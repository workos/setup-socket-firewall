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

test("workspace matrix selectors require bounded literal values", () => {
  const strategy = { matrix: { app: ["research", "incident-watch"] } };
  for (const run of [
    "npm -w apps/${{ matrix.app }} run build",
    'npm --workspace="apps/${{ matrix.app }}" run typecheck',
  ]) {
    assert.equal(
      inspect([setup, { run: "npm ci" }, { run }], { strategy }).integration
        .disposition,
      "integrated",
    );
    assert.equal(inspect([{ run }], { strategy }).status, "unknown");
    for (const matrix of [
      { app: ["research; npm install evil"] },
      { app: ["../elsewhere"] },
      { app: ["--registry=elsewhere"] },
      { app: [] },
      { app: ["research"], include: [{ app: "unsafe value" }] },
      "${{ fromJSON(needs.matrix.outputs.apps) }}",
    ])
      assert.equal(
        inspect([{ run }], { strategy: { matrix } }).integration.disposition,
        "needs-review",
      );
  }
  const run = "npm -w apps/${{ matrix.app }} install";
  assert.equal(
    inspect([{ run }], { strategy }).integration.disposition,
    "needs-sfw",
  );
  assert.equal(
    inspect([setup, { run }], { strategy }).integration.disposition,
    "integrated",
  );
});

test("runner-temp tarballs stay local, without excusing runner-temp overrides", () => {
  for (const run of [
    'npm install --no-save --ignore-scripts "$RUNNER_TEMP"/example-*.tgz',
    'npx --yes --package "$RUNNER_TEMP"/example-*.tgz example --list',
  ]) {
    assert.equal(
      inspect([setup, { run }]).integration.disposition,
      "integrated",
    );
    assert.equal(inspect([{ run }]).integration.disposition, "needs-sfw");
    assert.equal(
      inspect([setup, { run }], {
        env: { RUNNER_TEMP: "https://example.invalid" },
      }).integration.disposition,
      "needs-review",
    );
    assert.equal(
      inspect([setup, { run: `RUNNER_TEMP=https://example.invalid\n${run}` }])
        .integration.disposition,
      "needs-review",
    );
  }
  for (const target of [
    "$ARTIFACTS/example.tgz",
    "$RUNNER_TEMP/../example.tgz",
    "$RUNNER_TEMP/$PACKAGE.tgz",
  ])
    assert.equal(
      inspect([setup, { run: `npm install "${target}"` }]).integration
        .disposition,
      "needs-review",
    );
});

test("clean-room npm preserves only the exact inherited registry and config", () => {
  const prefix =
    'env -i CI=true HOME="$HOME" PATH="$PATH" NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:?}" NPM_CONFIG_USERCONFIG="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"';
  for (const command of ["npm ci", "npm ci --prefix web"]) {
    const run = `${prefix} ${command}`;
    assert.equal(
      inspect([setup, { run }]).integration.disposition,
      "integrated",
    );
    assert.equal(inspect([{ run }]).integration.disposition, "needs-sfw");
    assert.equal(inspect([setup, { run }]).status, "unknown");
  }
  for (const run of [
    `${prefix.replace('PATH="$PATH"', 'PATH="/other"')} npm ci`,
    `${prefix.replace('HOME="$HOME"', 'HOME="/other"')} npm ci`,
    `${prefix.replace('"${NPM_CONFIG_REGISTRY:?}"', '"https://example.invalid"')} npm ci`,
    `${prefix.replace('"${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"', '"/other/.npmrc"')} npm ci`,
    `${prefix} NODE_OPTIONS=--require=evil.cjs npm ci`,
    `${prefix} HOME="$HOME" npm ci`,
    "env -i npm ci",
  ])
    assert.notEqual(
      inspect([setup, { run }]).integration.disposition,
      "integrated",
      run,
    );
});

