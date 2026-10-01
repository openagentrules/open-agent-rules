// Loading is where a bad rule is caught. The version gate, the closed document
// world, anchor resolution, capability negotiation, the selector clauses, and a
// full type check of the condition against the declared environment all happen
// here, before any occurrence is evaluated.
//
// [OAR-OPS-3] Malformed documents, unknown identifiers, and type errors are not
// routed through `on_error`. They are load-time rejections, and an engine that
// silently downgraded one would enforce a policy the author never wrote.

import { check, ConditionTypeError } from './check.js';
import { CopyLoadError, INTERPOLATABLE, parseCopy } from './copy.js';
import { countNodes, parse, type Node } from './parse.js';
import type { Environment } from './capability.js';
import {
  COUNTER_READERS,
  EFFECTS,
  ENFORCEMENTS,
  KINDS,
  ON_FIRE_ACTIONS,
  OAR_MAJOR,
  OAR_MINOR,
  PROFILES,
  RELATED_TYPES,
  STATUSES,
  TRANSFORM_ACTIONS,
  isCoreAnchor,
  type Effect,
  type Enforcement,
  type Kind,
  type OnFireAction,
} from './vocab.js';

export class RuleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleLoadError';
  }
}

const ID_RE = /^[A-Z][A-Z0-9_]*$/;
const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const ANCHOR_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const FACT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const QUALIFIED_REF_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\/[A-Z][A-Z0-9_]*$/;
const EXTENSION_RE = /^x-[a-z0-9]+(-[a-z0-9]+)*$/;
const DETECTOR_RE = /^detector:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const DEFINED_FIELDS = new Set([
  'oar',
  'id',
  'namespace',
  'kind',
  'anchor',
  'selector',
  'when',
  'flow',
  'effect',
  'enforcement',
  'mandatory',
  'on_error',
  'on_fire',
  'counter_scope',
  'overrides',
  'requires',
  'transform',
  'detector',
  'copy',
  'references',
  'status',
  'related',
]);

const COPY_MEMBERS = new Set(['title', 'what', 'cause', 'why', 'fix', 'instead']);

export interface SelectorClause {
  readonly fact: string;
  readonly values: readonly string[];
}

export interface TransformSpec {
  readonly action: 'redact' | 'replace' | 'annotate';
  readonly target: string;
  readonly replacement?: string;
}

export interface RelatedEntry {
  readonly id: string;
  readonly type: string;
}

/**
 * [OAR-FIRE-11] One `fire_count_of` or `breaker_count_of` call in a condition:
 * the built-in that read it, the literal the author wrote, and the qualified
 * identifier that literal resolves to in the referencing rule's namespace.
 */
export interface CounterRef {
  readonly fn: string;
  readonly counter: 'fire_count' | 'breaker_count';
  readonly literal: string;
  readonly target: string;
}

export interface LoadedRule {
  readonly id: string;
  readonly namespace: string;
  /** [OAR-DOC-8] The identity of a rule: <namespace>/<id>, or the bare id in the host's own scope. */
  readonly qualified: string;
  readonly kind: Kind;
  readonly anchor: string;
  /** [OAR-PROF-4] The local anchor a core anchor resolves to through the profile map. */
  readonly resolvedAnchor: string;
  readonly selector: readonly SelectorClause[];
  readonly whenSource?: string;
  readonly when: Node | null;
  readonly flow: readonly string[];
  readonly hasFlow: boolean;
  readonly effect: Effect;
  readonly enforcement: Enforcement;
  readonly mandatory: boolean;
  readonly onError: string;
  readonly onFire: readonly OnFireAction[];
  /** [OAR-DOC-32], [OAR-FIRE-10] The declared string fact whose value keys this rule's counters. */
  readonly counterScope?: string;
  /** [OAR-FIRE-11] The counters of other rules this rule's condition reads. */
  readonly counterRefs: readonly CounterRef[];
  readonly overrides: readonly string[];
  readonly requiresProfiles: readonly string[];
  readonly requiresFacts: readonly string[];
  readonly transform?: TransformSpec;
  readonly detectorRef?: string;
  readonly copy: Readonly<Record<string, string>>;
  readonly status: string;
  readonly related: readonly RelatedEntry[];
  /** Fact and function names the condition, selector, transform, and copy reference. */
  readonly refs: ReadonlySet<string>;
  readonly warnings: readonly string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new RuleLoadError(`field ${JSON.stringify(field)} must be a list of strings`);
  return v.map((x) => {
    if (typeof x !== 'string') throw new RuleLoadError(`field ${JSON.stringify(field)} must be a list of strings`);
    return x;
  });
}

