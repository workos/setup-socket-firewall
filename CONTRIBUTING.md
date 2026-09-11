# Contributing to setup-socket-firewall

Thanks for helping improve the WorkOS Socket Firewall GitHub Action.

## Development requirements

- Bash on Linux or macOS
- Node.js 22 or later, for npm lockfile transformation, tests, and release validation
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
node --test scripts/scrub-npm-lockfile.test.mjs
bash scripts/build-release.test.sh
bash scripts/publish-release.test.sh
```

CI runs the same static and unit checks on every pull request. The npm scrub smoke matrix runs the composite action and `npm ci --ignore-scripts` against both npm filenames and lockfile versions 1–3 without credentials. Token-backed GitHub-hosted smoke jobs additionally exercise every supported package manager and a scrubbed npm lockfile with public registry DNS blocked.

The minimum test-coverage policy is one shell test suite for every executable shell source file. Changes to supported package-manager behavior must also include a token-backed frozen-lockfile smoke test.

## Pull request guidelines

- Keep changes focused and update documentation when behavior changes.
- Pin third-party GitHub Actions to complete commit SHAs.
- Do not weaken fail-closed token, DNS, or public-fork trust behavior to make a consumer pass.
- Preserve unrelated runner configuration and add regression tests for setup or teardown changes.
- Request review from the Security and Foundation code owners.

## Releases

Successful `main` CI automatically builds and publishes the allowlisted action tree. Do not run release commands locally or manually edit/tag `action-release/v1`. If automation fails, diagnose or rerun the `Publish action release` workflow in GitHub Actions. Consumers must use the full action-only SHA, never a source-branch SHA or mutable tag.

For security-sensitive reports, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.
