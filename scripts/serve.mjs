#!/usr/bin/env node
// Zero-dependency static server for site/ — the same tree Cloudflare Pages
// publishes. It applies site/_headers, so the immutable cache policy and the
// CORS grant under /spec/ behave locally exactly as they do in production:
// a third-party validator following a $ref against the dev server sees the
// same Content-Type and Access-Control-Allow-Origin it will see on the wire.
//
// Usage: node scripts/serve.mjs [--root site] [--port 8788] [--host 127.0.0.1]
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Accepts both `--port 8788` and `--port=8788`.
function arg(name, fallback) {
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = resolve(REPO, arg('root', 'site'));
const PORT = Number(arg('port', process.env.PORT ?? 8788));
const HOST = arg('host', process.env.HOST ?? '127.0.0.1');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

// --- _headers ----------------------------------------------------------------
// Cloudflare Pages format: an unindented line is a path pattern, the indented
// lines under it are `Name: value` headers. `*` matches within a path segment,
// `:placeholder` matches one segment. Comments start with `#`.
function loadHeaderRules(root) {
  const file = join(root, '_headers');
  if (!existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), test: patternToRegExp(line.trim()), headers: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    current.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return rules;
}

function patternToRegExp(pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+');
  return new RegExp(`^${source}$`);
}

function headersFor(rules, pathname) {
  const out = [];
  for (const rule of rules) if (rule.test.test(pathname)) out.push(...rule.headers);
  return out;
}

// --- request handling --------------------------------------------------------
// Resolution order mirrors Pages: exact file, then directory index, then the
// implicit .html extension.
function resolveFile(root, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) return null; // no escaping the root
  for (const candidate of [target, join(target, 'index.html'), `${target}.html`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const rules = loadHeaderRules(ROOT);

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? HOST}`);
  const file = resolveFile(ROOT, pathname);
  const status = file ? 200 : 404;
  console.log(`${status}  ${req.method} ${pathname}`);

  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 — no file for ${pathname}\n`);
    return;
  }

  const headers = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    // Dev only: never let the browser cache what you are actively editing.
    // _headers may override this below, which is the point — see the CORS and
    // immutability rules it declares for /spec/.
    'Cache-Control': 'no-store',
  };
  for (const [name, value] of headersFor(rules, pathname)) headers[name] = value;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`error: port ${PORT} is already in use — free it or pass --port`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT}`);
  console.log(`→ http://${HOST}:${PORT}/`);
  console.log(`${rules.length} header rule(s) from _headers applied\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
