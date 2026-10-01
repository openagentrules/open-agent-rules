#!/usr/bin/env node
// Specification test coverage gate. Every clause of the specification carrying
// a MUST or a MUST NOT must be cited by the `covers` list of at least one
// conformance fixture, or listed in exempt.json with an explanation. This script
// is that gate: it exits non-zero on a gap, on a stale exemption, and on a fixture
// citing a clause the specification does not define.
//
// Usage: node scripts/check-coverage.mjs [spec-version]

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VERSION = process.argv[2] ?? '1.0';
const SPEC = join(ROOT, 'spec', 'oar', VERSION, 'open-agent-rules.md');
const CORPUS = join(ROOT, 'spec', 'oar', VERSION, 'conformance');

const CLAUSE_RE = /\*\*\[(OAR-[A-Z]+-[0-9]+)\]\*\*/g;

/**
 * Split the specification into clauses. A clause runs from its own identifier to
 * the next one (or to the next heading), so "MUST" anywhere in its body counts.
 */
function clauses(markdown) {
  const out = [];
  const marks = [...markdown.matchAll(CLAUSE_RE)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : markdown.length;
    out.push({ id: marks[i][1], text: markdown.slice(start, end) });
  }
  return out;
}

function isNormative(text) {
  // MUST NOT is a superset of MUST for this purpose; SHOULD and MAY are not
  // gated. The word must appear capitalised and standalone (RFC 2119 usage).
  return /\bMUST\b/.test(text);
}

