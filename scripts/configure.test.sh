#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/configure.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  grep -Fq "$2" "$1" || fail "${1} does not contain: ${2}"
}

assert_not_contains() {
  if grep -Fq "$2" "$1" 2>/dev/null; then
    fail "${1} unexpectedly contains: ${2}"
  fi
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

new_case() {
  CASE_DIR="$(mktemp -d)"
  export HOME="${CASE_DIR}/home"
  export RUNNER_TEMP="$CASE_DIR"
  export GITHUB_ENV="${CASE_DIR}/github-env"
  export GITHUB_OUTPUT="${CASE_DIR}/github-output"
  export SFW_HOSTS_FILE="${CASE_DIR}/hosts"
  export NPM_CONFIG_USERCONFIG="${CASE_DIR}/setup-node.npmrc"
  mkdir -p "$HOME"
  : >"$GITHUB_ENV"
  : >"$GITHUB_OUTPUT"
  printf '127.0.0.1 localhost\n' >"$SFW_HOSTS_FILE"
  # setup-node writes this file without guaranteeing a trailing newline.
  printf 'registry=https://registry.npmjs.org/' >"$NPM_CONFIG_USERCONFIG"
  unset SFW_TOKEN SFW_ALLOW_EXTERNAL_FORK_FALLBACK SFW_CONFIGURE_BUN SFW_BUN_CONFIG_PATH SFW_EVENT_NAME
  unset SFW_REPOSITORY_PRIVATE SFW_HEAD_REPOSITORY SFW_BASE_REPOSITORY XDG_CONFIG_HOME
}

cleanup_case() {
  rm -rf "$CASE_DIR"
}

test_active_configuration() {
  new_case
  local token='test-token-must-not-be-logged'
  printf 'fund=false\n' >"$HOME/.npmrc"

  output="$(
    SFW_TOKEN="$token" \
      SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
      SFW_EVENT_NAME=push \
      bash "$SCRIPT" 2>&1
  )"

  [[ "$output" != *"$token"* ]] || fail 'token was written to output'
  assert_contains "$GITHUB_OUTPUT" 'active=true'
  for key in NPM_CONFIG_REGISTRY PNPM_CONFIG_REGISTRY BUN_CONFIG_REGISTRY; do
    assert_contains "$GITHUB_ENV" "${key}=https://socket-firewall.workos.dev/"
  done

  for npmrc in "$HOME/.npmrc" "$NPM_CONFIG_USERCONFIG"; do
    assert_contains "$npmrc" '# >>> workos-sfw >>>'
    assert_contains "$npmrc" 'registry=https://socket-firewall.workos.dev/'
    assert_contains "$npmrc" "//socket-firewall.workos.dev/:_authToken=${token}"
    assert_contains "$npmrc" 'replace-registry-host=always'
    [[ "$(file_mode "$npmrc")" == '600' ]] || fail "${npmrc} is not mode 600"
  done
  assert_contains "$HOME/.npmrc" 'fund=false'
  assert_contains "$NPM_CONFIG_USERCONFIG" 'registry=https://registry.npmjs.org/'

  for host in registry.npmjs.org registry.yarnpkg.com; do
    assert_contains "$SFW_HOSTS_FILE" "127.0.0.1 ${host} # workos-sfw"
    assert_contains "$SFW_HOSTS_FILE" "::1 ${host} # workos-sfw"
  done

  cleanup_case
}

test_active_configuration_is_idempotent() {
  new_case
  for _ in 1 2; do
    SFW_TOKEN=test-token \
      SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
      SFW_EVENT_NAME=push \
      bash "$SCRIPT" >/dev/null
  done

  [[ "$(grep -c '^# >>> workos-sfw >>>$' "$HOME/.npmrc")" -eq 1 ]] || fail 'home npmrc marker duplicated'
  [[ "$(grep -c '^# >>> workos-sfw >>>$' "$NPM_CONFIG_USERCONFIG")" -eq 1 ]] || fail 'effective npmrc marker duplicated'
  [[ "$(grep -c 'registry.npmjs.org # workos-sfw$' "$SFW_HOSTS_FILE")" -eq 2 ]] || fail 'npmjs hosts duplicated'
  [[ "$(grep -c 'registry.yarnpkg.com # workos-sfw$' "$SFW_HOSTS_FILE")" -eq 2 ]] || fail 'yarn hosts duplicated'

  cleanup_case
}

