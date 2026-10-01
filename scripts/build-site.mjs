#!/usr/bin/env node
// Build site/ from spec/oar/. Everything except _headers is generated.
//
// Usage:
//   node scripts/build-site.mjs           write the tree
//   node scripts/build-site.mjs --check   fail if the committed tree is stale
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, escapeHtml } from './markdown.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const VERSION = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '1.0';

const SPEC_ROOT = join(REPO, 'spec', 'oar');
const SITE = join(REPO, 'site');
const ORIGIN = 'https://openagentrules.org';
const BASE = `${ORIGIN}/spec/${VERSION}/`;

// A published version directory is immutable, so the site carries every
// published version alongside the one being drafted — rebuilding for a new
// version must never delete a tree adopters' $ref chains still resolve into.
const PUBLISHED = (() => {
  const doc = JSON.parse(readFileSync(join(REPO, 'spec', 'published.json'), 'utf8'));
  return (doc.published ?? []).map((e) => (typeof e === 'string' ? e : e.version));
})();
const VERSIONS = [...new Set([...PUBLISHED, VERSION])].sort();

// Hand-maintained, never generated. `.DS_Store` is not content and is ignored
// wherever it appears rather than being reported as a stale artifact.
const UNMANAGED = new Set(['_headers']);
const unmanaged = (rel) => UNMANAGED.has(rel) || rel.split('/').pop() === '.DS_Store';

// --- page shell -------------------------------------------------------------

