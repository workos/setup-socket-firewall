import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  ACTION_REPOSITORY,
  APPROVED_RELEASE_SHA,
  EXPECTED_RELEASE_TREE,
  RELEASE_BRANCH,
  RELEASE_CHANNEL,
} from "./constants.mjs";
import { GhCommandError, GitHubClient } from "./github.mjs";
import {
  captureRepositoryInventory,
  reconcileRepositoryInventories,
} from "./inventory.mjs";
import { main } from "./cli.mjs";
import { parseReleaseManifest, verifyActionRelease } from "./release.mjs";

const TREE_SHA = "5cdbe39b0edafee9457767134320d95c61d91a60";

const ROOT_ACTION = `
name: Setup Socket Firewall
runs:
  using: composite
  steps:
    - shell: bash
      run: bash "$GITHUB_ACTION_PATH/scripts/configure.sh"
`;
const TEARDOWN_ACTION = `
name: Teardown Socket Firewall
runs:
  using: composite
  steps:
    - shell: bash
      run: bash "$GITHUB_ACTION_PATH/../scripts/teardown.sh"
`;

function releaseClient(overrides = {}) {
  return {
    async getCommit() {
      return (
        overrides.commit ?? {
          sha: APPROVED_RELEASE_SHA,
          tree: { sha: TREE_SHA },
          verification: { reason: "valid", verified: true },
        }
      );
    },
    async getRef(_repository, ref) {
      const defaultResponse = {
        object: { sha: APPROVED_RELEASE_SHA, type: "commit" },
      };
      return overrides.refs?.[ref] ?? defaultResponse;
    },
    async getText(_repository, path) {
      if (path === "action.yml") {
        return overrides.rootAction ?? ROOT_ACTION;
      }
      if (path === "teardown/action.yml") {
        return overrides.teardownAction ?? TEARDOWN_ACTION;
      }
      throw new Error(`unexpected path ${path}`);
    },
    async getTree() {
      return (
        overrides.tree ?? {
          sha: TREE_SHA,
          tree: EXPECTED_RELEASE_TREE,
          truncated: false,
        }
      );
    },
  };
}

function restRepository(name, options = {}) {
  return {
    archived: options.archived ?? false,
    default_branch: options.defaultBranch ?? "main",
    name,
    visibility: options.visibility ?? "private",
  };
}

function graphqlRepository(name, options = {}) {
  return {
    isArchived: options.archived ?? false,
    name,
    visibility: (options.visibility ?? "private").toUpperCase(),
  };
}

describe("source dependency lockfile", () => {
  test("contains no Socket Firewall resolution URL", async () => {
    const lockfile = await readFile(
      new URL("../../package-lock.json", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      lockfile,
      /https?:\/\/[^/]*(?:socket-firewall|socket\.dev)/i,
    );
  });
});

describe("release verification", () => {
  test("accepts the exact signed action-only release", async () => {
    const result = await verifyActionRelease({ client: releaseClient() });

    assert.deepEqual(result, {
      branch: RELEASE_BRANCH,
      channel: RELEASE_CHANNEL,
      commitVerified: true,
      manifest: [
        "LICENSE",
        "action.yml",
        "scripts/configure.sh",
        "scripts/teardown.sh",
        "teardown/action.yml",
      ],
      repository: ACTION_REPOSITORY,
      sha: APPROVED_RELEASE_SHA,
      treeSha: TREE_SHA,
    });
  });

  test("rejects mismatched discovery refs", async () => {
    const client = releaseClient({
      refs: {
        [`tags/${RELEASE_CHANNEL}`]: {
          object: { sha: "f".repeat(40), type: "commit" },
        },
      },
    });

    await assert.rejects(
      verifyActionRelease({ client }),
      /release discovery refs do not match/,
    );
  });

  test("rejects an unverified release commit", async () => {
    const client = releaseClient({
      commit: {
        sha: APPROVED_RELEASE_SHA,
        tree: { sha: TREE_SHA },
        verification: { reason: "unsigned", verified: false },
      },
    });

    await assert.rejects(
      verifyActionRelease({ client }),
      /release commit is not GitHub-verified/,
    );
  });

  test("rejects extra release-tree content", async () => {
    const client = releaseClient({
      tree: {
        sha: TREE_SHA,
        tree: [
          ...EXPECTED_RELEASE_TREE,
          { mode: "100644", path: "tools/audit.mjs", type: "blob" },
        ],
        truncated: false,
      },
    });

    await assert.rejects(
      verifyActionRelease({ client }),
      /release tree differs from the reviewed manifest/,
    );
  });

  test("rejects action metadata that executes another local path", async () => {
    const client = releaseClient({
      rootAction: `
name: Unsafe
runs:
  using: composite
  steps:
    - uses: ./tools
`,
    });

    await assert.rejects(verifyActionRelease({ client }), /must execute only/);
  });

  test("rejects unsafe manifest paths", () => {
    assert.throws(
      () => parseReleaseManifest("action.yml\n../secret\n"),
      /traverses outside/,
    );
    assert.throws(
      () => parseReleaseManifest("action.yml\naction.yml\n"),
      /duplicate path/,
    );
    assert.throws(
      () => parseReleaseManifest(" action.yml\n"),
      /has whitespace/,
    );
  });
});

describe("GitHub adapter", () => {
  test("paginates REST repository inventory without omission", async () => {
    const repositories = Array.from({ length: 301 }, (_, index) =>
      restRepository(`repo-${String(index).padStart(3, "0")}`),
    );
    const pages = [];
    const client = new GitHubClient({
      async execute(args) {
        const endpoint = args.at(-1);
        const page = Number(
          new URL(`https://api.github.test/${endpoint}`).searchParams.get(
            "page",
          ),
        );
        pages.push(page);
        const start = (page - 1) * 100;
        return {
          stderr: "",
          stdout: JSON.stringify(repositories.slice(start, start + 100)),
        };
      },
    });

    const result = await client.listRestRepositories("workos");

    assert.equal(result.length, 301);
    assert.deepEqual(pages, [1, 2, 3, 4]);
  });

  test("runs the independent GraphQL-backed repository command", async () => {
    let received;
    const response = [graphqlRepository("one")];
    const client = new GitHubClient({
      async execute(args) {
        received = args;
        return { stderr: "", stdout: JSON.stringify(response) };
      },
    });

    assert.deepEqual(await client.listGraphqlRepositories("workos"), response);
    assert.deepEqual(received, [
      "repo",
      "list",
      "workos",
      "--limit",
      "10000",
      "--json",
      "name,isArchived,visibility",
    ]);
  });

  test("honors retry-after for a bounded rate-limit retry", async () => {
    let attempts = 0;
    const delays = [];
    const client = new GitHubClient({
      async execute() {
        attempts += 1;
        if (attempts === 1) {
          throw new GhCommandError("rate limited", {
            retryAfterMs: 7_000,
            status: 429,
          });
        }
        return { stderr: "", stdout: "[]" };
      },
      async sleep(delay) {
        delays.push(delay);
      },
    });

    assert.deepEqual(await client.api("example"), []);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [7_000]);
  });

  test("fails fast for a non-rate-limit 403", async () => {
    let attempts = 0;
    const client = new GitHubClient({
      defaultRetryDelayMs: 1,
      async execute() {
        attempts += 1;
        throw new GhCommandError("forbidden", { status: 403 });
      },
      async sleep() {},
    });

    await assert.rejects(client.api("example"), /forbidden/);
    assert.equal(attempts, 1);
  });
});

