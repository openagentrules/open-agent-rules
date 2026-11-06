#!/usr/bin/env node
// Gate: clause identifiers are well-formed, dense, and append-only.
//
// A clause identifier is the citation surface of this standard. A conformance
// fixture cites one, an implementer's bug report cites one, another spec cites
// one. So three properties have to hold, and none of them survives being left
// to care:
//
//   1. No identifier is defined twice. Two clauses under one number means half
//      the citations of that number point at the wrong requirement.
//   2. Numbering inside an area runs 1..n with no gaps. A gap is either a
//      clause that was deleted (which the append-only policy forbids) or one
//      that was never written, and a reader cannot tell which.
//   3. Every identifier recorded in clause-index.json still exists in the text.
//      That is the append-only guard: identifiers are never renumbered, never
//      reused, and never quietly dropped.
//
// clause-index.json is the released baseline. It is regenerated ONLY when
// clauses are legitimately added, with:
//
//     node scripts/check-clauses.mjs --write
//
// and the regenerated file lands in the same pull request as the new clauses.
// Regenerating it to make a failure go away is how a citation made a year ago
// stops resolving — if this gate fails, the text is wrong, not the index.
//
// Usage: node scripts/check-clauses.mjs [--write] [version]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const VERSION = args.find((a) => !a.startsWith('--')) ?? '1.0';
const SPEC_DIR = join(REPO, 'spec', 'oar', VERSION);
const INDEX = join(SPEC_DIR, 'clause-index.json');

const spec = readFileSync(join(SPEC_DIR, 'open-agent-rules.md'), 'utf8');

const errors = [];
const fail = (msg) => errors.push(msg);

// A clause is *defined* where it opens a bulleted requirement in bold:
//     - **[OAR-DOC-2]** A rule document MUST contain ...
// Every other appearance is a cross-reference.
const DEFINITION = /^\s*[-*]\s+\*\*\[(OAR-([A-Z]+)-([0-9]+))\]\*\*/gm;
const MENTION = /\[(OAR-([A-Z]+)-([0-9]+))\]/g;

const defined = [];
const seen = new Map(); // id -> first line number

const lineOf = (index) => spec.slice(0, index).split('\n').length;

for (const m of spec.matchAll(DEFINITION)) {
  const [, id, area, num] = m;
  const line = lineOf(m.index);
  if (seen.has(id)) fail(`[${id}] is defined twice — lines ${seen.get(id)} and ${line}`);
  else seen.set(id, line);
  defined.push({ id, area, num: Number(num), line });
}

if (defined.length === 0) {
  console.error(`error: no clause definitions found in spec/oar/${VERSION}/open-agent-rules.md`);
  console.error('A definition looks like: - **[OAR-DOC-1]** A rule document MUST ...');
  process.exit(1);
}

// 2. Contiguous from 1 inside each area. --------------------------------------
const byArea = new Map();
for (const c of defined) {
  if (!byArea.has(c.area)) byArea.set(c.area, []);
  byArea.get(c.area).push(c.num);
}
for (const [area, nums] of [...byArea].sort()) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const missing = [];
  for (let n = 1; n <= sorted.at(-1); n++) if (!sorted.includes(n)) missing.push(n);
  if (missing.length > 0) {
    fail(
      `area ${area} is not contiguous: ${missing.map((n) => `[OAR-${area}-${n}]`).join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} missing, but [OAR-${area}-${sorted.at(-1)}] exists. ` +
        'Clause numbers run 1..n with no gaps; a retired clause keeps its number and is marked obsolete in place.',
    );
  }
}

// 3. Every cross-reference resolves. ------------------------------------------
const ids = new Set(defined.map((c) => c.id));
const dangling = new Map();
for (const m of spec.matchAll(MENTION)) {
  if (m[1] === 'OAR-AREA-n') continue; // the template used to introduce the form
  if (!ids.has(m[1]) && !dangling.has(m[1])) dangling.set(m[1], lineOf(m.index));
}
for (const [id, line] of dangling) {
  fail(`[${id}] is cited at line ${line} but no clause defines it`);
}

// 4. Append-only against the released baseline. -------------------------------
const sortIds = (list) =>
  [...list].sort((a, b) => {
    const [, aa, an] = /^OAR-([A-Z]+)-([0-9]+)$/.exec(a);
    const [, ba, bn] = /^OAR-([A-Z]+)-([0-9]+)$/.exec(b);
    return aa === ba ? Number(an) - Number(bn) : aa < ba ? -1 : 1;
  });

const NOTE =
  'The released clause identifiers, for the append-only guard in ' +
  'scripts/check-clauses.mjs. Regenerated only when clauses are legitimately ' +
  'added, with `node scripts/check-clauses.mjs --write`, in the same pull ' +
  'request as the new clauses. An identifier is never removed from this list: ' +
  'a retired requirement keeps its number and is marked obsolete in the text.';

if (WRITE) {
  const doc = { oar: VERSION, note: NOTE, clauses: sortIds(ids) };
  writeFileSync(INDEX, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote spec/oar/${VERSION}/clause-index.json — ${ids.size} clause identifiers`);
} else if (!existsSync(INDEX)) {
  fail(
    `spec/oar/${VERSION}/clause-index.json does not exist. ` +
      'Create the baseline with: node scripts/check-clauses.mjs --write',
  );
} else {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(INDEX, 'utf8'));
  } catch (err) {
    fail(`spec/oar/${VERSION}/clause-index.json is not valid JSON — ${err.message}`);
  }
  if (baseline) {
    if (baseline.oar !== VERSION) {
      fail(`clause-index.json declares oar ${JSON.stringify(baseline.oar)}, expected "${VERSION}"`);
    }
    const released = baseline.clauses ?? [];
    const gone = released.filter((id) => !ids.has(id));
    if (gone.length > 0) {
      fail(
        `${gone.length} released clause identifier(s) no longer appear in the text: ${gone.join(', ')}. ` +
          'Clause identifiers are append-only — restore the clause, or mark it obsolete in place ' +
          'while keeping its identifier.',
      );
    }
    const added = sortIds([...ids].filter((id) => !released.includes(id)));
    if (added.length > 0) {
      console.log(
        `note: ${added.length} clause(s) not yet in the index: ${added.join(', ')}\n` +
          '      Run `node scripts/check-clauses.mjs --write` in the same PR that adds them.',
      );
    }
  }
}

if (errors.length > 0) {
  for (const err of errors) console.error(`error: ${err}`);
  console.error(`\n${errors.length} clause problem(s) in spec/oar/${VERSION}/open-agent-rules.md`);
  process.exit(1);
}

const areas = [...byArea.keys()].sort().join(', ');
console.log(`ok: ${defined.length} clauses across ${byArea.size} areas (${areas}) — dense, unique, append-only`);
