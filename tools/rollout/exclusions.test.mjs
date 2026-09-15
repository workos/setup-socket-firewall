import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { auditRepository } from "./audit.mjs";
import { REGISTRY_EXCLUSIONS } from "./exclusions.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";
import { resolveNoInstallWorkflowCalls } from "./integration.mjs";

const rule = REGISTRY_EXCLUSIONS[0];
const sha = "a".repeat(40);
const checkout = { uses: "actions/checkout@v7" };
const dependencies = { ordinary: "1.0.0", "tree-sitter-kotlin": rule.resolved };
const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: { token: "${{ secrets.PUBLIC_SOCKET_FIREWALL_TOKEN }}" },
};
const install = {
  run: "npm install",
  env: { NPM_CONFIG_REPLACE_REGISTRY_HOST: "npmjs" },
};
async function scan({
  repository = "oagen",
  entry = {},
  extraPackages = {},
  jobs,
  defaults,
  path = rule.workflows[0],
  failRead = false,
  manifest = { dependencies },
  npmrc,
} = {}) {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies },
      "node_modules/ordinary": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/ordinary/-/ordinary-1.0.0.tgz",
      },
      [rule.packagePath]: {
        version: rule.version,
        resolved: rule.resolved,
        integrity: rule.integrity,
        ...entry,
      },
      ...extraPackages,
    },
  };
  const sources = new Map([
    [
      path,
      stringify({
        on: "push",
        defaults,
        jobs: jobs ?? { check: { steps: [checkout, setup, install] } },
      }),
    ],
    [rule.lockfile, JSON.stringify(lock)],
    ["package.json", JSON.stringify(manifest)],
    ...(npmrc === undefined ? [] : [[".npmrc", npmrc]]),
  ]);
  return auditRepository(
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
        assert.equal(repo, `workos/${repository}`);
        if (!sources.has(path) || (failRead && path === rule.lockfile))
          throw new Error("source unavailable");
        return sources.get(path);
      },
    },
    { name: repository, defaultBranch: "main", visibility: "public" },
  );
}

test("approved archives are reported separately from fully integrated repositories", async () => {
  for (const repository of ["oagen", "oagen-emitters"]) {
    const result = await scan({ repository });
    assert.equal(result.disposition, "integrated-with-exclusions");
    assert.equal(result.assuranceDisposition, "needs-review");
    assert.equal(result.exclusions[0].status, "matched");
    assert.equal(
      result.exclusions[0].approvalRequestId,
      "24cb3145-70c0-471a-86b6-3f5d7b5860a0",
    );
    const download = result.workflows[0].jobs[0].integration.downloads[0];
    assert.equal(download.status, "covered-with-exclusion");
    assert.equal(download.exclusionId, `${repository}-tree-sitter-kotlin`);
    assert.equal(
      resolveNoInstallWorkflowCalls([result], "workos")[0].disposition,
      result.disposition,
    );
  }
});

test("OpenAPI records the approved archive without waiving other findings", async () => {
  const overrides = { "js-yaml": "^5.4.1", lodash: "^4.17.23" };
  const npmrc =
    "# Preserve the archive\nreplace-registry-host=npmjs\nomit-lockfile-registry-resolved=true\n";
  const steps = [checkout, setup, { run: "npm ci" }, { run: "npm test" }];
  const options = {
    repository: "openapi-spec",
    manifest: { dependencies, overrides },
    npmrc,
    jobs: { check: { steps } },
  };
  const result = await scan(options);
  assert.equal(result.exclusions[0].status, "matched");
  assert.equal(
    result.exclusions[0].approvalRequestId,
    "bf1c082e-4112-484a-8683-f36854138690",
  );
  assert.deepEqual(result.exclusions[0].workflows, []);
  assert.equal(result.disposition, "integrated-with-exclusions");
  assert.equal(result.assuranceDisposition, "needs-review");
  assert.equal(
    (
      await scan({
        ...options,
        jobs: { check: { steps: [...steps, { uses: "./missing" }] } },
      })
    ).disposition,
    "needs-review",
  );
  assert.equal(
    (
      await scan({
        ...options,
        jobs: { check: { steps }, uncovered: { steps: [{ run: "npm ci" }] } },
      })
    ).disposition,
    "needs-sfw",
  );
  assert.equal(
    (
      await scan({
        ...options,
        jobs: { check: { steps: [checkout, setup, install] } },
      })
    ).disposition,
    "needs-review",
  );
  for (const changes of [
    { npmrc: npmrc.replace("=npmjs", "=never") },
    { npmrc: `${npmrc}@other:registry=https://example.invalid/\n` },
    {
      manifest: { dependencies, overrides: { ...overrides, lodash: "^5.0.0" } },
    },
    {
      manifest: {
        dependencies,
        overrides: { ...overrides, extra: "https://example.invalid/other.tgz" },
      },
    },
    { entry: { integrity: "sha512-changed" } },
    { entry: { resolved: "https://example.invalid/other.tgz" } },
    {
      extraPackages: {
        "node_modules/another": {
          resolved: "https://example.invalid/other.tgz",
        },
      },
    },
  ]) {
    const changed = await scan({ ...options, ...changes });
    assert.equal(changed.exclusions[0].status, "stale");
    assert.equal(changed.disposition, "needs-review");
  }
  assert.equal(
    (await scan({ ...options, npmrc: undefined })).disposition,
    "audit-error",
  );
  // The OpenAPI override snapshot never authorizes overrides in the other repos.
  assert.equal(
    (await scan({ manifest: { dependencies, overrides } })).exclusions[0]
      .status,
    "stale",
  );
});

