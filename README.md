# setup-socket-firewall

Composite GitHub Actions for routing **public npm-compatible JavaScript/TypeScript dependency downloads** through the WorkOS Socket Firewall and restoring public-registry access before package publication.

This repository exposes two action entrypoints from the same action-only release commit:

- `/` — configure protected dependency downloads.
- `/teardown` — remove only SFW-owned configuration before an npm/pnpm/Yarn/Bun publish in the same job.

It does not route package publication or Python, Java, Go, Ruby, Rust, .NET, private-registry, or other dependency ecosystems through the WorkOS SFW instance.

## Immutable reference

Consumers must pin the full 40-character SHA of the reviewed action-only `v1` commit. Do not execute a mutable tag, branch, abbreviated SHA, or normal source commit.

```yaml
uses: workos/setup-socket-firewall@<FULL_40_CHARACTER_V1_SHA> # v1
```

The moving `v1` tag and `action-release/v1` branch are for human discovery and Renovate lookup. The repository’s normal source history contains tests and rollout tooling; each action-only release commit contains only the files in `release-manifest.txt`.

## Strict internal/private usage

Run package-manager setup first, then configure SFW before the first dependency download. This ordering is important when `actions/setup-node` uses `registry-url`, because setup-node writes the effective npm config file.

```yaml
- uses: actions/checkout@<PINNED_SHA>

- uses: actions/setup-node@<PINNED_SHA>
  with:
    node-version: 22
    registry-url: https://registry.npmjs.org/

- name: Configure Socket Firewall
  uses: workos/setup-socket-firewall@<FULL_40_CHARACTER_V1_SHA> # v1
  with:
    token: ${{ secrets.SOCKET_FIREWALL_TOKEN }}

- run: npm ci
```

For a Bun dependency-install job, also set `configure-bun: true`. This writes a marker-owned, mode-0600 user Bun config containing registry auth; setup fails rather than overwriting a pre-existing global Bun config.

The token is fail-closed by default. Private, internal, trusted/default-branch, and Dependabot jobs stop before dependency download when the token is absent.

`SOCKET_FIREWALL_TOKEN` is an organization secret. Dependabot uses a separate secret store: provision the same secret there for dependency-update runs that must pass, or accept the intentional fail-closed result. Ask in `#ask-foundation` about repository selection or token delivery.

## Public external-fork usage

Ordinary external-fork pull requests cannot receive organization secrets. A public repository may explicitly allow a public-registry fallback for that context only:

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@<PINNED_SHA>
    with:
      persist-credentials: false

  - uses: actions/setup-node@<PINNED_SHA>
    with:
      node-version: 22

  - name: Configure Socket Firewall
    uses: workos/setup-socket-firewall@<FULL_40_CHARACTER_V1_SHA> # v1
    with:
      token: ${{ secrets.SOCKET_FIREWALL_TOKEN }}
      allow-external-fork-fallback: true

  - run: npm ci
```

The action independently requires a `pull_request` event from a different repository into a public base repository. The input cannot enable fallback for private, same-repository, default-branch, or Dependabot runs.

Do not use this action in an install-bearing `pull_request_target` job. Such workflows can combine base-repository secrets with contributor-controlled checkout, lockfiles, scripts, local/reusable actions, or artifacts. Apply the same review to `workflow_run`, `issue_comment`, `workflow_dispatch`, reusable workflows with inherited secrets, and artifact handoffs whenever they select an untrusted ref or input. Redesign that trust boundary before enabling SFW.

## Package publication

Socket Firewall is a dependency-download control, not a package publication registry. Prefer a clean publish job that never configures SFW.

When an existing job must both install and publish, run the teardown entrypoint at the **same action SHA** after the final dependency download and before registry authentication or publication:

```yaml
- name: Configure Socket Firewall
  uses: workos/setup-socket-firewall@<FULL_40_CHARACTER_V1_SHA> # v1
  with:
    token: ${{ secrets.SOCKET_FIREWALL_TOKEN }}

- run: pnpm install
- run: pnpm build

- name: Restore public package registry
  uses: workos/setup-socket-firewall/teardown@<SAME_FULL_40_CHARACTER_V1_SHA> # v1

- name: Publish package
  run: pnpm publish --access public --provenance --no-git-checks
