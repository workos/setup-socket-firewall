#!/usr/bin/env bash
set -euo pipefail

readonly SFW_HOST='https://socket-firewall.workos.dev/'

fail() {
  printf '::error::Socket Firewall Bun lockfile scrub failed: %s\n' "$1" >&2
  exit 1
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

mode="${SFW_SCRUB_MODE:-}"
case "$mode" in
  check | apply) ;;
  *) fail 'mode must be check or apply' ;;
esac

workspace="${GITHUB_WORKSPACE:-}"
[[ -n "$workspace" && -d "$workspace" && ! -L "$workspace" ]] || fail 'GITHUB_WORKSPACE must name a real directory'
[[ -n "${GITHUB_OUTPUT:-}" ]] || fail 'GITHUB_OUTPUT is required'

lockfile="${workspace}/bun.lock"
[[ -f "$lockfile" && ! -L "$lockfile" ]] || fail 'root bun.lock must be a regular file'

if ! grep -Fq "$SFW_HOST" "$lockfile"; then
  printf 'changed=false\n' >>"$GITHUB_OUTPUT"
  exit 0
fi

printf 'changed=true\n' >>"$GITHUB_OUTPUT"
if [[ "$mode" == 'check' ]]; then
  exit 0
fi

temporary="$(mktemp "${lockfile}.workos-sfw.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

sed 's#"https://socket-firewall\.workos\.dev/[^"]*"#""#g' "$lockfile" >"$temporary"
chmod "$(file_mode "$lockfile")" "$temporary"
mv -f -- "$temporary" "$lockfile"

if grep -Fq "$SFW_HOST" "$lockfile"; then
  fail 'Socket Firewall URL remains after apply mode'
fi

trap - EXIT
