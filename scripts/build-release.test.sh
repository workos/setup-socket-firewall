#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASE_DIR="$(mktemp -d)"
trap 'rm -rf "$CASE_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

expect_build_failure() {
  set +e
  "$@" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "command unexpectedly succeeded: $*"
}

prepare_source_copy() {
  local destination="$1"
  mkdir -p "$destination/scripts" "$destination/teardown" "$destination/lockfile-scrub"
  cp "$ROOT/LICENSE" "$ROOT/action.yml" "$ROOT/release-manifest.txt" "$destination/"
  cp "$ROOT/teardown/action.yml" "$destination/teardown/"
  cp "$ROOT/lockfile-scrub/action.yml" "$destination/lockfile-scrub/"
  cp "$ROOT/scripts/build-release.sh" "$ROOT/scripts/configure.sh" "$ROOT/scripts/teardown.sh" "$ROOT/scripts/scrub-lockfile.sh" "$ROOT/scripts/scrub-npm-lockfile.mjs" "$ROOT/scripts/fix-lockfile.mjs" "$destination/scripts/"
}

"${ROOT}/scripts/build-release.sh" "${CASE_DIR}/release" >/dev/null

# A trailing slash must identify the requested directory, not a nested child.
mkdir "${CASE_DIR}/trailing"
"${ROOT}/scripts/build-release.sh" "${CASE_DIR}/trailing/" >/dev/null
[[ -f "${CASE_DIR}/trailing/action.yml" ]] || fail 'trailing-slash output did not contain action.yml at its root'
[[ ! -e "${CASE_DIR}/trailing/trailing" ]] || fail 'trailing-slash output was nested'

for dangerous in "$ROOT" "$(dirname "$ROOT")"; do
  expect_build_failure "${ROOT}/scripts/build-release.sh" "$dangerous"
  [[ -f "${ROOT}/action.yml" ]] || fail "repository source was deleted while rejecting: ${dangerous}"
done

mkdir "${CASE_DIR}/nonempty"
printf 'preserve me\n' >"${CASE_DIR}/nonempty/sentinel"
expect_build_failure "${ROOT}/scripts/build-release.sh" "${CASE_DIR}/nonempty"
grep -Fq 'preserve me' "${CASE_DIR}/nonempty/sentinel" || fail 'non-empty release directory was modified'

ln -s "$ROOT" "${CASE_DIR}/symlink-output"
expect_build_failure "${ROOT}/scripts/build-release.sh" "${CASE_DIR}/symlink-output"
[[ -f "${ROOT}/action.yml" ]] || fail 'symlink output modified repository source'

# Unsafe or missing manifest entries fail before publishing any staged output.
traversal_source="${CASE_DIR}/traversal-source"
prepare_source_copy "$traversal_source"
printf 'preserve me\n' >"${CASE_DIR}/escape"
printf '../escape\n' >>"${traversal_source}/release-manifest.txt"
expect_build_failure "${traversal_source}/scripts/build-release.sh" "${CASE_DIR}/traversal-output"
grep -Fq 'preserve me' "${CASE_DIR}/escape" || fail 'manifest traversal modified a file outside staging'
[[ ! -e "${CASE_DIR}/traversal-output" ]] || fail 'manifest traversal left output behind'

missing_source="${CASE_DIR}/missing-source"
prepare_source_copy "$missing_source"
printf 'scripts/missing.sh\n' >>"${missing_source}/release-manifest.txt"
expect_build_failure "${missing_source}/scripts/build-release.sh" "${CASE_DIR}/missing-output"
[[ ! -e "${CASE_DIR}/missing-output" ]] || fail 'missing manifest entry left partial output behind'

mkdir "${CASE_DIR}/existing-empty-output"
expect_build_failure "${missing_source}/scripts/build-release.sh" "${CASE_DIR}/existing-empty-output"
[[ -d "${CASE_DIR}/existing-empty-output" ]] || fail 'failed build removed caller-owned empty output directory'
[[ -z "$(find "${CASE_DIR}/existing-empty-output" -mindepth 1 -print -quit)" ]] || fail 'failed build dirtied caller-owned empty output directory'

