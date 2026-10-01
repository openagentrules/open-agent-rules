#!/usr/bin/env node
// Publish gate for site/ — the tree Cloudflare Pages serves. Catches the
// failures that are invisible in a diff but break adopters:
//
//   1. malformed JSON in a published schema or fixture
//   2. an internal link or sitemap entry pointing at a file that is not there
//   3. an _headers pattern that matches nothing — a renamed directory silently
//      dropping the CORS grant that third-party validators need to follow $ref
//
// Usage: node scripts/check-site.mjs [root]
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(REPO, process.argv[2] ?? 'site');
const ORIGIN = 'https://openagentrules.org';

const errors = [];
const fail = (msg) => errors.push(msg);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!existsSync(ROOT)) {
  console.error(`error: ${relative(REPO, ROOT)} does not exist`);
  process.exit(1);
}

const files = walk(ROOT);
const urlPath = (file) => '/' + relative(ROOT, file).split(/[\\/]/).join('/');

// 1. Every published JSON document parses. -----------------------------------
let jsonCount = 0;
for (const file of files.filter((f) => extname(f) === '.json')) {
  jsonCount++;
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`invalid JSON: ${relative(REPO, file)} — ${err.message}`);
  }
}

// 2. Internal links resolve, using the same order the server and Pages use. ---
// Returns the file the URL path serves, or null.
function target(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const abs = resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + '/')) return null;
  return (
    [abs, join(abs, 'index.html'), `${abs}.html`].find(
      (c) => existsSync(c) && statSync(c).isFile(),
    ) ?? null
  );
}

// Heading anchors are part of the published contract: RATIONALE.md and other
// specifications deep-link to `#3-anchors-and-selection`. A renamed heading
// that silently stops resolving is exactly as broken as a missing file.
const anchors = new Map();
function idsIn(file) {
  if (!anchors.has(file)) {
    const html = readFileSync(file, 'utf8');
    anchors.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return anchors.get(file);
}

let linkCount = 0;
let fragmentCount = 0;
for (const file of files.filter((f) => extname(f) === '.html')) {
  const html = readFileSync(file, 'utf8');
  const from = urlPath(file);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|mailto:|data:)/i.test(href) && !href.startsWith(ORIGIN)) continue;
    const raw = href.startsWith(ORIGIN) ? href.slice(ORIGIN.length) || '/' : href;
    const [beforeHash, fragment] = raw.split('#');
    const pathname = beforeHash.split('?')[0];
    let dest;
    if (!pathname) {
      dest = file; // same-page fragment
    } else {
      const abs = pathname.startsWith('/') ? pathname : posix.resolve(posix.dirname(from), pathname);
      linkCount++;
      dest = target(abs);
      if (!dest) {
        fail(`broken link: ${relative(REPO, file)} → ${href}`);
        continue;
      }
    }
    if (fragment && extname(dest) === '.html') {
      fragmentCount++;
      if (!idsIn(dest).has(decodeURIComponent(fragment))) {
        fail(`broken anchor: ${relative(REPO, file)} → ${href} (no id="${fragment}" in ${relative(ROOT, dest)})`);
      }
    }
  }
}

// 3. Every sitemap entry resolves, and every published page is in the sitemap. -
const sitemap = join(ROOT, 'sitemap.xml');
if (!existsSync(sitemap)) {
  fail('missing sitemap.xml');
} else {
  const locs = [...readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (locs.length === 0) fail('sitemap.xml lists no URLs');
  for (const loc of locs) {
    if (!loc.startsWith(ORIGIN)) {
      fail(`sitemap entry is not on ${ORIGIN}: ${loc}`);
      continue;
    }
    const pathname = loc.slice(ORIGIN.length) || '/';
    if (!target(pathname)) fail(`sitemap entry does not resolve: ${loc}`);
  }
  const listed = new Set(locs.map((l) => l.slice(ORIGIN.length) || '/'));
  for (const file of files.filter((f) => extname(f) === '.html')) {
    const path = urlPath(file);
    const canonical = path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path;
    // The 404 page is deliberately unlisted: a sitemap entry would invite
    // crawlers to index the not-found page as content.
    if (canonical === '/404.html') continue;
    if (!listed.has(canonical)) fail(`page not listed in sitemap.xml: ${canonical}`);
  }
}

// 4. Every _headers pattern matches at least one published file. --------------
const headersFile = join(ROOT, '_headers');
if (!existsSync(headersFile)) {
  fail('missing _headers — published schemas would lose their media type and CORS grant');
} else {
  const patterns = readFileSync(headersFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#') && !/^\s/.test(line))
    .map((line) => line.trim());
  if (patterns.length === 0) fail('_headers declares no path patterns');
  const paths = files.map(urlPath);
  for (const pattern of patterns) {
    const re = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+') +
        '$',
    );
    if (!paths.some((p) => re.test(p))) fail(`_headers pattern matches no file: ${pattern}`);
  }
}

// ----------------------------------------------------------------------------
if (errors.length > 0) {
  for (const err of errors) console.error(`error: ${err}`);
  console.error(`\n${errors.length} problem(s) in ${relative(REPO, ROOT)}`);
  process.exit(1);
}

console.log(
  `ok: ${files.length} files — ${jsonCount} JSON documents parse, ` +
    `${linkCount} internal links and ${fragmentCount} anchors resolve, ` +
    'sitemap and _headers agree with the tree',
);
