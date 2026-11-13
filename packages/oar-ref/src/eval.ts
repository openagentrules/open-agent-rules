// Evaluation of an already type-checked condition against a fact map. Nothing
// here reaches outside the supplied facts: a condition cannot mutate state and
// cannot perform input or output, so every state change an engine makes is one
// the rule declared through on_fire.

import type { Node } from './parse.js';
import type { Environment } from './env.js';

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

export type Value = boolean | bigint | number | string | unknown[] | Record<string, unknown> | null;

export interface EvalContext {
  readonly facts: Readonly<Record<string, Value>>;
  readonly env: Environment;
  /** Observation functions, keyed by name. */
  readonly functions: Readonly<Record<string, (arg: Value) => Value>>;
}

export function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.kind) {
    case 'bool': return node.value;
    case 'int': return node.value;
    case 'double': return node.value;
    case 'string': return node.value;
    case 'list': return node.items.map((item) => evaluate(item, ctx));
    case 'ident': return factValue(node.name, ctx);
    case 'select': {
      // A namespaced host fact is stored under its full dotted name; when the
      // occurrence carries it, the node reads that fact rather than selecting
      // into a map (see the matching case in load.ts). A declared flat fact
      // reads through the same coercion and zero-value rules as an ident, so
      // an int host fact compares as a bigint and an absent one reads as its
      // zero value ([OAR-FACT-24], [OAR-FACT-25]).
      const flat = `${node.target}.${node.field}`;
      const flatDecl = ctx.env.facts[flat];
      if (flatDecl !== undefined) {
        const raw = ctx.facts[flat];
        if (raw !== undefined && raw !== null) return coerce(raw as Value, flatDecl.type);
        return zeroValue(flatDecl.type);
      }
      const target = factValue(node.target, ctx);
      if (typeof target !== 'object' || target === null || Array.isArray(target)) {
        throw new EvalError(`${node.target} is not a map<string, dyn>`);
      }
      // [OAR-EXPR-13] A selected member is a string. An absent member reads as
      // the empty string; a present non-string member raises.
      const v = (target as Record<string, unknown>)[node.field];
      if (v === undefined || v === null) return '';
      if (typeof v !== 'string') throw new EvalError(`${node.target}.${node.field} is not a string`);
      return v;
    }
    case 'call': {
      const args = node.args.map((a) => evaluate(a, ctx));
      const builtin = BUILTIN_IMPLS[node.name];
      if (builtin) return builtin(args);
      const fn = ctx.functions[node.name];
      if (!fn) throw new EvalError(`observation function ${node.name} is not bound`);
      return fn(args[0]!);
    }
    case 'unary': {
      const v = evaluate(node.operand, ctx);
      if (node.op === '!') return !asBool(v);
      if (typeof v === 'bigint') return checkInt(-v);
      if (typeof v === 'number') return -v;
      throw new EvalError('unary - applied to a non-number');
    }
    case 'ternary':
      return asBool(evaluate(node.cond, ctx))
        ? evaluate(node.then, ctx)
        : evaluate(node.other, ctx);
    case 'binary':
      return binary(node, ctx);
  }
}

function binary(node: Extract<Node, { kind: 'binary' }>, ctx: EvalContext): Value {
  // && and || short-circuit, so the right arm is not evaluated when the left
  // already decides the result.
  if (node.op === '&&') {
    return asBool(evaluate(node.left, ctx)) ? asBool(evaluate(node.right, ctx)) : false;
  }
  if (node.op === '||') {
    return asBool(evaluate(node.left, ctx)) ? true : asBool(evaluate(node.right, ctx));
  }
  const l = evaluate(node.left, ctx);
  const r = evaluate(node.right, ctx);
  switch (node.op) {
    case '==': return same(l, r);
    case '!=': return !same(l, r);
    case 'in': {
      if (Array.isArray(r)) return r.some((item) => same(item as Value, l));
      if (typeof r === 'object' && r !== null) return Object.prototype.hasOwnProperty.call(r, l as string);
      throw new EvalError('in applied to a non-collection');
    }
    case '<': return compare(l, r) < 0;
    case '<=': return compare(l, r) <= 0;
    case '>': return compare(l, r) > 0;
    case '>=': return compare(l, r) >= 0;
    case '+':
      if (typeof l === 'string' && typeof r === 'string') return l + r;
      return arith(l, r, (a, b) => a + b, (a, b) => a + b);
    case '-': return arith(l, r, (a, b) => a - b, (a, b) => a - b);
    case '*': return arith(l, r, (a, b) => a * b, (a, b) => a * b);
    case '/':
      if (r === 0n || r === 0) throw new EvalError('division by zero');
      return arith(l, r, (a, b) => a / b, (a, b) => a / b);
    case '%':
      if (r === 0n) throw new EvalError('modulo by zero');
      return arith(l, r, (a, b) => a % b, (a, b) => a % b);
  }
}

