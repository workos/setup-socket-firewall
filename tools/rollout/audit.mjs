import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { classifyWorkflow, repositoryDisposition } from "./classify.mjs";
import { captureRepositoryInventory } from "./inventory.mjs";
import { ORGANIZATION } from "./constants.mjs";
import {
  integrationDisposition,
  resolveLocalWorkflowCalls,
  resolveNoInstallWorkflowCalls,
} from "./integration.mjs";

const WORKFLOW_PATH_PATTERN = /^\.(?:github|depot)\/workflows\/[^/]+\.ya?ml$/;
const LOCKFILE_PATTERN =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
const LOCAL_ACTION_PATTERN = /uses:\s*['"]?\.\/([^\s'"#]*)/g;
const AUDIT_CONCURRENCY = 5;
const MAX_WORKFLOWS_PER_REPOSITORY = 200;
const MAX_LOCAL_ACTIONS_PER_REPOSITORY = 200;

function sortedByName(rows) {
  return [...rows].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function isEmptyRepository(client, repository) {
  try {
    const metadata = await client.api(
      `repos/${repository}`,
      `read ${repository} metadata`,
    );
    return metadata.size === 0;
  } catch {
    return false;
  }
}

export async function auditRepository(client, repository) {
  const fullName = `${ORGANIZATION}/${repository.name}`;

  let headSha;
  let tree;
  try {
    const ref = await client.getRef(
      fullName,
      `heads/${encodeURIComponent(repository.defaultBranch)}`,
    );
    headSha = ref?.object?.sha;
    if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) {
      throw new Error(`unexpected head ref shape for ${fullName}`);
    }
    tree = await client.getTree(fullName, headSha, true);
  } catch (error) {
    const status = error.status ?? error.cause?.status;
    if (
      headSha === undefined &&
      (status === 404 ||
        status === 409 ||
        /HTTP (404|409)/.test(error.message)) &&
      (await isEmptyRepository(client, fullName))
    ) {
      return {
        defaultBranch: repository.defaultBranch,
        disposition: "empty",
        jobs: { total: 0 },
        lockfiles: [],
        name: repository.name,
        visibility: repository.visibility,
        workflows: [],
      };
    }
    return {
      defaultBranch: repository.defaultBranch,
      disposition: "audit-error",
      error: error.message,
      lockfiles: [],
      name: repository.name,
      visibility: repository.visibility,
      workflows: [],
    };
  }

  if (
    tree?.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.some(
      (entry) =>
        !entry ||
        typeof entry.path !== "string" ||
        !entry.path ||
        !["blob", "tree", "commit"].includes(entry.type) ||
        (entry.type === "blob" &&
          !["100644", "100755", "120000"].includes(entry.mode)) ||
        (entry.type === "tree" && entry.mode !== "040000") ||
        (entry.type === "commit" && entry.mode !== "160000"),
    ) ||
    new Set(tree.tree.map((entry) => entry.path)).size !== tree.tree.length
  ) {
    return {
      defaultBranch: repository.defaultBranch,
      disposition: "audit-error",
      error:
        "default-branch tree listing is malformed, truncated, or contains unsupported file modes",
      headSha,
      lockfiles: [],
      name: repository.name,
      visibility: repository.visibility,
      workflows: [],
    };
  }

  const blobPaths = new Set(
    (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path),
  );
  const workflowPaths = [...blobPaths]
    .filter((path) => WORKFLOW_PATH_PATTERN.test(path))
    .sort();
  const lockfiles = [...blobPaths]
    .filter((path) => LOCKFILE_PATTERN.test(path))
    .sort()
    .slice(0, 50);

  if (workflowPaths.length > MAX_WORKFLOWS_PER_REPOSITORY) {
    return {
      defaultBranch: repository.defaultBranch,
      disposition: "audit-error",
      error: `repository has ${workflowPaths.length} workflow files; refusing unbounded scan`,
      headSha,
      lockfiles,
      name: repository.name,
      visibility: repository.visibility,
      workflows: [],
    };
  }

  try {
    const readSource = async (path) => {
      if (tree.tree.find((entry) => entry.path === path)?.mode === "120000") {
        throw new Error("workflow or local action source is a symlink");
      }
      return client.getText(fullName, path, headSha);
    };
    const workflowTexts = await mapWithConcurrency(
      workflowPaths,
      AUDIT_CONCURRENCY,
      (path) => readSource(path),
    );

    if (
      workflowTexts.some((text) => typeof text !== "string" || !text.trim())
    ) {
      throw new Error("workflow source read is empty or malformed");
    }
    // Fetch only referenced local actions, including nested composites. The set
    // bounds cycles in fetching; the classifier separately bounds expansion.
    const localActions = new Map();
    const pendingTexts = [...workflowTexts];
    const localActionPaths = new Set();
    while (pendingTexts.length > 0) {
      const paths = [];
      for (const text of pendingTexts.splice(0)) {
        for (const match of text.matchAll(LOCAL_ACTION_PATTERN)) {
          const base = match[1].replace(/\/+$/, "");
          const prefix = base ? `${base}/` : "";
          for (const candidate of [
            `${prefix}action.yml`,
            `${prefix}action.yaml`,
          ]) {
            if (blobPaths.has(candidate) && !localActionPaths.has(candidate)) {
              localActionPaths.add(candidate);
              paths.push(candidate);
            }
          }
        }
      }
      if (localActionPaths.size > MAX_LOCAL_ACTIONS_PER_REPOSITORY) {
        throw new Error(
          "too many referenced local actions; refusing unbounded scan",
        );
      }
      await mapWithConcurrency(
        paths.sort(),
        AUDIT_CONCURRENCY,
        async (path) => {
          const text = await readSource(path);
          if (typeof text !== "string" || !text.trim())
            throw new Error("local action source read is empty or malformed");
          localActions.set(path, text);
          pendingTexts.push(text);
        },
      );
    }

    const workflows = resolveLocalWorkflowCalls(
      workflowPaths.map((path, index) =>
        classifyWorkflow(workflowTexts[index], {
          localActions,
          path,
          visibility: repository.visibility,
        }),
      ),
    );

    const managers = [
      ...new Set(
        workflows.flatMap((workflow) =>
          workflow.jobs.flatMap((job) => job.managers),
        ),
      ),
    ].sort();
    const statusCounts = {};
    for (const workflow of workflows) {
      for (const job of workflow.jobs) {
        statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
      }
    }

    return {
      defaultBranch: repository.defaultBranch,
      disposition: integrationDisposition(workflows),
      assuranceDisposition: repositoryDisposition(workflows),
      headSha,
      jobs: {
        byStatus: Object.fromEntries(
          Object.entries(statusCounts).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
        total: Object.values(statusCounts).reduce(
          (total, count) => total + count,
          0,
        ),
      },
      lockfiles,
      managers,
      name: repository.name,
      visibility: repository.visibility,
      workflows,
    };
  } catch (error) {
    return {
      defaultBranch: repository.defaultBranch,
      disposition: "audit-error",
      error: error.message,
      headSha,
      lockfiles,
      name: repository.name,
      visibility: repository.visibility,
      workflows: [],
    };
  }
}

export async function runAudit(client, options = {}) {
  const progress = options.progress ?? (() => {});
  const inventory = await captureRepositoryInventory(client, ORGANIZATION);

  let completed = 0;
  const repositories = await mapWithConcurrency(
    inventory.repositories,
    AUDIT_CONCURRENCY,
    async (repository) => {
      const row = await auditRepository(client, repository);
      completed += 1;
      progress(completed, inventory.repositories.length, repository.name);
      return row;
    },
  );

  const rows = sortedByName(
    resolveNoInstallWorkflowCalls(repositories, ORGANIZATION),
  );
  const dispositions = {};
  const assuranceDispositions = {};
  for (const row of rows) {
    dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
    const assurance = row.assuranceDisposition ?? row.disposition;
    assuranceDispositions[assurance] =
      (assuranceDispositions[assurance] ?? 0) + 1;
  }

  return {
    dispositions: Object.fromEntries(
      Object.entries(dispositions).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    assuranceDispositions: Object.fromEntries(
      Object.entries(assuranceDispositions).sort(([a], [b]) =>
        a < b ? -1 : 1,
      ),
    ),
    runtimeVerification: "not-performed",
    generatedAt: new Date().toISOString(),
    inventory: {
      activeCount: inventory.activeCount,
      archivedCount: inventory.archivedCount,
      differences: inventory.differences,
      totalCount: inventory.totalCount,
      visibility: inventory.visibility,
    },
    organization: ORGANIZATION,
    scanErrors: dispositions["audit-error"] ?? 0,
    scanStatus: dispositions["audit-error"] ? "partial" : "complete",
    coverage:
      "token-visible repositories only; organization-wide access is an operator prerequisite",
    repositories: rows,
    schemaVersion: 2,
  };
}

export async function writeReportAtomically(reportPath, report) {
  const directory = dirname(reportPath);
  const temporaryDirectory = await mkdtemp(join(directory, ".audit-"));
  const temporaryPath = join(temporaryDirectory, "report.json");
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, reportPath);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
