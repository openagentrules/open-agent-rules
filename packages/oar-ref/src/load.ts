// Loading is where a bad rule is caught. Structural checks, the version gate,
// requires_facts, and a full type check of the condition against the declared
// environment all happen here, before any occurrence is evaluated — so a
// mistyped fact name can never become a run-time default.

import { parse, type BinaryOp, type Node } from './parse.js';
import {
  BUILTINS,
  CORE_ANCHORS,
  type AnchorProfile,
  type CelType,
  type Environment,
} from './env.js';
import {
  COPY_MEMBERS,
  copyReferences,
  parseCopyTemplate,
  type CopyPart,
} from './copy.js';

export class RuleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleLoadError';
  }
}

export const SUPPORTED_SPEC_VERSIONS = ['1.0'] as const;
// The version this engine implements: it accepts its major at any minor up to
// its own ([OAR-DOC-3]).
const IMPLEMENTED = { major: 1, minor: 0 };
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** [OAR-DOC-3] The version gate, applied before anything else ([OAR-CONF-2]). */
function checkVersion(specVersion: string): void {
  const m = VERSION_RE.exec(specVersion);
  if (!m) throw new RuleLoadError(`spec_version ${JSON.stringify(specVersion)} is not <major>.<minor>`);
  if (Number(m[1]) !== IMPLEMENTED.major || Number(m[2]) > IMPLEMENTED.minor) {
    throw new RuleLoadError(
      `unsupported spec_version ${JSON.stringify(specVersion)} (this engine implements ${IMPLEMENTED.major}.${IMPLEMENTED.minor})`,
    );
  }
}

export type Kind = 'schema' | 'policy' | 'invariant' | 'detector';
export type Effect = 'block' | 'warn' | 'nudge' | 'allow';
export type OnFireAction =
  | 'increment_counter' | 'reset_counter' | 'publish_event'
  | 'increment_breaker' | 'reset_breaker';

const KINDS: readonly Kind[] = ['schema', 'policy', 'invariant', 'detector'];
const EFFECTS: readonly Effect[] = ['block', 'warn', 'nudge', 'allow'];
const ON_FIRE: readonly OnFireAction[] = [
  'increment_counter', 'reset_counter', 'publish_event',
  'increment_breaker', 'reset_breaker',
];

export interface Selector {
  tools?: string[];
}

// Every field the document model defines. Anything else that is not an x-
// extension is rejected.
const DOCUMENT_FIELDS = new Set([
  'spec_version', 'id', 'namespace', 'title', 'kind', 'severity', 'on', 'selector',
  'when', 'flow', 'effect', 'enforcement', 'mandatory', 'on_error', 'on_fire',
  'stream', 'references', 'detector', 'requires_facts', 'profile',
  'what', 'cause', 'why', 'fix', 'instead', 'message',
]);

