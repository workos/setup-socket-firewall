#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST="${ROOT}/release-manifest.txt"
RELEASE_INPUT="${1:-}"
SOURCE_SHA="${2:-}"
CHANNEL="${3:-v1}"
GH_BIN="${GH_BIN:-gh}"
REPOSITORY="${GITHUB_REPOSITORY:-}"

fail() {
  printf 'release publish failed: %s\n' "$1" >&2
  exit 1
}

[[ -n "$RELEASE_INPUT" ]] || fail 'usage: publish-release.sh RELEASE_DIRECTORY SOURCE_SHA [MAJOR_CHANNEL]'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'source SHA must be 40 lowercase hexadecimal characters'
[[ "$CHANNEL" =~ ^v[1-9][0-9]*$ ]] || fail 'release channel must look like v1 or v2'
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'GITHUB_REPOSITORY must be owner/name'
for command_name in "$GH_BIN" jq base64 find sort diff mktemp grep dirname basename pwd tr; do
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
entries="$(mktemp)"
payload="$(mktemp)"
ref_error="$(mktemp)"
cleanup() {
  local status=$?
  trap - EXIT
  rm -f -- "$expected" "$actual" "$entries" "$payload" "$ref_error"
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

: >"$entries"
while IFS= read -r path; do
  file="${RELEASE_DIR}/${path}"
  mode=100644
  [[ -x "$file" ]] && mode=100755
  encoded="$(base64 <"$file" | tr -d '\n')"
  jq -n --arg content "$encoded" '{content: $content, encoding: "base64"}' >"$payload"
  blob_sha="$("$GH_BIN" api --method POST "repos/${REPOSITORY}/git/blobs" --input "$payload" --jq .sha)"
  [[ "$blob_sha" =~ ^[0-9a-f]{40}$ ]] || fail "GitHub returned an invalid blob SHA for ${path}"
  jq -n \
    --arg path "$path" \
    --arg mode "$mode" \
    --arg sha "$blob_sha" \
    '{path: $path, mode: $mode, type: "blob", sha: $sha}' >>"$entries"
done <"$expected"

jq -s '{tree: .}' "$entries" >"$payload"
tree_sha="$("$GH_BIN" api --method POST "repos/${REPOSITORY}/git/trees" --input "$payload" --jq .sha)"
[[ "$tree_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'GitHub returned an invalid tree SHA'

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
  local known_existing="${3:-false}"

  if [[ "$known_existing" != 'true' ]]; then
    if "$GH_BIN" api "repos/${REPOSITORY}/git/ref/${short_ref}" --silent 2>"$ref_error"; then
      known_existing=true
    elif ! grep -q '(HTTP 404)' "$ref_error"; then
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

if [[ -n "$existing_sha" ]]; then
  existing_tree="$("$GH_BIN" api "repos/${REPOSITORY}/git/commits/${existing_sha}" --jq .tree.sha)"
  [[ "$existing_tree" =~ ^[0-9a-f]{40}$ ]] || fail 'GitHub returned an invalid existing release tree SHA'
  if [[ "$existing_tree" == "$tree_sha" ]]; then
    upsert_ref "tags/${CHANNEL}" "$existing_sha"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      {
        printf 'release_sha=%s\n' "$existing_sha"
        printf 'released=false\n'
        printf 'source_sha=%s\n' "$SOURCE_SHA"
        printf 'channel=%s\n' "$CHANNEL"
      } >>"$GITHUB_OUTPUT"
    fi
    printf 'Action release tree is unchanged at %s\n' "$existing_sha"
    exit 0
  fi
fi

if [[ -n "$existing_sha" ]]; then
  jq -n \
    --arg message "Release ${CHANNEL} from ${SOURCE_SHA}" \
    --arg tree "$tree_sha" \
    --arg parent "$existing_sha" \
    '{message: $message, tree: $tree, parents: [$parent]}' >"$payload"
else
  jq -n \
    --arg message "Release ${CHANNEL} from ${SOURCE_SHA}" \
    --arg tree "$tree_sha" \
    '{message: $message, tree: $tree, parents: []}' >"$payload"
fi

commit_response="$("$GH_BIN" api --method POST "repos/${REPOSITORY}/git/commits" --input "$payload")"
release_sha="$(jq -r '.sha // empty' <<<"$commit_response")"
verified="$(jq -r '.verification.verified // false' <<<"$commit_response")"
verification_reason="$(jq -r '.verification.reason // "missing"' <<<"$commit_response")"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'GitHub returned an invalid release commit SHA'
[[ "$verified" == 'true' ]] || fail "GitHub did not verify the release commit signature (${verification_reason})"

upsert_ref "$release_ref" "$release_sha" "$([[ -n "$existing_sha" ]] && printf true || printf false)"
upsert_ref "tags/${CHANNEL}" "$release_sha"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'release_sha=%s\n' "$release_sha"
    printf 'released=true\n'
    printf 'source_sha=%s\n' "$SOURCE_SHA"
    printf 'channel=%s\n' "$CHANNEL"
  } >>"$GITHUB_OUTPUT"
fi
printf 'Published %s action-only release %s from source %s\n' "$CHANNEL" "$release_sha" "$SOURCE_SHA"
