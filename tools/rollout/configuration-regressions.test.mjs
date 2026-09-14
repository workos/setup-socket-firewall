import assert from "node:assert/strict";
import test from "node:test";
import { classifyJob } from "./classify.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";
const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: {
    token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}",
    "configure-bun": true,
  },
};
const install = { run: "npm ci" };
const inspect = (steps, extra = {}, job = {}) =>
  classifyJob(
    "fixture",
    { steps, ...job },
    { visibility: "private", ...extra },
    ["push"],
  );
const primary = (steps) => inspect(steps).integration.disposition;

test("quoted assignments and config text never fabricate installs or mutations", () => {
  for (const run of [
    'NOTE="example npm ci "',
    "NOTE='example npm ci '",
    "NOTE=${VALUE:-example npm ci }",
    "NOTE=$(printf '%s' 'npm ci')",
    "VERSION=$(bun --version)",
    "printf '%s' 'npm config set registry https://example.invalid'",
    "printf '%s' 'HOME=/tmp > $GITHUB_ENV'",
    "printf '%s' 'registry=https://example.invalid' '>' '.npmrc'",
    "printf '%s' 'HOME=/tmp' '>' '$GITHUB_ENV'",
    "echo 'HOME=/tmp' > '$GITHUB_ENV'",
  ]) {
    assert.equal(primary([{ run }]), "no-js-ci", run);
    assert.equal(primary([setup, { run }, install]), "integrated", run);
  }
  assert.equal(
    primary([
      setup,
      { run: "npx tool 'npm config set registry https://example.invalid'" },
      install,
    ]),
    "integrated",
  );
  assert.equal(
    primary([
      setup,
      { run: "RESULT=$(npx tool --registry=https://example.invalid)" },
      install,
    ]),
    "integrated",
  );
});

test("transient overrides on unparsed and nested JS installers remain findings", () => {
  for (const run of [
    "npm --registry=https://example.invalid ci",
    "pnpm --registry=https://example.invalid install",
    "RESULT=$(npm --registry=https://example.invalid ci)",
    "RESULT=$(env -i npm ci)",
    "RESULT=$(HOME=/tmp npm ci)",
  ]) {
    const result = inspect([setup, install, { run }, install]);
    assert.equal(result.integration.disposition, "needs-review", run);
    assert.equal(result.integration.downloads.at(-1).status, "covered");
  }
});

test("standalone relevant assignments affect the same run, not later run blocks", () => {
  for (const key of [
    "HOME",
    "NPM_CONFIG_REGISTRY",
    "NPM_CONFIG_USERCONFIG",
    "PATH",
  ]) {
    assert.equal(
      primary([setup, { run: `${key}=/tmp\nnpm ci` }]),
      "needs-review",
      key,
    );
    assert.equal(
      primary([setup, { run: `${key}=/tmp` }, install]),
      "integrated",
      key,
    );
  }
  assert.equal(
    primary([setup, { run: 'NOTE="HOME=/tmp"\nnpm ci' }]),
    "integrated",
  );
  assert.equal(
    primary([setup, { run: 'export NOTE="HOME=/tmp"\nnpm ci' }]),
    "integrated",
  );
});

test("explicit persistent environment-file changes reach later installs", () => {
  for (const run of [
    'echo "HOME=/tmp" >> "$GITHUB_ENV"',
    'echo "NPM_CONFIG_USERCONFIG=/tmp/other" >> "${GITHUB_ENV:?}"',
    'echo "/tmp/bin" >> "$GITHUB_PATH"',
    'RESULT=$(echo "HOME=/tmp" >> "$GITHUB_ENV")',
  ])
    assert.equal(primary([setup, { run }, install]), "needs-review", run);
  assert.equal(
    primary([
      setup,
      { run: 'echo "APP_MODE=production" >> "$GITHUB_ENV"' },
      install,
    ]),
    "integrated",
  );
  assert.equal(
    primary([setup, { run: 'cat "$GITHUB_ENV"' }, install]),
    "integrated",
  );
  assert.equal(
    inspect(
      [setup, install],
      {},
      { env: { GITHUB_ENV: "/tmp/not-the-runner-env" } },
    ).integration.disposition,
    "needs-review",
  );
});

