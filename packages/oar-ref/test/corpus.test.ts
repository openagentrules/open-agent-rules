import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createRequire } from 'node:module';

// ajv is CommonJS and is a test-only dependency; require it directly rather
// than fighting the ESM interop for one constructor.
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020') as new (opts: object) => {
  addSchema(schema: unknown, key: string): void;
  getSchema(key: string): ((doc: unknown) => boolean) & { errors?: unknown };
  errorsText(errors: unknown): string;
};

import { loadFixtures, loadManifest, runFixture } from '../src/runner.js';
import { parse, UnsupportedCelConstruct } from '../src/parse.js';
import { loadRule, RuleLoadError } from '../src/load.js';
import { referenceAnchorProfile, referenceEnvironment } from '../src/env.js';

// Walk up to the repository root so the paths hold whether these run from
// source or from the compiled output.
function repoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'spec', 'oar'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('spec/oar not found above ' + from);
    dir = parent;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO = repoRoot(here);
const CORPUS = join(REPO, 'spec', 'oar', '1.1', 'conformance');
const SCHEMAS = join(REPO, 'spec', 'oar', '1.1', 'schemas');

test('the published corpus passes end to end', async () => {
  const fixtures = await loadFixtures(CORPUS);
  assert.ok(fixtures.length >= 20, `corpus holds only ${fixtures.length} fixtures`);
  const failures = fixtures.map(runFixture).filter((r) => !r.pass);
  assert.deepEqual(
    failures.map((f) => `${f.id}: ${f.detail}`),
    [],
  );
});

test('the manifest and the corpus directory describe the same fixtures', async () => {
  const manifest = await loadManifest(CORPUS);
  const fixtures = await loadFixtures(CORPUS);
  assert.equal(manifest.spec_version, '1.1');
  assert.deepEqual(
    manifest.fixtures.map((f) => f.id).sort(),
    fixtures.map((f) => f.id).sort(),
  );
});

test('every fixture rule validates against the published schema', async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of ['selector.schema.json', 'anchor-binding.schema.json', 'oar.schema.json']) {
    const doc = JSON.parse(await readFile(join(SCHEMAS, name), 'utf8'));
    ajv.addSchema(doc, name);
  }
  const validate = ajv.getSchema('oar.schema.json');
  assert.ok(validate, 'oar.schema.json did not compile');

  for (const fx of await loadFixtures(CORPUS)) {
    if (fx.expected.error !== undefined) continue; // deliberately invalid
    const docs = Array.isArray(fx.rule) ? fx.rule : [fx.rule];
    for (const doc of docs) {
      assert.ok(validate(doc), `${fx.id}: ${ajv.errorsText(validate.errors)}`);
    }
  }
});

test('constructs outside the declared subset are refused by name', () => {
  const cases: [string, string][] = [
    ['has(tool)', 'macro has'],
    ['[1, 2].all(x, x > 0)', 'macro all'],
    ['tool_args["path"]', 'index expression'],
    ['{"a": 1}', 'map literal'],
    ['tool.startsWith("r")', 'method call'],
    ['tool_args.a.b', 'chained field selection'],
    ['path_outside_scope(path_outside_scope("read"))', 'nested call argument'],
  ];
  for (const [expr, want] of cases) {
    assert.throws(
      () => parse(expr),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedCelConstruct, `${expr} raised ${err}`);
        assert.ok(err.message.includes(want), `${expr}: ${err.message} does not name ${want}`);
        return true;
      },
    );
  }
});

test('an undeclared fact is rejected at load, before any evaluation', () => {
  const doc = {
    spec_version: '1.1', id: 'GHOST', kind: 'policy', on: 'tool.pre_invoke',
    selector: {}, effect: 'block', when: 'ghost_fact',
  };
  assert.throws(
    () => loadRule(doc, { env: referenceEnvironment(), profile: referenceAnchorProfile() }),
    (err: unknown) => {
      assert.ok(err instanceof RuleLoadError);
      assert.ok(err.message.includes('ghost_fact'), err.message);
      return true;
    },
  );
});

test('a condition that is not boolean is rejected at load', () => {
  const doc = {
    spec_version: '1.1', id: 'NOT_BOOL', kind: 'policy', on: 'tool.pre_invoke',
    selector: {}, effect: 'block', when: 'tool',
  };
  assert.throws(
    () => loadRule(doc, { env: referenceEnvironment(), profile: referenceAnchorProfile() }),
    /want bool/,
  );
});
