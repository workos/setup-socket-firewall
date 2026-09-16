#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";

import { GitHubClient } from "./github.mjs";
import { captureRepositoryInventory } from "./inventory.mjs";
import { ORGANIZATION } from "./constants.mjs";
import { runAudit, writeReportAtomically } from "./audit.mjs";
import { verifyActionRelease } from "./release.mjs";

const COMMANDS = new Set(["audit", "inventory", "verify-action"]);
const REPORT_URL = new URL("../../reports/live-audit.json", import.meta.url);
const INVENTORY_URL = new URL("../../reports/inventory.json", import.meta.url);

function inventoryCounts(inventory) {
  const { activeCount, archivedCount, totalCount, visibility } = inventory;
  return { activeCount, archivedCount, totalCount, visibility };
}

export function scanExitCode(result) {
  return result.scanErrors > 0 ? 1 : 0;
}

export async function main(argv, options = {}) {
  if (argv.length !== 1 || !COMMANDS.has(argv[0])) {
    throw new Error("usage: cli.mjs <audit|inventory|verify-action>");
  }

  const client = options.client ?? new GitHubClient();
  const output = options.output ?? process.stdout;
  const command = argv[0];

  if (command === "audit") {
    const reportPath = options.reportPath ?? fileURLToPath(REPORT_URL);
    const report = await runAudit(client, {
      progress: (done, total) => {
        if (done % 25 === 0 || done === total) {
          process.stderr.write(`audited ${done}/${total} repositories\n`);
        }
      },
    });
    await writeReportAtomically(reportPath, report);
    const summary = {
      schemaVersion: report.schemaVersion,
      dispositions: report.dispositions,
      assuranceDispositions: report.assuranceDispositions,
      runtimeVerification: report.runtimeVerification,
      inventory: inventoryCounts(report.inventory),
      scanErrors: report.scanErrors,
      scanStatus: report.scanStatus,
      coverage: report.coverage,
      reportPath,
    };
    output.write(`${JSON.stringify(summary, null, 2)}\n`);
    return report;
  }

  const result =
    command === "verify-action"
      ? await verifyActionRelease({ client })
      : await captureRepositoryInventory(client, ORGANIZATION);
  if (command === "inventory") {
    const reportPath = options.reportPath ?? fileURLToPath(INVENTORY_URL);
    await writeReportAtomically(reportPath, result);
    output.write(
      `${JSON.stringify({ ...inventoryCounts(result), scanStatus: "complete", coverage: "token-visible repositories only", reportPath }, null, 2)}\n`,
    );
  } else {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .then((result) => {
      process.exitCode = scanExitCode(result);
    })
    .catch(() => {
      // API errors can contain private repository names or workflow source.
      process.stderr.write(
        `${JSON.stringify({ scanStatus: "failed", scanErrors: 1, error: "verifier failed; check command, access, API availability, and snapshot prerequisites privately" })}\n`,
      );
      process.exitCode = 1;
    });
}
