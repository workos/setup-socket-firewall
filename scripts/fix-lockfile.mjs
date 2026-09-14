import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const script = fileURLToPath(new URL('./scrub-lockfile.sh', import.meta.url));
const commitMutation = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

class ActionError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new ActionError(message);
}

export function validateLockfile(path) {
  requireValue(typeof path === 'string' && !/[\x00-\x1f\x7f\\]/.test(path), 'Invalid lockfile path.');
  requireValue(path.split('/').every((part) => part && part !== '.' && part !== '..'), 'Use a repository-relative lockfile path without dot or empty components.');
  requireValue(['bun.lock', 'package-lock.json', 'npm-shrinkwrap.json'].includes(basename(path)), 'Supported filenames: bun.lock, package-lock.json, npm-shrinkwrap.json.');
}

// Normalize only API-supplied lockfile bytes in an isolated directory. Never
// execute code from the target checkout or pass the GitHub token to a child.
export function normalizeLockfile(source, lockfile) {
  validateLockfile(lockfile);
  const work = mkdtempSync(join(tmpdir(), 'sfw-fix-'));
  try {
    const path = join(work, lockfile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    try {
      execFileSync('bash', [script], {
        env: {
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          GITHUB_WORKSPACE: work,
          GITHUB_OUTPUT: join(work, 'output'),
          SFW_SCRUB_LOCKFILE: lockfile,
          SFW_SCRUB_MODE: 'apply',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new ActionError('Lockfile normalization failed; no branch changes were made. Check the lockfile format and supported URL fields.');
    }
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Nonrecursive tree traversal preserves file modes and refuses symlinks or
// submodules rather than following the Contents API's symlink resolution.
async function readLockfile(api, repository, sha, lockfile) {
  const prefix = `repos/${repository}/git`;
  const commit = await api(`${prefix}/commits/${sha}`);
  requireValue(shaPattern.test(commit.tree?.sha), 'GitHub returned an invalid commit tree.');
  let treeSha = commit.tree.sha;
  const parts = lockfile.split('/');
  for (let i = 0; i < parts.length; i++) {
    const tree = await api(`${prefix}/trees/${treeSha}`);
    requireValue(tree.truncated === false && Array.isArray(tree.tree), 'GitHub tree listing is incomplete.');
    const entry = tree.tree.find((item) => item.path === parts[i]);
    requireValue(entry && shaPattern.test(entry.sha), 'Selected lockfile does not exist at the PR head.');
    if (i < parts.length - 1) {
      requireValue(entry.type === 'tree' && entry.mode === '040000', 'Lockfile parents must be directories, not symlinks or submodules.');
      treeSha = entry.sha;
      continue;
    }
    requireValue(entry.type === 'blob' && entry.mode === '100644', 'Selected lockfile must be a regular, non-executable file.');
    const blob = await api(`${prefix}/blobs/${entry.sha}`);
    requireValue(blob.encoding === 'base64' && typeof blob.content === 'string', 'GitHub did not return lockfile content.');
    const bytes = Buffer.from(blob.content, 'base64');
    requireValue(bytes.length === blob.size, 'GitHub lockfile content is incomplete.');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    requireValue(!source.includes('\0'), 'Binary lockfiles are not supported.');
    return source;
  }
}

export async function fixPullRequest({ eventName, repository, event, mode = 'fix', lockfile = 'bun.lock' }, api) {
  requireValue(['fix', 'check'].includes(mode), 'mode must be fix or check.');
  validateLockfile(lockfile);
  requireValue(eventName === 'pull_request', 'lockfile-scrub requires a pull_request event; pull_request_target and other triggers are refused.');
  requireValue(repoPattern.test(repository), 'Invalid GitHub repository context.');
  const expected = event?.pull_request;
  requireValue(expected && Number.isSafeInteger(expected.number) && expected.number > 0, 'Missing pull request context.');
  requireValue(expected.base?.repo?.full_name === repository && shaPattern.test(expected.head?.sha), 'Invalid pull request repository or head SHA.');

  const pr = await api(`repos/${repository}/pulls/${expected.number}`);
  requireValue(pr.state === 'open' && pr.base?.repo?.full_name === repository, 'Pull request is no longer open in this repository.');
  requireValue(pr.head?.sha === expected.head.sha && pr.head?.ref === expected.head.ref && pr.head?.repo?.full_name === expected.head.repo?.full_name, 'PR head changed; use the newest pull_request run. No branch was modified.');
  const sourceRepository = pr.head.repo.full_name;
  requireValue(repoPattern.test(sourceRepository), 'Invalid PR source repository.');
  const sameRepository = sourceRepository === repository;
  const metadata = await api(`repos/${repository}`);
  requireValue(typeof metadata.default_branch === 'string' && metadata.default_branch, 'Cannot determine the default branch.');
  requireValue(mode !== 'fix' || !sameRepository || pr.head.ref !== metadata.default_branch, 'Refusing to modify the default branch.');

  const source = await readLockfile(api, sourceRepository, pr.head.sha, lockfile);
  const normalized = normalizeLockfile(source, lockfile);
  const changed = normalized !== source;
  if (!changed || mode === 'check') return { changed, commitSha: '' };
  requireValue(sameRepository, 'Fork lockfile needs repair. Regenerate it using the public registry and commit it to your fork; this action never writes to forks.');

  // Atomic compare-and-swap: GitHub refuses if the branch advanced after the
  // read. No force push, branch reset, retry, checkout, staging, or Git hooks.
  const response = await api('graphql', {
    query: commitMutation,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: pr.head.ref },
        expectedHeadOid: pr.head.sha,
        message: { headline: 'chore: normalize lockfile registry URLs' },
        fileChanges: { additions: [{ path: lockfile, contents: Buffer.from(normalized).toString('base64') }] },
      },
    },
  });
  const commitSha = response.data?.createCommitOnBranch?.commit?.oid;
  requireValue(!response.errors?.length && shaPattern.test(commitSha), 'GitHub rejected the repair commit. Check contents:write, branch protection, or a newer PR head; no retry or force push was attempted.');
  return { changed: true, commitSha };
}

export function githubApi(token, apiUrl, graphqlUrl) {
  requireValue(token, 'GITHUB_TOKEN is required. Allow contents:write for automatic branch repair.');
  const base = new URL(apiUrl);
  const graphql = new URL(graphqlUrl);
  requireValue(base.protocol === 'https:' && graphql.protocol === 'https:' && base.origin === graphql.origin, 'GitHub API endpoints must share an HTTPS origin.');
  return async (path, body) => {
    const url = path === 'graphql' ? graphql : new URL(`${base.href.replace(/\/$/, '')}/${path}`);
    let response;
    try {
      response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new ActionError('GitHub request failed; inspect the PR branch before retrying. A commit request may already have succeeded.');
    }
    requireValue(response.ok, `GitHub request failed (${response.status}); check token permissions and branch protection. No automatic retry was attempted.`);
    return response.json();
  };
}

async function main() {
  try {
    requireValue(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required.');
    appendFileSync(process.env.GITHUB_OUTPUT, '');
    const result = await fixPullRequest({
      eventName: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      mode: process.env.INPUT_MODE || 'fix',
      lockfile: process.env.INPUT_LOCKFILE || 'bun.lock',
    }, githubApi(process.env.INPUT_TOKEN, process.env.GITHUB_API_URL, process.env.GITHUB_GRAPHQL_URL));
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\ncommit-sha=${result.commitSha}\n`);
    const summary = result.commitSha
      ? `Committed lockfile repair to the PR branch: ${result.commitSha}. GITHUB_TOKEN commits do not trigger another Actions run.`
      : result.changed ? 'Lockfile needs repair (check mode; no commit created).' : 'Lockfile is already clean; no commit created.';
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } catch (error) {
    // Only our own controlled errors are shown. Parser/filesystem errors can
    // echo lockfile content, URLs or caller-supplied paths.
    const safe = error instanceof ActionError ? error.message : 'Invalid action context or lockfile data.';
    console.error(`::error::${safe.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