describe("repository inventory", () => {
  test("reconciles exact REST and GraphQL active sets", () => {
    const rest = [
      restRepository("public-repo", { visibility: "public" }),
      restRepository("internal-repo", { visibility: "internal" }),
      restRepository("old-repo", { archived: true }),
    ];
    const graphql = [
      graphqlRepository("internal-repo", { visibility: "internal" }),
      graphqlRepository("old-repo", { archived: true }),
      graphqlRepository("public-repo", { visibility: "public" }),
    ];

    assert.deepEqual(reconcileRepositoryInventories(rest, graphql), {
      activeCount: 2,
      archivedCount: 1,
      differences: {
        activeOnlyGraphql: [],
        activeOnlyRest: [],
        allOnlyGraphql: [],
        allOnlyRest: [],
        visibilityMismatches: [],
      },
      repositories: [
        {
          defaultBranch: "main",
          name: "internal-repo",
          visibility: "internal",
        },
        {
          defaultBranch: "main",
          name: "public-repo",
          visibility: "public",
        },
      ],
      schemaVersion: 1,
      totalCount: 3,
      visibility: { internal: 1, private: 0, public: 1 },
    });
  });

  test("fails closed when repository visibility differs", () => {
    assert.throws(
      () =>
        reconcileRepositoryInventories(
          [restRepository("one", { visibility: "private" })],
          [graphqlRepository("one", { visibility: "public" })],
        ),
      /inventories differ/,
    );
  });

  test("rejects a malformed archived state", () => {
    assert.throws(
      () =>
        reconcileRepositoryInventories(
          [{ ...restRepository("one"), archived: "false" }],
          [graphqlRepository("one")],
        ),
      /invalid archived state/,
    );
  });

  test("fails closed when either inventory omits a repository", () => {
    assert.throws(
      () =>
        reconcileRepositoryInventories(
          [restRepository("one"), restRepository("two")],
          [graphqlRepository("one")],
        ),
      /inventories differ/,
    );
  });

  test("captures both sources before returning inventory", async () => {
    const calls = [];
    const client = {
      async listGraphqlRepositories() {
        calls.push("graphql");
        return [graphqlRepository("one")];
      },
      async listRestRepositories() {
        calls.push("rest");
        return [restRepository("one")];
      },
    };

    const result = await captureRepositoryInventory(client, "workos");

    assert.equal(result.activeCount, 1);
    assert.deepEqual(calls.sort(), ["graphql", "rest"]);
  });
});

describe("CLI", () => {
  test("rejects unknown commands and extra arguments", async () => {
    await assert.rejects(main([], {}), /usage:/);
    await assert.rejects(main(["inventory", "--org", "other"], {}), /usage:/);
  });

  test("prints deterministic inventory JSON", async () => {
    let output = "";
    const client = {
      async listGraphqlRepositories() {
        return [graphqlRepository("one")];
      },
      async listRestRepositories() {
        return [restRepository("one")];
      },
    };

    await main(["inventory"], {
      client,
      output: {
        write(value) {
          output += value;
        },
      },
    });

    assert.equal(JSON.parse(output).activeCount, 1);
  });
});
