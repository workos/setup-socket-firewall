#!/usr/bin/env bash
set -euo pipefail

PUBLIC_REGISTRY='https://registry.npmjs.org/'
NPMRC_BEGIN='# >>> workos-sfw >>>'
NPMRC_END='# <<< workos-sfw <<<'
BUNFIG_BEGIN='# >>> workos-sfw >>>'
BUNFIG_END='# <<< workos-sfw <<<'
MANAGED_HOST_PATTERN='^(127\.0\.0\.1|::1) (registry\.npmjs\.org|registry\.yarnpkg\.com) # workos-sfw$'

fail() {
  printf '::error title=Socket Firewall teardown failed::%s\n' "$1" >&2
  exit 1
}

require_environment() {
  [[ -n "${GITHUB_ENV:-}" ]] || { printf 'GITHUB_ENV is required\n' >&2; exit 1; }
  [[ -n "${GITHUB_OUTPUT:-}" ]] || { printf 'GITHUB_OUTPUT is required\n' >&2; exit 1; }
  [[ -n "${HOME:-}" ]] || fail 'HOME is required.'
  for command_name in sed chmod mktemp grep cat rm dirname pwd; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: ${command_name}."
  done
}

write_public_registry_environment() {
  {
    printf 'NPM_CONFIG_REGISTRY=%s\n' "$PUBLIC_REGISTRY"
    printf 'PNPM_CONFIG_REGISTRY=%s\n' "$PUBLIC_REGISTRY"
    printf 'BUN_CONFIG_REGISTRY=%s\n' "$PUBLIC_REGISTRY"
  } >>"$GITHUB_ENV"
}

