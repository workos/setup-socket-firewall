#!/usr/bin/env bash
set -euo pipefail

SFW_REGISTRY='https://socket-firewall.workos.dev/'
PUBLIC_REGISTRY='https://registry.npmjs.org/'
NPMRC_BEGIN='# >>> workos-sfw >>>'
NPMRC_END='# <<< workos-sfw <<<'
BUNFIG_BEGIN='# >>> workos-sfw >>>'
BUNFIG_END='# <<< workos-sfw <<<'
HOST_MARKER='# workos-sfw'
PUBLIC_REGISTRY_HOSTS=(registry.npmjs.org registry.yarnpkg.com)

fail() {
  printf '::error title=Socket Firewall setup failed::%s\n' "$1" >&2
  printf 'active=false\n' >>"$GITHUB_OUTPUT"
  exit 1
}

warn() {
  printf '::warning title=Socket Firewall not active::%s\n' "$1"
}

require_environment() {
  [[ -n "${GITHUB_ENV:-}" ]] || {
    printf 'GITHUB_ENV is required\n' >&2
    exit 1
  }
  [[ -n "${GITHUB_OUTPUT:-}" ]] || {
    printf 'GITHUB_OUTPUT is required\n' >&2
    exit 1
  }
  [[ -n "${HOME:-}" ]] || fail 'HOME is required.'
  for command_name in sed chmod mktemp grep mkdir cat touch rm dirname pwd; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: ${command_name}."
  done
}

write_registry_environment() {
  local registry="$1"
  {
    printf 'NPM_CONFIG_REGISTRY=%s\n' "$registry"
    printf 'PNPM_CONFIG_REGISTRY=%s\n' "$registry"
    printf 'BUN_CONFIG_REGISTRY=%s\n' "$registry"
  } >>"$GITHUB_ENV"
}

configure_setup_node_placeholder() {
  local npmrc="${NPM_CONFIG_USERCONFIG:-${HOME}/.npmrc}"
  if [[ -z "${NODE_AUTH_TOKEN:-}" && -f "$npmrc" ]] && grep -Fq '${NODE_AUTH_TOKEN}' "$npmrc"; then
    export NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX
    export SFW_OWNS_NODE_AUTH_TOKEN_PLACEHOLDER=true
    {
      printf 'NODE_AUTH_TOKEN=%s\n' "$NODE_AUTH_TOKEN"
      printf 'SFW_OWNS_NODE_AUTH_TOKEN_PLACEHOLDER=true\n'
    } >>"$GITHUB_ENV"
  fi
}

strip_managed_npmrc_block() {
  local source="$1"
  local destination="$2"
  if [[ -f "$source" ]]; then
    sed "/^${NPMRC_BEGIN}$/,/^${NPMRC_END}$/d" "$source" >"$destination"
  else
    : >"$destination"
  fi
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
    (-z "$real_runner" || ("$real_parent" != "$real_runner" && "$real_parent" != "$real_runner/"*)) ]]; then
    fail "Managed config path must be inside HOME or RUNNER_TEMP: ${npmrc}."
  fi
}

validate_npmrc_files() {
  local home_npmrc="${HOME}/.npmrc"
  mkdir -p "$HOME"
  validate_config_path "$home_npmrc"
  if [[ -n "${NPM_CONFIG_USERCONFIG:-}" && "$NPM_CONFIG_USERCONFIG" != "$home_npmrc" ]]; then
    validate_config_path "$NPM_CONFIG_USERCONFIG"
  fi
}

configure_npmrc() {
  local npmrc="$1"
  local temporary

  umask 077
  touch "$npmrc"
  chmod 600 "$npmrc"
  temporary="$(mktemp)"
  strip_managed_npmrc_block "$npmrc" "$temporary"
  {
    cat "$temporary"
    printf '\n%s\n' "$NPMRC_BEGIN"
    printf 'registry=%s\n' "$SFW_REGISTRY"
    printf '//socket-firewall.workos.dev/:_authToken=%s\n' "$SFW_TOKEN"
    printf 'replace-registry-host=always\n'
    printf '%s\n' "$NPMRC_END"
  } >"$npmrc"
  chmod 600 "$npmrc"
  rm -f "$temporary"
}

configure_npmrc_files() {
  local home_npmrc="${HOME}/.npmrc"
  configure_npmrc "$home_npmrc"

  if [[ -n "${NPM_CONFIG_USERCONFIG:-}" && "$NPM_CONFIG_USERCONFIG" != "$home_npmrc" ]]; then
    configure_npmrc "$NPM_CONFIG_USERCONFIG"
  fi
}

