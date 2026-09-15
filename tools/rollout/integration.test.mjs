import assert from "node:assert/strict";
import test from "node:test";
import { classifyJob, classifyWorkflow } from "./classify.mjs";
import { integrationDisposition } from "./integration.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";
import { runAudit } from "./audit.mjs";

const setup = {
  id: "sfw",
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: {
    token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}",
    "configure-bun": true,
  },
};
const teardown = {
  uses: `workos/setup-socket-firewall/teardown@${APPROVED_RELEASE_SHA}`,
};
const install = { run: "npm ci" };
const build = { run: "npm run build" };
const context = { visibility: "private" };
function job(steps, properties = {}, overrides = {}) {
  return classifyJob(
    "fixture",
    { steps, ...properties },
    { ...context, ...overrides },
    ["push"],
  );
}
const primary = (...args) => job(...args).integration.disposition;

test("observed install coverage and opaque execution are separate", () => {
  const result = job([setup, install, build]);
  assert.equal(result.status, "unknown");
  assert.equal(result.integration.disposition, "integrated");
  assert.equal(result.integration.downloads[0].status, "covered");
  assert.ok(result.integration.notes.includes("opaque-execution"));
  assert.equal(primary([install, build]), "needs-sfw");
  assert.equal(primary([setup, install, teardown, build]), "integrated");
  assert.equal(primary([setup, install, build, install]), "integrated");
  assert.equal(primary([build, setup, install]), "integrated");
});

test("an integrated sibling cannot hide a missing or unresolved install job", () => {
  assert.equal(
    integrationDisposition([
      { jobs: [job([setup, install]), job([install, build])] },
    ]),
    "needs-sfw",
  );
  assert.equal(
    integrationDisposition([{ jobs: [job([setup, install]), job([build])] }]),
    "integrated",
  );
  assert.equal(primary([{ uses: "./unresolved" }]), "needs-review");
  assert.equal(
    primary([
      { run: "go build ./..." },
      { uses: "actions/upload-artifact@v4" },
    ]),
    "no-js-ci",
  );
  assert.equal(primary([{ run: "git status" }]), "no-js-ci");
});

test("supported toolchain roles preserve intervals without synthesizing setup", () => {
  for (const tool of [
    { uses: "pnpm/action-setup@v4" },
    {
      uses: "pnpm/action-setup@v4",
      with: { version: "10", run_install: false },
    },
    { uses: "oven-sh/setup-bun@v2", with: { "bun-version": "1.3.14" } },
  ]) {
    assert.equal(primary([setup, tool, install, build]), "integrated");
    assert.equal(primary([tool, install, build]), "needs-sfw");
    assert.equal(job([setup, tool, install]).status, "unknown");
  }
  for (const tool of [
    { uses: "pnpm/action-setup@v4", with: { run_install: true } },
    { uses: "pnpm/action-setup@v4", with: { custom: "anything" } },
    { uses: "pnpm/action-setup/other@v4" },
    { uses: "untrusted/action-setup@v4" },
    {
      uses: "oven-sh/setup-bun@v2",
      with: { "bun-download-url": "https://example.invalid/bun" },
    },
    { uses: "oven-sh/setup-bun/other@v2" },
  ])
    assert.equal(primary([setup, tool, install]), "integrated");
  assert.equal(
    primary([
      setup,
      {
        uses: "pnpm/action-setup@v4",
        with: { run_install: "${{ inputs.install }}" },
      },
      install,
    ]),
    "needs-review",
  );
});

