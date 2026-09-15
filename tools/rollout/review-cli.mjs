#!/usr/bin/env node
import { readFile, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GitHubClient } from "./github.mjs";
import { runAudit, writeReportAtomically } from "./audit.mjs";
import { canonicalJson } from "./fingerprint.mjs";
import {
  advanceReview,
  newReviewState,
  recordDecision,
  reviewView,
  validateState,
} from "./review.mjs";

async function load(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("The ledger must be a regular file");
  return validateState(JSON.parse(await readFile(path, "utf8")));
}

// One writer across run/record/forget/init. A crashed writer leaves an explicit
// lock error, never an empty ledger or a lost acknowledgement. No TTL expiry.
export async function withLedgerLock(path, action) {
  const lock = `${path}.lock`;
  const handle = await open(lock, "wx", 0o600);
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await action();
  } finally {
    await handle.close();
    await rm(lock);
  }
}

export async function reviewMain(argv, options = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(
      [
        "state",
        "report",
        "case",
        "repository",
        "kind",
        "reason",
        "evidence",
        "by",
        "expected",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  const [command] = positionals;
  const allowed = {
    init: ["state"],
    run: ["state", "report"],
    show: ["state"],
    record: [
      "state",
      "case",
      "repository",
      "kind",
      "reason",
      "evidence",
      "by",
      "expected",
    ],
    forget: ["state", "case", "expected"],
  };
  if (
    positionals.length !== 1 ||
    !allowed[command] ||
    !values.state ||
    Object.keys(values).some((key) => !allowed[command].includes(key))
  )
    throw new Error(
      "usage: review <init|run|show|record|forget> --state <durable-private-ledger.json> [options]",
    );
  const statePath = resolve(values.state);
  const reportPath = resolve(values.report ?? "reports/review-audit.json");
  if (
    command === "run" &&
    [statePath, `${statePath}.lock`].includes(reportPath)
  )
    throw new Error("Audit report and ledger/lock paths must differ");
  if (command === "init")
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const output = options.output ?? process.stdout;
  if (command === "show") {
    const view = reviewView(await load(statePath));
    output.write(`${canonicalJson(view)}\n`);
    return view;
  }
  return withLedgerLock(statePath, async () => {
    let state;
    if (command === "init") {
      try {
        await lstat(statePath);
        throw new Error("Ledger already exists; init never replaces decisions");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      state = newReviewState();
    } else {
      state = await load(statePath); // Missing/corrupt state is an error, never []/auto-init.
      if (command === "run") {
        await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
        const target = join(
          await realpath(dirname(reportPath)),
          basename(reportPath),
        );
        const ledger = join(
          await realpath(dirname(statePath)),
          basename(statePath),
        );
        if ([ledger, `${ledger}.lock`].includes(target))
          throw new Error("Audit report and ledger/lock paths must differ");
        const report = await runAudit(options.client ?? new GitHubClient(), {
          progress: (done, total) => {
            if (done % 25 === 0 || done === total)
              (options.progress ?? process.stderr).write(
                `audited ${done}/${total} repositories\n`,
              );
          },
        });
        await writeReportAtomically(reportPath, report);
        state = advanceReview(state, report); // Partial results never replace last-good ledger.
      } else if (command === "record") {
        state = recordDecision(state, {
          id: values.case,
          repository: values.repository,
          kind: values.kind,
          reason: values.reason,
          evidence: values.evidence,
          recordedBy: values.by,
          expected: values.expected,
        });
      } else {
        if (
          reviewView(state).snapshot !== values.expected ||
          !Object.hasOwn(state.decisions, values.case ?? "")
        )
          throw new Error(
            "Current snapshot and an existing exact decision ID are required to forget",
          );
        delete state.decisions[values.case];
      }
    }
    await writeReportAtomically(statePath, JSON.parse(canonicalJson(state)));
    const view = reviewView(state);
    output.write(`${canonicalJson(view)}\n`);
    return view;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  reviewMain(process.argv.slice(2)).catch((error) => {
    // No source/API body in logs, and never a success-shaped empty finding list.
    console.error(
      JSON.stringify({
        status: "failed",
        error:
          error.code === "EEXIST"
            ? "Ledger locked; verify no writer is active before removing its .lock file."
            : error.code === "ERR_ASSERTION"
              ? error.message
              : "Review failed; check arguments, ledger, permissions, API availability, and private audit scanStatus. Existing ledger was not reset.",
      }),
    );
    process.exitCode = 1;
  });
}
