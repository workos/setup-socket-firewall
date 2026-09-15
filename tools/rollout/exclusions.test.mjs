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
        if (failRead && path === rule.lockfile)
          throw new Error("lockfile unavailable");
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
