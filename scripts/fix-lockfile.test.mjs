import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const { fixPullRequest, githubApi, validateLockfile } = await import(process.env.SFW_TEST_FIX_MODULE || './fix-lockfile.mjs');

const repository = 'workos/example';
const head = 'a'.repeat(40);
const next = 'b'.repeat(40);
const rootTree = 'c'.repeat(40);
const nestedTree = 'd'.repeat(40);
const blobSha = 'e'.repeat(40);
const firewall = 'https://socket-firewall.workos.dev/';
const npm = 'https://registry.npmjs.org/';
const npmSource = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/pkg': { version: '1.0.0', resolved: firewall + 'pkg/-/pkg-1.0.0.tgz', integrity: 'sha512-retain' } } }, null, 2);
const bunSource = '{\n"packages": {"pkg": ["pkg@1.0.0", "' + firewall + 'pkg/-/pkg-1.0.0.tgz", {}, "sha512-retain"]}\n}\n';

function fixture({ source = npmSource, lockfile = 'package-lock.json', sourceRepository = repository, branch = 'fix-lock', mode = 'fix' } = {}) {
  const event = { pull_request: { number: 10, base: { repo: { full_name: repository } }, head: { sha: head, ref: branch, repo: { full_name: sourceRepository } } } };
  const config = { eventName: 'pull_request', repository, event, lockfile, mode };
  const state = { pr: { ...structuredClone(event.pull_request), state: 'open' }, source, calls: [], mutations: [], fileMode: '100644', parentMode: '040000', truncated: false, beforeCommit: undefined, refuseCommit: false };
  const api = async (path, body) => {
    state.calls.push(path);
    if (path === `repos/${repository}/pulls/10`) return structuredClone(state.pr);
    if (path === `repos/${repository}`) return { default_branch: 'main' };
    if (path === `repos/${sourceRepository}/git/commits/${state.pr.head.sha}`) return { tree: { sha: rootTree } };
    if (path === `repos/${sourceRepository}/git/trees/${rootTree}`) {
      const nested = lockfile.includes('/');
      return { truncated: state.truncated, tree: [{ path: lockfile.split('/')[0], mode: nested ? state.parentMode : state.fileMode, type: nested ? 'tree' : 'blob', sha: nested ? nestedTree : blobSha }] };
    }
    if (path === `repos/${sourceRepository}/git/trees/${nestedTree}`) return { truncated: false, tree: [{ path: lockfile.split('/')[1], type: 'blob', mode: state.fileMode, sha: blobSha }] };
    if (path === `repos/${sourceRepository}/git/blobs/${blobSha}`) return { encoding: 'base64', size: Buffer.byteLength(state.source), content: Buffer.from(state.source).toString('base64') };
    if (path === 'graphql') {
      state.mutations.push(body);
      state.beforeCommit?.();
      if (state.refuseCommit || state.pr.head.sha !== body.variables.input.expectedHeadOid) return { errors: [{ message: 'denied or stale head' }] };
      state.source = Buffer.from(body.variables.input.fileChanges.additions[0].contents, 'base64').toString();
      state.pr.head.sha = next;
      return { data: { createCommitOnBranch: { commit: { oid: next } } } };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  return { config, state, api };
}

for (const lockfile of ['bun.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'nested path/package-lock.json']) {
  test(`default fix owns normalization AND branch commit: ${lockfile}`, async () => {
    const source = lockfile === 'bun.lock' ? bunSource : npmSource;
    const f = fixture({ lockfile, source });
    delete f.config.mode;
    const result = await fixPullRequest(f.config, f.api);
    assert.deepEqual(result, { changed: true, commitSha: next });
    assert.equal(f.state.mutations.length, 1);
    const request = f.state.mutations[0].variables.input;
    assert.deepEqual(request.branch, { repositoryNameWithOwner: repository, branchName: 'fix-lock' });
    assert.equal(request.expectedHeadOid, head);
    assert.equal(request.fileChanges.additions.length, 1);
    assert.equal(request.fileChanges.additions[0].path, lockfile);
    assert.equal(request.fileChanges.deletions, undefined);
    const expected = lockfile === 'bun.lock' ? source.replace(`"${firewall}pkg/-/pkg-1.0.0.tgz"`, '""') : source.replace(firewall, npm);
    assert.equal(f.state.source, expected);
    assert.equal(f.state.pr.head.sha, next);
    // New event at the repaired head produces no follow-up commit.
    f.config.event.pull_request.head.sha = next;
    assert.deepEqual(await fixPullRequest(f.config, f.api), { changed: false, commitSha: '' });
    assert.equal(f.state.mutations.length, 1);
  });
}

test('explicit check mode reports dirty without writing', async () => {
  const f = fixture({ mode: 'check' });
  assert.deepEqual(await fixPullRequest(f.config, f.api), { changed: true, commitSha: '' });
  assert.equal(f.state.mutations.length, 0);
  assert.equal(f.state.source, npmSource);
});

test('clean default fix creates no commit', async () => {
  const f = fixture({ source: npmSource.replace(firewall, npm) });
  assert.deepEqual(await fixPullRequest(f.config, f.api), { changed: false, commitSha: '' });
  assert.equal(f.state.mutations.length, 0);
});

for (const dirty of [false, true]) {
  test(`fork is read-only, ${dirty ? 'dirty fails with repair guidance' : 'clean succeeds'}`, async () => {
    const f = fixture({ sourceRepository: 'contributor/example', source: dirty ? npmSource : npmSource.replace(firewall, npm) });
    if (dirty) await assert.rejects(fixPullRequest(f.config, f.api), /never writes to forks/);
    else assert.deepEqual(await fixPullRequest(f.config, f.api), { changed: false, commitSha: '' });
    assert.equal(f.state.mutations.length, 0);
    assert.ok(f.state.calls.some((path) => path.startsWith('repos/contributor/example/git/')));
  });
}

for (const eventName of ['push', 'workflow_dispatch', 'pull_request_target', 'workflow_run']) {
  test(`unsupported trigger ${eventName} fails before API access`, async () => {
    const f = fixture();
    f.config.eventName = eventName;
    await assert.rejects(fixPullRequest(f.config, f.api), /pull_request event/);
    assert.equal(f.state.calls.length, 0);
  });
}

test('default branch, closed PR, or stale event cannot be modified', async () => {
  for (const kind of ['default', 'closed', 'stale', 'retargeted']) {
    const f = fixture({ branch: kind === 'default' ? 'main' : 'fix-lock' });
    if (kind === 'closed') f.state.pr.state = 'closed';
    if (kind === 'stale') f.state.pr.head.sha = next;
    if (kind === 'retargeted') f.state.pr.head.ref = 'another-branch';
    await assert.rejects(fixPullRequest(f.config, f.api));
    assert.equal(f.state.mutations.length, 0);
    assert.equal(f.state.source, npmSource);
  }
});

test('head advancing during transformation is rejected atomically, never retried', async () => {
  const f = fixture();
  f.state.beforeCommit = () => { f.state.pr.head.sha = next; };
  await assert.rejects(fixPullRequest(f.config, f.api), /rejected the repair commit/);
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.state.source, npmSource);
  assert.equal(f.state.pr.head.sha, next);
});

test('denied writes fail without pretending repair succeeded', async () => {
  const f = fixture();
  f.state.refuseCommit = true;
  await assert.rejects(fixPullRequest(f.config, f.api), /contents:write/);
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.state.source, npmSource);
});

for (const mode of ['120000', '160000', '100755']) {
  test(`file mode ${mode} cannot be repaired`, async () => {
    const f = fixture();
    f.state.fileMode = mode;
    await assert.rejects(fixPullRequest(f.config, f.api), /regular, non-executable/);
    assert.equal(f.state.mutations.length, 0);
  });
}

test('symlinked parent and truncated tree fail without commits', async () => {
  const f = fixture({ lockfile: 'nested/package-lock.json' });
  f.state.parentMode = '120000';
  await assert.rejects(fixPullRequest(f.config, f.api), /parents must be directories/);
  f.state.parentMode = '040000';
  f.state.truncated = true;
  await assert.rejects(fixPullRequest(f.config, f.api), /incomplete/);
  assert.equal(f.state.mutations.length, 0);
});

test('malformed lockfile is not committed and error does not echo content', async () => {
  const f = fixture({ source: '{"lockfileVersion":3,"secret":"do-not-log' });
  await assert.rejects(fixPullRequest(f.config, f.api), (error) => /normalization failed/.test(error.message) && !error.message.includes('do-not-log'));
  assert.equal(f.state.mutations.length, 0);
});

for (const path of ['/package-lock.json', '../bun.lock', 'x/../bun.lock', 'x//bun.lock', 'bun.lock\n', 'x\\bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml']) {
  test(`invalid path ${JSON.stringify(path)} is rejected`, () => assert.throws(() => validateLockfile(path)));
}

test('action defaults to branch repair and supplies repository token, no checkout needed', () => {
  const action = readFileSync(new URL('../lockfile-scrub/action.yml', import.meta.url), 'utf8');
  assert.match(action, /default: fix/);
  assert.match(action, /default: \$\{\{ github.token \}\}/);
  assert.match(action, /using: node24/);
  assert.match(action, /main: ..\/scripts\/fix-lockfile.mjs/);
  assert.doesNotMatch(action, /actions\/checkout/);
});

test('API rejects missing token, plaintext or cross-origin endpoints', () => {
  assert.throws(() => githubApi('', 'https://api.github.com', 'https://api.github.com/graphql'));
  assert.throws(() => githubApi('token', 'http://api.github.com', 'http://api.github.com/graphql'));
  assert.throws(() => githubApi('token', 'https://api.github.com', 'https://elsewhere.test/graphql'));
});
