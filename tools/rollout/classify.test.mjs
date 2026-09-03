import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditRepository, runAudit, writeReportAtomically } from "./audit.mjs";
import {
  classifyCommand,
  classifyWorkflow,
  repositoryDisposition,
} from "./classify.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";

const SETUP = `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`;
const TEARDOWN = `workos/setup-socket-firewall/teardown@${APPROVED_RELEASE_SHA}`;
const PRIVATE_TOKEN = "${{ secrets.SOCKET_FIREWALL_TOKEN }}";
const PUBLIC_TOKEN = "${{ secrets.PUBLIC_SOCKET_FIREWALL_TOKEN }}";

function workflow(jobsYaml, triggers = "push") {
  return `on: ${triggers}\njobs:\n${jobsYaml}`;
}

function classify(text, visibility = "private", localActions = new Map()) {
  return classifyWorkflow(text, {
    localActions,
    path: ".github/workflows/ci.yml",
    visibility,
  });
}

test("command grammar", () => {
  const cases = [
    ["npm ci --ignore-scripts", "js-public-download"],
    ["npm install --no-audit", "js-public-download"],
    ["npm audit", "no-network"],
    ["npm audit fix", "js-public-download"],
    ["npm publish --access public", "js-publish"],
    ["npm run build", "no-network"],
    ["npm test", "no-network"],
    ["npx changeset publish", "js-public-download"],
    ["pnpm install --frozen-lockfile", "js-public-download"],
    ["pnpm dlx create-thing", "js-public-download"],
    ["pnpm exec vitest run", "no-network"],
    ["pnpm publish --no-git-checks", "js-publish"],
    ["bun install --frozen-lockfile", "js-public-download"],
    ["bunx biome check", "js-public-download"],
    ["bun run test", "no-network"],
    ["bun publish", "js-publish"],
    ["yarn install --frozen-lockfile", "yarn-blocked"],
    ["yarn", "yarn-blocked"],
    ["yarn npm publish", "js-publish"],
    ["yarn build", "no-network"],
    ["corepack enable", "no-network"],
    ["corepack prepare pnpm@10 --activate", "js-public-download"],
    ["pip install -r requirements.txt", "other-ecosystem"],
    ["go build ./...", "other-ecosystem"],
    ["docker build .", "other-ecosystem"],
    ["make bootstrap", "unknown-wrapper"],
    ["./scripts/setup.sh", "unknown-wrapper"],
    ["bash scripts/install.sh", "unknown-wrapper"],
    ["turbo run lint", "no-network"],
    ["lerna bootstrap", "js-public-download"],
    ["CI=1 npm ci", "js-public-download"],
    ["echo done", "no-network"],
  ];
  for (const [command, kind] of cases) {
    assert.equal(classifyCommand(command).kind, kind, command);
  }
});

test("classifier: unprotected npm install needs SFW", () => {
  const result = classify(
    workflow(
      `  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@sha\n      - uses: actions/setup-node@sha\n        with: { registry-url: "https://registry.npmjs.org/" }\n      - run: npm ci\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unprotected");
  assert.deepEqual(result.jobs[0].managers, ["npm"]);
  assert.equal(repositoryDisposition([result]), "needs-sfw");
});

test("classifier: correctly ordered pinned setup is protected", () => {
  const result = classify(
    workflow(
      `  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@sha\n      - uses: actions/setup-node@sha\n        with: { registry-url: "https://registry.npmjs.org/" }\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
  );
  assert.deepEqual(result.jobs[0].violations, []);
  assert.equal(result.jobs[0].status, "protected");
  assert.equal(repositoryDisposition([result]), "protected");
});

test("classifier: registry mutation between setup and download is a violation", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - uses: actions/setup-node@sha\n        with: { registry-url: "https://registry.npmjs.org/" }\n      - run: npm ci\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unprotected");
  assert.match(result.jobs[0].violations.join(" "), /registry-mutating/);
});

test("classifier: setup after the first download is a violation", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - run: npm ci\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unprotected");
  assert.match(result.jobs[0].violations.join(" "), /after the first download/);
});

test("classifier: mutable or mismatched refs are violations", () => {
  const mutable = classify(
    workflow(
      `  build:\n    steps:\n      - uses: workos/setup-socket-firewall@v1\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
  );
  assert.match(mutable.jobs[0].violations.join(" "), /mutable or short ref/);

  const stale = classify(
    workflow(
      `  build:\n    steps:\n      - uses: workos/setup-socket-firewall@${"a".repeat(40)}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
  );
  assert.match(stale.jobs[0].violations.join(" "), /unapproved SHA/);
});

test("classifier: token must match repository visibility", () => {
  const publicWrongSecret = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm ci\n`,
    ),
    "public",
  );
  assert.match(
    publicWrongSecret.jobs[0].violations.join(" "),
    /PUBLIC_SOCKET_FIREWALL_TOKEN.*public/,
  );

  const publicRight = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PUBLIC_TOKEN}" }\n      - run: npm ci\n`,
    ),
    "public",
  );
  assert.equal(publicRight.jobs[0].status, "protected");

  const internalWrongSecret = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PUBLIC_TOKEN}" }\n      - run: npm ci\n`,
    ),
    "internal",
  );
  assert.match(
    internalWrongSecret.jobs[0].violations.join(" "),
    /SOCKET_FIREWALL_TOKEN.*internal/,
  );
});