const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const ID_RE = /^[A-Z][A-Z0-9_]*$/;
// [OAR-DOC-19] The only names outside the document model a document may carry.
const EXTENSION_RE = /^x-[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Rule {
  specVersion: string;
  id: string;
  namespace: string;
  kind: Kind;
  on: string;
  resolvedOn: string;
  selector: Selector;
  when: string;
  ast: Node | null;
  flow: string[];
  effect: Effect;
  enforcement: 'enforce' | 'monitor';
  mandatory: boolean;
  onError: string;
  onFire: OnFireAction[];
  detectorRef: string | null;
  /** Parsed copy members ([OAR-DOC-18], Appendix B). Empty when none. */
  copy: Readonly<Record<string, readonly CopyPart[]>>;
  /** Rule ids named by fire_count_of / breaker_count_of, resolved over the rule set. */
  counterRefs: readonly string[];
}

/** Identity is the (namespace, id) pair; the rendered code stays the bare id. */
export function identity(rule: Rule): string {
  return rule.namespace ? `${rule.namespace}/${rule.id}` : rule.id;
}

export interface LoadOptions {
  env: Environment;
  profile: AnchorProfile;
  /** Detector references this host can resolve. */
  detectors?: readonly string[];
}

export function loadRule(doc: unknown, opts: LoadOptions): Rule {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new RuleLoadError('rule document must be a JSON object');
  }
  const d = doc as Record<string, unknown>;

  checkVersion(requireString(d, 'spec_version'));
  const specVersion = d['spec_version'] as string;

  for (const key of Object.keys(d)) {
    if (EXTENSION_RE.test(key)) continue;
    if (!DOCUMENT_FIELDS.has(key)) {
      throw new RuleLoadError(`rule carries undefined field ${JSON.stringify(key)}`);
    }
  }

  const id = requireString(d, 'id');
  if (!ID_RE.test(id)) {
    throw new RuleLoadError(`id ${JSON.stringify(id)} does not match ${ID_RE.source}`);
  }
  const namespace = typeof d['namespace'] === 'string' ? d['namespace'] : '';
  if (namespace && !NAMESPACE_RE.test(namespace)) {
    throw new RuleLoadError(`rule ${id} has an invalid namespace ${JSON.stringify(namespace)}`);
  }

  const kind = requireString(d, 'kind') as Kind;
  if (!KINDS.includes(kind)) {
    throw new RuleLoadError(`rule ${id} has kind ${JSON.stringify(kind)}, want one of ${KINDS.join(', ')}`);
  }
  const effect = requireString(d, 'effect') as Effect;
  if (!EFFECTS.includes(effect)) {
    throw new RuleLoadError(`rule ${id} has effect ${JSON.stringify(effect)}, want one of ${EFFECTS.join(', ')}`);
  }
  if (d['severity'] !== undefined &&
      !['block', 'warn', 'info'].includes(String(d['severity']))) {
    throw new RuleLoadError(`rule ${id} has severity ${JSON.stringify(d['severity'])}`);
  }
  if (d['profile'] !== undefined && !['portable', 'host'].includes(String(d['profile']))) {
    throw new RuleLoadError(`rule ${id} has profile ${JSON.stringify(d['profile'])}, want portable or host`);
  }

  const on = requireString(d, 'on');
  const resolvedOn = resolveAnchor(id, on, opts.profile);

  if (d['selector'] === undefined) {
    throw new RuleLoadError(`rule ${id} is missing selector`);
  }
  const selector = readSelector(id, d['selector']);

  const enforcement = (d['enforcement'] ?? 'enforce') as 'enforce' | 'monitor';
  if (enforcement !== 'enforce' && enforcement !== 'monitor') {
    throw new RuleLoadError(`rule ${id} has enforcement ${JSON.stringify(enforcement)}`);
  }
  if (d['mandatory'] !== undefined && typeof d['mandatory'] !== 'boolean') {
    throw new RuleLoadError(`rule ${id} has mandatory ${JSON.stringify(d['mandatory'])}, want a boolean`);
  }
  if (d['mandatory'] === true && enforcement === 'monitor') {
    // [OAR-OPS-9] A rule cannot be both required and not enforced.
    throw new RuleLoadError(`rule ${id} is mandatory and cannot have enforcement monitor`);
  }
  const stream = String(d['stream'] ?? 'buffered');
  if (stream === 'chunk') {
    throw new RuleLoadError(`rule ${id} requests stream: chunk, which this engine does not implement`);
  }
  if (stream !== 'buffered') {
    throw new RuleLoadError(`rule ${id} has stream ${JSON.stringify(stream)}`);
  }

  const onFire: OnFireAction[] = [];
  for (const raw of asArray(d['on_fire'])) {
    const action = String(raw) as OnFireAction;
    if (!ON_FIRE.includes(action)) {
      throw new RuleLoadError(`rule ${id} declares on_fire ${JSON.stringify(action)}, which is outside the closed vocabulary`);
    }
    onFire.push(action);
  }

  let detectorRef: string | null = null;
  if (kind === 'detector') {
    const det = d['detector'];
    if (typeof det !== 'object' || det === null || typeof (det as Record<string, unknown>)['ref'] !== 'string') {
      throw new RuleLoadError(`rule ${id} has kind detector and must carry detector.ref`);
    }
    detectorRef = String((det as Record<string, unknown>)['ref']);
    if (!detectorRef.startsWith('detector://')) {
      throw new RuleLoadError(`rule ${id} detector.ref ${JSON.stringify(detectorRef)} is not a detector:// URI`);
    }
    if (opts.detectors && !opts.detectors.includes(detectorRef)) {
      throw new RuleLoadError(`rule ${id} names detector ${detectorRef}, which this engine cannot resolve`);
    }
  } else if (d['detector'] !== undefined) {
    throw new RuleLoadError(`rule ${id} carries detector but its kind is ${kind}`);
  }

  for (const raw of asArray(d['requires_facts'])) {
    const name = String(raw);
    if (!(name in opts.env.facts) && !(name in opts.env.functions)) {
      throw new RuleLoadError(`rule ${JSON.stringify(id)} requires fact ${JSON.stringify(name)}, which this host does not provide`);
    }
  }

  const when = typeof d['when'] === 'string' ? d['when'] : '';
  let ast: Node | null = null;
  if (when.trim() !== '') {
    ast = parse(when);
    const t = checkType(ast, opts.env, id);
    if (t !== 'bool') {
      throw new RuleLoadError(`rule ${id} condition evaluates to ${t}, want bool`);
    }
  }

  const copy: Record<string, readonly CopyPart[]> = {};
  for (const member of COPY_MEMBERS) {
    const raw = d[member];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') {
      throw new RuleLoadError(`rule ${id} copy member ${member} must be a string`);
    }
    copy[member] = parseCopyTemplate(id, member, raw, opts.env);
  }
  // [OAR-DOC-22], [OAR-COPY-5] Every non-core name the condition or the copy
  // references is listed in requires_facts, so portability reads off the document.
  const refs = new Set<string>();
  if (ast) conditionIdents(ast, refs, opts.env);
  for (const name of copyReferences(Object.values(copy).flat())) refs.add(name);
  const requiresNames = new Set(asArray(d['requires_facts']).map(String));
  for (const name of refs) {
    const tier = opts.env.facts[name]?.tier ?? opts.env.functions[name]?.tier;
    if (tier === undefined || tier === 'core' || requiresNames.has(name)) continue;
    throw new RuleLoadError(
      `rule ${id} references ${name}, which is not a core fact and is not listed in requires_facts`,
    );
  }
  const counterRefs: string[] = [];
  if (ast) counterCalls(ast, counterRefs);

  return {
    specVersion, id, namespace, kind, on, resolvedOn, selector, when, ast,
    flow: asArray(d['flow']).map(String),
    effect, enforcement,
    mandatory: d['mandatory'] === true,
    onError: typeof d['on_error'] === 'string' ? d['on_error'] : 'fail_closed',
    onFire, detectorRef, copy, counterRefs,
  };
}

