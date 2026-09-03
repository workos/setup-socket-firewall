#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST="${ROOT}/release-manifest.txt"
OUTPUT_INPUT="${1:-}"

while [[ "$OUTPUT_INPUT" == */ && "$OUTPUT_INPUT" != '/' ]]; do
  OUTPUT_INPUT="${OUTPUT_INPUT%/}"
done
if [[ -z "$OUTPUT_INPUT" || "$OUTPUT_INPUT" == '/' ]]; then
  printf 'usage: %s NEW_OR_EMPTY_OUTPUT_DIRECTORY\n' "$0" >&2
  exit 2
fi

output_parent="$(dirname "$OUTPUT_INPUT")"
output_name="$(basename "$OUTPUT_INPUT")"
if [[ "$output_name" == '.' || "$output_name" == '..' ]]; then
  printf 'invalid release output name: %s\n' "$output_name" >&2
  exit 1
fi
[[ -d "$output_parent" ]] || {
  printf 'release output parent does not exist: %s\n' "$output_parent" >&2
  exit 1
}
output_parent="$(cd "$output_parent" && pwd -P)"
OUTPUT="${output_parent}/${output_name}"

if [[ "$ROOT" == "$OUTPUT" || "$ROOT" == "$OUTPUT/"* ]]; then
  printf 'release output must not be the repository or an ancestor: %s\n' "$OUTPUT" >&2
  exit 1
fi

OUTPUT_WAS_EXISTING=false
if [[ -L "$OUTPUT" ]]; then
  printf 'release output must not be a symbolic link: %s\n' "$OUTPUT" >&2
  exit 1
elif [[ -e "$OUTPUT" ]]; then
  [[ -d "$OUTPUT" ]] || {
    printf 'release output exists and is not a directory: %s\n' "$OUTPUT" >&2
    exit 1
  }
  [[ -z "$(find "$OUTPUT" -mindepth 1 -print -quit)" ]] || {
    printf 'release output directory must be empty: %s\n' "$OUTPUT" >&2
    exit 1
  }
  OUTPUT_WAS_EXISTING=true
fi

expected="$(mktemp)"
actual="$(mktemp)"
staging="$(mktemp -d "${output_parent}/.${output_name}.workos-sfw.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$staging" && -d "$staging" ]]; then
    rm -rf -- "$staging"
  fi
  rm -f -- "$expected" "$actual"
  if [[ "$status" -ne 0 && "$OUTPUT_WAS_EXISTING" == 'true' && ! -e "$OUTPUT" && ! -L "$OUTPUT" ]]; then
    mkdir -- "$OUTPUT" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

: >"$expected"
while IFS= read -r path || [[ -n "$path" ]]; do
  [[ -n "$path" && "$path" != \#* ]] || continue
  case "$path" in
    /* | . | .. | ./* | ../* | */. | */.. | */./* | */../* | *//* | *[[:space:]]*)
      printf 'unsafe release manifest path: %s\n' "$path" >&2
      exit 1
      ;;
  esac

  source_path="${ROOT}/${path}"
  [[ -f "$source_path" && ! -L "$source_path" ]] || {
    printf 'release manifest path is missing or not a regular file: %s\n' "$path" >&2
    exit 1
  }
  source_parent="$(cd "$(dirname "$source_path")" && pwd -P)"
  real_source="${source_parent}/$(basename "$source_path")"
  [[ "$real_source" == "$ROOT/"* ]] || {
    printf 'release manifest path escapes repository: %s\n' "$path" >&2
    exit 1
  }
  printf '%s\n' "$path" >>"$expected"
done <"$MANIFEST"
LC_ALL=C sort -o "$expected" "$expected"
if [[ -n "$(uniq -d "$expected")" ]]; then
  printf 'release manifest contains duplicate paths\n' >&2
  exit 1
fi

while IFS= read -r path; do
  mkdir -p "${staging}/$(dirname "$path")"
  cp -p "${ROOT}/${path}" "${staging}/${path}"
done <"$expected"

(
  cd "$staging"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort
) >"$actual"
diff -u "$expected" "$actual"
bash -n "${staging}/scripts/configure.sh"
bash -n "${staging}/scripts/teardown.sh"

if [[ "$OUTPUT_WAS_EXISTING" == 'true' ]]; then
  [[ ! -L "$OUTPUT" && -d "$OUTPUT" && -z "$(find "$OUTPUT" -mindepth 1 -print -quit)" ]] || {
    printf 'release output changed while staging: %s\n' "$OUTPUT" >&2
    exit 1
  }
  rmdir -- "$OUTPUT"
elif [[ -e "$OUTPUT" || -L "$OUTPUT" ]]; then
  printf 'release output appeared while staging: %s\n' "$OUTPUT" >&2
  exit 1
fi

mv -- "$staging" "$OUTPUT"
staging=''
rm -f -- "$expected" "$actual"
trap - EXIT

printf 'Built action-only release tree at %s\n' "$OUTPUT"
