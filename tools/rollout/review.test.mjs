import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { runAudit } from "./audit.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";
import { GitHubClient, GhCommandError } from "./github.mjs";
import { canonicalJson, fingerprint } from "./fingerprint.mjs";
import {
  advanceReview,
  newReviewState,
  recordDecision,
  reviewView,
} from "./review.mjs";
import { reviewMain, withLedgerLock } from "./review-cli.mjs";

const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: { token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}" },
};
const job = {
  "runs-on": "ubuntu-latest",
  steps: [{ uses: "actions/checkout@v4" }, { run: "npm ci" }],
};
const workflow = (jobs = { install: job }) => stringify({ on: "push", jobs });
function client({
  files = { ".github/workflows/ci.yml": workflow() },
  head = "a".repeat(40),
  id = 42,
  name = "demo",
  partial = false,
  visible = true,
  reverse = false,
} = {}) {
  return {
    async listRestRepositories() {
      return visible
        ? [
            {
              id,
              name,
              default_branch: "main",
              visibility: "private",
              archived: false,
            },
          ]
        : [];
    },
    async listGraphqlRepositories() {
      return visible
        ? [{ name, visibility: "PRIVATE", isArchived: false }]
        : [];
    },
    async getRef() {
      return { object: { sha: head } };
    },
    async getTree() {
      const tree = Object.entries(files).map(([path, text]) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: fingerprint(text).slice(0, 40),
      }));
      return { truncated: partial, tree: reverse ? tree.reverse() : tree };
    },
    async getText(_repo, path, ref) {
      assert.equal(ref, head);
      assert.ok(Object.hasOwn(files, path));
      return files[path];
    },
  };
}
const scan = (options) => runAudit(client(options));
const reason = {
  reason: "Tracked fixture gap with a separate remediation PR.",
  evidence: "https://github.com/workos/example/pull/1",
  recordedBy: "test reviewer",
};
function acknowledge(state, extra = {}) {
  return recordDecision(state, {
    expected: reviewView(state).snapshot,
    id: state.findings[0].id,
    kind: "tracked-gap",
    ...reason,
    ...extra,
  });
}

test("bare transport EOF is retried within the existing bound, not mistaken for changed repository state", async () => {
  let calls = 0;
  const delays = [];
  const api = new GitHubClient({
    execute: async () => {
      calls++;
      if (calls === 1)
        throw new GhCommandError(
          'Get "https://api.github.com/repos/owner/example": EOF',
        );
      return { stdout: "{}" };
    },
    sleep: async (delay) => {
      delays.push(delay);
    },
  });
  assert.deepEqual(await api.api("repos/owner/example"), {});
  assert.equal(calls, 2);
  assert.deepEqual(delays, [5000]);
  calls = 0;
  delays.length = 0;
  api.execute = async () => {
    calls++;
    throw new GhCommandError("EOF");
  };
  await assert.rejects(api.api("repos/owner/example"), /failed/);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [5000, 10000, 20000]);
  calls = 0;
  api.execute = async () => {
    calls++;
    throw new GhCommandError("denied", { status: 403 });
  };
  await assert.rejects(api.api("repos/owner/example"), /denied/);
  assert.equal(calls, 1);
});

test("weekly findings and decisions are stable across order, timestamps, unrelated commits, YAML comments and other jobs", async () => {
  const first = advanceReview(newReviewState(), await scan());
  assert.equal(reviewView(first).needsProtection.length, 1);
  const known = acknowledge(first);
  const exception = acknowledge(first, { kind: "exception" });
  assert.equal(
    reviewView(advanceReview(exception, await scan())).known[0].decision.kind,
    "exception",
  );
  assert.equal(reviewView(exception).known[0].status, "needs-sfw");
  const second = await scan({
    head: "b".repeat(40),
    reverse: true,
    files: {
      "README.md": "unrelated documentation",
      ".github/workflows/ci.yml":
        "# a YAML comment\n" +
        workflow({
          unrelated: { steps: [{ run: "echo okay" }] },
          install: job,
        }),
    },
  });
  second.generatedAt = "another week";
  const repeated = advanceReview(known, second);
  assert.equal(canonicalJson(repeated), canonicalJson(known));
  assert.equal(
    canonicalJson(reviewView(repeated)),
    canonicalJson(reviewView(known)),
  );
  assert.equal(reviewView(repeated).known[0].status, "needs-sfw"); // Not falsely relabelled integrated.
});

