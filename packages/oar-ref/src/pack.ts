// Loading a rule pack from a directory, as a lint target.
//
// [OAR-DOC-31] A rule set may arrive as a JSON array of rule documents or as a
// multi-document YAML stream. Every member is an independent document, validated
// and rejected on its own terms, and a member's position in the collection never
// affects its identity, ordering, or precedence. [OAR-DOC-28] identity is never
// derived from a file name or path, which is why this reads whole directories
// and throws the file names away.

import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { loadCapability, type Environment } from './capability.js';
import { loadRuleSet, RuleLoadError, type RuleSet } from './load.js';
import { parseYaml, parseYamlStream } from './yaml.js';

export interface PackReport {
  readonly documents: number;
  readonly loaded: number;
  readonly set: RuleSet | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

function isRuleDocument(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read every rule document in a file, whatever collection form it uses. */
export async function readRuleDocuments(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8');
  const ext = extname(path);
  const parsed: unknown = ext === '.json' ? JSON.parse(text) : null;
  const docs = ext === '.json' ? (Array.isArray(parsed) ? parsed : [parsed]) : parseYamlStream(text);
  for (const doc of docs) {
    // [OAR-DOC-31] A collection containing a member that is not a rule document
    // is rejected.
    if (!isRuleDocument(doc)) throw new RuleLoadError(`${path} holds a member that is not a rule document`);
  }
  return docs;
}

export async function readCapabilityFile(path: string): Promise<Environment> {
  const text = await readFile(path, 'utf8');
  const doc: unknown = extname(path) === '.json' ? JSON.parse(text) : parseYaml(text);
  return loadCapability(doc);
}

/**
 * Load every rule document in a directory against a capability document, and
 * report what loaded. A rule that fails to load is a bug in the pack or the
 * engine, never a silent omission.
 */
export async function loadPack(dir: string, env: Environment): Promise<PackReport> {
  const names = (await readdir(dir))
    .filter((n) => (n.endsWith('.yaml') || n.endsWith('.yml') || n.endsWith('.json')) && !n.startsWith('capability.') && !n.startsWith('config.'))
    .sort();

  const docs: unknown[] = [];
  const errors: string[] = [];
  for (const name of names) {
    try {
      docs.push(...(await readRuleDocuments(join(dir, name))));
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }

  // Report every document that fails on its own terms before reporting the set.
  let loaded = 0;
  const { loadRuleDocument } = await import('./load.js');
  for (const doc of docs) {
    try {
      loadRuleDocument(doc, env);
      loaded++;
    } catch (err) {
      const id = isRuleDocument(doc) ? String(doc['id'] ?? '<no id>') : '<not an object>';
      errors.push(`${id}: ${(err as Error).message}`);
    }
  }

  let set: RuleSet | null = null;
  const warnings: string[] = [];
  if (errors.length === 0) {
    try {
      set = loadRuleSet(docs, env);
      warnings.push(...set.warnings);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  return { documents: docs.length, loaded, set, errors, warnings };
}
