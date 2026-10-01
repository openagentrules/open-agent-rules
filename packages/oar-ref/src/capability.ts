// The capability document, and the fact environment it produces.
//
// [OAR-FACT-21] An engine publishes a machine-readable capability document
// listing its supported anchors, the profiles it provides, its host-tier facts
// and their types, and its activity window size. [OAR-CONF-20] a conformance
// runner evaluates a fixture against the fixture's own capability document
// rather than its own, so every implementation is asked the same question.

import {
  CORE_ANCHORS,
  CORE_FACTS,
  CORE_FUNCTIONS,
  FACT_TYPES,
  PROFILES,
  PROFILE_NAMES,
  RESERVED_DETECTORS,
  isCoreAnchor,
  isReservedWord,
  type FactType,
  type FunctionSig,
} from './vocab.js';

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export type Tier = 'core' | 'profile' | 'host';

export interface FactDecl {
  readonly name: string;
  readonly type: FactType;
  readonly tier: Tier;
  readonly profile?: string;
}

export interface FunctionDecl {
  readonly name: string;
  readonly sig: FunctionSig;
  readonly tier: Tier;
  readonly profile?: string;
}

export interface Environment {
  readonly host: string;
  /** Core anchor identifier to the local anchor implementing it. */
  readonly anchors: Readonly<Record<string, string>>;
  /**
   * The inverse of `anchors`: a host-local anchor identifier to the core anchor
   * it implements. [OAR-CONF-29] an occurrence names the host-local identifier,
   * while the core fact `anchor` reports the core one.
   */
  readonly coreForLocal: ReadonlyMap<string, string>;
  readonly unsupportedAnchors: readonly string[];
  /** [OAR-PROF-5] The declared host-native anchor catalogue. */
  readonly hostAnchors: ReadonlySet<string>;
  readonly profiles: ReadonlySet<string>;
  readonly facts: ReadonlyMap<string, FactDecl>;
  readonly functions: ReadonlyMap<string, FunctionDecl>;
  readonly activityWindow: number;
  readonly detectors: ReadonlySet<string>;
  readonly expressionNodesMax: number;
  readonly supportsTransform: boolean;
}

const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const LOCAL_ANCHOR_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const HOST_FACT_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[A-Za-z_][A-Za-z0-9_]*$/;
const FN_SIG_RE = /^\((bool|int|double|string)\) -> (bool|int|double|string)$/;

/**
 * [OAR-FACT-21] Everything a capability document must declare. `host_facts` is
 * not here: a host with no host-tier fact declares none, and the empty list and
 * the absent field say the same thing.
 */
export const REQUIRED_FIELDS: readonly string[] = [
  'oar_capability_version',
  'host',
  'anchors',
  'profiles',
  'activity_window',
  'detectors',
  'expression_nodes_max',
  'supports_transform',
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Report why this engine cannot adopt a declared capability set, or null when it
 * can. [OAR-CONF-20] a fixture whose capability set cannot be adopted is
 * reported as skipped, never as failed.
 */
export function adoptionObstacle(doc: unknown): string | null {
  if (!isObject(doc)) return 'capability document is not an object';
  const profiles = doc['profiles'];
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (typeof p !== 'string' || !PROFILE_NAMES.includes(p)) {
        return `this engine does not implement the capability profile ${JSON.stringify(p)}`;
      }
    }
  }
  const detectors = doc['detectors'];
  if (Array.isArray(detectors)) {
    for (const d of detectors) {
      if (typeof d !== 'string' || !(RESERVED_DETECTORS as readonly string[]).includes(d)) {
        return `this engine does not register the detector ${JSON.stringify(d)}`;
      }
    }
  }
  return null;
}

