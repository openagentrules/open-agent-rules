// Evaluation of an already type-checked condition.
//
// [OAR-FACT-10] Condition evaluation is free of side-effects: nothing here
// mutates state and nothing performs input or output. Every state change an
// engine makes is one the rule declared through `on_fire`.
//
// The only failures reachable at run time are the three the specification names:
// an absent map key or an out-of-range index ([OAR-EXPR-13]), division or modulo
// by zero ([OAR-EXPR-14]), and 64-bit integer overflow ([OAR-EXPR-15]). Each
// raises, and the rule is then handled per its `on_error`.

import type { Node } from './parse.js';
import type { FactType } from './vocab.js';

export class ConditionRaise extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionRaise';
  }
}

export type Value =
  | boolean
  | bigint
  | number
  | string
  | readonly string[]
  | readonly Record<string, unknown>[]
  | Record<string, unknown>;

const INT_MIN = -(2n ** 63n);
const INT_MAX = 2n ** 63n - 1n;

function checkInt(v: bigint, what: string): bigint {
  // [OAR-EXPR-15] Integer arithmetic that overflows 64 bits raises rather than wraps.
  if (v < INT_MIN || v > INT_MAX) throw new ConditionRaise(`${what} overflows a 64-bit signed integer`);
  return v;
}

function checkDouble(v: number, what: string): number {
  // [OAR-EXPR-14] No arithmetic operation produces an IEEE infinity or NaN:
  // every comparison against a non-finite value silently decides one way, and
  // [OAR-FACT-23] has already excluded non-finite values from the type.
  if (!Number.isFinite(v)) throw new ConditionRaise(`${what} produced a non-finite double`);
  return v;
}

/** The zero value of a declared type, for a fact the occurrence did not report. */
export function zeroValue(type: FactType): Value {
  switch (type) {
    case 'bool':
      return false;
    case 'int':
      return 0n;
    case 'double':
      return 0;
    case 'string':
      return '';
    case 'list<string>':
      return [];
    case 'list<map>':
      return [];
    case 'map':
    case 'map<string,string>':
      return {};
  }
}

export interface EvalContext {
  /** Fact values for this occurrence, in their runtime representations. */
  readonly facts: ReadonlyMap<string, Value>;
  /** Observation functions, keyed by name. */
  readonly functions: ReadonlyMap<string, (arg: Value) => Value>;
}

export function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.kind) {
    case 'bool':
      return node.value;
    case 'int':
      return checkInt(node.value, 'an integer literal');
    case 'double':
      return node.value;
    case 'string':
      return node.value;
    case 'list':
      return node.items.map((i) => evaluate(i, ctx) as string);

    case 'ident': {
      const v = ctx.facts.get(node.name);
      if (v === undefined) throw new ConditionRaise(`fact ${node.name} was not produced`);
      return v;
    }

    case 'call': {
      if (node.name === 'size') return size(evaluate(node.args[0]!, ctx));
      if (node.name === 'starts_with' || node.name === 'ends_with' || node.name === 'contains') {
        const s = evaluate(node.args[0]!, ctx) as string;
        const needle = evaluate(node.args[1]!, ctx) as string;
        if (node.name === 'starts_with') return startsWith(s, needle);
        if (node.name === 'ends_with') return endsWith(s, needle);
        return contains(s, needle);
      }
      const fn = ctx.functions.get(node.name);
      if (fn === undefined) throw new ConditionRaise(`observation function ${node.name} was not produced`);
      return fn(evaluate(node.args[0]!, ctx));
    }

    case 'index': {
      const target = evaluate(node.target, ctx);
      const index = evaluate(node.index, ctx);
      if (Array.isArray(target)) {
        const i = Number(index as bigint);
        // [OAR-EXPR-13], [OAR-EXPR-21] Out of range raises, and a negative
        // index is out of range like any other.
        if (!Number.isSafeInteger(i) || i < 0 || i >= target.length) {
          throw new ConditionRaise(`list index ${String(index)} is out of range`);
        }
        return target[i] as Value;
      }
      if (typeof target === 'object' && target !== null) {
        const key = String(index);
        const map = target as Record<string, unknown>;
        // [OAR-EXPR-13] An absent key raises.
        if (!Object.prototype.hasOwnProperty.call(map, key)) {
          throw new ConditionRaise(`map key ${JSON.stringify(key)} is absent`);
        }
        return map[key] as Value;
      }
      throw new ConditionRaise('the index operator was applied to a scalar');
    }

    case 'unary': {
      // [OAR-EXPR-20] Retain both syntactic nodes for the least signed integer.
      if (node.op === '-' && node.operand.kind === 'int' && node.operand.value === -INT_MIN) return INT_MIN;
      const v = evaluate(node.operand, ctx);
      if (node.op === '!') return !(v as boolean);
      if (typeof v === 'bigint') return checkInt(-v, 'negation');
      return -(v as number);
    }

    case 'ternary':
      // Only the taken branch is evaluated.
      return (evaluate(node.cond, ctx) as boolean) ? evaluate(node.then, ctx) : evaluate(node.other, ctx);

    case 'binary':
      return binary(node, ctx);
  }
}