```

Teardown takes no token. It removes only marker-owned npm/Bun and `/etc/hosts` entries, flushes available Linux DNS caches, verifies the public registry hosts no longer resolve to loopback, restores public npm-compatible registry environment values, and fails before publish if cleanup cannot complete. Keep publish credentials scoped to the later publish step.

If any step after teardown may download another dependency, split publication onto a clean job rather than alternating setup and teardown. Private/GitHub Packages publication is outside this public-registry teardown contract: use a clean publish job with its own registry configuration rather than teardown’s intentional npmjs.org reset.

## Protected download behavior

With a token, setup:

1. Sets npm, pnpm, and Bun registry environment values to `https://socket-firewall.workos.dev/` for later steps.
2. Writes a marker-delimited registry, host-scoped auth token, and `replace-registry-host=always` block under mode `0600` to `~/.npmrc` and the effective `NPM_CONFIG_USERCONFIG` when setup-node configured one.
3. With `configure-bun: true`, writes a separate marker-owned mode-0600 Bun user config because Bun lockfile tarball fetches do not reliably apply npmrc auth.
4. DNS-null-routes these reviewed public JavaScript registry hosts over IPv4 and IPv6:
   - `registry.npmjs.org`
   - `registry.yarnpkg.com`
5. Emits `active=true`.

The npmjs entry catches direct/project-config bypass to the canonical public registry. The yarnpkg entry catches Yarn-default and non-npmjs mirror-lockfile bypass. `replace-registry-host=always` rewrites lockfile resolution hosts where npm honors that setting; DNS enforcement remains defense in depth against later registry drift to the reviewed hosts.

With no token, setup either:

- emits `active=false` and fails; or
- for an explicitly allowed public external-fork pull request only, emits a warning, selects the public npm registry, leaves DNS untouched, and succeeds with `active=false`.

## Requirements and limitations

- Supported target: ephemeral Linux runners with `bash`, `sed`, `chmod`, standard coreutils, passwordless `sudo`, and a writable `/etc/hosts` honored by the package manager resolver.
- GitHub-hosted and standard Depot runners are ephemeral. Persistent self-hosted runners are unsupported because host-file changes can outlive the job.
- Container jobs, non-sudo runners, and package-manager resolver behavior not covered by CI smoke tests require review; setup fails instead of silently omitting DNS enforcement.
- Current supported manager coverage is npm, pnpm, and Bun for public npm-compatible dependency downloads using committed public-registry lockfiles. Yarn Classic is blocked because it fetches the absolute public URL recorded in `yarn.lock`, which conflicts with DNS enforcement; Yarn Berry requires a separate auth design. Both remain fail-closed rollout blockers rather than silently bypassing SFW.
- Project config, environment, or direct arbitrary tarball/Git URLs can reference hosts outside the reviewed DNS list. Closing every arbitrary-host path requires network-level egress allowlisting and is outside this action.
- `replace-registry-host=always` can redirect lockfile URLs for private/third-party registries. The WorkOS endpoint is not assumed to proxy them; private-registry jobs require separate Foundation review.
- Dependency lifecycle code can read the host-scoped SFW credential while installation is running. The action restricts file permissions and token scope, requires ephemeral runners, and avoids job-wide token exposure, but cleanup cannot remove access retroactively.

## Automated release process

No maintainer runs local release commands.

1. Merge reviewed source changes to `main`.
2. The `CI` workflow validates the resulting main commit, including token-backed package-manager smokes.
3. After successful main CI, `.github/workflows/release.yml` checks out that exact commit and builds the allowlisted tree with `scripts/build-release.sh`.
4. `scripts/publish-release.sh` uploads that tree through GitHub's API, creates a GitHub-verified bot commit chained from the prior action-only release, and fails before updating refs if verification is absent.
5. CI moves `action-release/v1` and the `v1` discovery tag to the release commit and writes its full SHA to the workflow summary. An unchanged runtime tree is a no-op.
6. Consumer PRs use only the full action-only SHA. Renovate may discover updates through `v1`, but executable workflow references never use that mutable tag.

The workflow uses only the repository-scoped `GITHUB_TOKEN` with `contents: write`, serializes releases, skips stale successful commits when `main` has advanced, and can be retried through `workflow_dispatch`. A future breaking release must change the reviewed channel to `v2`; it must not repurpose `v1`.

Never publish the normal source commit as an action release: it contains tests and, after HELP-724 Phase 2, the one-time rollout verifier and report source.