const CSS = `:root {
  --fg:#191512; --bg:#fbf8f4; --muted:#6a6058; --rule:#e2d9cd; --link:#8a4b1f;
  --code:#f2ece3; --panel:#f7f2ea; --zebra:#f6f1e8; --accent:#b1592a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg:#ece5dc; --bg:#17140f; --muted:#a0968a; --rule:#332c23; --link:#e0a170;
    --code:#221d16; --panel:#1d1913; --zebra:#1c1811; --accent:#e0a170;
  }
}
* { box-sizing: border-box; }
/* Keyboard users get past the sticky header without tabbing through it. */
.skip { position:absolute; left:-999px; top:0; z-index:30; background:var(--panel);
  color:var(--fg); padding:.5rem .9rem; border-radius:0 0 6px 0; font:600 14px/1 ui-sans-serif, system-ui, sans-serif; }
.skip:focus { left:0; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 ui-serif, Georgia, serif;
  -webkit-text-size-adjust:100%; text-rendering:optimizeLegibility; }
::selection { background:var(--code); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:2px; }

/* Header. Sticky, so the section you are in is never more than a glance away,
   and so the reading-progress bar on its lower edge stays on screen. */
header { position:sticky; top:0; z-index:20; display:flex; flex-wrap:wrap; gap:.75rem 1.5rem;
  align-items:center; padding:.85rem 1.5rem; border-bottom:1px solid var(--rule);
  background:var(--bg); background:color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter:saturate(1.6) blur(10px); -webkit-backdrop-filter:saturate(1.6) blur(10px); }
.brand { display:inline-flex; align-items:center; gap:.5rem; font-weight:700;
  text-decoration:none; color:var(--fg); letter-spacing:-0.01em; }
.brand .mark { color:var(--accent); flex:none; }
nav { display:flex; flex-wrap:wrap; gap:1rem; font:600 14px/1 ui-sans-serif, system-ui, sans-serif; }
nav a { color:var(--muted); text-decoration:none; padding:.15rem 0; border-bottom:1.5px solid transparent; }
nav a:hover { color:var(--fg); }
nav a.here { color:var(--link); border-bottom-color:var(--accent); }
.progress { position:absolute; left:0; bottom:-1px; height:2px; width:0; background:var(--accent); }
/* On a phone the five nav items wrap to three rows, and a sticky header three
   rows deep eats a quarter of the screen. One horizontally scrolling row instead. */
@media (max-width:46rem) {
  header { flex-wrap:nowrap; gap:.9rem; padding:.6rem .9rem; }
  .brand { flex:none; }
  nav { flex-wrap:nowrap; overflow-x:auto; gap:1rem; font-size:13px;
    scrollbar-width:none; -ms-overflow-style:none; }
  nav::-webkit-scrollbar { display:none; }
}

/* Two columns on a wide viewport: contents rail, then the document.
   15 + 3.5 + 46 = 64.5rem, so the pair still clears the 70rem breakpoint. */
main { display:grid; gap:0 3.5rem; justify-content:center;
  grid-template-columns:minmax(0,46rem); padding:2rem 1.5rem 5rem; }
article { min-width:0; }
@media (min-width:70rem) {
  main.has-toc { grid-template-columns:15rem minmax(0,46rem); }
}

/* Contents. A disclosure on a narrow viewport, a sticky rail on a wide one.
   It ships open so a reader without scripting still gets the whole list. */
.toc { font:400 13px/1.5 ui-sans-serif, system-ui, sans-serif; margin:0 0 2.5rem;
  border:1px solid var(--rule); border-radius:8px; background:var(--panel); padding:.35rem .6rem; }
.toc > summary { font:600 11px/1.6 ui-sans-serif, system-ui, sans-serif; letter-spacing:.08em;
  text-transform:uppercase; color:var(--muted); cursor:pointer; padding:.4rem .25rem; }
.toc ol { list-style:none; margin:.2rem 0 .4rem; padding:0; }
.toc a { display:grid; grid-template-columns:2.4rem 1fr; align-items:baseline;
  color:var(--muted); text-decoration:none; padding:.25rem .4rem; border-radius:4px;
  box-shadow:inset 2px 0 0 transparent; }
.toc a:hover { color:var(--fg); background:var(--code); }
.toc a[aria-current] { color:var(--fg); background:var(--code); box-shadow:inset 2px 0 0 var(--accent); }
.toc .n { font:600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; opacity:.65; }
.toc .sub { padding-left:1rem; font-size:12.5px; }
.toc .sub .n { font-size:10.5px; }
@media (min-width:70rem) {
  .toc { position:sticky; top:4.5rem; max-height:calc(100vh - 7rem); overflow-y:auto; overscroll-behavior:contain;
    border:0; background:none; border-radius:0; padding:0 .5rem 0 0; margin:.4rem 0 0;
    scrollbar-width:thin; scrollbar-color:var(--rule) transparent; }
  .toc > summary { list-style:none; padding:0 0 .5rem .4rem; }
  .toc > summary::-webkit-details-marker { display:none; }
}

/* Document. */
h1,h2,h3,h4 { line-height:1.25; font-family:ui-sans-serif, system-ui, sans-serif;
  scroll-margin-top:5rem; letter-spacing:-0.011em; }
h1 { font-size:2rem; margin:0 0 1.1rem; }
h2 { font-size:1.35rem; margin:3rem 0 .75rem; padding-top:.9rem; border-top:1px solid var(--rule); }
/* The source's own horizontal rule already divides these; two lines is one too many. */
hr + h2 { border-top:0; padding-top:0; margin-top:0; }
h3 { font-size:1.08rem; margin:1.9rem 0 .5rem; }
h4 { font-size:1rem; margin:1.3rem 0 .5rem; color:var(--muted); }
a { color:var(--link); text-underline-offset:2px; }
/* A clause is quoted by its anchor far more often than it is read in order, so
   every heading offers its own link rather than making a reader hunt for one. */
.anchor { float:right; margin-left:.5rem; color:var(--muted); text-decoration:none;
  font:400 .8em/1 ui-monospace, SFMono-Regular, Menlo, monospace; opacity:0; transition:opacity .12s; }
h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, .anchor:focus-visible { opacity:.7; }
p.lede { font-size:1.2rem; line-height:1.6; margin-top:0; }
p.urls { color:var(--muted); font-size:.95rem; }
ul.jump { list-style:none; padding:0; margin:1.5rem 0 2.75rem; display:grid; gap:.6rem;
  grid-template-columns:repeat(auto-fit, minmax(17rem, 1fr)); }
ul.jump a { display:block; padding:.7rem .85rem; border:1px solid var(--rule); border-radius:8px;
  background:var(--panel); text-decoration:none; font:600 14px/1.4 ui-sans-serif, system-ui, sans-serif; }
ul.jump a:hover { border-color:var(--accent); background:var(--code); }
code { background:var(--code); padding:.1em .35em; border-radius:3px;
  font:0.88em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-word; }
pre { background:var(--code); border:1px solid var(--rule); padding:1rem; border-radius:6px;
  overflow-x:auto; font-size:.92rem; }
pre code { background:none; padding:0; }
code.url { user-select:all; }
table { border-collapse:collapse; width:100%; margin:1rem 0; font-size:.94rem; }
th, td { text-align:left; vertical-align:top; padding:.5rem .6rem; border-bottom:1px solid var(--rule); }
/* Not sticky: every table is wrapped in a horizontal scroller, which is the
   scrollport a sticky header would resolve against — it would pin itself over
   the first rows rather than to the top of the page. */
th { font:600 13px/1.4 ui-sans-serif, system-ui, sans-serif; color:var(--muted); }
tbody tr:nth-child(even) { background:var(--zebra); }
tr[hidden] { display:none; }
.scroll, .table-scroll { overflow-x:auto; }
/* Filter for the fixture index. Revealed by script — without it, it does nothing. */
.filter { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center;
  font:400 14px/1.4 ui-sans-serif, system-ui, sans-serif; color:var(--muted); margin:1rem 0 0; }
.filter input { font:inherit; color:var(--fg); background:var(--bg); padding:.4rem .6rem;
  border:1px solid var(--rule); border-radius:6px; min-width:16rem; }
blockquote { margin:1.25rem 0; padding:.15rem 0 .15rem 1.1rem; border-left:3px solid var(--accent);
  color:var(--muted); font-style:italic; }
hr { border:0; border-top:1px solid var(--rule); margin:2.5rem 0; }
footer { border-top:1px solid var(--rule); padding:2rem 1.5rem 3rem; color:var(--muted); font-size:.85rem; }
footer > * { max-width:46rem; margin:0 auto; }
footer nav { gap:1.25rem; margin-bottom:.9rem; font-size:13px; }

@media print {
  header, .toc, .anchor, .filter { display:none; }
  main { display:block; padding:0; }
  a { color:inherit; }
}`;

