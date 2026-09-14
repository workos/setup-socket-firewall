import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { scrubNpmLockfile } from './scrub-npm-lockfile.mjs';

const script = fileURLToPath(new URL('./scrub-lockfile.sh', import.meta.url));
const sfw = 'https://socket-firewall.workos.dev/';
const npm = 'https://registry.npmjs.org/';
const tarball = '@scope/pkg/-/pkg-1.2.3.tgz?download=1#fragment';
const descriptor = { version: '1.2.3', resolved: sfw + tarball, integrity: 'sha512-unchanged' };

for (const version of [1, 2, 3]) {
  test(`npm v${version}: canonical host, nested entries, all other bytes preserved`, () => {
    const lock = { lockfileVersion: version };
    if (version < 3) {
      lock.dependencies = { pkg: { ...descriptor, dependencies: { nested: descriptor } } };
    }
    if (version > 1) {
      lock.packages = { '': { name: 'root' }, 'node_modules/@scope/pkg': descriptor };
    }
    const input = JSON.stringify(lock, null, '\t').replaceAll('\n', '\r\n') + '\r\n';
    const expected = input.replaceAll(sfw, npm);
    const result = scrubNpmLockfile(input);
    assert.equal(result, expected);
    assert.equal(scrubNpmLockfile(result), result);
  });
}

test('only resolved string values change; lookalikes and other URLs remain intact', () => {
  const lock = {
    lockfileVersion: 3,
    resolved: 3,
    packages: {
      one: descriptor,
      two: { resolved: 'https://socket-firewall.workos.dev.evil.test/pkg' },
      three: { resolved: 'https://socket-firewall.workos.dev@evil.test/pkg' },
      four: { resolved: 'https://example.test/' + sfw },
      five: { resolved: 'https://user:secret@socket-firewall.workos.dev/pkg' },
      six: { resolved: npm + tarball },
      seven: { resolved: null },
      eight: { resolved: false },
      nine: { resolved: true },
      ten: { resolved: {} },
    },
    metadata: sfw + 'do-not-edit',
    version: sfw + 'do-not-edit',
    embedded: '\"resolved\": \"' + sfw + tarball + '\"',
  };
  const expected = structuredClone(lock);
  expected.packages.one.resolved = npm + tarball;
  assert.deepEqual(JSON.parse(scrubNpmLockfile(JSON.stringify(lock))), expected);
});

test('escaped resolved keys and escaped URL slashes are decoded safely', () => {
  const input = '{"lockfileVersion":2,"dependencies":{"pkg":{"resol\\u0076ed":"https:\\/\\/socket-firewall.workos.dev\\/pkg\\/-\\/pkg-1.tgz"}}}';
  const result = scrubNpmLockfile(input);
  assert.equal(JSON.parse(result).dependencies.pkg.resolved, npm + 'pkg/-/pkg-1.tgz');
  assert.ok(result.includes('resol\\u0076ed'));
});

test('npm omission-config locks are byte-identical no-ops', () => {
  const input = '{"lockfileVersion":3,"packages":{"node_modules/pkg":{"integrity":"sha512-test"}}}\n';
  assert.equal(scrubNpmLockfile(input), input);
});

for (const input of ['null', '[]', '{}', '{broken', '{"lockfileVersion":4}', '{"lockfileVersion":"3"}', '{"lockfileVersion":3,}']) {
  test(`invalid/unsupported npm input is rejected: ${input}`, () => {
    assert.throws(() => scrubNpmLockfile(input));
  });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sfw-npm-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const output = join(root, 'output');
  writeFileSync(output, '');
  return { root, workspace, output };
}

function run(f, path, mode = 'apply') {
  writeFileSync(f.output, '');
  return spawnSync('bash', [script], {
    env: { ...process.env, GITHUB_WORKSPACE: f.workspace, GITHUB_OUTPUT: f.output, SFW_SCRUB_MODE: mode, SFW_SCRUB_LOCKFILE: path },
    encoding: 'utf8',
  });
}

for (const path of ['package-lock.json', 'npm-shrinkwrap.json', 'nested with spaces/package-lock.json']) {
  test(`shell wrapper: check/apply/no-op, mode preservation and selected file only: ${path}`, (t) => {
    const f = fixture(t);
    const file = join(f.workspace, path);
    mkdirSync(dirname(file), { recursive: true });
    const before = JSON.stringify({ lockfileVersion: 3, packages: { pkg: descriptor } });
    writeFileSync(file, before);
    chmodSync(file, 0o640);
    writeFileSync(join(f.workspace, 'unrelated.txt'), sfw);
    for (const mode of ['check', 'apply', 'apply']) {
      const previous = readFileSync(file, 'utf8');
      const result = run(f, path, mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(f.output, 'utf8'), `changed=${previous.includes(sfw)}\n`);
      assert.equal(readFileSync(file, 'utf8'), mode === 'check' ? before : before.replaceAll(sfw, npm));
      assert.equal(statSync(file).mode & 0o777, 0o640);
      assert.equal(readFileSync(join(f.workspace, 'unrelated.txt'), 'utf8'), sfw);
      assert.ok(!readdirSync(dirname(file)).some((name) => name.includes('.workos-sfw.')));
    }
  });
}

test('malformed npm input fails without changing file or exposing contents', (t) => {
  const f = fixture(t);
  const file = join(f.workspace, 'package-lock.json');
  const secret = 'secret-do-not-log';
  writeFileSync(file, '{"lockfileVersion":3,"resolved":"' + sfw + secret);
  const before = readFileSync(file);
  const result = run(f, 'package-lock.json');
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(readFileSync(f.output, 'utf8'), '');
  assert.ok(!result.stderr.includes(secret));
  assert.deepEqual(readdirSync(f.workspace), ['package-lock.json']);
});

test('unsupported, missing, absolute, traversal and symlink paths cannot modify files', (t) => {
  const f = fixture(t);
  const input = JSON.stringify({ lockfileVersion: 3, resolved: sfw + tarball });
  const external = join(f.root, 'package-lock.json');
  writeFileSync(external, input);
  symlinkSync(external, join(f.workspace, 'npm-shrinkwrap.json'));
  symlinkSync(f.root, join(f.workspace, 'linked'));
  for (const path of ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'missing/package-lock.json', external, '../package-lock.json', 'x/../../package-lock.json', 'linked/package-lock.json', 'npm-shrinkwrap.json']) {
    const result = run(f, path);
    assert.notEqual(result.status, 0, path);
    assert.equal(readFileSync(external, 'utf8'), input);
    assert.equal(readFileSync(f.output, 'utf8'), '');
  }
  assert.ok(!existsSync(join(f.workspace, 'package-lock.json')));
});
