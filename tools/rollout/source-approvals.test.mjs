import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stringify } from "yaml";
import { GitHubClient } from "./github.mjs";
import { readRegistryExclusions, REGISTRY_EXCLUSIONS } from "./exclusions.mjs";

const approval = "61c52b1b-8081-48fa-9c8d-e2462e931ef7";

test("large file reads use the metadata's immutable blob and reject incomplete or substituted content", async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1, "a");
  const sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const metadata = {
    type: "file",
    encoding: "none",
    content: "",
    size: bytes.length,
    sha,
  };
  const blob = {
    sha,
    size: bytes.length,
    encoding: "base64",
    content: bytes.toString("base64"),
  };
  const calls = [];
  let response = blob;
  const api = new GitHubClient();
  api.api = async (endpoint) => {
    calls.push(endpoint);
    return endpoint.includes("/contents/") ? metadata : response;
  };
  assert.equal(
    await api.getText("workos/example", "large.lock", "a".repeat(40)),
    bytes.toString(),
  );
  assert.equal(calls[1], `repos/workos/example/git/blobs/${sha}`);
  for (const change of [
    { sha: "b".repeat(40) },
    { size: bytes.length - 1 },
    { content: blob.content.slice(4) },
    { content: Buffer.alloc(bytes.length, "b").toString("base64") },
    { encoding: "none" },
  ]) {
    response = { ...blob, ...change };
    await assert.rejects(
      api.getText("workos/example", "large.lock", "a".repeat(40)),
    );
  }
  metadata.size = 11 * 1024 * 1024;
  calls.length = 0;
  await assert.rejects(
    api.getText("workos/example", "large.lock", "a".repeat(40)),
  );
  assert.equal(
    calls.length,
    1,
    "unsupported size is rejected before fetching the blob",
  );
});

test("WorkOS approval binds the exact Rush Git override, pnpm source and integrity, not unrelated registry versions", async () => {
  const rule = REGISTRY_EXCLUSIONS.find((item) => item.repository === "workos");
  assert.ok(rule, "the requesting employee approved the WorkOS Kotlin source");
  assert.equal(rule.approvalRequestId, approval);
  assert.deepEqual(
    rule.workflows,
    [],
    "source approval never waives a CI installation",
  );
  // Independently transcribed approved source, not generated from the rule.
  const specifier =
    "github:fwcd/tree-sitter-kotlin#f66d2908542e93c0204c6c241f794afe4e9cd5d1";
  const tarball =
    "https://codeload.github.com/fwcd/tree-sitter-kotlin/tar.gz/f66d2908542e93c0204c6c241f794afe4e9cd5d1";
  const integrity =
    "sha512-7pk1Tg/gXh+6hM4E0F2rPKeLyA/bNlYyqVu6T1Md/AV/vloakbvEZG0R4CYwUfVtgFAMZRbOtA8JBzX1SFatBA==";
  assert.equal(rule.specifier, specifier);
  assert.equal(rule.resolved, tarball);
  assert.equal(rule.integrity, integrity);
  assert.equal(rule.version, "0.4.0");
  const config = {
    $schema: "https://example.invalid/schema.json",
    note: "/* quoted, not a comment */",
    globalOverrides: { "tree-sitter-kotlin": specifier, ordinary: "^1.0.0" },
  };
  const entry = {
    version: "0.4.0",
    resolution: { gitHosted: true, tarball, integrity },
  };
  const lock = {
    lockfileVersion: "9.0",
    overrides: { ...config.globalOverrides },
    packages: {
      [rule.packagePath]: entry,
      "ordinary@1.0.0": { resolution: { integrity: "sha512-fixture" } },
      "vendored@file:../../third_party/npm/example.tgz": {
        resolution: {
          integrity: "sha512-local",
          tarball: "file:../../third_party/npm/example.tgz",
        },
      },
    },
  };
  const read = async (c = config, l = lock) => {
    const files = {
      [rule.manifest]: `/** Rush configuration */\n// preserve URLs inside strings\n${JSON.stringify(c)}`,
      [rule.lockfile]: stringify(l),
    };
    const [result] = await readRegistryExclusions("workos", async (path) => {
      assert.ok(Object.hasOwn(files, path), path);
      return files[path];
    });
    return result.status;
  };
  assert.equal(await read(), "matched");
  assert.equal(
    await read(
      {
        ...config,
        globalOverrides: { ...config.globalOverrides, ordinary: "^2.0.0" },
      },
      { ...lock, overrides: { ...lock.overrides, ordinary: "^2.0.0" } },
    ),
    "matched",
  );
  assert.equal(
    await read({
      ...config,
      globalOverrides: { "tree-sitter-kotlin": "github:other/repo#unapproved" },
    }),
    "stale",
  );
  assert.equal(await read(config, { ...lock, overrides: {} }), "stale");
  assert.equal(
    await read(config, { ...lock, lockfileVersion: "10.0" }),
    "stale",
  );
  for (const change of [
    { version: "0.5.0" },
    { resolution: { ...entry.resolution, integrity: "sha512-other" } },
    {
      resolution: {
        ...entry.resolution,
        tarball: "https://example.invalid/other.tgz",
      },
    },
    { resolution: { ...entry.resolution, repo: "https://example.invalid" } },
  ])
    assert.equal(
      await read(config, {
        ...lock,
        packages: {
          ...lock.packages,
          [rule.packagePath]: { ...entry, ...change },
        },
      }),
      "stale",
    );
  for (const resolution of [
    {
      tarball: "https://example.invalid/unapproved.tgz",
      integrity: "sha512-other",
    },
    {
      type: "git",
      repo: "https://example.invalid/repo",
      commit: "b".repeat(40),
    },
    { tarball: "file://remote.example/archive.tgz", integrity: "sha512-other" },
  ])
    assert.equal(
      await read(config, {
        ...lock,
        packages: { ...lock.packages, extra: { resolution } },
      }),
      "stale",
    );
  await assert.rejects(
    readRegistryExclusions("workos", async () => {
      throw new Error("unavailable");
    }),
    /unavailable/,
  );
  await assert.rejects(
    readRegistryExclusions("workos", async () => "malformed"),
  );
});
