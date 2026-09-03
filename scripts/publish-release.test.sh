#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASE_DIR="$(mktemp -d)"
trap 'rm -rf "$CASE_DIR"' EXIT

TREE_SHA='2222222222222222222222222222222222222222'
EXISTING_SHA='3333333333333333333333333333333333333333'
OTHER_TREE_SHA='4444444444444444444444444444444444444444'
NEW_SHA='5555555555555555555555555555555555555555'
SOURCE_SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_line() {
  grep -Fqx "$2" "$1" || fail "${1} does not contain exact line: ${2}"
}

new_state() {
  STATE_DIR="$(mktemp -d "${CASE_DIR}/state.XXXXXX")"
  export FAKE_GH_STATE="$STATE_DIR"
  : >"${STATE_DIR}/calls"
  printf '0\n' >"${STATE_DIR}/counter"
  export GITHUB_OUTPUT="${STATE_DIR}/github-output"
  : >"$GITHUB_OUTPUT"
}

fake_gh="${CASE_DIR}/gh"
cat >"$fake_gh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

method=GET
endpoint=''
input=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    api) shift ;;
    --method) method="$2"; shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --jq) shift 2 ;;
    --silent) shift ;;
    *)
      if [[ -z "$endpoint" ]]; then endpoint="$1"; fi
      shift
      ;;
  esac
done

counter="$(cat "${FAKE_GH_STATE}/counter")"
counter=$((counter + 1))
printf '%s\n' "$counter" >"${FAKE_GH_STATE}/counter"
printf '%s %s\n' "$method" "$endpoint" >>"${FAKE_GH_STATE}/calls"
if [[ -n "$input" ]]; then
  cp "$input" "${FAKE_GH_STATE}/payload.${counter}.json"
fi

case "$endpoint" in
  */git/blobs)
    printf '1111111111111111111111111111111111111111\n'
    ;;
  */git/trees)
    printf '2222222222222222222222222222222222222222\n'
    ;;
  */git/ref/heads/action-release/v1)
    if [[ "${FAKE_EXISTING_RELEASE:-false}" == true ]]; then
      printf '3333333333333333333333333333333333333333\n'
    else
      printf 'gh: Not Found (HTTP 404)\n' >&2
      exit 1
    fi
    ;;
  */git/ref/tags/v1)
    if [[ "${FAKE_EXISTING_TAG:-false}" == true ]]; then
      printf '3333333333333333333333333333333333333333\n'
    else
      printf 'gh: Not Found (HTTP 404)\n' >&2
      exit 1
    fi
    ;;
  */git/commits/3333333333333333333333333333333333333333)
    printf '%s\n' "${FAKE_EXISTING_TREE:-4444444444444444444444444444444444444444}"
    ;;
  */git/commits)
    cp "$input" "${FAKE_GH_STATE}/commit-payload.json"
    printf '{"sha":"5555555555555555555555555555555555555555","verification":{"verified":%s,"reason":"%s"}}\n' \
      "${FAKE_VERIFIED:-true}" "${FAKE_VERIFICATION_REASON:-valid}"
    ;;
  */git/refs | */git/refs/*)
    printf '{}\n'
    ;;
  *)
    printf 'unexpected fake gh endpoint: %s\n' "$endpoint" >&2
    exit 1
    ;;
esac
FAKE
chmod +x "$fake_gh"

release_dir="${CASE_DIR}/release"
"${ROOT}/scripts/build-release.sh" "$release_dir" >/dev/null

# First publication creates an orphan commit plus branch and major tag refs.
new_state
FAKE_EXISTING_RELEASE=false \
  FAKE_EXISTING_TAG=false \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null
assert_line "$GITHUB_OUTPUT" "release_sha=${NEW_SHA}"
assert_line "$GITHUB_OUTPUT" 'released=true'
jq -e '.parents == []' "${STATE_DIR}/commit-payload.json" >/dev/null || fail 'initial release commit is not orphaned'
grep -Fq 'POST repos/workos/setup-socket-firewall/git/refs' "${STATE_DIR}/calls" || fail 'initial release refs were not created'
grep -Rl '"ref": "refs/heads/action-release/v1"' "${STATE_DIR}"/payload.*.json >/dev/null || fail 'release branch ref was not created'
grep -Rl '"ref": "refs/tags/v1"' "${STATE_DIR}"/payload.*.json >/dev/null || fail 'v1 tag ref was not created'

# An unchanged tree is a no-op but repairs/moves the discovery tag if needed.
new_state
FAKE_EXISTING_RELEASE=true \
  FAKE_EXISTING_TREE="$TREE_SHA" \
  FAKE_EXISTING_TAG=true \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null
assert_line "$GITHUB_OUTPUT" "release_sha=${EXISTING_SHA}"
assert_line "$GITHUB_OUTPUT" 'released=false'
if grep -Fq 'POST repos/workos/setup-socket-firewall/git/commits' "${STATE_DIR}/calls"; then
  fail 'unchanged release created a commit'
fi
grep -Fq 'PATCH repos/workos/setup-socket-firewall/git/refs/tags/v1' "${STATE_DIR}/calls" || fail 'unchanged release did not reconcile v1 tag'

# A changed tree chains from the prior action-only release and moves both refs.
new_state
FAKE_EXISTING_RELEASE=true \
  FAKE_EXISTING_TREE="$OTHER_TREE_SHA" \
  FAKE_EXISTING_TAG=true \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null
assert_line "$GITHUB_OUTPUT" "release_sha=${NEW_SHA}"
assert_line "$GITHUB_OUTPUT" 'released=true'
jq -e --arg parent "$EXISTING_SHA" '.parents == [$parent]' "${STATE_DIR}/commit-payload.json" >/dev/null || fail 'release commit does not chain from prior release'
grep -Fq 'PATCH repos/workos/setup-socket-firewall/git/refs/heads/action-release/v1' "${STATE_DIR}/calls" || fail 'release branch was not moved'
grep -Fq 'PATCH repos/workos/setup-socket-firewall/git/refs/tags/v1' "${STATE_DIR}/calls" || fail 'v1 tag was not moved'

# Never publish refs when GitHub does not verify the bot-created commit.
new_state
set +e
FAKE_EXISTING_RELEASE=false \
  FAKE_EXISTING_TAG=false \
  FAKE_VERIFIED=false \
  FAKE_VERIFICATION_REASON=unsigned \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'unverified release commit was accepted'
if grep -Eq '^(POST|PATCH) repos/workos/setup-socket-firewall/git/refs($|/)' "${STATE_DIR}/calls"; then
  fail 'unverified release updated a ref'
fi

# The publisher independently rejects a release tree that differs from the manifest.
new_state
printf 'unexpected\n' >"${release_dir}/unexpected.txt"
set +e
GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'release tree with an unexpected file was accepted'
[[ ! -s "${STATE_DIR}/calls" ]] || fail 'invalid release tree reached GitHub API'

printf 'release publish tests passed\n'