// Inlined rather than served as an asset: five pages, no build step for the
// reader, and a page that can never be served against a stale cached script.
const JS = `(function () {
  var bar = document.querySelector('.progress');
  var toc = document.querySelector('.toc');
  var links = toc ? Array.prototype.slice.call(toc.querySelectorAll('a[href^="#"]')) : [];
  var heads = links.map(function (a) { return document.getElementById(decodeURIComponent(a.hash.slice(1))); });
  var wide = window.matchMedia('(min-width: 70rem)');

  // Open as a rail, closed as a disclosure — set once at load and again only
  // when the viewport crosses the breakpoint, so a reader's own toggle sticks.
  var fit = function () { if (toc) toc.open = wide.matches; };
  fit();
  if (wide.addEventListener) wide.addEventListener('change', fit);

  // Heading positions are measured once and re-measured only when the layout
  // can have moved, so scrolling reads no geometry and cannot thrash layout.
  var tops = [];
  var measure = function () {
    tops = heads.map(function (h) {
      return h ? h.getBoundingClientRect().top + window.scrollY : Infinity;
    });
  };

  var active = -1;
  var update = function () {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var y = window.scrollY;
    if (bar) bar.style.width = (max > 0 ? Math.min(1, y / max) * 100 : 0) + '%';
    if (!links.length) return;
    // The section you are in is the last heading whose top has passed the header.
    var i = -1;
    for (var k = 0; k < tops.length; k++) if (tops[k] <= y + 96) i = k;
    if (i === active) return;
    if (active >= 0) links[active].removeAttribute('aria-current');
    active = i;
    if (i < 0) return;
    var a = links[i];
    a.setAttribute('aria-current', 'true');
    // Keep the current entry in view when the rail is taller than the viewport.
    if (toc.scrollHeight > toc.clientHeight + 4) {
      var top = a.offsetTop - toc.clientHeight / 2;
      if (Math.abs(top - toc.scrollTop) > toc.clientHeight / 3) toc.scrollTop = top;
    }
  };

  var remeasure = function () { measure(); update(); };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', remeasure);
  addEventListener('load', remeasure);
  remeasure();

  // The fixture index is long enough that finding one clause by eye is work.
  var input = document.getElementById('fixture-filter');
  if (input) {
    var box = input.closest('.filter');
    var count = document.getElementById('fixture-count');
    var rows = Array.prototype.slice.call(document.querySelectorAll('#fixtures tbody tr'));
    var apply = function () {
      var q = input.value.trim().toLowerCase();
      var n = 0;
      for (var j = 0; j < rows.length; j++) {
        var hit = !q || rows[j].textContent.toLowerCase().indexOf(q) !== -1;
        rows[j].hidden = !hit;
        if (hit) n++;
      }
      count.textContent = n === rows.length ? n + ' fixtures' : n + ' of ' + rows.length + ' fixtures';
      remeasure();
    };
    box.hidden = false;
    input.addEventListener('input', apply);
    apply();
  }
})();`;

const NAV = [
  ['overview', '/', 'Overview'],
  ['spec', `/spec/${VERSION}/`, 'Specification'],
  ['schemas', `/spec/${VERSION}/schemas.html`, 'Schemas'],
  ['conformance', `/spec/${VERSION}/conformance.html`, 'Conformance'],
  ['examples', '/examples/portable-pack.html', 'Examples'],
];