async function main() {
  const markdown = await readFile(SPEC, 'utf8');
  const all = clauses(markdown);
  if (all.length === 0) {
    console.error(`error: no clause identifiers found in ${SPEC}`);
    process.exit(2);
  }

  const defined = new Set(all.map((c) => c.id));
  const required = all.filter((c) => isNormative(c.text)).map((c) => c.id);
  const requiredSet = new Set(required);

  const names = (await readdir(CORPUS)).filter(
    (n) => n.endsWith('.json') && n !== 'manifest.json' && n !== 'exempt.json',
  );
  const cited = new Map(); // clause -> fixture ids
  const problems = [];
  for (const name of names.sort()) {
    const fx = JSON.parse(await readFile(join(CORPUS, name), 'utf8'));
    const stem = name.replace(/\.json$/, '');
    if (fx.id !== stem) problems.push(`${name}: id ${JSON.stringify(fx.id)} != file stem ${JSON.stringify(stem)}`);
    // [OAR-CONF-30] An expected.error substring must be a single machine token —
    // a field name, an identifier, a clause identifier, or an enum member — and
    // must not be a phrase or a sentence. [OAR-CONF-21] frees an engine to word
    // its own diagnostics, and asserting a whole English sentence takes that
    // freedom back: a second implementation naming the same field in its own
    // words would fail a fixture it is behaving correctly on.
    const wanted = fx.expected?.error;
    if (typeof wanted === 'string' && !/^[A-Za-z0-9_][A-Za-z0-9_./:<>-]*$/.test(wanted)) {
      problems.push(`${name}: expected.error ${JSON.stringify(wanted)} is not a single machine token [OAR-CONF-30]`);
    }
    // [OAR-CONF-32] A counter a fixture hands the engine ready-made tests the
    // fixture loader; a counter the engine had to arrive at tests the engine.
    // So a fixture that asserts a non-zero counter, or gates an effect on one of
    // the counter-reading functions, has to reach that value through the
    // declared side-effects of the occurrences it lists.
    for (const facts of [fx.input?.facts ?? {}, ...(fx.input?.occurrences ?? []).map((o) => o.facts ?? {})]) {
      for (const fact of ['fire_count', 'breaker_count', 'fire_count_of', 'breaker_count_of']) {
        if (fact in facts) problems.push(`${name}: supplies ${fact} in facts [OAR-CONF-32]`);
      }
    }
    // The most an occurrence can add to a counter is the number of increments
    // the rule lists in on_fire — a rule may list one twice. A fixture asserting
    // more than every occurrence it lists could have written is asserting a value
    // no engine could reach, which means the fixture put it there rather than the
    // engine. Counter keys carry a #scope suffix for a scoped rule [OAR-CONF-33].
    const occurrenceCount = Array.isArray(fx.input?.occurrences) ? fx.input.occurrences.length : 1;
    const ACTION = { fire_count: 'increment_counter', breaker_count: 'increment_breaker' };
    for (const [key, counters] of Object.entries(fx.expected?.counters ?? {})) {
      const qualified = key.split('#')[0];
      const rule = (fx.rules ?? []).find(
        (r) => (r.namespace ? `${r.namespace}/${r.id}` : r.id) === qualified,
      );
      for (const [field, value] of Object.entries(counters ?? {})) {
        const perOccurrence = (rule?.on_fire ?? []).filter((a) => a === ACTION[field]).length;
        const ceiling = occurrenceCount * perOccurrence;
        if (typeof value === 'number' && value > ceiling) {
          problems.push(
            `${name}: expects ${key} ${field}=${value}, above the ${ceiling} that ` +
              `${occurrenceCount} occurrence(s) of this rule could write [OAR-CONF-32]`,
          );
        }
      }
    }
    for (const clause of fx.covers ?? []) {
      if (!defined.has(clause)) problems.push(`${name}: covers ${clause}, which the specification does not define`);
      if (!cited.has(clause)) cited.set(clause, []);
      cited.get(clause).push(fx.id);
    }
  }

  // The manifest is what an implementer downloads to find the corpus, so a
  // fixture missing from it is a fixture nobody outside this repository runs —
  // a silent hole in every conformance claim made against it.
  const manifest = JSON.parse(await readFile(join(CORPUS, 'manifest.json'), 'utf8'));
  const listed = new Set((manifest.fixtures ?? []).map((f) => f.file));
  const present = new Set(names);
  for (const file of [...present].sort()) {
    if (!listed.has(file)) problems.push(`${file} is not listed in conformance/manifest.json`);
  }
  for (const file of [...listed].sort()) {
    if (!present.has(file)) problems.push(`conformance/manifest.json lists ${file}, which does not exist`);
  }

  // [OAR-CONF-35] The manifest marks a fixture baseline exactly when its
  // capability document claims no profile, no host fact, no activity window, no
  // content mutation, and no detector beyond the three the corpus reserves. The
  // flag is computed here from the fixture itself, so the manifest cannot
  // quietly promise a different floor than the corpus delivers.
  const RESERVED = new Set(['detector://noop', 'detector://error', 'detector://fixture']);
  for (const entry of manifest.fixtures ?? []) {
    if (!present.has(entry.file)) continue;
    const fx = JSON.parse(await readFile(join(CORPUS, entry.file), 'utf8'));
    const cap = fx.input?.capability ?? {};
    const minimal =
      Array.isArray(cap.profiles) && cap.profiles.length === 0 &&
      (cap.host_facts === undefined || cap.host_facts.length === 0) &&
      cap.activity_window === 0 &&
      cap.supports_transform === false &&
      Array.isArray(cap.detectors) && cap.detectors.every((d) => RESERVED.has(d));
    const flagged = entry.baseline === true;
    if (minimal && !flagged) problems.push(`${entry.file}: declares the baseline capability but the manifest does not mark it baseline [OAR-CONF-35]`);
    if (!minimal && flagged) problems.push(`${entry.file}: marked baseline but declares more than the baseline capability [OAR-CONF-35]`);
  }

  const exemptDoc = JSON.parse(await readFile(join(CORPUS, 'exempt.json'), 'utf8'));
  const exempt = new Map();
  for (const entry of exemptDoc.exempt ?? []) {
    if (!defined.has(entry.clause_id)) problems.push(`exempt.json: ${entry.clause_id} is not a clause of this specification`);
    if (!requiredSet.has(entry.clause_id)) problems.push(`exempt.json: ${entry.clause_id} carries no MUST, so exempting it is noise`);
    if (!entry.reason || !entry.reason.trim()) problems.push(`exempt.json: ${entry.clause_id} has no written justification`);
    if (exempt.has(entry.clause_id)) problems.push(`exempt.json: ${entry.clause_id} listed twice`);
    exempt.set(entry.clause_id, entry.reason);
  }

  // A `partial` entry records a clause whose behavioural half a fixture exercises
  // and whose reporting half it cannot reach. Such a clause is covered, so it
  // must NOT also be exempted, and both halves must be written down.
  for (const entry of exemptDoc.partial ?? []) {
    if (!requiredSet.has(entry.clause_id)) problems.push(`exempt.json: partial ${entry.clause_id} carries no MUST`);
    if (!cited.has(entry.clause_id)) problems.push(`exempt.json: partial ${entry.clause_id} is not covered by any fixture — it belongs in exempt, not partial`);
    if (exempt.has(entry.clause_id)) problems.push(`exempt.json: ${entry.clause_id} is both exempted and partial`);
    if (!entry.fixtured || !entry.not_fixtured) problems.push(`exempt.json: partial ${entry.clause_id} must name what is and is not exercised`);
  }

  const uncovered = [];
  for (const id of required) {
    if (cited.has(id)) continue;
    if (exempt.has(id)) continue;
    uncovered.push(id);
  }
  for (const id of exempt.keys()) {
    if (cited.has(id)) problems.push(`exempt.json: ${id} is exempted but also covered by ${cited.get(id).join(', ')} — drop the exemption`);
  }

  const fixtured = required.filter((id) => cited.has(id)).length;
  console.log(`spec ${VERSION}: ${all.length} clauses, ${required.length} normative (MUST/MUST NOT)`);
  console.log(`  fixtured: ${fixtured}`);
  console.log(`  exempted: ${exempt.size}`);
  console.log(`  partial:  ${(exemptDoc.partial ?? []).length} (covered, with a reporting obligation no fixture can observe)`);
  console.log(`  uncovered: ${uncovered.length}`);
  console.log(`  fixtures: ${names.length}`);

  for (const p of problems) console.error(`error: ${p}`);
  for (const id of uncovered) console.error(`error: ${id} is neither covered by a fixture nor exempted`);

  if (problems.length > 0 || uncovered.length > 0) process.exit(1);
  console.log('ok: every normative clause is covered or exempted');
}

await main();
