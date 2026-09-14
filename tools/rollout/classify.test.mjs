import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditRepository, runAudit, writeReportAtomically } from "./audit.mjs";
import {
  classifyCommand,
  classifyJob,
  classifyWorkflow,
  repositoryDisposition,
} from "./classify.mjs";
import { main, scanExitCode } from "./cli.mjs";
import { GitHubClient } from "./github.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";

const SETUP = `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`;
const TEARDOWN = `workos/setup-socket-firewall/teardown@${APPROVED_RELEASE_SHA}`;
const PRIVATE_TOKEN = "${{ secrets.SOCKET_FIREWALL_TOKEN }}";
const PUBLIC_TOKEN = "${{ secrets.PUBLIC_SOCKET_FIREWALL_TOKEN }}";

function workflow(jobsYaml, triggers = "push") {
  return `on: ${triggers}\njobs:\n${jobsYaml}`;
}

function classify(text, visibility = "private", localActions = new Map()) {
  return classifyWorkflow(text, {
    localActions,
    path: ".github/workflows/ci.yml",
    visibility,
  });
}

test("command grammar", () => {
  const cases = [
    ["npm ci --ignore-scripts", "js-public-download"],
    ["npm install --no-audit", "js-public-download"],
    ["npm audit", "no-network"],
    ["npm audit fix", "js-public-download"],
    ["npm publish --access public", "js-publish"],
    ["npm run build", "unknown-wrapper"],
    ["npm test", "unknown-wrapper"],
    ["npx changeset publish", "js-public-download"],
    ["pnpm install --frozen-lockfile", "js-public-download"],
    ["pnpm dlx create-thing", "js-public-download"],
    ["pnpm exec vitest run", "unknown-wrapper"],
    ["pnpm publish --no-git-checks", "js-publish"],
    ["bun install --frozen-lockfile", "js-public-download"],
    ["bunx biome check", "js-public-download"],
    ["bun run test", "unknown-wrapper"],
    ["bun publish", "js-publish"],
    ["yarn install --frozen-lockfile", "yarn-blocked"],
    ["yarn", "yarn-blocked"],
    ["yarn npm publish", "js-publish"],
    ["yarn build", "unknown-wrapper"],
    ["corepack enable", "no-network"],
    ["corepack prepare pnpm@10 --activate", "js-public-download"],
    ["pip install -r requirements.txt", "other-ecosystem"],
    ["go build ./...", "other-ecosystem"],
    ["docker build .", "unknown-wrapper"],
    ["make bootstrap", "unknown-wrapper"],
    ["./scripts/setup.sh", "unknown-wrapper"],
    ["bash scripts/install.sh", "unknown-wrapper"],
    ["turbo run lint", "unknown-wrapper"],
    ["lerna bootstrap", "js-public-download"],
    ["CI=1 npm ci", "js-public-download"],
    ["echo done", "no-network"],
  ];
  for (const [command, kind] of cases) {
    assert.equal(classifyCommand(command).kind, kind, command);
  }
});

test("classifier: unprotected npm install needs SFW", () => {
  const result = classify(
    workflow(
      `  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@sha\n      - uses: actions/setup-node@sha\n        with: { registry-url: "https://registry.npmjs.org/" }\n      - run: npm ci\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unprotected");
  assert.deepEqual(result.jobs[0].managers, ["npm"]);
  assert.equal(repositoryDisposition([result]), "needs-sfw");
});

test("classifier: correctly ordered pinned setup is protected", () => {
  const result = classify(
    workflow(
      `  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@sha\n      - uses: actions/setup-node@sha\n        with: { registry-url: "https://registry.npmjs.org/" }\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
  );
  assert.deepEqual(result.jobs[0].violations, []);
  assert.equal(result.jobs[0].status, "protected");
  assert.equal(repositoryDisposition([result]), "protected");
});

test("classifier: registry mutation between setup and download is a violation", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - uses: actions/setup-node@sha\n        with: { registry-url: "https://registry.npmjs.org/" }\n      - run: npm ci\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unprotected");
  assert.match(result.jobs[0].violations.join(" "), /registry-mutating/);
});

test("classifier: setup after the first download is a violation", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - run: npm ci\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unprotected");
  assert.match(result.jobs[0].violations.join(" "), /after the first download/);
});

