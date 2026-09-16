import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stringify } from "yaml";
import { auditRepository } from "./audit.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";

const sha = "c".repeat(40);
const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: { token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}" },
};
const action = stringify({
  runs: { using: "composite", steps: [{ shell: "bash", run: "npm ci" }] },
});
const captured = JSON.parse(
  readFileSync(new URL("./fixtures/approved-release.json", import.meta.url)),
);
async function audit(
  steps,
  files = { "actions/install/action.yml": action },
  entries = [],
  on = "push",
) {
  files = {
    ...files,
    ".github/workflows/ci.yml": stringify({
      on,
      jobs: { test: { "runs-on": "ubuntu-latest", steps } },
    }),
  };
  const reads = [];
  const result = await auditRepository(
    {
      async getRef() {
        return { object: { sha } };
      },
      async getTree() {
        return {
          truncated: false,
          tree: [
            ...Object.keys(files)
              .filter((path) => !entries.some((e) => e.path === path))
              .map((path) => ({ path, type: "blob", mode: "100644" })),
            ...entries,
          ],
        };
      },
      async getText(_repo, path, ref) {
        assert.equal(ref, sha);
        reads.push(path);
        assert.ok(Object.hasOwn(files, path), path);
        return files[path];
      },
    },
    { name: "fixture", defaultBranch: "main", visibility: "private" },
  );
  return { result, reads };
}

test("a same-snapshot checkout mount resolves its local action, preserving uncovered installs", async () => {
  const checkout = { uses: "actions/checkout@v4", with: { path: "source" } };
  const local = { uses: "./source/actions/install" };
  const { result, reads } = await audit([checkout, setup, local]);
  assert.equal(result.disposition, "integrated");
  assert.ok(reads.includes("actions/install/action.yml"));
  assert.equal(
    (await audit([checkout, local])).result.disposition,
    "needs-sfw",
  );
  assert.equal(
    (await audit([local, checkout])).result.disposition,
    "needs-review",
  );
  for (const withInput of [
    { path: "source", repository: "other/repo" },
    { path: "source", ref: "other-branch" },
    { path: "source", ref: "${{ inputs.checker-ref }}" },
    { path: "source", "sparse-checkout": "something-else" },
    { path: "../source" },
  ])
    assert.equal(
      (await audit([{ ...checkout, with: withInput }, setup, local])).result
        .disposition,
      "needs-review",
    );
  for (const extra of [
    { if: "inputs.enabled" },
    { "continue-on-error": true },
    { env: { PATH: "/other" } },
  ])
    assert.equal(
      (await audit([{ ...checkout, ...extra }, setup, local])).result
        .disposition,
      "needs-review",
    );
  assert.equal(
    (
      await audit([
        checkout,
        {
          uses: "actions/checkout@v4",
          with: { repository: "other/repo", path: "${{ env.DESTINATION }}" },
        },
        setup,
        local,
      ])
    ).result.disposition,
    "needs-review",
  );
});

test("a caller-selected checker revision is unresolved provenance, not a nonexistent local action", async () => {
  const { result, reads } = await audit([
    { uses: "actions/checkout@v4" },
    {
      uses: "actions/checkout@v4",
      with: {
        repository: "workos/fixture",
        ref: "${{ inputs.checker-ref }}",
        path: ".checker",
      },
    },
    { uses: "./.checker/actions/install" },
  ]);
  assert.equal(result.disposition, "needs-review");
  const operation = result.workflows[0].jobs[0].operations.find(
    (o) => o.kind === "unknown-local-action",
  );
  assert.equal(operation.sourceError, "unresolved-checkout-source");
  assert.equal(operation.checkoutRef, "${{ inputs.checker-ref }}");
  assert.equal(reads.includes("actions/install/action.yml"), false);
});

test("local SFW entrypoints require all immutable reviewed runtime blobs", async () => {
  const files = Object.fromEntries(
    Object.entries(captured.contents).map(([path, entry]) => [
      path,
      Buffer.from(entry.content, "base64").toString(),
    ]),
  );
  const entries = captured.tree.tree.filter((e) => e.type === "blob");
  const steps = [
    { uses: "actions/checkout@v4" },
    { uses: "./", with: setup.with },
    { run: "npm ci" },
  ];
  const { result } = await audit(steps, files, entries);
  assert.equal(result.disposition, "integrated");
  assert.equal(result.assuranceDisposition, "needs-review");
  assert.ok(
    result.workflows[0].jobs[0].integration.notes.includes(
      "local-runtime-matches-approved-release",
    ),
  );
  for (const path of [
    "action.yml",
    "scripts/configure.sh",
    "scripts/teardown.sh",
    "teardown/action.yml",
  ])
    assert.notEqual(
      (
        await audit(
          steps,
          files,
          entries.map((e) =>
            e.path === path ? { ...e, sha: "f".repeat(40) } : e,
          ),
        )
      ).result.disposition,
      "integrated",
    );
  assert.equal(
    (
      await audit(
        [
          { uses: "actions/checkout@v4", with: { ref: "other" } },
          ...steps.slice(1),
        ],
        files,
        entries,
      )
    ).result.disposition,
    "needs-sfw",
  );
  assert.notEqual(
    (
      await audit(
        [steps[0], { ...steps[1], with: {} }, steps[2]],
        files,
        entries,
      )
    ).result.disposition,
    "integrated",
  );
  assert.notEqual(
    (await audit(steps.slice(1), files, entries)).result.disposition,
    "integrated",
  );
  assert.notEqual(
    (
      await audit(
        [{ ...steps[0], if: false }, ...steps.slice(1)],
        files,
        entries,
      )
    ).result.disposition,
    "integrated",
  );
  assert.notEqual(
    (await audit(steps, files, entries, "workflow_call")).result.disposition,
    "integrated",
  );
  assert.equal(
    (
      await audit(
        [
          { ...steps[0], with: { repository: "workos/fixture", ref: sha } },
          ...steps.slice(1),
        ],
        files,
        entries,
        "workflow_call",
      )
    ).result.disposition,
    "integrated",
  );
  assert.equal(
    (
      await audit(
        [...steps, { uses: "./teardown" }, { run: "npm ci" }],
        files,
        entries,
      )
    ).result.disposition,
    "needs-sfw",
  );
});