test("classifier: publish boundaries", () => {
  const cleanPublish = classify(
    workflow(`  publish:\n    steps:\n      - run: npm publish\n`),
  );
  assert.equal(cleanPublish.jobs[0].status, "safe-publish");

  const restored = classify(
    workflow(
      `  release:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: pnpm install --frozen-lockfile\n      - uses: ${TEARDOWN}\n      - run: pnpm publish --no-git-checks\n`,
    ),
  );
  assert.equal(restored.jobs[0].status, "protected");

  const unsafe = classify(
    workflow(
      `  release:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm publish --no-git-checks\n`,
    ),
  );
  assert.equal(unsafe.jobs[0].status, "unsafe-publish");
  assert.equal(repositoryDisposition([unsafe]), "unsafe-publish");

  const teardownBeforeFinalDownload = classify(
    workflow(
      `  release:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - uses: ${TEARDOWN}\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm publish --no-git-checks\n`,
    ),
  );
  assert.equal(teardownBeforeFinalDownload.jobs[0].status, "unsafe-publish");
});

test("classifier: yarn installs block", () => {
  const result = classify(
    workflow(`  build:\n    steps:\n      - run: yarn install\n`),
  );
  assert.equal(result.jobs[0].status, "blocked-yarn");
  assert.equal(repositoryDisposition([result]), "blocked-yarn");
});

test("classifier: public privileged trigger with installs is unsafe", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - uses: actions/checkout@sha\n        with: { ref: "\${{ github.event.pull_request.head.sha }}" }\n      - run: npm ci\n`,
      "pull_request_target",
    ),
    "public",
  );
  assert.equal(result.jobs[0].status, "unsafe-trust");
  assert.equal(repositoryDisposition([result]), "blocked-trust");
});

test("classifier: reusable call with inherited secrets is flagged", () => {
  const result = classify(
    `on: push\njobs:\n  call:\n    uses: workos/shared/.github/workflows/ci.yml@main\n    secrets: inherit\n`,
  );
  assert.equal(result.jobs[0].status, "reusable-call");
  assert.match(result.jobs[0].violations.join(" "), /inherits all secrets/);
  assert.equal(repositoryDisposition([result]), "needs-review");
});

test("classifier: pnpm action-setup run_install downloads", () => {
  const result = classify(
    workflow(
      `  build:\n    steps:\n      - uses: pnpm/action-setup@sha\n        with: { run_install: true }\n`,
    ),
  );
  assert.equal(result.jobs[0].status, "unprotected");
});

test("classifier: Corepack pnpm bootstrap bypasses SFW npm configuration", () => {
  const lazyCorepack = classify(
    workflow(
      `  build:\n    steps:\n      - run: corepack enable\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: pnpm install --frozen-lockfile\n`,
    ),
  );
  assert.equal(lazyCorepack.jobs[0].status, "unprotected");
  assert.match(lazyCorepack.jobs[0].violations.join(" "), /Corepack.*lazily/);

  const corepackDownload = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: corepack prepare pnpm@11.20.0 --activate\n`,
    ),
  );
  assert.equal(corepackDownload.jobs[0].status, "unprotected");
  assert.match(
    corepackDownload.jobs[0].violations.join(" "),
    /Corepack package-manager downloads/,
  );

  const npmBootstrap = classify(
    workflow(
      `  build:\n    steps:\n      - uses: ${SETUP}\n        with: { token: "${PRIVATE_TOKEN}" }\n      - run: npm install --global pnpm@11.20.0 --ignore-scripts\n      - run: pnpm install --frozen-lockfile\n`,
    ),
  );
  assert.equal(npmBootstrap.jobs[0].status, "protected");
  assert.deepEqual(npmBootstrap.jobs[0].violations, []);
});

test("classifier: local composite actions resolve or block", () => {
  const localActions = new Map([
    [
      ".github/actions/install/action.yml",
      `runs:\n  using: composite\n  steps:\n    - run: npm ci\n      shell: bash\n`,
    ],
  ]);
  const resolved = classify(
    workflow(`  build:\n    steps:\n      - uses: ./.github/actions/install\n`),
    "private",
    localActions,
  );
  assert.equal(resolved.jobs[0].status, "unprotected");
  assert.equal(resolved.jobs[0].operations[0].via, "./.github/actions/install");

  const missing = classify(
    workflow(`  build:\n    steps:\n      - uses: ./.github/actions/mystery\n`),
  );
  assert.equal(missing.jobs[0].status, "unknown");
  assert.equal(repositoryDisposition([missing]), "needs-review");
});

