#!/usr/bin/env node
// Gate: the vocabulary tables printed in the specification are the vocabulary.
//
// vocabulary.yaml is the machine-readable source of truth for the core facts,
// the capability profiles, and the core anchors. The specification prints the
// same three vocabularies as markdown tables so a reader never has to open a
// second file. Two copies of a normative list drift, and a drifting fact type
// is a rule that loads on one engine and is rejected by the next — so this
// gate parses both and compares them row by row.
//
// The markdown is delimited by comment markers:
//   <!-- oar:table core -->     ... <!-- /oar:table -->
//   <!-- oar:table profiles -->  ... <!-- /oar:table -->
//   <!-- oar:table anchors -->   ... <!-- /oar:table -->
//
// Two normalisations are applied before comparing, and only two:
//   * backticks are stripped from markdown cells — the prose marks identifiers
//     as inline code, the YAML stores them plain;
//   * a profile description's first letter is compared case-insensitively —
//     the YAML stores a sentence, the prose continues an em-dash clause.
// Everything else must match character for character.
//
// Usage: node scripts/check-vocab.mjs [version]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, YamlError } from './yaml-lite.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.argv[2] ?? '1.0';
const SPEC_DIR = join(REPO, 'spec', 'oar', VERSION);

const errors = [];
const fail = (msg) => errors.push(msg);

// --- inputs -----------------------------------------------------------------

let vocab;
try {
  vocab = parseYaml(readFileSync(join(SPEC_DIR, 'vocabulary.yaml'), 'utf8'));
} catch (err) {
  if (err instanceof YamlError) {
    console.error(`error: spec/oar/${VERSION}/vocabulary.yaml — ${err.message}`);
    console.error('\nThe vocabulary reader supports block maps, block sequences, scalars');
    console.error('and >- folded blocks only. Rewrite the construct rather than the reader.');
    process.exit(1);
  }
  throw err;
}

const specPath = join(SPEC_DIR, 'open-agent-rules.md');
const spec = readFileSync(specPath, 'utf8');

if (vocab.oar !== VERSION) {
  fail(`vocabulary.yaml declares oar: ${JSON.stringify(vocab.oar)}, expected "${VERSION}"`);
}

// --- markdown extraction ----------------------------------------------------

function block(name) {
  const open = `<!-- oar:table ${name} -->`;
  const start = spec.indexOf(open);
  if (start === -1) return null;
  const end = spec.indexOf('<!-- /oar:table -->', start);
  if (end === -1) return null;
  return spec.slice(start + open.length, end).trim();
}

const unstyle = (cell) => cell.replace(/`/g, '').trim();

// Read one pipe table. Returns { header: [...], rows: [[...]] }.
function table(text, where) {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 3) {
    fail(`${where}: expected a markdown table with a header and at least one row`);
    return null;
  }
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const header = cells(lines[0]);
  if (!/^[\s|:-]+$/.test(lines[1])) {
    fail(`${where}: the row after the header is not a table separator: ${lines[1]}`);
    return null;
  }
  return { header, rows: lines.slice(2).map(cells) };
}

// Compare a fact table against a list of { name, type, observation }.
function compareFacts(md, facts, where, nameHeader) {
  if (!md) return;
  const want = [nameHeader, 'Type', 'Observation'];
  if (md.header.join(' | ') !== want.join(' | ')) {
    fail(`${where}: header is "${md.header.join(' | ')}", expected "${want.join(' | ')}"`);
  }
  if (md.rows.length !== facts.length) {
    fail(`${where}: ${md.rows.length} rows in the spec, ${facts.length} in vocabulary.yaml`);
  }
  const n = Math.max(md.rows.length, facts.length);
  for (let i = 0; i < n; i++) {
    const row = md.rows[i];
    const fact = facts[i];
    if (!row) {
      fail(`${where}: vocabulary.yaml has \`${fact.name}\` at row ${i + 1}; the spec table ends`);
      continue;
    }
    if (!fact) {
      fail(`${where}: the spec table has \`${row[0]}\` at row ${i + 1}; vocabulary.yaml ends`);
      continue;
    }
    if (row.length !== 3) {
      fail(`${where}: row ${i + 1} has ${row.length} cells, expected 3: ${row.join(' | ')}`);
      continue;
    }
    const [name, type, observation] = row.map(unstyle);
    if (name !== fact.name) fail(`${where} row ${i + 1}: name "${name}" != "${fact.name}"`);
    if (type !== fact.type) fail(`${where} \`${fact.name}\`: type "${type}" != "${fact.type}"`);
    const wanted = String(fact.observation).replace(/\s+/g, ' ').trim();
    const got = observation.replace(/\s+/g, ' ').trim();
    if (got !== wanted) {
      fail(`${where} \`${fact.name}\`: observation drifted\n    spec: ${got}\n    yaml: ${wanted}`);
    }
  }
}

// --- 5.3 core facts ---------------------------------------------------------