/** Parse and validate a capability document into a declared fact environment. */
export function loadCapability(doc: unknown): Environment {
  if (!isObject(doc)) throw new CapabilityError('capability document is not an object');

  const known = new Set([
    'oar_capability_version',
    'host',
    'anchors',
    'profiles',
    'activity_window',
    'host_facts',
    'detectors',
    'expression_nodes_max',
    'supports_transform',
  ]);
  for (const key of Object.keys(doc)) {
    if (!known.has(key)) throw new CapabilityError(`capability document carries undefined field ${JSON.stringify(key)}`);
  }

  // [OAR-FACT-21] The capability document declares all of: the anchor profile
  // map, the profiles provided, the activity window, the detector references
  // resolved, whether content mutation is implemented, and the parse-tree
  // ceiling. Every one of those is something a rule can be rejected for, so a
  // document omitting one leaves a load failure the document cannot predict —
  // which is the single thing it exists to make predictable. [OAR-FACT-24] an
  // engine validates its own document and refuses to start when it is invalid,
  // so an omission is a refusal here rather than a silent default.
  for (const required of REQUIRED_FIELDS) {
    if (doc[required] === undefined) {
      throw new CapabilityError(
        `[OAR-FACT-21] capability document is missing required field ${JSON.stringify(required)}`,
      );
    }
  }

  const version = doc['oar_capability_version'];
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new CapabilityError('capability document field "oar_capability_version" must be <major>.<minor>');
  }

  if (version !== "1.0") throw new CapabilityError("[OAR-FACT-24] unsupported oar_capability_version");

  const host = doc['host'];
  if (typeof host !== 'string' || !NAMESPACE_RE.test(host)) {
    throw new CapabilityError('capability document field "host" is not a namespace');
  }

  // [OAR-PROF-2] Every core anchor appears exactly once across core and
  // unsupported; a map omitting one or declaring one twice is rejected.
  const anchorsDoc = doc['anchors'];
  if (!isObject(anchorsDoc)) throw new CapabilityError('capability document field "anchors" is missing');
  for (const key of Object.keys(anchorsDoc)) {
    if (!['core', 'unsupported', 'host'].includes(key)) throw new CapabilityError(`[OAR-FACT-24] anchors has undefined field ${key}`);
  }
  const coreDoc = anchorsDoc['core'];
  if (!isObject(coreDoc)) throw new CapabilityError('capability document field "anchors.core" is missing');
  const unsupported = anchorsDoc['unsupported'] ?? [];
  if (!Array.isArray(unsupported)) throw new CapabilityError('capability document field "anchors.unsupported" is not a list');

  const anchors: Record<string, string> = {};
  for (const [core, local] of Object.entries(coreDoc)) {
    if (!isCoreAnchor(core)) throw new CapabilityError(`anchor profile map names ${JSON.stringify(core)}, which is not a core anchor`);
    if (typeof local !== 'string' || !LOCAL_ANCHOR_RE.test(local)) {
      throw new CapabilityError(`anchor profile map binds ${core} to a malformed local anchor`);
    }
    anchors[core] = local;
  }
  const unsupportedList: string[] = [];
  for (const name of unsupported) {
    if (typeof name !== 'string' || !isCoreAnchor(name)) {
      throw new CapabilityError(`anchor profile map lists ${JSON.stringify(name)} as unsupported, which is not a core anchor`);
    }
    if (unsupportedList.includes(name)) throw new CapabilityError('[OAR-PROF-2] duplicate anchors.unsupported entry');
    unsupportedList.push(name);
  }
  for (const core of CORE_ANCHORS) {
    const inCore = Object.prototype.hasOwnProperty.call(anchors, core);
    const inUnsupported = unsupportedList.includes(core);
    if (inCore && inUnsupported) throw new CapabilityError(`[OAR-PROF-2] anchor profile map declares core anchor ${core} twice`);
    if (!inCore && !inUnsupported) throw new CapabilityError(`[OAR-PROF-2] anchor profile map omits core anchor ${core}`);
  }

  // [OAR-PROF-5] The host-native anchor catalogue. A rule whose anchor is
  // neither a core anchor nor listed here is rejected at load, so a misspelled
  // anchor cannot load and silently never run.
  const hostAnchorsDoc = anchorsDoc['host'] ?? [];
  if (!Array.isArray(hostAnchorsDoc)) throw new CapabilityError('capability document field "anchors.host" is not a list');
  const hostAnchors = new Set<string>();
  for (const name of hostAnchorsDoc) {
    if (typeof name !== 'string' || !LOCAL_ANCHOR_RE.test(name)) {
      throw new CapabilityError(`capability document field "anchors.host" lists a malformed anchor ${JSON.stringify(name)}`);
    }
    if (isCoreAnchor(name)) {
      throw new CapabilityError(`[OAR-PROF-5] host anchor catalogue lists ${name}, which collides with a core anchor identifier`);
    }
    if (hostAnchors.has(name)) throw new CapabilityError('[OAR-FACT-24] duplicate anchors.host entry');
    hostAnchors.add(name);
  }

  const profilesDoc = doc['profiles'];
  if (!Array.isArray(profilesDoc)) throw new CapabilityError('capability document field "profiles" is missing');
  const profiles = new Set<string>();
  for (const p of profilesDoc) {
    if (typeof p !== 'string') throw new CapabilityError('capability document field "profiles" holds a non-string');
    if (!Object.prototype.hasOwnProperty.call(PROFILES, p)) {
      throw new CapabilityError(`[OAR-FACT-24] capability document claims profile ${JSON.stringify(p)}, which this specification does not define`);
    }
    if (profiles.has(p)) throw new CapabilityError('[OAR-FACT-24] duplicate profiles entry');
    profiles.add(p);
  }

  // [OAR-FACT-14] Every declared fact belongs to exactly one profile, the core
  // tier, or the engine's own host tier. [OAR-FACT-16] a claimed profile is
  // provided whole. [OAR-FACT-17] nothing redefines a core or profile name.
  const facts = new Map<string, FactDecl>();
  const functions = new Map<string, FunctionDecl>();
  for (const [name, type] of Object.entries(CORE_FACTS)) {
    facts.set(name, { name, type, tier: 'core' });
  }
  // [OAR-FIRE-11] fire_count_of and breaker_count_of are core-tier observation
  // functions, so a rule reaches them without naming anything in requires.
  for (const [name, sig] of Object.entries(CORE_FUNCTIONS)) {
    functions.set(name, { name, sig, tier: 'core' });
  }
  for (const p of profiles) {
    const def = PROFILES[p]!;
    for (const [name, type] of Object.entries(def.facts)) {
      facts.set(name, { name, type, tier: 'profile', profile: p });
    }
    for (const [name, sig] of Object.entries(def.functions)) {
      functions.set(name, { name, sig, tier: 'profile', profile: p });
    }
  }

  const hostFactsDoc = doc['host_facts'] ?? [];
  if (!Array.isArray(hostFactsDoc)) throw new CapabilityError('capability document field "host_facts" is not a list');
  for (const entry of hostFactsDoc) {
    if (!isObject(entry)) throw new CapabilityError('capability document field "host_facts" holds a non-object');
    for (const key of Object.keys(entry)) {
      if (!['name', 'type', 'observation'].includes(key)) throw new CapabilityError(`[OAR-FACT-24] host_facts has undefined field ${key}`);
    }
    if (entry['observation'] !== undefined && typeof entry['observation'] !== 'string') throw new CapabilityError('[OAR-FACT-24] host_facts.observation must be a string');
    const name = entry['name'];
    const type = entry['type'];
    if (typeof name !== 'string' || !HOST_FACT_RE.test(name)) {
      throw new CapabilityError(`[OAR-FACT-18] host fact ${JSON.stringify(name)} is not published under a namespace the host owns`);
    }
    if (host !== undefined && !name.startsWith(`${host}.`)) {
      throw new CapabilityError(`[OAR-FACT-18] host fact ${name} is not published under the host namespace ${host}`);
    }
    if (facts.has(name) || functions.has(name)) {
      throw new CapabilityError(`[OAR-FACT-17] host fact ${name} redefines a declared name`);
    }
    // [OAR-EXPR-24] An engine MUST NOT declare a fact or an observation function
    // under a reserved word. A name is one identifier however it is spelled, so
    // the check is against the whole name.
    if (isReservedWord(name)) {
      throw new CapabilityError(`[OAR-EXPR-24] host fact ${name} is declared under a reserved word`);
    }
    if (typeof type !== 'string') throw new CapabilityError(`host fact ${name} has no type`);
    const fnMatch = FN_SIG_RE.exec(type);
    if (fnMatch) {
      functions.set(name, {
        name,
        sig: { arg: fnMatch[1] as FactType, ret: fnMatch[2] as FactType },
        tier: 'host',
      });
      continue;
    }
    if (!(FACT_TYPES as readonly string[]).includes(type)) {
      throw new CapabilityError(`[OAR-FACT-22] host fact ${name} declares type ${JSON.stringify(type)}, which is not a fact type`);
    }
    facts.set(name, { name, type: type as FactType, tier: 'host' });
  }

  const windowRaw = doc['activity_window'];
  if (typeof windowRaw !== 'number' || !Number.isInteger(windowRaw) || windowRaw < 0) {
    throw new CapabilityError('capability document field "activity_window" must be a non-negative integer');
  }

  const detectorsDoc = doc['detectors'];
  if (!Array.isArray(detectorsDoc)) throw new CapabilityError('capability document field "detectors" is not a list');
  const detectors = new Set<string>();
  for (const d of detectorsDoc) {
    if (typeof d !== 'string' || !/^detector:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(d)) {
      throw new CapabilityError(`capability document lists a malformed detector reference ${JSON.stringify(d)}`);
    }
    if (detectors.has(d)) throw new CapabilityError('[OAR-FACT-24] duplicate detectors entry');
    detectors.add(d);
  }

  // [OAR-OPS-22] Detector-backed profiles require registered observation providers.
  for (const detectorBacked of ['secrets', 'pii', 'prompt-injection', 'jailbreak', 'moderation']) {
    if (profiles.has(detectorBacked) && detectors.size === 0) {
      throw new CapabilityError(
        `[OAR-OPS-22] capability document claims profile ${detectorBacked} with no registered detector`,
      );
    }
  }

  // [OAR-EXPR-17] The declared parse-tree ceiling is at least 256 nodes.
  const nodesRaw = doc['expression_nodes_max'];
  if (typeof nodesRaw !== 'number' || !Number.isInteger(nodesRaw) || nodesRaw < 256) {
    throw new CapabilityError('[OAR-EXPR-17] capability document field "expression_nodes_max" must be an integer of at least 256');
  }

  const supportsTransform = doc['supports_transform'];
  if (typeof supportsTransform !== 'boolean') throw new CapabilityError('capability document field "supports_transform" is not a boolean');

  const coreForLocal = new Map<string, string>();
  for (const core of CORE_ANCHORS) {
    const local = anchors[core];
    if (local !== undefined && !coreForLocal.has(local)) coreForLocal.set(local, core);
  }

  return {
    host,
    anchors,
    coreForLocal,
    unsupportedAnchors: unsupportedList,
    hostAnchors,
    profiles,
    facts,
    functions,
    activityWindow: windowRaw,
    detectors,
    expressionNodesMax: nodesRaw,
    supportsTransform,
  };
}

