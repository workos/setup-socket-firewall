# Contributing to setup-socket-firewall

Thanks for helping improve the WorkOS Socket Firewall GitHub Action.

## Development requirements

- Bash on Linux or macOS
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
bash scripts/build-release.test.sh
```

CI runs the same static and unit checks on every pull request. Token-backed GitHub-hosted smoke jobs additionally exercise every supported package manager.

The minimum test-coverage policy is one shell test suite for every executable shell source file. Changes to supported package-manager behavior must also include a token-backed frozen-lockfile smoke test.

## Pull request guidelines

- Keep changes focused and update documentation when behavior changes.
- Pin third-party GitHub Actions to complete commit SHAs.
- Do not weaken fail-closed token, DNS, or public-fork trust behavior to make a consumer pass.
- Preserve unrelated runner configuration and add regression tests for setup or teardown changes.
- Request review from the Security and Foundation code owners.

## Releases

Maintainers create releases from the allowlisted tree in `release-manifest.txt`. Do not manually edit or tag the release branch, and never direct consumers to a source-branch SHA or mutable tag.

For security-sensitive reports, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.
