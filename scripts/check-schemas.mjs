#!/usr/bin/env node
// Gate: the published JSON Schemas are fetchable and self-consistent.
//
// A third-party validator loads these by URL and follows every `$ref` from
// there. Three things break that silently in a diff:
//
//   1. malformed JSON — the file 200s and the validator dies;
//   2. an `$id` that does not match the URL the file is served from, which
//      makes a validator resolve relative refs against the wrong base;
//   3. a `$ref` to a `$defs` pointer or a sibling file that is not there.
//
// So: every schema parses, every `$id` equals
// https://openagentrules.org/spec/<version>/<filename>, and every `$ref`
// resolves — either to a local `#/$defs/...` pointer, or to a sibling schema
// that exists (named relatively or by its published URL).
//
// Usage: node scripts/check-schemas.mjs [version]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.argv[2] ?? '1.0';
const DIR = join(REPO, 'spec', 'oar', VERSION, 'schemas');
const BASE = `https://openagentrules.org/spec/${VERSION}/`;

const errors = [];
const fail = (msg) => errors.push(msg);

const names = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (names.length === 0) {
  console.error(`error: no JSON schemas in spec/oar/${VERSION}/schemas/`);
  process.exit(1);
}

// --- parse ------------------------------------------------------------------

const docs = new Map();
for (const name of names) {
  try {
    docs.set(name, JSON.parse(readFileSync(join(DIR, name), 'utf8')));
  } catch (err) {
    fail(`${name} is not valid JSON — ${err.message}`);
  }
}

// --- $id --------------------------------------------------------------------

for (const [name, doc] of docs) {
  const want = BASE + name;
  if (doc.$id !== want) {
    fail(`${name}: $id is ${JSON.stringify(doc.$id)}, expected ${JSON.stringify(want)}`);
  }
  if (!doc.$schema) fail(`${name}: no $schema — a validator cannot tell which dialect this is`);
}

// --- $ref -------------------------------------------------------------------

// Walk a JSON value, yielding every { ref, where } pair with a JSON-Pointer
// path so a failure names the exact location rather than the file.
function* refs(node, path = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* refs(node[i], `${path}/${i}`);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') yield { ref: value, where: path || '/' };
      else yield* refs(value, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
  }
}

// Resolve a `#/a/b` JSON Pointer inside a document.
function pointer(doc, fragment) {
  if (fragment === '' || fragment === '/') return doc;
  let node = doc;
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

let refCount = 0;
for (const [name, doc] of docs) {
  for (const { ref, where } of refs(doc)) {
    refCount++;
    const at = `${name} at ${where}`;

    // Local pointer.
    if (ref.startsWith('#')) {
      if (pointer(doc, ref.slice(1)) === undefined) {
        fail(`${at}: $ref "${ref}" resolves to nothing in this document`);
      }
      continue;
    }

    // Published URL, or a relative sibling filename. Both must name a file in
    // this directory: the set has to resolve from the web and from a local
    // checkout alike.
    let target = ref;
    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      if (!ref.startsWith(BASE)) {
        fail(`${at}: $ref "${ref}" points outside ${BASE} — the schema set must be self-contained`);
        continue;
      }
      target = ref.slice(BASE.length);
    } else if (target.includes('/')) {
      fail(`${at}: $ref "${ref}" is a path — inter-schema refs are sibling filenames`);
      continue;
    }

    const [file, fragment] = target.split('#');
    if (!docs.has(file)) {
      fail(`${at}: $ref "${ref}" names ${file}, which is not in spec/oar/${VERSION}/schemas/`);
      continue;
    }
    if (fragment !== undefined && pointer(docs.get(file), fragment) === undefined) {
      fail(`${at}: $ref "${ref}" resolves to nothing in ${file}`);
    }
  }
}

// --- report -----------------------------------------------------------------

if (errors.length > 0) {
  for (const err of errors) console.error(`error: ${err}`);
  console.error(`\n${errors.length} problem(s) in spec/oar/${VERSION}/schemas/`);
  process.exit(1);
}

console.log(`ok: ${docs.size} schemas parse, carry their published $id, and ${refCount} $refs resolve`);
