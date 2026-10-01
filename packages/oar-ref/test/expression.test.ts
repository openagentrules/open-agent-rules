// Appendix A: the grammar, the type rules, and the run-time raises.

import assert from 'node:assert/strict';
import test from 'node:test';

import { referenceEnvironment } from '../src/capability.js';
import { check } from '../src/check.js';
import { ConditionRaise, evaluate, type Value } from '../src/eval.js';
import { ConditionSyntaxError, countNodes, parse, type Node } from '../src/parse.js';

const env = referenceEnvironment();
const reachable = new Set<string>([
  ...[...env.facts.keys()],
  ...[...env.functions.keys()],
]);

function typeOf(src: string): string {
  return check(parse(src), { env, reachable }).type;
}

function run(src: string, facts: Record<string, Value> = {}): Value {
  const ast = parse(src);
  check(ast, { env, reachable });
  return evaluate(ast, { facts: new Map(Object.entries(facts)), functions: new Map() });
}

test('the grammar rejects what it does not derive, naming the construct and its offset', () => {
  // [OAR-EXPR-1] Every rejection names the offending construct and its offset.
  const cases: [string, string][] = [
    ['{"a": 1}', 'a map literal is not part of the condition language'],
    ['true // comment', 'a comment is not part of the condition language'],
    ['true /* comment */', 'a comment is not part of the condition language'],
    ['1 < 2 == true', 'a relation admits at most one relational operator'],
    ['!!true', 'a unary operator may not be repeated'],
    ['- -1 == 0', 'a unary operator may not be repeated'],
    ['size(anchor).n == 1', 'there is no field-selection operator'],
    ['1e5 > 0', 'exponent notation is not part of the condition language'],
    ['1u > 0', 'an unsigned literal is not part of the condition language'],
    ['anchor = "x"', 'assignment is not part of the condition language'],
    ['9223372036854775808 > 0', 'integer literal 9223372036854775808 does not fit int'],
    ['true & false', 'bitwise "&" is not part of the condition language'],
    ['"unterminated', 'unterminated string literal'],
    ['"\\x41" == ""', 'unsupported string escape'],
    ['"\\u00" == ""', '\\u must be followed by exactly four hexadecimal digits'],
  ];
  for (const [src, want] of cases) {
    assert.throws(
      () => parse(src),
      (err: unknown) => {
        assert.ok(err instanceof ConditionSyntaxError, `${src} raised ${String(err)}`);
        assert.ok(err.message.includes(want), `${src}: ${err.message} does not mention ${want}`);
        assert.ok(/at offset \d+$/.test(err.message), `${src}: ${err.message} names no offset`);
        return true;
      },
    );
  }
});

test('the grammar accepts what it derives', () => {
  for (const src of [
    'true',
    'anchor == "model.input"',
    'fire_count >= 3 && breaker_count < 2',
    'anchor == "a" ? fire_count > 0 : breaker_count > 0',
    '"read" in ["read", "write"]',
    '"path" in tool_args',
    'size(pii_entities) > 0 && "kind" in pii_entities[0]',
    'tool_arg_string("path") == "/etc/passwd"',
    'path_outside_scope(tool)',
    '-fire_count < 0',
    '!policy_denied',
    '(fire_count + 1) * 2 % 3 == 0',
    'prompt_injection_score > 0.5',
    'anchor == "a" || anchor == "b" || anchor == "c"',
  ]) {
    assert.doesNotThrow(() => parse(src), `${src} should parse`);
  }
});

test('operator precedence is tightest-first as published', () => {
  // [OAR-EXPR-4] index; unary; * / %; + -; comparisons; == !=; &&; ||; ternary.
  assert.equal(run('1 + 2 * 3 == 7'), true);
  assert.equal(run('(1 + 2) * 3 == 9'), true);
  assert.equal(run('-2 * 3 == 0 - 6'), true);
  assert.equal(run('true || false && false'), true);
  assert.equal(run('true ? false ? 1 : 2 : 3'), 2n);
});

