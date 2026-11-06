#!/usr/bin/env node
// Run the published Open Agent Rules conformance corpus against this
// implementation. Usage: oar-conformance <corpus-dir>
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'dist', 'src', 'runner.js');
if (!existsSync(built)) {
  console.error('error: build first — npm run build');
  process.exit(2);
}
const { runCorpus } = await import(built);

const dir = resolve(process.argv[2] ?? join(here, '..', '..', '..', 'spec', 'oar', '1.0', 'conformance'));
const report = await runCorpus(dir);
for (const r of report.results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}${r.pass ? '' : `\n        ${r.detail}`}`);
}
console.log(`\n${report.passed}/${report.results.length} fixtures passed, ` +
  `${report.clauses.length} clauses exercised`);
process.exit(report.failed === 0 ? 0 : 1);