function arith(
  l: Value, r: Value,
  ints: (a: bigint, b: bigint) => bigint,
  doubles: (a: number, b: number) => number,
): Value {
  // [OAR-EXPR-14] No wrapping and no infinities: BigInt division already
  // truncates toward zero, so only the range needs checking.
  if (typeof l === 'bigint' && typeof r === 'bigint') return checkInt(ints(l, r));
  if (typeof l === 'number' && typeof r === 'number') {
    const v = doubles(l, r);
    if (!Number.isFinite(v)) throw new EvalError('double arithmetic is not finite');
    return v;
  }
  throw new EvalError('arithmetic applied to non-numbers of the same type');
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function checkInt(v: bigint): bigint {
  if (v < INT64_MIN || v > INT64_MAX) throw new EvalError('integer overflow');
  return v;
}

// Strings compare by Unicode code point ([OAR-EXPR-10]); JavaScript's own
// comparison is by UTF-16 code unit, which orders astral characters differently.
function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

// The built-ins of [OAR-EXPR-17]. The string ones compare code point sequences
// with no normalisation and no case folding; on well-formed UTF-16 a code-unit
// prefix, suffix, or substring match is the same as a code-point one.
const BUILTIN_IMPLS: Readonly<Record<string, (args: Value[]) => Value>> = {
  size: ([x]) => {
    if (typeof x === 'string') return BigInt([...x].length);
    if (Array.isArray(x)) return BigInt(x.length);
    if (typeof x === 'object' && x !== null) return BigInt(Object.keys(x).length);
    throw new EvalError('size applied to a non-collection');
  },
  starts_with: ([s, p]) => (s as string).startsWith(p as string),
  ends_with: ([s, p]) => (s as string).endsWith(p as string),
  contains: ([s, p]) => (s as string).includes(p as string),
};

function compare(l: Value, r: Value): number {
  if (typeof l === 'bigint' && typeof r === 'bigint') return l < r ? -1 : l > r ? 1 : 0;
  if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : l > r ? 1 : 0;
  if (typeof l === 'string' && typeof r === 'string') return compareCodePoints(l, r);
  throw new EvalError('ordered comparison of values of different types');
}

// == and != apply to scalars only ([OAR-EXPR-11]); aggregates are refused at load.
function same(l: Value, r: Value): boolean {
  return l === r;
}

function asBool(v: Value): boolean {
  if (typeof v !== 'boolean') throw new EvalError('expected a boolean');
  return v;
}

/**
 * Read a declared fact. An absent value reads as the zero of its declared
 * type — the host published the fact, it simply had nothing to report.
 */
export function factValue(name: string, ctx: EvalContext): Value {
  const decl = ctx.env.facts[name];
  if (!decl) throw new EvalError(`${name} is not a declared fact`);
  const raw = ctx.facts[name];
  if (raw !== undefined && raw !== null) return coerce(raw, decl.type);
  return zeroValue(decl.type);
}

function zeroValue(type: string): Value {
  switch (type) {
    case 'bool': return false;
    case 'int': return 0n;
    case 'double': return 0;
    case 'string': return '';
    case 'list<string>':
    case 'list<map<string, dyn>>': return [];
    case 'map<string, dyn>': return {};
  }
  throw new EvalError(`fact type ${type} has no zero value`);
}

// JSON has one number type, so an int fact arrives as a JS number and is
// widened to the bigint the type check reasoned about.
function coerce(raw: Value, type: string): Value {
  if (type === 'int' && typeof raw === 'number') {
    if (!Number.isInteger(raw)) throw new EvalError(`int fact received ${raw}`);
    return BigInt(raw);
  }
  if (type === 'double') {
    // [OAR-FACT-17] A non-finite double is a fact-provider failure, never a
    // value the engine coerces or defaults.
    const n = typeof raw === 'bigint' ? Number(raw) : raw;
    if (typeof n === 'number' && !Number.isFinite(n)) {
      throw new EvalError('double fact is not finite');
    }
    if (typeof raw === 'bigint') return n;
  }
  return raw;
}
