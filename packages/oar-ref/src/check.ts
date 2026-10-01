// Appendix A, section A.2: the type rules of the condition language.
//
// Every condition is fully typed at load. There is no dynamic type
// ([OAR-EXPR-19]): the index operator is typed exhaustively, an unparameterised
// `map` cannot be indexed at all, and an observation an engine wants to expose
// out of one is a declared observation function whose return type is written
// down. That is what makes [OAR-FACT-4] — reject at load, never default at run
// time — implementable.

import type { Node } from './parse.js';
import type { Environment } from './capability.js';
import { COUNTER_READERS, STRING_BUILTINS, type FactType } from './vocab.js';

export class ConditionTypeError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'ConditionTypeError';
  }
}

/**
 * [OAR-EXPR-7] A static type of the condition language. There is no null value
 * and no nullable fact type: every declared fact has a value at every
 * occurrence ([OAR-FACT-25]), so a comparison against null could only ever be
 * dead code.
 */
export type ExprType = FactType;

export interface CheckResult {
  readonly type: ExprType;
  /** Every fact and observation function name the condition references. */
  readonly refs: ReadonlySet<string>;
}

const NUMERIC = new Set<ExprType>(['int', 'double']);
const AGGREGATE = new Set<ExprType>(['list<string>', 'list<map>', 'map', 'map<string,string>']);

function sameOrPromotable(a: ExprType, b: ExprType): boolean {
  if (a === b) return true;
  return NUMERIC.has(a) && NUMERIC.has(b);
}

export interface CheckOptions {
  readonly env: Environment;
  /**
   * Names the rule may reach: the core tier plus whatever it declared through
   * `requires`. A reference outside it is rejected under [OAR-FACT-20], which
   * is what makes portability computable from the document alone.
   */
  readonly reachable: ReadonlySet<string>;
}

/** Type-check a condition, collecting the names it references. */
export function check(node: Node, opts: CheckOptions): CheckResult {
  const refs = new Set<string>();
  const type = walk(node, opts, refs);
  return { type, refs };
}

