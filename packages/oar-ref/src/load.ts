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

export type Kind = 'schema' | 'policy' | 'invariant' | 'detector';
export type Effect = 'block' | 'warn' | 'nudge' | 'allow' | 'transform';
export type OnFireAction =
  | 'increment_counter' | 'reset_counter' | 'publish_event'
  | 'increment_breaker' | 'reset_breaker';

const KINDS: readonly Kind[] = ['schema', 'policy', 'invariant', 'detector'];
const EFFECTS: readonly Effect[] = ['block', 'warn', 'nudge', 'allow', 'transform'];
const ON_FIRE: readonly OnFireAction[] = [
  'increment_counter', 'reset_counter', 'publish_event',
  'increment_breaker', 'reset_breaker',
];

export interface Selector {
  tools?: string[];
  tool?: string | null;
  profiles?: string[];
  surface?: string | null;
  surfaces?: string[];
  session_posture?: string[];
  phase?: string | null;
  workflow?: string | null;
  principal?: string | string[];
  ledger?: Record<string, unknown>;
}

const SELECTOR_CLAUSES = new Set([
  'tools', 'tool', 'profiles', 'surface', 'surfaces',
  'session_posture', 'phase', 'workflow', 'principal', 'ledger',
]);

// Every field the document model defines. Anything else that is not an x-
// extension is rejected.
const DOCUMENT_FIELDS = new Set([
  'spec_version', 'id', 'namespace', 'title', 'kind', 'severity', 'on', 'selector',
  'when', 'flow', 'effect', 'enforcement', 'mandatory', 'on_error', 'on_fire',
  'stream', 'emit', 'references', 'detector', 'requires_facts', 'profile', 'tools',
  'what', 'cause', 'why', 'fix', 'instead', 'message', 'category',
  'context_schema', 'scenarios', 'evidence', 'code',
]);

const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const ID_RE = /^[A-Z][A-Z0-9_]*$/;

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

  const specVersion = requireString(d, 'spec_version');
  if (!/^[0-9]+\.[0-9]+$/.test(specVersion)) {
    throw new RuleLoadError(`spec_version ${JSON.stringify(specVersion)} is not <major>.<minor>`);
  }
  if (!(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(specVersion)) {
    throw new RuleLoadError(
      `unsupported spec_version ${JSON.stringify(specVersion)} (want one of ${SUPPORTED_SPEC_VERSIONS.join(', ')})`,
    );
  }

  for (const key of Object.keys(d)) {
    if (key.startsWith('x-')) continue;
    if (!DOCUMENT_FIELDS.has(key)) {
      throw new RuleLoadError(`rule carries undefined field ${JSON.stringify(key)}`);
    }
  }
  if ('code' in d && specVersion !== '1.0') {
    throw new RuleLoadError(`code is removed at spec_version ${specVersion} — use id`);
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
  if (selector.tools === undefined && Array.isArray(d['tools'])) {
    // The deprecated top-level filter is equivalent to selector.tools.
    selector.tools = (d['tools'] as unknown[]).map(String);
  }

  const enforcement = (d['enforcement'] ?? 'enforce') as 'enforce' | 'monitor';
  if (enforcement !== 'enforce' && enforcement !== 'monitor') {
    throw new RuleLoadError(`rule ${id} has enforcement ${JSON.stringify(enforcement)}`);
  }
  if (d['mandatory'] !== undefined && typeof d['mandatory'] !== 'boolean') {
    throw new RuleLoadError(`rule ${id} has mandatory ${JSON.stringify(d['mandatory'])}, want a boolean`);
  }
  if (d['mandatory'] === true && enforcement === 'monitor') {
    // [OAR-OPS-12] A rule cannot be both required and not enforced.
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
  // [OAR-COPY-5] A non-core fact named only in copy is still a fact the rule
  // references: copy is presentation, not an exemption from the portability
  // contract, so it must be reached through requires_facts.
  const whenRefs = new Set<string>();
  if (ast) conditionIdents(ast, whenRefs);
  const requiresNames = new Set(asArray(d['requires_facts']).map(String));
  for (const name of copyReferences(Object.values(copy).flat())) {
    const decl = opts.env.facts[name];
    if (!decl || decl.tier === 'core') continue;
    if (requiresNames.has(name) || whenRefs.has(name)) continue;
    throw new RuleLoadError(
      `rule ${id} copy references ${name}, which is not a core fact and is not reached through requires_facts`,
    );
  }

  return {
    specVersion, id, namespace, kind, on, resolvedOn, selector, when, ast,
    flow: asArray(d['flow']).map(String),
    effect, enforcement,
    mandatory: d['mandatory'] === true,
    onError: typeof d['on_error'] === 'string' ? d['on_error'] : 'fail_closed',
    onFire, detectorRef, copy,
  };
}

/** Every fact name a condition references, for the [OAR-COPY-5] check. */
function conditionIdents(node: Node, out: Set<string>): void {
  switch (node.kind) {
    case 'ident': out.add(node.name); break;
    case 'select': out.add(node.target); break;
    case 'list': for (const item of node.items) conditionIdents(item, out); break;
    case 'unary': conditionIdents(node.operand, out); break;
    case 'ternary':
      conditionIdents(node.cond, out);
      conditionIdents(node.then, out);
      conditionIdents(node.other, out);
      break;
    case 'binary':
      conditionIdents(node.left, out);
      conditionIdents(node.right, out);
      break;
    case 'call': for (const arg of node.args) conditionIdents(arg, out); break;
    default: break;
  }
}

// --- hints (section 9) ---------------------------------------------------------

// The fields a hint document may carry: the document envelope, the presentation
// fields, and the copy members. Everything evaluation-shaped is forbidden.
const HINT_FIELDS = new Set([
  'spec_version', 'id', 'namespace', 'title', 'kind', 'severity', 'emit',
  'references', 'what', 'cause', 'why', 'fix', 'instead', 'message',
]);

// The evaluation fields [OAR-HINT-1] forbids — named individually so the load
// error can distinguish "a hint must not evaluate" from "no such field".
const HINT_EVALUATION_FIELDS = new Set([
  'on', 'selector', 'effect', 'when', 'flow', 'enforcement', 'mandatory',
  'on_error', 'on_fire', 'stream', 'detector', 'requires_facts', 'tools', 'profile',
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

  const specVersion = requireString(d, 'spec_version');
  if (!/^[0-9]+\.[0-9]+$/.test(specVersion)) {
    throw new RuleLoadError(`spec_version ${JSON.stringify(specVersion)} is not <major>.<minor>`);
  }
  if (!(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(specVersion)) {
    throw new RuleLoadError(
      `unsupported spec_version ${JSON.stringify(specVersion)} (want one of ${SUPPORTED_SPEC_VERSIONS.join(', ')})`,
    );
  }

  for (const key of Object.keys(d)) {
    if (key.startsWith('x-')) continue;
    if (!HINT_FIELDS.has(key)) {
      if (HINT_EVALUATION_FIELDS.has(key)) {
        throw new RuleLoadError(
          `hint carries evaluation field ${JSON.stringify(key)} — a hint publishes copy, it does not evaluate ([OAR-HINT-1])`,
        );
      }
      throw new RuleLoadError(
        `hint carries field ${JSON.stringify(key)}, which this specification does not define ([OAR-DOC-20], [OAR-HINT-5])`,
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
    if (!SELECTOR_CLAUSES.has(key)) {
      throw new RuleLoadError(`rule ${id} selector carries undefined clause ${JSON.stringify(key)}`);
    }
    (out as Record<string, unknown>)[key] = value;
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