/** The rule ids a condition passes to fire_count_of and breaker_count_of. */
function counterCalls(node: Node, out: string[]): void {
  switch (node.kind) {
    case 'call':
      if (COUNTER_FUNCTIONS.has(node.name) && node.args[0]?.kind === 'string') out.push(node.args[0].value);
      for (const arg of node.args) counterCalls(arg, out);
      break;
    case 'list': for (const item of node.items) counterCalls(item, out); break;
    case 'unary': counterCalls(node.operand, out); break;
    case 'ternary': counterCalls(node.cond, out); counterCalls(node.then, out); counterCalls(node.other, out); break;
    case 'binary': counterCalls(node.left, out); counterCalls(node.right, out); break;
    default: break;
  }
}

const COUNTER_FUNCTIONS = new Set(['fire_count_of', 'breaker_count_of']);

export interface RuleSet {
  rules: Rule[];
  hints: Hint[];
}

/**
 * Load a rule set ([OAR-DOC-27]): each document on its own, then the checks
 * that span documents — unique identities, on_error substitutes, counter
 * references, and unique hint codes.
 */
export function loadRuleSet(ruleDocs: readonly unknown[], hintDocs: readonly unknown[], opts: LoadOptions): RuleSet {
  const rules = ruleDocs.map((doc) => loadRule(doc, opts));
  const hints = hintDocs.map((doc) => loadHint(doc));
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = identity(rule);
    if (seen.has(key)) throw new RuleLoadError(`rule set holds two rules with identity ${key} [OAR-DOC-28]`);
    seen.add(key);
  }
  const inNamespace = (namespace: string, id: string) =>
    rules.some((r) => r.namespace === namespace && r.id === id);
  for (const rule of rules) {
    if (rule.onError !== 'fail_closed' && rule.onError !== 'fail_open' && !inNamespace(rule.namespace, rule.onError)) {
      throw new RuleLoadError(`rule ${identity(rule)} on_error names ${rule.onError}, which is not a rule of its namespace in the rule set [OAR-OPS-4]`);
    }
    for (const ref of rule.counterRefs) {
      if (!inNamespace(rule.namespace, ref)) {
        throw new RuleLoadError(`rule ${identity(rule)} reads the counters of ${ref}, which is not a rule of its namespace in the rule set [OAR-FIRE-6]`);
      }
    }
  }
  const codes = new Set<string>();
  for (const hint of hints) {
    if (codes.has(hint.id)) throw new RuleLoadError(`rule set holds two hints with code ${hint.id} [OAR-HINT-2]`);
    codes.add(hint.id);
  }
  return { rules, hints };
}

