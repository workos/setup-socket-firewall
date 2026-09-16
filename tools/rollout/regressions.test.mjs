import assert from "node:assert/strict";
import test from "node:test";
import { auditRepository, runAudit } from "./audit.mjs";
import {
  classifyJob,
  classifyWorkflow,
  repositoryDisposition,
} from "./classify.mjs";
import { scanExitCode } from "./cli.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";
import { parseYamlSource } from "./yaml.mjs";
import { statusFromText } from "./github.mjs";

test("GitHub status parsing handles both CLI diagnostic formats", () => {
  assert.equal(statusFromText("gh: API rate limit exceeded (HTTP 429)"), 429);
  assert.equal(statusFromText("HTTP 429: rate limit exceeded"), 429);
  assert.equal(statusFromText("HTTP 403: rate limit exceeded"), 403);
  assert.equal(statusFromText("HTTP 404: Not Found"), 404);
  assert.equal(statusFromText("network failure"), undefined);
});

const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: { token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}" },
};
const install = { run: "npm ci" };
const context = { visibility: "private", path: ".github/workflows/ci.yml" };
function inspect(steps, overrides = {}) {
  const job = classifyJob("build", { steps }, { ...context, ...overrides }, [
    "push",
  ]);
  return { job, disposition: repositoryDisposition([{ jobs: [job] }]) };
}

test("option values cannot masquerade as informational or publishing verbs", () => {
  for (const run of [
    "npm --prefix help ci",
    "npm --prefix publish ci",
    "pnpm --filter list install",
    "npm --prefix=help ci",
  ]) {
    for (const steps of [[{ run }], [setup, install, { run }]]) {
      assert.equal(inspect(steps).disposition, "needs-review", run);
    }
  }
});

test("scoped and abbreviated registry options cannot earn protected", () => {
  for (const run of [
    "npm install @fixture/pkg --@fixture:registry=https://registry.example.invalid",
    "npm ci --reg=https://registry.example.invalid",
    "npm ci --regis=https://registry.example.invalid",
    "pnpm install --config.registry=https://registry.example.invalid",
  ]) {
    const result = inspect([setup, { run }]);
    assert.equal(result.disposition, "needs-sfw", run);
    assert.match(result.job.violations.join(" "), /registry-mutating/);
  }
  for (const run of [
    "npm ci --userc=other.npmrc",
    "npm ci --future-config=other",
  ]) {
    assert.equal(inspect([setup, { run }]).disposition, "needs-review", run);
  }
  assert.equal(
    inspect([setup, { run: "npm ci --ignore-scripts --no-audit --no-fund" }])
      .disposition,
    "protected",
  );
});

test("ecosystem executors remain candidates rather than being excluded", () => {
  for (const run of [
    "uv run npm ci",
    "poetry run npm ci",
    "conda run npm ci",
    "pipenv run npm ci",
    "go run bootstrap.go",
    "cargo run --bin installer",
  ]) {
    assert.equal(inspect([{ run }]).disposition, "needs-review", run);
    assert.equal(
      inspect([setup, install, { run }]).disposition,
      "needs-review",
      run,
    );
  }
  assert.equal(
    inspect([{ run: "pip install -r requirements.txt" }]).job.status,
    "out-of-scope",
  );
});

test("targeted Corepack controls cannot clear a different manager's state", () => {
  for (const enable of ["corepack enable", "corepack enable pnpm"]) {
    assert.equal(
      inspect([
        { run: enable },
        { run: "corepack disable yarn" },
        setup,
        { run: "pnpm install" },
      ]).disposition,
      "needs-review",
    );
  }
  assert.equal(
    inspect([
      { run: "corepack enable" },
      { run: "corepack disable" },
      setup,
      { run: "pnpm install" },
    ]).disposition,
    "protected",
  );
});

test("conditional protection and legitimate fork fallback are review, not known gaps", () => {
  for (const step of [
    { ...setup, if: "github.ref == 'refs/heads/main'" },
    { ...setup, "continue-on-error": true },
  ])
    assert.equal(inspect([step, install]).disposition, "needs-review");
  assert.equal(
    inspect(
      [
        {
          ...setup,
          with: {
            token: "${{ secrets.PUBLIC_SOCKET_FIREWALL_TOKEN }}",
            "allow-external-fork-fallback": true,
          },
        },
        install,
      ],
      { visibility: "public" },
    ).disposition,
    "needs-review",
  );
  assert.equal(
    inspect([{ ...setup, if: false }, install]).disposition,
    "needs-sfw",
  );
});

test("unsupported YAML never emits source-bearing warnings or returns a clean workflow", () => {
  const emitted = [];
  const emitWarning = process.emitWarning;
  process.emitWarning = (...args) => emitted.push(args);
  try {
    const invalidSources = [
      "name: !private-canary private-workflow-canary\n",
      "? [private, canary]\n: value\n",
      "---\nname: second-document\n",
      "name: [unterminated\n",
    ];
    for (const invalid of invalidSources) {
      const source = `on: push\njobs:\n  build:\n    steps:\n      - run: echo done\n${invalid}`;
      assert.equal(
        repositoryDisposition([classifyWorkflow(source, context)]),
        "needs-review",
      );
      assert.throws(() => parseYamlSource(source));
    }
    const localActions = new Map([
      [
        "local/action.yml",
        `name: !private-canary private-composite-canary\nruns:\n  using: composite\n  steps:\n    - uses: ${setup.uses}\n      with:\n        token: '${setup.with.token}'\n    - run: npm ci\n      shell: bash\n`,
      ],
    ]);
    assert.equal(
      inspect([{ uses: "./local" }], { localActions }).disposition,
      "needs-review",
    );
    assert.deepEqual(emitted, []);
  } finally {
    process.emitWarning = emitWarning;
  }
});

test("malformed non-blob modes produce partial audit errors, never no-ci", async () => {
  const repository = {
    name: "fixture",
    defaultBranch: "main",
    visibility: "private",
  };
  for (const entry of [
    { type: "tree", mode: "100644" },
    { type: "tree" },
    { type: "commit", mode: "100644" },
    { type: "commit" },
  ]) {
    const client = {
      listRestRepositories: async () => [
        { ...repository, default_branch: "main", archived: false },
      ],
      listGraphqlRepositories: async () => [
        { ...repository, isArchived: false },
      ],
      getRef: async () => ({ object: { sha: "a".repeat(40) } }),
      getTree: async () => ({
        truncated: false,
        tree: [{ path: ".github/workflows/ci.yml", ...entry }],
      }),
      getText: async () => {
        throw new Error("must not read malformed tree source");
      },
    };
    assert.equal(
      (await auditRepository(client, repository)).disposition,
      "audit-error",
    );
    const report = await runAudit(client);
    assert.equal(report.scanStatus, "partial");
    assert.equal(report.scanErrors, 1);
    assert.equal(scanExitCode(report), 1);
  }
});
