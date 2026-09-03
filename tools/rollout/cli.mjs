#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { GitHubClient } from "./github.mjs";
import { captureRepositoryInventory } from "./inventory.mjs";
import { ORGANIZATION } from "./constants.mjs";
import { runAudit, writeReportAtomically } from "./audit.mjs";
import { verifyActionRelease } from "./release.mjs";

const COMMANDS = new Set(["audit", "inventory", "verify-action"]);
const REPORT_URL = new URL("../../reports/live-audit.json", import.meta.url);

export async function main(argv, options = {}) {
  if (argv.length !== 1 || !COMMANDS.has(argv[0])) {
    throw new Error("usage: cli.mjs <audit|inventory|verify-action>");
  }

  const client = options.client ?? new GitHubClient();
  const output = options.output ?? process.stdout;
  const command = argv[0];

  if (command === "audit") {
    const reportPath = options.reportPath ?? REPORT_URL.pathname;
    const report = await runAudit(client, {
      progress: (done, total) => {
        if (done % 25 === 0 || done === total) {
          process.stderr.write(`audited ${done}/${total} repositories\n`);
        }
      },
    });
    await writeReportAtomically(reportPath, report);
    const summary = {
      dispositions: report.dispositions,
      inventory: report.inventory,
      reportPath,
    };
    output.write(`${JSON.stringify(summary, null, 2)}\n`);
    return report;
  }

  const result =
    command === "verify-action"
      ? await verifyActionRelease({ client })
      : await captureRepositoryInventory(client, ORGANIZATION);
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`rollout verifier failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
