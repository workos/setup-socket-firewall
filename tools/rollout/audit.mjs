import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { classifyWorkflow, repositoryDisposition } from "./classify.mjs";
import { captureRepositoryInventory } from "./inventory.mjs";
import { ORGANIZATION } from "./constants.mjs";

const WORKFLOW_PATH_PATTERN = /^\.(?:github|depot)\/workflows\/[^/]+\.ya?ml$/;
const LOCKFILE_PATTERN =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
const LOCAL_ACTION_PATTERN = /uses:\s*['"]?\.\/([^\s'"#]+)/g;
const AUDIT_CONCURRENCY = 5;
const MAX_WORKFLOWS_PER_REPOSITORY = 200;
const ADVISORY_WORKSPACE_PATTERN = /-ghsa(?:-[a-z0-9]{4}){3}$/;

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
      `heads/${repository.defaultBranch}`,
    );
    headSha = ref?.object?.sha;
    if (typeof headSha !== "string" || headSha.length !== 40) {
      throw new Error(`unexpected head ref shape for ${fullName}`);
    }
    tree = await client.getTree(
      fullName,
      encodeURIComponent(repository.defaultBranch),
      true,
    );
  } catch (error) {
    if (
      error.message?.includes("HTTP 404") &&
      ADVISORY_WORKSPACE_PATTERN.test(repository.name)
    ) {
      return {
        defaultBranch: repository.defaultBranch,
        disposition: "advisory-workspace",
        lockfiles: [],
        name: repository.name,
        visibility: repository.visibility,
        workflows: [],
      };
    }
    if (await isEmptyRepository(client, fullName)) {
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

  if (tree.truncated !== false) {
    return {
      defaultBranch: repository.defaultBranch,
      disposition: "audit-error",
      error: "default-branch tree listing is truncated",
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
    const workflowTexts = await mapWithConcurrency(
      workflowPaths,
      AUDIT_CONCURRENCY,
      (path) => client.getText(fullName, path, headSha),
    );

    const localActionPaths = new Set();
    for (const text of workflowTexts) {
      for (const match of text.matchAll(LOCAL_ACTION_PATTERN)) {
        const base = match[1].replace(/\/+$/, "");
        for (const candidate of [`${base}/action.yml`, `${base}/action.yaml`]) {
          if (blobPaths.has(candidate)) {
            localActionPaths.add(candidate);
          }
        }
      }
    }
    const localActions = new Map();
    await mapWithConcurrency(
      [...localActionPaths].sort(),
      AUDIT_CONCURRENCY,
      async (path) => {
        localActions.set(path, await client.getText(fullName, path, headSha));
      },
    );

    const workflows = workflowPaths.map((path, index) =>
      classifyWorkflow(workflowTexts[index], {
        localActions,
        path,
        visibility: repository.visibility,
      }),
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
      disposition: repositoryDisposition(workflows),
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

  const rows = sortedByName(repositories);
  const dispositions = {};
  for (const row of rows) {
    dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
  }

  return {
    dispositions: Object.fromEntries(
      Object.entries(dispositions).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    generatedAt: new Date().toISOString(),
    inventory: {
      activeCount: inventory.activeCount,
      archivedCount: inventory.archivedCount,
      differences: inventory.differences,
      totalCount: inventory.totalCount,
      visibility: inventory.visibility,
    },
    organization: ORGANIZATION,
    repositories: rows,
    schemaVersion: 1,
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