test("standard explicit Bash and local script commands are not unknown installer options", () => {
  const shell = "bash --noprofile --norc -euo pipefail {0}";
  assert.equal(
    inspect([setup, { run: "npm ci", shell }]).integration.disposition,
    "integrated",
  );
  assert.equal(
    inspect([{ run: "npm ci", shell }]).integration.disposition,
    "needs-sfw",
  );
  for (const custom of ["bash --rcfile /other {0}", "python {0}"]) {
    assert.equal(
      inspect([setup, { run: "npm ci", shell: custom }]).integration
        .disposition,
      "needs-review",
    );
  }
  for (const run of [
    'npm version "$VERSION" --no-git-tag-version',
    "npm pack --json",
    "packed=$(npm pack --json)",
    "bun scripts/build-binary.ts --target $TARGET",
  ]) {
    const result = inspect([{ run }]);
    assert.equal(result.integration.disposition, "no-js-ci", run);
    assert.equal(result.status, "unknown", run);
  }
  for (const run of [
    "npm pack @scope/remote",
    "npm pack $PACKAGE",
    "npm pack --pack-destination $DIR",
    "bun $SCRIPT",
  ])
    assert.equal(
      inspect([{ run }]).integration.disposition,
      "needs-review",
      run,
    );
});

test("matching immutable output guards cover only the same guarded installs", () => {
  const ready = { id: "ready", run: 'echo enabled=true >> "$GITHUB_OUTPUT"' };
  for (const guard of [
    "steps.ready.outputs.enabled == 'true'",
    "needs.prepare.outputs.enabled == 'true'",
  ]) {
    const guardedSetup = { ...setup, if: guard };
    const install = { run: "npm ci", if: `\${{ ${guard} }}` };
    const result = inspect([ready, guardedSetup, install]);
    assert.equal(result.integration.disposition, "integrated");
    assert.equal(result.status, "unknown");
    assert.equal(
      inspect([ready, guardedSetup, { run: "npm ci" }]).integration.disposition,
      "needs-review",
    );
    assert.equal(
      inspect([
        ready,
        guardedSetup,
        { ...install, if: guard.replace("'true'", "'false'") },
      ]).integration.disposition,
      "needs-review",
    );
    assert.equal(
      inspect([ready, { ...guardedSetup, "continue-on-error": true }, install])
        .integration.disposition,
      "needs-review",
    );
    assert.equal(
      inspect([ready, { ...guardedSetup, env: { HOME: "/other" } }, install])
        .integration.disposition,
      "needs-review",
    );
    assert.equal(
      inspect([
        ready,
        guardedSetup,
        {
          uses: `workos/setup-socket-firewall/teardown@${APPROVED_RELEASE_SHA}`,
        },
        install,
      ]).integration.disposition,
      "needs-sfw",
    );
  }
  const guardedSetup = {
    ...setup,
    if: "steps.ready.outputs.enabled == 'true'",
  };
  const install = { run: "npm ci", if: guardedSetup.if };
  for (const steps of [
    [guardedSetup, ready, install],
    [ready, guardedSetup, ready, install],
    [
      ready,
      guardedSetup,
      { ...install, if: "steps.ready.outputs.enabled == 't r u e'" },
    ],
  ])
    assert.equal(inspect(steps).integration.disposition, "needs-review");
  for (const guard of [
    "env.ENABLED == 'true'",
    "always()",
    "steps.ready.outputs.enabled == 't r u e'",
  ]) {
    assert.equal(
      inspect([ready, { ...setup, if: guard }, { ...install, if: guard }])
        .integration.disposition,
      "needs-review",
    );
  }
});