test_strict_missing_token_fails_closed() {
  new_case
  set +e
  output="$(
    SFW_TOKEN='' \
      SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
      SFW_EVENT_NAME=push \
      bash "$SCRIPT" 2>&1
  )"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail 'strict missing-token path succeeded'
  [[ "$output" == *'SOCKET_FIREWALL_TOKEN is unavailable'* ]] || fail 'strict failure was not actionable'
  assert_contains "$GITHUB_OUTPUT" 'active=false'
  assert_not_contains "$SFW_HOSTS_FILE" '# workos-sfw'
  [[ ! -e "$HOME/.npmrc" ]] || fail 'strict failure created home npmrc'

  cleanup_case
}

test_public_external_fork_fallback() {
  new_case
  output="$(
    SFW_TOKEN='' \
      SFW_ALLOW_EXTERNAL_FORK_FALLBACK=true \
      SFW_EVENT_NAME=pull_request \
      SFW_REPOSITORY_PRIVATE=false \
      SFW_HEAD_REPOSITORY=contributor/example \
      SFW_BASE_REPOSITORY=workos/example \
      bash "$SCRIPT" 2>&1
  )"

  [[ "$output" == *'explicitly permitted public external-fork'* ]] || fail 'fallback warning missing'
  assert_contains "$GITHUB_OUTPUT" 'active=false'
  assert_contains "$GITHUB_ENV" 'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/'
  assert_not_contains "$SFW_HOSTS_FILE" '# workos-sfw'
  [[ ! -e "$HOME/.npmrc" ]] || fail 'fallback created home npmrc'

  cleanup_case
}

test_fallback_context_is_enforced() {
  local private_value head base allow
  for case_name in no-opt-in private same-repo incomplete; do
    new_case
    private_value=false
    head=contributor/example
    base=workos/example
    allow=true
    case "$case_name" in
      no-opt-in) allow=false ;;
      private) private_value=true ;;
      same-repo) head=workos/example ;;
      incomplete) head='' ;;
    esac

    set +e
    SFW_TOKEN='' \
      SFW_ALLOW_EXTERNAL_FORK_FALLBACK="$allow" \
      SFW_EVENT_NAME=pull_request \
      SFW_REPOSITORY_PRIVATE="$private_value" \
      SFW_HEAD_REPOSITORY="$head" \
      SFW_BASE_REPOSITORY="$base" \
      bash "$SCRIPT" >/dev/null 2>&1
    status=$?
    set -e
    [[ "$status" -ne 0 ]] || fail "unsafe fallback succeeded: ${case_name}"
    assert_contains "$GITHUB_OUTPUT" 'active=false'
    cleanup_case
  done
}

test_pull_request_target_is_rejected() {
  new_case
  set +e
  output="$(
    SFW_TOKEN=test-token \
      SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
      SFW_EVENT_NAME=pull_request_target \
      bash "$SCRIPT" 2>&1
  )"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail 'pull_request_target path succeeded'
  [[ "$output" == *'pull_request_target jobs may not activate'* ]] || fail 'pull_request_target failure was not actionable'
  assert_contains "$GITHUB_OUTPUT" 'active=false'
  assert_not_contains "$SFW_HOSTS_FILE" '# workos-sfw'

  cleanup_case
}

test_invalid_fallback_input_is_rejected() {
  new_case
  set +e
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=yes \
    SFW_EVENT_NAME=push \
    bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'invalid fallback input succeeded'
  cleanup_case
}

test_token_newline_is_rejected() {
  new_case
  set +e
  SFW_TOKEN=$'test-token\ninjected=true' \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_EVENT_NAME=push \
    bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'newline-bearing token succeeded'
  assert_not_contains "$NPM_CONFIG_USERCONFIG" 'injected=true'
  cleanup_case
}

