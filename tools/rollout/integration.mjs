import { APPROVED_RELEASE_SHA } from "./constants.mjs";

// Configuration/executable/startup controls, not application credentials.
const RELEVANT_ENV =
  /^(?:(?:npm|pnpm|bun|yarn|corepack)_|HOME$|USERPROFILE$|XDG_|APPDATA$|LOCALAPPDATA$|PATH$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SHELL$|SHELLOPTS$|BASHOPTS$|CDPATH$|LD_|DYLD_|BASH_FUNC_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$)/i;
// Workflow toolchain-version metadata does not select a registry/config path.
const VERSION_ENV = new Set([
  "NODE_VERSION",
  "PNPM_VERSION",
  "BUN_VERSION",
  "XCODE_VERSION",
]);
const normalize = (value) => String(value ?? "").replaceAll(/\s+/g, "");
const expression = (value) =>
  normalize(value).replace(/^\$\{\{(.*)\}\}$/, "$1");

export function environmentUncertain(env) {
  if (env === undefined) return false;
  if (!env || typeof env !== "object" || Array.isArray(env)) return true;
  return Object.entries(env).some(
    ([key, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      (RELEVANT_ENV.test(key) && !VERSION_ENV.has(key.toUpperCase())) ||
      !["string", "number", "boolean"].includes(typeof value),
  );
}

export function defaultsUncertain(defaults) {
  if (defaults === undefined) return false;
  return (
    !defaults ||
    typeof defaults !== "object" ||
    Array.isArray(defaults) ||
    Object.keys(defaults).some((key) => key !== "run") ||
    !defaults.run ||
    typeof defaults.run !== "object" ||
    Array.isArray(defaults.run) ||
    Object.entries(defaults.run).some(
      ([key, value]) => key !== "shell" || !["bash", "sh"].includes(value),
    )
  );
}

// Only the documented toolchain role is assumed here, not bootstrap traffic or
// arbitrary action implementation safety. Strict assurance keeps these opaque.
export function toolchainPreservesRouting(uses, inputs) {
  if (uses.subpath !== "" || uses.kind !== "remote" || !uses.ref) return false;
  const supported =
    uses.repository === "pnpm/action-setup"
      ? ["version", "package_json_file", "run_install"]
      : uses.repository === "oven-sh/setup-bun"
        ? ["bun-version", "bun-version-file"]
        : undefined;
  if (!supported || Object.keys(inputs).some((key) => !supported.includes(key)))
    return false;
  return (
    inputs.run_install === undefined ||
    inputs.run_install === false ||
    inputs.run_install === "false"
  );
}

export function certainTeardown(operation, setup) {
  if (operation.ref !== APPROVED_RELEASE_SHA) return false;
  if (!operation.uncertain) return true;
  if (operation.via || operation.boundaryUncertainWithoutCondition)
    return false;
  const guard = expression(operation.condition);
  if (guard === "always()") return true;
  const active = guard.match(
    /^always\(\)&&steps\.([A-Za-z_][\w-]*)\.outputs\.active==(['"])true\2$/,
  );
  return Boolean(
    active &&
    !setup?.via &&
    setup?.id === active[1] &&
    !setup.uncertain &&
    setup.ref === operation.ref,
  );
}

function installationCapable(operation) {
  if (operation.corepackControl) return false;
  if (operation.kind === "unknown-local-action") return true;
  if (operation.kind !== "unknown-wrapper") return false;
  const program =
    operation.program ??
    String(operation.command ?? "")
      .trim()
      .split(/\s+/)[0];
  return Boolean(
    operation.manager ||
    operation.installationCapable ||
    program.includes("/") ||
    /['"$`=]/.test(program) ||
    /\.(?:[cm]?js|sh|py|rb)$/.test(program) ||
    [
      "env",
      "npm",
      "pnpm",
      "bun",
      "yarn",
      "node",
      "command",
      "sudo",
      "time",
      "exec",
      "eval",
      "source",
      ".",
      "python",
      "python3",
      "ruby",
      "perl",
      "bash",
      "sh",
      "zsh",
      "make",
      "just",
      "mise",
      "rake",
      "task",
      "corepack",
      "lerna",
      "nx",
      "rush",
      "turbo",
    ].includes(program),
  );
}

function contextUncertain(job, context) {
  return (
    environmentUncertain(job.env) ||
    defaultsUncertain(job.defaults) ||
    (context.integrationContextUncertain ?? context.workflowUncertain) ||
    job.container !== undefined
  );
}

export function observedIntegration(operations, job, context) {
  const downloads = [];
  const notes = new Set();
  const expectedToken = `\${{secrets.${context.visibility === "public" ? "PUBLIC_SOCKET_FIREWALL_TOKEN" : "SOCKET_FIREWALL_TOKEN"}}}`;
  let setup;
  let state;
  let opaque = false;
  let corepack = "disabled";
  let potentialInstall = false;
  let unresolvedEarlyInstall = false;
  const uncertainContext = contextUncertain(job, context);
  const malformed =
    !Array.isArray(job.steps) ||
    job.steps.length === 0 ||
    operations.some(
      (operation) =>
        operation.sourceError ||
        (operation.kind === "unknown" && !operation.uses && !operation.reason),
    );
  if (malformed) notes.add("malformed-job-or-step");

  for (const [index, operation] of operations.entries()) {
    const uncertain = operation.integrationUncertain ?? operation.uncertain;
    if (operation.corepackControl) corepack = "unresolved";
    if (["enable", "disable"].includes(operation.corepack))
      corepack = uncertain
        ? "unresolved"
        : operation.corepack === "enable"
          ? "enabled"
          : "disabled";
    if (operation.kind === "sfw-setup") {
      setup = operation;
      opaque = false;
      if (uncertain || !["false", "true"].includes(operation.fallback)) {
        state = {
          status: "unresolved",
          reason: "conditional-or-uncertain-setup",
        };
      } else if (
        operation.ref !== APPROVED_RELEASE_SHA ||
        (operation.token !== expectedToken &&
          (!operation.token.includes("${{") ||
            /^\$\{\{secrets\.[A-Za-z_][\w]*\}\}$/.test(operation.token))) ||
        (operation.fallback === "true" && context.visibility !== "public")
      ) {
        state = { status: "gap", reason: "unsupported-setup-configuration" };
      } else if (operation.token !== expectedToken) {
        state = { status: "unresolved", reason: "unresolved-setup-token" };
      } else {
        state = {
          status: operation.fallback === "true" ? "fork-exception" : "covered",
          reason: "approved-setup-interval",
        };
      }
      continue;
    }
    if (operation.kind === "sfw-teardown") {
      const certain = certainTeardown(operation, setup);
      state = certain
        ? undefined
        : { status: "unresolved", reason: "conditional-or-uncertain-teardown" };
      setup = undefined;
      opaque = false;
      continue;
    }
    if (
      operation.kind === "js-public-download" ||
      operation.kind === "yarn-blocked"
    ) {
      let result;
      if (uncertainContext || uncertain || opaque) {
        result = {
          status: "unresolved",
          reason: uncertainContext
            ? "install-execution-context"
            : opaque
              ? "opaque-operation-before-install"
              : "uncertain-install-syntax-or-condition",
        };
      } else if (operation.registryMutating) {
        result = { status: "gap", reason: "registry-override" };
      } else if (operation.kind === "yarn-blocked") {
        result = { status: "unresolved", reason: "unsupported-yarn-install" };
      } else if (operation.manager === "pnpm" && corepack === "unresolved") {
        result = { status: "unresolved", reason: "uncertain-corepack-shims" };
      } else if (
        operation.corepack ||
        (operation.manager === "pnpm" && corepack === "enabled")
      ) {
        result = {
          status: "gap",
          reason: "corepack-download-bypasses-registry",
        };
      } else if (!state) {
        result = { status: "gap", reason: "no-active-setup" };
      } else if (state.status === "unresolved" || state.status === "gap") {
        result = state;
      } else if (
        operation.manager === "bun" &&
        setup?.configureBun !== "true"
      ) {
        result = {
          status: setup?.configureBun === "false" ? "gap" : "unresolved",
          reason: "bun-configuration-missing-or-unresolved",
        };
      } else {
        result = state;
      }
      downloads.push({
        operation: index + 1,
        step: operation.step,
        manager: operation.manager,
        ...result,
      });
    }
    if (operation.registryMutating) {
      state = uncertain
        ? { status: "unresolved", reason: "uncertain-registry-mutation" }
        : { status: "gap", reason: "registry-override" };
      setup = undefined;
    }
    const unknown = operation.kind.startsWith("unknown");
    if (unknown || uncertain)
      notes.add(
        unknown ? "opaque-execution" : "conditional-or-uncertain-operation",
      );
    const validInterval = ["covered", "fork-exception"].includes(state?.status);
    const scriptRole =
      operation.integrationScript &&
      validInterval &&
      !uncertainContext &&
      !uncertain &&
      !opaque;
    if (installationCapable(operation)) {
      potentialInstall = true;
      if (!validInterval || uncertainContext || uncertain || opaque)
        unresolvedEarlyInstall = true;
    }
    if (scriptRole) notes.add("package-script-role-not-routing-invalidation");
    if (operation.integrationExecutor) notes.add("executor-code-unverified");
    if (
      (unknown &&
        !operation.integrationToolchain &&
        !operation.integrationTransparent &&
        !scriptRole) ||
      (uncertain && operation.kind !== "js-public-download")
    )
      opaque = true;
  }
  const statuses = new Set(downloads.map((download) => download.status));
  if (unresolvedEarlyInstall) notes.add("unresolved-install-path-before-setup");
  const disposition = statuses.has("gap")
    ? "needs-sfw"
    : statuses.has("unresolved") || unresolvedEarlyInstall || malformed
      ? "needs-review"
      : downloads.length
        ? "integrated"
        : potentialInstall
          ? "needs-review"
          : "no-js-ci";
  return {
    disposition,
    downloads,
    notes: [...notes].sort(),
    runtimeVerification: "not-performed",
  };
}

export function integrationDisposition(workflows) {
  const dispositions = new Set(
    workflows.flatMap((workflow) => [
      ...(workflow.parseError !== undefined ? ["needs-review"] : []),
      ...workflow.jobs.map(
        (job) => job.integration?.disposition ?? "needs-review",
      ),
    ]),
  );
  for (const disposition of ["needs-sfw", "needs-review", "integrated"]) {
    if (dispositions.has(disposition)) return disposition;
  }
  return workflows.length ? "no-js-ci" : "no-ci";
}
