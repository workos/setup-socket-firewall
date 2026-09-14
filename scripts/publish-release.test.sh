#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASE_DIR="$(mktemp -d)"
trap 'rm -rf "$CASE_DIR"' EXIT

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
  export GITHUB_RUN_ID=12345
  export GITHUB_RUN_ATTEMPT=1
}

calculate_tree() {
  local release_dir="$1"
  local index path file mode blob
  index="$(mktemp "${CASE_DIR}/index.XXXXXX")"
  rm -f "$index"
  GIT_INDEX_FILE="$index" git -C "$ROOT" read-tree --empty
  while IFS= read -r path; do
    file="${release_dir}/${path}"
    mode=100644
    [[ -x "$file" ]] && mode=100755
    blob="$(git -C "$ROOT" hash-object -w -- "$file")"
    GIT_INDEX_FILE="$index" git -C "$ROOT" update-index --add --cacheinfo "${mode},${blob},${path}"
  done < <(grep -Ev '^[[:space:]]*(#|$)' "${ROOT}/release-manifest.txt" | LC_ALL=C sort)
  GIT_INDEX_FILE="$index" git -C "$ROOT" write-tree
  rm -f "$index"
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
  graphql)
    cp "$input" "${FAKE_GH_STATE}/graphql-payload.json"
    if [[ -n "${FAKE_BASE_TREE:-}" ]]; then
      # Model FileAddition: preserve an existing file's mode; new files are
      # regular 100644 blobs. Build the result from the actual mutation payload,
      # independently of the publisher's desired tree hash.
      export GIT_INDEX_FILE="${FAKE_GH_STATE}/api-index"
      git -C "$FAKE_GIT_ROOT" read-tree "$FAKE_BASE_TREE"
      while IFS= read -r path; do
        git -C "$FAKE_GIT_ROOT" update-index --force-remove -- "$path"
      done < <(jq -r '.variables.input.fileChanges.deletions[].path' "$input")
      while IFS=$'\t' read -r path contents; do
        entry="$(git -C "$FAKE_GIT_ROOT" ls-files --stage -- "$path")"
        mode="${entry%% *}"
        mode="${mode:-100644}"
        blob="$(printf '%s' "$contents" | base64 --decode | git -C "$FAKE_GIT_ROOT" hash-object -w --stdin)"
        git -C "$FAKE_GIT_ROOT" update-index --add --cacheinfo "${mode},${blob},${path}"
      done < <(jq -r '.variables.input.fileChanges.additions[] | [.path, .contents] | @tsv' "$input")
      git -C "$FAKE_GIT_ROOT" write-tree >"${FAKE_GH_STATE}/api-tree"
    fi
    printf '{"data":{"createCommitOnBranch":{"commit":{"oid":"5555555555555555555555555555555555555555","signature":{"isValid":%s,"wasSignedByGitHub":%s,"state":"%s"}}}}}\n' \
      "${FAKE_SIGNATURE_VALID:-true}" "${FAKE_SIGNED_BY_GITHUB:-true}" "${FAKE_SIGNATURE_STATE:-VALID}"
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
  */git/commits/5555555555555555555555555555555555555555)
    if [[ -n "${FAKE_BASE_TREE:-}" ]]; then
      cat "${FAKE_GH_STATE}/api-tree"
    else
      printf '%s\n' "${FAKE_PUBLISHED_TREE:-${FAKE_DESIRED_TREE}}"
    fi
    ;;
  */git/trees/*)
    if [[ -n "${FAKE_BASE_TREE:-}" ]]; then
      git -C "$FAKE_GIT_ROOT" ls-tree -r "$FAKE_BASE_TREE" | jq -Rn '
        {truncated: false, tree: [inputs | split("\t") as $row |
          ($row[0] | split(" ")) as $object |
          {mode: $object[0], type: $object[1], sha: $object[2], path: $row[1]}]}'
    else
      printf '{"truncated":false,"tree":[{"path":"obsolete.txt","type":"blob","mode":"100644","sha":"9999999999999999999999999999999999999999"}]}\n'
    fi
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
DESIRED_TREE="$(calculate_tree "$release_dir")"
export FAKE_DESIRED_TREE="$DESIRED_TREE"

# First publication creates a signed commit on a temporary branch, then creates release refs.
new_state
FAKE_EXISTING_RELEASE=false \
  FAKE_EXISTING_TAG=false \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null
assert_line "$GITHUB_OUTPUT" "release_sha=${NEW_SHA}"
assert_line "$GITHUB_OUTPUT" 'released=true'
jq -e --arg source "$SOURCE_SHA" '.variables.input.expectedHeadOid == $source' "${STATE_DIR}/graphql-payload.json" >/dev/null || fail 'initial release did not stage from source SHA'
jq -e '.variables.input.branch.branchName == "action-release-staging/v1-12345-1"' "${STATE_DIR}/graphql-payload.json" >/dev/null || fail 'unexpected temporary branch name'
jq -e '.variables.input.fileChanges.deletions == [{"path":"obsolete.txt"}]' "${STATE_DIR}/graphql-payload.json" >/dev/null || fail 'base-only file was not deleted'
grep -Rl '"ref": "refs/heads/action-release/v1"' "${STATE_DIR}"/payload.*.json >/dev/null || fail 'release branch ref was not created'
grep -Rl '"ref": "refs/tags/v1"' "${STATE_DIR}"/payload.*.json >/dev/null || fail 'v1 tag ref was not created'
grep -Fq 'DELETE repos/workos/setup-socket-firewall/git/refs/heads/action-release-staging/v1-12345-1' "${STATE_DIR}/calls" || fail 'temporary branch was not deleted'

# An unchanged tree is a no-op but repairs/moves the discovery tag if needed.
new_state
FAKE_EXISTING_RELEASE=true \
  FAKE_EXISTING_TREE="$DESIRED_TREE" \
  FAKE_EXISTING_TAG=true \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null
assert_line "$GITHUB_OUTPUT" "release_sha=${EXISTING_SHA}"
assert_line "$GITHUB_OUTPUT" 'released=false'
if grep -Fq 'POST graphql' "${STATE_DIR}/calls"; then
  fail 'unchanged release created a commit'
fi
grep -Fq 'PATCH repos/workos/setup-socket-firewall/git/refs/tags/v1' "${STATE_DIR}/calls" || fail 'unchanged release did not reconcile v1 tag'

# A changed tree stages from the prior action-only release and moves both refs.
new_state
FAKE_EXISTING_RELEASE=true \
  FAKE_EXISTING_TREE="$OTHER_TREE_SHA" \
  FAKE_EXISTING_TAG=true \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null
assert_line "$GITHUB_OUTPUT" "release_sha=${NEW_SHA}"
assert_line "$GITHUB_OUTPUT" 'released=true'
jq -e --arg parent "$EXISTING_SHA" '.variables.input.expectedHeadOid == $parent' "${STATE_DIR}/graphql-payload.json" >/dev/null || fail 'release did not stage from prior release'
grep -Fq 'PATCH repos/workos/setup-socket-firewall/git/refs/heads/action-release/v1' "${STATE_DIR}/calls" || fail 'release branch was not moved'
grep -Fq 'PATCH repos/workos/setup-socket-firewall/git/refs/tags/v1' "${STATE_DIR}/calls" || fail 'v1 tag was not moved'

# Reproduce the five-file pre-scrub release: the older shell helpers already
# have executable modes; every other runtime file must be added by the API.
base_index="${CASE_DIR}/base-index"
GIT_INDEX_FILE="$base_index" git -C "$ROOT" read-tree --empty
for path in LICENSE action.yml scripts/configure.sh scripts/teardown.sh teardown/action.yml; do
  read -r mode _ blob _ < <(git -C "$ROOT" ls-tree -r "$DESIRED_TREE" -- "$path")
  GIT_INDEX_FILE="$base_index" git -C "$ROOT" update-index --add --cacheinfo "${mode},${blob},${path}"
done
base_tree="$(GIT_INDEX_FILE="$base_index" git -C "$ROOT" write-tree)"

publish_from_previous_release() {
  FAKE_BASE_TREE="$base_tree" \
    FAKE_GIT_ROOT="$ROOT" \
    FAKE_EXISTING_RELEASE=true \
    FAKE_EXISTING_TREE="$base_tree" \
    FAKE_EXISTING_TAG=true \
    GH_BIN="$fake_gh" \
    GITHUB_REPOSITORY=workos/setup-socket-firewall \
    "${ROOT}/scripts/publish-release.sh" "$1" "$SOURCE_SHA" v1
}

# The current package must match the mode-aware API result without relaxing the
# exact-tree check. This fails on the original 100755 scrub helper from PR #10.
new_state
publish_from_previous_release "$release_dir" >/dev/null
assert_line "$GITHUB_OUTPUT" "release_sha=${NEW_SHA}"
assert_line "$GITHUB_OUTPUT" 'released=true'
assert_line "${STATE_DIR}/api-tree" "$DESIRED_TREE"
assert_line "${STATE_DIR}/calls" 'PATCH repos/workos/setup-socket-firewall/git/refs/heads/action-release/v1'
assert_line "${STATE_DIR}/calls" 'PATCH repos/workos/setup-socket-firewall/git/refs/tags/v1'

# Reintroducing the unnecessary executable bit reproduces the production error
# and must leave both discovery refs untouched, while cleaning the staging ref.
broken_release="${CASE_DIR}/executable-scrub-release"
cp -R "$release_dir" "$broken_release"
chmod +x "${broken_release}/scripts/scrub-lockfile.sh"
new_state
if publish_from_previous_release "$broken_release" >"${STATE_DIR}/error" 2>&1; then
  fail 'new executable scrub helper unexpectedly published'
fi
grep -Fq 'GitHub-signed release commit tree differs from the staged tree' "${STATE_DIR}/error" || fail 'wrong failure for executable scrub helper'
[[ ! -s "$GITHUB_OUTPUT" ]] || fail 'mismatched release emitted success outputs'
if grep -Eq 'PATCH repos/.*/git/refs/(heads/action-release/v1|tags/v1)' "${STATE_DIR}/calls"; then
  fail 'executable mode mismatch moved a release ref'
