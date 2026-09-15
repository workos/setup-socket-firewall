import { APPROVED_RELEASE_SHA } from "./constants.mjs";

// Configuration/executable/startup controls, not application credentials.
const RELEVANT_ENV =
  /^(?:(?:npm|pnpm|bun|yarn|corepack)_|HOME$|GITHUB_ENV$|GITHUB_PATH$|SFW_BUN_CONFIG_PATH$|USERPROFILE$|XDG_|APPDATA$|LOCALAPPDATA$|PATH$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SHELL$|SHELLOPTS$|BASHOPTS$|CDPATH$|LD_|DYLD_|BASH_FUNC_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$)/i;
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

export function literalWorkingDirectory(value) {
  return (
    typeof value === "string" &&
    /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\/?$/.test(value) &&
    !value.split("/").includes("..")
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
    Object.entries(defaults.run).some(([key, value]) =>
      key === "working-directory"
        ? !literalWorkingDirectory(value)
        : key !== "shell" || !["bash", "sh"].includes(value),
    )
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

// Unknown execution is not evidence of a JS dependency install. Retain review
// candidates only where source actually invokes a JS package tool, including
// unsupported wrappers/options. Do not guess from script names or executables.
export function unresolvedJsInvocation(operation) {
  if (operation.explicitJsInvocation) return true;
  if (
    operation.corepackControl ||
    operation.integrationLiteral ||
    operation.kind !== "unknown-wrapper"
  )
    return false;
  if (operation.manager) return true;
  const command = operation.command ?? "";
  const install =
    /(?:^|[\s/("'`])(?:(?:npm|pnpm|bun|yarn)\s+(?:ci|install|i|add|fetch|dlx|pack|update|upgrade|config\s+(?:set|delete|unset))\b|(?:npx|bunx)\s)/;
  return (
    install.test(command) &&
    (/^(?:env|sudo|command|time|exec|bash|sh|zsh|uv|poetry|go)\b/.test(
      command,
    ) ||
      /^(?![A-Za-z_][A-Za-z0-9_]*=)[^\s=]+=/.test(command) ||
      /^(?:\.?\.?\/|\/)[^\s]*\/(?:npm|pnpm|npx|bun|bunx|yarn|corepack)\b/.test(
        command,
      ))
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
  const additionalJsPaths = [];
  const notes = new Set();
  const expectedToken = `\${{secrets.${context.visibility === "public" ? "PUBLIC_SOCKET_FIREWALL_TOKEN" : "SOCKET_FIREWALL_TOKEN"}}}`;
  let setup;
  let state;
  let bunState;
  let corepack = "disabled";
  let environmentGroup;
  let persistentEnvironmentUncertain = false;
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
    const uncertain =
      operation.integrationConfigurationUncertain ??
      operation.integrationUncertain ??
      operation.uncertain;
    const currentState =
      operation.manager === "bun" && bunState ? bunState : state;
    const validInterval = ["covered", "fork-exception"].includes(
      currentState?.status,
    );
    if (operation.stepEnvironmentUncertain)
      environmentGroup = operation.commandGroup;
    if (operation.environmentPersisting) persistentEnvironmentUncertain = true;
    const uncertainStepEnvironment =
      persistentEnvironmentUncertain ||
      (environmentGroup !== undefined &&
        environmentGroup === operation.commandGroup);
    if (operation.corepackControl || operation.integrationCorepackUncertain)
      corepack = "unresolved";
    if (["enable", "disable"].includes(operation.corepack))
      corepack = uncertain
        ? "unresolved"
        : operation.corepack === "enable"
          ? "enabled"
          : "disabled";
    if (operation.kind === "sfw-setup") {
      setup = operation;
      if (operation.configureBun === "true") bunState = undefined;
      // The pinned action validates the value and independently restricts
      // fallback to public external-fork PRs. An expression cannot widen that.
      const publicForkFallback =
        context.visibility === "public" &&
        (operation.fallback === "true" ||
          /^\$\{\{.+\}\}$/.test(operation.fallback));
      if (
        uncertain ||
        (!publicForkFallback && !["false", "true"].includes(operation.fallback))
      ) {
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
          status: publicForkFallback ? "fork-exception" : "covered",
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
      bunState = undefined;
      continue;
    }
    if (
      operation.kind === "js-public-download" ||
      operation.kind === "yarn-blocked"
    ) {
      let result;
      if (
        uncertainContext ||
        uncertainStepEnvironment ||
        uncertain ||
        (operation.integrationSyntaxUncertain && !validInterval)
      ) {
        result = {
          status: "unresolved",
          reason:
            uncertainContext || uncertainStepEnvironment
              ? "install-execution-context"
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
      } else if (!currentState) {
        result = { status: "gap", reason: "no-active-setup" };
      } else if (
        currentState.status === "unresolved" ||
        currentState.status === "gap"
      ) {
        result = currentState;
      } else if (
        operation.manager === "bun" &&
        setup?.configureBun !== "true"
      ) {
        result = {
          status: setup?.configureBun === "false" ? "gap" : "unresolved",
          reason: "bun-configuration-missing-or-unresolved",
        };
      } else {
        result = currentState;
      }
      downloads.push({
        operation: index + 1,
        step: operation.step,
        manager: operation.manager,
        ...result,
      });
    }
    if (operation.registryPersisting) {
      const changed = uncertain
        ? { status: "unresolved", reason: "uncertain-registry-mutation" }
        : { status: "gap", reason: "registry-override" };
      if (operation.registryManager === "bun") bunState = changed;
      else {
        state = changed;
        setup = undefined;
      }
    }
    const unknown = operation.kind.startsWith("unknown");
    if (unknown || uncertain)
      notes.add(
        unknown ? "opaque-execution" : "conditional-or-uncertain-operation",
      );
    if (operation.integrationScript) {
      notes.add("package-script-code-unverified");
    }
    if (
      operation.explicitJsInvocation ||
      (!operation.integrationScript &&
        unresolvedJsInvocation(operation) &&
        !operation.registryPersisting)
    ) {
      const managers = new Set([
        ...(operation.integrationScript ? [] : [operation.manager]),
        ...(operation.integrationManagers ?? []),
      ]);
      const managerUncertain =
        !["npm", "pnpm", "bun", "yarn"].some((manager) =>
          managers.has(manager),
        ) ||
        operation.integrationCorepackDownload ||
        managers.has("yarn") ||
        (managers.has("pnpm") && corepack !== "disabled") ||
        (managers.has("bun") &&
          (setup?.configureBun !== "true" ||
            (bunState &&
              !["covered", "fork-exception"].includes(bunState.status))));
      additionalJsPaths.push({
        operation: index + 1,
        step: operation.step,
        status:
          validInterval &&
          !managerUncertain &&
          !operation.registryMutating &&
          !uncertainContext &&
          !uncertainStepEnvironment &&
          !uncertain
            ? "setup-observed"
            : "unresolved",
        reason: "unparsed-js-invocation",
      });
    }
    // No opacity latch: arbitrary code may do anything at runtime, but that
    // cannot erase or synthesize the configuration observed in this workflow.
    if (operation.integrationExecutor) notes.add("executor-code-unverified");
  }
  const statuses = new Set(downloads.map((download) => download.status));
  const disposition = statuses.has("gap")
    ? "needs-sfw"
    : statuses.has("unresolved") ||
        additionalJsPaths.some((path) => path.status === "unresolved") ||
        malformed
      ? "needs-review"
      : downloads.length ||
          additionalJsPaths.some((path) => path.status === "setup-observed")
        ? "integrated"
        : "no-js-ci";
  return {
    disposition,
    downloads,
    additionalJsPaths,
    notes: [...notes].sort(),
    runtimeVerification: "not-performed",
  };
}

// Local reusable workflows are already read at this repository's captured SHA.
// Reuse their primary result rather than treating the call itself as opaque.
// Expressions inside the callee remain unresolved; this does not evaluate inputs
// or forward credentials. Missing files and cycles stay review. Acquisition
// bounds this graph to 200 workflow files; no new source is fetched here.
export function resolveLocalWorkflowCalls(workflows) {
  const byPath = new Map(
    workflows.map((workflow) => [workflow.path, workflow]),
  );
  const resolved = new Map();
  function visit(path, stack = new Set()) {
    if (stack.has(path) || !byPath.has(path)) return undefined;
    if (resolved.has(path)) return resolved.get(path);
    const workflow = byPath.get(path);
    const result = {
      ...workflow,
      jobs: workflow.jobs.map((job) => {
        const call = job.operations.find(
          (operation) => operation.kind === "reusable-call",
        );
        if (!call?.uses.startsWith("./")) return job;
        const target = call.uses.slice(2);
        const callee = visit(target, new Set([...stack, path]));
        if (!callee) return job;
        return {
          ...job,
          integration: {
            ...job.integration,
            disposition: integrationDisposition([callee]),
            referencedWorkflow: target,
            notes: ["local-workflow-analyzed-at-snapshot"],
          },
        };
      }),
    };
    resolved.set(path, result);
    return result;
  }
  return workflows.map((workflow) => visit(workflow.path));
}

// Reuse already-captured remote source only when it has no observed JS install
// paths. A callee with installs needs caller-specific inputs/secrets/visibility;
// its coverage cannot simply be copied across repositories. Never substitute a
// default-branch body for a different pinned ref, tag, owner or unread source.
export function resolveNoInstallWorkflowCalls(repositories, organization) {
  const byName = new Map(
    repositories.map((repository) => [repository.name, repository]),
  );
  return repositories.map((repository) => {
    if (["audit-error", "empty", "no-ci"].includes(repository.disposition))
      return repository;
    const workflows = repository.workflows.map((workflow) => ({
      ...workflow,
      jobs: workflow.jobs.map((job) => {
        const call = job.operations.find(
          (operation) => operation.kind === "reusable-call",
        );
        const match = call?.uses.match(
          /^([^/]+)\/([^/]+)\/(\.github\/workflows\/[^/@]+\.ya?ml)@(.+)$/,
        );
        if (!match || match[1] !== organization) return job;
        const target = byName.get(match[2]);
        if (
          !target?.headSha ||
          target.disposition === "audit-error" ||
          ![target.headSha, target.defaultBranch].includes(match[4])
        )
          return job;
        const callee = target.workflows.find(
          (candidate) => candidate.path === match[3],
        );
        if (!callee || integrationDisposition([callee]) !== "no-js-ci")
          return job;
        return {
          ...job,
          integration: {
            ...job.integration,
            disposition: "no-js-ci",
            referencedRepository: target.name,
            referencedWorkflow: callee.path,
            referencedHeadSha: target.headSha,
            notes: ["referenced-snapshot-has-no-observed-js-install"],
          },
        };
      }),
    }));
    return {
      ...repository,
      workflows,
      disposition: integrationDisposition(workflows),
    };
  });
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