function binary(node: Extract<Node, { kind: 'binary' }>, ctx: EvalContext): Value {
  // [OAR-EXPR-5] && and || short-circuit: the right operand is not evaluated
  // when the left decides the result. A condition can therefore guard an
  // expensive or partial sub-expression behind a cheap one.
  if (node.op === '&&') {
    if (!(evaluate(node.left, ctx) as boolean)) return false;
    return evaluate(node.right, ctx) as boolean;
  }
  if (node.op === '||') {
    if (evaluate(node.left, ctx) as boolean) return true;
    return evaluate(node.right, ctx) as boolean;
  }

  const l = evaluate(node.left, ctx);
  const r = evaluate(node.right, ctx);

  switch (node.op) {
    case 'in': {
      const needle = l as string;
      if (Array.isArray(r)) return (r as readonly string[]).includes(needle);
      if (typeof r === 'object' && r !== null) {
        return Object.prototype.hasOwnProperty.call(r as Record<string, unknown>, needle);
      }
      throw new ConditionRaise('in was applied to a scalar');
    }
    case '==':
      return equal(l, r);
    case '!=':
      return !equal(l, r);
    case '<':
      return compare(l, r) < 0;
    case '<=':
      return compare(l, r) <= 0;
    case '>':
      return compare(l, r) > 0;
    case '>=':
      return compare(l, r) >= 0;
    case '+':
      if (typeof l === 'string') return l + (r as string);
      if (typeof l === 'bigint') return checkInt(l + (r as bigint), 'addition');
      return checkDouble((l as number) + (r as number), 'addition');
    case '-':
      if (typeof l === 'bigint') return checkInt(l - (r as bigint), 'subtraction');
      return checkDouble((l as number) - (r as number), 'subtraction');
    case '*':
      if (typeof l === 'bigint') return checkInt(l * (r as bigint), 'multiplication');
      return checkDouble((l as number) * (r as number), 'multiplication');
    case '/':
      if (typeof l === 'bigint') {
        // [OAR-EXPR-14] Division by zero raises.
        if ((r as bigint) === 0n) throw new ConditionRaise('division by zero');
        // [OAR-EXPR-21] Integer division truncates toward zero, which is what
        // BigInt division already does: -7n / 2n is -3n, and -7n % 2n is -1n.
        return checkInt(l / (r as bigint), 'division');
      }
      if ((r as number) === 0) throw new ConditionRaise('division by zero');
      return checkDouble((l as number) / (r as number), 'division');
    case '%':
      // [OAR-EXPR-14] Modulo by zero raises.
      if ((r as bigint) === 0n) throw new ConditionRaise('modulo by zero');
      return checkInt((l as bigint) % (r as bigint), 'modulo');
    default:
      throw new ConditionRaise(`unreachable operator ${String(node.op)}`);
  }
}

function equal(l: Value, r: Value): boolean {
  // [OAR-EXPR-10] int is promoted to double for a mixed comparison only.
  // [OAR-EXPR-21] two aggregates never reach here: the type checker rejects
  // that comparison at load.
  if (typeof l === 'bigint' && typeof r === 'number') return Number(l) === r;
  if (typeof l === 'number' && typeof r === 'bigint') return l === Number(r);
  if (typeof l === 'bigint' && typeof r === 'bigint') return l === r;
  return l === r;
}