fi
assert_line "${STATE_DIR}/calls" 'DELETE repos/workos/setup-socket-firewall/git/refs/heads/action-release-staging/v1-12345-1'

# Never publish release refs when GitHub does not sign the staged commit.
new_state
set +e
FAKE_EXISTING_RELEASE=false \
  FAKE_EXISTING_TAG=false \
  FAKE_SIGNATURE_VALID=false \
  FAKE_SIGNED_BY_GITHUB=false \
  FAKE_SIGNATURE_STATE=UNSIGNED \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'unsigned release commit was accepted'
if grep -Eq 'PATCH repos/.*/git/refs/(heads/action-release/v1|tags/v1)' "${STATE_DIR}/calls"; then
  fail 'unsigned release moved a release ref'
fi
if grep -Rl '"ref": "refs/heads/action-release/v1"\|"ref": "refs/tags/v1"' "${STATE_DIR}"/payload.*.json >/dev/null 2>&1; then
  fail 'unsigned release created a release ref'
fi

# Never publish release refs when the signed commit tree differs from staging.
new_state
set +e
FAKE_EXISTING_RELEASE=false \
  FAKE_EXISTING_TAG=false \
  FAKE_PUBLISHED_TREE="$OTHER_TREE_SHA" \
  GH_BIN="$fake_gh" \
  GITHUB_REPOSITORY=workos/setup-socket-firewall \
  "${ROOT}/scripts/publish-release.sh" "$release_dir" "$SOURCE_SHA" v1 >/dev/null 2>&1
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'mismatched signed release tree was accepted'
if grep -Eq 'PATCH repos/.*/git/refs/(heads/action-release/v1|tags/v1)' "${STATE_DIR}/calls"; then
  fail 'mismatched release moved a release ref'
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