function walk(node: Node, opts: CheckOptions, refs: Set<string>): ExprType {
  const { env } = opts;
  switch (node.kind) {
    case 'bool':
      return 'bool';
    case 'int':
      return 'int';
    case 'double':
      return 'double';
    case 'string':
      return 'string';
    case 'list': {
      // [OAR-EXPR-21] A list literal is list<string> when every member is a
      // string and list<map> when every member is a map, and is rejected
      // otherwise: members merely agreeing is necessary but not sufficient,
      // because [OAR-FACT-22] defines no other list type. The empty literal is
      // rejected because its type cannot be inferred.
      if (node.items.length === 0) {
        throw new ConditionTypeError('[OAR-EXPR-21] the empty list literal [] has no inferable type', node.offset);
      }
      const types = node.items.map((item) => walk(item, opts, refs));
      if (types.every((t) => t === 'string')) return 'list<string>';
      if (types.every((t) => t === 'map' || t === 'map<string,string>')) return 'list<map>';
      throw new ConditionTypeError(
        `[OAR-EXPR-21] a list literal is list<string> or list<map>, given members of type ${[...new Set(types)].join(', ')}`,
        node.offset,
      );
    }

    case 'ident': {
      const fact = env.facts.get(node.name);
      if (fact === undefined) {
        if (env.functions.has(node.name)) {
          throw new ConditionTypeError(`[OAR-FACT-3] ${node.name} is an observation function and must be called`, node.offset);
        }
        // [OAR-FACT-3] A mistyped fact name is a load failure, never a runtime
        // default. [OAR-EXPR-2] a dotted identifier is a single name, so an
        // author reaching for field selection lands here; say so, because
        // "unknown identifier" alone does not hint at the real problem.
        throw new ConditionTypeError(`unknown identifier ${node.name}${selectionHint(node.name, env)}`, node.offset);
      }
      requireReachable(node.name, fact.tier, opts, node.offset);
      refs.add(node.name);
      return fact.type;
    }

    case 'call': {
      // [OAR-EXPR-16] The language defines exactly four built-ins: size, and the
      // three string operations. Everything else is a declared observation
      // function, which is subject to the tier rules.
      if (node.name === 'size') {
        if (node.args.length !== 1) {
          throw new ConditionTypeError(`[OAR-EXPR-16] size() takes exactly one argument, given ${node.args.length}`, node.offset);
        }
        const t = walk(node.args[0]!, opts, refs);
        if (
          t !== 'string' &&
          t !== 'list<string>' &&
          t !== 'list<map>' &&
          t !== 'map' &&
          t !== 'map<string,string>'
        ) {
          throw new ConditionTypeError(`[OAR-EXPR-16] size() takes a string, a list, or a map, given ${t}`, node.offset);
        }
        return 'int';
      }
      // [OAR-EXPR-16], [OAR-EXPR-22] starts_with, ends_with, and contains are
      // (string, string) -> bool, compared by Unicode code point with no
      // normalisation, no case folding, and no locale.
      if (STRING_BUILTINS.includes(node.name)) {
        if (node.args.length !== 2) {
          throw new ConditionTypeError(
            `[OAR-EXPR-16] ${node.name}() takes exactly two arguments, given ${node.args.length}`,
            node.offset,
          );
        }
        const a = walk(node.args[0]!, opts, refs);
        const b = walk(node.args[1]!, opts, refs);
        if (a !== 'string' || b !== 'string') {
          throw new ConditionTypeError(
            `[OAR-EXPR-16] ${node.name}() takes two string arguments, given ${a} and ${b}`,
            node.offset,
          );
        }
        return 'bool';
      }
      const fn = env.functions.get(node.name);
      if (fn === undefined) {
        if (env.facts.has(node.name)) {
          throw new ConditionTypeError(`[OAR-FACT-3] ${node.name} is a fact, not an observation function`, node.offset);
        }
        throw new ConditionTypeError(`unknown identifier ${node.name}`, node.offset);
      }
      requireReachable(node.name, fn.tier, opts, node.offset);
      refs.add(node.name);
      if (node.args.length !== 1) {
        throw new ConditionTypeError(
          `[OAR-FACT-9] observation function ${node.name} takes exactly one argument, given ${node.args.length}`,
          node.offset,
        );
      }
      // [OAR-FIRE-11] fire_count_of and breaker_count_of each take one argument
      // which MUST be a string literal. Requiring a literal is what lets the
      // reference be resolved — and the unresolvable-reference error reported —
      // at load rather than at run time.
      if (COUNTER_READERS[node.name] !== undefined && node.args[0]!.kind !== 'string') {
        throw new ConditionTypeError(
          `[OAR-FIRE-11] ${node.name} takes a string literal naming a loaded rule, given a ${node.args[0]!.kind} expression`,
          node.offset,
        );
      }
      const argType = walk(node.args[0]!, opts, refs);
      if (argType !== fn.sig.arg) {
        throw new ConditionTypeError(
          `[OAR-FACT-9] observation function ${node.name} takes ${fn.sig.arg}, given ${argType}`,
          node.offset,
        );
      }
      return fn.sig.ret;
    }

    case 'index': {
      // [OAR-EXPR-13] The index operator is typed exhaustively.
      const target = walk(node.target, opts, refs);
      const index = walk(node.index, opts, refs);
      if (target === 'map') {
        // [OAR-EXPR-19] An unparameterised map may not be indexed at all.
        throw new ConditionTypeError(
          `[OAR-EXPR-19] ${describe(node.target)} is an unparameterised map and may not be indexed; it supports only "in" and size()`,
          node.offset,
        );
      }
      if (target === 'map<string,string>' && index === 'string') return 'string';
      if (target === 'list<string>' && index === 'int') return 'string';
      if (target === 'list<map>' && index === 'int') return 'map';
      throw new ConditionTypeError(`[OAR-EXPR-13] the index operator does not accept ${target} indexed by ${index}`, node.offset);
    }

    case 'unary': {
      const t = walk(node.operand, opts, refs);
      if (node.op === '!') {
        // [OAR-EXPR-8] ! takes and produces bool.
        if (t !== 'bool') throw new ConditionTypeError(`[OAR-EXPR-8] ! takes bool, given ${t}`, node.offset);
        return 'bool';
      }
      if (!NUMERIC.has(t)) throw new ConditionTypeError(`[OAR-EXPR-9] unary - takes int or double, given ${t}`, node.offset);
      return t;
    }

    case 'ternary': {
      // [OAR-EXPR-8] The condition is bool and the branches share a type.
      const c = walk(node.cond, opts, refs);
      if (c !== 'bool') throw new ConditionTypeError(`[OAR-EXPR-8] the ternary condition must be bool, given ${c}`, node.offset);
      const a = walk(node.then, opts, refs);
      const b = walk(node.other, opts, refs);
      if (a !== b) throw new ConditionTypeError(`[OAR-EXPR-8] the ternary branches are ${a} and ${b}, which differ`, node.offset);
      return a;
    }

    case 'binary':
      return binary(node, opts, refs);
  }
}

