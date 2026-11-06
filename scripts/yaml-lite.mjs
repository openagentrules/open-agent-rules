// A deliberately tiny YAML reader for spec/oar/<version>/vocabulary.yaml.
//
// This repository has no dependencies and is not going to grow one for a file
// that uses four constructs. So this parser implements exactly those four:
//
//   1. block mappings          key: value
//   2. block sequences         - item
//   3. plain and quoted scalars
//   4. folded block scalars    key: >-
//
// Everything else in YAML — anchors, aliases, tags, flow collections, literal
// blocks, multiple documents, merge keys, complex keys — is *rejected with an
// error naming the line*. Guessing is how a vocabulary file silently means
// something other than what it says, and this file is a build gate's input.
//
// Scalars are returned as strings, except `null`/`~`/empty (null) and the
// booleans `true`/`false`. Numbers stay strings: every value in the vocabulary
// is a name, a type, or prose, and none of them wants to be a float.

export class YamlError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

const REJECT = [
  [/^---\s*$/, 'multiple documents are not supported'],
  [/^\.\.\.\s*$/, 'document end markers are not supported'],
  [/^%/, 'directives are not supported'],
];

// Strip a trailing `# comment`. A `#` counts as a comment only at the start of
// the content or after whitespace, and never inside a quoted scalar. A quote
// character only *opens* a scalar at the start of a token, so the apostrophe in
// prose like "the engine's own counters" is left alone. If a quote never
// closes, the text was prose after all — rescan ignoring quotes rather than
// refusing the file.
function stripComment(text) {
  const scan = (respectQuotes) => {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\' && quote === '"') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (respectQuotes && (c === '"' || c === "'") && (i === 0 || /\s/.test(text[i - 1]))) {
        quote = c;
        continue;
      }
      if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
    }
    return quote ? null : text.trimEnd();
  };
  return scan(true) ?? scan(false);
}

// One significant line: its content and the column that content starts at.
function scan(src) {
  const out = [];
  src.split('\n').forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (raw.includes('\t')) throw new YamlError(lineNo, 'tabs are not valid YAML indentation');
    const col = raw.length - raw.trimStart().length;
    const uncut = raw.trimStart().trimEnd();
    const body = stripComment(raw.trimStart());
    if (body === '') return; // blank or comment-only
    for (const [re, why] of REJECT) if (re.test(body)) throw new YamlError(lineNo, why);
    out.push({ col, text: body, raw: uncut, line: lineNo });
  });
  return out;
}

function scalar(text, lineNo) {
  if (text === '' || text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    if (text.length < 2 || text[text.length - 1] !== q) {
      throw new YamlError(lineNo, `unterminated ${q === '"' ? 'double' : 'single'}-quoted scalar`);
    }
    const body = text.slice(1, -1);
    if (q === "'") return body.replace(/''/g, "'");
    return body.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
  }
  if (/^[&*!]/.test(text)) {
    throw new YamlError(lineNo, `anchors, aliases and tags are not supported: ${text}`);
  }
  if (/^[[{]/.test(text)) {
    throw new YamlError(lineNo, `flow collections are not supported: ${text}`);
  }
  if (text === '|' || text === '|-' || text === '|+' || text === '>' || text === '>+') {
    throw new YamlError(lineNo, `only the >- folded block scalar is supported, not ${text}`);
  }
  return text;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/;

export function parseYaml(src) {
  const lines = scan(src);
  if (lines.length === 0) return null;
  const [value, next] = parseNode(lines, 0, lines[0].col);
  if (next < lines.length) {
    throw new YamlError(lines[next].line, `unexpected content at indent ${lines[next].col}`);
  }
  return value;
}

function parseNode(lines, i, col) {
  return lines[i].text.startsWith('-') ? parseSequence(lines, i, col) : parseMapping(lines, i, col);
}

// A folded block scalar: every following line indented deeper than the key,
// joined with single spaces. A blank line inside one would mean a paragraph
// break, which nothing here uses — scan() has already dropped blank lines, so
// reject any `#` we would have mangled instead of silently truncating prose.
function parseFolded(lines, i, keyCol) {
  const parts = [];
  while (i < lines.length && lines[i].col > keyCol) {
    if (lines[i].raw !== lines[i].text) {
      throw new YamlError(lines[i].line, 'a folded block line containing # is not supported');
    }
    parts.push(lines[i].text);
    i++;
  }
  if (parts.length === 0) throw new YamlError(lines[i - 1].line, 'empty folded block');
  return [parts.join(' '), i];
}

function parseMapping(lines, i, col) {
  const map = {};
  while (i < lines.length && lines[i].col === col) {
    const { text, line } = lines[i];
    const m = KEY.exec(text);
    if (!m) throw new YamlError(line, `expected "key: value", got: ${text}`);
    const key = m[1];
    const rest = (m[2] ?? '').trim();
    if (key in map) throw new YamlError(line, `duplicate key: ${key}`);
    if (rest === '>-') {
      const [value, next] = parseFolded(lines, i + 1, col);
      map[key] = value;
      i = next;
    } else if (rest !== '') {
      map[key] = scalar(rest, line);
      i++;
    } else {
      // Nested block, or an explicitly empty value.
      const child = i + 1;
      if (child < lines.length && lines[child].col > col) {
        const [value, next] = parseNode(lines, child, lines[child].col);
        map[key] = value;
        i = next;
      } else if (child < lines.length && lines[child].col === col && lines[child].text.startsWith('-')) {
        // A sequence written at the same indentation as its key.
        const [value, next] = parseSequence(lines, child, col);
        map[key] = value;
        i = next;
      } else {
        map[key] = null;
        i++;
      }
    }
  }
  if (i < lines.length && lines[i].col > col) {
    throw new YamlError(lines[i].line, `unexpected indentation (${lines[i].col} > ${col})`);
  }
  return [map, i];
}

function parseSequence(lines, i, col) {
  const list = [];
  while (i < lines.length && lines[i].col === col && lines[i].text.startsWith('-')) {
    const { text, line } = lines[i];
    if (text !== '-' && text[1] !== ' ') {
      throw new YamlError(line, `expected "- " after the sequence dash, got: ${text}`);
    }
    const rest = text.slice(2);
    const restCol = col + 2;
    if (rest.trim() === '') {
      const child = i + 1;
      if (child >= lines.length || lines[child].col <= col) {
        throw new YamlError(line, 'sequence entry has no value');
      }
      const [value, next] = parseNode(lines, child, lines[child].col);
      list.push(value);
      i = next;
    } else if (KEY.test(rest)) {
      // `- key: value` — an inline map whose first key sits at restCol.
      const spliced = [{ col: restCol, text: rest, raw: rest, line }, ...lines.slice(i + 1)];
      const [value, consumed] = parseMapping(spliced, 0, restCol);
      list.push(value);
      i = i + consumed;
    } else if (rest.trim().startsWith('-')) {
      throw new YamlError(line, 'nested inline sequences are not supported');
    } else {
      list.push(scalar(rest.trim(), line));
      i++;
    }
  }
  if (i < lines.length && lines[i].col > col) {
    throw new YamlError(lines[i].line, `unexpected indentation (${lines[i].col} > ${col})`);
  }
  return [list, i];
}
