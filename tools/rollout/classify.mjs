import { parseYamlSource as parse } from "./yaml.mjs";
import { shellCommands, shellTokens } from "./commands.mjs";

import { ACTION_REPOSITORY, APPROVED_RELEASE_SHA } from "./constants.mjs";
import {
  certainTeardown,
  defaultsUncertain,
  environmentUncertain,
  literalWorkingDirectory,
  observedIntegration,
  unresolvedJsInvocation,
  SUPPORTED_SHELLS,
} from "./integration.mjs";

export const PACKAGE_MANAGER_READ = 'require("./package.json").packageManager';
const PNPM_BOOTSTRAP = `set -euo pipefail\npnpm_package="$(node --print '${PACKAGE_MANAGER_READ}')"\nnpm install --global "$pnpm_package" --ignore-scripts --no-audit --no-fund`;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const LOCAL_TARBALL = /^\$(?:RUNNER_TEMP|\{RUNNER_TEMP\})\/[\w.*-]+\.tgz$/;
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
  "--package-lock=false",
  "--omit=dev",
  "--include=optional",
  "--os=*",
  "--cpu=*",
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

// An ordinary run-step guard still has GitHub's implicit success() gating.
// It can skip an install/script, but cannot run it after failed setup. Keep
// explicit status predicates conservative and never apply this to uses/composites.
function primaryRunGuard(step) {
  if (
    typeof step.run === "string" &&
    typeof step.if === "string" &&
    !/\b(?:always|cancelled|failure|success)\s*\(/i.test(step.if)
  )
    return undefined;
  return step.if;
}

function expectedTokenExpression(visibility) {
  const secret =
    visibility === "public"
      ? "PUBLIC_SOCKET_FIREWALL_TOKEN"
      : "SOCKET_FIREWALL_TOKEN";
  return `\${{secrets.${secret}}}`;
}

function commandParts(command, context = {}) {
  const tokens = shellTokens(command);
  const words = tokens.words;
  const environment = {};
  let start = 0;
  const assignments = (envArguments = false) => {
    const values = envArguments ? words : tokens.commands;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[start] ?? "")) {
      // Keep keys for scope checks, never copy values to new diagnostics.
      Object.defineProperty(environment, values[start].split("=", 1)[0], {
        value: true,
        enumerable: true,
        configurable: true,
      });
      start += 1;
    }
  };
  assignments();
  let preservedEnvironment = false;
  if (words[start] === "env" && words[start + 1] === "-i") {
    // This clean-room npm invocation retains the exact action-configured paths
    // and registry. Every other env -i shape remains unresolved.
    const expected = {
      HOME: '"$HOME"',
      PATH: '"$PATH"',
      NPM_CONFIG_REGISTRY: '"${NPM_CONFIG_REGISTRY:?}"',
      NPM_CONFIG_USERCONFIG: '"${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"',
    };
    const values = new Map();
    let end = start + 2;
    let duplicate = false;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[end] ?? "")) {
      const raw = tokens.commands[end];
      const key = raw.slice(0, raw.indexOf("="));
      duplicate ||= values.has(key);
      values.set(key, raw.slice(key.length + 1));
      end += 1;
    }
    if (
      !duplicate &&
      words[end] === "npm" &&
      Object.entries(expected).every(
        ([key, value]) => values.get(key) === value,
      ) &&
      [...values].every(
        ([key, value]) =>
          Object.hasOwn(expected, key) || (key === "CI" && value === "true"),
      )
    ) {
      start = end;
      preservedEnvironment = true;
    }
  }
  if (words[start] === "env" && !words[start + 1]?.startsWith("-")) {
    start += 1;
    assignments(true);
  }
  const args = words.slice(start);
  const rawArgs = tokens.commands.slice(start);
  // A literal workspace selector changes the package, not the npm command.
  // Leave dynamic/escaping selectors and other leading options unresolved.
  while (args[0] === "npm") {
    const separate = ["-w", "--workspace"].includes(args[1]);
    const value = separate
      ? args[2]
      : args[1]?.startsWith("--workspace=")
        ? args[1].slice(12)
        : undefined;
    const bounded = value?.replace(
      /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g,
      (match, key) =>
        context.literalMatrixKeys?.has(key) ? "matrix-value" : match,
    );
    if (!literalWorkingDirectory(bounded) || bounded.startsWith("-")) break;
    const count = separate ? 2 : 1;
    args.splice(1, count);
    rawArgs.splice(1, count);
  }
  return { words: args, rawWords: rawArgs, environment, preservedEnvironment };
}

function commandWords(command, context) {
  return commandParts(command, context).words;
}