function binary(
  node: Extract<Node, { kind: 'binary' }>,
  opts: CheckOptions,
  refs: Set<string>,
): ExprType {
  const op = node.op;
  const left = walk(node.left, opts, refs);
  const right = walk(node.right, opts, refs);

  // [OAR-EXPR-8] && and || take and produce bool.
  if (op === '&&' || op === '||') {
    if (left !== 'bool' || right !== 'bool') {
      throw new ConditionTypeError(`[OAR-EXPR-8] ${op} takes bool operands, given ${left} and ${right}`, node.offset);
    }
    return 'bool';
  }

  // [OAR-EXPR-12] in takes a string and a list<string>, or a string and a map.
  if (op === 'in') {
    if (left !== 'string') throw new ConditionTypeError(`[OAR-EXPR-12] in takes a string on the left, given ${left}`, node.offset);
    if (right !== 'list<string>' && right !== 'map' && right !== 'map<string,string>') {
      throw new ConditionTypeError(`[OAR-EXPR-12] in takes a list<string> or a map on the right, given ${right}`, node.offset);
    }
    return 'bool';
  }

  // [OAR-EXPR-11] == and != take two operands of the same type, or one int and
  // one double. A comparison between unrelated types is rejected at load
  // rather than silently returning false.
  if (op === '==' || op === '!=') {
    // [OAR-EXPR-21] Equality over two aggregates is rejected at load: element-
    // wise equality over a list<map> is more machinery than a guardrail needs.
    if (AGGREGATE.has(left) && AGGREGATE.has(right)) {
      throw new ConditionTypeError(
        `[OAR-EXPR-21] ${op} does not compare two aggregate values, given ${left} and ${right}`,
        node.offset,
      );
    }
    if (!sameOrPromotable(left, right)) {
      throw new ConditionTypeError(
        `[OAR-EXPR-11] ${op} compares unrelated types ${left} and ${right}`,
        node.offset,
      );
    }
    return 'bool';
  }

  // [OAR-EXPR-10] Ordering comparisons take two int, two double, one of each,
  // or two string.
  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    if (left === 'string' && right === 'string') return 'bool';
    if (NUMERIC.has(left) && NUMERIC.has(right)) return 'bool';
    throw new ConditionTypeError(`[OAR-EXPR-10] ${op} takes two numbers or two strings, given ${left} and ${right}`, node.offset);
  }

  // [OAR-EXPR-9] Arithmetic takes two int or two double; % takes two int; +
  // additionally concatenates two strings.
  if (op === '%') {
    if (left !== 'int' || right !== 'int') {
      throw new ConditionTypeError(`[OAR-EXPR-9] % takes two int operands, given ${left} and ${right}`, node.offset);
    }
    return 'int';
  }
  if (op === '+' && left === 'string' && right === 'string') return 'string';
  if (left === 'int' && right === 'int') return 'int';
  if (left === 'double' && right === 'double') return 'double';
  throw new ConditionTypeError(
    `[OAR-EXPR-9] ${op} takes two int or two double operands, given ${left} and ${right}`,
    node.offset,
  );
}

/**
 * [OAR-EXPR-2], [OAR-EXPR-19] A hint for the one mistake this grammar invites:
 * writing `tool_args.path` and expecting field selection. The whole dotted
 * string is one name, and the member is reached with `in` plus a typed accessor.
 */
function selectionHint(name: string, env: Environment): string {
  const at = name.lastIndexOf('.');
  if (at === -1) return '';
  const prefix = name.slice(0, at);
  const member = name.slice(at + 1);
  const decl = env.facts.get(prefix);
  if (decl === undefined) return '';
  if (decl.type === 'map' || decl.type === 'map<string,string>') {
    return (
      ` — a dotted identifier is a single name and there is no field-selection operator;` +
      ` reach a member of the ${decl.type} fact ${prefix} with ${JSON.stringify(member)} in ${prefix}` +
      ` and a declared accessor, or with ${prefix}[${JSON.stringify(member)}]`
    );
  }
  return ` — a dotted identifier is a single name and there is no field-selection operator; ${prefix} is a ${decl.type}`;
}

/** Name the operand a diagnostic is about, when it has a name. */
function describe(node: Node): string {
  if (node.kind === 'ident') return node.name;
  if (node.kind === 'call') return `${node.name}()`;
  return 'the operand';
}

function requireReachable(
  name: string,
  tier: 'core' | 'profile' | 'host',
  opts: CheckOptions,
  offset: number,
): void {
  if (tier === 'core') return;
  if (opts.reachable.has(name)) return;
  // [OAR-FACT-20] Reject a reference to a non-core capability the rule does not
  // reach through requires.
  throw new ConditionTypeError(
    `[OAR-FACT-20] ${name} is outside the core tier and the rule does not reach it through requires`,
    offset,
  );
}