test("package-manager and file registry writes remain configuration conflicts", () => {
  for (const run of [
    "pnpm config set @example:registry https://example.invalid",
    "npm config set registry https://example.invalid",
  ])
    assert.equal(primary([setup, { run }, install]), "needs-sfw", run);
  for (const run of [
    "echo 'registry=https://example.invalid' | tee .npmrc",
    'tee "$NPM_CONFIG_USERCONFIG" < input.txt',
    "RESULT=$(npm config set registry https://example.invalid)",
    "npm config set registry $REGISTRY",
    "npm config set $KEY $VALUE",
  ])
    assert.equal(primary([setup, { run }, install]), "needs-review", run);
  const bunWrite = {
    run: "printf \"[install]\\nregistry='https://example.invalid'\\n\" > bunfig.toml",
  };
  assert.notEqual(
    primary([setup, bunWrite, { run: "bun install" }]),
    "integrated",
  );
  assert.equal(primary([setup, bunWrite, install]), "integrated");
});

test("explicit config-file mutations are distinct from reading or copying a source", () => {
  for (const run of [
    'rm "$NPM_CONFIG_USERCONFIG"',
    "mv .npmrc old-config",
    "sed -i 's/registry/other/' .npmrc",
    'cp input.txt "$NPM_CONFIG_USERCONFIG"',
  ])
    assert.equal(primary([setup, { run }, install]), "needs-review", run);
  for (const run of [
    'cat "$NPM_CONFIG_USERCONFIG"',
    'cp "$NPM_CONFIG_USERCONFIG" artifact.txt',
  ])
    assert.equal(primary([setup, { run }, install]), "integrated", run);
});

test("composite condition references are not replaced with a different expression type", () => {
  const localActions = new Map([
    [
      "helper/action.yml",
      JSON.stringify({
        inputs: { enabled: { default: "false" } },
        runs: {
          using: "composite",
          steps: [
            { if: "${{ inputs.enabled }}", run: "npm ci", shell: "bash" },
          ],
        },
      }),
    ],
  ]);
  // Composite inputs are strings: the nonempty string "false" is not the
  // literal boolean expression false. The install must not disappear.
  const result = inspect([{ uses: "./helper" }], { localActions });
  assert.notEqual(result.integration.disposition, "no-js-ci");
  assert.equal(result.integration.downloads.length, 1);
});

test("the action-exported Bun config path is recognized without trusting overrides", () => {
  for (const flag of [
    '--config="${SFW_BUN_CONFIG_PATH:?}"',
    '--config "$SFW_BUN_CONFIG_PATH"',
    "--config=$SFW_BUN_CONFIG_PATH",
  ]) {
    const run = `bun install --frozen-lockfile ${flag}`;
    assert.equal(primary([setup, { run }]), "integrated");
    assert.equal(
      primary([
        { ...setup, with: { ...setup.with, "configure-bun": false } },
        { run },
      ]),
      "needs-sfw",
    );
    assert.equal(
      primary([setup, { run, env: { SFW_BUN_CONFIG_PATH: "/tmp/other" } }]),
      "needs-review",
    );
  }
  for (const flag of [
    "--config='$SFW_BUN_CONFIG_PATH'",
    '--config="${SFW_BUN_CONFIG_PATH:-other}"',
    "--config=./custom.toml",
  ])
    assert.equal(
      primary([setup, { run: `bun install ${flag}` }]),
      "needs-review",
    );
});