/** Visit every node of a parse tree, in no particular order. */
function walkNodes(node: Node, visit: (n: Node) => void): void {
  visit(node);
  switch (node.kind) {
    case 'list':
      for (const item of node.items) walkNodes(item, visit);
      return;
    case 'call':
      for (const arg of node.args) walkNodes(arg, visit);
      return;
    case 'index':
      walkNodes(node.target, visit);
      walkNodes(node.index, visit);
      return;
    case 'unary':
      walkNodes(node.operand, visit);
      return;
    case 'binary':
      walkNodes(node.left, visit);
      walkNodes(node.right, visit);
      return;
    case 'ternary':
      walkNodes(node.cond, visit);
      walkNodes(node.then, visit);
      walkNodes(node.other, visit);
      return;
    default:
      return;
  }
}

/** Resolve a bare or qualified rule reference within a referring namespace. */
export function resolveRef(ref: string, namespace: string): string {
  if (ref.includes('/')) return ref;
  return namespace === '' ? ref : `${namespace}/${ref}`;
}

/**
 * Load one rule document against a declared environment. Every rejection names
 * the field, identifier, or capability at fault.
 */
export function loadRuleDocument(doc: unknown, env: Environment): LoadedRule {
  if (!isObject(doc)) throw new RuleLoadError('[OAR-DOC-31] a rule set member is not a rule document: expected a JSON object');

  // [OAR-CONF-2] Check `oar` before any other processing of the document.
  const oar = doc['oar'];
  if (oar === undefined) throw new RuleLoadError('rule document is missing required field "oar"');
  // [OAR-DOC-3] Each part is a decimal integer with no leading zero: two
  // engines free to disagree about whether "01.0" equals "1.0" would disagree
  // about which documents load.
  if (typeof oar !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(oar)) {
    throw new RuleLoadError('field "oar" must be a version string of the form <major>.<minor>, each part without a leading zero');
  }
  const [majorText, minorText] = oar.split('.') as [string, string];
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major !== OAR_MAJOR) {
    // [OAR-DOC-4] An unsupported major is refused, never downgraded or coerced.
    throw new RuleLoadError(
      `[OAR-DOC-4] oar ${oar} names a major version this engine does not implement (${OAR_MAJOR}.${OAR_MINOR})`,
    );
  }
  if (minor > OAR_MINOR) {
    // [OAR-DOC-5] A greater minor may narrow the rule with a field this engine
    // would ignore, so refusing to load is the only visible failure mode.
    throw new RuleLoadError(
      `[OAR-DOC-5] oar ${oar} names a minor version above this engine's own (${OAR_MAJOR}.${OAR_MINOR})`,
    );
  }

  // [OAR-DOC-27] The document world is closed: a field this specification does
  // not define is a rejection, naming the field. A typo that silently does
  // nothing is how a guardrail becomes a placebo.
  for (const key of Object.keys(doc)) {
    if (DEFINED_FIELDS.has(key)) continue;
    // [OAR-DOC-26] An unrecognised x- extension is ignored.
    if (EXTENSION_RE.test(key)) continue;
    throw new RuleLoadError(`[OAR-DOC-27] rule document carries undefined field ${JSON.stringify(key)}`);
  }

  // [OAR-DOC-2] The five obligatory fields.
  for (const required of ['id', 'kind', 'anchor', 'effect']) {
    if (doc[required] === undefined) {
      throw new RuleLoadError(`[OAR-DOC-2] rule document is missing required field ${JSON.stringify(required)}`);
    }
  }

  const id = doc['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new RuleLoadError(`[OAR-DOC-6] field "id" does not match ^[A-Z][A-Z0-9_]*$: ${JSON.stringify(id)}`);
  }

  const namespaceRaw = doc['namespace'];
  if (namespaceRaw !== undefined && (typeof namespaceRaw !== 'string' || !NAMESPACE_RE.test(namespaceRaw))) {
    throw new RuleLoadError(`field "namespace" is not a publisher scope: ${JSON.stringify(namespaceRaw)}`);
  }
  const namespace = typeof namespaceRaw === 'string' ? namespaceRaw : '';
  const qualified = namespace === '' ? id : `${namespace}/${id}`;

  const kind = doc['kind'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    throw new RuleLoadError(`[OAR-DOC-10] field "kind" is ${JSON.stringify(kind)}, not one of ${KINDS.join(', ')}`);
  }

  const effect = doc['effect'];
  if (typeof effect !== 'string' || !(EFFECTS as readonly string[]).includes(effect)) {
    throw new RuleLoadError(`[OAR-DOC-11] field "effect" is ${JSON.stringify(effect)}, not one of ${EFFECTS.join(', ')}`);
  }

  const anchorRaw = doc['anchor'];
  if (typeof anchorRaw !== 'string' || !ANCHOR_RE.test(anchorRaw)) {
    throw new RuleLoadError('field "anchor" must name exactly one lifecycle moment');
  }

  const enforcementRaw = doc['enforcement'] ?? 'enforce';
  if (typeof enforcementRaw !== 'string' || !(ENFORCEMENTS as readonly string[]).includes(enforcementRaw)) {
    throw new RuleLoadError(`field "enforcement" must be one of ${ENFORCEMENTS.join(', ')}`);
  }
  const enforcement = enforcementRaw as Enforcement;

  const mandatoryRaw = doc['mandatory'] ?? false;
  if (typeof mandatoryRaw !== 'boolean') throw new RuleLoadError('field "mandatory" must be a boolean');

  const onErrorRaw = doc['on_error'] ?? 'fail_closed';
  if (typeof onErrorRaw !== 'string') throw new RuleLoadError('field "on_error" must be a string');
  if (
    onErrorRaw !== 'fail_closed' &&
    onErrorRaw !== 'fail_open' &&
    !ID_RE.test(onErrorRaw) &&
    !QUALIFIED_REF_RE.test(onErrorRaw)
  ) {
    throw new RuleLoadError(
      `field "on_error" must be fail_closed, fail_open, or a rule identifier, got ${JSON.stringify(onErrorRaw)}`,
    );
  }

  const onFireRaw = doc['on_fire'] ?? [];
  const onFire: OnFireAction[] = [];
  for (const action of stringList(onFireRaw, 'on_fire')) {
    if (!(ON_FIRE_ACTIONS as readonly string[]).includes(action)) {
      // [OAR-FIRE-1] The side-effect vocabulary is closed.
      throw new RuleLoadError(`[OAR-FIRE-1] field "on_fire" names undefined side-effect ${JSON.stringify(action)}`);
    }
    onFire.push(action as OnFireAction);
  }

  const overrides = stringList(doc['overrides'] ?? [], 'overrides');
  for (const ref of overrides) {
    if (!ID_RE.test(ref) && !QUALIFIED_REF_RE.test(ref)) {
      throw new RuleLoadError(`field "overrides" holds malformed rule reference ${JSON.stringify(ref)}`);
    }
  }

  const statusRaw = doc['status'] ?? 'stable';
  if (typeof statusRaw !== 'string' || !(STATUSES as readonly string[]).includes(statusRaw)) {
    throw new RuleLoadError(`field "status" must be one of ${STATUSES.join(', ')}`);
  }

  const related: RelatedEntry[] = [];
  const relatedRaw = doc['related'] ?? [];
  if (!Array.isArray(relatedRaw)) throw new RuleLoadError('field "related" must be a list');
  for (const entry of relatedRaw) {
    if (!isObject(entry)) throw new RuleLoadError('field "related" holds a non-object');
    for (const key of Object.keys(entry)) {
      if (key !== 'id' && key !== 'type') throw new RuleLoadError(`field "related" carries undefined member ${JSON.stringify(key)}`);
    }
    const rid = entry['id'];
    const rtype = entry['type'];
    if (typeof rid !== 'string' || (!ID_RE.test(rid) && !QUALIFIED_REF_RE.test(rid))) {
      throw new RuleLoadError(`field "related" holds malformed rule reference ${JSON.stringify(rid)}`);
    }
    if (typeof rtype !== 'string' || !(RELATED_TYPES as readonly string[]).includes(rtype)) {
      throw new RuleLoadError(`field "related" type must be one of ${RELATED_TYPES.join(', ')}`);
    }
    related.push({ id: rid, type: rtype });
  }

  const copy: Record<string, string> = {};
  const copyRaw = doc['copy'];
  if (copyRaw !== undefined) {
    if (!isObject(copyRaw)) throw new RuleLoadError('field "copy" must be an object');
    for (const [key, value] of Object.entries(copyRaw)) {
      // [OAR-DOC-24] copy carries a closed set of presentation strings.
      if (!COPY_MEMBERS.has(key)) throw new RuleLoadError(`[OAR-DOC-24] field "copy" carries undefined member ${JSON.stringify(key)}`);
      if (typeof value !== 'string') throw new RuleLoadError(`field "copy.${key}" must be a string`);
      copy[key] = value;
    }
  }

  const referencesRaw = doc['references'];
  if (referencesRaw !== undefined) {
    if (!isObject(referencesRaw)) throw new RuleLoadError('field "references" must be an object');
    for (const [key, value] of Object.entries(referencesRaw)) stringList(value, `references.${key}`);
  }

  // [OAR-DOC-23] detector is present if and only if kind is detector.
  const detectorRaw = doc['detector'];
  let detectorRef: string | undefined;
  if (kind === 'detector') {
    if (!isObject(detectorRaw)) throw new RuleLoadError(`[OAR-DOC-23] rule ${qualified} has kind detector and must carry "detector"`);
    for (const key of Object.keys(detectorRaw)) {
      if (key !== 'ref') throw new RuleLoadError(`field "detector" carries undefined member ${JSON.stringify(key)}`);
    }
    const ref = detectorRaw['ref'];
    if (typeof ref !== 'string' || !DETECTOR_RE.test(ref)) {
      throw new RuleLoadError('field "detector.ref" must be a detector:// reference');
    }
    // [OAR-OPS-12] A reference the engine cannot resolve to a registered
    // detector is a load-time rejection.
    if (!env.detectors.has(ref)) {
      throw new RuleLoadError(`[OAR-OPS-12] rule ${qualified} references detector ${ref}, which is not registered`);
    }
    detectorRef = ref;
  } else if (detectorRaw !== undefined) {
    throw new RuleLoadError(`[OAR-DOC-23] rule ${qualified} has kind ${kind} and must not carry "detector"`);
  }

  // [OAR-DOC-22] transform is present if and only if effect is transform.
  const transformRaw = doc['transform'];
  let transform: TransformSpec | undefined;
  if (effect === 'transform') {
    // [OAR-OPS-18] An engine that does not implement content mutation refuses
    // the rule rather than treating it as a block or ignoring it.
    if (!env.supportsTransform) {
      throw new RuleLoadError(`[OAR-OPS-18] rule ${qualified} has effect transform, and this engine declares supports_transform false`);
    }
    if (!isObject(transformRaw)) throw new RuleLoadError(`[OAR-DOC-22] rule ${qualified} has effect transform and must carry "transform"`);
    for (const key of Object.keys(transformRaw)) {
      if (key !== 'action' && key !== 'target' && key !== 'replacement') {
        throw new RuleLoadError(`field "transform" carries undefined member ${JSON.stringify(key)}`);
      }
    }
    const action = transformRaw['action'];
    const target = transformRaw['target'];
    const replacement = transformRaw['replacement'];
    if (typeof action !== 'string' || !(TRANSFORM_ACTIONS as readonly string[]).includes(action)) {
      throw new RuleLoadError(`field "transform.action" must be one of ${TRANSFORM_ACTIONS.join(', ')}`);
    }
    if (typeof target !== 'string') throw new RuleLoadError('field "transform.target" must be a string');
    if (replacement !== undefined && typeof replacement !== 'string') {
      throw new RuleLoadError('field "transform.replacement" must be a string');
    }
    if ((action === 'replace' || action === 'annotate') && replacement === undefined) {
      throw new RuleLoadError(`[OAR-OPS-13] field "transform.replacement" is required for action ${action}`);
    }
    // [OAR-OPS-14] target names the whole content, or a list<map> fact carrying
    // the spans to act on. Anything else is a load-time rejection.
    if (target !== 'content') {
      const fact = env.facts.get(target);
      if (fact === undefined || fact.type !== 'list<map>') {
        throw new RuleLoadError(
          `[OAR-OPS-14] field "transform.target" names ${JSON.stringify(target)}, which is neither "content" nor a declared list<map> fact`,
        );
      }
    }
    const act = action as TransformSpec['action'];
    transform = replacement === undefined ? { action: act, target } : { action: act, target, replacement };
  } else if (transformRaw !== undefined) {
    throw new RuleLoadError(`[OAR-DOC-22] rule ${qualified} has effect ${effect} and must not carry "transform"`);
  }

  // [OAR-CONF-3], [OAR-PROF-4] Resolve the anchor: a core anchor identifier
  // through the profile map, any other value against the declared host anchor
  // catalogue.
  let resolvedAnchor: string;
  if (isCoreAnchor(anchorRaw)) {
    const local = env.anchors[anchorRaw];
    if (local === undefined) {
      throw new RuleLoadError(`[OAR-PROF-4] rule ${qualified} targets core anchor ${anchorRaw}, which this host declares unsupported`);
    }
    resolvedAnchor = local;
  } else if (env.hostAnchors.has(anchorRaw)) {
    // [OAR-PROF-5] A catalogued host-native anchor is a valid OAR document and
    // loads; it is simply not portable.
    resolvedAnchor = anchorRaw;
  } else {
    // [OAR-DOC-12], [OAR-PROF-5] Neither core nor catalogued: a load error
    // naming the value. A misspelled anchor must not load and silently never
    // run.
    throw new RuleLoadError(
      `[OAR-DOC-12] rule ${qualified} names anchor ${anchorRaw}, which is neither a core anchor nor in the declared host anchor catalogue`,
    );
  }

  // [OAR-DOC-21], [OAR-FACT-19] Capability negotiation.
  const requiresRaw = doc['requires'] ?? {};
  if (!isObject(requiresRaw)) throw new RuleLoadError('field "requires" must be an object');
  for (const key of Object.keys(requiresRaw)) {
    if (key !== 'profiles' && key !== 'facts') {
      throw new RuleLoadError(`field "requires" carries undefined member ${JSON.stringify(key)}`);
    }
  }
  const requiresProfiles = stringList(requiresRaw['profiles'] ?? [], 'requires.profiles');
  const requiresFacts = stringList(requiresRaw['facts'] ?? [], 'requires.facts');
  for (const name of requiresFacts) {
    if (!FACT_NAME_RE.test(name)) throw new RuleLoadError(`field "requires.facts" holds malformed name ${JSON.stringify(name)}`);
  }

  const reachable = new Set<string>();
  for (const profile of requiresProfiles) {
    if (!env.profiles.has(profile)) {
      throw new RuleLoadError(
        `[OAR-FACT-19] rule ${qualified} requires capability profile ${JSON.stringify(profile)}, which this host does not provide`,
      );
    }
    const def = PROFILES[profile]!;
    for (const name of Object.keys(def.facts)) reachable.add(name);
    for (const name of Object.keys(def.functions)) reachable.add(name);
  }
  for (const name of requiresFacts) {
    if (!env.facts.has(name) && !env.functions.has(name)) {
      throw new RuleLoadError(
        `[OAR-FACT-19] rule ${qualified} requires fact ${JSON.stringify(name)}, which this host does not provide`,
      );
    }
    reachable.add(name);
  }

  const refs = new Set<string>();
  // [OAR-FACT-11] A rule references a fact from its transform target as much as
  // from its condition. The target is the one reference that is not part of
  // deciding whether the rule fires, so an engine that omits it here produces a
  // transform that rewrites nothing and reports success.
  if (transform !== undefined && transform.target !== 'content') {
    if (!reachable.has(transform.target)) throw new RuleLoadError(`[OAR-FACT-20] transform target ${transform.target} is outside requires`);
    refs.add(transform.target);
  }
  const warnings: string[] = [];

  // [OAR-SEL-1] A selector clause is named by a fact.
  const selector: SelectorClause[] = [];
  const selectorRaw = doc['selector'];
  if (selectorRaw !== undefined) {
    if (!isObject(selectorRaw)) throw new RuleLoadError('field "selector" must be an object');
    for (const [factName, valuesRaw] of Object.entries(selectorRaw)) {
      const fact = env.facts.get(factName);
      // [OAR-SEL-3] A clause naming a fact the engine does not declare, or one
      // whose type is neither string nor list<string>, is a load error — never a
      // silent match and never a silent non-match.
      if (fact === undefined) {
        throw new RuleLoadError(
          `[OAR-SEL-3] selector clause ${JSON.stringify(factName)} names a fact this engine does not declare`,
        );
      }
      if (fact.type !== 'string' && fact.type !== 'list<string>') {
        throw new RuleLoadError(
          `[OAR-SEL-3] selector clause ${JSON.stringify(factName)} names a fact of type ${fact.type}, which is neither string nor list<string>`,
        );
      }
      if (fact.tier !== 'core' && !reachable.has(factName)) {
        // [OAR-FACT-20] A selector reference outside the core tier must be
        // reached through requires.
        throw new RuleLoadError(
          `[OAR-FACT-20] selector clause ${JSON.stringify(factName)} is outside the core tier and the rule does not reach it through requires`,
        );
      }
      const values = stringList(valuesRaw, `selector.${factName}`);
      // [OAR-SEL-6] A clause whose value is the empty list matches nothing. The
      // rule loads, and the engine warns.
      if (values.length === 0) {
        warnings.push(`selector clause ${JSON.stringify(factName)} is empty, so rule ${qualified} is never selected`);
      }
      refs.add(factName);
      selector.push({ fact: factName, values });
    }
  }

  // [OAR-DOC-14] The condition, type-checked against the declared environment.
  const whenRaw = doc['when'];
  let when: Node | null = null;
  if (whenRaw !== undefined) {
    if (typeof whenRaw !== 'string') throw new RuleLoadError('field "when" must be a string');
    let ast: Node;
    try {
      ast = parse(whenRaw);
    } catch (err) {
      throw new RuleLoadError(`rule ${qualified} condition: ${(err as Error).message}`);
    }
    // [OAR-EXPR-17] The declared parse-tree ceiling.
    const nodes = countNodes(ast);
    if (nodes > env.expressionNodesMax) {
      throw new RuleLoadError(
        `[OAR-EXPR-17] rule ${qualified} condition has ${nodes} parse-tree nodes, above the declared expression_nodes_max of ${env.expressionNodesMax}`,
      );
    }
    let result;
    try {
      result = check(ast, { env, reachable });
    } catch (err) {
      if (err instanceof ConditionTypeError) throw new RuleLoadError(`rule ${qualified} condition: ${err.message}`);
      throw err;
    }
    // [OAR-FACT-4] A rejection for a non-boolean result names the type the
    // condition produced and the word bool.
    if (result.type !== 'bool') {
      throw new RuleLoadError(
        `[OAR-FACT-4] rule ${qualified} condition produces ${result.type}, want bool`,
      );
    }
    for (const name of result.refs) refs.add(name);
    when = ast;
  }

  // [OAR-FIRE-11] Collect the counter reads. The argument was already required
  // to be a string literal by the type checker, so every reference can be
  // resolved — and an unresolvable one reported — at load, in loadRuleSet.
  const counterRefs: CounterRef[] = [];
  if (when !== null) {
    walkNodes(when, (n) => {
      if (n.kind !== 'call') return;
      const counter = COUNTER_READERS[n.name];
      if (counter === undefined) return;
      const arg = n.args[0];
      if (arg === undefined || arg.kind !== 'string') return;
      counterRefs.push({ fn: n.name, counter, literal: arg.value, target: resolveRef(arg.value, namespace) });
    });
  }

  // [OAR-DOC-32], [OAR-FIRE-10] counter_scope names a declared fact of type
  // string whose value keys this rule's counters. A name the engine does not
  // declare, a fact of another type, and a non-core fact the rule does not reach
  // through requires are each a load-time rejection naming the fact.
  const counterScopeRaw = doc['counter_scope'];
  let counterScope: string | undefined;
  if (counterScopeRaw !== undefined) {
    if (typeof counterScopeRaw !== 'string' || !FACT_NAME_RE.test(counterScopeRaw)) {
      throw new RuleLoadError(`field "counter_scope" must name a declared fact, got ${JSON.stringify(counterScopeRaw)}`);
    }
    const decl = env.facts.get(counterScopeRaw);
    if (decl === undefined) {
      throw new RuleLoadError(
        `[OAR-FIRE-10] rule ${qualified} names counter_scope ${counterScopeRaw}, which this engine does not declare`,
      );
    }
    if (decl.type !== 'string') {
      throw new RuleLoadError(
        `[OAR-FIRE-10] rule ${qualified} names counter_scope ${counterScopeRaw}, whose type is ${decl.type} and not string`,
      );
    }
    if (decl.tier !== 'core' && !reachable.has(counterScopeRaw)) {
      throw new RuleLoadError(
        `[OAR-FIRE-10] rule ${qualified} names counter_scope ${counterScopeRaw}, which is outside the core tier and the rule does not reach it through requires`,
      );
    }
    // The scope fact is observed at every occurrence at which the rule's
    // counters move, so it is a name the rule references for the purposes of
    // fact production and of the [OAR-PROF-8] portability report.
    refs.add(counterScopeRaw);
    counterScope = counterScopeRaw;
  }

  // [OAR-COPY-2], [OAR-COPY-3], [OAR-COPY-4], [OAR-COPY-5] Copy bindings are
  // fact references: unknown names, illegal constructs, and non-interpolatable
  // types are load failures, and a non-core name must be reached through requires.
  for (const [member, text] of Object.entries(copy)) {
    let bindings;
    try {
      bindings = parseCopy(text);
    } catch (err) {
      if (err instanceof CopyLoadError) {
        throw new RuleLoadError(
          `[OAR-COPY-3] rule ${qualified} copy.${member} carries construct ${err.message}`,
        );
      }
      throw err;
    }
    for (const binding of bindings) {
      const decl = env.facts.get(binding.name);
      if (decl === undefined) {
        throw new RuleLoadError(
          `[OAR-COPY-2] rule ${qualified} copy.${member} names ${binding.name}, which this engine does not declare`,
        );
      }
      if (binding.interpolate && !INTERPOLATABLE.has(decl.type)) {
        throw new RuleLoadError(
          `[OAR-COPY-4] rule ${qualified} copy.${member} interpolates ${binding.name}, whose type is ${decl.type}`,
        );
      }
      if (decl.tier !== 'core' && !reachable.has(binding.name)) {
        throw new RuleLoadError(
          `[OAR-FACT-20] copy names ${binding.name}, which is outside the core tier and the rule does not reach it through requires`,
        );
      }
      refs.add(binding.name);
    }
  }

  // [OAR-DOC-15], [OAR-FACT-13], [OAR-PROF-3] flow against the declared window.
  const flowRaw = doc['flow'];
  let flow: string[] = [];
  const hasFlow = flowRaw !== undefined;
  if (hasFlow) {
    flow = stringList(flowRaw, 'flow');
    // [OAR-DOC-15] A present flow is non-empty: a vacuous match and an
    // impossible match are both defensible readings of [], so it does not load.
    if (flow.length === 0) {
      throw new RuleLoadError(`[OAR-DOC-15] rule ${qualified} carries an empty flow, which has no defined meaning`);
    }
    if (env.activityWindow === 0) {
      throw new RuleLoadError(
        `[OAR-PROF-3] rule ${qualified} carries flow, and this host declares activity_window 0`,
      );
    }
    if (flow.length > env.activityWindow) {
      throw new RuleLoadError(
        `[OAR-FACT-13] rule ${qualified} carries a flow of ${flow.length} steps, above the declared activity_window of ${env.activityWindow}`,
      );
    }
  }

  return {
    id,
    namespace,
    qualified,
    kind: kind as Kind,
    anchor: anchorRaw,
    resolvedAnchor,
    selector,
    ...(typeof whenRaw === 'string' ? { whenSource: whenRaw } : {}),
    when,
    flow,
    hasFlow,
    effect: effect as Effect,
    enforcement,
    mandatory: mandatoryRaw,
    onError: onErrorRaw,
    onFire,
    ...(counterScope !== undefined ? { counterScope } : {}),
    counterRefs,
    overrides,
    requiresProfiles,
    requiresFacts,
    ...(transform ? { transform } : {}),
    ...(detectorRef ? { detectorRef } : {}),
    copy,
    status: statusRaw,
    related,
    refs,
    warnings,
  };
}