test("job reachability and harmless context do not alter install ordering", () => {
  assert.equal(
    primary([setup, install], {
      if: "github.ref == 'refs/heads/main'",
      env: { CI: true },
      defaults: { run: { shell: "bash" } },
    }),
    "integrated",
  );
  assert.equal(primary([setup, install], { if: false }), "no-js-ci");
  const workflow = classifyWorkflow(
    "on: push\ndefaults:\n  run:\n    shell: bash\nenv:\n  CI: true\njobs:\n  test:\n    steps:\n      - uses: " +
      setup.uses +
      "\n        with:\n          token: '${{ secrets.SOCKET_FIREWALL_TOKEN }}'\n      - run: npm ci\n",
    { ...context, path: ".github/workflows/ci.yml" },
  );
  assert.equal(integrationDisposition([workflow]), "integrated");
  assert.equal(
    primary([setup, { ...install, env: { NODE_ENV: "production" } }]),
    "integrated",
  );
  for (const env of [
    { NPM_CONFIG_REGISTRY: "https://example.invalid" },
    { PATH: "/custom" },
    { HOME: "/custom" },
    { BASH_ENV: "startup.sh" },
    { "${{ inputs.key }}": "value" },
    { UNMODELED: {} },
  ]) {
    assert.equal(primary([setup, install], { env }), "needs-review");
    assert.equal(primary([setup, { ...install, env }]), "needs-review");
  }
  assert.equal(
    primary([setup, install], { defaults: { run: { shell: "pwsh" } } }),
    "needs-review",
  );
});

test("public fallback is recorded as an exception, not missing integration", () => {
  const fallback = {
    ...setup,
    with: {
      token: "${{ secrets.PUBLIC_SOCKET_FIREWALL_TOKEN }}",
      "allow-external-fork-fallback": true,
    },
  };
  const result = job([fallback, install, build], {}, { visibility: "public" });
  assert.equal(result.integration.disposition, "integrated");
  assert.equal(result.integration.downloads[0].status, "fork-exception");
  assert.equal(result.status, "unknown");
  assert.equal(
    primary([
      {
        ...setup,
        with: { ...setup.with, "allow-external-fork-fallback": true },
      },
      install,
    ]),
    "needs-sfw",
  );
  assert.equal(
    primary([
      {
        ...setup,
        with: {
          ...setup.with,
          "allow-external-fork-fallback": "${{ inputs.fallback }}",
        },
      },
      install,
    ]),
    "needs-review",
  );
});

test("per-download negative controls remain actionable or unresolved", () => {
  for (const steps of [
    [{ ...setup, if: false }, install, build],
    [install, setup, install],
    [setup, install, teardown, install, build],
    [{ ...setup, uses: "workos/setup-socket-firewall@v1" }, install],
    [{ ...setup, with: { token: "wrong" } }, install],
    [
      { ...setup, with: { ...setup.with, "configure-bun": false } },
      { run: "bun install" },
    ],
    [setup, { run: "npm ci --reg=https://example.invalid" }],
    [{ run: "corepack enable" }, setup, { run: "pnpm install" }],
  ])
    assert.equal(primary(steps), "needs-sfw");
  for (const steps of [
    [{ ...setup, if: "github.ref == 'refs/heads/main'" }, install],
    [{ ...setup, "continue-on-error": true }, install],
    [setup, { run: "npm ci --future-option=unknown" }],
    [setup, { run: "npm --prefix help ci" }],
    [setup, { uses: "./unresolved" }, install],
    [setup, { run: "corepack enable pnpm" }, { run: "pnpm install" }],
  ])
    assert.equal(primary(steps), "needs-review");
});

test("teardown guards establish only the appropriate success-path boundary", () => {
  for (const condition of [
    "always()",
    "${{ always() && steps.sfw.outputs.active == 'true' }}",
  ]) {
    const clean = job([
      setup,
      install,
      { ...teardown, if: condition },
      { run: "npm publish" },
    ]);
    assert.equal(clean.integration.disposition, "integrated");
    assert.equal(clean.status, "unknown");
    assert.ok(
      !clean.violations.some((v) => v.includes("without a same-SHA teardown")),
    );
    assert.equal(
      primary([setup, install, { ...teardown, if: condition }, install]),
      "needs-sfw",
    );
    assert.notEqual(
      job([
        setup,
        install,
        { ...teardown, if: condition },
        { run: "npm publish", if: "always()" },
      ]).status,
      "protected",
    );
  }
  for (const boundary of [
    { ...teardown, if: "always() && steps.other.outputs.active == 'true'" },
    { ...teardown, if: "always()", "continue-on-error": true },
    { ...teardown, if: "inputs.cleanup" },
  ]) {
    assert.equal(
      job([setup, install, boundary, { run: "npm publish" }]).status,
      "unsafe-publish",
    );
    assert.equal(primary([setup, install, boundary, install]), "needs-review");
  }
});