syntax_source="${CASE_DIR}/syntax-source"
prepare_source_copy "$syntax_source"
printf '\nif then\n' >>"${syntax_source}/scripts/configure.sh"
expect_build_failure "${syntax_source}/scripts/build-release.sh" "${CASE_DIR}/syntax-output"
[[ ! -e "${CASE_DIR}/syntax-output" ]] || fail 'syntax failure left partial output behind'

# A prepared fixture must build successfully before corrupting a runtime file.
node_source="${CASE_DIR}/node-source"
prepare_source_copy "$node_source"
"${node_source}/scripts/build-release.sh" "${CASE_DIR}/node-valid" >/dev/null
printf '\nconst = ;\n' >>"${node_source}/scripts/scrub-npm-lockfile.mjs"
expect_build_failure "${node_source}/scripts/build-release.sh" "${CASE_DIR}/node-invalid"
[[ ! -e "${CASE_DIR}/node-invalid" ]] || fail 'npm syntax failure left output behind'

expected="${CASE_DIR}/expected"
actual="${CASE_DIR}/actual"
grep -Ev '^[[:space:]]*(#|$)' "${ROOT}/release-manifest.txt" | LC_ALL=C sort >"$expected"
(
  cd "${CASE_DIR}/release"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort
) >"$actual"
diff -u "$expected" "$actual"

for forbidden in README.md package.json package-lock.json reports tools .github scripts/configure.test.sh scripts/teardown.test.sh scripts/scrub-lockfile.test.sh scripts/scrub-npm-lockfile.test.mjs scripts/fix-lockfile.test.mjs scripts/build-release.sh scripts/build-release.test.sh scripts/publish-release.sh scripts/publish-release.test.sh; do
  [[ ! -e "${CASE_DIR}/release/${forbidden}" ]] || fail "forbidden release path present: ${forbidden}"
done

[[ -x "${CASE_DIR}/release/scripts/configure.sh" ]] || fail 'configure.sh lost executable mode'
[[ -x "${CASE_DIR}/release/scripts/teardown.sh" ]] || fail 'teardown.sh lost executable mode'
# The GraphQL publisher creates new files as 100644. This helper is invoked via
# bash (including the packaged controller below), so it needs no executable bit.
[[ ! -x "${CASE_DIR}/release/scripts/scrub-lockfile.sh" ]] || fail 'scrub-lockfile.sh must be non-executable for signed publication'

grep -Fq 'bash "$GITHUB_ACTION_PATH/scripts/configure.sh"' "${CASE_DIR}/release/action.yml" || fail 'root action does not invoke its shipped configure script'
grep -Fq 'bash "$GITHUB_ACTION_PATH/../scripts/teardown.sh"' "${CASE_DIR}/release/teardown/action.yml" || fail 'teardown action does not invoke its shipped teardown script'
grep -Fq 'main: ../scripts/fix-lockfile.mjs' "${CASE_DIR}/release/lockfile-scrub/action.yml" || fail 'lockfile action does not invoke its shipped branch fixer'
SFW_TEST_FIX_MODULE="${CASE_DIR}/release/scripts/fix-lockfile.mjs" node --test "${ROOT}/scripts/fix-lockfile.test.mjs" >/dev/null

# Run the shipped wrapper from the isolated release tree, not the source tree.
mkdir "${CASE_DIR}/npm-workspace"
printf '{"lockfileVersion":3,"resolved":"https://socket-firewall.workos.dev/pkg/-/pkg-1.tgz"}\n' >"${CASE_DIR}/npm-workspace/package-lock.json"
GITHUB_WORKSPACE="${CASE_DIR}/npm-workspace" GITHUB_OUTPUT="${CASE_DIR}/npm-output" \
  SFW_SCRUB_MODE=apply SFW_SCRUB_LOCKFILE=package-lock.json \
  bash "${CASE_DIR}/release/scripts/scrub-lockfile.sh"
grep -Fq 'https://registry.npmjs.org/pkg/-/pkg-1.tgz' "${CASE_DIR}/npm-workspace/package-lock.json" || fail 'shipped npm scrub failed'
grep -Fxq 'changed=true' "${CASE_DIR}/npm-output" || fail 'shipped npm scrub output missing'

printf 'release tree tests passed\n'