/** Every fact and function name a condition references, for [OAR-DOC-22]. */
function conditionIdents(node: Node, out: Set<string>, env: Environment): void {
  switch (node.kind) {
    case 'ident': out.add(node.name); break;
    case 'select': {
      // A dotted host fact is one name; otherwise the target map is the reference.
      const flat = `${node.target}.${node.field}`;
      out.add(env.facts[flat] ? flat : node.target);
      break;
    }
    case 'list': for (const item of node.items) conditionIdents(item, out, env); break;
    case 'unary': conditionIdents(node.operand, out, env); break;
    case 'ternary':
      conditionIdents(node.cond, out, env);
      conditionIdents(node.then, out, env);
      conditionIdents(node.other, out, env);
      break;
    case 'binary':
      conditionIdents(node.left, out, env);
      conditionIdents(node.right, out, env);
      break;
    case 'call':
      out.add(node.name);
      for (const arg of node.args) conditionIdents(arg, out, env);
      break;
    default: break;
  }
}

// --- hints (section 9) ---------------------------------------------------------

// The fields a hint document may carry: the document envelope, the presentation
// fields, and the copy members. Everything evaluation-shaped is forbidden.
const HINT_FIELDS = new Set([
  'spec_version', 'id', 'namespace', 'title', 'kind', 'severity',
  'references', 'what', 'cause', 'why', 'fix', 'instead', 'message',
]);

// The evaluation fields [OAR-HINT-1] forbids — named individually so the load
// error can distinguish "a hint must not evaluate" from "no such field".
const HINT_EVALUATION_FIELDS = new Set([
  'on', 'selector', 'effect', 'when', 'flow', 'enforcement', 'mandatory',
  'on_error', 'on_fire', 'stream', 'detector', 'requires_facts', 'profile',
]);

export interface Hint {
  specVersion: string;
  id: string;
  namespace: string;
  kind: 'hint';
  copy: Readonly<Record<string, string>>;
}

