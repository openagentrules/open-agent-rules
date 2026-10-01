#!/usr/bin/env bash
# A published version directory is immutable. Adopters' $ref chains and
# validator caches hold these URLs forever, and site/_headers serves them with a
# one-year immutable cache — so a byte change to an already-published file is a
# silent interoperability break. Corrections ship as a new version.
#
# Publishing a version records a content hash of its two trees — the source
# (spec/oar/<v>/) and the published projection (site/spec/<v>/) — in
# spec/published.json. This gate recomputes both hashes and fails when either
# tree stops matching its recorded hash. Hashing the tree, rather than diffing
# against HEAD, is what makes the gate mean the same thing everywhere: a CI
# checkout *is* HEAD, so a HEAD diff can never fail where it matters.
#
# Usage:
#   scripts/freeze-spec.sh                 check every published version
#   scripts/freeze-spec.sh --publish <v>   record <v>'s hashes (the one-way door)
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

tree_hash() {
  # Deterministic over content and relative paths; independent of mtimes.
  local dir="$1"
  (cd "$dir" && find . -type f ! -name '.DS_Store' -print0 | sort -z | \
    xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
}

# Validate the ledger and preserve every entry already recorded in Git history.
# Comparing only to HEAD would let deleting an entry silently unfreeze a version.
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
function entries(text) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.published)) throw Error('published must be an array');
  const out = new Map();
  for (const entry of doc.published) {
    if (!entry || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(entry.version) ||
        !/^[a-f0-9]{64}$/.test(entry.spec_tree_sha256) || !/^[a-f0-9]{64}$/.test(entry.site_tree_sha256) || out.has(entry.version)) {
      throw Error('invalid or duplicate published release entry');
    }
    out.set(entry.version, entry);
  }
  return out;
}
const current = entries(readFileSync('spec/published.json', 'utf8'));
const revisions = execFileSync('git', ['log', '--format=%H', 'HEAD', '--', 'spec/published.json'], {encoding:'utf8'}).trim().split('\n').filter(Boolean);
for (const revision of revisions) {
  const previous = entries(execFileSync('git', ['show', `${revision}:spec/published.json`], {encoding:'utf8'}));
  for (const [version, entry] of previous) {
    const now = current.get(version);
    if (!now || now.spec_tree_sha256 !== entry.spec_tree_sha256 || now.site_tree_sha256 !== entry.site_tree_sha256) {
      throw Error(`published version ${version} was removed or its recorded hashes were changed`);
    }
  }
}
JS

if [[ "${1:-}" == "--publish" ]]; then
  VERSION="${2:?usage: freeze-spec.sh --publish <version>}"
  [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "invalid version" >&2; exit 1; }
  bash "$0"
  python3 scripts/release-bundle.py "$VERSION" --check
  for dir in "spec/oar/${VERSION}" "site/spec/${VERSION}"; do
    [[ -d "$dir" ]] || { echo "error: $dir does not exist" >&2; exit 1; }
  done
  SPEC_HASH="$(tree_hash "spec/oar/${VERSION}")" SITE_HASH="$(tree_hash "site/spec/${VERSION}")" \
  node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(fs.readFileSync("spec/published.json", "utf8"));
    const v = process.argv[1];
    if ((doc.published ?? []).some((e) => (typeof e === "string" ? e : e.version) === v)) {
      console.error(`error: version ${v} is already published — its bytes are frozen`);
      process.exit(1);
    }
    doc.published.push({ version: v, spec_tree_sha256: process.env.SPEC_HASH, site_tree_sha256: process.env.SITE_HASH });
    fs.writeFileSync("spec/published.json", JSON.stringify(doc, null, 2) + "\n");
    console.log(`published ${v} — its trees are now frozen; commit spec/published.json`);
  ' "$VERSION"
  exit 0
fi

# Check mode: verify every published version against its recorded hashes. A
# version absent from published.json is still being drafted, and editing it in
# place is the point.
ENTRY_TEXT="$(node -e '
  const { published } = JSON.parse(require("node:fs").readFileSync("spec/published.json", "utf8"));
  for (const e of published) console.log(`${e.version} ${e.spec_tree_sha256} ${e.site_tree_sha256}`);
')"
ENTRIES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && ENTRIES+=("$line")
done <<< "$ENTRY_TEXT"

if (( ${#ENTRIES[@]} == 0 )); then
  echo "ok: no version is published yet — nothing is frozen"
  exit 0
fi

status=0
for entry in "${ENTRIES[@]}"; do
  read -r version spec_hash site_hash <<<"$entry"
  for pair in "spec/oar/${version}:${spec_hash}" "site/spec/${version}:${site_hash}"; do
    dir="${pair%%:*}" want="${pair##*:}"
    if [[ ! -d "$dir" ]]; then
      echo "error: published version ${version} is immutable, and ${dir} is missing" >&2
      status=1
      continue
    fi
    got="$(tree_hash "$dir")"
    if [[ "$got" != "$want" ]]; then
      echo "error: published version ${version} is immutable — ${dir} no longer matches its recorded hash" >&2
      echo "  recorded ${want}" >&2
      echo "  current  ${got}" >&2
      echo "  Ship the correction as a new version instead." >&2
      status=1
    fi
  done
done

if (( status == 0 )); then
  echo "ok: every published version matches its recorded hash (${#ENTRIES[@]} version(s))"
fi
exit $status
