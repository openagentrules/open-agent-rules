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
    case 'null': return null;
    case 'list': return node.items.map((item) => evaluate(item, ctx));
    case 'ident': return factValue(node.name, ctx);
    case 'select': {
      const target = factValue(node.target, ctx);
      if (typeof target !== 'object' || target === null || Array.isArray(target)) {
        throw new EvalError(`${node.target} is not a struct`);
      }
      // An absent field reads as the zero value of a string-typed selection,
      // matching how an absent observation reads elsewhere.
      const v = (target as Record<string, unknown>)[node.field];
      return v === undefined ? '' : (v as Value);
    }
    case 'call': {
      const fn = ctx.functions[node.name];
      if (!fn) throw new EvalError(`observation function ${node.name} is not bound`);
      return fn(evaluate(node.args[0]!, ctx));
    }
    case 'unary': {
      const v = evaluate(node.operand, ctx);
      if (node.op === '!') return !asBool(v);
      if (typeof v === 'bigint') return -v;
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
      if (!Array.isArray(r)) throw new EvalError('in applied to a non-list');
      return r.some((item) => same(item as Value, l));
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
      if (typeof l === 'bigint' && r === 0n) throw new EvalError('division by zero');
      return arith(l, r, (a, b) => a / b, (a, b) => a / b);
    case '%':
      if (typeof l === 'bigint' && r === 0n) throw new EvalError('modulo by zero');
      return arith(l, r, (a, b) => a % b, (a, b) => a % b);
  }
}

function arith(
  l: Value, r: Value,
  ints: (a: bigint, b: bigint) => bigint,
  doubles: (a: number, b: number) => number,
): Value {
  if (typeof l === 'bigint' && typeof r === 'bigint') return ints(l, r);
  if (typeof l === 'number' && typeof r === 'number') return doubles(l, r);
  throw new EvalError('arithmetic applied to non-numbers of the same type');
}

function compare(l: Value, r: Value): number {
  if (typeof l === 'bigint' && typeof r === 'bigint') return l < r ? -1 : l > r ? 1 : 0;
  if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : l > r ? 1 : 0;
  if (typeof l === 'string' && typeof r === 'string') return l < r ? -1 : l > r ? 1 : 0;
  throw new EvalError('ordered comparison of values of different types');
}

function same(l: Value, r: Value): boolean {
  if (Array.isArray(l) && Array.isArray(r)) {
    return l.length === r.length && l.every((v, i) => same(v as Value, r[i] as Value));
  }
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
  switch (decl.type) {
    case 'bool': return false;
    case 'int': return 0n;
    case 'double': return 0;
    case 'string': return '';
    case 'list<string>':
    case 'list<struct>': return [];
    case 'struct': return {};
  }
}

// JSON has one number type, so an int fact arrives as a JS number and is
// widened to the bigint the type check reasoned about.
function coerce(raw: Value, type: string): Value {
  if (type === 'int' && typeof raw === 'number') {
    if (!Number.isInteger(raw)) throw new EvalError(`int fact received ${raw}`);
    return BigInt(raw);
  }
  if (type === 'double' && typeof raw === 'bigint') return Number(raw);
  return raw;
}