test('&& and || short-circuit', () => {
  // [OAR-EXPR-5] The right operand is not evaluated when the left decides.
  assert.equal(run('false && 1 / 0 == 0'), false);
  assert.equal(run('true || 1 / 0 == 0'), true);
  assert.throws(() => run('true && 1 / 0 == 0'), ConditionRaise);
});

test('the type rules reject at load rather than defaulting at run time', () => {
  const cases: [string, string][] = [
    ['tool && true', '&& takes bool operands'],
    ['!anchor', '! takes bool, given string'],
    ['true ? anchor : 1', 'the ternary branches are string and int, which differ'],
    ['anchor ? 1 : 2', 'the ternary condition must be bool, given string'],
    ['1 + 2.5 > 0.0', 'takes two int or two double operands'],
    ['1.0 % 2.0 > 0.0', '% takes two int operands'],
    ['anchor == 1', 'compares unrelated types string and int'],
    ['anchor < 1', 'takes two numbers or two strings'],
    ['1 in ["a"]', 'in takes a string on the left'],
    ['"a" in anchor', 'in takes a list<string> or a map on the right'],
    ['tool_args["path"] == "x"', 'may not be indexed'],
    ['pii_entities["a"] == pii_entities[0]', 'does not accept list<map> indexed by string'],
    ['size(fire_count) > 0', 'size() takes a string, a list, or a map, given int'],
    ['size() > 0', 'size() takes exactly one argument'],
    ['path_outside_scope(1)', 'takes string, given int'],
    ['ghost_fact', 'unknown identifier ghost_fact'],
    ['null == null', 'unknown identifier null'],
    ['anchor in []', 'the empty list literal [] has no inferable type'],
    ['anchor in ["a", 1]', 'a list literal is list<string> or list<map>'],
    ['pii_entities == secret_matches', 'does not compare two aggregate values'],
    ['tool()', 'is a fact, not an observation function'],
    ['path_outside_scope', 'is an observation function and must be called'],
  ];
  for (const [src, want] of cases) {
    assert.throws(
      () => typeOf(src),
      (err: unknown) => {
        assert.ok((err as Error).message.includes(want), `${src}: ${(err as Error).message}`);
        return true;
      },
    );
  }
});

test('a dotted identifier whose prefix is a map fact gets a targeted hint', () => {
  // [OAR-EXPR-2], [OAR-EXPR-19] "unknown identifier" alone does not hint at the
  // real problem, which is that there is no field-selection operator.
  assert.throws(
    () => typeOf('tool_args.path == "x"'),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.includes('unknown identifier tool_args.path'), message);
      assert.ok(message.includes('there is no field-selection operator'), message);
      assert.ok(message.includes('"path" in tool_args'), message);
      return true;
    },
  );
});

test('int is promoted to double for a mixed comparison only', () => {
  // [OAR-EXPR-10], [OAR-EXPR-11], [OAR-FACT-23]
  assert.equal(typeOf('fire_count > 0.5'), 'bool');
  assert.equal(run('3 > 0.5'), true);
  assert.equal(run('1 == 1.0'), true);
  assert.equal(run('2 < 1.5'), false);
  // Promotion is for the comparison only: arithmetic still needs one type.
  assert.throws(() => typeOf('fire_count + 0.5 > 0.0'), /takes two int or two double/);
});

test('the run-time raises are exactly the three the specification names', () => {
  // [OAR-EXPR-13] absent key or out-of-range index.
  assert.throws(
    () => run('size(pii_entities[2]) > 0', { pii_entities: [] }),
    /list index 2 is out of range/,
  );
  assert.throws(
    () => run('size(secret_matches[0]) > 0', { secret_matches: [] }),
    /out of range/,
  );
  // [OAR-EXPR-14] division and modulo by zero.
  assert.throws(() => run('1 / 0 == 0'), /division by zero/);
  assert.throws(() => run('1 % 0 == 0'), /modulo by zero/);
  // [OAR-EXPR-15] 64-bit integer overflow raises rather than wrapping.
  assert.throws(() => run('9223372036854775807 + 1 > 0'), /overflows a 64-bit signed integer/);
  assert.throws(() => run('0 - 9223372036854775807 - 2 < 0'), /overflows a 64-bit signed integer/);
});