test("classifier: parse errors and scope buckets fail closed", () => {
  const broken = classify("on: [push\njobs: {");
  assert.notEqual(broken.parseError, undefined);
  assert.equal(repositoryDisposition([broken]), "needs-review");

  const python = classify(
    workflow(
      `  build:\n    steps:\n      - run: pip install -r requirements.txt\n`,
    ),
  );
  assert.equal(repositoryDisposition([python]), "out-of-scope");

  assert.equal(repositoryDisposition([]), "no-ci");
  assert.equal(repositoryDisposition([], { error: "boom" }), "audit-error");
});

function stubClient(overrides = {}) {
  const restRepositories = [
    {
      archived: false,
      default_branch: "main",
      name: "app",
      visibility: "internal",
    },
    {
      archived: false,
      default_branch: "main",
      name: "empty-repo",
      visibility: "private",
    },
  ];
  return {
    api: async (endpoint) => {
      if (endpoint === "repos/workos/empty-repo") {
        return { size: 0 };
      }
      throw new Error(`unexpected api call: ${endpoint}`);
    },
    getRef: async (repository) => {
      if (repository === "workos/empty-repo") {
        const error = new Error("Not Found");
        error.status = 404;
        throw error;
      }
      return { object: { sha: "c".repeat(40) } };
    },
    getText: async (repository, path) => {
      assert.equal(path, ".github/workflows/ci.yml");
      return workflow(`  build:\n    steps:\n      - run: npm ci\n`);
    },
    getTree: async () => ({
      tree: [
        { path: ".github/workflows/ci.yml", type: "blob" },
        { path: "package-lock.json", type: "blob" },
      ],
      truncated: false,
    }),
    listGraphqlRepositories: async () =>
      restRepositories.map((repository) => ({
        isArchived: repository.archived,
        name: repository.name,
        visibility: repository.visibility,
      })),
    listRestRepositories: async () => restRepositories,
    ...overrides,
  };
}

test("audit: classifies live repositories and writes an atomic report", async () => {
  const report = await runAudit(stubClient());
  assert.equal(report.inventory.activeCount, 2);
  assert.deepEqual(report.dispositions, { empty: 1, "needs-sfw": 1 });
  const app = report.repositories.find((row) => row.name === "app");
  assert.equal(app.disposition, "needs-sfw");
  assert.deepEqual(app.managers, ["npm"]);
  assert.deepEqual(app.lockfiles, ["package-lock.json"]);

  const directory = await mkdtemp(join(tmpdir(), "sfw-audit-"));
  const reportPath = join(directory, "report.json");
  await writeReportAtomically(reportPath, report);
  const written = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(written.dispositions, report.dispositions);
  assert.deepEqual(await readdir(directory), ["report.json"]);
});

test("audit: access failures become audit-error rows, never no-download", async () => {
  const client = stubClient({
    getTree: async () => {
      const error = new Error("Forbidden");
      error.status = 403;
      throw error;
    },
  });
  const row = await auditRepository(client, {
    defaultBranch: "main",
    name: "app",
    visibility: "internal",
  });
  assert.equal(row.disposition, "audit-error");
  assert.match(row.error, /Forbidden/);
});

test("audit: truncated trees fail closed", async () => {
  const client = stubClient({
    getTree: async () => ({ tree: [], truncated: true }),
  });
  const row = await auditRepository(client, {
    defaultBranch: "main",
    name: "app",
    visibility: "internal",
  });
  assert.equal(row.disposition, "audit-error");
  assert.match(row.error, /truncated/);
});

test("adapter: transient network failures retry bounded", async () => {
  const { GitHubClient } = await import("./github.mjs");
  let attempts = 0;
  const client = new GitHubClient({
    execute: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("dial tcp 140.82.113.6:443: i/o timeout");
      }
      return { stdout: "{}" };
    },
    sleep: async () => {},
  });
  await client.api("repos/workos/example", "read example");
  assert.equal(attempts, 3);
});

test("adapter: non-transient failures do not retry", async () => {
  const { GitHubClient } = await import("./github.mjs");
  let attempts = 0;
  const client = new GitHubClient({
    execute: async () => {
      attempts += 1;
      const error = new Error("gh: Not Found (HTTP 404)");
      error.status = 404;
      throw error;
    },
    sleep: async () => {},
  });
  await assert.rejects(() => client.api("repos/workos/gone", "read gone"));
  assert.equal(attempts, 1);
});