test("audit v2 separates primary integration counts from assurance and errors", async () => {
  const workflow = `on: push\njobs:\n  build:\n    steps:\n      - uses: ${setup.uses}\n        with: { token: '${setup.with.token}' }\n      - run: npm ci\n      - run: npm test\n`;
  const client = {
    listRestRepositories: async () =>
      ["app", "broken"].map((name) => ({
        name,
        default_branch: "main",
        archived: false,
        visibility: "private",
      })),
    listGraphqlRepositories: async () =>
      ["app", "broken"].map((name) => ({
        name,
        isArchived: false,
        visibility: "private",
      })),
    getRef: async () => ({ object: { sha: "a".repeat(40) } }),
    getTree: async (repo) => ({
      truncated: repo.endsWith("broken"),
      tree: [
        { path: ".github/workflows/ci.yml", type: "blob", mode: "100644" },
      ],
    }),
    getText: async () => workflow,
  };
  const report = await runAudit(client);
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.dispositions, { "audit-error": 1, integrated: 1 });
  assert.deepEqual(report.assuranceDispositions, {
    "audit-error": 1,
    "needs-review": 1,
  });
  assert.equal(report.scanStatus, "partial");
  assert.equal(report.scanErrors, 1);
  assert.equal(report.runtimeVerification, "not-performed");
  assert.equal(
    integrationDisposition([
      classifyWorkflow("on: [", { ...context, path: "fixture" }),
    ]),
    "needs-review",
  );
});

test("malformed steps cannot become no-js-ci or integrated", () => {
  for (const steps of [
    undefined,
    null,
    [],
    [null],
    [{}],
    [setup, install, {}],
  ]) {
    assert.equal(job(steps).integration.disposition, "needs-review");
  }
  assert.equal(
    integrationDisposition([
      classifyWorkflow("on: push\njobs:\n  bad: false\n", {
        visibility: "private",
      }),
    ]),
    "needs-review",
  );
});

test("explicit unparsed JS installers remain candidates, generic executors do not", () => {
  for (const run of [
    "uv run npm ci",
    "poetry run npm ci",
    "command npm ci",
    "npm --prefix help ci",
  ]) {
    assert.equal(job([{ run }]).integration.disposition, "needs-review", run);
    assert.equal(
      integrationDisposition([
        { jobs: [job([setup, install]), job([{ run }])] },
      ]),
      "needs-review",
      run,
    );
  }
  for (const run of [
    "go run bootstrap.go",
    "python scripts/bootstrap.py",
    "CI=1 make bootstrap",
    "CI=1 node scripts/bootstrap.mjs",
    "CI=1 ./scripts/bootstrap.sh",
    "${{ inputs.command }}",
  ]) {
    assert.equal(primary([{ run }]), "no-js-ci");
    assert.equal(
      integrationDisposition([
        { jobs: [job([setup, install]), job([{ run }])] },
      ]),
      "integrated",
    );
  }
  assert.equal(
    job([], {
      uses: "example/shared/.github/workflows/build.yml@main",
      if: false,
    }).integration.disposition,
    "no-js-ci",
  );
});

