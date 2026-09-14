# Contributing to setup-socket-firewall

Thanks for helping improve the WorkOS Socket Firewall GitHub Action.

## Development requirements

- Bash on Linux or macOS
- Node.js 24 or later and npm, matching the branch-repair JavaScript action runtime and CI
- Go, for the pinned `shfmt` check
- ShellCheck
- Passwordless `sudo` and a disposable Linux runner for integration testing that modifies `/etc/hosts`

Never use a production Socket Firewall token in local test fixtures or commit credentials to the repository.

## Checks

Run these checks before opening a pull request:

```bash
shellcheck --severity=warning scripts/*.sh
go run mvdan.cc/sh/v3/cmd/shfmt@v3.14.0 -d -i 2 -ci scripts/*.sh
bash -n scripts/*.sh
bash scripts/configure.test.sh
bash scripts/teardown.test.sh
bash scripts/scrub-lockfile.test.sh
node --test scripts/scrub-npm-lockfile.test.mjs scripts/fix-lockfile.test.mjs
bash scripts/build-release.test.sh
bash scripts/publish-release.test.sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`npm run check` runs formatting and pure mocked Node tests offline after dependencies are installed. `npm test` and `npm run test:unit` both run all verifier suites. No credential or live discovery-ref lookup is needed for these tests. The install and pinned Go formatter command above may access the network; they are not offline tests.

CI runs the same static and unit checks on every pull request. The npm scrub smoke matrix tests the internal normalizer and `npm ci --ignore-scripts` against both npm filenames and lockfile versions 1–3 without credentials. Branch-repair tests exercise the action controller against a simulated GitHub API, asserting the target branch, single-file commit, expected-head race protection, no-op, fork/default-branch guards, and denied writes. Release-tree tests run those same controller tests using the packaged runtime. Token-backed GitHub-hosted smoke jobs additionally exercise every supported package manager and a scrubbed npm lockfile with public registry DNS blocked.

Existing public/fork secret gates and token-backed smoke jobs are independent of the detector. Never add a live organization audit or release snapshot verification to normal source CI.

The minimum test-coverage policy is one shell test suite for every executable shell source file. Verifier changes require synthetic Node fixtures for per-download setup/teardown boundaries, opaque execution, immutable-SHA reads, partial failures and private reporting. Preserve REST/GraphQL token-visible inventory reconciliation without claiming it proves organization-wide completeness. Changes to supported package-manager behavior must also include a token-backed frozen-lockfile smoke test.

## Operator-only commands

`npm run inventory` and `npm run audit:live` are read-only manual commands using an existing authorized `gh` session. Confirm organization-wide read access separately before making organization-wide claims. No scheduling or remediation is implicit. See README for the scan scope and limitations.

Full results are owner-only, ignored `reports/inventory.json` and `reports/live-audit.json`; terminal JSON contains sanitized counts. Audit `scanErrors`/`scanStatus` distinguish operational failures from discovered gaps. Exit 1 includes partial scans; exit 0 can still include `needs-sfw` or `needs-review`. Do not force-add reports, expose inventory/source in logs, or upload full reports as artifacts.

`npm run verify-action` is a separate live, strict historical release snapshot check, not a normal CI check. Advancing `v1` or changing the current release manifest can intentionally invalidate it. Mocked release tests use `tools/rollout/fixtures/release-manifest.txt`, preserving integrity regression tests without binding source CI to future manifest changes. Keep the actual runtime manifest and action-only publication boundaries intact.

## Pull request guidelines

- Keep changes focused and update documentation when behavior changes.
- Pin third-party GitHub Actions to complete commit SHAs.
- Do not weaken fail-closed token, DNS, or public-fork trust behavior to make a consumer pass.
- Preserve unrelated runner configuration and add regression tests for setup or teardown changes.
- Request review from the Security and Foundation code owners.

## Releases

Successful `main` CI automatically builds and publishes the allowlisted action tree. Do not run release commands locally or manually edit/tag `action-release/v1`. If automation fails, diagnose or rerun the `Publish action release` workflow in GitHub Actions. Consumers must use the full action-only SHA, never a source-branch SHA or mutable tag.

For security-sensitive reports, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.
