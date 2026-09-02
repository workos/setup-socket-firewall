#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIGURE="${ROOT}/scripts/configure.sh"
TEARDOWN="${ROOT}/scripts/teardown.sh"

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
  printf '127.0.0.1 localhost\n192.0.2.1 unrelated.example # unrelated\n203.0.113.1 custom.example # workos-sfw custom\n' >"$SFW_HOSTS_FILE"
  printf 'registry=https://registry.npmjs.org/\nalways-auth=true\n' >"$NPM_CONFIG_USERCONFIG"
  printf 'fund=false\n' >"$HOME/.npmrc"
  unset SFW_BUN_CONFIG_PATH SFW_CONFIGURE_BUN XDG_CONFIG_HOME
  unset NODE_AUTH_TOKEN SFW_OWNS_NODE_AUTH_TOKEN_PLACEHOLDER
}

cleanup_case() {
  rm -rf "$CASE_DIR"
}

test_setup_then_teardown_restores_public_registry() {
  new_case
  local token='test-token-remove-me'

  SFW_TOKEN="$token" \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_EVENT_NAME=push \
    bash "$CONFIGURE" >/dev/null

  output="$(bash "$TEARDOWN" 2>&1)"
  [[ "$output" == *'public npm-compatible registry access restored'* ]] || fail 'teardown summary missing'
  assert_contains "$GITHUB_OUTPUT" 'active=true'
  assert_contains "$GITHUB_OUTPUT" 'active=false'

  for npmrc in "$HOME/.npmrc" "$NPM_CONFIG_USERCONFIG"; do
    assert_not_contains "$npmrc" '# >>> workos-sfw >>>'
    assert_not_contains "$npmrc" 'socket-firewall.workos.dev'
    assert_not_contains "$npmrc" "$token"
  done
  assert_contains "$HOME/.npmrc" 'fund=false'
  assert_contains "$NPM_CONFIG_USERCONFIG" 'registry=https://registry.npmjs.org/'
  assert_contains "$NPM_CONFIG_USERCONFIG" 'always-auth=true'

  assert_not_contains "$SFW_HOSTS_FILE" 'registry.npmjs.org # workos-sfw'
  assert_not_contains "$SFW_HOSTS_FILE" 'registry.yarnpkg.com # workos-sfw'
  assert_contains "$SFW_HOSTS_FILE" '127.0.0.1 localhost'
  assert_contains "$SFW_HOSTS_FILE" '192.0.2.1 unrelated.example # unrelated'
  assert_contains "$SFW_HOSTS_FILE" '203.0.113.1 custom.example # workos-sfw custom'

  for key in NPM_CONFIG_REGISTRY PNPM_CONFIG_REGISTRY BUN_CONFIG_REGISTRY; do
    [[ "$(grep -E "^${key}=" "$GITHUB_ENV" | tail -1)" == "${key}=https://registry.npmjs.org/" ]] || fail "${key} was not restored"
  done

  cleanup_case
}

test_teardown_is_idempotent() {
  new_case
  for _ in 1 2; do
    bash "$TEARDOWN" >/dev/null
  done
  assert_contains "$HOME/.npmrc" 'fund=false'
  assert_contains "$NPM_CONFIG_USERCONFIG" 'always-auth=true'
  assert_contains "$SFW_HOSTS_FILE" '192.0.2.1 unrelated.example # unrelated'
  assert_contains "$SFW_HOSTS_FILE" '203.0.113.1 custom.example # workos-sfw custom'
  assert_not_contains "$SFW_HOSTS_FILE" 'registry.npmjs.org # workos-sfw'
  assert_not_contains "$SFW_HOSTS_FILE" 'registry.yarnpkg.com # workos-sfw'
  cleanup_case
}

test_teardown_without_npmrc_succeeds() {
  new_case
  rm -f "$HOME/.npmrc" "$NPM_CONFIG_USERCONFIG"
  bash "$TEARDOWN" >/dev/null
  assert_contains "$GITHUB_OUTPUT" 'active=false'
  assert_contains "$GITHUB_ENV" 'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/'
  cleanup_case
}

test_effective_npmrc_deduplicates_home_path() {
  new_case
  export NPM_CONFIG_USERCONFIG="$HOME/.npmrc"
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_EVENT_NAME=push \
    bash "$CONFIGURE" >/dev/null
  bash "$TEARDOWN" >/dev/null
  assert_not_contains "$HOME/.npmrc" 'socket-firewall.workos.dev'
  assert_contains "$HOME/.npmrc" 'fund=false'
  cleanup_case
}