test("dynamic Bun configuration and uncertain local boundaries stay unresolved", () => {
  assert.equal(
    job([
      {
        ...setup,
        with: { ...setup.with, "configure-bun": "${{ inputs.bun }}" },
      },
      { run: "bun install" },
    ]).integration.disposition,
    "needs-review",
  );
  const localActions = new Map([
    [
      "inner/action.yml",
      `runs:\n  using: composite\n  steps:\n    - uses: ${setup.uses}\n      with: { token: '${setup.with.token}' }\n    - run: npm ci\n      shell: bash\n`,
    ],
  ]);
  const nested = classifyJob(
    "fixture",
    { steps: [{ uses: "./inner", if: "inputs.install" }] },
    { visibility: "private", localActions },
    ["push"],
  );
  assert.equal(nested.integration.disposition, "needs-review");
  assert.equal(
    job([setup, { uses: "pnpm/action-setup" }, install]).integration
      .disposition,
    "integrated",
  );
});

test("active-output teardown does not confuse composite-local step IDs with job IDs", () => {
  const localActions = new Map([
    [
      "inner/action.yml",
      `runs:\n  using: composite\n  steps:\n    - uses: ${setup.uses}\n      id: sfw\n      with: { token: '${setup.with.token}' }\n    - run: npm ci\n      shell: bash\n`,
    ],
  ]);
  const result = classifyJob(
    "fixture",
    {
      steps: [
        { uses: "./inner" },
        { ...teardown, if: "always() && steps.sfw.outputs.active == 'true'" },
        { run: "npm publish" },
      ],
    },
    { visibility: "private", localActions },
    ["push"],
  );
  assert.equal(result.status, "unsafe-publish");
  assert.equal(primary([{ run: "git diff file.js" }]), "no-js-ci");
});

test("Corepack uncertainty survives setup and conditional or targeted controls", () => {
  for (const steps of [
    [
      { run: "corepack enable" },
      { run: "corepack disable", if: "inputs.disable_corepack" },
    ],
    [{ run: "corepack enable", if: "inputs.enable_corepack" }],
    [{ run: "corepack enable pnpm", if: "inputs.enable_corepack" }],
    [{ run: "corepack enable pnpm" }],
    [
      { run: "corepack enable" },
      { run: "corepack disable yarn", if: "inputs.disable_corepack" },
    ],
  ]) {
    const result = job([...steps, setup, { run: "pnpm install" }]);
    assert.equal(result.integration.disposition, "needs-review");
    assert.equal(result.integration.downloads[0].status, "unresolved");
  }
  assert.equal(
    primary([
      { run: "corepack enable", if: "inputs.enable_corepack" },
      { run: "corepack disable" },
      setup,
      { run: "pnpm install" },
    ]),
    "integrated",
  );
  assert.equal(
    primary([
      { run: "corepack enable pnpm", if: "inputs.enable_corepack" },
      { run: "corepack disable" },
      setup,
      { run: "pnpm install" },
    ]),
    "integrated",
  );
  assert.equal(
    primary([{ run: "corepack enable" }, setup, { run: "pnpm install" }]),
    "needs-sfw",
  );
});

test("script diagnostics survive later setup without becoming invented installs", () => {
  for (const before of [
    [],
    [{ ...setup, if: "inputs.enable_sfw" }],
    [{ ...setup, with: { token: "wrong" } }],
    [setup, install, teardown],
  ]) {
    const result = job([
      ...before,
      { run: "npm run bootstrap" },
      setup,
      install,
    ]);
    assert.equal(result.integration.disposition, "integrated");
    assert.ok(
      result.integration.notes.includes("package-script-code-unverified"),
    );
    assert.equal(result.status, "unknown");
  }
});

test("malformed local source remains review even after a covered install", () => {
  for (const text of [
    "runs: [",
    "runs: false",
    "runs: { using: composite, steps: false }",
    "false",
  ]) {
    const result = job(
      [setup, install, { uses: "./broken" }],
      {},
      {
        localActions: new Map([["broken/action.yml", text]]),
      },
    );
    assert.equal(result.integration.disposition, "needs-review");
    assert.ok(result.operations.some((operation) => operation.sourceError));
    assert.equal(result.integration.downloads[0].status, "covered");
  }
});

