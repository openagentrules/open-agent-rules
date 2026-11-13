#!/usr/bin/env node
// Lint example packs. Every YAML document in a pack is loaded: rule and hint
// documents validate against the published schemas and load together as a rule
// set, a profile map validates against its schema and [OAR-PROF-2], and the
// fixtures must replay exactly the documents the pack publishes. Every fixture
// must then replay to its expected outcome.
// Usage: node bin/lint-pack.mjs <pack-dir>...   (defaults to ../../examples)

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const YAML = require('yaml');

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = resolve(pkgRoot, '../../spec/oar/1.0/schemas');
// A pack is a directory with a fixtures/ member. An argument that names a
// directory of packs (no fixtures/ of its own) expands to its pack children.
function expandPack(p) {
  if (existsSync(join(p, 'fixtures'))) return [p];
  return readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(p, e.name, 'fixtures')))
    .map((e) => join(p, e.name))
    .sort();
}
const packArgs = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map((p) => resolve(p))
  : [resolve(pkgRoot, '../../examples')];
const packs = packArgs.flatMap(expandPack);

const { loadFixtures, runFixture } = await import('../dist/src/runner.js');
const { loadRuleSet } = await import('../dist/src/load.js');
const { referenceEnvironment, referenceAnchorProfile, validateAnchorProfile, withHostFacts } = await import('../dist/src/env.js');
const { jsonEqual } = await import('../dist/src/decide.js');

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const name of ['selector.schema.json', 'oar.schema.json', 'oar-profile.schema.json']) {
  ajv.addSchema(JSON.parse(await readFile(join(schemaDir, name), 'utf8')), name);
}
const validateDoc = ajv.getSchema('oar.schema.json');
const validateProfile = ajv.getSchema('oar-profile.schema.json');

/** Load a pack's YAML: its rule and hint documents, profile map, and host-fact catalog. */
async function loadPackYaml(pack) {
  const out = { docs: [], profile: null, hostFacts: {}, problems: [] };
  for (const name of (await readdir(pack)).filter((n) => n.endsWith('.yaml')).sort()) {
    const parsed = YAML.parseAllDocuments(await readFile(join(pack, name), 'utf8'));
    for (const doc of parsed) {
      if (doc.errors.length > 0) {
        out.problems.push(`${name}: ${doc.errors[0].message}`);
        continue;
      }
      const value = doc.toJS();
      if (value === null || typeof value !== 'object') continue;
      if ('oar_profile_version' in value) {
        if (!validateProfile(value)) out.problems.push(`${name}: ${ajv.errorsText(validateProfile.errors)}`);
        out.profile = value;
      } else if ('spec_version' in value || 'id' in value || 'kind' in value) {
        if (!validateDoc(value)) out.problems.push(`${name} (${value.id}): ${ajv.errorsText(validateDoc.errors)}`);
        out.docs.push({ file: name, doc: value });
      } else {
        // A host-fact catalog: fact name to declared type.
        Object.assign(out.hostFacts, value);
      }
    }
  }
  return out;
}

let failed = false;
for (const pack of packs) {
  const fixturesDir = join(pack, 'fixtures');
  if (!existsSync(fixturesDir)) {
    console.log(`skip ${pack} (no fixtures/)`);
    continue;
  }
  const fixtures = await loadFixtures(fixturesDir);
  let packFailed = false;
  const yaml = await loadPackYaml(pack);
  for (const problem of yaml.problems) {
    console.log(`FAIL ${problem}`);
    packFailed = true;
  }
  try {
    if (yaml.profile) {
      validateAnchorProfile({ version: yaml.profile.oar_profile_version, core: yaml.profile.core ?? {}, unsupported: yaml.profile.unsupported ?? [] });
    }
    const env = withHostFacts(referenceEnvironment(), yaml.hostFacts);
    const docs = yaml.docs.map((d) => d.doc);
    // The reference host maps every core anchor, so a rule on an anchor the
    // pack's own profile leaves unsupported loads against the reference map.
    loadRuleSet(docs.filter((d) => d.kind !== 'hint'), docs.filter((d) => d.kind === 'hint'),
      { env, profile: referenceAnchorProfile(), detectors: ['detector://noop', 'detector://fixture', 'detector://error'] });
  } catch (err) {
    console.log(`FAIL ${pack}: the pack's documents do not load as a rule set: ${err.message}`);
    packFailed = true;
  }
  // The fixtures replay exactly what the pack publishes.
  const published = yaml.docs.map((d) => d.doc);
  for (const fx of fixtures) {
    if (fx.expected?.error !== undefined) continue;
    const ruleDocs = Array.isArray(fx.rule) ? fx.rule : fx.rule !== undefined ? [fx.rule] : [];
    const hintDocs = Array.isArray(fx.hints) ? fx.hints : [];
    for (const doc of [...ruleDocs, ...hintDocs]) {
      if (!published.some((p) => jsonEqual(p, doc))) {
        console.log(`FAIL ${fx.id}: replays ${doc.namespace ?? ''}/${doc.id}, which differs from the pack's YAML`);
        packFailed = true;
      }
    }
  }
  for (const fx of fixtures) {
    const ruleDocs = Array.isArray(fx.rule) ? fx.rule : fx.rule !== undefined ? [fx.rule] : [];
    const hintDocs = Array.isArray(fx.hints) ? fx.hints : [];
    // A fixture that expects a load error is testing the loader with a
    // document that is intentionally invalid; schema-validity of the offending
    // document is not the point, so it is not checked.
    const expectsLoadError = fx.expected?.error !== undefined;
    for (const [label, doc] of [...ruleDocs.map((d) => ['rule', d]), ...hintDocs.map((d) => ['hint', d])]) {
      if (expectsLoadError) break;
      if (!validateDoc(doc)) {
        console.log(`FAIL ${fx.id} (${label}): ${ajv.errorsText(validateDoc.errors)}`);
        packFailed = true;
      }
    }
    const result = runFixture(fx);
    if (!result.pass) {
      console.log(`FAIL ${fx.id}: ${result.detail ?? 'did not match expectation'}`);
      packFailed = true;
    }
  }
  if (packFailed) failed = true;
  else console.log(`ok   ${pack} (${fixtures.length} fixture${fixtures.length === 1 ? '' : 's'})`);
}

process.exit(failed ? 1 : 0);