// Literal logging only: quoted source, substitution and shell controls are not
// interpreted. These lines are transparent only to observed configuration.
function literalLogging(command) {
  // GitHub interpolates expressions before the shell sees even single quotes.
  if (command.includes("${{")) return false;
  return /^echo(?:\s+(?:"[^"$`\\\\]*"|'[^']*'|[A-Za-z0-9_.,:/@+=-]+))*\s*$/.test(
    command,
  );
}

const REGISTRY_FLAG =
  /^--(?:config\.)?(?:(?:@[^:\s=]+:)?(?:reg|regi|regis|regist|registr|registry)|userconfig|globalconfig)(?:=|$)/i;
const REGISTRY_KEY = /^(?:(?:@[^:]+:)?registry|userconfig|globalconfig)$/i;
function registrySetter(words) {
  return (
    ["npm", "pnpm"].includes(words[0]) &&
    words[1] === "config" &&
    ["set", "delete", "unset"].includes(words[2]) &&
    REGISTRY_KEY.test((words[3] ?? "").split("=", 1)[0])
  );
}
function writeTargets(tokens, includeRemovals = true) {
  const target = (index) => ({
    value: tokens.words[index] ?? "",
    raw: tokens.commands[index] ?? "",
  });
  const targets = tokens.commands.flatMap((word, index) =>
    /^>+$/.test(word) ? [target(index + 1)] : [],
  );
  const program = tokens.words[0];
  if (
    program === "tee" ||
    (includeRemovals && ["rm", "unlink", "mv", "truncate"].includes(program)) ||
    (["sed", "perl"].includes(program) &&
      tokens.words.some((word) => /^-[^-]*i|^--in-place(?:=|$)/.test(word)))
  )
    return [
      ...targets,
      ...tokens.words.slice(1).map((_, index) => target(index + 1)),
    ];
  if (["cp", "install", "mv"].includes(program) && tokens.words.length > 1)
    return [...targets, target(tokens.words.length - 1)];
  return targets;
}
function expandedTarget(target) {
  return target.raw.startsWith('"') && target.raw.endsWith('"')
    ? target.raw.slice(1, -1)
    : target.raw;
}
function configTarget(target) {
  if (
    /(?:^|\/)\.npmrc$/.test(target.value) ||
    /^\$(?:NPM_CONFIG_USERCONFIG|\{NPM_CONFIG_USERCONFIG(?::\?[^}]*)?\})$/.test(
      expandedTarget(target),
    )
  )
    return "npm";
  if (
    /(?:^|\/)bunfig\.toml$/.test(target.value) ||
    /^\$(?:SFW_BUN_CONFIG_PATH|\{SFW_BUN_CONFIG_PATH(?::\?[^}]*)?\})$/.test(
      expandedTarget(target),
    )
  )
    return "bun";
  return undefined;
}

function assignmentKeys(words) {
  return Object.fromEntries(
    words.flatMap((word) => {
      const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=|<<)/);
      return match ? [[match[1], true]] : [];
    }),
  );
}
function changesStepEnvironment(command) {
  const { words, environment } = commandParts(command);
  if (!words.length) return environmentUncertain(environment);
  if (["export", "declare", "typeset", "unset"].includes(words[0])) {
    const keys =
      words[0] === "unset"
        ? Object.fromEntries(words.slice(1).map((key) => [key, true]))
        : assignmentKeys(words.slice(1));
    return environmentUncertain(keys);
  }
  return false;
}
function writesEnvironment(tokens) {
  const targets = writeTargets(tokens, false).map(expandedTarget);
  const keys = assignmentKeys(tokens.words);
  return (
    targets.some((path) =>
      /^\$(?:GITHUB_PATH|\{GITHUB_PATH(?::\?[^}]*)?\})$/.test(path),
    ) ||
    (targets.some((path) =>
      /^\$(?:GITHUB_ENV|\{GITHUB_ENV(?::\?[^}]*)?\})$/.test(path),
    ) &&
      (!Object.keys(keys).length || environmentUncertain(keys)))
  );
}

function approvedBunArguments(words, rawWords) {
  const indexes = new Set();
  if (words[0] !== "bun") return indexes;
  const approvedPath = (value) =>
    /^\$(?:SFW_BUN_CONFIG_PATH|\{SFW_BUN_CONFIG_PATH(?::\?)?\})$/.test(
      value?.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : (value ?? ""),
    );
  rawWords.forEach((word, index) => {
    if (word.startsWith("--config=") && approvedPath(word.slice(9)))
      indexes.add(index);
    if (word === "--config" && approvedPath(rawWords[index + 1])) {
      indexes.add(index);
      indexes.add(index + 1);
    }
  });
  return indexes;
}

function directExecutor(words) {
  const packageName = /^(?:@[\w.-]+\/)?[A-Za-z0-9_][\w.-]*(?:@[\w.^~*+-]+)?$/;
  if (words[0] === "npm") {
    // npm parses options after the command too, unless an explicit -- ends them.
    return ["exec", "x"].includes(words[1]) &&
      words[2] === "--" &&
      (packageName.test(words[3] ?? "") || LOCAL_TARBALL.test(words[3] ?? ""))
      ? words.slice(0, 3).join(" ")
      : undefined;
  }
  if (!["npx", "bunx"].includes(words[0])) return undefined;
  let target = 1;
  while (target < words.length) {
    if (["-y", "--yes"].includes(words[target])) target += 1;
    else if (
      words[0] === "npx" &&
      ["-p", "--package"].includes(words[target]) &&
      (packageName.test(words[target + 1] ?? "") ||
        LOCAL_TARBALL.test(words[target + 1] ?? ""))
    )
      target += 2;
    else if (
      words[0] === "npx" &&
      words[target].startsWith("--package=") &&
      (packageName.test(words[target].slice(10)) ||
        LOCAL_TARBALL.test(words[target].slice(10)))
    )
      target += 1;
    else break;
  }
  // Installer options end at the literal package/binary target. Arguments to
  // that program are payload, not npx/bunx registry configuration.
  if (
    !/^[A-Za-z0-9_@][A-Za-z0-9_@./:+-]*$/.test(words[target] ?? "") &&
    !LOCAL_TARBALL.test(words[target] ?? "")
  )
    return undefined;
  return words.slice(0, target).join(" ");
}

function installerArguments(words) {
  const prefix = directExecutor(words);
  const args = (prefix === undefined ? words : shellTokens(prefix).words).slice(
    1,
  );
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

function firstSubcommand(words) {
  return words.slice(1).find((word) => !word.startsWith("-"));
}

export function classifyCommand(command, context) {
  const words = commandWords(command, context);
  const program = words[0];
  if (!program) {
    return { command, kind: "no-network" };
  }
  if (program.includes("/"))
    return { command, program, kind: "unknown-wrapper" };
  const name = program;
  if (
    ["npm", "pnpm", "bun", "yarn", "npx", "bunx", "corepack"].includes(name) &&
    words.length === 2 &&
    ["--version", "-v", "--help", "-h"].includes(words[1])
  )
    return { command, kind: "no-network" };

  if (
    ["npm", "pnpm"].includes(name) &&
    words[1] === "config" &&
    ["get", "list", "ls"].includes(words[2])
  )
    return { command, kind: "no-network" };

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
      if (words.length !== 2)
        return {
          command,
          program,
          corepackControl: subcommand,
          kind: "unknown-wrapper",
        };
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
      installationCapable: executesProgram,
    };
  }
  if (ORCHESTRATORS.has(name)) {
    if (name === "lerna" && words.includes("bootstrap")) {
      return { command, kind: "js-public-download", manager: "npm" };
    }
    return { command, program, kind: "unknown-wrapper" };
  }
  if (
    WRAPPER_COMMANDS.has(name) ||
    /\.sh$/.test(name) ||
    ((name === "bash" || name === "sh" || name === "zsh") &&
      words.slice(1).some((word) => /\.sh$/.test(word)))
  ) {
    return { command, program, kind: "unknown-wrapper" };
  }
  return {
    command,
    program,
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

// Local uses paths are workspace-relative, not relative to the action file.
// Only a checkout selecting this captured source may remap a literal mount.
export function resolveLocalActionSource(path, context = {}) {
  for (const step of [...(context.checkouts ?? [])].reverse()) {
    if (condition(step.if) === "never") continue;
    const input = step.with ?? {};
    if (!isMapping(input)) return { sourceError: "unresolved-checkout-source" };
    const mount = input.path ?? ".";
    if (!literalWorkingDirectory(mount))
      return { sourceError: "unresolved-checkout-path" };
    const prefix = mount.replace(/^\.\//, "").replace(/\/$/, "");
    const root = prefix === "." || prefix === "";
    if (!root && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    const repository = input.repository;
    const ref = input.ref;
    // In a reusable workflow, implicit checkout/github.repository select the
    // caller, not necessarily the repository containing this workflow.
    const sameRepository =
      (typeof repository === "string" && repository === context.repository) ||
      (!context.reusableWorkflow &&
        (repository === undefined ||
          normalizeExpression(repository) === "${{github.repository}}"));
    const sameRef =
      ref === undefined ||
      ref === "" ||
      (context.headSha !== undefined && ref === context.headSha) ||
      (!context.reusableWorkflow &&
        normalizeExpression(ref) === "${{github.sha}}");
    if (
      !sameRepository ||
      !sameRef ||
      condition(step.if) !== "always" ||
      condition(step["continue-on-error"] ?? false) !== "never" ||
      input["sparse-checkout"] !== undefined ||
      step.env !== undefined
    )
      return {
        sourceError: "unresolved-checkout-source",
        checkoutRepository: repository ?? context.repository,
        checkoutRef: ref,
      };
    return {
      path: root ? path : path.slice(prefix.length).replace(/^\//, ""),
      checkedOut: true,
    };
  }
  return { path };
}

// Bind only whole-value composite input references; never evaluate expressions
// or interpolate shell text. This preserves caller token names through helpers.
function bindInputs(value, inputs) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/);
  return match
    ? Object.hasOwn(inputs, match[1])
      ? inputs[match[1]]
      : ""
    : value;
}

function bindStepInputs(step, inputs) {
  if (!isMapping(step)) return step;
  return Object.fromEntries(
    Object.entries(step).map(([key, value]) => [
      key,
      ["with", "env"].includes(key) && isMapping(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, item]) => [
              name,
              bindInputs(item, inputs),
            ]),
          )
        : value,
    ]),
  );
}

function classifyUsesStep(step, context) {
  const uses = parseUses(step.uses);
  const withInput = step.with ?? {};

  if (uses.kind === "local") {
    const source = resolveLocalActionSource(uses.path, context);
    if (source.sourceError)
      return [{ kind: "unknown-local-action", uses: step.uses, ...source }];
    if (
      context.localSfwRelease &&
      source.checkedOut &&
      ["", "teardown"].includes(source.path)
    ) {
      return classifyUsesStep(
        {
          ...step,
          uses: `${ACTION_REPOSITORY}${source.path ? "/teardown" : ""}@${APPROVED_RELEASE_SHA}`,
        },
        context,
      ).map((operation) => ({
        ...operation,
        uses: step.uses,
        localRuntimeVerified: true,
        uncertain: true,
        integrationConfigurationUncertain: false,
      }));
    }
    const stack = context.actionStack ?? [];
    if (stack.includes(uses.path) || stack.length >= 20) {
      return [
        {
          kind: "unknown-local-action",
          uses: step.uses,
          reason: "cyclic or deeply nested local action",
          sourceError: "unresolved-local-action-expansion",
        },
      ];
    }
    const prefix = source.path ? `${source.path}/` : "";
    const actionText =
      context.localActions?.get(`${prefix}action.yml`) ??
      context.localActions?.get(`${prefix}action.yaml`);
    if (actionText === undefined) {
      return [
        {
          kind: "unknown-local-action",
          uses: step.uses,
          sourceError: "unresolved-local-action-source",
        },
      ];
    }
    let action;
    try {
      action = parse(actionText);
    } catch {
      return [
        {
          kind: "unknown-local-action",
          uses: step.uses,
          sourceError: "local-action-parse-error",
        },
      ];
    }
    if (
      !isMapping(action) ||
      !isMapping(action.runs) ||
      typeof action.runs.using !== "string" ||
      (action.runs.using === "composite" &&
        (!Array.isArray(action.runs.steps) || action.runs.steps.length === 0))
    ) {
      return [
        {
          kind: "unknown-local-action",
          uses: step.uses,
          sourceError: "malformed-local-action",
        },
      ];
    }
    const steps = action?.runs?.steps;
    if (
      action?.runs?.using !== "composite" ||
      !Array.isArray(steps) ||
      steps.length === 0
    ) {
      return [{ kind: "unknown-local-action", uses: step.uses }];
    }
    const inputs = {
      ...Object.fromEntries(
        Object.entries(action.inputs ?? {}).map(([key, input]) => [
          key,
          input?.default ?? "",
        ]),
      ),
      ...withInput,
    };
    return steps.flatMap((inner) =>
      classifyStep(bindStepInputs(inner, inputs), {
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
        id: step.id,
        condition: step.if,
        boundaryUncertainWithoutCondition: boundaryUncertain({
          ...step,
          if: undefined,
        }),
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
        registryPersisting: withInput["registry-url"] !== undefined,
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
          integrationConfigurationUncertain: ![true, "true"].includes(
            runInstall,
          ),
        },
      ];
    }
    return [
      {
        kind: "unknown",
        uses: step.uses,
      },
    ];
  }
  return [
    {
      kind: "unknown",
      uses: step.uses,
    },
  ];
}

export function classifyStep(step, context = {}) {
  if (context.stepBudget && --context.stepBudget.remaining < 0) {
    return [
      {
        kind: "unknown-local-action",
        reason: "local action expansion limit reached",
        sourceError: "unresolved-local-action-expansion",
      },
    ];
  }
  if (!isMapping(step)) return [{ kind: "unknown" }];
  if (condition(step.if) === "never") return [];
  if (
    isMapping(step.with) &&
    Object.values(step.with).some(
      (value) => value !== null && typeof value === "object",
    )
  )
    return [{ kind: "unknown", sourceError: "malformed-action-input" }];
  // Resolve only this root-manifest bootstrap, not arbitrary shell variables.
  // Snapshot evidence does not certify execution of the JSON reader at runtime.
  const pinnedBootstrap =
    !context.actionStack?.length &&
    typeof context.packageManager === "string" &&
    context.packageManager === context.packageManager.trim() &&
    /^pnpm@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
      context.packageManager ?? "",
    ) &&
    [undefined, ".", "./"].includes(step["working-directory"]) &&
    typeof step.run === "string" &&
    step.run
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .join("\n") === PNPM_BOOTSTRAP;
  if (pinnedBootstrap)
    step = {
      ...step,
      run: `npm install --global ${context.packageManager} --ignore-scripts --no-audit --no-fund`,
    };
  const lines =
    typeof step.run === "string"
      ? step.run
          .trim()
          .split("\n")
          .map((line) => line.trim())
      : [];
  const offlineBun =
    !context.actionStack?.length &&
    context.offlineBunAllowed !== false &&
    !environmentUncertain(step.env) &&
    (step.shell === undefined || SUPPORTED_SHELLS.has(step.shell)) &&
    lines[0] ===
      "if ! bun install --help | grep -F -- '--offline ' >/dev/null; then" &&
    /^echo '[^'\r\n$`\\]*' >&2$/.test(lines[1] ?? "") &&
    lines[2] === "exit 1" &&
    lines[3] === "fi" &&
    lines[4] ===
      "bun install --lockfile-only --offline --ignore-scripts --registry=https://registry.npmjs.org/";
  let operations;
  let uncertain = boundaryUncertain(step) || pinnedBootstrap;
  let integrationEnv = step.env;
  if (
    typeof step.uses === "string" &&
    step.uses.split("@")[0] === ACTION_REPOSITORY &&
    isMapping(step.env) &&
    /^\$\{\{runner\.temp\}\}\/[\w.-]+$/.test(
      normalizeExpression(step.env.NPM_CONFIG_USERCONFIG),
    )
  ) {
    // Setup validates this path and configures both it and HOME/.npmrc.
    // An override on an install step still requires separate review.
    integrationEnv = { ...step.env };
    delete integrationEnv.NPM_CONFIG_USERCONFIG;
  }
  const registryExclusion =
    context.registryExclusion &&
    !context.actionStack?.length &&
    [undefined, ".", "./"].includes(step["working-directory"]) &&
    isMapping(integrationEnv) &&
    integrationEnv.NPM_CONFIG_REPLACE_REGISTRY_HOST === "npmjs" &&
    /^\s*npm\s+(?:ci|install)\s*$/.test(step.run ?? "")
      ? context.registryExclusion.id
      : undefined;
  if (registryExclusion) {
    integrationEnv = { ...integrationEnv };
    delete integrationEnv.NPM_CONFIG_REPLACE_REGISTRY_HOST;
  }
  let integrationUncertain =
    boundaryUncertain({ ...step, env: undefined, if: primaryRunGuard(step) }) ||
    environmentUncertain(integrationEnv);
  const configurationBoundaryUncertain = integrationUncertain;
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
    const complexShell = (script) =>
      /[;'"$`|<>(){}\\]|(?:^|\s)(?:if|then|else|fi|for|while|case|eval|source|sudo)(?:\s|$)|(?<!&)&(?!&)/m.test(
        script,
      ) ||
      (step.shell !== undefined && !SUPPORTED_SHELLS.has(step.shell));
    uncertain ||= complexShell(step.run);
    const shell = shellCommands(step.run);
    integrationUncertain ||=
      shell.ambiguous ||
      (step.shell !== undefined && !SUPPORTED_SHELLS.has(step.shell));
    const conditionalControl =
      shell.conditional ||
      shell.commands.some((command) =>
        /^(?:if|case|for|while|until|select)\b/.test(command),
      );
    let offlineCommandPending = offlineBun;
    operations = shell.commands.map((command) => {
      const offlineValidation = offlineCommandPending && command === lines[4];
      if (offlineValidation) offlineCommandPending = false;
      const operation = offlineValidation
        ? {
            command,
            kind: "no-network",
            offlineValidation: true,
            uncertain: true,
          }
        : classifyCommand(command, context);
      const { words, rawWords, environment, preservedEnvironment } =
        commandParts(command, context);
      const bunArguments = approvedBunArguments(words, rawWords);
      const tokens = shellTokens(command);
      if (tokens.limit || tokens.lexError)
        operation.sourceError = "unresolved-shell-source";
      const nestedCommands = tokens.substitutions.flatMap(
        (body) => shellCommands(body).commands,
      );
      const nested = nestedCommands.map((body) => commandParts(body).words);
      const nestedEnvironment = nestedCommands.some(
        (body, index) =>
          environmentUncertain(commandParts(body).environment) ||
          (classifyCommand(body).kind === "unknown-wrapper" &&
            !classifyCommand(body).manager &&
            unresolvedJsInvocation(classifyCommand(body))) ||
          changesStepEnvironment(body) ||
          (/^(?:env|sudo|command|time|exec)$/.test(nested[index][0] ?? "") &&
            unresolvedJsInvocation(classifyCommand(body))),
      );
      const executorPrefix = directExecutor(words);
      // npm's exact 'always' mode rewrites lockfile hosts to the configured
      // registry; it does not select another registry. Other modes need review.
      const replacementFlags = words.filter((word) =>
        word.startsWith("--replace-registry-host"),
      );
      const configurationWords = installerArguments(words).filter(
        (word) => !word.startsWith("--replace-registry-host"),
      );
      const supportedReplacement =
        words[0] === "npm" &&
        replacementFlags.every(
          (word) => word === "--replace-registry-host=always",
        );
      const targets = [
        ...writeTargets(tokens),
        ...nestedCommands.flatMap((body) => writeTargets(shellTokens(body))),
      ];
      const configKinds = targets.map(configTarget);
      const configFileWrite = configKinds.some(Boolean);
      const bunFileOnly = configFileWrite && !configKinds.includes("npm");
      const knownRegistryContent =
        ["echo", "printf"].includes(words[0]) &&
        tokens.words.some((word) =>
          /(?:^|\n)(?:@[^:]+:)?registry\s*=/.test(word),
        );
      const setter = registrySetter(words) || nested.some(registrySetter);
      const dynamicSetter = [words, ...nested].some(
        (args) =>
          ["npm", "pnpm"].includes(args[0]) &&
          args[1] === "config" &&
          ["set", "delete", "unset"].includes(args[2]) &&
          /[$`]/.test(args.slice(3).join(" ")),
      );
      const nestedOverride = nested.some(
        (args) =>
          ["npm", "pnpm", "bun", "yarn", "npx", "bunx"].includes(args[0]) &&
          installerArguments(args).some((word) => REGISTRY_FLAG.test(word)),
      );
      const registryMutating =
        !offlineValidation &&
        (setter ||
          dynamicSetter ||
          configFileWrite ||
          nestedOverride ||
          (["npm", "pnpm", "bun", "yarn", "npx", "bunx"].includes(words[0]) &&
            configurationWords.some((word) => REGISTRY_FLAG.test(word))) ||
          Object.keys(environment).some((key) =>
            /^(?:npm|pnpm|bun)_CONFIG_/i.test(key),
          ));
      // A literal npm prefix selects the project directory, just like a
      // run-step working-directory. Do not accept dynamic or escaping paths.
      const directoryArguments = new Set();
      if (words[0] === "npm" && !words[1]?.startsWith("-")) {
        words.forEach((word, index) => {
          if (
            word === "--prefix" &&
            literalWorkingDirectory(words[index + 1])
          ) {
            directoryArguments.add(index);
            directoryArguments.add(index + 1);
          } else if (
            word.startsWith("--prefix=") &&
            literalWorkingDirectory(word.slice(9))
          ) {
            directoryArguments.add(index);
          }
        });
      }
      const unsupportedFlags =
        operation.kind === "js-public-download" &&
        operation.corepack === undefined &&
        words
          .filter(
            (word, index) =>
              !bunArguments.has(index) &&
              !directoryArguments.has(index) &&
              !(
                supportedReplacement &&
                word === "--replace-registry-host=always"
              ),
          )
          .some(
            (word) =>
              word.startsWith("-") && !TRANSPARENT_INSTALL_FLAGS.has(word),
          );
      if (registryMutating) {
        operation.registryMutating = true;
        operation.registryPersisting =
          setter || dynamicSetter || configFileWrite;
        if (bunFileOnly) operation.registryManager = "bun";
      } else if (
        unsupportedFlags ||
        (replacementFlags.length > 0 && !supportedReplacement)
      )
        operation.uncertain = true;
      if (Object.keys(environment).length && !registryMutating)
        operation.uncertain = true;
      operation.integrationUncertain =
        environmentUncertain(environment) ||
        (replacementFlags.length > 0 && !supportedReplacement) ||
        (words[0] === "npm" && ["exec", "x"].includes(words[1])) ||
        (unsupportedFlags && !registryMutating) ||
        (operation.kind === "js-public-download" &&
          /[$`]/.test(
            words
              .filter(
                (word, index) =>
                  !bunArguments.has(index) &&
                  !(words[0] === "npm" && LOCAL_TARBALL.test(word)),
              )
              .join(" "),
          )) ||
        (configFileWrite && !knownRegistryContent) ||
        nestedOverride ||
        dynamicSetter;
      if (
        ["npx", "bunx"].includes(words[0]) ||
        (words[0] === "npm" && ["exec", "x"].includes(words[1]))
      ) {
        // Strict assurance still sees unknown executor code/configuration flags.
        operation.uncertain = true;
        operation.integrationExecutor = executorPrefix !== undefined;
        operation.integrationUncertain =
          environmentUncertain(environment) ||
          (executorPrefix === undefined && !registryMutating);
        operation.integrationUncertain ||= nestedOverride;
        // Persistence comes from executable setters/writes, not payload text.
      }
      if (setter && nested.some(registrySetter))
        operation.integrationUncertain = true;
      // Reachability is not a certain state transition: a skipped disable
      // cannot clear a persistent Corepack shim established by an earlier step.
      if (
        operation.corepackControl ||
        ["enable", "disable"].includes(operation.corepack)
      )
        operation.integrationUncertain ||=
          condition(step.if) === "uncertain" || conditionalControl;
      if (
        operation.registryMutating &&
        (conditionalControl || condition(step.if) === "uncertain")
      )
        operation.integrationUncertain = true;
      operation.commandGroup = context.stepBudget?.remaining;
      operation.stepEnvironmentUncertain = changesStepEnvironment(command);
      operation.environmentPersisting =
        writesEnvironment(tokens) ||
        nestedCommands.some((body) => writesEnvironment(shellTokens(body)));
      const nestedCandidates = nestedCommands.map(classifyCommand);
      const nestedInvocations = nestedCandidates.filter((candidate, index) => {
        const args = nested[index];
        const configRead =
          args[1] === "config" && ["get", "list", "ls"].includes(args[2]);
        return (
          candidate.kind === "js-public-download" ||
          candidate.kind === "yarn-blocked" ||
          (unresolvedJsInvocation(candidate) &&
            !configRead &&
            !registrySetter(args) &&
            !scriptInvocation(args, candidate.kind))
        );
      });
      operation.explicitJsInvocation =
        nestedOverride || nestedInvocations.length > 0;
      const directInvocation =
        !scriptInvocation(words, operation.kind) &&
        unresolvedJsInvocation({ ...operation, explicitJsInvocation: false });
      const identifiedInvocations = directInvocation
        ? [...nestedInvocations, operation]
        : nestedInvocations;
      operation.integrationManagers = [
        ...new Set(
          identifiedInvocations
            .map((candidate) => {
              const manager =
                candidate.manager ??
                shellTokens(candidate.command).words.find((word) =>
                  ["npm", "pnpm", "bun", "yarn", "npx", "bunx"].includes(word),
                );
              return manager === "npx"
                ? "npm"
                : manager === "bunx"
                  ? "bun"
                  : manager;
            })
            .filter(Boolean),
        ),
      ];
      operation.integrationCorepackDownload = nestedInvocations.some(
        (candidate) => candidate.corepack,
      );
      operation.integrationCorepackUncertain = nestedCandidates.some(
        (candidate) =>
          candidate.corepackControl ||
          ["enable", "disable"].includes(candidate.corepack),
      );
      operation.integrationConfigurationUncertain =
        operation.integrationUncertain ||
        (operation.explicitJsInvocation && nestedEnvironment) ||
        (directInvocation && !operation.manager) ||
        (step.shell !== undefined && !SUPPORTED_SHELLS.has(step.shell)) ||
        (operation.kind === "unknown-wrapper" &&
          operation.manager !== undefined &&
          (words[1]?.startsWith("-") || /[$`]/.test(words[1] ?? ""))) ||
        /^(?![A-Za-z_][A-Za-z0-9_]*=)[^\s=]+=/.test(command) ||
        /^(?:\.?\.?\/|\/)[^\s]*\/(?:npm|pnpm|npx|bun|bunx|yarn|corepack)\b/.test(
          command,
        ) ||
        (!preservedEnvironment &&
          /^(?:env|sudo|command|time|exec)$/.test(words[0] ?? "") &&
          /(?:^|\s)(?:npm|pnpm|npx|bun|bunx|yarn|corepack)\b/.test(command)) ||
        (operation.registryMutating && shell.ambiguous);
      operation.integrationSyntaxUncertain = shell.ambiguous;
      operation.integrationLiteral = literalLogging(command);
      // Script bodies are unverified code, not presumed dependency installs.
      // pnpm/Yarn support script-name shorthands; their configuration/toolchain
      // commands are not shorthands. Explicit nested JS commands stay reviewable.
      operation.integrationScript = scriptInvocation(words, operation.kind);
      return operation;
    });
    if (shell.limit || shell.lexError)
      operations.push({
        kind: "unknown",
        sourceError: "unresolved-shell-source",
      });
  } else {
    operations = [{ kind: "unknown" }];
  }
  return operations.map((operation) => ({
    ...operation,
    ...(registryExclusion ? { registryExclusion } : {}),
    ...(uncertain || operation.uncertain ? { uncertain: true } : {}),
    integrationUncertain:
      integrationUncertain ||
      (operation.integrationUncertain ?? operation.uncertain ?? false),
    integrationConfigurationUncertain:
      configurationBoundaryUncertain ||
      (operation.integrationConfigurationUncertain ??
        operation.integrationUncertain ??
        operation.uncertain ??
        false),
  }));
}

function scriptInvocation(words, kind) {
  return (
    kind === "unknown-wrapper" &&
    ["npm", "pnpm", "bun", "yarn"].includes(words[0]) &&
    (/^(?:run|test|start|stop|restart)$/.test(words[1] ?? "") ||
      (words[0] === "bun" &&
        (words[1] === "build" ||
          (literalWorkingDirectory(words[1]) &&
            /\.[cm]?[jt]sx?$/.test(words[1])))) ||
      (words[0] === "npm" &&
        (words[1] === "version" ||
          (words[1] === "pack" &&
            words
              .slice(2)
              .every((arg) =>
                ["--json", "--ignore-scripts", "--dry-run"].includes(arg),
              )))) ||
      (["pnpm", "yarn"].includes(words[0]) &&
        /^[A-Za-z0-9_:.+-]+$/.test(words[1] ?? "") &&
        !/^(?:config|env|setup|set|create|self-update|plugin|policies|patch|patch-commit)$/.test(
          words[1],
        ) &&
        !words
          .slice(2)
          .some((word) =>
            /^(?:npm|pnpm|npx|bun|bunx|yarn|corepack)$/.test(word),
          )))
  );
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
  let lastSetup;
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
      lastSetup = operation;
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
      publishBoundary = certainTeardown(operation, lastSetup);
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
      integration: {
        disposition: "needs-review",
        downloads: [],
        notes: ["malformed-job"],
        runtimeVerification: "not-performed",
      },
    };
  }

  if (job.uses !== undefined && condition(job.if) === "never") {
    return {
      job: jobName,
      managers: [],
      operations: [],
      status: "no-in-scope-download",
      violations: [],
      integration: {
        disposition: "no-js-ci",
        downloads: [],
        notes: [],
        runtimeVerification: "not-performed",
      },
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
      operations:
        typeof job.uses === "string" &&
        job.steps === undefined &&
        (job.with === undefined || isMapping(job.with)) &&
        (job.secrets === undefined ||
          job.secrets === "inherit" ||
          isMapping(job.secrets))
          ? [{ kind: "reusable-call", uses: job.uses }]
          : [{ kind: "unknown", sourceError: "malformed-reusable-call" }],
      status: "reusable-call",
      violations,
      integration: {
        disposition: "needs-review",
        downloads: [],
        notes: ["unresolved-reusable-workflow"],
        runtimeVerification: "not-performed",
      },
    };
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const matrix = job.strategy?.matrix;
  const literalMatrixKeys = new Set(
    matrix &&
      typeof matrix === "object" &&
      !Array.isArray(matrix) &&
      matrix.include === undefined
      ? Object.entries(matrix)
          .filter(
            ([, values]) =>
              Array.isArray(values) &&
              values.length > 0 &&
              values.every(
                (value) =>
                  typeof value === "string" &&
                  /^[A-Za-z0-9_][\w.-]*$/.test(value),
              ),
          )
          .map(([key]) => key)
      : [],
  );
  const checkouts = steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        typeof step?.uses === "string" &&
        step.uses.startsWith("actions/checkout@"),
    );
  const checkout = checkouts[0];
  const defaultCheckout =
    checkouts.length === 1 &&
    condition(checkout.step.if) === "always" &&
    condition(checkout.step["continue-on-error"] ?? false) === "never" &&
    ["ref", "repository", "path", "sparse-checkout"].every(
      (key) => checkout.step.with?.[key] === undefined,
    );
  const stepContext = {
    ...context,
    reusableWorkflow: triggers.includes("workflow_call"),
    offlineBunAllowed:
      !environmentUncertain(job.env) &&
      !defaultsUncertain(job.defaults) &&
      !context.integrationContextUncertain &&
      job.container === undefined,
    registryExclusion:
      defaultCheckout &&
      context.exclusionRootDirectory !== false &&
      [undefined, ".", "./"].includes(job.defaults?.run?.["working-directory"])
        ? context.registryExclusion
        : undefined,
    literalMatrixKeys,
    stepBudget: { remaining: 1000 },
  };
  let packageManagerSourceUnchanged =
    defaultCheckout &&
    [undefined, ".", "./"].includes(job.defaults?.run?.["working-directory"]) &&
    context.exclusionRootDirectory !== false;
  const priorCheckouts = [];
  const operations =
    condition(job.if) === "never"
      ? []
      : steps.flatMap((step, index) => {
          const afterCheckout = index > (checkout?.index ?? -1);
          if (
            typeof step?.uses === "string" &&
            step.uses.startsWith("actions/checkout@")
          )
            priorCheckouts.push(step);
          const currentContext = {
            ...stepContext,
            checkouts: priorCheckouts,
            registryExclusion: afterCheckout
              ? stepContext.registryExclusion
              : undefined,
            packageManager:
              afterCheckout && packageManagerSourceUnchanged
                ? context.packageManager
                : undefined,
          };
          // Earlier shell/local or mutable action execution can replace the file.
          if (
            typeof step?.uses !== "string" ||
            step.uses.startsWith("./") ||
            !FULL_SHA_PATTERN.test(step.uses.split("@")[1] ?? "")
          )
            packageManagerSourceUnchanged = false;
          return classifyStep(step, currentContext).map((operation) => ({
            ...operation,
            step: index + 1,
          }));
        });
  if (
    !Array.isArray(job.steps) ||
    steps.length === 0 ||
    job.container !== undefined ||
    job.services !== undefined ||
    boundaryUncertain(job) ||
    context.workflowUncertain ||
    (job.defaults?.run?.shell !== undefined &&
      !SUPPORTED_SHELLS.has(job.defaults.run.shell))
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

  return {
    job: jobName,
    managers,
    operations,
    status,
    violations,
    integration: observedIntegration(operations, job, context),
  };
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
    workflow == null &&
    text.trim().startsWith("#") &&
    text.split("\n").every((line) => /^\s*(?:#.*)?$/.test(line))
  ) {
    return {
      jobs: [],
      path: context.path,
      triggers: [],
      status: "no-in-scope-download",
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
        exclusionRootDirectory: [undefined, ".", "./"].includes(
          workflow.defaults?.run?.["working-directory"],
        ),
        workflowUncertain:
          workflow.env !== undefined || workflow.defaults !== undefined,
        integrationContextUncertain:
          environmentUncertain(workflow.env) ||
          defaultsUncertain(workflow.defaults),
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
