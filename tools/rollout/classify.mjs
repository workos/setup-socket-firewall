import { parse } from "yaml";

import { ACTION_REPOSITORY, APPROVED_RELEASE_SHA } from "./constants.mjs";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UNSAFE_PUBLIC_TRIGGERS = new Set([
  "issue_comment",
  "pull_request_target",
  "repository_dispatch",
  "workflow_run",
]);
const CONTRIBUTOR_HEAD_PATTERN =
  /github\.event\.pull_request\.head|github\.head_ref|\bhead\.sha\b|\bhead\.ref\b/;

const NPM_DOWNLOAD = new Set([
  "add",
  "audit",
  "ci",
  "clean-install",
  "dedupe",
  "exec",
  "i",
  "install",
  "install-ci-test",
  "install-test",
  "update",
  "upgrade",
  "x",
]);
const NPM_NO_NETWORK = new Set([
  "build",
  "cache",
  "config",
  "get",
  "help",
  "link",
  "login",
  "logout",
  "ls",
  "outdated",
  "pack",
  "ping",
  "prune",
  "rebuild",
  "restart",
  "run",
  "run-script",
  "set",
  "start",
  "stop",
  "t",
  "test",
  "version",
  "view",
  "whoami",
]);
const PNPM_DOWNLOAD = new Set([
  "add",
  "dlx",
  "fetch",
  "i",
  "import",
  "install",
  "install-test",
  "up",
  "update",
]);
const PNPM_NO_NETWORK = new Set([
  "build",
  "config",
  "exec",
  "lint",
  "list",
  "ls",
  "pack",
  "prune",
  "rebuild",
  "run",
  "start",
  "t",
  "test",
  "version",
  "why",
]);
const BUN_DOWNLOAD = new Set(["add", "i", "install", "update", "x"]);
const BUN_NO_NETWORK = new Set(["build", "run", "test"]);
const YARN_DOWNLOAD = new Set(["add", "dlx", "i", "import", "install", "up"]);
const OTHER_ECOSYSTEM_COMMANDS = new Set([
  "apk",
  "apt",
  "apt-get",
  "brew",
  "bundle",
  "cargo",
  "composer",
  "conda",
  "docker",
  "dotnet",
  "gem",
  "go",
  "gradle",
  "helm",
  "mvn",
  "nuget",
  "pip",
  "pip3",
  "pipenv",
  "poetry",
  "terraform",
  "uv",
]);
const WRAPPER_COMMANDS = new Set(["just", "make", "mise", "rake", "task"]);
const NO_NETWORK_ORCHESTRATORS = new Set(["lerna", "nx", "rush", "turbo"]);

function normalizeExpression(value) {
  return String(value ?? "").replaceAll(/\s+/g, "");
}

function expectedTokenExpression(visibility) {
  const secret =
    visibility === "public"
      ? "PUBLIC_SOCKET_FIREWALL_TOKEN"
      : "SOCKET_FIREWALL_TOKEN";
  return `\${{secrets.${secret}}}`;
}

function splitCommands(script) {
  return String(script)
    .split(/\r?\n|&&|\|\||;|(?<!\|)\|(?!\|)/)
    .map((command) => command.trim())
    .filter((command) => command.length > 0 && !command.startsWith("#"));
}

function commandWords(command) {
  const words = command.split(/\s+/).filter((word) => word.length > 0);
  let start = 0;
  while (
    start < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]) ||
      ["sudo", "time", "env", "exec"].includes(words[start]))
  ) {
    start += 1;
  }
  return words.slice(start);
}

function firstSubcommand(words) {
  return words.slice(1).find((word) => !word.startsWith("-"));
}