validate_config_path() {
  local npmrc="$1"
  local parent real_parent real_home real_runner=''

  [[ "$npmrc" == /* ]] || fail "Managed config path must be absolute: ${npmrc}."
  [[ ! -L "$npmrc" ]] || fail "Managed config path must not be a symbolic link: ${npmrc}."
  parent="$(dirname "$npmrc")"
  [[ -d "$parent" ]] || fail "npm config directory does not exist: ${parent}."
  real_parent="$(cd "$parent" && pwd -P)"
  real_home="$(cd "$HOME" && pwd -P)"
  if [[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" ]]; then
    real_runner="$(cd "$RUNNER_TEMP" && pwd -P)"
  fi

  if [[ "$real_parent" != "$real_home" && "$real_parent" != "$real_home/"* &&
        ( -z "$real_runner" || ( "$real_parent" != "$real_runner" && "$real_parent" != "$real_runner/"* ) ) ]]; then
    fail "Managed config path must be inside HOME or RUNNER_TEMP: ${npmrc}."
  fi
}

remove_managed_npmrc_block() {
  local npmrc="$1"
  local temporary

  validate_config_path "$npmrc"
  if [[ ! -e "$npmrc" ]]; then
    return 0
  fi
  [[ -f "$npmrc" ]] || fail "npm config path is not a regular file: ${npmrc}."

  chmod 600 "$npmrc"
  temporary="$(mktemp)"
  sed "/^${NPMRC_BEGIN}$/,/^${NPMRC_END}$/d" "$npmrc" >"$temporary"
  cat "$temporary" >"$npmrc"
  chmod 600 "$npmrc"
  rm -f "$temporary"

  if grep -Fq 'socket-firewall.workos.dev/:_authToken=' "$npmrc"; then
    fail "Socket Firewall auth remains in ${npmrc}."
  fi
}

remove_managed_npmrc_blocks() {
  local home_npmrc="${HOME}/.npmrc"
  remove_managed_npmrc_block "$home_npmrc"

  if [[ -n "${NPM_CONFIG_USERCONFIG:-}" && "$NPM_CONFIG_USERCONFIG" != "$home_npmrc" ]]; then
    remove_managed_npmrc_block "$NPM_CONFIG_USERCONFIG"
  fi
}

remove_managed_bunfig() {
  local bunfig="${SFW_BUN_CONFIG_PATH:-}"
  local temporary
  [[ -n "$bunfig" ]] || return 0
  validate_config_path "$bunfig"
  [[ -e "$bunfig" ]] || return 0
  [[ -f "$bunfig" ]] || fail "Bun config path is not a regular file: ${bunfig}."

  chmod 600 "$bunfig"
  temporary="$(mktemp)"
  sed "/^${BUNFIG_BEGIN}$/,/^${BUNFIG_END}$/d" "$bunfig" >"$temporary"
  cat "$temporary" >"$bunfig"
  rm -f "$temporary"
  if grep -Fq 'socket-firewall.workos.dev' "$bunfig"; then
    fail "Socket Firewall configuration remains in ${bunfig}."
  fi
  if grep -Eq '[^[:space:]]' "$bunfig"; then
    chmod 600 "$bunfig"
  else
    rm -f "$bunfig"
  fi
}

hosts_file() {
  printf '%s' "${SFW_HOSTS_FILE:-/etc/hosts}"
}

flush_and_verify_dns() {
  local host addresses attempt all_restored

  command -v getent >/dev/null 2>&1 || fail 'getent is required to verify DNS restoration.'
  command -v sleep >/dev/null 2>&1 || fail 'sleep is required to wait for DNS restoration.'
  if command -v resolvectl >/dev/null 2>&1; then
    sudo resolvectl flush-caches >/dev/null 2>&1 || true
  fi
  if command -v systemd-resolve >/dev/null 2>&1; then
    sudo systemd-resolve --flush-caches >/dev/null 2>&1 || true
  fi
  if command -v nscd >/dev/null 2>&1; then
    sudo nscd -i hosts >/dev/null 2>&1 || true
  fi

  for ((attempt = 1; attempt <= 30; attempt++)); do
    all_restored=true
    for host in registry.npmjs.org registry.yarnpkg.com; do
      addresses="$(getent ahosts "$host" 2>/dev/null || true)"
      if [[ -z "$addresses" ]] || grep -Eq '^(127\.|::1[[:space:]])' <<<"$addresses"; then
        all_restored=false
        break
      fi
    done
    if [[ "$all_restored" == 'true' ]]; then
      return
    fi
    sleep 1
  done

  fail 'Public JavaScript registry DNS still resolves to loopback 30 seconds after teardown.'
}

remove_dns_enforcement() {
  local target
  local temporary
  target="$(hosts_file)"

  if [[ ! -e "$target" ]]; then
    return 0
  fi
  [[ -f "$target" ]] || fail "Hosts path is not a regular file: ${target}."

  temporary="$(mktemp)"
  set +e
  grep -Ev "$MANAGED_HOST_PATTERN" "$target" >"$temporary"
  grep_status=$?
  set -e
  if [[ "$grep_status" -gt 1 ]]; then
    rm -f "$temporary"
    fail "Cannot safely read ${target}."
  fi

  if [[ -n "${SFW_HOSTS_FILE:-}" ]]; then
    cat "$temporary" >"$target" || fail "Cannot update ${target}."
  else
    command -v sudo >/dev/null 2>&1 || fail 'sudo is required to restore /etc/hosts.'
    sudo -n true >/dev/null 2>&1 || fail 'Passwordless sudo is required to restore /etc/hosts.'
    sudo tee "$target" <"$temporary" >/dev/null || fail "Cannot update ${target}."
  fi
  rm -f "$temporary"

  set +e
  grep -Eq "$MANAGED_HOST_PATTERN" "$target"
  grep_status=$?
  set -e
  if [[ "$grep_status" -eq 0 ]]; then
    fail "Socket Firewall DNS entries remain in ${target}."
  elif [[ "$grep_status" -gt 1 ]]; then
    fail "Cannot verify ${target} after teardown."
  fi

  if [[ -z "${SFW_HOSTS_FILE:-}" ]]; then
    flush_and_verify_dns
  fi
}

main() {
  require_environment
  remove_managed_npmrc_blocks
  remove_managed_bunfig
  remove_dns_enforcement
  if [[ "${SFW_ROLLBACK_ONLY:-false}" == 'true' ]]; then
    return
  fi
  write_public_registry_environment
  printf 'active=false\n' >>"$GITHUB_OUTPUT"
  printf 'Socket Firewall disabled; public npm-compatible registry access restored for publication.\n'
}

main "$@"
