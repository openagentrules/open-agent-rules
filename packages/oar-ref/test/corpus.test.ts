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

import { fixtureShapeError, loadFixtures, loadManifest, runFixture, type Fixture } from '../src/runner.js';
import { parse, UnsupportedCelConstruct } from '../src/parse.js';
import { loadHint, loadRule, RuleLoadError } from '../src/load.js';
import { referenceAnchorProfile, referenceEnvironment, withHostFacts } from '../src/env.js';
import { canonicalDouble, CopyRenderError, parseCopyTemplate, renderCopy } from '../src/copy.js';
import { CounterStore, decide } from '../src/decide.js';

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
const CORPUS = join(REPO, 'spec', 'oar', '1.0', 'conformance');
const SCHEMAS = join(REPO, 'spec', 'oar', '1.0', 'schemas');

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
  assert.equal(manifest.spec_version, '1.0');
  assert.deepEqual(
    manifest.fixtures.map((f) => f.id).sort(),
    fixtures.map((f) => f.id).sort(),
  );
});

test('every fixture rule validates against the published schema', async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of ['selector.schema.json', 'oar.schema.json']) {
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
    for (const doc of Array.isArray(fx.hints) ? fx.hints : []) {
      assert.ok(validate(doc), `${fx.id} hint: ${ajv.errorsText(validate.errors)}`);
    }
  }
});

test('every fixture uses only the members the fixture shape defines', async () => {
  for (const fx of await loadFixtures(CORPUS)) {
    assert.equal(fixtureShapeError(fx), null, fx.id);
  }
});

test('a fixture asserting an undefined expected key fails rather than passing', () => {
  const fx = {
    id: 'undefined-expected-key',
    title: 'An undefined expected key',
    covers: ['OAR-CONF-15'],
    rule: {
      spec_version: '1.0', id: 'R', kind: 'policy', on: 'tool.pre_invoke', selector: {},
      effect: 'block', when: 'tool == "read"',
    },
    input: { anchor: 'tool.pre_invoke', facts: { tool: 'read' } },
    expected: { decision: 'block', verdict: 'deny' },
  } as unknown as Fixture;
  const result = runFixture(fx);
  assert.equal(result.pass, false);
  assert.match(result.detail ?? '', /verdict/);
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
    spec_version: '1.0', id: 'GHOST', kind: 'policy', on: 'tool.pre_invoke',
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
    spec_version: '1.0', id: 'NOT_BOOL', kind: 'policy', on: 'tool.pre_invoke',
    selector: {}, effect: 'block', when: 'tool',
  };
  assert.throws(
    () => loadRule(doc, { env: referenceEnvironment(), profile: referenceAnchorProfile() }),
    /want bool/,
  );
});

// --- copy bindings (Appendix B) ------------------------------------------------

const LOADOPTS = { env: referenceEnvironment(), profile: referenceAnchorProfile() };

test('a double renders in the canonical form of [OAR-COPY-9]', () => {
  assert.equal(canonicalDouble(1.0), '1.0');
  assert.equal(canonicalDouble(0.0000001), '0.0000001');
  assert.equal(canonicalDouble(-2.5), '-2.5');
  assert.equal(canonicalDouble(0.0), '0.0');
  assert.equal(canonicalDouble(-0.0), '0.0');
  assert.equal(canonicalDouble(1e21), '1000000000000000000000.0');
  assert.equal(canonicalDouble(0.91), '0.91');
  assert.throws(() => canonicalDouble(Infinity), CopyRenderError);
});

