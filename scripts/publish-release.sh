#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST="${ROOT}/release-manifest.txt"
RELEASE_INPUT="${1:-}"
SOURCE_SHA="${2:-}"
CHANNEL="${3:-v1}"
GH_BIN="${GH_BIN:-gh}"
REPOSITORY="${GITHUB_REPOSITORY:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}"

fail() {
  printf 'release publish failed: %s\n' "$1" >&2
  exit 1
}

[[ -n "$RELEASE_INPUT" ]] || fail 'usage: publish-release.sh RELEASE_DIRECTORY SOURCE_SHA [MAJOR_CHANNEL]'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'source SHA must be 40 lowercase hexadecimal characters'
[[ "$CHANNEL" =~ ^v[1-9][0-9]*$ ]] || fail 'release channel must look like v1 or v2'
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'GITHUB_REPOSITORY must be owner/name'
[[ "$RUN_ID" =~ ^[0-9]+$ && "$RUN_ATTEMPT" =~ ^[0-9]+$ ]] || fail 'GitHub run ID and attempt are required'
for command_name in "$GH_BIN" jq base64 find sort diff mktemp grep dirname basename pwd git tr; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: ${command_name}"
done

while [[ "$RELEASE_INPUT" == */ && "$RELEASE_INPUT" != '/' ]]; do
  RELEASE_INPUT="${RELEASE_INPUT%/}"
done
[[ -d "$RELEASE_INPUT" && ! -L "$RELEASE_INPUT" ]] || fail 'release directory must be a real directory'
release_parent="$(cd "$(dirname "$RELEASE_INPUT")" && pwd -P)"
RELEASE_DIR="${release_parent}/$(basename "$RELEASE_INPUT")"

expected="$(mktemp)"
actual="$(mktemp)"
additions="$(mktemp)"
deletions="$(mktemp)"
payload="$(mktemp)"
ref_error="$(mktemp)"
index_file="$(mktemp)"
rm -f "$index_file"
temp_branch="action-release-staging/${CHANNEL}-${RUN_ID}-${RUN_ATTEMPT}"
temp_ref="heads/${temp_branch}"
temp_ref_created=false
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$temp_ref_created" == 'true' ]]; then
    "$GH_BIN" api --method DELETE "repos/${REPOSITORY}/git/refs/${temp_ref}" --silent >/dev/null 2>&1 ||
      printf 'warning: could not delete temporary release branch %s\n' "$temp_branch" >&2
  fi
  rm -f -- "$expected" "$actual" "$additions" "$deletions" "$payload" "$ref_error" "$index_file"
  exit "$status"
}
trap cleanup EXIT

grep -Ev '^[[:space:]]*(#|$)' "$MANIFEST" | LC_ALL=C sort >"$expected"
if find "$RELEASE_DIR" -type l -print -quit | grep -q .; then
  fail 'release directory contains a symbolic link'
fi
(
  cd "$RELEASE_DIR"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort
) >"$actual"
diff -u "$expected" "$actual" >/dev/null || fail 'release directory does not exactly match release-manifest.txt'

GIT_INDEX_FILE="$index_file" git -C "$ROOT" read-tree --empty
: >"$additions"
while IFS= read -r path; do
  file="${RELEASE_DIR}/${path}"
  mode=100644
  [[ -x "$file" ]] && mode=100755
  blob_sha="$(git -C "$ROOT" hash-object -w -- "$file")"
  GIT_INDEX_FILE="$index_file" git -C "$ROOT" update-index --add --cacheinfo "${mode},${blob_sha},${path}"
  encoded="$(base64 <"$file" | tr -d '\n')"
  jq -n --arg path "$path" --arg contents "$encoded" '{path: $path, contents: $contents}' >>"$additions"
done <"$expected"
desired_tree="$(GIT_INDEX_FILE="$index_file" git -C "$ROOT" write-tree)"
[[ "$desired_tree" =~ ^[0-9a-f]{40}$ ]] || fail 'could not calculate the desired release tree'