test("new jobs, new repos and changed existing installs cannot inherit an acknowledgement", async () => {
  const known = acknowledge(advanceReview(newReviewState(), await scan()));
  const added = advanceReview(
    known,
    await scan({
      files: {
        ".github/workflows/ci.yml": workflow({ install: job, another: job }),
      },
    }),
  );
  assert.equal(reviewView(added).known.length, 1);
  assert.equal(reviewView(added).needsProtection.length, 1);
  const changed = advanceReview(
    known,
    await scan({
      files: {
        ".github/workflows/ci.yml": workflow({
          install: {
            ...job,
            steps: [...job.steps, { run: "npm install another" }],
          },
        }),
      },
    }),
  );
  assert.equal(reviewView(changed).needsProtection.length, 1);
  assert.equal(Object.values(changed.decisions)[0].active, false);
  assert.equal(
    reviewView(advanceReview(changed, await scan())).needsProtection.length,
    1,
    "reverting inputs does not silently reactivate a stale decision",
  );
  const recreated = advanceReview(known, await scan({ id: 43 }));
  assert.equal(reviewView(recreated).needsProtection.length, 1);
  assert.equal(recreated.unobserved[0].repositoryId, 42);
  const renamed = advanceReview(known, await scan({ name: "renamed" }));
  assert.equal(reviewView(renamed).needsProtection.length, 0);
  assert.equal(reviewView(renamed).known[0].repository, "workos/renamed");
});

test("resolution followed by regression reopens; absent visibility does not resolve, expire or discard decisions", async () => {
  const known = acknowledge(advanceReview(newReviewState(), await scan()));
  const protectedReport = await scan({
    files: {
      ".github/workflows/ci.yml": workflow({
        install: { ...job, steps: [setup, ...job.steps] },
      }),
    },
  });
  const resolved = advanceReview(known, protectedReport);
  assert.equal(resolved.findings.length, 0);
  assert.equal(
    reviewView(advanceReview(resolved, await scan())).needsProtection.length,
    1,
  );
  const missing = advanceReview(known, await scan({ visible: false }));
  assert.equal(missing.unobserved.length, 1);
  assert.equal(Object.values(missing.decisions)[0].active, true);
  assert.deepEqual(
    advanceReview(missing, await scan({ visible: false })),
    missing,
  );
  assert.deepEqual(advanceReview(missing, await scan()), known);
});

test("only referenced helpers, configuration and upstream producers invalidate their reviewed consumers", async () => {
  const files = {
    ".github/workflows/ci.yml": workflow({
      producer: { steps: [{ run: "echo value=one" }] },
      install: {
        ...job,
        needs: "producer",
        steps: [job.steps[0], { uses: "./.github/actions/install" }],
      },
    }),
    ".github/actions/install/action.yml": stringify({
      runs: { using: "composite", steps: [{ shell: "bash", run: "npm ci" }] },
    }),
    ".github/actions/unused/action.yml": "unused",
    ".npmrc": "registry=https://registry.npmjs.org/",
  };
  const known = acknowledge(
    advanceReview(newReviewState(), await scan({ files })),
  );
  assert.deepEqual(
    advanceReview(
      known,
      await scan({
        files: { ...files, ".github/actions/unused/action.yml": "changed" },
        reverse: true,
      }),
    ),
    known,
  );
  for (const [path, value] of [
    [
      ".github/actions/install/action.yml",
      files[".github/actions/install/action.yml"].replace(
        "npm ci",
        "npm install",
      ),
    ],
    [".npmrc", "registry=https://other.invalid/"],
    [
      ".github/workflows/ci.yml",
      files[".github/workflows/ci.yml"].replace("value=one", "value=two"),
    ],
  ])
    assert.equal(
      Object.values(
        advanceReview(known, await scan({ files: { ...files, [path]: value } }))
          .decisions,
      )[0].active,
      false,
      path,
    );
});

test("review uncertainty is separately acknowledged, not a blanket exception for a later proven gap", async () => {
  const files = {
    ".github/workflows/ci.yml": workflow({
      install: { ...job, steps: [{ uses: "./missing" }] },
    }),
  };
  const initial = advanceReview(newReviewState(), await scan({ files }));
  assert.equal(reviewView(initial).needsReview.length, 1);
  assert.throws(() => acknowledge(initial), /known-review/);
  const known = acknowledge(initial, { kind: "known-review" });
  assert.equal(
    reviewView(advanceReview(known, await scan())).needsProtection.length,
    1,
  );
  assert.throws(
    () =>
      acknowledge(initial, { kind: "known-review", expected: "0".repeat(64) }),
    /snapshot changed/,
  );
  assert.throws(
    () => acknowledge(initial, { kind: "known-review", reason: "" }),
    /reason/,
  );
  assert.throws(
    () =>
      acknowledge(initial, {
        kind: "known-review",
        evidence: "https://user:secret@example.com",
      }),
    /credential-free/,
  );
  assert.throws(
    () => acknowledge(initial, { kind: "known-review", id: "*" }),
    /No current finding/,
  );
});

test("partial reports, inventory disagreements, missing IDs and legacy reports cannot reset good state", async () => {
  const state = acknowledge(advanceReview(newReviewState(), await scan()));
  const bytes = canonicalJson(state);
  assert.throws(
    () =>
      advanceReview(state, {
        schemaVersion: 3,
        organization: "workos",
        scanStatus: "partial",
        scanErrors: 1,
      }),
    /Incomplete audit/,
  );
  for (const change of [
    (r) => {
      delete r.repositories[0].repositoryId;
    },
    (r) => {
      delete r.repositories[0].workflows[0].jobs[0].reviewFingerprint;
    },
    (r) => {
      r.inventory.differences.activeOnlyRest = ["demo"];
    },
    (r) => {
      r.repositories.push(r.repositories[0]);
      r.inventory.activeCount++;
    },
  ]) {
    const report = await scan();
    change(report);
    assert.throws(() => advanceReview(state, report));
  }
  assert.equal(canonicalJson(state), bytes);
});

