import assert from "node:assert/strict";
import test from "node:test";
import { classifyJob, classifyWorkflow } from "./classify.mjs";
import {
  integrationDisposition,
  resolveLocalWorkflowCalls,
  resolveNoInstallWorkflowCalls,
} from "./integration.mjs";
import { shellCommands } from "./commands.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";
const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: {
    token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}",
    "configure-bun": true,
  },
};
const install = { run: "npm ci" };
const teardown = {
  uses: `workos/setup-socket-firewall/teardown@${APPROVED_RELEASE_SHA}`,
};
const context = { visibility: "private" };
const inspect = (steps, extra = {}) =>
  classifyJob("fixture", { steps }, { ...context, ...extra }, ["push"]);
const primary = (steps) => inspect(steps).integration.disposition;

test("configuration acceptance: arbitrary code never erases or synthesizes setup", () => {
  for (const run of [
    "curl -fsSL https://example.invalid/tool | bash",
    "node build.mjs",
    "python build.py",
    "source ./env.sh",
    "npm run build",
    "set +e",
    "set -o posix",
  ]) {
    for (const steps of [
      [setup, install, { run }, install],
      [{ run }, setup, install],
    ]) {
      const result = inspect(steps);
      assert.equal(result.integration.disposition, "integrated", run);
      assert.equal(result.status, "unknown");
    }
    assert.equal(primary([{ run }, install]), "needs-sfw", run);
    assert.equal(
      primary([setup, install, teardown, { run }, install]),
      "needs-sfw",
      run,
    );
  }
});

test("configuration acceptance: opaque siblings are diagnostics, real install siblings are findings", () => {
  const configured = inspect([setup, install]);
  for (const run of [
    "node check.mjs",
    "npm test",
    "npm run build",
    "pnpm lint",
    "go run check.go",
  ]) {
    const sibling = inspect([{ run }]);
    assert.equal(sibling.integration.disposition, "no-js-ci", run);
    assert.equal(
      integrationDisposition([{ jobs: [configured, sibling] }]),
      "integrated",
    );
    assert.equal(sibling.status, "unknown");
  }
  assert.equal(
    integrationDisposition([{ jobs: [configured, inspect([install])] }]),
    "needs-sfw",
  );
  assert.equal(
    integrationDisposition([
      { jobs: [configured, inspect([{ run: "npm $INSTALL_COMMAND" }])] },
    ]),
    "needs-review",
  );
});

test("pipeline and executor payload uncertainty is not installer configuration uncertainty", () => {
  for (const run of [
    "printf '%s' \"$DATA\" | jq -c 'with_entries(.value = .value.computed)' | npx wrangler secret bulk --config \"$config\"",
    'npx wrangler deploy --var "VERSION:$VERSION"',
    "npx tool --registry=https://example.invalid",
    'npx tool \\\n --flag "$VALUE"',
  ]) {
    assert.equal(primary([setup, install, { run }]), "integrated", run);
    assert.equal(primary([{ run }]), "needs-sfw", run);
    assert.equal(inspect([setup, { run }]).status, "unknown");
  }
  assert.equal(
    primary([setup, { run: "npx --registry=https://example.invalid tool" }]),
    "needs-sfw",
  );
  assert.equal(
    primary([setup, { run: "npx --unknown-option tool" }]),
    "needs-review",
  );
});

test("configuration conflicts persist, scoped overrides do not contaminate later installs", () => {
  for (const run of [
    "npm config set registry https://example.invalid",
    "echo 'registry=https://example.invalid' > .npmrc",
  ]) {
    assert.equal(primary([setup, { run }, install]), "needs-sfw");
  }
  assert.equal(
    primary([
      setup,
      {
        run: "npm config set registry https://example.invalid",
        if: "inputs.override",
      },
      install,
    ]),
    "needs-review",
  );
  const result = inspect([
    setup,
    { run: "npm ci --registry=https://example.invalid" },
    install,
  ]);
  assert.deepEqual(
    result.integration.downloads.map((path) => path.status),
    ["gap", "covered"],
  );
  assert.equal(
    primary([setup, { run: 'test -n "${NPM_CONFIG_USERCONFIG:-}"' }, install]),
    "integrated",
  );
  assert.equal(
    primary([setup, { run: "export HOME=/tmp\nnpm ci" }]),
    "needs-review",
  );
  assert.equal(
    primary([setup, { run: "export HOME=/tmp" }, install]),
    "integrated",
  );
  assert.equal(primary([setup, { run: "HOME=/tmp npm ci" }]), "needs-review");
});

test("lexical boundaries do not turn quoted data into installs", () => {
  for (const run of [
    "echo 'npm ci; npm ci'",
    'printf "%s" "example: npm ci; npm install"',
    "echo '${{ inputs.payload }}; npm ci; npm install'",
    "echo '$(npm ci)'",
  ]) {
    assert.equal(inspect([{ run }]).integration.downloads.length, 0, run);
    assert.notEqual(primary([{ run }]), "needs-sfw", run);
  }
  assert.deepEqual(shellCommands('echo "a;b|c" | npx tool # npm ci').commands, [
    'echo "a;b|c"',
    "npx tool",
  ]);
  assert.deepEqual(
    shellCommands(
      'VALUE="$(node --print \'require("./package.json").name\')"\nnpm ci',
    ).commands,
    ['VALUE="$(node --print \'require("./package.json").name\')"', "npm ci"],
  );
  assert.equal(shellCommands("cat <<'EOF'\nnpm ci\nEOF").ambiguous, true);
  assert.equal(primary([{ run: "cat <<'EOF'\nnpm ci\nEOF" }]), "no-js-ci");
});