// A bracket pair — the shape a clause identifier wears throughout the text.
const MARK =
  '<svg class="mark" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M6 2.5H3.2v11H6M10 2.5h2.8v11H10"/></svg>';

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E" +
  "%3Cpath d='M6 2.5H3.2v11H6M10 2.5h2.8v11H10' fill='none' stroke='%23b1592a' stroke-width='1.9' " +
  "stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

// --- contents ---------------------------------------------------------------
//
// Built from the rendered body rather than from the markdown, so the rail can
// never name a section the page does not have, and so pages assembled from more
// than one source (the conformance page, the example pack) are covered too.
const HEADING = /<(h2|h3) id="([^"]+)">([\s\S]*?)<\/\1>/g;
// Tags out, entities left alone. The result is already-escaped HTML text, so it
// is emitted as-is — escaping it again would print `&amp;` where a heading has
// an ampersand.
const text = (html) => html.replace(/<[^>]+>/g, '').trim();

function contents(body) {
  const items = [...body.matchAll(HEADING)].map(([, tag, id, inner]) => {
    const label = text(inner);
    // "5.1 Capability profiles" and "Appendix A — ..." carry their own numbering;
    // it goes in its own column so the titles line up down the rail.
    const m = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/.exec(label) ?? /^Appendix\s+([A-Z])\s*[—-]\s*(.*)$/.exec(label);
    return { tag, id, n: m ? m[1] : '', label: m ? m[2] : label };
  });
  // Below a handful of entries the rail costs more attention than it saves.
  if (items.length < 3) return '';
  const list = items
    .map(
      (it) =>
        `<li${it.tag === 'h3' ? ' class="sub"' : ''}>` +
        `<a href="#${it.id}"><span class="n">${it.n}</span>` +
        `<span>${it.label}</span></a></li>`,
    )
    .join('\n');
  return `<details class="toc" open>
<summary>Contents</summary>
<ol>
${list}
</ol>
</details>`;
}

// Every heading is a link to itself.
const linkHeadings = (body) =>
  body.replace(
    /<(h2|h3|h4) id="([^"]+)">([\s\S]*?)<\/\1>/g,
    (_, tag, id, inner) =>
      `<${tag} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Permalink">#</a></${tag}>`,
  );

// A page's canonical URL is its own: the pretty directory form where the file
// is an index.html, the file's own path otherwise. A site whose every page
// declared the homepage canonical would ask search engines to deindex the
// specification itself.
const canonicalFor = (path) =>
  path === 'index.html'
    ? `${ORIGIN}/`
    : path.endsWith('/index.html')
      ? `${ORIGIN}/${path.slice(0, -'index.html'.length)}`
      : `${ORIGIN}/${path}`;