test_effective_npmrc_deduplicates_home_path() {
  new_case
  export NPM_CONFIG_USERCONFIG="$HOME/.npmrc"
  printf 'fund=false\n' >"$HOME/.npmrc"
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_EVENT_NAME=push \
    bash "$SCRIPT" >/dev/null
  [[ "$(grep -c '^# >>> workos-sfw >>>$' "$HOME/.npmrc")" -eq 1 ]] || fail 'same npmrc path was configured twice'
  cleanup_case
}

test_effective_npmrc_outside_runner_roots_is_rejected() {
  new_case
  export NPM_CONFIG_USERCONFIG="$(dirname "$CASE_DIR")/outside.npmrc"
  set +e
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_EVENT_NAME=push \
    bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'npmrc outside HOME/RUNNER_TEMP succeeded'
  [[ ! -e "$NPM_CONFIG_USERCONFIG" ]] || fail 'outside npmrc was created'
  assert_not_contains "$SFW_HOSTS_FILE" '# workos-sfw'
  cleanup_case
}

test_partial_dns_failure_rolls_back_npm_config() {
  new_case
  export SFW_HOSTS_FILE="$CASE_DIR/hosts-directory"
  mkdir "$SFW_HOSTS_FILE"
  set +e
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_EVENT_NAME=push \
    bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'invalid hosts path succeeded'
  [[ ! -e "$HOME/.npmrc" ]] || assert_not_contains "$HOME/.npmrc" 'socket-firewall.workos.dev'
  assert_not_contains "$NPM_CONFIG_USERCONFIG" 'socket-firewall.workos.dev'
  assert_not_contains "$GITHUB_ENV" 'socket-firewall.workos.dev'
  assert_not_contains "$GITHUB_ENV" 'NPM_CONFIG_REGISTRY='
  assert_contains "$GITHUB_OUTPUT" 'active=false'
  cleanup_case
}

test_bun_config_is_explicit_and_restrictive() {
  new_case
  export XDG_CONFIG_HOME="$CASE_DIR/xdg"
  mkdir -p "$XDG_CONFIG_HOME"
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_CONFIGURE_BUN=true \
    SFW_EVENT_NAME=push \
    bash "$SCRIPT" >/dev/null
  bunfig="$XDG_CONFIG_HOME/.bunfig.toml"
  assert_contains "$bunfig" '# >>> workos-sfw >>>'
  assert_contains "$bunfig" 'registry = { url = "https://socket-firewall.workos.dev/", token = "test-token" }'
  assert_contains "$GITHUB_ENV" "SFW_BUN_CONFIG_PATH=$bunfig"
  [[ "$(file_mode "$bunfig")" == '600' ]] || fail 'bunfig is not mode 600'
  cleanup_case
}

test_existing_global_bun_config_fails_closed() {
  new_case
  printf '[install]\ncache = false\n' >"$HOME/.bunfig.toml"
  set +e
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_CONFIGURE_BUN=true \
    SFW_EVENT_NAME=push \
    bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'existing global Bun config was overwritten'
  assert_contains "$HOME/.bunfig.toml" 'cache = false'
  assert_not_contains "$HOME/.bunfig.toml" 'test-token'
  assert_not_contains "$GITHUB_ENV" 'NPM_CONFIG_REGISTRY='
  cleanup_case
}

test_active_configuration
test_active_configuration_is_idempotent
test_strict_missing_token_fails_closed
test_public_external_fork_fallback
test_fallback_context_is_enforced
test_pull_request_target_is_rejected
test_invalid_fallback_input_is_rejected
test_token_newline_is_rejected
test_effective_npmrc_deduplicates_home_path
test_effective_npmrc_outside_runner_roots_is_rejected
test_partial_dns_failure_rolls_back_npm_config
test_bun_config_is_explicit_and_restrictive
test_existing_global_bun_config_fails_closed

printf 'configure tests passed\n'
