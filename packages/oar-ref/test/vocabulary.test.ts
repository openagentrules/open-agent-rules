// The transcription guard. src/vocab.ts is a hand transcription of the published
// core-fact, profile, and anchor tables; these tests re-read the tables and fail
// if the transcription drifts in either direction.
//
// [OAR-VER-5] adding a fact to an existing profile is a breaking change to that
// profile, so drift has to be visible.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { CORE_ANCHORS, CORE_FACTS, CORE_FUNCTIONS, PROFILES } from '../src/vocab.js';
import { SPEC_DIR } from './support.js';

interface Row {
  name: string;
  type: string;
}

/** Read the rows of a pipe table delimited by an <!-- oar:table <name> --> marker. */
function tableRows(markdown: string, marker: string, typed = true): { profile: string; rows: Row[] }[] {
  const start = markdown.indexOf(`<!-- oar:table ${marker} -->`);
  assert.ok(start !== -1, `no oar:table ${marker} marker in the specification`);
  const end = markdown.indexOf('<!-- /oar:table -->', start);
  const body = markdown.slice(start, end);

  const out: { profile: string; rows: Row[] }[] = [];
  let current: { profile: string; rows: Row[] } = { profile: marker, rows: [] };
  out.push(current);
  for (const line of body.split('\n')) {
    const header = /^\*\*Profile `([a-z-]+)`\*\*/.exec(line);
    if (header) {
      current = { profile: header[1]!, rows: [] };
      out.push(current);
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const name = /^`(.+)`$/.exec(cells[1]!);
    if (!name) continue;
    if (!typed) {
      current.rows.push({ name: name[1]!, type: '' });
      continue;
    }
    const type = /^`(.+)`$/.exec(cells[2]!);
    if (!type) continue;
    current.rows.push({ name: name[1]!, type: type[1]! });
  }
  return out.filter((t) => t.rows.length > 0);
}

const markdown = await readFile(join(SPEC_DIR, 'open-agent-rules.md'), 'utf8');

test('the transcribed core tier matches the published table', () => {
  // The core tier holds both facts and observation functions: fire_count_of and
  // breaker_count_of read another rule's counters ([OAR-FIRE-11]).
  const [core] = tableRows(markdown, 'core');
  assert.ok(core);
  const transcribed: Record<string, string> = { ...CORE_FACTS };
  for (const [name, sig] of Object.entries(CORE_FUNCTIONS)) {
    transcribed[name] = `(${sig.arg}) -> ${sig.ret}`;
  }
  const published = Object.fromEntries(core.rows.map((r) => [r.name, r.type]));
  assert.deepEqual(published, transcribed);
});

test('the transcribed vocabulary matches the published tables', () => {
  const tables = tableRows(markdown, 'profiles');
  assert.deepEqual(
    tables.map((t) => t.profile).sort(),
    Object.keys(PROFILES).sort(),
    'the set of published profiles and the set transcribed differ',
  );
  for (const table of tables) {
    const def = PROFILES[table.profile];
    assert.ok(def, `profile ${table.profile} is published but not transcribed`);
    const transcribed: Record<string, string> = { ...def.facts };
    for (const [name, sig] of Object.entries(def.functions)) {
      transcribed[name] = `(${sig.arg}) -> ${sig.ret}`;
    }
    const published = Object.fromEntries(table.rows.map((r) => [r.name, r.type]));
    assert.deepEqual(
      published,
      transcribed,
      `profile ${table.profile} drifted from the published table`,
    );
  }
});

test('the transcribed core anchors match the published table', () => {
  const [anchors] = tableRows(markdown, 'anchors', false);
  assert.ok(anchors);
  assert.deepEqual(anchors.rows.map((r) => r.name), [...CORE_ANCHORS]);
});

test('no fact and no observation function share a name', () => {
  // [OAR-FACT-2] Fact names and observation function names share one namespace.
  // An engine hosted in a language whose evaluator does not distinguish them
  // syntactically must still be implementable.
  const facts = new Set(Object.keys(CORE_FACTS));
  const functions = new Set(Object.keys(CORE_FUNCTIONS));
  for (const name of functions) {
    assert.ok(!facts.has(name), `${name} is declared as both a core fact and a core function`);
  }
  for (const def of Object.values(PROFILES)) {
    for (const name of Object.keys(def.facts)) {
      assert.ok(!functions.has(name), `${name} is declared as both a fact and a function`);
      facts.add(name);
    }
    for (const name of Object.keys(def.functions)) {
      assert.ok(!facts.has(name), `${name} is declared as both a fact and a function`);
      functions.add(name);
    }
  }
  // Not vacuous: the mcp profile carries both the bare and the _for form.
  assert.ok(facts.has('mcp_provider_configured'));
  assert.ok(functions.has('mcp_provider_configured_for'));
});