/**
 * Loads a hint document (section 9). A hint is a copy publication keyed by
 * code: it carries no evaluation fields ([OAR-HINT-1]), at least one copy
 * member ([OAR-HINT-2]), and copy that is static — no bindings, no
 * conditionals ([OAR-HINT-3]).
 */
export function loadHint(doc: unknown): Hint {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new RuleLoadError('hint document must be a JSON object');
  }
  const d = doc as Record<string, unknown>;

  checkVersion(requireString(d, 'spec_version'));
  const specVersion = d['spec_version'] as string;

  for (const key of Object.keys(d)) {
    if (EXTENSION_RE.test(key)) continue;
    if (!HINT_FIELDS.has(key)) {
      if (HINT_EVALUATION_FIELDS.has(key)) {
        throw new RuleLoadError(
          `hint carries evaluation field ${JSON.stringify(key)} — a hint publishes copy, it does not evaluate ([OAR-HINT-1])`,
        );
      }
      throw new RuleLoadError(
        `hint carries field ${JSON.stringify(key)}, which this specification does not define ([OAR-DOC-19], [OAR-HINT-5])`,
      );
    }
  }

  const id = requireString(d, 'id');
  if (!ID_RE.test(id)) {
    throw new RuleLoadError(`hint id ${JSON.stringify(id)} is not an identifier`);
  }
  if (d['kind'] !== 'hint') {
    throw new RuleLoadError(`hint ${id} carries kind ${JSON.stringify(d['kind'])}, want "hint"`);
  }
  const namespace = typeof d['namespace'] === 'string' ? d['namespace'] : '';
  if (namespace !== '' && !NAMESPACE_RE.test(namespace)) {
    throw new RuleLoadError(`hint ${id} namespace ${JSON.stringify(namespace)} is not a namespace`);
  }
  if (d['severity'] !== undefined &&
      !['block', 'warn', 'info'].includes(String(d['severity']))) {
    throw new RuleLoadError(`hint ${id} has severity ${JSON.stringify(d['severity'])}`);
  }

  const copy: Record<string, string> = {};
  let members = 0;
  for (const member of COPY_MEMBERS) {
    const raw = d[member];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') {
      throw new RuleLoadError(`hint ${id} copy member ${member} must be a string`);
    }
    if (raw.includes('{{') || raw.includes('{%')) {
      throw new RuleLoadError(
        `hint ${id} copy member ${member} carries a binding — hint copy is static ([OAR-HINT-3])`,
      );
    }
    copy[member] = raw;
    members += 1;
  }
  if (members === 0) {
    throw new RuleLoadError(`hint ${id} carries no copy member ([OAR-HINT-2])`);
  }

  return { specVersion, id, namespace, kind: 'hint', copy };
}

function resolveAnchor(id: string, on: string, profile: AnchorProfile): string {
  if (!(CORE_ANCHORS as readonly string[]).includes(on)) {
    // A host-native anchor. This engine models only the core set, so it has
    // none — a rule naming one cannot be resolved here.
    throw new RuleLoadError(`rule ${id} names anchor ${JSON.stringify(on)}, which this engine cannot resolve`);
  }
  const local = profile.core[on];
  if (local === undefined) {
    throw new RuleLoadError(`rule ${JSON.stringify(id)} targets core anchor ${JSON.stringify(on)}, which this host does not support`);
  }
  return local;
}

function readSelector(id: string, raw: unknown): Selector {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RuleLoadError(`rule ${id} selector must be an object`);
  }
  const out: Selector = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // [OAR-SEL-7] tools is the only clause this version defines.
    if (key !== 'tools') {
      throw new RuleLoadError(`rule ${id} selector carries undefined clause ${JSON.stringify(key)}`);
    }
    if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v !== '')) {
      throw new RuleLoadError(`rule ${id} selector clause "tools" must be a non-empty list of tool names`);
    }
    out.tools = value as string[];
  }
  return out;
}

