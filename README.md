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

- **Token present:** writes the Socket Firewall registry and auth token to
  `~/.npmrc`, then null-routes `registry.npmjs.org` (IPv4 and IPv6) via
  `/etc/hosts`. Any install that tries to bypass the firewall fails loudly
  instead of silently reaching the public registry.
- **Token absent:** emits a workflow warning and leaves the public registry
  reachable. This keeps fork PRs on public repos (where secrets are
  unavailable) building.

## Notes

- Requires passwordless `sudo` (true on GitHub-hosted runners and standard
  self-hosted images).
- If your `package-lock.json` contains `resolved` URLs pinned to
  `registry.npmjs.org` that npm does not rewrite (git deps, hardcoded
  tarballs), the null-route will surface them as install failures.
  Regenerate the lockfile with the firewall registry configured.
- Yarn Classic users: `registry.yarnpkg.com` is not null-routed; open an
  issue if you need it.
