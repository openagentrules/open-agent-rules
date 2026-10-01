#!/usr/bin/env node
// Run the published Open Agent Rules conformance corpus against this
// implementation, or lint a rule pack against a capability document.
//
//   oar-conformance [--json] [<corpus-dir> | <corpus-url>]
//   oar-conformance [--json] --capability <capability-file> <pack-dir>
//
// A corpus URL names the published manifest (…/conformance/manifest.json) or
// its directory; the fixtures the manifest lists are fetched beside it into a
// temporary directory and run from there. A local directory never fetches.
//
// [OAR-CONF-20] Each fixture is evaluated against the capability document it
// declares; one this engine cannot adopt is reported as skipped.
// [OAR-CONF-24] A skipped fixture is not a passed fixture, and is reported
// distinctly from a pass and from a failure.

import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'dist', 'src', 'index.js');
if (!existsSync(built)) {
  console.error('error: build first — npm run build');
  process.exit(2);
}
const oar = await import(built);

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const rest = argv.filter((a) => a !== '--json');

const capabilityAt = rest.indexOf('--capability');
if (capabilityAt !== -1) {
  const capabilityFile = rest[capabilityAt + 1];
  const packDir = rest[capabilityAt + 2];
  if (!capabilityFile || !packDir) {
    console.error('usage: oar-conformance --capability <capability-file> <pack-dir>');
    process.exit(2);
  }
  const env = await oar.readCapabilityFile(resolve(capabilityFile));
  const report = await oar.loadPack(resolve(packDir), env);
  if (json) {
    writeFileSync(1,
      JSON.stringify({
        documents: report.documents,
        loaded: report.loaded,
        errors: report.errors,
        warnings: report.warnings,
      }) + '\n',
    );
    process.exit(report.errors.length === 0 ? 0 : 1);
  }
  for (const w of report.warnings) console.log(`warn  ${w}`);
  for (const e of report.errors) console.log(`FAIL  ${e}`);
  console.log(`\n${report.loaded}/${report.documents} rule documents loaded`);
  process.exit(report.errors.length === 0 ? 0 : 1);
}

async function fetchCorpus(target) {
  const manifestUrl = target.endsWith('.json') ? target : `${target.replace(/\/+$/, '')}/manifest.json`;
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  const get = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
    return res.text();
  };
  const manifestText = await get(manifestUrl);
  const manifest = JSON.parse(manifestText);
  const dir = await mkdtemp(join(tmpdir(), 'oar-corpus-'));
  await writeFile(join(dir, 'manifest.json'), manifestText);
  for (const entry of manifest.fixtures ?? []) {
    await writeFile(join(dir, entry.file), await get(base + entry.file));
  }
  console.error(`fetched ${manifest.fixtures?.length ?? 0} fixtures from ${base} into ${dir}`);
  return dir;
}

const target = rest[0];
const dir = /^https?:\/\//.test(target ?? '')
  ? await fetchCorpus(target)
  : resolve(target ?? join(here, '..', '..', '..', 'spec', 'oar', '1.0', 'conformance'));
const report = await oar.runCorpus(dir);

if (json) {
  // A single JSON object and nothing else, so stdout parses. Consumed by the
  // differential gate that diffs this engine against the Rust gateway.
  // Flush the complete report before exiting, including when stdout is a pipe.
  writeFileSync(1, JSON.stringify(report) + '\n');
  process.exit(report.failed === 0 ? 0 : 1);
}

for (const r of report.results) {
  const label = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  console.log(`${label}  ${r.id}${r.pass && !r.skipped ? '' : `\n        ${r.detail ?? ''}`}`);
}
console.log(
  `\n${report.passed}/${report.results.length} fixtures passed, ` +
    `${report.failed} failed, ${report.skipped} skipped, ` +
    `${report.clauses.length} clauses exercised`,
);
process.exit(report.failed === 0 ? 0 : 1);
