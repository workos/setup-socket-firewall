#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/scrub-lockfile.sh"
ACTION="${ROOT}/lockfile-scrub/action.yml"

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
  export GITHUB_WORKSPACE="${CASE_DIR}/workspace"
  export GITHUB_OUTPUT="${CASE_DIR}/github-output"
  mkdir -p "$GITHUB_WORKSPACE"
  : >"$GITHUB_OUTPUT"
  unset SFW_SCRUB_LOCKFILE
}

cleanup_case() {
  rm -rf "$CASE_DIR"
}

write_lockfile() {
  cat >"${GITHUB_WORKSPACE}/bun.lock" <<'JSON'
{
  "lockfileVersion": 1,
  "packages": {
    "left-pad": ["left-pad@1.3.0", "https://socket-firewall.workos.dev/left-pad/-/left-pad-1.3.0.tgz", {}, "sha512-left-pad"],
    "plain": ["plain@1.0.0", "", {}, "sha512-plain"],
    "unrelated": ["unrelated@1.0.0", "https://example.test/pkg.tgz", {}, "sha512-unrelated"]
  }
}
JSON
}

test_clean_lockfile_reports_unchanged() {
  new_case
  printf '{"lockfileVersion":1,"packages":{}}\n' >"${GITHUB_WORKSPACE}/bun.lock"
  cp "${GITHUB_WORKSPACE}/bun.lock" "${CASE_DIR}/before"
  SFW_SCRUB_MODE=check bash "$SCRIPT"
  assert_contains "$GITHUB_OUTPUT" 'changed=false'
  cmp "${CASE_DIR}/before" "${GITHUB_WORKSPACE}/bun.lock" || fail 'clean lockfile changed'
  cleanup_case
}

test_check_mode_does_not_modify_lockfile() {
  new_case
  write_lockfile
  cp "${GITHUB_WORKSPACE}/bun.lock" "${CASE_DIR}/before"
  SFW_SCRUB_MODE=check bash "$SCRIPT"
  assert_contains "$GITHUB_OUTPUT" 'changed=true'
  cmp "${CASE_DIR}/before" "${GITHUB_WORKSPACE}/bun.lock" || fail 'check mode changed lockfile'
  cleanup_case
}

test_apply_mode_restores_native_bun_fields() {
  new_case
  write_lockfile
  chmod 640 "${GITHUB_WORKSPACE}/bun.lock"
  SFW_SCRUB_MODE=apply bash "$SCRIPT"
  assert_contains "$GITHUB_OUTPUT" 'changed=true'
  assert_not_contains "${GITHUB_WORKSPACE}/bun.lock" 'https://socket-firewall.workos.dev/'
  assert_contains "${GITHUB_WORKSPACE}/bun.lock" '"left-pad": ["left-pad@1.3.0", "", {}, "sha512-left-pad"]'
  assert_contains "${GITHUB_WORKSPACE}/bun.lock" '"unrelated": ["unrelated@1.0.0", "https://example.test/pkg.tgz", {}, "sha512-unrelated"]'
  mode="$(stat -c '%a' "${GITHUB_WORKSPACE}/bun.lock" 2>/dev/null || stat -f '%Lp' "${GITHUB_WORKSPACE}/bun.lock")"
  [[ "$mode" == 640 ]] || fail "apply mode changed file mode to ${mode}"
  cleanup_case
}

test_apply_mode_rewrites_multiple_sfw_urls() {
  new_case
  write_lockfile
  cat >>"${GITHUB_WORKSPACE}/bun.lock" <<'JSON'
"second": ["second@1.0.0", "https://socket-firewall.workos.dev/second/-/second-1.0.0.tgz", {}, "sha512-second"]
JSON
  SFW_SCRUB_MODE=apply bash "$SCRIPT"
  assert_not_contains "${GITHUB_WORKSPACE}/bun.lock" 'https://socket-firewall.workos.dev/'
  assert_contains "${GITHUB_WORKSPACE}/bun.lock" '"second": ["second@1.0.0", "", {}, "sha512-second"]'
  cleanup_case
}

test_missing_or_symlink_lockfile_is_rejected() {
  new_case
  set +e
  SFW_SCRUB_MODE=check bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'missing lockfile succeeded'
  printf '{}\n' >"${CASE_DIR}/real-lock"
  ln -s "${CASE_DIR}/real-lock" "${GITHUB_WORKSPACE}/bun.lock"
  set +e
  SFW_SCRUB_MODE=check bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'symlink lockfile succeeded'
  cleanup_case
}

test_invalid_mode_is_rejected() {
  new_case
  write_lockfile
  set +e
  SFW_SCRUB_MODE=replace bash "$SCRIPT" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'invalid mode succeeded'
  cleanup_case
}

test_explicit_nested_bun_lockfile() {
  new_case
  write_lockfile
  cp "${GITHUB_WORKSPACE}/bun.lock" "${CASE_DIR}/before"
  mkdir "${GITHUB_WORKSPACE}/nested dir"
  cp "${GITHUB_WORKSPACE}/bun.lock" "${GITHUB_WORKSPACE}/nested dir/bun.lock"
  SFW_SCRUB_MODE=apply SFW_SCRUB_LOCKFILE='nested dir/bun.lock' bash "$SCRIPT"
  assert_contains "$GITHUB_OUTPUT" 'changed=true'
  assert_not_contains "${GITHUB_WORKSPACE}/nested dir/bun.lock" 'https://socket-firewall.workos.dev/'
  cmp "${CASE_DIR}/before" "${GITHUB_WORKSPACE}/bun.lock" || fail 'unselected root lockfile changed'
  : >"$GITHUB_OUTPUT"
  SFW_SCRUB_MODE=apply SFW_SCRUB_LOCKFILE='nested dir/bun.lock' bash "$SCRIPT"
  assert_contains "$GITHUB_OUTPUT" 'changed=false'
  cleanup_case
}

test_unrecognized_bun_url_fails_without_mutation() {
  new_case
  write_lockfile
  printf 'unquoted https://socket-firewall.workos.dev/broken\n' >>"${GITHUB_WORKSPACE}/bun.lock"
  cp "${GITHUB_WORKSPACE}/bun.lock" "${CASE_DIR}/before"
  for scrub_mode in check apply; do
    if SFW_SCRUB_MODE="$scrub_mode" bash "$SCRIPT" >/dev/null 2>&1; then
      fail 'unrecognized Bun URL succeeded'
    fi
    cmp "${CASE_DIR}/before" "${GITHUB_WORKSPACE}/bun.lock" || fail 'failure modified original lockfile'
    [[ ! -s "$GITHUB_OUTPUT" ]] || fail 'failed scrub emitted success output'
  done
  cleanup_case
}

test_action_wires_changed_output_and_script() {
  assert_contains "$ACTION" 'main: ../scripts/fix-lockfile.mjs'
  assert_contains "$ACTION" 'using: node24'
  assert_contains "$ACTION" 'default: bun.lock'
  assert_contains "$ACTION" 'default: fix'
  assert_contains "$ACTION" 'default: ${{ github.token }}'
}

test_clean_lockfile_reports_unchanged
test_check_mode_does_not_modify_lockfile
test_apply_mode_restores_native_bun_fields
test_apply_mode_rewrites_multiple_sfw_urls
test_missing_or_symlink_lockfile_is_rejected
test_invalid_mode_is_rejected
test_explicit_nested_bun_lockfile
test_unrecognized_bun_url_fails_without_mutation
test_action_wires_changed_output_and_script

printf 'scrub lockfile tests passed\n'
