// Loading is where a bad rule is caught. Structural checks, the version gate,
// requires_facts, and a full type check of the condition against the declared
// environment all happen here, before any occurrence is evaluated — so a
// mistyped fact name can never become a run-time default.

import { parse, type BinaryOp, type Node } from './parse.js';
import {
  CORE_ANCHORS,
  type AnchorProfile,
  type CelType,
  type Environment,
} from './env.js';

export class RuleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleLoadError';
  }
}

export const SUPPORTED_SPEC_VERSIONS = ['1.0', '1.1'] as const;

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

  return {
    specVersion, id, namespace, kind, on, resolvedOn, selector, when, ast,
    flow: asArray(d['flow']).map(String),
    effect, enforcement,
    mandatory: d['mandatory'] === true,
    onError: typeof d['on_error'] === 'string' ? d['on_error'] : 'fail_closed',
    onFire, detectorRef,
  };
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

/** Walk the AST against the declared environment, before any evaluation. */
export function checkType(node: Node, env: Environment, ruleID: string): CelType {
  const fail = (msg: string): never => {
    throw new RuleLoadError(`rule ${ruleID}: ${msg}`);
  };
  switch (node.kind) {
    case 'bool': return 'bool';
    case 'int': return 'int';
    case 'double': return 'double';
    case 'string': return 'string';
    case 'null': return 'string';
    case 'list': {
      for (const item of node.items) checkType(item, env, ruleID);
      return 'list<string>';
    }
    case 'ident': {
      const decl = env.facts[node.name];
      if (!decl) {
        return fail(`condition references ${JSON.stringify(node.name)}, which is not a declared fact`);
      }
      return decl.type;
    }
    case 'select': {
      const decl = env.facts[node.target];
      if (!decl) {
        return fail(`condition references ${JSON.stringify(node.target)}, which is not a declared fact`);
      }
      if (decl.type !== 'struct') {
        return fail(`condition selects .${node.field} on ${node.target}, which is ${decl.type}, not a struct`);
      }
      return 'string';
    }
    case 'call': {
      const fn = env.functions[node.name];
      if (!fn) {
        return fail(`condition calls ${JSON.stringify(node.name)}, which is not a declared observation function`);
      }
      if (node.args.length !== 1) {
        return fail(`observation function ${node.name} takes one argument, got ${node.args.length}`);
      }
      const argType = checkType(node.args[0]!, env, ruleID);
      if (argType !== fn.arg) {
        return fail(`observation function ${node.name} takes ${fn.arg}, got ${argType}`);
      }
      return fn.returns;
    }
    case 'unary': {
      const t = checkType(node.operand, env, ruleID);
      if (node.op === '!') {
        if (t !== 'bool') return fail(`! applied to ${t}`);
        return 'bool';
      }
      if (!NUMERIC.includes(t)) return fail(`unary - applied to ${t}`);
      return t;
    }
    case 'ternary': {
      const c = checkType(node.cond, env, ruleID);
      if (c !== 'bool') return fail(`ternary condition is ${c}, want bool`);
      const a = checkType(node.then, env, ruleID);
      const b = checkType(node.other, env, ruleID);
      if (a !== b) return fail(`ternary arms are ${a} and ${b}`);
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
      if (left !== 'bool' || right !== 'bool') return fail(`${op} applied to ${left} and ${right}`);
      return 'bool';
    case 'in':
      if (right !== 'list<string>' && right !== 'list<struct>') {
        return fail(`in applied to ${right}, which is not a list`);
      }
      return 'bool';
    case '==':
    case '!=':
      if (left !== right) return fail(`${op} compares ${left} with ${right}`);
      return 'bool';
    case '<': case '<=': case '>': case '>=':
      // int and double are distinct types and are not comparable without an
      // explicit conversion, which this subset does not provide.
      if (left !== right) return fail(`${op} compares ${left} with ${right}`);
      if (!NUMERIC.includes(left) && left !== 'string') {
        return fail(`${op} applied to ${left}`);
      }
      return 'bool';
    case '+':
      if (left === 'string' && right === 'string') return 'string';
      if (left === right && NUMERIC.includes(left)) return left;
      return fail(`+ applied to ${left} and ${right}`);
    case '-': case '*': case '/': case '%':
      if (left === right && NUMERIC.includes(left)) return left;
      return fail(`${op} applied to ${left} and ${right}`);
  }
}