test("classifier: mutable or mismatched refs are violations", () => {
  const mutable = classify(
    workflow(
      `  build:\n    steps:\n      - uses: workos/setup-socket-firewall@v1\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
  );
  assert.equal(mutable.jobs[0].status, "unprotected");
  assert.match(mutable.jobs[0].violations.join(" "), /mutable or short ref/);

  const stale = classify(
    workflow(
      `  build:\n    steps:\n      - uses: workos/setup-socket-firewall@${"a".repeat(40)}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
  );
  assert.equal(stale.jobs[0].status, "unprotected");
  assert.match(stale.jobs[0].violations.join(" "), /unapproved SHA/);
});

test("classifier: token must match repository visibility", () => {
  const publicWrongSecret = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
    "public",
  );
  assert.equal(publicWrongSecret.jobs[0].status, "unprotected");
  assert.match(
    publicWrongSecret.jobs[0].violations.join(" "),
    /PUBLIC_SOCKET_FIREWALL_TOKEN.*public/,
  );

  const publicRight = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PUBLIC_TOKEN}" }\n      - run: npm ci\n`,
    ),
    "public",
  );
  assert.equal(publicRight.jobs[0].status, "protected");

  const internalWrongSecret = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PUBLIC_TOKEN}" }\n      - run: npm ci\n`,
    ),
    "internal",
  );
  assert.match(
    internalWrongSecret.jobs[0].violations.join(" "),
    /SOCKET_FIREWALL_TOKEN.*internal/,
  );
});

test("classifier: publish boundaries", () => {
  const cleanPublish = classify(
    workflow(`  publish:\n    steps:\n      - run: npm publish\n`),
  );
  assert.equal(cleanPublish.jobs[0].status, "safe-publish");

  const restored = classify(
    workflow(
      `  release:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: pnpm install --frozen-lockfile\n      - uses: ${TEARDOWN}\n      - run: pnpm publish --no-git-checks\n`,
    ),
  );
  assert.equal(restored.jobs[0].status, "protected");

  const unsafe = classify(
    workflow(
      `  release:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm publish --no-git-checks\n`,
    ),
  );
  assert.equal(unsafe.jobs[0].status, "unsafe-publish");
  assert.equal(repositoryDisposition([unsafe]), "unsafe-publish");

  const teardownBeforeFinalDownload = classify(
    workflow(
      `  release:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - uses: ${TEARDOWN}\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm publish --no-git-checks\n`,
    ),
  );
  assert.equal(teardownBeforeFinalDownload.jobs[0].status, "unsafe-publish");
});

test("classifier: yarn installs block", () => {
  const result = classify(
    workflow(`  build:\n    steps:\n      - run: yarn install\n`),
  );
  assert.equal(result.jobs[0].status, "blocked-yarn");
  assert.equal(repositoryDisposition([result]), "blocked-yarn");
});

