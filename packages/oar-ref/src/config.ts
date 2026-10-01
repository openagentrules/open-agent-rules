// Section 9: the operator configuration document.
//
// A rule pack arrives from a publisher; an operator has to run it. The
// configuration document is what keeps the pack and the operator's local
// decisions separate, so disabling one rule does not mean forking the pack.
//
// [OAR-CFG-6] A configuration never alters a rule's anchor, selector, when,
// effect, on_fire, overrides, or copy — this module only ever writes an
// enforcement value, which is structurally why that holds.

import { resolveRef, type RuleSet } from './load.js';
import { ENFORCEMENTS, OAR_MAJOR, OAR_MINOR, type Enforcement } from './vocab.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ID_RE = /^[A-Z][A-Z0-9_]*$/;
const QUALIFIED_REF_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\/[A-Z][A-Z0-9_]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve a configuration reference against the loaded set. A bare id matches
 * the rule carrying it when exactly one rule does, whatever its namespace: an
 * operator writes `READ_OUTSIDE_SCOPE`, not the publisher's full scope.
 */
function resolveRuleRef(ref: string, set: RuleSet): string | null {
  if (set.byId.has(ref)) return ref;
  const matches = [...set.byId.values()].filter((r) => r.id === ref);
  if (matches.length === 1) return matches[0]!.qualified;
  if (matches.length > 1) {
    throw new ConfigError(`[OAR-CFG-8] configuration names ${ref}, which is ambiguous across namespaces: ${matches.map((r) => r.qualified).join(', ')}`);
  }
  const inHost = resolveRef(ref, '');
  return set.byId.has(inHost) ? inHost : null;
}

/**
 * Apply configuration documents in order, returning the effective enforcement
 * of every rule the configuration speaks about. [OAR-CFG-7] the last statement
 * about a rule wins.
 */
export function applyConfigs(
  docs: readonly unknown[],
  set: RuleSet,
): Map<string, Enforcement> {
  const effective = new Map<string, Enforcement>();

  for (const doc of docs) {
    if (!isObject(doc)) throw new ConfigError('a configuration document must be a JSON object');
    for (const key of Object.keys(doc)) {
      if (key !== 'oar_config' && key !== 'disable' && key !== 'enforcement') {
        throw new ConfigError(`[OAR-CFG-6] configuration document carries undefined field ${JSON.stringify(key)}`);
      }
    }
    // [OAR-CFG-1] A configuration carries oar_config and any of disable and
    // enforcement.
    const version = doc['oar_config'];
    if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
      throw new ConfigError('configuration document field "oar_config" must be <major>.<minor>');
    }
    // [OAR-CFG-1] A configuration written against a later minor may name
    // enforcement machinery this engine does not have, so it is refused exactly
    // as [OAR-DOC-4] and [OAR-DOC-5] refuse a document.
    const [majorText, minorText] = version.split('.') as [string, string];
    if (Number(majorText) !== OAR_MAJOR || Number(minorText) > OAR_MINOR) {
      throw new ConfigError(
        `[OAR-CFG-1] oar_config ${version} names a version this engine does not implement (${OAR_MAJOR}.${OAR_MINOR})`,
      );
    }

    const disable = doc['disable'] ?? [];
    if (!Array.isArray(disable)) throw new ConfigError('configuration field "disable" must be a list');
    for (const raw of disable) {
      if (typeof raw !== 'string' || (!ID_RE.test(raw) && !QUALIFIED_REF_RE.test(raw))) {
        throw new ConfigError(`configuration field "disable" holds malformed rule reference ${JSON.stringify(raw)}`);
      }
      const target = resolveRuleRef(raw, set);
      // [OAR-CFG-4] A configuration naming a rule that is not loaded is
      // rejected. One that silently refers to nothing is indistinguishable from
      // one that works.
      if (target === null) throw new ConfigError(`[OAR-CFG-4] configuration disables ${raw}, which is not loaded`);
      // [OAR-CFG-5], [OAR-OPS-7] A mandatory rule cannot be disabled.
      if (set.byId.get(target)!.mandatory) {
        throw new ConfigError(`[OAR-CFG-5] configuration disables ${target}, whose mandatory is true`);
      }
      // [OAR-CFG-2] A listed rule is treated as though its enforcement were off.
      effective.set(target, 'off');
    }

    const enforcement = doc['enforcement'] ?? {};
    if (!isObject(enforcement)) throw new ConfigError('configuration field "enforcement" must be an object');
    for (const [raw, value] of Object.entries(enforcement)) {
      if (!ID_RE.test(raw) && !QUALIFIED_REF_RE.test(raw)) {
        throw new ConfigError(`configuration field "enforcement" holds malformed rule reference ${JSON.stringify(raw)}`);
      }
      if (typeof value !== 'string' || !(ENFORCEMENTS as readonly string[]).includes(value)) {
        throw new ConfigError(`configuration sets ${raw} to ${JSON.stringify(value)}, which is not an enforcement value`);
      }
      const target = resolveRuleRef(raw, set);
      if (target === null) throw new ConfigError(`[OAR-CFG-4] configuration sets enforcement for ${raw}, which is not loaded`);
      if (set.byId.get(target)!.mandatory && value !== 'enforce') {
        // [OAR-CFG-5] A mandatory rule cannot be downgraded.
        throw new ConfigError(`[OAR-CFG-5] configuration downgrades ${target} to ${value}, whose mandatory is true`);
      }
      // [OAR-CFG-3] The configured value replaces the rule's own declared
      // enforcement.
      effective.set(target, value as Enforcement);
    }
  }

  return effective;
}