test("inline environment and unsupported env wrappers retain installer candidates", () => {
  for (const run of [
    "HOME=/tmp npm ci",
    "PATH=/tmp npm ci",
    "NODE_OPTIONS=--require=./bootstrap.cjs npm ci",
    "env HOME=/tmp npm ci",
    "env -i npm ci",
    "env --ignore-environment npm ci",
    "env --unset=HOME npm ci",
    "1BAD=x npm ci",
    "sudo npm ci",
    "time npm ci",
    "exec npm ci",
  ]) {
    assert.equal(primary([setup, { run }]), "needs-review", run);
    assert.equal(primary([{ run }]), "needs-review", run);
    assert.equal(
      integrationDisposition([
        { jobs: [job([setup, install]), job([{ run }])] },
      ]),
      "needs-review",
      run,
    );
  }
  for (const run of ["CI=1 npm ci", "env CI=1 npm ci"]) {
    assert.equal(primary([setup, { run }]), "integrated", run);
    assert.equal(primary([{ run }]), "needs-sfw", run);
    assert.notEqual(job([setup, { run }]).status, "protected");
  }
  assert.equal(
    primary([{ run: "git status" }, { uses: "actions/upload-artifact@v4" }]),
    "no-js-ci",
  );
});

test("only bounded literal logging and safe shell prologues preserve direct installs", () => {
  for (const prefix of [
    "set -e",
    "set -euo pipefail",
    'echo "Installing dependencies"',
    "echo 'Installing dependencies'",
    'echo "source: npm ci; npm ci"',
    'echo "--registry=https://example.invalid"',
  ]) {
    const run = `${prefix}\nnpm ci`;
    assert.equal(primary([setup, { run }]), "integrated", run);
    assert.equal(primary([{ run }]), "needs-sfw", run);
    assert.notEqual(job([setup, { run }]).status, "protected");
  }
  for (const run of [
    'echo "literal source: npm ci"',
    'echo "source: npm ci; npm ci"',
    "echo 'source: npm ci && npm ci'",
  ]) {
    assert.notEqual(primary([setup, { run }]), "integrated", run);
    assert.notEqual(primary([{ run }]), "needs-sfw", run);
  }
});

test("ordinary package script roles preserve observed setup, never assure script code", () => {
  for (const run of [
    "npm run build",
    "npm test",
    "npm test -- --runInBand",
    "pnpm run lint",
    "bun run build",
    "yarn test",
  ]) {
    const result = job([
      setup,
      { run },
      { run: "npx wrangler deploy --env production" },
    ]);
    assert.equal(result.integration.disposition, "integrated", run);
    assert.equal(result.status, "unknown", run);
    assert.ok(
      result.integration.notes.includes("package-script-code-unverified"),
    );
    assert.equal(primary([setup, { run }]), "no-js-ci", run);
    assert.equal(primary([{ run }, setup, install]), "integrated", run);
  }
  for (const run of ["npm --prefix scripts run build"]) {
    assert.notEqual(primary([setup, { run }, install]), "integrated", run);
  }
  assert.equal(primary([setup, build, teardown, install]), "needs-sfw");
  assert.equal(
    primary([
      setup,
      build,
      { run: "npm config set registry https://example.invalid" },
      install,
    ]),
    "needs-sfw",
  );
});

test("direct executor target arguments are not installer configuration", () => {
  for (const run of [
    "npx wrangler deploy --env production",
    "npx -y wrangler deploy --env production",
    "npx --package=tool tool",
    "bunx biome check --write",
    "npx tool --registry=https://example.invalid",
    "npx tool --env $ENVIRONMENT",
    "npx tool $(node bootstrap.mjs)",
  ]) {
    const result = job([setup, { run }]);
    assert.equal(result.integration.disposition, "integrated", run);
    assert.equal(result.status, "unknown", run);
    assert.ok(result.integration.notes.includes("executor-code-unverified"));
    assert.equal(primary([{ run }]), "needs-sfw", run);
  }
  for (const run of [
    "npx --registry=https://example.invalid wrangler",
    "bunx --reg=https://example.invalid tool",
    "npx --@scope:registry=https://example.invalid tool",
  ]) {
    assert.equal(primary([setup, { run }]), "needs-sfw", run);
  }
  for (const run of [
    "npx --future-option tool",
    "npx --package=$PACKAGE tool",
    "npx $TOOL --env production",
    "npx",
    "npm exec tool -- --env production",
    "npm exec tool",
    "env -i npx tool",
  ])
    assert.equal(primary([setup, { run }]), "needs-review", run);
});