function page({ title, here, body, path, description }) {
  const nav = NAV.map(
    ([key, href, label]) => `<a href="${href}"${key === here ? ' class="here"' : ''}>${label}</a>`,
  ).join('');
  const toc = contents(body);
  const canonical = canonicalFor(path);
  const desc =
    description ??
    'Open Agent Rules is a portable document format for what a host lets an agent do at a lifecycle moment. A rule names the moment, a condition over typed observations, and an effect. The same document produces the same decision on every conforming engine.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Open Agent Rules">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${FAVICON}">
<style>
${CSS}
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header><a class="brand" href="/">${MARK}Open Agent Rules</a><nav>${nav}</nav><div class="progress" aria-hidden="true"></div></header>
<main id="content"${toc ? ' class="has-toc"' : ''}>
${toc ? `${toc}\n` : ''}<article>
${linkHeadings(body)}
</article>
</main>
<footer>
<nav><a href="https://github.com/paintedwolf-ai/open-agent-rules">Repository</a><a href="/spec/governance.html">Governance</a><a href="/spec/rationale.html">Rationale</a><a href="/spec/licence.html">Licence</a><a href="/spec/patents.html">Patents</a></nav>
<p>Specification text CC BY 4.0. Schemas, corpus, and code Apache-2.0. A published patent
non-assertion covenant covers every implementation.
Anyone may implement this specification, for any purpose, without permission, notification, or fee.</p>
</footer>
<script>
${JS}
</script>
</body>
</html>
`;
}

// --- inputs -----------------------------------------------------------------

const read = (p) => readFileSync(p, 'utf8');
const bytes = (p) => readFileSync(p);

const rationaleMd = read(join(SPEC_ROOT, 'RATIONALE.md'));

// --- the generated tree -----------------------------------------------------

const files = new Map(); // site-relative path -> Buffer

const put = (path, content) =>
  files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));

// 1. Overview. ---------------------------------------------------------------
put(
  'index.html',
  page({
    title: 'Open Agent Rules — portable rules for what a host lets an agent do',
    here: 'overview',
    path: 'index.html',
    body: `<p class="lede">Open Agent Rules is a portable document format for what a host
lets an agent do at a lifecycle moment. A rule names the moment, a condition over
typed observations, and an effect. The same document produces the same decision on
every engine that provides the capabilities the document declares it needs.</p>
<p class="urls">Current version <strong>${VERSION}</strong> &middot;
canonical schema <code class="url">${BASE}oar.schema.json</code></p>
<ul class="jump">
  <li><a href="/spec/${VERSION}/">Read the specification</a></li>
  <li><a href="/spec/${VERSION}/schemas.html">Fetch the schemas</a></li>
  <li><a href="/spec/${VERSION}/conformance.html">Run the conformance corpus</a></li>
  <li><a href="/examples/portable-pack.html">A worked rule pack</a></li>
  <li><a href="/examples/moderation-pack.html">Converting a moderation policy</a></li>
  <li><a href="https://github.com/paintedwolf-ai/open-agent-rules">Repository</a></li>
</ul>
${renderMarkdown(rationaleMd)}`,
  }),
);

// The 404 page. Cloudflare Pages serves 404.html with a real 404 status; without
// it, every mistyped $ref or fixture URL soft-200s the homepage — the exact
// silent failure the rest of this pipeline exists to prevent.
put(
  '404.html',
  page({
    title: 'Not found — Open Agent Rules',
    here: 'overview',
    path: '404.html',
    description: 'The page or file you requested does not exist on openagentrules.org.',
    body: `<h1>Not found</h1>
<p>Nothing is published at this URL. Published version directories are immutable, so a URL
that once resolved still does — this one never has.</p>
<ul class="jump">
  <li><a href="/">Overview</a></li>
  <li><a href="/spec/${VERSION}/">The specification</a></li>
  <li><a href="/spec/${VERSION}/conformance.html">The conformance corpus</a></li>
</ul>`,
  }),
);

// Redirect table, generated so the latest alias tracks the current version.
// /spec/latest/ is a stable spelling for "the current version" (the W3C
// latest-version convention); the dated form is the immutable citation.
put(
  '_redirects',
  `/spec/latest/* /spec/${VERSION}/:splat 302
/spec/latest /spec/${VERSION}/ 302
/spec /spec/${VERSION}/ 302
/examples /examples/portable-pack.html 302
`,
);

// 2–5. Per-version trees: the rendered specification, its companion sources,
// the schemas, and the conformance corpus. Every published version is built
// alongside the current one, so publishing a new version can never delete the
// tree an adopter's $ref chain still resolves into.
function buildSpecTree(v) {
  const specDir = join(SPEC_ROOT, v);
  const base = `${ORIGIN}/spec/${v}/`;
  const specMd = read(join(specDir, 'open-agent-rules.md'));

  const schemaNames = readdirSync(join(specDir, 'schemas'))
    .filter((f) => f.endsWith('.json'))
    .sort();

  const corpusDir = join(specDir, 'conformance');
  const corpusNames = existsSync(corpusDir)
    ? readdirSync(corpusDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];

  if (corpusNames.length === 0) {
    console.error(`error: spec/oar/${v}/conformance/ contains no fixtures.`);
    console.error('The published site serves the corpus, and site/_headers grants CORS to');
    console.error(`/spec/*/conformance/* — with an empty corpus that pattern matches no file`);
    console.error('and `task site:check` fails. Land the conformance corpus first.');
    process.exit(1);
  }

  put(
    `spec/${v}/index.html`,
    page({
      title: `Open Agent Rules ${v}`,
      here: 'spec',
      path: `spec/${v}/index.html`,
      description: `The Open Agent Rules ${v} specification: document model, evaluation, facts and conditions, capability profiles, transforms, and the conformance runner algorithm.`,
      body: `${renderMarkdown(specMd)}
<hr>
<p>This page is rendered from <a href="/spec/${v}/open-agent-rules.md">open-agent-rules.md</a>, the hand-authored source. The vocabulary printed in sections 5.3, 5.4 and 8.1 is also published as <a href="/spec/${v}/vocabulary.yaml">vocabulary.yaml</a>. See also <a href="/spec/${v}/extensions.html">Extensions</a>, <a href="/spec/rationale.html">Rationale</a> and <a href="/spec/governance.html">Governance</a>.</p>`,
    }),
  );

  // Publish source companions and rendered pages.
  for (const name of ['open-agent-rules.md', 'vocabulary.yaml', 'EXTENSIONS.md', 'clause-index.json', 'release-manifest.json', 'LICENSE']) {
    const path = join(specDir, name);
    if (existsSync(path)) put(`spec/${v}/${name}`, bytes(path));
  }
  for (const [name, slug, title] of [
    ['EXTENSIONS.md', 'extensions', `Extensions — Open Agent Rules ${v}`],
  ]) {
    const path = join(specDir, name);
    if (!existsSync(path)) continue;
    put(
      `spec/${v}/${slug}.html`,
      page({
        title,
        here: 'spec',
        path: `spec/${v}/${slug}.html`,
        description: `${title.split(' — ')[0]} notes for Open Agent Rules ${v}.`,
        body: `${renderMarkdown(read(path))}
<hr>
<p>Rendered from <a href="/spec/${v}/${name}">${name}</a>.</p>`,
      }),
    );
  }

  // Schemas, verbatim, plus an index.
  const schemaRows = [];
  for (const name of schemaNames) {
    const raw = bytes(join(specDir, 'schemas', name));
    put(`spec/${v}/${name}`, raw);
    const doc = JSON.parse(raw.toString('utf8'));
    // The first sentence of the description is the schema's role; the rest is
    // clause citation, which belongs in the specification, not in a table cell.
    const role = String(doc.description ?? '').split(/(?<=\.)\s/)[0];
    schemaRows.push(
      `<tr><td><code>${escapeHtml(name)}</code></td>` +
        `<td><code class="url">${base}${escapeHtml(name)}</code></td>` +
        `<td>${escapeHtml(doc.title ?? '')} — ${escapeHtml(role)}</td></tr>`,
    );
  }

  put(
    `spec/${v}/schemas.html`,
    page({
      title: `Schemas — Open Agent Rules ${v}`,
      here: 'schemas',
      path: `spec/${v}/schemas.html`,
      description: `The published JSON Schemas for Open Agent Rules ${v}: rule documents, capability documents, operator configuration, and conformance fixtures, served with CORS for $ref resolution.`,
      body: `<h1>Schemas</h1>
<p>Every schema is served as <code>application/schema+json</code> with <code>Access-Control-Allow-Origin: *</code>, so a validator can follow the whole <code>$ref</code> chain from a URL alone. Inter-schema references are relative filenames, so the same set also resolves from a local directory with no network. A published version path never changes.</p>
<div class="scroll">
<table>
<thead><tr><th>Schema</th><th>Canonical URL</th><th>Role</th></tr></thead>
<tbody>
${schemaRows.join('\n')}
</tbody>
</table>
</div>
<p>The schemas check shape, not meaning. A document that validates can still be rejected at load — for a capability the host does not provide, an unresolvable anchor, or a condition that does not type-check. Those rejections are specified in <a href="/spec/${v}/#10-conformance">section 10</a>, and the corpus is what proves an engine performs them.</p>`,
    }),
  );

  // The conformance corpus, verbatim, plus an index.
  for (const name of corpusNames) {
    put(`spec/${v}/conformance/${name}`, bytes(join(corpusDir, name)));
  }

  const manifestPath = join(corpusDir, 'manifest.json');
  let fixtures = [];
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(read(manifestPath));
    fixtures = (manifest.fixtures ?? []).map((f) => ({
      id: f.id,
      file: f.file ?? `${f.id}.json`,
      title: f.title ?? '',
      covers: f.covers ?? [],
      baseline: f.baseline === true,
    }));
  } else {
    for (const name of corpusNames) {
      if (name === 'manifest.json' || name === 'exempt.json') continue;
      const doc = JSON.parse(read(join(corpusDir, name)));
      fixtures.push({
        id: doc.id ?? name.replace(/\.json$/, ''),
        file: name,
        title: doc.title ?? '',
        covers: doc.covers ?? [],
        baseline: false,
      });
    }
  }
  fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const baselineCount = fixtures.filter((f) => f.baseline).length;

  // The runner algorithm is quoted from the specification rather than restated,
  // so the page cannot drift from the clauses it advertises.
  function section(pattern) {
    const lines = specMd.split('\n');
    const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && pattern.test(l));
    if (start === -1) return '';
    const level = /^(#+)/.exec(lines[start])[1].length;
    let end = start + 1;
    while (end < lines.length && !new RegExp(`^#{1,${level}}\\s`).test(lines[end])) end++;
    return lines.slice(start + 1, end).join('\n');
  }

  const fixtureRows = fixtures
    .map(
      (f) =>
        `<tr><td><a href="/spec/${v}/conformance/${escapeHtml(f.file)}"><code>${escapeHtml(f.id)}</code></a></td>` +
        `<td><code>${escapeHtml(f.covers.join(', '))}</code></td>` +
        `<td>${escapeHtml(f.title)}${f.baseline ? ' <em>(baseline)</em>' : ''}</td></tr>`,
    )
    .join('\n');

  put(
    `spec/${v}/conformance.html`,
    page({
      title: `Conformance — Open Agent Rules ${v}`,
      here: 'conformance',
      path: `spec/${v}/conformance.html`,
      description: `The Open Agent Rules ${v} conformance corpus: ${fixtures.length} language-neutral JSON fixtures, each citing the clauses it exercises, with a machine-readable manifest.`,
      body: `<h1>Conformance</h1>
<h2 id="run-the-corpus-against-your-implementation">Run the corpus against your implementation</h2>
<p>Fetch the index, fetch each fixture it names, and run each one: load the fixture's <code>rules</code> against the host described by <code>input.capability</code>, apply the <code>input</code>, and compare against <code>expected</code>. An implementation claiming conformance passes every fixture whose declared capability set it can adopt, and reports the ones it skipped. A skipped fixture is not a passed fixture, and the ${baselineCount} fixtures the manifest marks <em>baseline</em> may not be skipped at all — their declared capability is one nothing conforming lacks.</p>
<pre><code>curl ${base}conformance/manifest.json</code></pre>
<h2 id="the-runner-algorithm">The runner algorithm</h2>
${renderMarkdown(section(/runner algorithm/i))}
<h2 id="fixtures">Fixtures (${fixtures.length})</h2>
<p class="filter" hidden><label for="fixture-filter">Filter</label>
<input id="fixture-filter" type="search" autocomplete="off" placeholder="clause id, fixture name, or words">
<span id="fixture-count"></span></p>
<div class="scroll">
<table id="fixtures">
<thead><tr><th>Fixture</th><th>Covers</th><th>What it proves</th></tr></thead>
<tbody>
${fixtureRows}
</tbody>
</table>
</div>`,
    }),
  );
}

// Spec-root companion prose: raw beside rendered, once for all versions.
for (const name of ['LICENCE-SPEC.md', 'GOVERNANCE.md', 'RATIONALE.md', 'PATENTS.md']) {
  put(`spec/${name}`, bytes(join(SPEC_ROOT, name)));
}
for (const [name, slug, title, description] of [
  ['GOVERNANCE.md', 'governance', 'Governance — Open Agent Rules',
    'How the Open Agent Rules specification changes: the one-change rule, clause identifiers, versioning, the capability-profile lifecycle, and the extension registry.'],
  ['RATIONALE.md', 'rationale', 'Rationale — Open Agent Rules',
    'Why Open Agent Rules exists, why it is not Rego, Cedar, a callback API, or a policy-engine manifest, and the reasoning behind its main design choices.'],
  ['LICENCE-SPEC.md', 'licence', 'Licence — Open Agent Rules',
    'Licences for the Open Agent Rules specification prose (CC BY 4.0) and for the schemas, corpus, examples, and code (Apache-2.0), with the implementation grant.'],
  ['PATENTS.md', 'patents', 'Patents — Open Agent Rules',
    'Painted Wolf LLC’s irrevocable patent non-assertion covenant covering every implementation of the Open Agent Rules specification.'],
]) {
  put(
    `spec/${slug}.html`,
    page({
      title,
      here: 'spec',
      path: `spec/${slug}.html`,
      description,
      body: `${renderMarkdown(read(join(SPEC_ROOT, name)))}
<hr>
<p>Rendered from <a href="/spec/${name}">${name}</a>.</p>`,
    }),
  );
}

for (const v of VERSIONS) buildSpecTree(v);

// 6. The worked example pack. ------------------------------------------------
//
// The pack is published so a reader can see a whole rule set rather than
// fragments, and it is copied byte for byte — `--check` therefore fails the
// build if the pack changes and the site is not rebuilt, which is what stops a
// published example from rotting into something that no longer loads.
const PACKS = [
  {
    slug: 'portable-pack',
    title: 'A portable rule pack — Open Agent Rules',
    description:
      'A worked Open Agent Rules pack: ten rules exercising most of the format, the capability document they assume, and an operator configuration.',
  },
  {
    slug: 'moderation-pack',
    title: 'Converting a moderation policy — Open Agent Rules',
    description:
      'A hosted moderation policy of the kind the large model platforms ship, rewritten as Open Agent Rules — what maps directly and what does not.',
  },
];

const fileAnchor = (name) => `file-${name.replace(/\.yaml$/, '')}`;

for (const { slug, title, description } of PACKS) {
  const other = PACKS.find((p) => p.slug !== slug);
  const dir = join(REPO, 'examples', slug);
  const packReadme = read(join(dir, 'README.md'));
  const packFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  // A file in the directory that the pack's own index does not mention, or an
  // index entry with no file behind it, is exactly the drift this catches.
  const listed = new Set([...packReadme.matchAll(/\[`([^`]+\.yaml)`\]/g)].map((m) => m[1]));
  const packProblems = [
    ...packFiles.filter((f) => !listed.has(f)).map((f) => `examples/${slug}/${f} is not listed in the pack README`),
    ...[...listed]
      .filter((f) => !packFiles.includes(f))
      .map((f) => `the pack README lists examples/${slug}/${f}, which does not exist`),
  ];
  if (packProblems.length > 0) {
    for (const p of packProblems) console.error(`error: ${p}`);
    process.exit(1);
  }

  for (const name of packFiles) put(`examples/${slug}/${name}`, bytes(join(dir, name)));

  // The README is written for someone reading the repository. Point its relative
  // links at the published equivalents; anything it links that this does not
  // rewrite stays relative and is caught by the site link check.
  const packBody = packReadme
    .replace(/\]\((?:\.\.\/)+spec\/oar\/[0-9.]+\/open-agent-rules\.md\)/g, `](/spec/${VERSION}/)`)
    .replace(/\]\(([a-z0-9-]+\.yaml)\)/g, (_, name) => `](#${fileAnchor(name)})`);

  const packListings = packFiles
    .map(
      (name) =>
        `<h2 id="${fileAnchor(name)}"><code>${escapeHtml(name)}</code></h2>\n` +
        `<p><a href="/examples/${slug}/${escapeHtml(name)}">Raw file</a></p>\n` +
        `<pre><code class="language-yaml">${escapeHtml(read(join(dir, name)))}\n</code></pre>`,
    )
    .join('\n');

  put(
    `examples/${slug}.html`,
    page({
      title,
      here: 'examples',
      path: `examples/${slug}.html`,
      description,
      body: `${renderMarkdown(packBody)}
<hr>
<p>The other worked example: <a href="/examples/${other.slug}.html">${escapeHtml(other.title.split(' — ')[0])}</a>.</p>
${packListings}`,
    }),
  );
}

// 7. Crawl metadata. ---------------------------------------------------------
const pages = [...files.keys()]
  .filter((p) => p.endsWith('.html') && p !== '404.html')
  .map((p) => (p.endsWith('index.html') ? p.slice(0, -'index.html'.length) : p))
  .sort();

put(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${ORIGIN}/${p}</loc></url>`).join('\n')}
</urlset>
`,
);

put(
  'robots.txt',
  `User-agent: *
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`,
);

// --- write or verify --------------------------------------------------------

function committed() {
  const found = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = relative(SITE, full).split(/[\\/]/).join('/');
        if (!unmanaged(rel)) found.set(rel, bytes(full));
      }
    }
  };
  walk(SITE);
  return found;
}

if (CHECK) {
  const disk = committed();
  const problems = [];
  for (const [path, content] of files) {
    if (!disk.has(path)) problems.push(`missing from site/: ${path}`);
    else if (!disk.get(path).equals(content)) problems.push(`stale in site/: ${path}`);
  }
  for (const path of disk.keys()) {
    if (!files.has(path)) problems.push(`not generated, should be deleted: site/${path}`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`error: ${p}`);
    console.error(`\n${problems.length} file(s) in site/ do not match the specification tree.`);
    console.error('Run `task site:build` and commit the result.');
    process.exit(1);
  }
  console.log(`ok: site/ is current — ${files.size} generated files match spec/oar/${VERSION}/`);
} else {
  const staticHeaders = join(REPO, 'static', '_headers');
  if (existsSync(staticHeaders)) {
    mkdirSync(SITE, { recursive: true });
    writeFileSync(join(SITE, '_headers'), readFileSync(staticHeaders));
  }
  if (existsSync(join(SITE, 'spec'))) rmSync(join(SITE, 'spec'), { recursive: true });
  for (const [path, content] of files) {
    const full = join(SITE, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  // Remove anything left over from a previous build that this one no longer
  // produces — a renamed version directory must not linger on the CDN.
  for (const path of committed().keys()) {
    if (!files.has(path)) rmSync(join(SITE, path));
  }
  if (!existsSync(join(SITE, '_headers'))) {
    console.error('error: site/_headers is missing — published schemas would lose their media type and CORS grant');
    process.exit(1);
  }
  console.log(`ok: wrote ${files.size} files to site/ from spec/oar/${VERSION}/`);
}

// Referenced so a stray import is not silently dead.
void statSync;