function requireString(d: Record<string, unknown>, key: string): string {
  const v = d[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new RuleLoadError(`rule document is missing required field ${JSON.stringify(key)}`);
  }
  return v;
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [v];
  return v;
}

// ---------------------------------------------------------------- type check

const NUMERIC: readonly CelType[] = ['int', 'double'];
const INT64_MAX = 2n ** 63n - 1n;

/** Walk the AST against the declared environment, before any evaluation. */
export function checkType(node: Node, env: Environment, ruleID: string): CelType {
  const fail = (msg: string): never => {
    throw new RuleLoadError(`rule ${ruleID}: ${msg}`);
  };
  switch (node.kind) {
    case 'bool': return 'bool';
    case 'int':
      // [OAR-EXPR-15] An int literal fits a signed 64-bit integer.
      if (node.value > INT64_MAX) return fail(`int literal ${node.value} does not fit 64 bits [OAR-EXPR-15]`);
      return 'int';
    case 'double':
      if (!Number.isFinite(node.value)) return fail('double literal is not finite [OAR-EXPR-15]');
      return 'double';
    case 'string': return 'string';
    case 'list': {
      // [OAR-EXPR-7] A list literal is a non-empty list<string>.
      if (node.items.length === 0) return fail('empty list literal: its type cannot be inferred [OAR-EXPR-7]');
      for (const item of node.items) {
        const t = checkType(item, env, ruleID);
        if (t !== 'string') return fail(`list literal member is ${t}, want string [OAR-EXPR-7]`);
      }
      return 'list<string>';
    }
    case 'ident': {
      const decl = env.facts[node.name];
      if (!decl) {
        return fail(`condition references ${JSON.stringify(node.name)}, which is not a declared fact [OAR-EXPR-2]`);
      }
      return decl.type;
    }
    case 'select': {
      // A namespaced host fact (`<host>.<fact>`, [OAR-FACT-15]) is written in a
      // condition with the same dotted spelling its declaration uses. When the
      // environment declares the dotted name outright, the node reads that fact;
      // otherwise the node selects into a `map<string, dyn>` ([OAR-FACT-22]).
      const flat = env.facts[`${node.target}.${node.field}`];
      if (flat) return flat.type;
      const decl = env.facts[node.target];
      if (!decl) {
        return fail(`condition references ${JSON.stringify(node.target)}, which is not a declared fact [OAR-EXPR-2]`);
      }
      if (decl.type !== 'map<string, dyn>') {
        return fail(`condition selects .${node.field} on ${node.target}, which is ${decl.type}, not a map<string, dyn> [OAR-EXPR-2]`);
      }
      return 'string';
    }
    case 'call': {
      if (BUILTINS.has(node.name)) return checkBuiltin(node.name, node.args, env, ruleID, fail);
      const fn = env.functions[node.name];
      if (!fn) {
        return fail(`condition calls ${JSON.stringify(node.name)}, which is not a declared observation function [OAR-EXPR-16]`);
      }
      if (COUNTER_FUNCTIONS.has(node.name) && node.args[0]?.kind !== 'string') {
        return fail(`${node.name} takes a string literal naming a rule [OAR-FIRE-6]`);
      }
      if (node.args.length !== 1) {
        return fail(`observation function ${node.name} takes one argument, got ${node.args.length} [OAR-EXPR-16]`);
      }
      const argType = checkType(node.args[0]!, env, ruleID);
      if (argType !== fn.arg) {
        return fail(`observation function ${node.name} takes ${fn.arg}, got ${argType} [OAR-EXPR-16]`);
      }
      return fn.returns;
    }
    case 'unary': {
      // [OAR-EXPR-15] -9223372036854775808 is the least int, written as unary
      // minus over a literal one past INT64_MAX.
      if (node.op === '-' && node.operand.kind === 'int' && node.operand.value === INT64_MAX + 1n) return 'int';
      const t = checkType(node.operand, env, ruleID);
      if (node.op === '!') {
        if (t !== 'bool') return fail(`! applied to ${t} [OAR-EXPR-8]`);
        return 'bool';
      }
      if (!NUMERIC.includes(t)) return fail(`unary - applied to ${t} [OAR-EXPR-9]`);
      return t;
    }
    case 'ternary': {
      const c = checkType(node.cond, env, ruleID);
      if (c !== 'bool') return fail(`ternary condition is ${c}, want bool [OAR-EXPR-8]`);
      const a = checkType(node.then, env, ruleID);
      const b = checkType(node.other, env, ruleID);
      if (a !== b) return fail(`ternary arms are ${a} and ${b} [OAR-EXPR-8]`);
      return a;
    }
    case 'binary':
      return checkBinary(node.op, node.left, node.right, env, ruleID, fail);
  }
}