const coreBlock = block('core');
if (coreBlock === null) fail('no <!-- oar:table core --> block in the specification');
else compareFacts(table(coreBlock, 'core table'), vocab.core.facts, 'core table', 'Name');

// --- 5.4 standard profiles --------------------------------------------------

const profilesBlock = block('profiles');
if (profilesBlock === null) {
  fail('no <!-- oar:table profiles --> block in the specification');
} else {
  // Each profile is a `**Profile \`name\`** — description` line followed by a
  // table. Split on the heading lines so a missing or reordered profile shows
  // up as a name mismatch rather than a silently ignored section.
  const chunks = [];
  for (const line of profilesBlock.split('\n')) {
    const heading = /^\*\*Profile `([^`]+)`\*\*\s*—\s*(.+?)\s*$/.exec(line.trim());
    if (heading) chunks.push({ name: heading[1], description: heading[2], body: [] });
    else if (chunks.length > 0) chunks.at(-1).body.push(line);
    else if (line.trim() !== '') fail(`profiles block: stray line before the first profile: ${line}`);
  }
  const declared = vocab.profiles ?? [];
  if (chunks.length !== declared.length) {
    fail(`profiles: ${chunks.length} in the spec, ${declared.length} in vocabulary.yaml`);
  }
  for (let i = 0; i < Math.max(chunks.length, declared.length); i++) {
    const md = chunks[i];
    const yml = declared[i];
    if (!md) {
      fail(`profiles: vocabulary.yaml declares \`${yml.name}\`; the spec does not print it`);
      continue;
    }
    if (!yml) {
      fail(`profiles: the spec prints \`${md.name}\`; vocabulary.yaml does not declare it`);
      continue;
    }
    if (md.name !== yml.name) {
      fail(`profiles: position ${i + 1} is \`${md.name}\` in the spec, \`${yml.name}\` in vocabulary.yaml`);
      continue;
    }
    const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
    if (lower(unstyle(md.description)) !== lower(String(yml.description).replace(/\s+/g, ' ').trim())) {
      fail(
        `profile \`${yml.name}\`: description drifted\n    spec: ${md.description}\n    yaml: ${yml.description}`,
      );
    }
    compareFacts(table(md.body.join('\n'), `profile \`${yml.name}\``), yml.facts, `profile \`${yml.name}\``, 'Name');
  }
}

// --- 8.1 core anchors -------------------------------------------------------

const anchorsBlock = block('anchors');
if (anchorsBlock === null) {
  fail('no <!-- oar:table anchors --> block in the specification');
} else {
  const md = table(anchorsBlock, 'anchors table');
  const declared = vocab.anchors ?? [];
  if (md) {
    const want = ['Core anchor', 'Lifecycle moment'];
    if (md.header.join(' | ') !== want.join(' | ')) {
      fail(`anchors table: header is "${md.header.join(' | ')}", expected "${want.join(' | ')}"`);
    }
    if (md.rows.length !== declared.length) {
      fail(`anchors table: ${md.rows.length} rows in the spec, ${declared.length} in vocabulary.yaml`);
    }
    for (let i = 0; i < Math.max(md.rows.length, declared.length); i++) {
      const row = md.rows[i];
      const anchor = declared[i];
      if (!row) {
        fail(`anchors table: vocabulary.yaml has \`${anchor.name}\` at row ${i + 1}; the table ends`);
        continue;
      }
      if (!anchor) {
        fail(`anchors table: the spec has \`${row[0]}\` at row ${i + 1}; vocabulary.yaml ends`);
        continue;
      }
      if (row.length !== 2) {
        fail(`anchors table: row ${i + 1} has ${row.length} cells, expected 2`);
        continue;
      }
      const [name, moment] = row.map(unstyle);
      if (name !== anchor.name) fail(`anchors table row ${i + 1}: "${name}" != "${anchor.name}"`);
      const wanted = String(anchor.moment).replace(/\s+/g, ' ').trim();
      const got = moment.replace(/\s+/g, ' ').trim();
      if (got !== wanted) {
        fail(`anchor \`${anchor.name}\`: moment drifted\n    spec: ${got}\n    yaml: ${wanted}`);
      }
    }
  }
}

// --- report -----------------------------------------------------------------

if (errors.length > 0) {
  for (const err of errors) console.error(`error: ${err}`);
  console.error(
    `\n${errors.length} vocabulary mismatch(es) between spec/oar/${VERSION}/vocabulary.yaml\n` +
      `and the tables in spec/oar/${VERSION}/open-agent-rules.md.\n` +
      'vocabulary.yaml is the source of truth: fix the table to match it, or change both together.',
  );
  process.exit(1);
}

const factCount =
  vocab.core.facts.length + (vocab.profiles ?? []).reduce((n, p) => n + p.facts.length, 0);
console.log(
  `ok: ${factCount} facts across the core tier and ${(vocab.profiles ?? []).length} profiles, ` +
    `${(vocab.anchors ?? []).length} core anchors — spec tables match vocabulary.yaml`,
);