/**
 * This implementation's own capability document: every core anchor, every
 * standard profile, the three reserved detectors, and no host-tier facts, so
 * every rule it accepts of its own accord is portable by construction.
 */
export function referenceCapabilityDocument(): Record<string, unknown> {
  const core: Record<string, string> = {};
  for (const a of CORE_ANCHORS) core[a] = a;
  return {
    oar_capability_version: '1.0',
    host: 'openagentrules.reference',
    anchors: { core, unsupported: [] },
    profiles: [...PROFILE_NAMES],
    activity_window: 16,
    host_facts: [],
    detectors: [...RESERVED_DETECTORS],
    expression_nodes_max: 4096,
    supports_transform: true,
  };
}

/**
 * [OAR-FACT-24] An engine validates its own capability document before loading
 * any rule and refuses to start when it is invalid. Every requirement this
 * specification places on what a host declares is one the engine enforces
 * against itself; an engine that trusted its own configuration unchecked would
 * accept rules against a vocabulary it does not actually provide, and the
 * failure would surface as a wrong decision at run time rather than a refusal
 * to start.
 */
export function assertCapabilityValid(doc: unknown): Environment {
  try {
    return loadCapability(doc);
  } catch (err) {
    throw new CapabilityError(
      `[OAR-FACT-24] this engine refuses to start: its capability document is invalid — ${(err as Error).message}`,
    );
  }
}

export function referenceEnvironment(): Environment {
  return assertCapabilityValid(referenceCapabilityDocument());
}
