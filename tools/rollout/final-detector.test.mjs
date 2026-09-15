import assert from "node:assert/strict";
import test from "node:test";
import { classifyJob } from "./classify.mjs";
import { shellCommands, shellTokens } from "./commands.mjs";
import { APPROVED_RELEASE_SHA } from "./constants.mjs";

const setup = {
  uses: `workos/setup-socket-firewall@${APPROVED_RELEASE_SHA}`,
  with: {
    token: "${{ secrets.SOCKET_FIREWALL_TOKEN }}",
    "configure-bun": true,
  },
};
const inspect = (steps, extra = {}) =>
  classifyJob("test", { steps, ...extra }, { visibility: "private" });
const offline = `if ! bun install --help | grep -F -- '--offline ' >/dev/null; then
  echo 'Offline support is required.' >&2
  exit 1
fi
bun install --lockfile-only --offline --ignore-scripts --registry=https://registry.npmjs.org/`;

test("Bun offline canonicalization requires its adjacent fail-closed capability guard", () => {
  const result = inspect([
    setup,
    { run: "bun install --frozen-lockfile" },
    { run: offline },
  ]);
  assert.equal(result.integration.disposition, "integrated");
  assert.equal(result.integration.downloads.length, 1);
  assert.equal(result.status, "unknown");
  assert.equal(inspect([{ run: offline }]).integration.disposition, "no-js-ci");
  for (const run of [
    offline.split("\n").at(-1),
    offline.replace("exit 1", "exit 0"),
    offline.replace("--offline --ignore-scripts", "--offline"),
    offline.replace("fi\nbun", "fi\nexport PATH=/elsewhere\nbun"),
    offline.replace("--offline '", "--offline'"),
    offline.replace("'Offline support is required.'", '"$(npm ci)"'),
  ]) {
    assert.notEqual(
      inspect([setup, { run }]).integration.disposition,
      "integrated",
      run,
    );
  }
  assert.notEqual(
    inspect([setup, { run: offline, env: { PATH: "/elsewhere" } }]).integration
      .disposition,
    "integrated",
  );
  assert.notEqual(
    inspect([setup, { run: offline }], { env: { PATH: "/elsewhere" } })
      .integration.disposition,
    "integrated",
  );
  assert.notEqual(
    inspect([setup, { run: offline, shell: "python" }]).integration.disposition,
    "integrated",
  );
  assert.equal(
    inspect([
      setup,
      { run: offline + "\nexport PATH=/other\n" + offline.split("\n").at(-1) },
    ]).integration.downloads.length,
    1,
  );
});

test("substitution budget is per command, not every independent read in a job", () => {
  const run = Array.from(
    { length: 30 },
    (_, i) => `value${i}=$(printf value)`,
  ).join("\n");
  assert.equal(shellCommands(run).limit, false);
  assert.equal(inspect([{ run }]).integration.disposition, "no-js-ci");
  // A single command exceeding the bound must not hide its last substitution.
  const many = `echo ${"$(printf value) ".repeat(20)}$(npm ci)`;
  assert.equal(shellTokens(many).limit, true);
  assert.equal(
    inspect([setup, { run: many }]).integration.disposition,
    "needs-review",
  );
});

test("quoted heredoc bodies are data, including quotes and apparent installers", () => {
  for (const delimiter of ["'EOF'", '"EOF"']) {
    const run = `prompt=$(cat <<${delimiter}\nIt's a prompt: npm ci\n$(npm install fake)\n\`bun install\`\n((((\nEOF\n)\necho "$prompt"`;
    assert.equal(shellCommands(run).lexError, false);
    assert.equal(inspect([{ run }]).integration.disposition, "no-js-ci");
    assert.equal(
      inspect([{ run: run + "\nnpm ci" }]).integration.disposition,
      "needs-review",
    );
    assert.equal(
      inspect([setup, { run: run + "\nnpm ci" }]).integration.downloads.length,
      1,
    );
  }
  assert.equal(
    inspect([{ run: "cat <<-'EOF'\n\tnpm ci\n\tEOF\n" }]).integration
      .disposition,
    "no-js-ci",
  );
  for (const run of [
    "cat <<'EOF'\nunclosed",
    "cat <<'EOF'\n${{ inputs.untrusted }}\nEOF",
    "cat <<EOF\n$(npm ci)\nEOF",
    "bash <<'EOF'\nnpm ci\nEOF",
    "cat <<'EOF' | bash\nnpm ci\nEOF",
  ])
    assert.notEqual(
      inspect([setup, { run }]).integration.disposition,
      "no-js-ci",
    );
});
