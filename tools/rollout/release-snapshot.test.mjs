import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GitHubClient } from "./github.mjs";
import { APPROVED_RUNTIME_BLOBS } from "./constants.mjs";
import { verifyActionRelease } from "./release.mjs";

const snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/approved-release.json", import.meta.url)),
);
function client(data, historicalRefs = false) {
  const prefix = `repos/${data.provenance.repository}`;
  const replies = new Map([
    [`${prefix}/git/commits/${data.commit.sha}`, data.commit],
    [`${prefix}/git/trees/${data.commit.tree.sha}?recursive=1`, data.tree],
    ...Object.entries(data.contents).map(([path, body]) => [
      `${prefix}/contents/${path}?ref=${data.commit.sha}`,
      body,
    ]),
    ...Object.values(data.discovery).map((body) => [
      `${prefix}/git/ref/${body.ref.slice(5)}`,
      historicalRefs
        ? { ...body, object: { type: "commit", sha: data.commit.sha } }
        : body,
    ]),
  ]);
  return new GitHubClient({
    execute: async (args) => {
      assert.deepEqual(args.slice(0, 3), ["api", "--method", "GET"]);
      assert.ok(replies.has(args[3]), args[3]);
      return { stdout: JSON.stringify(replies.get(args[3])) };
    },
  });
}
const verify = (data, historicalRefs = false) =>
  verifyActionRelease({
    client: client(data, historicalRefs),
    manifestUrl: new URL("./fixtures/release-manifest.txt", import.meta.url),
  });

test("captured immutable API shapes verify without manufacturing a tree from production constants", async () => {
  // Only discovery refs are synthesized to the historical commit. The capture
  // records the newer live refs separately; it does not claim they still match.
  const result = await verify(snapshot, true);
  assert.equal(result.sha, snapshot.commit.sha);
  assert.equal(result.treeSha, snapshot.tree.sha);
  for (const [path, sha] of Object.entries(APPROVED_RUNTIME_BLOBS))
    assert.equal(
      snapshot.tree.tree.find((entry) => entry.path === path)?.sha,
      sha,
    );
});

test("captured moved discovery refs fail the historical verifier without entering normal source CI", async () => {
  assert.notEqual(snapshot.discovery.branch.object.sha, snapshot.commit.sha);
  await assert.rejects(verify(snapshot), /unapproved SHA/);
});

test("captured responses retain signature, tree and content integrity failures", async () => {
  for (const [mutate, message] of [
    [
      (data) => {
        data.commit.verification.verified = false;
      },
      /not GitHub-verified/,
    ],
    [
      (data) => {
        data.tree.truncated = true;
      },
      /truncated/,
    ],
    [
      (data) => {
        data.tree.tree[0].mode = "120000";
      },
      /tree differs/,
    ],
    [
      (data) => {
        data.contents["action.yml"].type = "symlink";
      },
      /not a complete base64/,
    ],
  ]) {
    const data = structuredClone(snapshot);
    mutate(data);
    await assert.rejects(verify(data, true), message);
  }
});
