#!/usr/bin/env node
// Fixture capability minimality: a fixture MUST declare only the capability it
// needs ([OAR-CONF-36]).
//
// Why this gate exists. An engine evaluates a fixture against the capability the
// *fixture* declares, and reports a fixture whose capability set it cannot adopt
// as skipped ([OAR-CONF-20]). So a declaration the fixture does not use is not
// inert: it narrows the set of engines that can run the fixture at all, for no
// coverage in return. The same declarations decide the *baseline* floor
// ([OAR-CONF-35]) — the mechanism that stops a conformance claim assembled
// entirely out of skips — so an unused `supports_transform: true` quietly shrinks
// the floor the corpus exists to hold.
//
// Why it probes rather than pattern-matches. A first attempt at this check
// computed "what the fixture needs" from its rules — transform effects, flow
// steps, detector refs, `requires` — and was wrong 29 times out of 113, because
// in this corpus the capability declaration is frequently the *subject* of the
// fixture rather than scaffolding for it: a fixture proving that a rule
// requiring an unprovided profile is rejected needs that profile to stay
// unprovided; one proving a host fact must be namespaced needs the badly-named
// fact to stay declared. No static predicate distinguishes those from boilerplate.
//
// The probe does. For each capability dimension, remove it and re-run the corpus:
// if the fixture's verdict is byte-identical without it, the declaration bought
// nothing and is over-declared. If the verdict moves, the declaration is
// load-bearing and stays. That is a definition rather than a heuristic, and it
// cannot produce the false positives the predicate did.
//
// Usage:  node scripts/check-capability-minimal.mjs [--fix]
// Exits 0 when every declaration is used or load-bearing, 1 otherwise.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CORPUS = join(ROOT, 'spec/oar/1.0/conformance');
const REF = join(ROOT, 'packages/oar-ref');
const FIX = process.argv.includes('--fix');

const SKIP_FILES = new Set(['manifest.json', 'exempt.json']);
const files = readdirSync(CORPUS)
  .filter((f) => f.endsWith('.json') && !SKIP_FILES.has(f))
  .sort();

const read = (f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf8'));
const write = (f, d) => writeFileSync(join(CORPUS, f), JSON.stringify(d, null, 2) + '\n');

// One corpus run, keyed by fixture id. The reference engine is the arbiter:
// these are its verdicts, and a reduction is safe exactly when they do not move.
function verdicts() {
  // The runner exits non-zero when fixtures fail, which is the *expected* state
  // while probing: a reduction that breaks a fixture is the signal being
  // measured. The report is on stdout either way, so read it and let the diff
  // decide, rather than treating a failing corpus as a broken runner.
  let out;
  try {
    out = execFileSync('node', ['bin/oar-conformance.mjs', '--json'], {
      cwd: REF,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (!e.stdout) throw e;
    out = e.stdout;
  }
  const parsed = JSON.parse(out);
  const map = new Map();
  for (const r of parsed.results ?? []) map.set(r.id, JSON.stringify(r));
  return map;
}

// The dimensions the baseline predicate reads ([OAR-CONF-35]). Each reduction
// returns true when it changed the document.
const DIMENSIONS = [
  {
    name: 'supports_transform',
    reduce(cap) {
      if (cap.supports_transform !== true) return false;
      cap.supports_transform = false;
      return true;
    },
  },
  {
    name: 'activity_window',
    reduce(cap) {
      if (!cap.activity_window) return false;
      cap.activity_window = 0;
      return true;
    },
  },
  {
    name: 'detectors',
    reduce(cap) {
      if (!Array.isArray(cap.detectors) || cap.detectors.length === 0) return false;
      cap.detectors = [];
      return true;
    },
  },
  {
    name: 'profiles',
    reduce(cap) {
      if (!Array.isArray(cap.profiles) || cap.profiles.length === 0) return false;
      cap.profiles = [];
      return true;
    },
  },
  {
    name: 'host_facts',
    reduce(cap) {
      if (!Array.isArray(cap.host_facts) || cap.host_facts.length === 0) return false;
      cap.host_facts = [];
      return true;
    },
  },
];

const baseline = verdicts();
const originals = new Map(files.map((f) => [f, readFileSync(join(CORPUS, f), 'utf8')]));
const restoreAll = () => {
  for (const [f, text] of originals) writeFileSync(join(CORPUS, f), text);
};

const overDeclared = []; // {file, dimension}

try {
  for (const dim of DIMENSIONS) {
    // Apply this dimension's reduction everywhere it applies, then run once.
    const touched = [];
    for (const f of files) {
      const doc = read(f);
      const cap = doc.input?.capability;
      if (!cap || typeof cap !== 'object') continue;
      if (dim.reduce(cap)) {
        write(f, doc);
        touched.push(f);
      }
    }
    if (touched.length === 0) continue;

    const after = verdicts();
    for (const f of touched) {
      const id = JSON.parse(originals.get(f)).id ?? f.replace(/\.json$/, '');
      // Unchanged verdict ⇒ the declaration bought nothing.
      if (baseline.get(id) === after.get(id)) overDeclared.push({ file: f, dimension: dim.name });
    }
    restoreAll();
  }
} finally {
  if (!FIX) restoreAll();
}

if (overDeclared.length === 0) {
  console.log(`capability minimality: ${files.length} fixtures, every declaration used or load-bearing.`);
  process.exit(0);
}

if (FIX) {
  // Re-apply exactly the reductions proven safe above, together.
  const byFile = new Map();
  for (const { file, dimension } of overDeclared) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(dimension);
  }
  for (const [f, dims] of byFile) {
    const doc = read(f);
    for (const name of dims) DIMENSIONS.find((d) => d.name === name).reduce(doc.input.capability);
    write(f, doc);
  }
  const after = verdicts();
  const moved = files.filter((f) => {
    const id = JSON.parse(originals.get(f)).id ?? f.replace(/\.json$/, '');
    return baseline.get(id) !== after.get(id);
  });
  if (moved.length > 0) {
    restoreAll();
    console.error('capability minimality --fix: combined reductions moved a verdict; reverted:');
    for (const f of moved) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`capability minimality --fix: reduced ${byFile.size} fixtures, ${overDeclared.length} declarations, verdicts unchanged.`);
  // Reductions interact: emptying `profiles` can free a `detectors` entry that
  // was load-bearing only because a claimed profile required it. So a pass can
  // expose more, and the fix runs to a fixed point rather than making the
  // contributor discover that by running it twice.
  let settled = true;
  try {
    execFileSync('node', [process.argv[1]], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    settled = false; // a non-zero exit means more declarations came free
  }
  if (!settled) {
    console.log('capability minimality --fix: reductions exposed more; re-running to a fixed point.');
    execFileSync('node', [process.argv[1], '--fix'], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
  }
  console.log('Re-run node scripts/check-coverage.mjs — baseline flags in manifest.json follow from these declarations.');
  process.exit(0);
}

console.error(`capability minimality: ${overDeclared.length} unused declaration(s) across ${new Set(overDeclared.map((o) => o.file)).size} fixture(s) [OAR-CONF-36].`);
console.error('Each one narrows which engines can run the fixture ([OAR-CONF-20]) and, for supports_transform, shrinks the baseline floor ([OAR-CONF-35]).');
for (const { file, dimension } of overDeclared) console.error(`  ${file}: ${dimension}`);
console.error('\nFix with: node scripts/check-capability-minimal.mjs --fix');
process.exit(1);