configure_bunfig() {
  local base bunfig temporary
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    base="$XDG_CONFIG_HOME"
  else
    base="$HOME"
  fi

  case "$base" in
    "$HOME" | "$HOME"/* | "${RUNNER_TEMP:-}" | "${RUNNER_TEMP:-}"/*) ;;
    *) fail "Bun config directory must be inside HOME or RUNNER_TEMP: ${base}." ;;
  esac
  mkdir -p "$base"
  bunfig="${base}/.bunfig.toml"
  validate_config_path "$bunfig"

  umask 077
  touch "$bunfig"
  chmod 600 "$bunfig"
  temporary="$(mktemp)"
  sed "/^${BUNFIG_BEGIN}$/,/^${BUNFIG_END}$/d" "$bunfig" >"$temporary"
  if grep -Eq '^[[:space:]]*[^#[:space:]]' "$temporary"; then
    rm -f "$temporary"
    fail "Existing global Bun config is unsupported: ${bunfig}."
  fi
  {
    cat "$temporary"
    printf '\n%s\n' "$BUNFIG_BEGIN"
    printf '[install]\n'
    printf 'registry = { url = "%s", token = "%s" }\n' "$SFW_REGISTRY" "$SFW_TOKEN"
    printf '%s\n' "$BUNFIG_END"
  } >"$bunfig"
  chmod 600 "$bunfig"
  rm -f "$temporary"
  export SFW_BUN_CONFIG_PATH="$bunfig"
  printf 'SFW_BUN_CONFIG_PATH=%s\n' "$bunfig" >>"$GITHUB_ENV"
}

hosts_file() {
  printf '%s' "${SFW_HOSTS_FILE:-/etc/hosts}"
}

append_host_line() {
  local line="$1"
  local target
  target="$(hosts_file)"

  if grep -Fqx "$line" "$target" 2>/dev/null; then
    return
  fi

  if [[ -n "${SFW_HOSTS_FILE:-}" ]]; then
    printf '%s\n' "$line" >>"$target" || fail "Cannot write ${target}."
  else
    command -v sudo >/dev/null 2>&1 || fail 'sudo is required to update /etc/hosts.'
    sudo -n true >/dev/null 2>&1 || fail 'Passwordless sudo is required to update /etc/hosts.'
    printf '%s\n' "$line" | sudo tee -a "$target" >/dev/null || fail "Cannot write ${target}."
  fi
}

configure_dns_enforcement() {
  local host
  local target
  target="$(hosts_file)"

  if [[ -n "${SFW_HOSTS_FILE:-}" ]]; then
    touch "$target" || fail "Cannot create ${target}."
  elif [[ ! -f "$target" ]]; then
    fail "Hosts file does not exist: ${target}."
  fi

  for host in "${PUBLIC_REGISTRY_HOSTS[@]}"; do
    append_host_line "127.0.0.1 ${host} ${HOST_MARKER}"
    append_host_line "::1 ${host} ${HOST_MARKER}"
  done
}

is_public_external_fork() {
  [[ "${SFW_EVENT_NAME:-}" == 'pull_request' ]] &&
    [[ "${SFW_REPOSITORY_PRIVATE:-}" == 'false' ]] &&
    [[ -n "${SFW_HEAD_REPOSITORY:-}" ]] &&
    [[ -n "${SFW_BASE_REPOSITORY:-}" ]] &&
    [[ "$SFW_HEAD_REPOSITORY" != "$SFW_BASE_REPOSITORY" ]]
}

rollback_partial_configuration() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "${SFW_MUTATED:-false}" == 'true' ]]; then
    if ! SFW_ROLLBACK_ONLY=true bash "$(dirname "${BASH_SOURCE[0]}")/teardown.sh" >/dev/null; then
      printf '::warning title=Socket Firewall rollback incomplete::Partial setup cleanup failed; discard this runner and inspect npm/Bun config plus /etc/hosts.\n' >&2
    fi
  fi
  exit "$status"
}

main() {
  require_environment
  SFW_ALLOW_EXTERNAL_FORK_FALLBACK="${SFW_ALLOW_EXTERNAL_FORK_FALLBACK:-false}"
  SFW_CONFIGURE_BUN="${SFW_CONFIGURE_BUN:-false}"

  case "$SFW_ALLOW_EXTERNAL_FORK_FALLBACK" in
    true | false) ;;
    *) fail 'allow-external-fork-fallback must be true or false.' ;;
  esac
  case "$SFW_CONFIGURE_BUN" in
    true | false) ;;
    *) fail 'configure-bun must be true or false.' ;;
  esac

  if [[ "${SFW_EVENT_NAME:-}" == 'pull_request_target' ]]; then
    fail 'Install-bearing pull_request_target jobs may not activate Socket Firewall; use a trusted workflow boundary.'
  fi

  if [[ -z "${SFW_TOKEN:-}" ]]; then
    if [[ "$SFW_ALLOW_EXTERNAL_FORK_FALLBACK" == 'true' ]] && is_public_external_fork; then
      configure_setup_node_placeholder
      write_registry_environment "$PUBLIC_REGISTRY"
      printf 'active=false\n' >>"$GITHUB_OUTPUT"
      warn 'SOCKET_FIREWALL_TOKEN is unavailable in this explicitly permitted public external-fork pull request; public npm remains reachable.'
      return
    fi

    fail 'SOCKET_FIREWALL_TOKEN is unavailable outside an explicitly permitted public external-fork pull request.'
  fi

  if [[ "$SFW_TOKEN" == *$'\n'* || "$SFW_TOKEN" == *$'\r'* || "$SFW_TOKEN" == *'"'* || "$SFW_TOKEN" == *'\\'* ]]; then
    fail 'SOCKET_FIREWALL_TOKEN contains characters that cannot be written safely.'
  fi

  validate_npmrc_files
  SFW_MUTATED=true
  trap rollback_partial_configuration EXIT
  configure_dns_enforcement
  configure_npmrc_files
  if [[ "$SFW_CONFIGURE_BUN" == 'true' ]]; then
    configure_bunfig
  fi
  configure_setup_node_placeholder
  write_registry_environment "$SFW_REGISTRY"
  printf 'active=true\n' >>"$GITHUB_OUTPUT"
  trap - EXIT
  printf 'Socket Firewall active for public npm-compatible dependency downloads; known public JS registries are DNS-null-routed.\n'
}

main "$@"
