import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { auditRepository } from "./audit.mjs";
import { classifyJob, classifyWorkflow } from "./classify.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";

const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: {
    token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}",
    "configure-bun": true,
  },
};
const context = { visibility: "private", path: ".github/workflows/ci.yml" };
const inspect = (steps, extra = {}) =>
  classifyJob("build", { steps, ...extra }, context, ["push"]);

test("literal install options preserve configuration, not execution assurance", () => {
  for (const run of [
    "npm ci --include=optional",
    "npm install --omit=dev --package-lock=false",
    "npm ci --prefix web",
    "npm ci --prefix=packages/sdk",
    'bun install --frozen-lockfile --os="*" --cpu="*"',
  ]) {
    assert.equal(
      inspect([setup, { run }]).integration.disposition,
      "integrated",
      run,
    );
    assert.equal(inspect([{ run }]).integration.disposition, "needs-sfw", run);
    assert.equal(
      inspect([setup, { run: `${run} --registry=https://example.invalid` }])
        .integration.disposition,
      "needs-sfw",
      run,
    );
  }
  for (const run of [
    "npm ci --prefix $PROJECT",
    "npm ci --prefix ../other",
    "npm ci --prefix /tmp/project",
    "npm ci --prefix --registry=https://example.invalid",
    "npm ci --future-option web",
    "npm --prefix help ci",
  ]) {
    assert.notEqual(
      inspect([setup, { run }]).integration.disposition,
      "integrated",
      run,
    );
  }
});

test("literal default working directories match explicit run-step directories", () => {
  for (const directory of ["web", "./packages/chat", "."]) {
    const defaults = { run: { shell: "bash", "working-directory": directory } };
    const result = inspect([setup, { run: "npm ci" }], { defaults });
    assert.equal(result.integration.disposition, "integrated");
    assert.equal(result.status, inspect([setup, { run: "npm ci" }]).status);
    assert.equal(
      inspect([{ run: "npm ci" }], { defaults }).integration.disposition,
      "needs-sfw",
    );
    const workflow = classifyWorkflow(
      JSON.stringify({
        on: "push",
        defaults,
        jobs: { build: { steps: [setup, { run: "npm ci" }] } },
      }),
      context,
    );
    assert.equal(workflow.jobs[0].integration.disposition, "integrated");
  }
  for (const directory of [
    "${{ inputs.path }}",
    "$HOME",
    "../other",
    "/tmp",
    null,
  ]) {
    assert.equal(
      inspect([setup, { run: "npm ci" }], {
        defaults: { run: { "working-directory": directory } },
      }).integration.disposition,
      "needs-review",
    );
  }
  assert.equal(
    inspect([setup, { run: "npm ci" }], {
      defaults: { run: { "working-directory": "web", shell: "python" } },
    }).integration.disposition,
    "needs-review",
  );
});

test("setup-owned temporary npm config does not invalidate HOME configuration", () => {
  const env = { NPM_CONFIG_USERCONFIG: "${{ runner.temp }}/sfw.npmrc" };
  assert.equal(
    inspect([{ ...setup, env }, { run: "npm ci" }]).integration.disposition,
    "integrated",
  );
  for (const steps of [
    [setup, { run: "npm ci", env }],
    [{ ...setup, env: { ...env, HOME: "/other" } }, { run: "npm ci" }],
    [
      { ...setup, env: { NPM_CONFIG_USERCONFIG: "${{ inputs.config }}" } },
      { run: "npm ci" },
    ],
  ])
    assert.equal(inspect(steps).integration.disposition, "needs-review");
});

test("public dynamic fallback stays bounded by the pinned action's fork checks", () => {
  const publicSetup = {
    ...setup,
    with: {
      ...setup.with,
      token: "${{ secrets.PUBLIC_SOCKET_FIREWALL_TOKEN }}",
      "allow-external-fork-fallback":
        "${{ github.event_name == 'pull_request' }}",
    },
  };
  const steps = [publicSetup, { run: "npm ci" }];
  const result = classifyJob(
    "build",
    { steps },
    { ...context, visibility: "public" },
    ["pull_request"],
  );
  assert.equal(result.integration.disposition, "integrated");
  assert.equal(result.integration.downloads[0].status, "fork-exception");
  assert.equal(result.status, "unknown");
  assert.equal(inspect(steps).integration.disposition, "needs-review");
  assert.equal(
    classifyJob(
      "build",
      { steps: [{ ...publicSetup, "continue-on-error": true }, steps[1]] },
      { ...context, visibility: "public" },
    ).integration.disposition,
    "needs-review",
  );
});

test("commented-out workflows contain no active jobs; invalid YAML remains reviewable", () => {
  const result = classifyWorkflow(
    "# name: Disabled\n# on: push\n# jobs:\n#   build: npm ci\n",
    context,
  );
  assert.equal(result.parseError, undefined);
  assert.deepEqual(result.jobs, []);
  for (const source of ["", "null", "jobs: {}", "# disabled\non: ["]) {
    assert.ok(classifyWorkflow(source, context).parseError, source);
  }
});

test("audit acquires root actions at the captured SHA, including nested composites", async () => {
  const sha = "a".repeat(40);
  for (const filename of ["action.yml", "action.yaml"]) {
    const sources = new Map([
      [
        context.path,
        stringify({
          on: "push",
          jobs: { build: { steps: [{ uses: "./" }] } },
        }),
      ],
      [
        filename,
        stringify({
          runs: { using: "composite", steps: [setup, { uses: "./nested" }] },
        }),
      ],
      [
        "nested/action.yml",
        JSON.stringify({
          runs: {
            using: "composite",
            steps: [{ run: "npm ci", shell: "bash" }],
          },
        }),
      ],
    ]);
    const reads = [];
    const result = await auditRepository(
      {
        async getRef() {
          return { object: { sha } };
        },
        async getTree() {
          return {
            truncated: false,
            tree: [...sources.keys()].map((path) => ({
              path,
              type: "blob",
              mode: "100644",
            })),
          };
        },
        async getText(repo, path, ref) {
          assert.equal(ref, sha);
          reads.push(path);
          return sources.get(path);
        },
      },
      { name: "fixture", defaultBranch: "main", visibility: "private" },
    );
    assert.deepEqual(reads.sort(), [...sources.keys()].sort());
    assert.equal(result.disposition, "integrated");
  }
  const cyclic = new Map([
    [
      "action.yml",
      JSON.stringify({ runs: { using: "composite", steps: [{ uses: "./" }] } }),
    ],
  ]);
  assert.equal(
    classifyJob(
      "cycle",
      { steps: [{ uses: "./" }] },
      { ...context, localActions: cyclic },
    ).integration.disposition,
    "needs-review",
  );
  assert.equal(
    inspect([{ uses: "./" }]).integration.disposition,
    "needs-review",
  );
});