test("a stricter stable conjunction implies setup, never the reverse", () => {
  const ready = { id: "ready", run: 'echo enabled=true >> "$GITHUB_OUTPUT"' };
  const output = "steps.ready.outputs.enabled == 'true'";
  const event = "github.event_name == 'pull_request'";
  const check = (setupGuard, installGuard, steps = [ready]) =>
    inspect([
      ...steps,
      { ...setup, if: setupGuard },
      { run: "npx tool", if: installGuard },
    ]);
  for (const guard of [`${output} && ${event}`, `${event} && ${output}`]) {
    const result = check(output, `\${{ ${guard} }}`);
    assert.equal(result.integration.disposition, "integrated");
    assert.equal(result.status, "unknown");
    assert.equal(check(guard, output).integration.disposition, "needs-review");
    assert.equal(check(guard, guard).integration.disposition, "integrated");
    assert.equal(
      check(output, guard, [ready, ready]).integration.disposition,
      "needs-review",
    );
    assert.equal(
      check(output, guard, []).integration.disposition,
      "needs-review",
    );
  }
  for (const guard of [
    `${output} || ${event}`,
    `\${{ ${output} }} && ${event}`,
    `${event} && \${{ ${output} }}`,
    `${output} && always()`,
    `${output} && env.ENABLED == 'true'`,
    `${output} && (${event})`,
    `${output} && ${event} && needs.other.outputs.ok == 'true'`,
    `${output.replace("'true'", "'false'")} && ${event}`,
  ])
    assert.equal(
      check(output, guard).integration.disposition,
      "needs-review",
      guard,
    );
  assert.equal(
    check(`${output} && ${event}`, `${output} && github.event_name == 'push'`)
      .integration.disposition,
    "needs-review",
  );
});

test("literal npm workspaces preserve command classification and teardown gaps", () => {
  const teardown = {
    uses: `${setup.uses.split("@")[0]}/teardown@${APPROVED_RELEASE_SHA}`,
  };
  for (const selector of [
    "-w apps/research",
    "--workspace apps/research",
    "--workspace=apps/research",
  ]) {
    const script = { run: `npm ${selector} run build` };
    assert.equal(inspect([script]).integration.disposition, "no-js-ci");
    assert.equal(inspect([script]).status, "unknown");
    for (const verb of ["ci", "exec -- wrangler --env production"]) {
      const install = { run: `npm ${selector} ${verb}` };
      assert.equal(
        inspect([setup, install]).integration.disposition,
        "integrated",
      );
      assert.equal(inspect([install]).integration.disposition, "needs-sfw");
      assert.equal(
        inspect([setup, teardown, install]).integration.disposition,
        "needs-sfw",
      );
    }
  }
  for (const run of [
    "npm -w $APP run build",
    "npm -w apps/${{ matrix.app }} run build",
    "npm -w ../outside ci",
    "npm -w --userconfig ci",
    "npm -w apps/research --userconfig other ci",
    "npm -w apps/research exec wrangler",
  ])
    assert.notEqual(
      inspect([setup, { run }]).integration.disposition,
      "integrated",
      run,
    );
  assert.equal(
    inspect([
      setup,
      { run: "npm -w apps/research ci --registry=https://example.invalid" },
    ]).integration.disposition,
    "needs-sfw",
  );
});

test("literal npx package selectors retain all download and configuration boundaries", () => {
  for (const run of [
    "npx --yes --package renovate@43.257.6 renovate-config-validator --strict default.json",
    "npx -p @scope/tool@1.2.3 tool --env $ENVIRONMENT",
    "npx --package=tool --package=other tool --registry=https://payload.invalid",
    "npm exec -- wrangler --env $ENVIRONMENT",
  ]) {
    const result = inspect([setup, { run }]);
    assert.equal(result.integration.disposition, "integrated", run);
    assert.equal(result.status, "unknown", run);
    assert.equal(inspect([{ run }]).integration.disposition, "needs-sfw", run);
  }
  for (const run of [
    "npx --package=$PACKAGE tool",
    "npx --package $ARTIFACTS/tool.tgz tool",
    "npx --package=https://example.invalid/tool.tgz tool",
    "npx --package tool",
    "bunx --package tool tool",
    "npm exec -- $TOOL",
    "npm exec -- https://example.invalid/tool.tgz",
  ])
    assert.equal(
      inspect([setup, { run }]).integration.disposition,
      "needs-review",
      run,
    );
  assert.equal(
    inspect([setup, { run: "npx --package --userconfig tool" }]).integration
      .disposition,
    "needs-sfw",
  );
  assert.equal(
    inspect([
      setup,
      { run: "npx --package tool --registry=https://example.invalid tool" },
    ]).integration.disposition,
    "needs-sfw",
  );
  assert.equal(
    inspect([
      setup,
      { run: "npm exec --registry=https://example.invalid -- tool" },
    ]).integration.disposition,
    "needs-sfw",
  );
});

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