test_orphaned_sfw_auth_fails_before_public_restore() {
  new_case
  printf '//socket-firewall.workos.dev/:_authToken=orphaned\n' >>"$HOME/.npmrc"
  set +e
  bash "$TEARDOWN" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'orphaned SFW auth was accepted'
  assert_not_contains "$GITHUB_ENV" 'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/'
  cleanup_case
}

test_effective_npmrc_outside_runner_roots_is_rejected() {
  new_case
  NPM_CONFIG_USERCONFIG="$(dirname "$CASE_DIR")/outside.npmrc"
  export NPM_CONFIG_USERCONFIG
  printf 'unrelated=true\n' >"$NPM_CONFIG_USERCONFIG"
  set +e
  bash "$TEARDOWN" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'teardown accepted npmrc outside HOME/RUNNER_TEMP'
  assert_contains "$NPM_CONFIG_USERCONFIG" 'unrelated=true'
  rm -f "$NPM_CONFIG_USERCONFIG"
  cleanup_case
}

test_unreadable_hosts_file_is_not_truncated() {
  new_case
  printf '127.0.0.1 localhost\n' >"$SFW_HOSTS_FILE"
  chmod 000 "$SFW_HOSTS_FILE"
  set +e
  bash "$TEARDOWN" >/dev/null 2>&1
  status=$?
  set -e
  chmod 600 "$SFW_HOSTS_FILE"
  if [[ "$status" -ne 0 ]]; then
    assert_contains "$SFW_HOSTS_FILE" '127.0.0.1 localhost'
  fi
  cleanup_case
}

test_owned_setup_node_placeholder_is_cleared() {
  new_case
  export NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX
  export SFW_OWNS_NODE_AUTH_TOKEN_PLACEHOLDER=true

  bash "$TEARDOWN" >/dev/null

  grep -Fqx 'NODE_AUTH_TOKEN=' "$GITHUB_ENV" || fail 'owned NODE_AUTH_TOKEN placeholder was not cleared exactly'
  assert_contains "$GITHUB_ENV" 'SFW_OWNS_NODE_AUTH_TOKEN_PLACEHOLDER=false'
  cleanup_case
}

test_caller_replacement_token_is_preserved() {
  new_case
  export NODE_AUTH_TOKEN=caller-owned-token
  export SFW_OWNS_NODE_AUTH_TOKEN_PLACEHOLDER=true

  bash "$TEARDOWN" >/dev/null

  if grep -Eq '^NODE_AUTH_TOKEN=' "$GITHUB_ENV"; then
    fail 'caller-owned NODE_AUTH_TOKEN was cleared'
  fi
  assert_contains "$GITHUB_ENV" 'SFW_OWNS_NODE_AUTH_TOKEN_PLACEHOLDER=false'
  cleanup_case
}

test_bun_config_is_removed() {
  new_case
  export XDG_CONFIG_HOME="$CASE_DIR/xdg"
  mkdir -p "$XDG_CONFIG_HOME"
  SFW_TOKEN=test-token \
    SFW_ALLOW_EXTERNAL_FORK_FALLBACK=false \
    SFW_CONFIGURE_BUN=true \
    SFW_EVENT_NAME=push \
    bash "$CONFIGURE" >/dev/null
  bunfig="$XDG_CONFIG_HOME/.bunfig.toml"
  export SFW_BUN_CONFIG_PATH="$bunfig"
  assert_contains "$bunfig" 'test-token'
  bash "$TEARDOWN" >/dev/null
  [[ ! -e "$bunfig" ]] || fail 'marker-only Bun config was not removed'
  cleanup_case
}

test_setup_then_teardown_restores_public_registry
test_teardown_is_idempotent
test_teardown_without_npmrc_succeeds
test_effective_npmrc_deduplicates_home_path
test_orphaned_sfw_auth_fails_before_public_restore
test_effective_npmrc_outside_runner_roots_is_rejected
test_unreadable_hosts_file_is_not_truncated
test_owned_setup_node_placeholder_is_cleared
test_caller_replacement_token_is_preserved
test_bun_config_is_removed

printf 'teardown tests passed\n'