export function classifyCommand(command) {
  const words = commandWords(command);
  const program = words[0];
  if (!program) {
    return { command, kind: "no-network" };
  }
  const name = program.replace(/^.*\//, "");

  if (name === "npx" || name === "bunx") {
    return {
      command,
      kind: "js-public-download",
      manager: name === "npx" ? "npm" : "bun",
    };
  }
  if (name === "corepack") {
    const subcommand = firstSubcommand(words);
    if (subcommand === "enable" || subcommand === "disable") {
      return { command, corepack: subcommand, kind: "no-network" };
    }
    return {
      command,
      corepack: subcommand ?? "implicit",
      kind: "js-public-download",
      manager: "npm",
    };
  }
  if (name === "npm" || name === "pnpm" || name === "bun" || name === "yarn") {
    const subcommand = firstSubcommand(words);
    if (name === "yarn") {
      if (
        subcommand === "publish" ||
        (subcommand === "npm" && words.includes("publish"))
      ) {
        return { command, kind: "js-publish", manager: "yarn" };
      }
      if (subcommand === undefined || YARN_DOWNLOAD.has(subcommand)) {
        return { command, kind: "yarn-blocked", manager: "yarn" };
      }
      return { command, kind: "no-network" };
    }
    if (subcommand === "publish") {
      return { command, kind: "js-publish", manager: name };
    }
    const downloads =
      name === "npm"
        ? NPM_DOWNLOAD
        : name === "pnpm"
          ? PNPM_DOWNLOAD
          : BUN_DOWNLOAD;
    const quiet =
      name === "npm"
        ? NPM_NO_NETWORK
        : name === "pnpm"
          ? PNPM_NO_NETWORK
          : BUN_NO_NETWORK;
    if (subcommand !== undefined && downloads.has(subcommand)) {
      if (name === "npm" && subcommand === "audit" && !words.includes("fix")) {
        return { command, kind: "no-network" };
      }
      return { command, kind: "js-public-download", manager: name };
    }
    if (
      subcommand === undefined ||
      quiet.has(subcommand) ||
      (name === "bun" && /[./]/.test(subcommand))
    ) {
      return { command, kind: "no-network" };
    }
    return { command, kind: "unknown", manager: name };
  }
  if (OTHER_ECOSYSTEM_COMMANDS.has(name)) {
    return { command, kind: "other-ecosystem" };
  }
  if (NO_NETWORK_ORCHESTRATORS.has(name)) {
    if (name === "lerna" && words.includes("bootstrap")) {
      return { command, kind: "js-public-download", manager: "npm" };
    }
    return { command, kind: "no-network" };
  }
  if (
    WRAPPER_COMMANDS.has(name) ||
    /\.sh$/.test(name) ||
    ((name === "bash" || name === "sh" || name === "zsh") &&
      words.slice(1).some((word) => /\.sh$/.test(word)))
  ) {
    return { command, kind: "unknown-wrapper" };
  }
  return { command, kind: "no-network" };
}

function parseUses(uses) {
  const value = String(uses);
  if (value.startsWith("./")) {
    return {
      kind: "local",
      path: value.replace(/^\.\//, "").replace(/\/+$/, ""),
    };
  }
  if (value.startsWith("docker://")) {
    return { image: value, kind: "docker" };
  }
  const atIndex = value.lastIndexOf("@");
  const ref = atIndex === -1 ? "" : value.slice(atIndex + 1);
  const target = atIndex === -1 ? value : value.slice(0, atIndex);
  const segments = target.split("/");
  return {
    kind: "remote",
    ref,
    repository: segments.slice(0, 2).join("/"),
    subpath: segments.slice(2).join("/"),
    target,
  };
}

function classifyUsesStep(step, context) {
  const uses = parseUses(step.uses);
  const withInput = step.with ?? {};

  if (uses.kind === "local") {
    const actionText =
      context.localActions?.get(`${uses.path}/action.yml`) ??
      context.localActions?.get(`${uses.path}/action.yaml`);
    if (actionText === undefined) {
      return [{ kind: "unknown-local-action", uses: step.uses }];
    }
    let action;
    try {
      action = parse(actionText);
    } catch {
      return [{ kind: "unknown-local-action", uses: step.uses }];
    }
    const steps = action?.runs?.steps;
    if (action?.runs?.using !== "composite" || !Array.isArray(steps)) {
      return [{ kind: "local-action", uses: step.uses }];
    }
    return steps.flatMap((inner) =>
      classifyStep(inner, context).map((operation) => ({
        ...operation,
        via: step.uses,
      })),
    );
  }
  if (uses.kind === "docker") {
    return [{ kind: "other-ecosystem", uses: step.uses }];
  }

  if (uses.repository === ACTION_REPOSITORY) {
    const kind = uses.subpath === "teardown" ? "sfw-teardown" : "sfw-setup";
    if (uses.subpath !== "" && uses.subpath !== "teardown") {
      return [{ kind: "unknown", uses: step.uses }];
    }
    return [
      {
        fallback: normalizeExpression(
          withInput["allow-external-fork-fallback"] ?? "false",
        ),
        kind,
        ref: uses.ref,
        token: normalizeExpression(withInput.token ?? ""),
        uses: step.uses,
      },
    ];
  }
  if (uses.repository === "actions/setup-node") {
    return [
      {
        kind: "setup-node",
        registryMutating: withInput["registry-url"] !== undefined,
        uses: step.uses,
      },
    ];
  }
  if (uses.repository === "actions/checkout") {
    return [
      {
        kind: "checkout",
        persistCredentials: normalizeExpression(
          withInput["persist-credentials"] ?? "true",
        ),
        ref: String(withInput.ref ?? ""),
        repository: String(withInput.repository ?? ""),
        uses: step.uses,
      },
    ];
  }
  if (uses.repository === "pnpm/action-setup") {
    const runInstall = withInput.run_install;
    if (runInstall !== undefined && String(runInstall) !== "false") {
      return [{ kind: "js-public-download", manager: "pnpm", uses: step.uses }];
    }
    return [{ kind: "toolchain", uses: step.uses }];
  }
  if (
    uses.repository === "changesets/action" ||
    uses.repository === "JS-DevTools/npm-publish"
  ) {
    return [{ kind: "js-publish", manager: "npm", uses: step.uses }];
  }
  return [{ kind: "remote-action", uses: step.uses }];
}

export function classifyStep(step, context) {
  if (step === null || typeof step !== "object") {
    return [{ kind: "unknown" }];
  }
  if (step.uses !== undefined) {
    return classifyUsesStep(step, context);
  }
  if (step.run !== undefined) {
    return splitCommands(step.run).map((command) => classifyCommand(command));
  }
  return [{ kind: "no-network" }];
}

function normalizeTriggers(workflow) {
  const triggers = workflow?.on ?? workflow?.[true];
  if (typeof triggers === "string") {
    return [triggers];
  }
  if (Array.isArray(triggers)) {
    return triggers.map(String).sort();
  }
  if (triggers && typeof triggers === "object") {
    return Object.keys(triggers).sort();
  }
  return [];
}

function collectViolations(operations, context, triggers, job) {
  const violations = [];
  const downloads = [];
  let lastRegistryMutation = -1;
  const setups = [];
  const teardowns = [];
  const publishes = [];
  const expectedToken = expectedTokenExpression(context.visibility);

  operations.forEach((operation, index) => {
    if (operation.kind === "js-public-download") {
      downloads.push(index);
    }
    if (
      operation.kind === "setup-node" &&
      operation.registryMutating === true
    ) {
      lastRegistryMutation = index;
    }
    if (operation.kind === "js-publish") {
      publishes.push(index);
    }
    if (operation.kind === "sfw-setup") {
      setups.push(index);
      if (operation.ref !== APPROVED_RELEASE_SHA) {
        violations.push(
          FULL_SHA_PATTERN.test(operation.ref)
            ? `sfw-setup pins unapproved SHA ${operation.ref}`
            : `sfw-setup uses mutable or short ref "${operation.ref}"`,
        );
      }
      if (operation.token !== expectedToken) {
        violations.push(
          `sfw-setup token must be ${expectedToken} for ${context.visibility} repositories`,
        );
      }
      if (context.visibility !== "public" && operation.fallback === "true") {
        violations.push(
          "allow-external-fork-fallback is enabled outside a public repository",
        );
      }
    }
    if (operation.kind === "sfw-teardown") {
      teardowns.push(index);
      if (operation.ref !== APPROVED_RELEASE_SHA) {
        violations.push(
          `sfw-teardown ref "${operation.ref}" does not match the approved release SHA`,
        );
      }
    }
  });

  const corepackEnable = operations.findIndex(
    (operation) => operation.corepack === "enable",
  );
  const firstPnpmDownload = operations.findIndex(
    (operation) =>
      operation.kind === "js-public-download" && operation.manager === "pnpm",
  );
  if (corepackEnable !== -1 && firstPnpmDownload > corepackEnable) {
    violations.push(
      "Corepack may lazily download pnpm directly from registry.npmjs.org; install the pinned pnpm package with npm through Socket Firewall before invoking pnpm",
    );
  }
  if (
    operations.some(
      (operation) =>
        operation.corepack !== undefined &&
        operation.corepack !== "enable" &&
        operation.corepack !== "disable",
    )
  ) {
    violations.push(
      "Corepack package-manager downloads do not use Socket Firewall npm configuration",
    );
  }

  const firstDownload = downloads[0];
  const validSetup = setups.find(
    (index) =>
      operations[index].ref === APPROVED_RELEASE_SHA &&
      operations[index].token === expectedToken,
  );
  if (firstDownload !== undefined && setups.length > 0) {
    if (validSetup === undefined) {
      violations.push("no valid Socket Firewall setup precedes downloads");
    } else if (validSetup > firstDownload) {
      violations.push("Socket Firewall setup runs after the first download");
    } else if (
      lastRegistryMutation > validSetup &&
      lastRegistryMutation < firstDownload
    ) {
      violations.push(
        "registry-mutating setup-node runs between Socket Firewall setup and the first download",
      );
    }
  }

  if (publishes.length > 0 && setups.length > 0) {
    const lastDownload = downloads.at(-1) ?? -1;
    const validTeardown = teardowns.find(
      (index) =>
        operations[index].ref === APPROVED_RELEASE_SHA &&
        index > lastDownload &&
        index < publishes[0],
    );
    if (validTeardown === undefined) {
      violations.push(
        "publish follows Socket Firewall setup without a same-SHA teardown boundary",
      );
    }
  }

  if (context.visibility === "public") {
    const unsafeTriggers = triggers.filter((trigger) =>
      UNSAFE_PUBLIC_TRIGGERS.has(trigger),
    );
    const installBearing =
      downloads.length > 0 || setups.length > 0 || publishes.length > 0;
    if (unsafeTriggers.length > 0 && installBearing) {
      violations.push(
        `install-bearing job is reachable from privileged trigger(s): ${unsafeTriggers.join(", ")}`,
      );
    }
    for (const operation of operations) {
      if (
        operation.kind === "checkout" &&
        installBearing &&
        (CONTRIBUTOR_HEAD_PATTERN.test(operation.ref) ||
          CONTRIBUTOR_HEAD_PATTERN.test(operation.repository)) &&
        unsafeTriggers.length > 0
      ) {
        violations.push(
          "privileged trigger checks out contributor-controlled head in an install-bearing job",
        );
      }
    }
  }

  if (job?.secrets === "inherit") {
    violations.push("reusable workflow call inherits all secrets");
  }

  return violations;
}

export function classifyJob(jobName, job, context, triggers) {
  if (job === null || typeof job !== "object") {
    return {
      job: jobName,
      managers: [],
      operations: [],
      status: "unknown",
      violations: ["job definition is not a mapping"],
    };
  }

  if (job.uses !== undefined) {
    const violations =
      job.secrets === "inherit"
        ? ["reusable workflow call inherits all secrets"]
        : [];
    return {
      job: jobName,
      managers: [],
      operations: [{ kind: "reusable-call", uses: String(job.uses) }],
      status: "reusable-call",
      violations,
    };
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const operations = steps.flatMap((step) => classifyStep(step, context));
  const violations = collectViolations(operations, context, triggers, job);

  const kinds = new Set(operations.map((operation) => operation.kind));
  const managers = [
    ...new Set(
      operations
        .filter((operation) => operation.kind === "js-public-download")
        .map((operation) => operation.manager)
        .filter(Boolean),
    ),
  ].sort();

  const hasDownload = kinds.has("js-public-download");
  const hasPublish = kinds.has("js-publish");
  const hasSetup = kinds.has("sfw-setup");
  const hasUnknown =
    kinds.has("unknown") ||
    kinds.has("unknown-wrapper") ||
    kinds.has("unknown-local-action");
  const publishUnsafe = violations.some((violation) =>
    violation.includes("without a same-SHA teardown"),
  );
  const trustUnsafe = violations.some(
    (violation) =>
      violation.includes("privileged trigger") ||
      violation.includes("inherits all secrets"),
  );

  let status;
  if (trustUnsafe) {
    status = "unsafe-trust";
  } else if (publishUnsafe) {
    status = "unsafe-publish";
  } else if (kinds.has("yarn-blocked")) {
    status = "blocked-yarn";
  } else if (hasDownload && hasSetup && violations.length === 0) {
    status = "protected";
  } else if (hasDownload) {
    status = "unprotected";
  } else if (hasUnknown) {
    status = "unknown";
  } else if (hasPublish) {
    status = hasSetup ? "unsafe-publish" : "safe-publish";
  } else if (kinds.has("other-ecosystem")) {
    status = "out-of-scope";
  } else {
    status = "no-in-scope-download";
  }

  return { job: jobName, managers, operations, status, violations };
}

export function classifyWorkflow(text, context) {
  let workflow;
  try {
    workflow = parse(text);
  } catch (error) {
    return {
      jobs: [],
      parseError: error.message,
      path: context.path,
      status: "unknown",
      triggers: [],
    };
  }
  if (workflow === null || typeof workflow !== "object") {
    return {
      jobs: [],
      parseError: "workflow is not a mapping",
      path: context.path,
      status: "unknown",
      triggers: [],
    };
  }

  const triggers = normalizeTriggers(workflow);
  const jobEntries = Object.entries(workflow.jobs ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const jobs = jobEntries.map(([jobName, job]) =>
    classifyJob(jobName, job, context, triggers),
  );

  return { jobs, path: context.path, triggers };
}

const STATUS_SEVERITY = [
  "unsafe-trust",
  "unsafe-publish",
  "blocked-yarn",
  "unprotected",
  "unknown",
  "reusable-call",
  "protected",
  "safe-publish",
  "out-of-scope",
  "no-in-scope-download",
];

export function repositoryDisposition(workflowResults, evidence = {}) {
  const statuses = new Set();
  for (const workflow of workflowResults) {
    if (workflow.parseError !== undefined) {
      statuses.add("unknown");
    }
    for (const job of workflow.jobs) {
      statuses.add(job.status);
    }
  }

  if (evidence.error !== undefined) {
    return "audit-error";
  }
  for (const status of STATUS_SEVERITY) {
    if (statuses.has(status)) {
      switch (status) {
        case "unsafe-trust":
          return "blocked-trust";
        case "unsafe-publish":
          return "unsafe-publish";
        case "blocked-yarn":
          return "blocked-yarn";
        case "unprotected":
          return "needs-sfw";
        case "unknown":
        case "reusable-call":
          return "needs-review";
        case "protected":
          return "protected";
        case "safe-publish":
        case "out-of-scope":
          return "out-of-scope";
        default:
          return "no-js-ci";
      }
    }
  }
  return workflowResults.length === 0 ? "no-ci" : "no-js-ci";
}
