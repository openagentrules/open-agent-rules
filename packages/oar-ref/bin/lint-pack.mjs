#!/usr/bin/env node
// Lint example packs: every rule and hint document must validate against the
// published schemas, and every fixture must replay to its expected outcome.
// Usage: node bin/lint-pack.mjs <pack-dir>...   (defaults to ../../examples)

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = resolve(pkgRoot, '../../spec/oar/1.1/schemas');
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

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const name of ['selector.schema.json', 'oar.schema.json']) {
  ajv.addSchema(JSON.parse(await readFile(join(schemaDir, name), 'utf8')), name);
}
const validateDoc = ajv.getSchema('oar.schema.json');

let failed = false;
for (const pack of packs) {
  const fixturesDir = join(pack, 'fixtures');
  if (!existsSync(fixturesDir)) {
    console.log(`skip ${pack} (no fixtures/)`);
    continue;
  }
  const fixtures = await loadFixtures(fixturesDir);
  let packFailed = false;
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