test("upstream helper/reusable changes and stale archive inputs reopen their recorded scopes", async () => {
  const files = {
    ".github/workflows/ci.yml": workflow({
      producer: { uses: "./.github/workflows/producer.yml" },
      install: { ...job, needs: "producer" },
    }),
    ".github/workflows/producer.yml": stringify({
      on: "workflow_call",
      jobs: {
        value: {
          steps: [
            {
              uses: "actions/checkout@v4",
              with: { repository: "workos/demo" },
            },
            { uses: "./.github/actions/producer" },
          ],
        },
      },
    }),
    ".github/actions/producer/action.yml": stringify({
      runs: {
        using: "composite",
        steps: [{ shell: "bash", run: "echo value=one" }],
      },
    }),
  };
  const first = advanceReview(newReviewState(), await scan({ files }));
  const gap = first.findings.find((item) => item.status === "needs-sfw");
  const known = acknowledge(first, { id: gap.id });
  const changed = advanceReview(
    known,
    await scan({
      files: {
        ...files,
        ".github/actions/producer/action.yml": files[
          ".github/actions/producer/action.yml"
        ].replace("value=one", "value=two"),
      },
    }),
  );
  assert.equal(changed.decisions[gap.id].active, false);

  const archiveFiles = {
    ".github/workflows/ci.yml": workflow(),
    "package.json": "{}",
    ".npmrc": "registry=https://registry.npmjs.org/",
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/example": {
          version: "1.0.0",
          resolved: "https://example.invalid/archive.tgz",
        },
      },
    }),
  };
  const stale = advanceReview(
    newReviewState(),
    await scan({ files: archiveFiles, name: "openapi-spec" }),
  );
  const archive = stale.findings.find((item) => item.kind === "exclusion");
  const recorded = acknowledge(stale, { id: archive.id, kind: "known-review" });
  assert.deepEqual(
    advanceReview(
      recorded,
      await scan({
        files: archiveFiles,
        name: "openapi-spec",
        head: "b".repeat(40),
      }),
    ),
    recorded,
  );
  const drift = advanceReview(
    recorded,
    await scan({
      name: "openapi-spec",
      files: {
        ...archiveFiles,
        "package-lock.json": archiveFiles["package-lock.json"].replace(
          "1.0.0",
          "2.0.0",
        ),
      },
    }),
  );
  assert.equal(drift.decisions[archive.id].active, false);
});

test("CLI persistence survives restart; missing/corrupt state, races and partial scans fail without replacing decisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sfw-weekly-"));
  const path = join(dir, "state.json");
  const report = join(dir, "audit.json");
  const options = {
    client: client(),
    output: { write() {} },
    progress: { write() {} },
  };
  const run = (command, args = [], extra = {}) =>
    reviewMain([command, "--state", path, ...args], { ...options, ...extra });
  try {
    await assert.rejects(run("run", ["--report", report]), /ENOENT/);
    await run("init");
    const first = await run("run", ["--report", report]);
    await run("record", [
      "--expected",
      first.snapshot,
      "--case",
      first.needsProtection[0].id,
      "--kind",
      "tracked-gap",
      "--reason",
      reason.reason,
      "--evidence",
      reason.evidence,
      "--by",
      reason.recordedBy,
    ]);
    const bytes = await readFile(path, "utf8");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(report)).mode & 0o777, 0o600);
    assert.equal((await run("show")).known.length, 1);
    await run("run", ["--report", report], {
      client: client({ head: "b".repeat(40) }),
    });
    assert.equal(await readFile(path, "utf8"), bytes);
    await assert.rejects(run("init"), /already exists/);
    await assert.rejects(run("run", ["--report", path]), /must differ/);
    const alias = join(dir, "alias");
    await symlink(dir, alias);
    await assert.rejects(
      run("run", ["--report", join(alias, "state.json")]),
      /must differ/,
    );
    await assert.rejects(
      run("run", ["--report", report], { client: client({ partial: true }) }),
      /Incomplete audit/,
    );
    assert.equal(await readFile(path, "utf8"), bytes);
    await withLedgerLock(path, async () => {
      await assert.rejects(run("run", ["--report", report]), {
        code: "EEXIST",
      });
    });
    assert.equal(await readFile(path, "utf8"), bytes);
    await writeFile(path, "{bad json");
    await assert.rejects(run("run", ["--report", report]));
    assert.equal(await readFile(path, "utf8"), "{bad json");
    await rm(path);
    await symlink(report, path);
    await assert.rejects(run("show"), /regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
