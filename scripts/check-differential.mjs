#!/usr/bin/env node
// Compare production conformance reports fixture by fixture.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CORPUS = join(ROOT, 'spec/oar/1.0/conformance');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const GATEWAY = resolve(arg('--gateway', join(ROOT, '../oar-gateway')));

if (!existsSync(CORPUS) || !existsSync(join(CORPUS, 'manifest.json'))) {
  console.error('differential: no corpus yet — nothing to compare.');
  process.exit(0);
}
if (!existsSync(GATEWAY)) {
  // The second implementation is optional.
  console.log(`differential: second implementation not found at ${GATEWAY} — skipped.`);
  console.log('             (clone it to run this gate; it is not required to build the standard)');
  process.exit(0);
}

/** Serialise object keys while preserving semantic array order. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** Normalise a verdict so the two engines' shapes are comparable. */
function normalise(v) {
  if (v === null || v === undefined) return null;
  // Error wording is outside the contract.
  if (v.error !== undefined) return { errored: true };
  const out = {};
  if (v.decision !== undefined) out.decision = v.decision ?? 'none';
  out.code = v.code ?? null;
  out.rule = v.rule ?? null;
  out.applied = Array.isArray(v.applied) ? v.applied : [];
  out.on_fire = Array.isArray(v.on_fire) ? v.on_fire : [];
  out.skipped_transforms = Array.isArray(v.skipped_transforms) ? v.skipped_transforms : [];
  out.transforms = Array.isArray(v.transforms) ? v.transforms : [];
  out.advisories = Array.isArray(v.advisories) ? v.advisories.map(a => ({ ...a, copy: a.copy ?? {} })) : [];
  out.counters = v.counters ?? {};
  out.events = Array.isArray(v.events) ? v.events : [];
  out.content = v.content ?? null;
  out.copy = v.copy ?? {};
  return out;
}

function runEngine(label, cmd, args, opts = {}) {
  try {
    const raw = execFileSync(cmd, args, {
      cwd: opts.cwd ?? ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const out = (err.stdout || '').trim();
    if (out) {
      try { return { ok: true, value: JSON.parse(out) }; } catch { /* not JSON */ }
    }
    const detail = ((err.stderr || '') + (err.message || '')).split('\n')[0];
    return { ok: false, label, detail };
  }
}

const fixtures = readdirSync(CORPUS)
  .filter((f) => f.endsWith('.json') && !['manifest.json', 'exempt.json'].includes(f))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const reportPath = arg('--report', null);
console.log(`differential: ${fixtures.length} fixtures, ${reportPath ? 'three' : 'two'} engines\n`);

const a = runEngine('oar-ref (TypeScript)', 'node',
  [join(ROOT, 'packages/oar-ref/bin/oar-conformance.mjs'), CORPUS, '--json']);
const b = runEngine('oar-gateway (Rust)', 'cargo',
  ['run', '--locked', '--quiet', '-p', 'oar-gateway', '--', 'conformance', CORPUS, '--json'], { cwd: GATEWAY });

// Only completed runs can disagree.
if (!b.ok) {
  console.log(`differential: Rust implementation failed to run.`);
  console.log(`              (${b.detail})`);
  process.exit(1);
}
if (!a.ok) {
  console.error(`differential: reference implementation failed to run: ${a.detail}`);
  process.exit(1);
}

const index = (r) => (Array.isArray(r?.results)
  ? Object.fromEntries(r.results.map((x) => [x.id, x]))
  : (r?.results ?? r));

const A = index(a.value), B = index(b.value);
// Additional reports must come from each host's authorized verification entry
// point; this gate does not launch another repository's build or test runner.
const C = reportPath ? index(JSON.parse(readFileSync(resolve(reportPath), 'utf8'))) : null;
const disagreements = [];
let compared = 0, skipped = 0;

for (const id of fixtures) {
  const va = A[id], vb = B[id];
  if (!va || !vb) { disagreements.push({ id, kind: "missing result", a: !!va, b: !!vb }); continue; }
  if (va.skipped && vb.skipped) { skipped++; continue; }
  if (va.pass === false || va.passed === false || vb.pass === false || vb.passed === false) {
    disagreements.push({ id, kind: "conformance failure", a: va.error ?? va.message, b: vb.error ?? vb.message });
  }
  // Shared capability skips are comparable ([OAR-CONF-20]).
  if (va.skipped !== vb.skipped) {
    disagreements.push({ id, kind: 'skip', a: va.skipped ? 'skipped' : 'ran', b: vb.skipped ? 'skipped' : 'ran' });
    continue;
  }
  if (C) {
    const vc = C[id];
    if (!vc || vc.skipped || vc.pass === false || vc.passed === false) {
      disagreements.push({ id, kind: 'additional report missing, skipped, or failed', a: 'pass', b: JSON.stringify(vc) });
    } else if (stable(normalise(va.actual ?? va)) !== stable(normalise(vc.actual ?? vc))) {
      disagreements.push({ id, kind: 'additional report verdict', a: stable(normalise(va.actual ?? va)), b: stable(normalise(vc.actual ?? vc)) });
    }
  }
  compared++;
  const na = stable(normalise(va.actual ?? va));
  const nb = stable(normalise(vb.actual ?? vb));
  if (na !== nb) disagreements.push({ id, kind: 'verdict', a: na, b: nb });
}

console.log(`compared ${compared}, skipped by both ${skipped}`);

if (disagreements.length === 0) {
  console.log('\nok: all supplied engines agree on every compared fixture.');
  process.exit(0);
}

console.error(`\n${disagreements.length} disagreement(s) — each is a candidate specification bug:\n`);
for (const d of disagreements) {
  console.error(`  ${d.id} [${d.kind}]`);
  console.error(`    oar-ref      ${d.a}`);
    console.error(`    ${d.kind.startsWith('additional report') ? 'additional report' : 'oar-gateway'}  ${d.b}`);
}
console.error('\nReview each discrepancy against the specification.');
process.exit(1);
