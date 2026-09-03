import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import {
  ACTION_REPOSITORY,
  APPROVED_RELEASE_SHA,
  EXPECTED_RELEASE_TREE,
  RELEASE_BRANCH,
  RELEASE_CHANNEL,
} from "./constants.mjs";

const DEFAULT_MANIFEST_URL = new URL(
  "../../release-manifest.txt",
  import.meta.url,
);
const FORBIDDEN_RELEASE_PATHS = [
  ".github/",
  "package.json",
  "package-lock.json",
  "reports/",
  "tools/",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedTreeEntries(entries) {
  return entries
    .map(({ mode, path, type }) => ({ mode, path, type }))
    .sort((left, right) => compareStrings(left.path, right.path));
}

function assertExactTree(actual, expected) {
  const actualJson = JSON.stringify(sortedTreeEntries(actual));
  const expectedJson = JSON.stringify(sortedTreeEntries(expected));
  assert(
    actualJson === expectedJson,
    `release tree differs from the reviewed manifest: expected ${expectedJson}, received ${actualJson}`,
  );
}

function parseAction(text, path) {
  let action;
  try {
    action = parseYaml(text);
  } catch (error) {
    throw new Error(`${path} is not valid YAML: ${error.message}`);
  }
  assert(action && typeof action === "object", `${path} is not a YAML object`);
  assert(
    action.runs?.using === "composite",
    `${path} is not a composite action`,
  );
  assert(Array.isArray(action.runs.steps), `${path} has no composite steps`);
  return action;
}

function assertRuntimeReference(action, actionPath, expectedCommand) {
  const commands = action.runs.steps
    .map((step) => step.run)
    .filter((run) => typeof run === "string");
  assert(
    commands.length === 1 && commands[0] === expectedCommand,
    `${actionPath} must execute only ${expectedCommand}`,
  );

  const localUses = action.runs.steps
    .map((step) => step.uses)
    .filter((uses) => typeof uses === "string" && uses.startsWith("."));
  assert(
    localUses.length === 0,
    `${actionPath} contains an unexpected local action reference`,
  );
}

export function parseReleaseManifest(text) {
  const paths = [];
  const seen = new Set();

  for (const [index, rawLine] of text.split("\n").entries()) {
    if (rawLine === "" || rawLine.startsWith("#")) {
      continue;
    }
    const lineNumber = index + 1;
    assert(
      rawLine === rawLine.trim(),
      `manifest line ${lineNumber} has whitespace`,
    );
    assert(!rawLine.startsWith("/"), `manifest line ${lineNumber} is absolute`);
    assert(
      !rawLine.split("/").includes(".."),
      `manifest line ${lineNumber} traverses outside the release`,
    );
    assert(!seen.has(rawLine), `manifest contains duplicate path ${rawLine}`);
    seen.add(rawLine);
    paths.push(rawLine);
  }

  assert(paths.length > 0, "release manifest is empty");
  return paths.sort(compareStrings);
}

export async function verifyActionRelease(options) {
  const client = options.client;
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  const manifest = parseReleaseManifest(await readFile(manifestUrl, "utf8"));

  for (const forbidden of FORBIDDEN_RELEASE_PATHS) {
    assert(
      !manifest.some(
        (path) => path === forbidden || path.startsWith(forbidden),
      ),
      `release manifest includes forbidden source path ${forbidden}`,
    );
  }

  const expectedBlobPaths = EXPECTED_RELEASE_TREE.filter(
    ({ type }) => type === "blob",
  )
    .map(({ path }) => path)
    .sort(compareStrings);
  assert(
    JSON.stringify(manifest) === JSON.stringify(expectedBlobPaths),
    "local release manifest differs from the reviewed runtime allowlist",
  );

  const [branch, tag] = await Promise.all([
    client.getRef(ACTION_REPOSITORY, `heads/${RELEASE_BRANCH}`),
    client.getRef(ACTION_REPOSITORY, `tags/${RELEASE_CHANNEL}`),
  ]);
  const branchSha = branch.object?.sha;
  const tagSha = tag.object?.sha;
  assert(
    branch.object?.type === "commit" && tag.object?.type === "commit",
    "release discovery refs must point directly to commits",
  );
  assert(branchSha === tagSha, "release discovery refs do not match");
  assert(
    branchSha === APPROVED_RELEASE_SHA,
    `release discovery refs point to unapproved SHA ${branchSha ?? "missing"}`,
  );

  const commit = await client.getCommit(
    ACTION_REPOSITORY,
    APPROVED_RELEASE_SHA,
  );
  assert(
    commit.sha === APPROVED_RELEASE_SHA,
    "release commit SHA does not match",
  );
  assert(
    commit.verification?.verified === true &&
      commit.verification?.reason === "valid",
    "release commit is not GitHub-verified",
  );
  assert(
    typeof commit.tree?.sha === "string" &&
      /^[0-9a-f]{40}$/.test(commit.tree.sha),
    "release commit has an invalid tree SHA",
  );

  const [tree, rootActionText, teardownActionText] = await Promise.all([
    client.getTree(ACTION_REPOSITORY, commit.tree.sha, true),
    client.getText(ACTION_REPOSITORY, "action.yml", APPROVED_RELEASE_SHA),
    client.getText(
      ACTION_REPOSITORY,
      "teardown/action.yml",
      APPROVED_RELEASE_SHA,
    ),
  ]);
  assert(
    tree.sha === commit.tree.sha,
    "release commit and recursive tree SHAs do not match",
  );
  assert(tree.truncated === false, "release tree response is truncated");
  assert(Array.isArray(tree.tree), "release tree response has no entries");
  assertExactTree(tree.tree, EXPECTED_RELEASE_TREE);

  const rootAction = parseAction(rootActionText, "action.yml");
  const teardownAction = parseAction(teardownActionText, "teardown/action.yml");
  assertRuntimeReference(
    rootAction,
    "action.yml",
    'bash "$GITHUB_ACTION_PATH/scripts/configure.sh"',
  );
  assertRuntimeReference(
    teardownAction,
    "teardown/action.yml",
    'bash "$GITHUB_ACTION_PATH/../scripts/teardown.sh"',
  );

  return {
    branch: RELEASE_BRANCH,
    channel: RELEASE_CHANNEL,
    commitVerified: true,
    manifest,
    repository: ACTION_REPOSITORY,
    sha: APPROVED_RELEASE_SHA,
    treeSha: commit.tree?.sha,
  };
}
