// A small markdown renderer for the published site.
//
// It handles exactly the constructs the specification and its companion
// documents use: headings, paragraphs, fenced code, pipe tables, bullet and
// ordered lists, links, bold, italic, inline code, blockquotes and horizontal
// rules. It is not a CommonMark implementation and does not try to be — the
// point is a dependency-free, auditable path from the hand-authored markdown
// to the HTML on openagentrules.org.
//
// Heading anchors are stable and are part of the published contract: other
// documents deep-link to `#3-anchors-and-selection`. The slug is the heading
// text lowercased with every run of non-alphanumeric characters collapsed to a
// hyphen, so "5.1 Capability profiles" is `#5-1-capability-profiles`.

export const escapeHtml = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');

export const slug = (text) =>
  text
    .replace(/`/g, '')
    .replace(/\*\*?/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const LINK = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)/;

// Inline markup. Scanned left to right so that a construct opened inside a code
// span (`[OAR-DOC-1]`, `^[A-Z]*$`) is never mistaken for markup.
export function inline(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) {
        out += `<code>${escapeHtml(src.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    if (src[i] === '[') {
      const m = LINK.exec(rest);
      if (m) {
        out += `<a href="${escapeHtml(m[2])}">${inline(m[1])}</a>`;
        i += m[0].length;
        continue;
      }
    }

    if (rest.startsWith('**')) {
      const end = src.indexOf('**', i + 2);
      if (end !== -1) {
        out += `<strong>${inline(src.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }

    // A single `*` is emphasis only when it opens and closes a run of text on
    // the same line with no space just inside it.
    if (src[i] === '*') {
      const m = /^\*([^*\s][^*]*)\*/.exec(rest);
      if (m) {
        out += `<em>${inline(m[1])}</em>`;
        i += m[0].length;
        continue;
      }
    }

    out += escapeHtml(src[i]);
    i++;
  }
  return out;
}

const isTable = (line) => line.trimStart().startsWith('|');
const isRule = (line) => /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
const isHeading = (line) => /^#{1,6}\s+\S/.test(line);
const isFence = (line) => /^```/.test(line.trimStart());
const isBullet = (line) => /^([-*])\s+\S/.test(line);
const isOrdered = (line) => /^\d+\.\s+\S/.test(line);
const isItem = (line) => isBullet(line) || isOrdered(line);

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

// One list item is a sequence of paragraphs; '' marks the break between them.
function renderItem(parts) {
  const paragraphs = [];
  let current = [];
  for (const part of parts) {
    if (part === '') {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
    } else current.push(part);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  if (paragraphs.length <= 1) return `<li>${inline(paragraphs[0] ?? '')}</li>`;
  return `<li>${paragraphs.map((p) => `<p>${inline(p)}</p>`).join('')}</li>`;
}

export function renderMarkdown(source) {
  // HTML comments are authoring markers (the vocabulary table delimiters) and
  // never reach the page.
  const src = source.replace(/<!--[\s\S]*?-->/g, '');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (isFence(line)) {
      const open = line.trimStart();
      const lang = open.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) body.push(lines[i]), i++;
      i++; // closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    if (isHeading(line)) {
      const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      const level = m[1].length;
      const id = slug(m[2]);
      out.push(`<h${level} id="${id}">${inline(m[2])}</h${level}>`);
      i++;
      continue;
    }

    if (isRule(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (isTable(line) && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && isTable(lines[i + 1])) {
      const header = cells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && isTable(lines[i])) rows.push(cells(lines[i])), i++;
      const head = header.map((c) => `<th>${inline(c)}</th>`).join('');
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('\n');
      out.push(
        `<div class="scroll">\n<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n</div>`,
      );
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const parts = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        parts.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(parts.join(' '))}</blockquote>`);
      continue;
    }

    if (isItem(line)) {
      const tag = isOrdered(line) ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isItem(l) && !/^\s/.test(l)) {
          items.push([l.replace(/^(?:[-*]|\d+\.)\s+/, '')]);
          i++;
        } else if (l.trim() === '') {
          // A blank line ends the list unless what follows continues an item or
          // opens the next one.
          const next = lines[i + 1];
          if (next === undefined) break;
          if (/^\s{2,}\S/.test(next) && !isItem(next.trimStart())) {
            items.at(-1).push('');
            i++;
          } else if (isItem(next) && !/^\s/.test(next)) {
            i++;
          } else break;
        } else if (/^\s{2,}\S/.test(l) && items.length > 0) {
          items.at(-1).push(l.trim());
          i++;
        } else break;
      }
      out.push(`<${tag}>\n${items.map(renderItem).join('\n')}\n</${tag}>`);
      continue;
    }

    // Paragraph: run to the next blank line or block opener.
    const parts = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const l = lines[i];
      if (isHeading(l) || isFence(l) || isRule(l) || isTable(l) || isItem(l) || l.trimStart().startsWith('>')) break;
      parts.push(l.trim());
      i++;
    }
    if (parts.length > 0) {
      out.push(`<p>${inline(parts.join(' '))}</p>`);
    } else {
      // A block opener that did not form a block — a lone `|` with no separator
      // row, say. Emit it rather than dropping it: silently losing a line of the
      // specification is the one failure mode this renderer must not have.
      out.push(`<p>${inline(line.trim())}</p>`);
      i++;
    }
  }

  return out.join('\n');
}
