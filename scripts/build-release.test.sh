#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASE_DIR="$(mktemp -d)"
trap 'rm -rf "$CASE_DIR"' EXIT

"${ROOT}/scripts/build-release.sh" "${CASE_DIR}/release" >/dev/null

for dangerous in "$ROOT" "$(dirname "$ROOT")"; do
  set +e
  "${ROOT}/scripts/build-release.sh" "$dangerous" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || {
    printf 'dangerous release output was accepted: %s\n' "$dangerous" >&2
    exit 1
  }
  [[ -f "${ROOT}/action.yml" ]] || {
    printf 'repository source was deleted while rejecting: %s\n' "$dangerous" >&2
    exit 1
  }
done

mkdir "${CASE_DIR}/nonempty"
printf 'preserve me\n' >"${CASE_DIR}/nonempty/sentinel"
set +e
"${ROOT}/scripts/build-release.sh" "${CASE_DIR}/nonempty" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] || {
  printf 'non-empty release directory was accepted\n' >&2
  exit 1
}
grep -Fq 'preserve me' "${CASE_DIR}/nonempty/sentinel" || {
  printf 'non-empty release directory was modified\n' >&2
  exit 1
}

expected="${CASE_DIR}/expected"
actual="${CASE_DIR}/actual"
grep -Ev '^[[:space:]]*(#|$)' "${ROOT}/release-manifest.txt" | LC_ALL=C sort >"$expected"
(
  cd "${CASE_DIR}/release"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort
) >"$actual"
diff -u "$expected" "$actual"

for forbidden in README.md package.json package-lock.json reports tools .github scripts/configure.test.sh scripts/teardown.test.sh scripts/build-release.sh scripts/build-release.test.sh; do
  [[ ! -e "${CASE_DIR}/release/${forbidden}" ]] || {
    printf 'forbidden release path present: %s\n' "$forbidden" >&2
    exit 1
  }
done

[[ -x "${CASE_DIR}/release/scripts/configure.sh" ]] || {
  printf 'configure.sh lost executable mode\n' >&2
  exit 1
}
[[ -x "${CASE_DIR}/release/scripts/teardown.sh" ]] || {
  printf 'teardown.sh lost executable mode\n' >&2
  exit 1
}

grep -Fq 'bash "$GITHUB_ACTION_PATH/scripts/configure.sh"' "${CASE_DIR}/release/action.yml" || {
  printf 'root action does not invoke its shipped configure script\n' >&2
  exit 1
}
grep -Fq 'bash "$GITHUB_ACTION_PATH/../scripts/teardown.sh"' "${CASE_DIR}/release/teardown/action.yml" || {
  printf 'teardown action does not invoke its shipped teardown script\n' >&2
  exit 1
}

printf 'release tree tests passed\n'
