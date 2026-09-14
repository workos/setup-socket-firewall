import { parseYamlSource as parse } from "./yaml.mjs";

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
// Only literal informational commands are considered transparent. Scripts,
// lifecycle commands and executors can hide dependency installation.
const NPM_NO_NETWORK = new Set(["get", "help", "ls", "whoami"]);
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
const PNPM_NO_NETWORK = new Set(["list", "ls", "why"]);
const BUN_DOWNLOAD = new Set(["add", "i", "install", "update", "x"]);
const BUN_NO_NETWORK = new Set();
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
const ORCHESTRATORS = new Set(["lerna", "nx", "rush", "turbo"]);
const SIMPLE_COMMANDS = new Set(["echo", "printf", "pwd", "true", "false"]);
const TRANSPARENT_INSTALL_FLAGS = new Set([
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--frozen-lockfile",
  "--immutable",
  "--offline",
  "--prefer-offline",
  "--no-progress",
  "--no-save",
  "--save-exact",
  "--save-dev",
  "--global",
  "-g",
  "-D",
  "-y",
]);

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function condition(value) {
  if (value === undefined) return "always";
  const expression = normalizeExpression(value).replace(
    /^\$\{\{(.*)\}\}$/,
    "$1",
  );
  if (expression === "false") return "never";
  if (expression === "true") return "always";
  return "uncertain";
}

