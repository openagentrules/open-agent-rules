// The published corpus, end to end, plus the obligations [OAR-CONF-17] to
// [OAR-CONF-19] put on the fixtures themselves.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { loadFixtures, loadManifest, runFixture } from '../src/runner.js';
import { CORPUS, EXAMPLES, SCHEMAS } from './support.js';
import { loadPack, readCapabilityFile } from '../src/pack.js';

// ajv is CommonJS and test-only; require it rather than fighting ESM interop.
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020') as new (opts: object) => {
  addSchema(schema: unknown, key: string): void;
  getSchema(key: string): ((doc: unknown) => boolean) & { errors?: unknown };
  errorsText(errors: unknown): string;
};

async function validator(entry: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of [
    'oar.schema.json',
    'oar-capability.schema.json',
    'oar-config.schema.json',
    'oar-fixture.schema.json',
  ]) {
    const doc = JSON.parse(await readFile(join(SCHEMAS, name), 'utf8')) as { $id?: string };
    ajv.addSchema(doc, doc.$id ?? name);
  }
  const validate = ajv.getSchema(`https://openagentrules.org/spec/1.0/${entry}`);
  assert.ok(validate, `${entry} did not compile`);
  return { ajv, validate };
}

test('the published corpus passes end to end', async () => {
  const fixtures = await loadFixtures(CORPUS);
  assert.ok(fixtures.length >= 100, `corpus holds only ${fixtures.length} fixtures`);
  const results = fixtures.map(runFixture);
  assert.deepEqual(
    results.filter((r) => !r.pass && !r.skipped).map((r) => `${r.id}: ${r.detail}`),
    [],
  );
  // [OAR-CONF-24] A skipped fixture is not a passed fixture. The reference
  // engine claims every published profile, so it should skip nothing.
  assert.deepEqual(results.filter((r) => r.skipped).map((r) => r.id), []);
});

test('the manifest and the corpus directory describe the same fixtures', async () => {
  const manifest = await loadManifest(CORPUS);
  const fixtures = await loadFixtures(CORPUS);
  assert.equal(manifest.oar, '1.0');
  assert.deepEqual(
    manifest.fixtures.map((f) => f.id).sort(),
    fixtures.map((f) => f.id).sort(),
  );
  for (const entry of manifest.fixtures) {
    const fx = fixtures.find((f) => f.id === entry.id)!;
    assert.equal(entry.file, `${entry.id}.json`);
    assert.deepEqual(entry.covers, [...fx.covers], `${entry.id}: manifest covers drifted`);
    assert.equal(entry.title, fx.title, `${entry.id}: manifest title drifted`);
  }
});

test('every fixture validates against the published fixture schema', async () => {
  // [OAR-CONF-17], [OAR-CONF-18] The fixture shape is the schema's business.
  // A fixture asserting a load-time rejection carries a deliberately invalid
  // payload, so for those the nested rule, capability, and configuration
  // documents are checked structurally only — the payload is the point.
  const { ajv, validate } = await validator('oar-fixture.schema.json');
  const relaxed = JSON.parse(await readFile(join(SCHEMAS, 'oar-fixture.schema.json'), 'utf8')) as Record<string, unknown>;
  const props = (relaxed['properties'] as Record<string, Record<string, unknown>>)['input']!
    .properties as Record<string, unknown>;
  props['capability'] = { type: 'object' };
  props['config'] = { type: 'array', items: { type: 'object' } };
  (relaxed['properties'] as Record<string, Record<string, unknown>>)['rules'] = {
    type: 'array',
    minItems: 1,
  };
  relaxed['$id'] = 'https://openagentrules.org/spec/1.0/oar-fixture-relaxed.schema.json';
  const relaxedAjv = new Ajv2020({ strict: false, allErrors: true });
  relaxedAjv.addSchema(relaxed, 'relaxed');
  const validateRelaxed = relaxedAjv.getSchema('relaxed');

  const names = (await readdir(CORPUS)).filter(
    (n) => n.endsWith('.json') && n !== 'manifest.json' && n !== 'exempt.json',
  );
  for (const name of names) {
    const doc = JSON.parse(await readFile(join(CORPUS, name), 'utf8')) as {
      id: string;
      expected: Record<string, unknown>;
    };
    if (typeof doc.expected['error'] === 'string') {
      assert.ok(validateRelaxed(doc), `${name}: ${relaxedAjv.errorsText(validateRelaxed.errors)}`);
    } else {
      assert.ok(validate(doc), `${name}: ${ajv.errorsText(validate.errors)}`);
    }
    // [OAR-CONF-17] id equals the file name stem.
    assert.equal(doc.id, name.replace(/\.json$/, ''));
  }
});

