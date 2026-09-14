import assert from "node:assert/strict";
import test from "node:test";
import { classifyJob } from "./classify.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";
const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: { token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}" },
};
const install = { run: "npm ci" };
const context = { visibility: "private" };
const inspect = (steps, extra = {}) =>
  classifyJob("fixture", { steps }, { ...context, ...extra }, ["push"]);

test("ordinary run guards preserve observed ordering, not boundary reachability", () => {
  for (const guard of [
    "github.ref == 'refs/heads/main'",
    "${{ github.event_name == 'push' }}",
  ]) {
    assert.equal(
      inspect([setup, { ...install, if: guard }]).integration.disposition,
      "integrated",
    );
    assert.equal(
      inspect([{ ...install, if: guard }]).integration.disposition,
      "needs-sfw",
    );
    const row = inspect([
      setup,
      install,
      { run: "npm run deploy", if: guard },
      { run: "npx wrangler deploy --env production", if: guard },
    ]);
    assert.equal(row.integration.disposition, "integrated");
    assert.equal(row.status, "unknown");
    assert.equal(
      inspect([{ ...setup, if: guard }, install]).integration.disposition,
      "needs-review",
    );
  }
  for (const guard of [
    "always()",
    "Always()",
    "failure()",
    "!cancelled()",
    "success() || true",
  ]) {
    assert.equal(
      inspect([setup, { ...install, if: guard }]).integration.disposition,
      "needs-review",
    );
  }
  const localActions = new Map([
    [
      "configure/action.yml",
      `runs:\n  using: composite\n  steps:\n    - uses: ${setup.uses}\n      with:\n        token: '${setup.with.token}'\n`,
    ],
  ]);
  assert.equal(
    inspect(
      [{ uses: "./configure", if: "github.ref == 'refs/heads/main'" }, install],
      { localActions },
    ).integration.disposition,
    "needs-review",
  );
});

test("toolchain version metadata is distinct from package-manager configuration", () => {
  const steps = [setup, install];
  assert.equal(
    classifyJob(
      "fixture",
      { steps, env: { BUN_VERSION: "1.3.14", PNPM_VERSION: "9.15.9" } },
      context,
      ["push"],
    ).integration.disposition,
    "integrated",
  );
  for (const env of [
    { BUN_INSTALL: "/tmp/other" },
    { PNPM_CONFIG_REGISTRY: "https://registry.example.invalid" },
  ]) {
    assert.equal(
      classifyJob("fixture", { steps, env }, context, ["push"]).integration
        .disposition,
      "needs-review",
    );
  }
});

test("GitHub expressions are not literal shell logging", () => {
  for (const run of [
    "echo '${{ inputs.payload }}'\nnpm ci",
    'echo "${{ inputs.payload }}"\nnpm ci',
  ]) {
    assert.equal(
      inspect([setup, { run }]).integration.disposition,
      "needs-review",
    );
    assert.equal(inspect([{ run }]).integration.disposition, "needs-review");
  }
  assert.equal(
    inspect([setup, { run: "echo '$SHELL_LITERAL'\nnpm ci" }]).integration
      .disposition,
    "integrated",
  );
});

test("exhausted local expansion retains covered evidence but requires review", () => {
  const steps = [
    ...Array.from({ length: 997 }, () => ({ run: "echo ok", shell: "bash" })),
    { run: "npm ci --registry=https://example.invalid", shell: "bash" },
  ];
  const localActions = new Map([
    [
      "large/action.yml",
      JSON.stringify({ runs: { using: "composite", steps } }),
    ],
  ]);
  const result = inspect([setup, install, { uses: "./large" }], {
    localActions,
  });
  assert.equal(
    result.operations.at(-1).sourceError,
    "unresolved-local-action-expansion",
  );
  assert.equal(result.integration.downloads[0].status, "covered");
  assert.equal(result.integration.disposition, "needs-review");
});

test("missing, cyclic and malformed local/action source stays visible after install", () => {
  assert.equal(
    inspect([setup, install, { uses: "./missing" }]).integration.disposition,
    "needs-review",
  );
  const localActions = new Map([
    [
      "cycle/action.yml",
      "runs:\n  using: composite\n  steps:\n    - uses: ./cycle\n",
    ],
  ]);
  assert.equal(
    inspect([setup, install, { uses: "./cycle" }], { localActions }).integration
      .disposition,
    "needs-review",
  );
  for (const value of [{ nested: true }, ["not", "a", "scalar"]]) {
    assert.equal(
      inspect([
        setup,
        { uses: "pnpm/action-setup@v4", with: { version: value } },
        install,
      ]).integration.disposition,
      "needs-review",
    );
    assert.equal(
      inspect([
        setup,
        install,
        { uses: "actions/upload-artifact@v4", with: { path: value } },
      ]).integration.disposition,
      "needs-review",
    );
  }
});