test('copy bindings render against the occurrence facts', () => {
  const env = referenceEnvironment();
  const parts = parseCopyTemplate(
    'R', 'what',
    'tool {{tool}} {% if path_denied %}denied{% else %}allowed{% endif %} n={{ breaker_count }}',
    env,
  );
  assert.equal(
    renderCopy(parts, { tool: 'shell', path_denied: true, breaker_count: 3n }, env),
    'tool shell denied n=3',
  );
  assert.equal(
    renderCopy(parts, { tool: 'shell', path_denied: false, breaker_count: 0n }, env),
    'tool shell allowed n=0',
  );
  // [OAR-COPY-8] whitespace inside the delimiters is insignificant.
  assert.deepEqual(parseCopyTemplate('R', 'what', '{{ tool }}', env), parseCopyTemplate('R', 'what', '{{tool}}', env));
  // A list<string> joins with ", "; an empty list renders as the empty string.
  const list = parseCopyTemplate('R', 'fix', 'errors: {{ arg_validation_errors }}', env);
  assert.equal(renderCopy(list, { arg_validation_errors: ['a', 'b'] }, env), 'errors: a, b');
  assert.equal(renderCopy(list, { arg_validation_errors: [] }, env), 'errors: ');
});

test('copy bindings are validated at load', () => {
  const base = {
    spec_version: '1.0', id: 'R', kind: 'policy', on: 'tool.pre_invoke',
    selector: {}, effect: 'block', when: 'tool == "x"',
  };
  // [OAR-COPY-2] an unknown binding is a load failure naming the identifier.
  assert.throws(
    () => loadRule({ ...base, what: 'no {{ ghost_fact }} here' }, LOADOPTS),
    (err: unknown) => err instanceof RuleLoadError && err.message.includes('ghost_fact'),
  );
  // [OAR-COPY-4] a non-interpolatable type is a load failure.
  assert.throws(() => loadRule({ ...base, what: 'args {{ tool_args }}' }, LOADOPTS), /cannot be interpolated/);
  // [OAR-COPY-3] a construct the grammar does not derive is a load failure
  // naming the construct.
  assert.throws(() => loadRule({ ...base, what: '{% if tool %}x' }, LOADOPTS), /unterminated conditional/);
  assert.throws(() => loadRule({ ...base, what: '{{ tool ' }, LOADOPTS), /unterminated binding/);
  assert.throws(() => loadRule({ ...base, what: '{% when tool %}' }, LOADOPTS), /not a construct of the copy grammar/);
  assert.throws(() => loadRule({ ...base, what: '{% endif %}' }, LOADOPTS), /outside a conditional/);
});

test('a non-core fact named only in copy must be reached through requires_facts', () => {
  const base = {
    spec_version: '1.0', id: 'R', kind: 'policy', on: 'tool.pre_invoke',
    selector: {}, effect: 'block', when: 'tool == "x"',
  };
  assert.throws(
    () => loadRule({ ...base, what: 'score {{ prompt_injection_score }}' }, LOADOPTS),
    /requires_facts/,
  );
  loadRule(
    { ...base, requires_facts: ['prompt_injection_score'], what: 'score {{ prompt_injection_score }}' },
    LOADOPTS,
  );
  loadRule(
    { ...base, when: 'prompt_injection_score > 0.5', what: 'score {{ prompt_injection_score }}' },
    LOADOPTS,
  );
});

test('copy does not affect selection or the decision ([OAR-COPY-6])', () => {
  const mk = (what: string) => loadRule(
    {
      spec_version: '1.0', id: 'R', kind: 'policy', on: 'tool.pre_invoke',
      selector: {}, effect: 'block', when: 'tool == "shell"', what,
    },
    LOADOPTS,
  );
  const plain = decide([mk('plain')], { anchor: 'tool.pre_invoke', facts: { tool: 'shell' } }, { env: LOADOPTS.env });
  const bound = decide(
    [mk('tool {{ tool }} n={{ breaker_count }}')],
    { anchor: 'tool.pre_invoke', facts: { tool: 'shell' } },
    { env: LOADOPTS.env },
  );
  assert.deepEqual({ ...plain.decision, copy: undefined }, { ...bound.decision, copy: undefined });
  assert.equal(bound.decision?.copy?.what, 'tool shell n=0');
});