test("classifier: public privileged trigger with installs is unsafe", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - uses: actions/checkout@sha\n        with: { ref: "\${{ github.event.pull_request.head.sha }}" }\n      - run: npm ci\n`,
      "pull_request_target",
    ),
    "public",
  );
  assert.equal(result.jobs[0].status, "unsafe-trust");
  assert.equal(repositoryDisposition([result]), "blocked-trust");
});

test("classifier: reusable call with inherited secrets is flagged", () => {
  const result = classify(
    `on: push\njobs:\n  call:\n    uses: workos/shared/.github/workflows/ci.yml@main\n    secrets: inherit\n`,
  );
  assert.equal(result.jobs[0].status, "reusable-call");
  assert.match(result.jobs[0].violations.join(" "), /inherits all secrets/);
  assert.equal(repositoryDisposition([result]), "needs-review");
});

test("classifier: pnpm action-setup run_install downloads", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - uses: pnpm/action-setup@sha\n        with: { run_install: true }\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unknown");
  assert.equal(repositoryDisposition([result]), "needs-review");
});

test("classifier: Corepack pnpm bootstrap bypasses SFW npm configuration", () => {
  const lazyCorepack = classify(
    workflow(
      `  build:\n    steps:\n      - run: corepack enable\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: pnpm install --frozen-lockfile\n`,
    ),
  );
  assert.equal(lazyCorepack.jobs[0].status, "unprotected");
  assert.match(lazyCorepack.jobs[0].violations.join(" "), /Corepack.*lazily/);

  const corepackDownload = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: corepack prepare pnpm@11.20.0 --activate\n`,
    ),
  );
  assert.equal(corepackDownload.jobs[0].status, "unprotected");
  assert.match(
    corepackDownload.jobs[0].violations.join(" "),
    /Corepack package-manager downloads/,
  );

  const npmBootstrap = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm install --global pnpm@11.20.0 --ignore-scripts\n      - run: pnpm install --frozen-lockfile\n`,
    ),
  );
  assert.equal(npmBootstrap.jobs[0].status, "protected");
  assert.deepEqual(npmBootstrap.jobs[0].violations, []);
});

test("classifier: local composite actions resolve or block", () => {
  const localActions = new Map([
    [
      ".github/actions/install/action.yml",
      `runs:\n  using: composite\n  steps:\n    - run: npm ci\n      shell: bash\n`,
    ],
  ]);
  const resolved = classify(
    workflow(`  build:\n    steps:\n      - uses: ./.github/actions/install\n`),
    "private",
    localActions,
  );
  assert.equal(resolved.jobs[0].status, "unprotected");
  assert.equal(resolved.jobs[0].operations[0].via, "./.github/actions/install");

  const missing = classify(
    workflow(`  build:\n    steps:\n      - uses: ./.github/actions/mystery\n`),
  );
  assert.equal(missing.jobs[0].status, "unknown");
  assert.equal(repositoryDisposition([missing]), "needs-review");
});

test("classifier: parse errors and scope buckets fail closed", () => {
  const broken = classify("on: [push\njobs: {");
  assert.notEqual(broken.parseError, undefined);
  assert.equal(repositoryDisposition([broken]), "needs-review");

  const python = classify(
    workflow(
      `  build:\n    steps:\n      - run: pip install -r requirements.txt\n`,
    ),
  );
  assert.equal(repositoryDisposition([python]), "out-of-scope");

  assert.equal(repositoryDisposition([]), "no-ci");
  assert.equal(repositoryDisposition([], { error: "boom" }), "audit-error");
});

function stubClient(overrides = {}) {
  const restRepositories = [
    {
      archived: false,
      default_branch: "main",
      name: "app",
      visibility: "internal",
    },
    {
      archived: false,
      default_branch: "main",
      name: "empty-repo",
      visibility: "private",
    },
  ];
  return {
    api: async (endpoint) => {
      if (endpoint === "repos/workos/empty-repo") {
        return { size: 0 };
      }
      throw new Error(`unexpected api call: ${endpoint}`);
    },
    getRef: async (repository) => {
      if (repository === "workos/empty-repo") {
        const error = new Error("Not Found");
        error.status = 404;
        throw error;
      }
      return { object: { sha: "c".repeat(40) } };
    },
    getText: async (repository, path) => {
      assert.equal(path, ".github/workflows/ci.yml");
      return workflow(`  build:\n    steps:\n      - run: npm ci\n`);
    },
    getTree: async () => ({
      tree: [
        { path: ".github/workflows/ci.yml", type: "blob", mode: "100644" },
        { path: "package-lock.json", type: "blob", mode: "100644" },
      ],
      truncated: false,
    }),
    listGraphqlRepositories: async () =>
      restRepositories.map((repository) => ({
        isArchived: repository.archived,
        name: repository.name,
        visibility: repository.visibility,
      })),
    listRestRepositories: async () => restRepositories,
    ...overrides,
  };
}

test("audit: classifies mocked repositories and writes an atomic report", async (t) => {
  const report = await runAudit(stubClient());
  assert.equal(report.inventory.activeCount, 2);
  assert.deepEqual(report.dispositions, { empty: 1, "needs-sfw": 1 });
  const app = report.repositories.find((row) => row.name === "app");
  assert.equal(app.disposition, "needs-sfw");
  assert.deepEqual(app.managers, ["npm"]);
  assert.deepEqual(app.lockfiles, ["package-lock.json"]);

  const directory = await mkdtemp(join(tmpdir(), "sfw-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "report.json");
  await writeReportAtomically(reportPath, report);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  const written = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(written.dispositions, report.dispositions);
  assert.deepEqual(await readdir(directory), ["report.json"]);
});

test("audit: access failures become audit-error rows, never no-download", async () => {
  const client = stubClient({
    getTree: async () => {
      const error = new Error("Forbidden");
      error.status = 403;
      throw error;
    },
  });
  const row = await auditRepository(client, {
    defaultBranch: "main",
    name: "app",
    visibility: "internal",
  });
  assert.equal(row.disposition, "audit-error");
  assert.match(row.error, /Forbidden/);
});

test("audit: truncated trees fail closed", async () => {
  const client = stubClient({
    getTree: async () => ({ tree: [], truncated: true }),
  });
  const row = await auditRepository(client, {
    defaultBranch: "main",
    name: "app",
    visibility: "internal",
  });
  assert.equal(row.disposition, "audit-error");
  assert.match(row.error, /truncated/);
});

test("adapter: transient network failures retry bounded", async () => {
  const { GitHubClient } = await import("./github.mjs");
  let attempts = 0;
  const client = new GitHubClient({
    execute: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("dial tcp 140.82.113.6:443: i/o timeout");
      }
      return { stdout: "{}" };
    },
    sleep: async () => {},
  });
  await client.api("repos/workos/example", "read example");
  assert.equal(attempts, 3);
});

test("adapter: non-transient failures do not retry", async () => {
  const { GitHubClient } = await import("./github.mjs");
  let attempts = 0;
  const client = new GitHubClient({
    execute: async () => {
      attempts += 1;
      const error = new Error("gh: Not Found (HTTP 404)");
      error.status = 404;
      throw error;
    },
    sleep: async () => {},
  });
  await assert.rejects(() => client.api("repos/workos/gone", "read gone"));
  assert.equal(attempts, 1);
});

const setupStep = { uses: SETUP, with: { token: PRIVATE_TOKEN } };
const installStep = { run: "npm ci" };
const teardownStep = { uses: TEARDOWN };
function jobResult(steps, extra = {}, context = {}) {
  return classifyJob(
    "fixture",
    { steps, ...extra },
    { visibility: "private", ...context },
    ["push"],
  );
}

test("classifier: every download needs an active, unconditional setup interval", () => {
  const cases = [
    ["disabled", [{ ...setupStep, if: false }, installStep]],
    [
      "disabled expression",
      [{ ...setupStep, if: "${{ false }}" }, installStep],
    ],
    [
      "conditional",
      [{ ...setupStep, if: "github.ref == 'refs/heads/main'" }, installStep],
    ],
    [
      "continue on error",
      [{ ...setupStep, "continue-on-error": true }, installStep],
    ],
    [
      "dynamic continue on error",
      [
        { ...setupStep, "continue-on-error": "${{ matrix.optional }}" },
        installStep,
      ],
    ],
    ["teardown before install", [setupStep, teardownStep, installStep]],
    [
      "teardown after first install",
      [setupStep, installStep, teardownStep, installStep],
    ],
    [
      "conditional teardown",
      [setupStep, { ...teardownStep, if: "always()" }, installStep],
    ],
    [
      "later registry action",
      [
        setupStep,
        installStep,
        {
          uses: "actions/setup-node@fixture",
          with: { "registry-url": "https://registry.npmjs.org/" },
        },
        installStep,
      ],
    ],
    [
      "later registry flag",
      [
        setupStep,
        installStep,
        { run: "npm ci --registry=https://registry.npmjs.org/" },
      ],
    ],
    [
      "later registry assignment",
      [
        setupStep,
        installStep,
        { run: "NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ npm ci" },
      ],
    ],
    ["install condition", [setupStep, { ...installStep, if: "always()" }]],
    [
      "install continue on error",
      [setupStep, { ...installStep, "continue-on-error": true }],
    ],
    [
      "fallback path",
      [
        {
          ...setupStep,
          with: { ...setupStep.with, "allow-external-fork-fallback": "true" },
        },
        installStep,
      ],
    ],
    ["bun configuration missing", [setupStep, { run: "bun install" }]],
  ];
  const ambiguous = new Set([
    "conditional",
    "continue on error",
    "dynamic continue on error",
    "conditional teardown",
    "install condition",
    "install continue on error",
    "fallback path",
  ]);
  for (const [label, steps] of cases) {
    const result = jobResult(steps);
    assert.equal(
      result.status,
      ambiguous.has(label) ? "unknown" : "unprotected",
      label,
    );
    assert.equal(
      repositoryDisposition([{ jobs: [result] }]),
      ambiguous.has(label) ? "needs-review" : "needs-sfw",
      label,
    );
    assert.ok(result.violations.length > 0, label);
  }
  assert.equal(
    jobResult([setupStep, installStep, teardownStep]).status,
    "protected",
  );
  assert.equal(
    jobResult([setupStep, installStep, teardownStep, setupStep, installStep])
      .status,
    "protected",
  );
  assert.equal(
    jobResult([
      { ...setupStep, if: true, "continue-on-error": false },
      installStep,
    ]).status,
    "protected",
  );
  assert.equal(
    jobResult([
      { ...setupStep, with: { ...setupStep.with, "configure-bun": "true" } },
      { run: "bun install" },
    ]).status,
    "protected",
  );
});

test("classifier: opaque operations cannot lose to an otherwise protected install", () => {
  const opaque = [
    { run: "npm run bootstrap" },
    { run: "npm test" },
    { run: "pnpm exec custom" },
    { run: "bash -c 'npm ci'" },
    { run: "node scripts/bootstrap.js" },
    { run: "./scripts/bootstrap" },
    { run: "docker build ." },
    { run: "custom-tool" },
    { uses: "docker://fixture/image:latest" },
    { uses: "example/opaque-action@fixture" },
    { uses: "./missing" },
    { run: "npm config set registry https://registry.npmjs.org/" },
  ];
  for (const step of opaque) {
    assert.equal(jobResult([step]).status, "unknown", JSON.stringify(step));
    const result = jobResult([setupStep, installStep, step]);
    assert.notEqual(result.status, "protected", JSON.stringify(step));
    assert.ok(["unknown", "unprotected"].includes(result.status));
  }
  for (const extra of [
    { container: "node:22" },
    { if: "always()" },
    { "continue-on-error": true },
    { env: { NPM_CONFIG_REGISTRY: "custom" } },
    { defaults: { run: { shell: "python" } } },
  ]) {
    assert.equal(jobResult([setupStep, installStep], extra).status, "unknown");
  }
});

test("classifier: small shell grammar keeps complex constructs uncertain", () => {
  for (const run of [
    "npm ci || true",
    "npm ci; npm ci",
    "if true; then npm ci; fi",
    "npm ci $(custom)",
    "npm ci > log",
    "sudo npm ci",
    'npm ci "$(custom)"',
  ]) {
    assert.notEqual(jobResult([setupStep, { run }]).status, "protected", run);
  }
  assert.equal(
    jobResult([setupStep, { run: "npm ci && pnpm install" }]).status,
    "protected",
  );
  assert.equal(
    jobResult([setupStep, { run: "npm ci", shell: "python" }]).status,
    "unknown",
  );
});

test("classifier: local composite nesting, cycles and inner/outer uncertainty", () => {
  const localActions = new Map([
    [
      "outer/action.yml",
      "runs:\n  using: composite\n  steps:\n    - uses: ./inner\n",
    ],
    [
      "inner/action.yml",
      `runs:\n  using: composite\n  steps:\n    - uses: ${SETUP}\n      with: { token: '${PRIVATE_TOKEN}' }\n    - run: npm ci\n      shell: bash\n`,
    ],
  ]);
  const call = { uses: "./outer" };
  assert.equal(jobResult([call], {}, { localActions }).status, "protected");
  for (const boundary of [{ if: "always()" }, { "continue-on-error": true }]) {
    assert.equal(
      jobResult([{ ...call, ...boundary }], {}, { localActions }).status,
      "unknown",
    );
  }
  localActions.set(
    "inner/action.yml",
    `runs:\n  using: composite\n  steps:\n    - uses: ${SETUP}\n      if: false\n      with: { token: '${PRIVATE_TOKEN}' }\n    - run: npm ci\n      shell: bash\n`,
  );
  assert.equal(jobResult([call], {}, { localActions }).status, "unprotected");
  localActions.set(
    "inner/action.yml",
    "runs:\n  using: composite\n  steps:\n    - uses: ./outer\n",
  );
  assert.equal(jobResult([call], {}, { localActions }).status, "unknown");
  localActions.set(
    "inner/action.yml",
    "runs: { using: node24, main: index.js }",
  );
  assert.equal(
    jobResult([setupStep, installStep, call], {}, { localActions }).status,
    "unknown",
  );
});

test("classifier: malformed workflow/jobs and unknown operations remain review candidates", () => {
  for (const text of [
    "{}",
    "jobs: []",
    "jobs: {}",
    "jobs: wrong",
    "on: push\njobs: { build: [] }",
    "on: push\njobs: { build: {} }",
    "on: push\njobs: { build: { steps: wrong } }",
    "on: push\njobs: { build: { steps: [null] } }",
  ]) {
    assert.equal(repositoryDisposition([classify(text)]), "needs-review", text);
  }
  const result = classify(
    workflow("  build:\n    steps:\n      - run: npm run bootstrap\n"),
  );
  assert.equal(repositoryDisposition([result]), "needs-review");
});

const fixtureRepository = {
  name: "app",
  defaultBranch: "main",
  visibility: "private",
};
const blob = (path) => ({ path, type: "blob", mode: "100644" });

test("audit: moving branch cannot change tree or nested source snapshot", async () => {
  const sha = "d".repeat(40);
  const reads = [];
  const sources = new Map([
    [
      ".github/workflows/ci.yml",
      workflow("  build:\n    steps:\n      - uses: ./outer\n"),
    ],
    [
      "outer/action.yml",
      "runs:\n  using: composite\n  steps:\n    - uses: ./inner\n",
    ],
    [
      "inner/action.yml",
      "runs:\n  using: composite\n  steps:\n    - run: npm ci\n      shell: bash\n    - uses: ./outer\n",
    ],
  ]);
  const row = await auditRepository(
    stubClient({
      getRef: async () => ({ object: { sha } }),
      getTree: async (_repo, ref, recursive) => {
        assert.equal(ref, sha); // The simulated branch now points elsewhere.
        assert.equal(recursive, true);
        return { truncated: false, tree: [...sources.keys()].map(blob) };
      },
      getText: async (_repo, path, ref) => {
        assert.equal(ref, sha);
        reads.push(path);
        return sources.get(path);
      },
    }),
    fixtureRepository,
  );
  assert.equal(row.headSha, sha);
  // The certain install precedes the unresolved cycle; retain both signals.
  assert.equal(row.disposition, "needs-sfw");
  assert.equal(row.assuranceDisposition, "needs-review");
  assert.deepEqual(reads.sort(), [...sources.keys()].sort());
  assert.ok(
    row.workflows[0].jobs[0].operations.some(
      (op) => op.kind === "unknown-local-action",
    ),
  );
});

test("audit: malformed and partial reads never become clean", async () => {
  const overrides = [
    { getRef: async () => ({ object: { sha: "z".repeat(40) } }) },
    ...[
      null,
      {},
      { truncated: false },
      { truncated: false, tree: [null] },
      { truncated: false, tree: [{ type: "blob" }] },
    ].map((tree) => ({ getTree: async () => tree })),
    ...[undefined, "", {}].map((text) => ({ getText: async () => text })),
    {
      getText: async () => {
        throw new Error("fixture source read failed");
      },
    },
    {
      getTree: async () => ({
        truncated: false,
        tree: [{ ...blob(".github/workflows/ci.yml"), mode: "120000" }],
      }),
    },
  ];
  for (const override of overrides) {
    assert.equal(
      (await auditRepository(stubClient(override), fixtureRepository))
        .disposition,
      "audit-error",
    );
  }
});

test("adapter: reject partial/malformed base64, wrong sizes and invalid UTF-8", async () => {
  const valid = {
    type: "file",
    encoding: "base64",
    content: "bmFtZTogZml4dHVyZQo=",
    size: 14,
  };
  const responses = [
    null,
    { ...valid, content: undefined },
    { ...valid, content: "%%%" },
    { ...valid, size: 15 },
    { ...valid, size: undefined },
    { ...valid, content: "/w==", size: 1 },
  ];
  for (const response of responses) {
    const client = new GitHubClient({
      execute: async () => ({ stdout: JSON.stringify(response) }),
    });
    await assert.rejects(
      client.getText("example/fixture", "action.yml", "a".repeat(40)),
    );
  }
  const client = new GitHubClient({
    execute: async () => ({ stdout: JSON.stringify(valid) }),
  });
  assert.equal(
    await client.getText("example/fixture", "action.yml", "a".repeat(40)),
    "name: fixture\n",
  );
});

test("CLI: partial scan errors are distinct from gaps and terminal output is sanitized", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sfw-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let output = "";
  const reportPath = join(directory, "report.json");
  const report = await main(["audit"], {
    client: stubClient({
      getText: async () => {
        throw new Error("private fixture detail");
      },
    }),
    reportPath,
    output: {
      write: (text) => {
        output += text;
      },
    },
  });
  assert.equal(report.scanStatus, "partial");
  assert.equal(report.scanErrors, 1);
  assert.equal(scanExitCode(report), 1);
  const summary = JSON.parse(output);
  assert.equal(summary.scanErrors, 1);
  assert.deepEqual(summary.dispositions, { "audit-error": 1, empty: 1 });
  assert.doesNotMatch(output, /private fixture detail|empty-repo|"app"/);
  assert.match(await readFile(reportPath, "utf8"), /private fixture detail/);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  const gaps = await runAudit(stubClient());
  assert.equal(gaps.scanStatus, "complete");
  assert.equal(scanExitCode(gaps), 0);
  const unknowns = await runAudit(
    stubClient({
      getText: async () =>
        workflow("  build:\n    steps:\n      - run: npm run bootstrap\n"),
    }),
  );
  assert.equal(unknowns.dispositions["needs-review"], 1);
  assert.equal(scanExitCode(unknowns), 0);
});

test("classifier: later Corepack activation and alternate checkout are not certified", () => {
  const later = jobResult([
    setupStep,
    { run: "pnpm install" },
    { run: "corepack enable" },
    { run: "pnpm install" },
  ]);
  assert.equal(later.status, "unprotected");
  assert.match(later.violations.join(" "), /Corepack.*operation 4/);
  for (const step of [
    { uses: "actions/setup-node/custom@fixture" },
    { uses: "actions/checkout@fixture", with: { ref: "other-branch" } },
    {
      uses: "actions/checkout@fixture",
      with: { repository: "example/alternate" },
    },
  ]) {
    assert.equal(jobResult([step, setupStep, installStep]).status, "unknown");
  }
});

test("classifier: branching local composites have a bounded expansion", () => {
  const localActions = new Map();
  for (let index = 0; index < 15; index += 1) {
    localActions.set(
      `action-${index}/action.yml`,
      `runs:\n  using: composite\n  steps:\n    - uses: ./action-${index + 1}\n    - uses: ./action-${index + 1}\n`,
    );
  }
  const result = jobResult([{ uses: "./action-0" }], {}, { localActions });
  assert.equal(result.status, "unknown");
  assert.ok(result.operations.length < 1100);
  assert.ok(
    result.operations.some(
      (op) => op.reason === "local action expansion limit reached",
    ),
  );
});

test("adapter: source paths are escaped independently of immutable ref", async () => {
  let endpoint;
  const client = new GitHubClient({
    execute: async (args) => {
      endpoint = args.at(-1);
      return {
        stdout: JSON.stringify({
          type: "file",
          encoding: "base64",
          content: "",
          size: 0,
        }),
      };
    },
  });
  await client.getText(
    "example/fixture",
    ".github/workflows/ci#fixture.yml",
    "e".repeat(40),
  );
  assert.equal(
    endpoint,
    `repos/example/fixture/contents/.github/workflows/ci%23fixture.yml?ref=${"e".repeat(40)}`,
  );
});

test("classifier: composite inner boundaries survive expansion", () => {
  for (const boundary of ["if: always()", "continue-on-error: true"]) {
    const localActions = new Map([
      [
        "inner/action.yml",
        `runs:\n  using: composite\n  steps:\n    - uses: ${SETUP}\n      ${boundary}\n      with: { token: '${PRIVATE_TOKEN}' }\n    - run: npm ci\n      shell: bash\n`,
      ],
    ]);
    const result = jobResult([{ uses: "./inner" }], {}, { localActions });
    assert.equal(result.status, "unknown", boundary);
    assert.equal(result.operations[0].uncertain, true);
  }
  for (const boundary of [{ if: "always()" }, { "continue-on-error": true }]) {
    assert.equal(
      jobResult([
        setupStep,
        installStep,
        { ...teardownStep, ...boundary },
        { run: "npm publish" },
      ]).status,
      boundary.if === "always()" ? "unknown" : "unsafe-publish",
    );
  }
});

test("classifier: registry changes are evaluated at each download, not after the last one", () => {
  const registryStep = {
    uses: "actions/setup-node@fixture",
    with: { "registry-url": "https://registry.npmjs.org/" },
  };
  assert.equal(
    jobResult([setupStep, installStep, registryStep]).status,
    "protected",
  );
  assert.equal(
    jobResult([setupStep, installStep, registryStep, installStep]).status,
    "unprotected",
  );
  assert.equal(
    jobResult([setupStep, installStep, registryStep, setupStep, installStep])
      .status,
    "protected",
  );
});