function compare(l: Value, r: Value): number {
  if (typeof l === 'string' && typeof r === 'string') {
    // String comparison is by Unicode code point.
    const a = [...l];
    const b = [...r];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const x = a[i]!.codePointAt(0)!;
      const y = b[i]!.codePointAt(0)!;
      if (x !== y) return x < y ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  if (typeof l === 'bigint' && typeof r === 'bigint') return l < r ? -1 : l > r ? 1 : 0;
  const a = typeof l === 'bigint' ? Number(l) : (l as number);
  const b = typeof r === 'bigint' ? Number(r) : (r as number);
  return a < b ? -1 : a > b ? 1 : 0;
}

function size(v: Value): bigint {
  // [OAR-EXPR-16] On a string, size() counts Unicode code points.
  if (typeof v === 'string') return BigInt([...v].length);
  if (Array.isArray(v)) return BigInt((v as readonly unknown[]).length);
  if (typeof v === 'object' && v !== null) return BigInt(Object.keys(v as Record<string, unknown>).length);
  throw new ConditionRaise('size() was applied to a scalar');
}

/**
 * [OAR-FACT-23], [OAR-EXPR-22] A string is a sequence of Unicode code points,
 * and the three string built-ins compare over that sequence. The spread splits
 * on code points rather than UTF-16 code units, so an astral-plane character is
 * one member and a lone surrogate never matches half of one — which is exactly
 * the disagreement a host language's native operators would introduce.
 */
export function codePoints(s: string): string[] {
  return [...s];
}

function prefixAt(hay: readonly string[], needle: readonly string[], at: number): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (hay[at + i] !== needle[i]) return false;
  }
  return true;
}

/** [OAR-EXPR-22] True when `s` begins with `prefix`. An empty prefix matches every string. */
export function startsWith(s: string, prefix: string): boolean {
  const a = codePoints(s);
  const b = codePoints(prefix);
  if (b.length > a.length) return false;
  return prefixAt(a, b, 0);
}

/** [OAR-EXPR-22] True when `s` ends with `suffix`. An empty suffix matches every string. */
export function endsWith(s: string, suffix: string): boolean {
  const a = codePoints(s);
  const b = codePoints(suffix);
  if (b.length > a.length) return false;
  return prefixAt(a, b, a.length - b.length);
}

/** [OAR-EXPR-22] True when `substring` occurs anywhere in `s`. An empty substring matches every string. */
export function contains(s: string, substring: string): boolean {
  const a = codePoints(s);
  const b = codePoints(substring);
  if (b.length > a.length) return false;
  for (let at = 0; at + b.length <= a.length; at++) {
    if (prefixAt(a, b, at)) return true;
  }
  return false;
}

/** Validate a supplied observation against its declared type [OAR-FACT-26]. */
export function validateFactValue(raw: unknown, type: string, name: string): Value {
  switch (type) {
    case 'bool':
      if (typeof raw !== 'boolean') throw new ConditionRaise(`fact ${name} is not a bool`);
      return raw;
    case 'int':
      if ((typeof raw === 'bigint' || (typeof raw === 'number' && Number.isInteger(raw))) && BigInt(raw) >= -(1n << 63n) && BigInt(raw) < (1n << 63n)) return BigInt(raw);
      throw new ConditionRaise(`fact ${name} is not an int`);
    case 'double':
      if (typeof raw !== 'number') throw new ConditionRaise(`fact ${name} is not a double`);
      // [OAR-FACT-23] A double fact is a finite binary64: a non-finite value
      // from a fact provider is a fact-provider failure, not a comparison that
      // silently decides one way.
      if (!Number.isFinite(raw)) throw new ConditionRaise(`fact ${name} is not a finite double`);
      return raw;
    case 'string':
      if (typeof raw !== 'string') throw new ConditionRaise(`fact ${name} is not a string`);
      return raw;
    case 'list<string>':
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
        throw new ConditionRaise(`fact ${name} is not a list<string>`);
      }
      return raw as string[];
    case 'list<map>':
      if (!Array.isArray(raw) || raw.some(x => typeof x !== 'object' || x === null || Array.isArray(x))) throw new ConditionRaise(`fact ${name} is not a list<map>`);
      return raw as Record<string, unknown>[];
    case 'map':
    case 'map<string,string>':
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ConditionRaise(`fact ${name} is not a map`);
      }
      if (type === 'map<string,string>' && Object.values(raw).some(v => typeof v !== 'string')) throw new ConditionRaise(`fact ${name} is not a map<string,string>`);
      return raw as Record<string, unknown>;
    default:
      throw new ConditionRaise(`fact ${name} has an undeclarable type`);
  }
}