test('an on_error block omits copy whose observation failed ([OAR-COPY-10])', () => {
  const rule = loadRule(
    {
      spec_version: '1.0', id: 'R', kind: 'policy', on: 'tool.pre_invoke', selector: {},
      effect: 'block', when: 'prompt_injection_score > 0.5', on_error: 'fail_closed',
      what: 'errors: {{ arg_validation_errors }}',
    },
    LOADOPTS,
  );
  // The double arrives non-finite (a fact-provider failure, [OAR-FACT-17]) so
  // the condition errors, and the copy's list arrives with non-string members
  // so rendering fails too: the block stands without copy, nothing coerced.
  const r = decide(
    [rule],
    { anchor: 'tool.pre_invoke', facts: { prompt_injection_score: 1e999, arg_validation_errors: [1] } },
    { env: LOADOPTS.env },
  );
  assert.equal(r.decision?.effect, 'block');
  assert.equal(r.decision?.code, 'R');
  assert.equal(r.decision?.copy, undefined);
});

test('a substitute on_error block carries the substitute rule\'s copy', () => {
  const sub = loadRule(
    {
      spec_version: '1.0', id: 'SUB', kind: 'policy', on: 'tool.pre_invoke', selector: {},
      effect: 'block', when: 'tool == "nope"', what: 'substitute for {{ tool }}',
    },
    LOADOPTS,
  );
  const bad = loadRule(
    {
      spec_version: '1.0', id: 'BAD', kind: 'policy', on: 'tool.pre_invoke', selector: {},
      effect: 'block', when: 'prompt_injection_score > 0.5', on_error: 'SUB',
      what: 'bad {{ arg_validation_errors }}',
    },
    LOADOPTS,
  );
  const r = decide(
    [bad, sub],
    { anchor: 'tool.pre_invoke', facts: { prompt_injection_score: 1e999 } },
    { env: LOADOPTS.env },
  );
  assert.equal(r.decision?.code, 'SUB');
  assert.equal(r.decision?.copy?.what, 'substitute for ');
});

// --- hints (section 9) ----------------------------------------------------------

test('a hint loads as a copy publication and rejects evaluation fields', () => {
  const hint = loadHint({
    spec_version: '1.0', id: 'TOOL_OUTPUT_SPILL_CAPPED', kind: 'hint',
    severity: 'info', what: 'Output was capped.', fix: 'Narrow the request.',
  });
  assert.equal(hint.id, 'TOOL_OUTPUT_SPILL_CAPPED');
  assert.equal(hint.kind, 'hint');
  // [OAR-HINT-1] no evaluation fields.
  assert.throws(() => loadHint({ spec_version: '1.0', id: 'H', kind: 'hint', when: 'tool', what: 'x' }), /\[OAR-HINT-1\]/);
  assert.throws(() => loadHint({ spec_version: '1.0', id: 'H', kind: 'hint', effect: 'block', what: 'x' }), /\[OAR-HINT-1\]/);
  // [OAR-HINT-2] at least one copy member.
  assert.throws(() => loadHint({ spec_version: '1.0', id: 'H', kind: 'hint' }), /\[OAR-HINT-2\]/);
  // [OAR-HINT-3] copy is static.
  assert.throws(() => loadHint({ spec_version: '1.0', id: 'H', kind: 'hint', what: 'has {{ x }}' }), /\[OAR-HINT-3\]/);
  // An unsupported spec_version is rejected, not coerced.
  assert.throws(() => loadHint({ spec_version: '1.1', id: 'H', kind: 'hint', what: 'x' }), /unsupported spec_version/);
});

test('host facts extend the environment under [OAR-FACT-19]', () => {
  const env = withHostFacts(referenceEnvironment(), { scope_hint: 'string' });
  assert.equal(env.facts['scope_hint']?.type, 'string');
  assert.equal(env.facts['scope_hint']?.tier, 'host');
  assert.throws(() => withHostFacts(referenceEnvironment(), { tool: 'string' }), /collides/);
  assert.throws(() => withHostFacts(referenceEnvironment(), { x: 'list<map>' }), /data-type vocabulary/);
});