function boundaryUncertain(step) {
  return (
    condition(step.if) === "uncertain" ||
    (step["continue-on-error"] !== undefined &&
      condition(step["continue-on-error"]) !== "never") ||
    step.env !== undefined
  );
}

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
  if (program.includes("/")) return { command, kind: "unknown-wrapper" };
  const name = program;

  // Do not mistake an option's value (e.g. --prefix help) for the verb.
  // Unsupported leading options remain review candidates, not a parsed shell.
  if (
    ["npm", "pnpm", "bun", "yarn", "corepack"].includes(name) &&
    words[1]?.startsWith("-")
  ) {
    return { command, kind: "unknown-wrapper", manager: name };
  }

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
      // Targeted controls may affect Yarn without changing pnpm's shim.
      if (words.length !== 2) return { command, kind: "unknown-wrapper" };
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
      return { command, kind: "unknown-wrapper", manager: "yarn" };
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
    if (quiet.has(subcommand)) {
      return { command, kind: "no-network" };
    }
    return { command, kind: "unknown-wrapper", manager: name };
  }
  if (OTHER_ECOSYSTEM_COMMANDS.has(name)) {
    // Language/package executors can wrap JS installers just like shell scripts.
    const executesProgram = words
      .slice(1)
      .some((word) => ["run", "exec", "generate", "shell"].includes(word));
    return {
      command,
      kind: executesProgram ? "unknown-wrapper" : "other-ecosystem",
    };
  }
  if (ORCHESTRATORS.has(name)) {
    if (name === "lerna" && words.includes("bootstrap")) {
      return { command, kind: "js-public-download", manager: "npm" };
    }
    return { command, kind: "unknown-wrapper" };
  }
  if (
    WRAPPER_COMMANDS.has(name) ||
    /\.sh$/.test(name) ||
    ((name === "bash" || name === "sh" || name === "zsh") &&
      words.slice(1).some((word) => /\.sh$/.test(word)))
  ) {
    return { command, kind: "unknown-wrapper" };
  }
  return {
    command,
    kind: SIMPLE_COMMANDS.has(name) ? "no-network" : "unknown-wrapper",
  };
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
    const stack = context.actionStack ?? [];
    if (stack.includes(uses.path) || stack.length >= 20) {
      return [
        {
          kind: "unknown-local-action",
          uses: step.uses,
          reason: "cyclic or deeply nested local action",
        },
      ];
    }
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
    if (
      action?.runs?.using !== "composite" ||
      !Array.isArray(steps) ||
      steps.length === 0
    ) {
      return [{ kind: "unknown-local-action", uses: step.uses }];
    }
    return steps.flatMap((inner) =>
      classifyStep(inner, {
        ...context,
        actionStack: [...stack, uses.path],
      }).map((operation) => ({
        ...operation,
        via: step.uses,
      })),
    );
  }
  if (uses.kind === "docker") {
    return [{ kind: "unknown", uses: step.uses }];
  }

  if (uses.repository === ACTION_REPOSITORY) {
    const kind = uses.subpath === "teardown" ? "sfw-teardown" : "sfw-setup";
    if (uses.subpath !== "" && uses.subpath !== "teardown") {
      return [{ kind: "unknown", uses: step.uses }];
    }
    return [
      {
        configureBun: normalizeExpression(
          withInput["configure-bun"] ?? "false",
        ),
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
  if (uses.repository === "actions/setup-node" && uses.subpath === "") {
    return [
      {
        kind: "setup-node",
        registryMutating: withInput["registry-url"] !== undefined,
        uses: step.uses,
      },
    ];
  }
  if (uses.repository === "actions/checkout" && uses.subpath === "") {
    return [
      {
        kind: "checkout",
        uncertain:
          withInput.ref !== undefined || withInput.repository !== undefined,
        persistCredentials: normalizeExpression(
          withInput["persist-credentials"] ?? "true",
        ),
        ref: String(withInput.ref ?? ""),
        repository: String(withInput.repository ?? ""),
        uses: step.uses,
      },
    ];
  }
  if (uses.repository === "pnpm/action-setup" && uses.subpath === "") {
    const runInstall = withInput.run_install;
    if (runInstall !== undefined && String(runInstall) !== "false") {
      return [
        {
          kind: "js-public-download",
          manager: "pnpm",
          uses: step.uses,
          uncertain: true,
        },
      ];
    }
    return [{ kind: "unknown", uses: step.uses }];
  }
  return [{ kind: "unknown", uses: step.uses }];
}

export function classifyStep(step, context = {}) {
  if (context.stepBudget && --context.stepBudget.remaining < 0) {
    return [
      {
        kind: "unknown-local-action",
        reason: "local action expansion limit reached",
      },
    ];
  }
  if (!isMapping(step)) return [{ kind: "unknown" }];
  if (condition(step.if) === "never") return [];
  let operations;
  let uncertain = boundaryUncertain(step);
  if (
    step.uses !== undefined &&
    step.run === undefined &&
    typeof step.uses === "string" &&
    (step.with === undefined || isMapping(step.with))
  ) {
    operations = classifyUsesStep(step, context);
  } else if (typeof step.run === "string" && step.uses === undefined) {
    // Deliberately not a shell interpreter: retain recognizable downloads but
    // never certify control flow, substitutions, redirections or custom shells.
    uncertain ||=
      /[;'"$`|<>(){}\\]|(?:^|\s)(?:if|then|else|fi|for|while|case|eval|source|sudo)(?:\s|$)|(?<!&)&(?!&)/m.test(
        step.run,
      ) ||
      (step.shell !== undefined && !["bash", "sh"].includes(step.shell));
    operations = splitCommands(step.run).map((command) => {
      const operation = classifyCommand(command);
      if (
        /--(?:[^\s=]*:)?reg[a-z]*\b|--[^\s=]*(?:registry|userconfig)|(?:NPM|PNPM|BUN)_CONFIG_|npm_config_|\bnpm\s+config\s+(?:set|delete)\b/i.test(
          command,
        )
      ) {
        operation.registryMutating = true;
      } else if (
        operation.kind === "js-public-download" &&
        operation.corepack === undefined &&
        commandWords(command).some(
          (word) =>
            word.startsWith("-") && !TRANSPARENT_INSTALL_FLAGS.has(word),
        )
      ) {
        // Package managers accept abbreviated/configuration flags. Rather than
        // emulate each parser, keep unrecognized options as review candidates.
        operation.uncertain = true;
      }
      return operation;
    });
  } else {
    operations = [{ kind: "unknown" }];
  }
  return operations.map((operation) => ({
    ...operation,
    ...(uncertain || operation.uncertain ? { uncertain: true } : {}),
  }));
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
  const setups = [];
  const publishes = [];
  const expectedToken = expectedTokenExpression(context.visibility);
  let activeSetup;
  let registryInvalidated = false;
  let publishBoundary = true;
  let corepackEnabled = false;

  operations.forEach((operation, index) => {
    if (operation.corepack === "enable") corepackEnabled = true;
    if (operation.corepack === "disable") corepackEnabled = false;
    if (operation.kind === "js-public-download") {
      downloads.push(index);
      if (registryInvalidated || operation.registryMutating) {
        violations.push(
          `registry-mutating configuration precedes download operation ${index + 1}`,
        );
      }
      if (operation.manager === "pnpm" && corepackEnabled) {
        violations.push(
          `Corepack may lazily download pnpm directly from registry.npmjs.org at operation ${index + 1}; install pinned pnpm with npm through Socket Firewall instead`,
        );
      }
      if (
        activeSetup === undefined ||
        operation.uncertain ||
        operation.registryMutating
      ) {
        violations.push(
          `download operation ${index + 1} has no certain active Socket Firewall setup`,
        );
      }
      if (operation.manager === "bun" && activeSetup?.configureBun !== "true") {
        violations.push(
          `Bun download operation ${index + 1} requires configure-bun: true`,
        );
      }
      publishBoundary = false;
    }
    if (operation.registryMutating === true) {
      registryInvalidated = true;
      activeSetup = undefined;
    }
    if (operation.kind === "js-publish") {
      publishes.push(index);
      if (setups.length > 0 && !publishBoundary) {
        violations.push(
          "publish follows Socket Firewall setup without a same-SHA teardown boundary",
        );
      }
    }
    if (operation.kind === "sfw-setup") {
      registryInvalidated = false;
      setups.push(index);
      publishBoundary = false;
      activeSetup =
        operation.ref === APPROVED_RELEASE_SHA &&
        operation.token === expectedToken &&
        !operation.uncertain &&
        operation.fallback === "false"
          ? operation
          : undefined;
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
      registryInvalidated = false;
      activeSetup = undefined;
      publishBoundary =
        operation.ref === APPROVED_RELEASE_SHA && !operation.uncertain;
      if (operation.ref !== APPROVED_RELEASE_SHA) {
        violations.push(
          `sfw-teardown ref "${operation.ref}" does not match the approved release SHA`,
        );
      }
    }
  });

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

  if (downloads.length > 0 && setups.length > 0 && setups[0] > downloads[0]) {
    violations.push("Socket Firewall setup runs after the first download");
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

export function classifyJob(jobName, job, context = {}, triggers = []) {
  if (!isMapping(job)) {
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
  const stepContext = { ...context, stepBudget: { remaining: 1000 } };
  const operations =
    condition(job.if) === "never"
      ? []
      : steps.flatMap((step, index) =>
          classifyStep(step, stepContext).map((operation) => ({
            ...operation,
            step: index + 1,
          })),
        );
  if (
    !Array.isArray(job.steps) ||
    steps.length === 0 ||
    job.container !== undefined ||
    job.services !== undefined ||
    boundaryUncertain(job) ||
    context.workflowUncertain ||
    (job.defaults?.run?.shell !== undefined &&
      !["bash", "sh"].includes(job.defaults.run.shell))
  ) {
    operations.push({
      kind: "unknown",
      reason: "opaque job or workflow execution context",
    });
  }
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
    kinds.has("unknown-local-action") ||
    operations.some(
      (operation) =>
        operation.uncertain ||
        (operation.kind === "sfw-setup" && operation.fallback !== "false"),
    );
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
  } else if (hasUnknown) {
    // A conditional setup, opaque wrapper, or supported fork fallback is not
    // proof of a missing integration. Retain violations for private review.
    status = "unknown";
  } else if (kinds.has("yarn-blocked")) {
    status = "blocked-yarn";
  } else if (hasDownload && violations.length > 0) {
    status = "unprotected";
  } else if (hasDownload && hasSetup) {
    status = "protected";
  } else if (hasDownload) {
    status = "unprotected";
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
  if (
    !isMapping(workflow) ||
    !isMapping(workflow.jobs) ||
    Object.keys(workflow.jobs).length === 0
  ) {
    return {
      jobs: [],
      parseError: "workflow or jobs is not a nonempty mapping",
      path: context.path,
      status: "unknown",
      triggers: [],
    };
  }

  const triggers = normalizeTriggers(workflow);
  if (triggers.length === 0) {
    return {
      jobs: [],
      path: context.path,
      triggers,
      status: "unknown",
      parseError: "workflow has no recognized trigger declaration",
    };
  }
  const jobEntries = Object.entries(workflow.jobs ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const jobs = jobEntries.map(([jobName, job]) =>
    classifyJob(
      jobName,
      job,
      {
        ...context,
        workflowUncertain:
          workflow.env !== undefined || workflow.defaults !== undefined,
      },
      triggers,
    ),
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