function checkBinary(
  op: BinaryOp,
  leftNode: Node,
  rightNode: Node,
  env: Environment,
  ruleID: string,
  fail: (msg: string) => never,
): CelType {
  const left = checkType(leftNode, env, ruleID);
  const right = checkType(rightNode, env, ruleID);
  switch (op) {
    case '&&':
    case '||':
      if (left !== 'bool' || right !== 'bool') return fail(`${op} applied to ${left} and ${right} [OAR-EXPR-8]`);
      return 'bool';
    case 'in':
      // [OAR-EXPR-12] membership in a list<string>, or key presence in a map.
      if (left !== 'string' || (right !== 'list<string>' && right !== 'map<string, dyn>')) {
        return fail(`in applied to ${left} and ${right} [OAR-EXPR-12]`);
      }
      return 'bool';
    case '==':
    case '!=':
      if (left !== right) return fail(`${op} compares ${left} with ${right} [OAR-EXPR-11]`);
      if (!SCALAR.includes(left)) return fail(`${op} compares aggregate ${left} [OAR-EXPR-11]`);
      return 'bool';
    case '<': case '<=': case '>': case '>=':
      // int and double are distinct types and are not comparable without an
      // explicit conversion, which this subset does not provide.
      if (left !== right) return fail(`${op} compares ${left} with ${right} [OAR-EXPR-10]`);
      if (!NUMERIC.includes(left) && left !== 'string') {
        return fail(`${op} applied to ${left} [OAR-EXPR-10]`);
      }
      return 'bool';
    case '+':
      if (left === 'string' && right === 'string') return 'string';
      if (left === right && NUMERIC.includes(left)) return left;
      return fail(`+ applied to ${left} and ${right} [OAR-EXPR-9]`);
    case '%':
      if (left === 'int' && right === 'int') return 'int';
      return fail(`% applied to ${left} and ${right} [OAR-EXPR-9]`);
    case '-': case '*': case '/':
      if (left === right && NUMERIC.includes(left)) return left;
      return fail(`${op} applied to ${left} and ${right} [OAR-EXPR-9]`);
  }
}

const SCALAR: readonly CelType[] = ['bool', 'int', 'double', 'string'];
const SIZED: readonly CelType[] = ['string', 'list<string>', 'list<map<string, dyn>>', 'map<string, dyn>'];

/** The four built-ins of [OAR-EXPR-17], checked against their signatures. */
function checkBuiltin(
  name: string,
  args: readonly Node[],
  env: Environment,
  ruleID: string,
  fail: (msg: string) => never,
): CelType {
  const types = args.map((a) => checkType(a, env, ruleID));
  if (name === 'size') {
    if (types.length !== 1 || !SIZED.includes(types[0]!)) {
      return fail(`size takes one string, list, or map, got (${types.join(', ')}) [OAR-EXPR-16]`);
    }
    return 'int';
  }
  if (types.length !== 2 || types[0] !== 'string' || types[1] !== 'string') {
    return fail(`${name} takes (string, string), got (${types.join(', ')}) [OAR-EXPR-16]`);
  }
  return 'bool';
}
