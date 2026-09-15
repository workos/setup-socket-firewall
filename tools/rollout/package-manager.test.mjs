import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { auditRepository } from "./audit.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";

const sha = "a".repeat(40);
const checkout = { uses: `actions/checkout@${"b".repeat(40)}` };
const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: { token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}" },
};
const run = `set -euo pipefail
pnpm_package="$(node --print 'require("./package.json").packageManager')"
npm install --global "$pnpm_package" --ignore-scripts --no-audit --no-fund`;

async function inspect({
  packageManager = "pnpm@11.20.0",
  steps = [checkout, setup, { run }],
  job = {},
  files = {},
  manifestMode = "100644",
} = {}) {
  const sources = {
    ".github/workflows/ci.yml": stringify({
      on: "push",
      jobs: { check: { ...job, steps } },
    }),
    "package.json": JSON.stringify({ packageManager }),
    ...files,
  };
  const reads = [];
  const result = await auditRepository(
    {
      getRef: async () => ({ object: { sha } }),
      getTree: async () => ({
        truncated: false,
        tree: Object.keys(sources).map((path) => ({
          path,
          type: "blob",
          mode: path === "package.json" ? manifestMode : "100644",
        })),
      }),
      getText: async (repository, path, ref) => {
        assert.equal(ref, sha);
        reads.push(path);
        if (!Object.hasOwn(sources, path)) throw new Error("missing source");
        return sources[path];
      },
    },
    { name: "fixture", defaultBranch: "main", visibility: "private" },
  );
  return { ...result, reads };
}

test("root packageManager bootstrap resolves the captured pin, not an arbitrary variable", async () => {
  const result = await inspect();
  assert.equal(result.disposition, "integrated");
  assert.equal(result.assuranceDisposition, "needs-review");
  assert.ok(result.reads.includes("package.json"));
  assert.equal(
    (await inspect({ steps: [checkout, { run }] })).disposition,
    "needs-sfw",
  );
  assert.equal(
    (
      await inspect({ steps: [checkout, setup, { run: "npm ci" }] })
    ).reads.includes("package.json"),
    false,
  );
});

test("unresolved or changed packageManager source never clears the finding", async () => {
  for (const packageManager of [
    null,
    ["pnpm@11.20.0"],
    { packageManager: "pnpm@11.20.0" },
    "pnpm@latest",
    "pnpm@11.20.0\n",
    "pnpm@^11.20.0",
    "pnpm@https://example.com/pnpm.tgz",
    "--registry=https://example.com",
    "pnpm@11.20.0\nnpm install evil",
    "npm@11.0.0",
  ])
    assert.equal(
      (await inspect({ packageManager })).disposition,
      "needs-review",
      String(packageManager),
    );
  for (const changed of [
    { steps: [setup, { run }] },
    { steps: [checkout, setup, { uses: 42 }, { run }] },
    { steps: [{ ...checkout, with: { ref: "other" } }, setup, { run }] },
    { steps: [{ ...checkout, with: { path: "nested" } }, setup, { run }] },
    { steps: [checkout, setup, { run: "node rewrite-package.mjs" }, { run }] },
    {
      steps: [checkout, setup, { uses: "./rewrite" }, { run }],
      files: {
        "rewrite/action.yml": stringify({
          runs: {
            using: "composite",
            steps: [{ shell: "bash", run: "node rewrite-package.mjs" }],
          },
        }),
      },
    },
    { steps: [checkout, setup, { run, "working-directory": "nested" }] },
    { job: { defaults: { run: { "working-directory": "nested" } } } },
    { job: { env: { NODE_OPTIONS: "--require ./rewrite.cjs" } } },
    { files: { ".npmrc": "registry=https://other.invalid/" } },
    {
      steps: [
        checkout,
        setup,
        { run: `${run}\nnpm config set registry https://other.invalid/` },
      ],
    },
    {
      steps: [
        checkout,
        setup,
        { run: run.replace("--no-fund", "--registry=https://other.invalid/") },
      ],
    },
  ])
    assert.notEqual(
      (await inspect(changed)).disposition,
      "integrated",
      JSON.stringify(changed),
    );
  assert.equal(
    (await inspect({ manifestMode: "120000" })).disposition,
    "audit-error",
  );
  assert.equal(
    (await inspect({ files: { "package.json": "{broken" } })).disposition,
    "audit-error",
  );
});