test("application environment and sibling services do not change observed host routing", () => {
  const env = {
    APP_TOKEN: "${{ secrets.APP_TOKEN }}",
    CI: "${{ inputs.ci }}",
    DEPLOY_ENV: "production",
  };
  assert.equal(primary([setup, install], { env }), "integrated");
  assert.equal(primary([setup, { ...install, env }]), "integrated");
  assert.equal(job([setup, install], { env }).status, "unknown");
  const workflow = classifyWorkflow(
    `on: push\nenv:\n  APP_TOKEN: '${env.APP_TOKEN}'\njobs:\n  test:\n    steps:\n      - uses: ${setup.uses}\n        with: { token: '${setup.with.token}' }\n      - run: npm ci\n`,
    context,
  );
  assert.equal(integrationDisposition([workflow]), "integrated");
  for (const key of [
    "npm_config_registry",
    "PNPM_HOME",
    "BUN_CONFIG",
    "YARN_RC_FILENAME",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "BASH_ENV",
    "ENV",
    "SHELL",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "bad-key",
  ]) {
    assert.equal(
      primary([setup, install], { env: { [key]: "${{ secrets.VALUE }}" } }),
      "needs-review",
      key,
    );
  }
  for (const env of ["${{ inputs.environment }}", [], null, { APP_TOKEN: {} }])
    assert.equal(primary([setup, install], { env }), "needs-review");
  const services = { database: { image: "postgres:17" } };
  assert.equal(primary([setup, install], { services }), "integrated");
  assert.equal(primary([install], { services }), "needs-sfw");
  assert.equal(job([setup, install], { services }).status, "unknown");
  assert.equal(
    primary([setup, install], { container: "node:22" }),
    "needs-review",
  );
});

test("unresolved setup token forwarding is not evidence of a wrong token", () => {
  for (const token of [
    "${{ inputs.token }}",
    "${{ secrets[inputs.token_name] }}",
  ]) {
    const result = job([{ ...setup, with: { token } }, install]);
    assert.equal(result.integration.disposition, "needs-review");
    assert.equal(
      result.integration.downloads[0].reason,
      "unresolved-setup-token",
    );
    assert.notEqual(result.status, "protected");
  }
  for (const token of [
    "wrong",
    "",
    "${{ secrets.PUBLIC_SOCKET_FIREWALL_TOKEN }}",
  ])
    assert.equal(
      primary([{ ...setup, with: { token } }, install]),
      "needs-sfw",
    );
  assert.equal(primary([install]), "needs-sfw");
});

test("exact npm lockfile host replacement preserves the configured registry", () => {
  assert.equal(
    primary([setup, { run: "npm ci --replace-registry-host=always" }]),
    "integrated",
  );
  assert.equal(
    primary([{ run: "npm ci --replace-registry-host=always" }]),
    "needs-sfw",
  );
  for (const option of [
    "--registry=https://example.invalid",
    "--reg=https://example.invalid",
    "--@scope:registry=https://example.invalid",
  ])
    assert.equal(
      primary([
        setup,
        { run: `npm ci --replace-registry-host=always ${option}` },
      ]),
      "needs-sfw",
    );
  for (const run of [
    "npm ci --replace-registry-host=never",
    "npm ci --replace-registry-host=npmjs",
    "npm ci --replace-registry-host=example.invalid",
    "npm ci --replace-registry-host always",
    "pnpm install --replace-registry-host=always",
  ])
    assert.equal(primary([setup, { run }]), "needs-review", run);
});
