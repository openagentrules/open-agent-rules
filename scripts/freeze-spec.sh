#!/usr/bin/env bash
# A published version directory is immutable. Adopters' $ref chains and
# validator caches hold these URLs forever, and site/_headers serves them with a
# one-year immutable cache — so a byte change to an already-published file is a
# silent interoperability break. Corrections ship as a new version.
#
# Usage: scripts/freeze-spec.sh <version>
set -euo pipefail

VERSION="${1:?usage: freeze-spec.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DIR="site/spec/${VERSION}"
if [[ ! -d "$DIR" ]]; then
  echo "error: $DIR does not exist" >&2
  exit 1
fi

if ! git rev-parse --verify --quiet HEAD >/dev/null; then
  echo "ok: no commit yet — version ${VERSION} is not published"
  exit 0
fi

changed=()
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  if ! git show "HEAD:${path}" 2>/dev/null | diff -q - "$path" >/dev/null 2>&1; then
    changed+=("$path")
  fi
done < <(git ls-tree -r --name-only HEAD -- "$DIR")

if (( ${#changed[@]} > 0 )); then
  echo "error: published version ${VERSION} is immutable — these files changed:" >&2
  for path in "${changed[@]}"; do echo "  $path" >&2; done
  echo >&2
  echo "Ship the correction as a new version instead." >&2
  exit 1
fi

echo "ok: published version ${VERSION} is unchanged"