test("changed pins and additional external sources invalidate the exclusion", async () => {
  for (const entry of [
    { version: "0.5.0" },
    { resolved: rule.resolved.replace("f66d290", "aaaaaaa") },
    { integrity: "sha512-other" },
  ]) {
    const result = await scan({ entry });
    assert.equal(result.exclusions[0].status, "stale");
    assert.equal(result.disposition, "needs-review");
  }
  const result = await scan({
    extraPackages: {
      "node_modules/another": { resolved: "https://example.invalid/other.tgz" },
    },
  });
  assert.equal(result.exclusions[0].status, "stale");
  assert.equal(result.disposition, "needs-review");
  assert.equal((await scan({ failRead: true })).disposition, "audit-error");
  for (const manifest of [
    { dependencies: { extra: "https://example.invalid/extra.tgz" } },
    { overrides: { extra: "https://example.invalid/extra.tgz" } },
    { workspaces: ["packages/*"] },
  ])
    assert.equal((await scan({ manifest })).exclusions[0].status, "stale");
  assert.equal(
    (
      await scan({
        entry: { dependencies: { extra: "github:other/unapproved" } },
      })
    ).exclusions[0].status,
    "stale",
  );
});

test("source exclusions cannot hide other gaps, configuration changes, or repositories", async () => {
  const missing = await scan({
    jobs: { check: { steps: [checkout, install] } },
  });
  assert.equal(missing.disposition, "needs-sfw");
  const sibling = await scan({
    jobs: {
      check: { steps: [checkout, setup, install] },
      uncovered: { steps: [{ run: "npm ci" }] },
    },
  });
  assert.equal(sibling.disposition, "needs-sfw");
  for (const changed of [
    { ...install, env: { ...install.env, HOME: "/elsewhere" } },
    { ...install, "working-directory": "other" },
    { ...install, run: "npm install --registry=https://example.invalid" },
    { ...install, env: { NPM_CONFIG_REPLACE_REGISTRY_HOST: "never" } },
  ])
    assert.equal(
      (await scan({ jobs: { check: { steps: [checkout, setup, changed] } } }))
        .disposition,
      "needs-review",
    );
  assert.equal(
    (await scan({ path: ".github/workflows/new.yml" })).disposition,
    "needs-review",
  );
  for (const changedCheckout of [
    { ...checkout, with: { ref: "other" } },
    { ...checkout, with: { repository: "other/repo" } },
    { ...checkout, with: { path: "other" } },
    { ...checkout, if: false },
  ])
    assert.equal(
      (
        await scan({
          jobs: { check: { steps: [changedCheckout, setup, install] } },
        })
      ).disposition,
      "needs-review",
    );
  const defaults = { run: { "working-directory": "other" } };
  assert.equal((await scan({ defaults })).disposition, "needs-review");
  assert.equal(
    (
      await scan({
        jobs: { check: { defaults, steps: [checkout, setup, install] } },
      })
    ).disposition,
    "needs-review",
  );
  assert.equal(
    (await scan({ jobs: { check: { steps: [setup, install, checkout] } } }))
      .disposition,
    "needs-review",
  );
  const unrelated = await scan({ repository: "unapproved" });
  assert.deepEqual(unrelated.exclusions, []);
  assert.equal(unrelated.disposition, "needs-review");
});