test('a map<string,string> index raises on an absent key', () => {
  // The reference host declares no map<string,string> fact, so this exercises
  // the evaluator directly against the shape [OAR-EXPR-13] types.
  const ast = parse('"a"');
  assert.equal(countNodes(ast), 1);
  assert.throws(
    () =>
      evaluate(parse('m["absent"]'), {
        facts: new Map<string, Value>([['m', { present: 'x' }]]),
        functions: new Map(),
      }),
    /map key "absent" is absent/,
  );
});

test('size counts Unicode code points on a string', () => {
  // [OAR-EXPR-16] size() is the only built-in.
  assert.equal(run('size("ré🙂d")'), 4n);
  assert.equal(run('size(["a", "b"])'), 2n);
  assert.equal(run('size(tool_args)', { tool_args: { a: 1, b: 2 } }), 2n);
});

test('nodes are counted exactly as [OAR-EXPR-20] defines', () => {
  // A literal, an identifier, a call, an index, a unary, a binary, a ternary.
  // Call arguments, index operands, and list members count separately; a list
  // literal is itself one node; parentheses are not nodes.
  assert.equal(countNodes(parse('true')), 1);
  assert.equal(countNodes(parse('anchor')), 1);
  assert.equal(countNodes(parse('(((anchor)))')), 1, 'parentheses do not survive parsing');
  assert.equal(countNodes(parse('!true')), 2);
  assert.equal(countNodes(parse('1 + 2')), 3);
  assert.equal(countNodes(parse('size(anchor)')), 2);
  assert.equal(countNodes(parse('pii_entities[0]')), 3);
  assert.equal(countNodes(parse('["a", "b", "c"]')), 4, 'a list literal is one node plus its members');
  assert.equal(countNodes(parse('true ? 1 : 2')), 4);
  // The published floor, built the way the corpus builds it.
  const terms = ['!(fire_count == 999)'].concat(
    Array.from({ length: 63 }, (_, i) => `fire_count == ${i + 1}`),
  );
  assert.equal(countNodes(parse(terms.join(' || '))), 256);
});

test('the parse tree admits no loop, recursion, or user-defined function', () => {
  // [OAR-EXPR-18] Evaluation terminates structurally: the node kinds the parser
  // can produce are exactly those [OAR-EXPR-20] enumerates, and none of them
  // introduces a binding form, a loop, or a definition.
  const kinds = new Set<string>();
  const collect = (node: Node): void => {
    kinds.add(node.kind);
    switch (node.kind) {
      case 'list':
        node.items.forEach(collect);
        break;
      case 'call':
        node.args.forEach(collect);
        break;
      case 'index':
        collect(node.target);
        collect(node.index);
        break;
      case 'unary':
        collect(node.operand);
        break;
      case 'binary':
        collect(node.left);
        collect(node.right);
        break;
      case 'ternary':
        collect(node.cond);
        collect(node.then);
        collect(node.other);
        break;
      default:
        break;
    }
  };
  for (const src of [
    'true', '1', '1.5', '"s"', '["a"]', 'anchor', 'size(anchor)',
    'pii_entities[0]', '!true', '1 + 1', 'true ? 1 : 2',
  ]) {
    collect(parse(src));
  }
  assert.deepEqual(
    [...kinds].sort(),
    ['binary', 'bool', 'call', 'double', 'ident', 'index', 'int', 'list', 'string', 'ternary', 'unary'],
    'the parser produces a node kind outside the published enumeration',
  );
  // No macro, comprehension, or lambda form exists to introduce a binding: each
  // of these is refused, either by the grammar or by the closed environment.
  for (const src of ['[1, 2].all(x, x > 0)', 'has(anchor)', 'anchor.map(x, x)', 'anchor.startsWith("a")']) {
    assert.throws(() => typeOf(src), `${src} must not survive loading`);
  }
});
