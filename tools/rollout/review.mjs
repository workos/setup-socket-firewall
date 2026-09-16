import assert from "node:assert/strict";
import { fingerprint } from "./fingerprint.mjs";
import { ORGANIZATION } from "./constants.mjs";

const HASH = /^[0-9a-f]{64}$/;
const statuses = new Set(["needs-sfw", "needs-review"]);
const kinds = new Set(["known-review", "tracked-gap", "exception"]);
const mapping = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const sorted = (rows) =>
  [...rows].sort((a, b) => {
    const left = `${a.repository}/${a.path ?? ""}/${a.job ?? ""}/${a.id ?? ""}`;
    const right = `${b.repository}/${b.path ?? ""}/${b.job ?? ""}/${b.id ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });

export function newReviewState() {
  return {
    schemaVersion: 1,
    organization: ORGANIZATION,
    decisions: {},
    findings: [],
    unobserved: [],
  };
}

function validRepository(value) {
  return (
    Number.isSafeInteger(value.repositoryId) &&
    value.repositoryId > 0 &&
    typeof value.repository === "string" &&
    /^workos\/[\w.-]+$/.test(value.repository)
  );
}

export function validateState(state) {
  assert(
    mapping(state) &&
      state.schemaVersion === 1 &&
      state.organization === ORGANIZATION,
    "Unsupported review ledger",
  );
  assert(
    Object.keys(state).every((key) =>
      [
        "schemaVersion",
        "organization",
        "decisions",
        "findings",
        "unobserved",
      ].includes(key),
    ),
    "Unknown ledger fields",
  );
  assert(
    mapping(state.decisions) &&
      Array.isArray(state.findings) &&
      Array.isArray(state.unobserved),
    "Malformed review ledger",
  );
  assert(
    new Set(state.findings.map((item) => item.id)).size ===
      state.findings.length,
    "Duplicate review finding",
  );
  for (const item of state.findings) {
    assert(
      validRepository(item) &&
        HASH.test(item.id) &&
        HASH.test(item.fingerprint) &&
        statuses.has(item.status),
      "Malformed review finding",
    );
    assert(
      ["job", "workflow", "exclusion"].includes(item.kind) &&
        typeof item.path === "string" &&
        (item.job === null || typeof item.job === "string"),
      "Malformed finding scope",
    );
    assert(
      item.id ===
        fingerprint([item.repositoryId, item.kind, item.path, item.job]),
      "Finding identity does not match its scope",
    );
    assert(
      Array.isArray(item.reasons) &&
        item.reasons.every((reason) => typeof reason === "string"),
      "Malformed finding reasons",
    );
  }
  for (const [id, decision] of Object.entries(state.decisions)) {
    assert(
      HASH.test(id) &&
        validRepository(decision) &&
        HASH.test(decision.fingerprint) &&
        statuses.has(decision.status) &&
        kinds.has(decision.kind),
      "Malformed review decision",
    );
    assert(
      mapping(decision.scope) &&
        ["job", "workflow", "exclusion"].includes(decision.scope.kind) &&
        typeof decision.scope.path === "string" &&
        (decision.scope.job === null || typeof decision.scope.job === "string"),
      "Missing exact decision scope",
    );
    assert(
      id ===
        fingerprint([
          decision.repositoryId,
          decision.scope.kind,
          decision.scope.path,
          decision.scope.job,
        ]),
      "Decision identity does not match its scope",
    );
    assert(
      decision.kind === "exception" ||
        decision.status ===
          (decision.kind === "known-review" ? "needs-review" : "needs-sfw"),
      "Decision kind conflicts with classification",
    );
    assert(typeof decision.active === "boolean", "Missing decision validity");
    validateRationale(decision);
  }
  assert(
    state.unobserved.every(validRepository),
    "Malformed visibility history",
  );
  return state;
}

function validateRationale({ reason, evidence, recordedBy }) {
  assert(
    typeof reason === "string" &&
      reason.trim().length >= 10 &&
      reason.length <= 4000,
    "A specific reason is required",
  );
  assert(
    typeof recordedBy === "string" &&
      recordedBy.trim() &&
      recordedBy.length <= 200,
    "Recorded-by identity is required",
  );
  const url = new URL(evidence);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      evidence.length <= 2048,
    "Evidence must be a credential-free HTTPS URL",
  );
}

function collect(report) {
  assert(
    report.schemaVersion === 3 &&
      report.organization === ORGANIZATION &&
      report.scanStatus === "complete" &&
      report.scanErrors === 0,
    "Incomplete audit: ledger and last-good review must not advance",
  );
  assert(
    Array.isArray(report.repositories) &&
      report.repositories.length === report.inventory.activeCount,
    "Incomplete repository inventory",
  );
  assert(
    Object.values(report.inventory.differences).every(
      (values) => Array.isArray(values) && values.length === 0,
    ),
    "Inventory sources disagree",
  );
  const seen = new Map();
  const facts = new Map();
  const findings = [];
  const add = (repo, kind, path, job, status, source, reasons) => {
    assert(
      HASH.test(source),
      "Audit lacks review fingerprints; run the current detector",
    );
    const item = {
      id: fingerprint([repo.repositoryId, kind, path, job]),
      repositoryId: repo.repositoryId,
      repository: `${ORGANIZATION}/${repo.name}`,
      kind,
      path,
      job,
      status,
      fingerprint: source,
      reasons: [...new Set(reasons)].sort(),
    };
    assert(!facts.has(item.id), "Duplicate finding scope");
    facts.set(item.id, item);
    if (statuses.has(status)) findings.push(item);
  };
  for (const repo of report.repositories) {
    assert(
      validRepository({
        repositoryId: repo.repositoryId,
        repository: `${ORGANIZATION}/${repo.name}`,
      }) && !seen.has(repo.repositoryId),
      "Missing or duplicate immutable repository ID",
    );
    assert(repo.disposition !== "audit-error", "Partial repository scan");
    seen.set(repo.repositoryId, repo.name);
    for (const workflow of repo.workflows) {
      if (workflow.parseError !== undefined)
        add(
          repo,
          "workflow",
          workflow.path,
          null,
          "needs-review",
          workflow.reviewFingerprint,
          ["workflow-source-unparsed"],
        );
      for (const job of workflow.jobs) {
        const integration = job.integration;
        assert(
          integration && typeof integration.disposition === "string",
          "Missing job classification",
        );
        add(
          repo,
          "job",
          workflow.path,
          job.job,
          integration.disposition,
          job.reviewFingerprint,
          [
            ...(integration.downloads ?? [])
              .filter((item) => ["gap", "unresolved"].includes(item.status))
              .map((item) => item.reason),
            ...(integration.additionalJsPaths ?? [])
              .filter((item) => item.status === "unresolved")
              .map((item) => item.reason),
            ...job.operations
              .filter((item) => item.sourceError)
              .map((item) => item.sourceError),
            ...(job.operations.some((item) => item.kind === "reusable-call")
              ? ["reusable-workflow-context"]
              : []),
          ],
        );
      }
    }
    for (const exclusion of repo.exclusions ?? []) {
      add(
        repo,
        "exclusion",
        exclusion.id,
        null,
        exclusion.status === "stale"
          ? "needs-review"
          : "integrated-with-exclusions",
        exclusion.reviewFingerprint,
        ["approved-exclusion-drift"],
      );
    }
  }
  return { seen, facts, findings: sorted(findings) };
}

// Acknowledgements bind to source inputs, never a repository-wide waiver or a
// last-seen timestamp. Missing visibility is not evidence of resolution.
export function advanceReview(previous, report) {
  validateState(previous);
  const { seen, facts, findings } = collect(report);
  const state = structuredClone(previous);
  for (const [id, decision] of Object.entries(state.decisions)) {
    if (!seen.has(decision.repositoryId)) continue;
    const fact = facts.get(id);
    if (
      !fact ||
      fact.fingerprint !== decision.fingerprint ||
      (statuses.has(fact.status) && fact.status !== decision.status)
    )
      decision.active = false;
    decision.repository = `${ORGANIZATION}/${seen.get(decision.repositoryId)}`;
  }
  const prior = [
    ...previous.findings,
    ...Object.values(previous.decisions),
    ...previous.unobserved,
  ];
  state.unobserved = sorted([
    ...new Map(
      prior
        .filter((item) => !seen.has(item.repositoryId))
        .map((item) => [
          item.repositoryId,
          { repositoryId: item.repositoryId, repository: item.repository },
        ]),
    ).values(),
  ]);
  state.findings = findings;
  return validateState(state);
}

export function reviewView(state) {
  validateState(state);
  const pending = [];
  const known = [];
  for (const item of sorted(state.findings)) {
    const decision = state.decisions[item.id];
    if (
      decision?.active &&
      decision.fingerprint === item.fingerprint &&
      decision.status === item.status
    ) {
      known.push({
        ...item,
        decision: {
          kind: decision.kind,
          reason: decision.reason,
          evidence: decision.evidence,
          recordedBy: decision.recordedBy,
        },
      });
    } else pending.push(item);
  }
  return {
    schemaVersion: 1,
    snapshot: fingerprint(sorted(state.findings)),
    needsProtection: pending.filter((item) => item.status === "needs-sfw"),
    needsReview: pending.filter((item) => item.status === "needs-review"),
    known,
    unobserved: sorted(state.unobserved),
  };
}

export function recordDecision(
  previous,
  { expected, id, repository, kind, reason, evidence, recordedBy },
) {
  validateState(previous);
  assert(
    HASH.test(expected) && reviewView(previous).snapshot === expected,
    "Review snapshot changed; inspect it before recording a decision",
  );
  assert(
    Boolean(id) !== Boolean(repository) && kinds.has(kind),
    "Select one exact case or current repository findings and a valid decision kind",
  );
  validateRationale({ reason, evidence, recordedBy });
  const selected = previous.findings.filter((item) =>
    id ? item.id === id : item.repository === repository,
  );
  assert(selected.length > 0, "No current finding matches this selection");
  assert(
    selected.every(
      (item) =>
        kind === "exception" ||
        item.status ===
          (kind === "known-review" ? "needs-review" : "needs-sfw"),
    ),
    "Use known-review for uncertainty, tracked-gap for unfinished protection, or an explicitly justified exception",
  );
  const state = structuredClone(previous);
  for (const item of selected)
    state.decisions[item.id] = {
      repositoryId: item.repositoryId,
      repository: item.repository,
      fingerprint: item.fingerprint,
      scope: { kind: item.kind, path: item.path, job: item.job },
      status: item.status,
      kind,
      reason,
      evidence,
      recordedBy,
      active: true,
    };
  return validateState(state);
}
