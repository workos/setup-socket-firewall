#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST="${ROOT}/release-manifest.txt"
OUTPUT_INPUT="${1:-}"

if [[ -z "$OUTPUT_INPUT" || "$OUTPUT_INPUT" == '/' ]]; then
  printf 'usage: %s EMPTY_OUTPUT_DIRECTORY\n' "$0" >&2
  exit 2
fi

output_parent="$(dirname "$OUTPUT_INPUT")"
output_name="$(basename "$OUTPUT_INPUT")"
[[ -d "$output_parent" ]] || {
  printf 'release output parent does not exist: %s\n' "$output_parent" >&2
  exit 1
}
OUTPUT="$(cd "$output_parent" && pwd -P)/${output_name}"

if [[ "$ROOT" == "$OUTPUT" || "$ROOT" == "$OUTPUT/"* ]]; then
  printf 'release output must not be the repository or an ancestor: %s\n' "$OUTPUT" >&2
  exit 1
fi
if [[ -e "$OUTPUT" ]]; then
  [[ -d "$OUTPUT" ]] || {
    printf 'release output exists and is not a directory: %s\n' "$OUTPUT" >&2
    exit 1
  }
  [[ -z "$(find "$OUTPUT" -mindepth 1 -print -quit)" ]] || {
    printf 'release output directory must be empty: %s\n' "$OUTPUT" >&2
    exit 1
  }
else
  mkdir "$OUTPUT"
fi

while IFS= read -r path || [[ -n "$path" ]]; do
  [[ -n "$path" && "$path" != \#* ]] || continue
  [[ -f "${ROOT}/${path}" ]] || {
    printf 'release manifest path is missing: %s\n' "$path" >&2
    exit 1
  }
  mkdir -p "${OUTPUT}/$(dirname "$path")"
  cp -p "${ROOT}/${path}" "${OUTPUT}/${path}"
done <"$MANIFEST"

expected="$(mktemp)"
actual="$(mktemp)"
grep -Ev '^[[:space:]]*(#|$)' "$MANIFEST" | LC_ALL=C sort >"$expected"
(
  cd "$OUTPUT"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort
) >"$actual"

diff -u "$expected" "$actual"
bash -n "${OUTPUT}/scripts/configure.sh"
bash -n "${OUTPUT}/scripts/teardown.sh"
rm -f "$expected" "$actual"

printf 'Built action-only release tree at %s\n' "$OUTPUT"