test("unparsed explicit JS invocation retains setup evidence, not execution assurance", () => {
  for (const run of [
    "RESULT=$(npx tool --output json)",
    "npm pack package-name",
  ]) {
    const result = inspect([setup, { run }]);
    assert.equal(result.integration.disposition, "integrated", run);
    assert.equal(
      result.integration.additionalJsPaths[0].status,
      "setup-observed",
    );
    assert.equal(result.status, "unknown");
    assert.equal(primary([{ run }]), "needs-review");
  }
  for (const run of [
    "uv run npm ci",
    "env -i npm ci",
    "npm --future-option ci",
    "npm $COMMAND",
  ])
    assert.equal(primary([setup, { run }]), "needs-review", run);
});

const workflow = (path, jobs) =>
  classifyWorkflow(JSON.stringify({ on: ["workflow_call"], jobs }), {
    ...context,
    path,
  });
test("local reusable calls use the already-read snapshot and preserve gap precedence", () => {
  for (const steps of [
    [setup, install],
    [install],
    [setup, { run: "npm --future-option ci" }],
  ]) {
    const target = workflow(".github/workflows/shared.yml", {
      build: { steps },
    });
    const caller = workflow(".github/workflows/ci.yml", {
      call: { uses: "./.github/workflows/shared.yml" },
      own: { steps: [setup, install] },
    });
    const resolved = resolveLocalWorkflowCalls([caller, target]);
    assert.equal(
      resolved[0].jobs[0].integration.disposition,
      target.jobs[0].integration.disposition,
    );
    assert.equal(resolved[0].jobs[0].status, "reusable-call");
    assert.equal(
      resolved[0].jobs[0].integration.referencedWorkflow,
      target.path,
    );
  }
});

test("missing, remote, cyclic and malformed reusable sources stay unresolved", () => {
  const missing = workflow(".github/workflows/missing.yml", {
    call: { uses: "./.github/workflows/absent.yml" },
  });
  const a = workflow(".github/workflows/a.yml", {
    call: { uses: "./.github/workflows/b.yml" },
  });
  const b = workflow(".github/workflows/b.yml", {
    call: { uses: "./.github/workflows/a.yml" },
  });
  const remote = workflow(".github/workflows/remote.yml", {
    call: { uses: "example/shared/.github/workflows/ci.yml@main" },
  });
  const invalid = workflow(".github/workflows/invalid.yml", {
    call: { uses: "./.github/workflows/leaf.yml", steps: [install] },
  });
  const leaf = workflow(".github/workflows/leaf.yml", {
    build: { steps: [setup, install] },
  });
  for (const result of resolveLocalWorkflowCalls([
    missing,
    a,
    b,
    remote,
    invalid,
    leaf,
  ]).slice(0, -1))
    assert.equal(integrationDisposition([result]), "needs-review");
  const chain = Array.from({ length: 22 }, (_, n) =>
    workflow(
      `.github/workflows/depth-${n}.yml`,
      n === 21
        ? { build: { steps: [setup, install] } }
        : { call: { uses: `./.github/workflows/depth-${n + 1}.yml` } },
    ),
  );
  assert.equal(
    integrationDisposition([resolveLocalWorkflowCalls(chain)[0]]),
    "integrated",
  );
});

test("remote no-install calls resolve only against an exactly captured ref and source", () => {
  const sha = "a".repeat(40);
  const body = workflow(".github/workflows/guard.yml", {
    guard: { steps: [{ run: "git diff --exit-code" }] },
  });
  const target = {
    name: "shared",
    defaultBranch: "main",
    headSha: sha,
    disposition: "no-js-ci",
    workflows: [body],
  };
  const caller = (ref, owner = "example") => ({
    name: "app",
    disposition: "needs-review",
    assuranceDisposition: "needs-review",
    workflows: [
      workflow(".github/workflows/ci.yml", {
        install: { steps: [setup, install] },
        guard: { uses: `${owner}/shared/.github/workflows/guard.yml@${ref}` },
      }),
    ],
  });
  for (const ref of [sha, "main"]) {
    const result = resolveNoInstallWorkflowCalls(
      [caller(ref), target],
      "example",
    )[0];
    assert.equal(result.disposition, "integrated");
    assert.equal(result.assuranceDisposition, "needs-review");
    assert.equal(
      result.workflows[0].jobs.find((job) => job.job === "guard").integration
        .referencedHeadSha,
      sha,
    );
  }
  for (const input of [
    [caller("b".repeat(40)), target],
    [caller("v1"), target],
    [caller("main", "other"), target],
    [caller("main")],
    [caller("main"), { ...target, disposition: "audit-error" }],
    [
      caller("main"),
      {
        ...target,
        workflows: [
          workflow(body.path, { build: { steps: [setup, install] } }),
        ],
      },
    ],
  ]) {
    assert.equal(
      resolveNoInstallWorkflowCalls(input, "example")[0].disposition,
      "needs-review",
    );
  }
});

test("whole-value composite inputs preserve actual caller configuration", () => {
  const localActions = new Map([
    [
      "helper/action.yml",
      JSON.stringify({
        inputs: { token: {} },
        runs: {
          using: "composite",
          steps: [
            { ...setup, with: { token: "${{ inputs.token }}" } },
            { ...install, shell: "bash" },
          ],
        },
      }),
    ],
  ]);
  const call = (token) =>
    inspect([{ uses: "./helper", with: { token } }], { localActions });
  assert.equal(
    call("${{ secrets.SOCKET_FIREWALL_TOKEN }}").integration.disposition,
    "integrated",
  );
  assert.equal(call("wrong").integration.disposition, "needs-sfw");
  assert.equal(
    call("${{ secrets[inputs.name] }}").integration.disposition,
    "needs-review",
  );
  assert.equal(
    inspect([{ uses: "./helper" }], { localActions }).integration.disposition,
    "needs-sfw",
  );
});