test('every fixture declares the host it assumes', async () => {
  // [OAR-CONF-19] Without one, a fixture asks each implementation a different
  // question — whether a rule loads would depend on which anchors and profiles
  // that implementation happens to support.
  for (const fx of await loadFixtures(CORPUS)) {
    assert.ok(fx.input?.capability, `${fx.id} carries no input.capability`);
    assert.equal(
      (fx.input.capability as { oar_capability_version?: string }).oar_capability_version,
      '1.0',
      `${fx.id} declares the wrong capability version`,
    );
  }
});

test('every fixture rule that is meant to load validates against the rule schema', async () => {
  // A fixture asserting a load-time rejection is deliberately invalid; every
  // other rule document must satisfy the published schema.
  const { ajv, validate } = await validator('oar.schema.json');
  for (const fx of await loadFixtures(CORPUS)) {
    if (typeof fx.expected['error'] === 'string') continue;
    for (const doc of fx.rules) {
      assert.ok(validate(doc), `${fx.id}: ${ajv.errorsText(validate.errors)}`);
    }
  }
});

test('every fixture capability document validates against the capability schema', async () => {
  const { ajv, validate } = await validator('oar-capability.schema.json');
  for (const fx of await loadFixtures(CORPUS)) {
    // A handful of fixtures are about a capability document being rejected.
    if (typeof fx.expected['error'] === 'string') continue;
    assert.ok(validate(fx.input.capability), `${fx.id}: ${ajv.errorsText(validate.errors)}`);
  }
});

test('every expected.error is a single machine token', async () => {
  // [OAR-CONF-30] A fixture asserts that the right thing was named, never how
  // it was phrased. [OAR-CONF-21] frees an engine to word its own diagnostics,
  // and a corpus asserting whole English sentences takes that freedom back: a
  // second implementation reporting the same defect, naming the same field, in
  // its own words would fail a fixture it is behaving correctly on.
  const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_./:<>-]*$/;
  let asserted = 0;
  for (const fx of await loadFixtures(CORPUS)) {
    const wanted = fx.expected['error'];
    if (typeof wanted !== 'string') continue;
    asserted++;
    assert.ok(!/\s/.test(wanted), `${fx.id}: expected.error ${JSON.stringify(wanted)} is a phrase, not a token`);
    assert.ok(TOKEN.test(wanted), `${fx.id}: expected.error ${JSON.stringify(wanted)} is not a machine token`);
  }
  assert.ok(asserted > 50, `only ${asserted} fixtures assert a load-time rejection`);
});

test('the exemption list is admissible and disjoint from the corpus', async () => {
  // [OAR-CONF-28] An exemption is admissible only for a clause a fixture cannot
  // observe, and must name the check that enforces it instead.
  const doc = JSON.parse(await readFile(join(CORPUS, 'exempt.json'), 'utf8')) as {
    _note: string;
    exempt: { clause_id: string; reason: string; check?: string }[];
    partial?: { clause_id: string; fixtured: string; not_fixtured: string }[];
  };
  assert.ok(doc._note.length > 0);
  const covered = new Set<string>();
  for (const fx of await loadFixtures(CORPUS)) for (const c of fx.covers) covered.add(c);
  for (const entry of doc.exempt) {
    assert.match(entry.clause_id, /^OAR-[A-Z]+-\d+$/);
    assert.ok(entry.reason.length > 80, `${entry.clause_id}: the justification is too thin`);
    assert.ok(entry.check, `${entry.clause_id}: names no check that enforces it instead`);
    assert.ok(!covered.has(entry.clause_id), `${entry.clause_id} is both exempted and covered`);
  }
  // A partial entry records a clause a fixture covers behaviourally but whose
  // reporting obligation no fixture can observe. It must be covered, and must
  // never also be exempted: a green corpus should not imply more than it tested.
  const exempted = new Set(doc.exempt.map((e) => e.clause_id));
  for (const entry of doc.partial ?? []) {
    assert.ok(covered.has(entry.clause_id), `${entry.clause_id} is partial but no fixture covers it`);
    assert.ok(!exempted.has(entry.clause_id), `${entry.clause_id} is both exempted and partial`);
    assert.ok(entry.fixtured.length > 40, `${entry.clause_id}: does not say what is exercised`);
    assert.ok(entry.not_fixtured.length > 40, `${entry.clause_id}: does not say what is not`);
  }
});

test('the published example pack loads against the host it declares', async () => {
  // A rule here that fails to load is a bug in the pack or the engine.
  const env = await readCapabilityFile(join(EXAMPLES, 'capability.yaml'));
  const report = await loadPack(EXAMPLES, env);
  assert.deepEqual(report.errors, []);
  assert.equal(report.loaded, report.documents);
  assert.equal(report.documents, 10, 'the pack should hold ten rule documents');
  assert.ok(report.set, 'the pack should link as a rule set');
});
