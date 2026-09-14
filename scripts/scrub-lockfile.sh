#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly SFW_HOST='https://socket-firewall.workos.dev/'

fail() {
  printf '::error::Socket Firewall lockfile scrub failed: %s\n' "$1" >&2
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
workspace="$(cd "$workspace" && pwd -P)"

relative="${SFW_SCRUB_LOCKFILE:-bun.lock}"
case "$relative" in
  /* | *$'\n'* | *$'\r'* | */ | *//* | . | .. | ./* | ../* | */./* | */../*)
    fail 'lockfile must be a relative workspace path without dot or empty components'
    ;;
esac
case "$(basename "$relative")" in
  bun.lock) format=bun ;;
  package-lock.json | npm-shrinkwrap.json) format=npm ;;
  *) fail 'supported lockfiles are bun.lock, package-lock.json, and npm-shrinkwrap.json' ;;
esac

# Reject symlinked parent directories as well as symlinked lockfiles. Never
# follow a contributor-controlled path outside the checked-out workspace.
IFS='/' read -r -a components <<<"$relative"
lockfile="$workspace"
for component in "${components[@]}"; do
  lockfile="${lockfile}/${component}"
  [[ ! -L "$lockfile" ]] || fail 'lockfile path must not contain symbolic links'
done
[[ -f "$lockfile" ]] || fail 'selected lockfile must be a regular file'

# Stage the transformation before publishing output or replacing any file.
# Check mode uses the same transform, so changed only means a supported repair.
temporary="$(mktemp "${lockfile}.workos-sfw.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

case "$format" in
  bun)
    sed 's#"https://socket-firewall\.workos\.dev/[^"]*"#""#g' "$lockfile" >"$temporary"
    if grep -Fq "$SFW_HOST" "$temporary"; then
      fail 'unrecognized Socket Firewall URL in Bun lockfile; original file was not changed'
    fi
    ;;
  npm)
    command -v node >/dev/null 2>&1 || fail 'npm lockfile scrubbing requires Node.js 22 or later'
    node "$ROOT/scripts/scrub-npm-lockfile.mjs" "$lockfile" >"$temporary"
    ;;
esac

if cmp -s "$lockfile" "$temporary"; then
  printf 'changed=false\n' >>"$GITHUB_OUTPUT"
  exit 0
fi

if [[ "$mode" == 'apply' ]]; then
  chmod "$(file_mode "$lockfile")" "$temporary"
  mv -f -- "$temporary" "$lockfile"
fi
printf 'changed=true\n' >>"$GITHUB_OUTPUT"