export interface RuleSet {
  readonly rules: readonly LoadedRule[];
  /** Qualified identifier to the rule carrying it. */
  readonly byId: ReadonlyMap<string, LoadedRule>;
  /** Qualified identifier to the qualified identifiers it suppresses. */
  readonly suppresses: ReadonlyMap<string, readonly string[]>;
  /** Qualified identifier to the rule substituted when it cannot be evaluated. */
  readonly errorSubstitute: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

/**
 * Load a rule set: each document, then the set-level checks — duplicate
 * identities, `overrides` resolution and cycles, and `on_error` substitutions.
 */
export function loadRuleSet(docs: readonly unknown[], env: Environment): RuleSet {
  const rules = docs.map((doc) => loadRuleDocument(doc, env));

  const byId = new Map<string, LoadedRule>();
  for (const rule of rules) {
    // [OAR-DOC-9] Two rules with the same qualified identifier are a rejection.
    // [OAR-DOC-8] Two documents sharing an id under different namespaces are
    // distinct rules and both load.
    if (byId.has(rule.qualified)) {
      throw new RuleLoadError(`[OAR-DOC-9] rule set contains two rules with qualified identifier ${rule.qualified}`);
    }
    byId.set(rule.qualified, rule);
  }

  const suppresses = new Map<string, string[]>();
  for (const rule of rules) {
    const targets: string[] = [];
    for (const ref of rule.overrides) {
      const target = resolveRef(ref, rule.namespace);
      const found = byId.get(target);
      // [OAR-EVAL-13] An overrides entry that resolves to no loaded rule is a
      // load-time rejection, naming it.
      if (found === undefined) {
        throw new RuleLoadError(`[OAR-EVAL-13] rule ${rule.qualified} overrides ${target}, which is not loaded`);
      }
      // [OAR-EVAL-17], [OAR-OPS-7] A mandatory rule cannot be suppressed.
      if (found.mandatory) {
        throw new RuleLoadError(`[OAR-EVAL-17] rule ${rule.qualified} overrides ${target}, whose mandatory is true`);
      }
      if (target === rule.qualified) {
        throw new RuleLoadError(`overrides forms a cycle: ${rule.qualified} -> ${rule.qualified}`);
      }
      targets.push(target);
    }
    suppresses.set(rule.qualified, targets);
  }

  // [OAR-EVAL-16] A suppression cycle is a load-time rejection, naming the rules
  // in it.
  const cycle = findCycle(suppresses);
  if (cycle !== null) throw new RuleLoadError(`[OAR-EVAL-16] overrides forms a cycle: ${cycle.join(' -> ')}`);

  // [OAR-FIRE-11] A fire_count_of or breaker_count_of argument resolving to no
  // loaded rule is a load-time rejection, naming it. The argument was required
  // to be a literal precisely so this check can happen here.
  for (const rule of rules) {
    for (const ref of rule.counterRefs) {
      const target = byId.get(ref.target);
      if (target === undefined) {
        throw new RuleLoadError(
          `[OAR-FIRE-11] rule ${rule.qualified} reads ${ref.fn}(${JSON.stringify(ref.literal)}), which resolves to ${ref.target} and is not loaded`,
        );
      }
      const scope = target.counterScope;
      if (scope !== undefined) {
        const declaration = env.facts.get(scope)!;
        const reached = declaration.tier === 'core' || rule.requiresFacts.includes(scope) ||
          rule.requiresProfiles.some((profile) => Object.hasOwn(PROFILES[profile]!.facts, scope));
        if (!reached) {
          throw new RuleLoadError(`[OAR-FIRE-11] indirect counter_scope ${scope} is outside requires for ${rule.qualified}`);
        }
      }
    }
  }

  const errorSubstitute = new Map<string, string>();
  for (const rule of rules) {
    if (rule.onError === 'fail_closed' || rule.onError === 'fail_open') continue;
    const target = resolveRef(rule.onError, rule.namespace);
    // [OAR-OPS-5] An on_error naming a rule that is not loaded is a rejection.
    if (!byId.has(target)) {
      throw new RuleLoadError(`[OAR-OPS-5] rule ${rule.qualified} names on_error ${target}, which is not loaded`);
    }
    errorSubstitute.set(rule.qualified, target);
  }

  const warnings = rules.flatMap((r) => r.warnings);
  return { rules, byId, suppresses, errorSubstitute, warnings };
}

function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, number>(); // 0 unvisited, 1 on stack, 2 done
  const stack: string[] = [];
  let found: string[] | null = null;

  const visit = (node: string): void => {
    if (found !== null) return;
    const s = state.get(node) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      const at = stack.indexOf(node);
      found = [...stack.slice(at), node];
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 2);
  };

  for (const node of edges.keys()) {
    visit(node);
    if (found !== null) return found;
  }
  return null;
}

/**
 * [OAR-PROF-8] A portability report: why a rule will not travel. A non-portable
 * rule is legal, so this is never a load failure.
 */
export function portability(rule: LoadedRule, env: Environment): string[] {
  const reasons: string[] = [];
  if (!isCoreAnchor(rule.anchor)) reasons.push(`anchor ${rule.anchor} is host-native`);
  for (const name of rule.refs) {
    const decl = env.facts.get(name) ?? env.functions.get(name);
    if (decl === undefined) continue;
    if (decl.tier === 'host') reasons.push(`fact ${name} is host-tier`);
  }
  if (rule.flow.length > 0) reasons.push(`flow of ${rule.flow.length} steps needs an activity window at least that large`);
  return reasons;
}