release_ref="heads/action-release/${CHANNEL}"
existing_sha=''
if existing_sha="$("$GH_BIN" api "repos/${REPOSITORY}/git/ref/${release_ref}" --jq .object.sha 2>"$ref_error")"; then
  [[ "$existing_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'GitHub returned an invalid existing release SHA'
else
  if ! grep -q '(HTTP 404)' "$ref_error"; then
    cat "$ref_error" >&2
    fail 'could not inspect the current release ref'
  fi
  existing_sha=''
fi

upsert_ref() {
  local short_ref="$1"
  local full_ref="refs/${short_ref}"
  local sha="$2"
  local known_existing="${3:-unknown}"

  if [[ "$known_existing" == 'unknown' ]]; then
    if "$GH_BIN" api "repos/${REPOSITORY}/git/ref/${short_ref}" --silent 2>"$ref_error"; then
      known_existing=true
    elif grep -q '(HTTP 404)' "$ref_error"; then
      known_existing=false
    else
      cat "$ref_error" >&2
      fail "could not inspect ${full_ref}"
    fi
  fi

  if [[ "$known_existing" == 'true' ]]; then
    jq -n --arg sha "$sha" '{sha: $sha, force: true}' >"$payload"
    "$GH_BIN" api --method PATCH "repos/${REPOSITORY}/git/refs/${short_ref}" --input "$payload" --silent
  else
    jq -n --arg ref "$full_ref" --arg sha "$sha" '{ref: $ref, sha: $sha}' >"$payload"
    "$GH_BIN" api --method POST "repos/${REPOSITORY}/git/refs" --input "$payload" --silent
  fi
}

emit_result() {
  local release_sha="$1"
  local released="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      printf 'release_sha=%s\n' "$release_sha"
      printf 'released=%s\n' "$released"
      printf 'source_sha=%s\n' "$SOURCE_SHA"
      printf 'channel=%s\n' "$CHANNEL"
    } >>"$GITHUB_OUTPUT"
  fi
}

if [[ -n "$existing_sha" ]]; then
  existing_tree="$("$GH_BIN" api "repos/${REPOSITORY}/git/commits/${existing_sha}" --jq .tree.sha)"
  [[ "$existing_tree" =~ ^[0-9a-f]{40}$ ]] || fail 'GitHub returned an invalid existing release tree SHA'
  if [[ "$existing_tree" == "$desired_tree" ]]; then
    upsert_ref "tags/${CHANNEL}" "$existing_sha"
    emit_result "$existing_sha" false
    printf 'Action release tree is unchanged at %s\n' "$existing_sha"
    exit 0
  fi
  base_sha="$existing_sha"
  release_ref_exists=true
else
  base_sha="$SOURCE_SHA"
  release_ref_exists=false
fi

"$GH_BIN" api "repos/${REPOSITORY}/git/trees/${base_sha}?recursive=1" >"$payload"
base_truncated="$(jq -r '.truncated // false' "$payload")"
[[ "$base_truncated" == 'false' ]] || fail 'base tree listing was truncated'
jq -r '.tree[] | select(.type == "blob") | .path' "$payload" | LC_ALL=C sort >"$actual"
: >"$deletions"
while IFS= read -r path; do
  if ! grep -Fqx "$path" "$expected"; then
    jq -n --arg path "$path" '{path: $path}' >>"$deletions"
  fi
done <"$actual"

jq -n \
  --arg query 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid signature { isValid wasSignedByGitHub state } } } }' \
  --arg repository "$REPOSITORY" \
  --arg branch "$temp_branch" \
  --arg expectedHeadOid "$base_sha" \
  --arg headline "Release ${CHANNEL} from ${SOURCE_SHA}" \
  --slurpfile additions "$additions" \
  --slurpfile deletions "$deletions" \
  '{query: $query, variables: {input: {branch: {repositoryNameWithOwner: $repository, branchName: $branch}, expectedHeadOid: $expectedHeadOid, message: {headline: $headline}, fileChanges: {additions: $additions, deletions: $deletions}}}}' >"$payload"

jq -n --arg ref "refs/heads/${temp_branch}" --arg sha "$base_sha" '{ref: $ref, sha: $sha}' >"$ref_error"
"$GH_BIN" api --method POST "repos/${REPOSITORY}/git/refs" --input "$ref_error" --silent
temp_ref_created=true

commit_response="$("$GH_BIN" api graphql --method POST --input "$payload")"
release_sha="$(jq -r '.data.createCommitOnBranch.commit.oid // empty' <<<"$commit_response")"
signature_valid="$(jq -r '.data.createCommitOnBranch.commit.signature.isValid // false' <<<"$commit_response")"
signed_by_github="$(jq -r '.data.createCommitOnBranch.commit.signature.wasSignedByGitHub // false' <<<"$commit_response")"
signature_state="$(jq -r '.data.createCommitOnBranch.commit.signature.state // "missing"' <<<"$commit_response")"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'GitHub returned an invalid release commit SHA'
[[ "$signature_valid" == 'true' && "$signed_by_github" == 'true' ]] || fail "GitHub did not sign and verify the release commit (${signature_state})"

published_tree="$("$GH_BIN" api "repos/${REPOSITORY}/git/commits/${release_sha}" --jq .tree.sha)"
[[ "$published_tree" == "$desired_tree" ]] || fail 'GitHub-signed release commit tree differs from the staged tree'

upsert_ref "$release_ref" "$release_sha" "$release_ref_exists"
upsert_ref "tags/${CHANNEL}" "$release_sha"
"$GH_BIN" api --method DELETE "repos/${REPOSITORY}/git/refs/${temp_ref}" --silent
temp_ref_created=false

emit_result "$release_sha" true
printf 'Published %s action-only release %s from source %s\n' "$CHANNEL" "$release_sha" "$SOURCE_SHA"