test("nested JS paths retain manager-specific configuration requirements", () => {
  const npmOnly = { ...setup, with: { ...setup.with, "configure-bun": false } };
  for (const run of ["RESULT=$(bun install)", "RESULT=$(uv run bun install)"])
    assert.equal(primary([npmOnly, { run }]), "needs-review");
  assert.equal(
    primary([npmOnly, { run: "RESULT=$(npx tool --argument bun)" }]),
    "integrated",
  );
  assert.equal(
    primary([setup, { run: "RESULT=$(yarn install)" }]),
    "needs-review",
  );
  assert.equal(
    primary([
      { run: "corepack enable" },
      setup,
      { run: "RESULT=$(pnpm install)" },
    ]),
    "needs-review",
  );
  assert.equal(
    primary([setup, { run: "RESULT=$(corepack prepare pnpm@10)" }]),
    "needs-review",
  );
  assert.equal(
    primary([
      setup,
      { run: "RESULT=$(corepack enable)" },
      { run: "pnpm install" },
    ]),
    "needs-review",
  );
});

test("explicit nested installs survive outer script and mutation roles", () => {
  for (const run of [
    'npm run build "$(npm ci)"',
    "RESULT=$(npm ci; npm config set registry https://example.invalid)",
  ]) {
    assert.equal(primary([{ run }]), "needs-review");
    assert.equal(primary([{ run }, setup, install]), "needs-review");
  }
  assert.equal(
    primary([setup, { run: 'npm run build "$(npm ci)"' }]),
    "integrated",
  );
  assert.equal(
    primary([{ run: 'npm run build "$(printf npm)"' }, setup, install]),
    "integrated",
  );
});

test("configuration-file mutations remain visible inside substitutions", () => {
  for (const run of [
    'RESULT=$(echo "@example:registry=https://example.invalid" > .npmrc)',
    'RESULT=$(rm "$NPM_CONFIG_USERCONFIG")',
    "RESULT=$(tee .npmrc < input.txt)",
  ])
    assert.equal(primary([setup, { run }, install]), "needs-review", run);
  assert.equal(
    primary([
      setup,
      { run: "RESULT=$(printf '%s' 'registry=example' '>' '.npmrc')" },
      install,
    ]),
    "integrated",
  );
});

test("unmodeled direct JS launchers do not inherit guessed configuration", () => {
  for (const run of [
    "uv run bun install",
    "uv run npx --registry=https://example.invalid tool",
    "uv run npm config set registry https://example.invalid",
    'bash -c "bun install"',
  ]) {
    assert.equal(primary([setup, { run }, install]), "needs-review", run);
    assert.equal(
      primary([setup, { run: `RESULT=$(${run})` }, install]),
      "needs-review",
      run,
    );
  }
});

test("literal word quoting and escapes do not hide registry options", () => {
  for (const run of [
    'n"pm" ci --registry=https://example.invalid',
    'npm ci --reg""istry=https://example.invalid',
    String.raw`npm ci \--registry=https://example.invalid`,
  ])
    assert.equal(primary([setup, { run }]), "needs-sfw", run);
  assert.equal(
    primary([setup, { run: "npm ci --registration=unused" }]),
    "needs-review",
  );
  assert.equal(
    primary([
      setup,
      { run: 'npm run build -- --registry=example "$(npm ci)"' },
    ]),
    "integrated",
  );
});

test("line continuations remove the newline without inventing a word boundary", () => {
  assert.equal(primary([{ run: "NOTE=hello\\\nnpm ci" }]), "no-js-ci");
  assert.equal(primary([{ run: "n\\\npm ci" }]), "needs-sfw");
  assert.equal(primary([setup, { run: "n\\\npm ci" }]), "integrated");
  assert.equal(
    primary([setup, { run: "npm ci --reg\\\nistry=https://example.invalid" }]),
    "needs-sfw",
  );
});

test("unresolved lexical structure or a lexical limit cannot disappear after a covered install", () => {
  for (const run of [
    "NOTE='unterminated",
    `NOTE=${"$(".repeat(105)}echo ok${")".repeat(105)}`,
  ]) {
    const result = inspect([setup, install, { run }]);
    assert.equal(result.integration.disposition, "needs-review");
    assert.ok(
      result.operations.some(
        (operation) => operation.sourceError === "unresolved-shell-source",
      ),
    );
  }
});
