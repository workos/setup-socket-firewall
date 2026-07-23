# setup-socket-firewall

Composite GitHub Action that routes npm installs through the WorkOS Socket
Firewall registry and null-routes `registry.npmjs.org`, so packages cannot be
fetched from the public registry directly.

## Usage

Add the step to any job **before** the first `npm ci` / `npm install` /
`pnpm install` / `yarn install` step:

```yaml
- uses: workos/setup-socket-firewall@v1
  with:
    token: ${{ secrets.SOCKET_FIREWALL_TOKEN }}
```

`SOCKET_FIREWALL_TOKEN` is an org-level secret. If your repo does not have
access to it, ask in #ask-foundation.

## Behavior

- **Token present:** writes the Socket Firewall registry, auth token and
  `replace-registry-host=always` to `~/.npmrc`, then null-routes
  `registry.npmjs.org` and `registry.yarnpkg.com` (IPv4 and IPv6) via
  `/etc/hosts`. `replace-registry-host=always` makes npm rewrite every
  lockfile `resolved` host (not just `registry.npmjs.org`) to the firewall
  registry, so a poisoned lockfile cannot pull from a public mirror. Any
  install that tries to bypass the firewall fails loudly instead of silently
  reaching the public registry.
- **Token absent:** emits a workflow warning and leaves the public registry
  reachable. This keeps fork PRs on public repos (where secrets are
  unavailable) building.

## Notes

- Requires passwordless `sudo` (true on GitHub-hosted runners and standard
  self-hosted images).
- With `replace-registry-host=always`, npm rewrites lockfile `resolved` hosts
  to the firewall registry. Git deps and hardcoded non-registry tarball URLs
  are not rewritten; if they point at a null-routed host they surface as
  install failures. Regenerate the lockfile with the firewall registry
  configured.
- `replace-registry-host=always` also rewrites `resolved` URLs that point at
  a private or third-party registry (e.g. `@your-scope/pkg` resolved from an
  internal Nexus/Artifactory host) to `socket-firewall.workos.dev`. This is
  intentional — the firewall is meant to be the single egress for package
  fetches — but if it does not proxy that upstream, those installs will fail
  (typically a 404). Configure the firewall to proxy the upstream, or fetch
  such packages in a separate job that does not run this action.
- **Known limitations (not fully closed by this action):** a project-level
  `.npmrc` committed to the repo, or an `npm_config_registry` environment
  variable, overrides the user-level `~/.npmrc` written here and can redirect
  installs to an un-null-routed host. Tarballs referenced directly by URL on
  an arbitrary host are also not scanned. Closing these requires network-level
  egress allowlisting to `socket-firewall.workos.dev`; the null-route only
  covers the registry mirror hosts listed above. Yarn Classic / pnpm honor
  their own registry config and are only partially covered.
- **Persistent runners:** the `/etc/hosts` null-route is machine-wide and
  outlives the job. On persistent self-hosted runners this means
  `registry.npmjs.org` stays unreachable for subsequent jobs on that
  machine. Use ephemeral runners (GitHub-hosted and Depot runners are
  ephemeral) or accept machine-wide enforcement.
