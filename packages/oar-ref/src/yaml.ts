// A reader for the YAML subset this repository's rule packs and capability
// documents are written in.
//
// [OAR-DOC-1] A rule document must be representable as a JSON object; an engine
// may accept other serialisations provided the mapping to JSON is lossless, and
// YAML is the common authoring form. [OAR-DOC-31] a multi-document YAML stream
// is one of the two rule-set forms an engine may accept, and every member is
// treated as an independent document.
//
// This is deliberately not a general YAML implementation — this package carries
// zero runtime dependencies, and a rule pack needs block maps, block and flow
// sequences, quoted and plain scalars, comments, and the `---` separator. A
// construct outside that subset raises rather than being guessed at.

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} on line ${line + 1}`);
    this.name = 'YamlError';
  }
}

type Line = { indent: number; text: string; n: number };

function scanLines(src: string): Line[] {
  const out: Line[] = [];
  const raw = src.split(/\r?\n/);
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n]!;
    if (line.includes('\t')) throw new YamlError('a tab may not be used for indentation', n);
    const trimmed = stripComment(line);
    if (trimmed.trim() === '') continue;
    const indent = trimmed.length - trimmed.trimStart().length;
    out.push({ indent, text: trimmed.trimStart().trimEnd(), n });
  }
  return out;
}

/** Strip a `#` comment that is not inside a quoted scalar. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i);
  }
  return line;
}

/** Parse a multi-document YAML stream into one JSON-shaped value per document. */
export function parseYamlStream(src: string): unknown[] {
  const docs: string[] = [];
  let current: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    if (/^---\s*$/.test(line)) {
      docs.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  docs.push(current.join('\n'));
  return docs
    .filter((d) => scanLines(d).length > 0)
    .map((d) => parseYaml(d));
}

/** Parse a single YAML document into a JSON-shaped value. */
export function parseYaml(src: string): unknown {
  const lines = scanLines(src);
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent);
  if (next !== lines.length) throw new YamlError('unexpected content', lines[next]!.n);
  return value;
}

function parseBlock(lines: Line[], at: number, indent: number): [unknown, number] {
  if (lines[at]!.text.startsWith('- ') || lines[at]!.text === '-') {
    return parseSequence(lines, at, indent);
  }
  return parseMapping(lines, at, indent);
}

function parseSequence(lines: Line[], at: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let i = at;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (!line.text.startsWith('- ') && line.text !== '-') break;
    const inline = line.text === '-' ? '' : line.text.slice(2).trim();
    if (inline === '') {
      i++;
      if (i < lines.length && lines[i]!.indent > indent) {
        const [value, next] = parseBlock(lines, i, lines[i]!.indent);
        out.push(value);
        i = next;
      } else {
        out.push(null);
      }
      continue;
    }
    // A mapping that starts on the dash line: `- name: x` continues at the
    // column the key begins in.
    const key = splitKey(inline);
    if (key !== null) {
      const childIndent = indent + 2;
      const synthetic: Line[] = [{ indent: childIndent, text: inline, n: line.n }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= childIndent) {
        synthetic.push(lines[j]!);
        j++;
      }
      const [value, consumed] = parseMapping(synthetic, 0, childIndent);
      if (consumed !== synthetic.length) throw new YamlError('unexpected content in a sequence item', lines[i]!.n);
      out.push(value);
      i = j;
      continue;
    }
    out.push(scalar(inline, line.n));
    i++;
  }
  return [out, i];
}

function splitKey(text: string): [string, string] | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseMapping(lines: Line[], at: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = at;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (line.text.startsWith('- ')) break;
    const split = splitKey(line.text);
    if (split === null) throw new YamlError(`expected "key: value", got ${JSON.stringify(line.text)}`, line.n);
    const [rawKey, rawValue] = split;
    const key = unquote(rawKey);
    if (rawValue !== '') {
      out[key] = scalar(rawValue, line.n);
      i++;
      continue;
    }
    i++;
    if (i < lines.length && lines[i]!.indent > indent) {
      const [value, next] = parseBlock(lines, i, lines[i]!.indent);
      out[key] = value;
      i = next;
      continue;
    }
    // A block sequence may sit at the parent's own indentation.
    if (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) {
      const [value, next] = parseSequence(lines, i, indent);
      out[key] = value;
      i = next;
      continue;
    }
    out[key] = null;
  }
  return [out, i];
}

function unquote(text: string): string {
  if (text.length >= 2 && text[0] === '"' && text.endsWith('"')) {
    return JSON.parse(text) as string;
  }
  if (text.length >= 2 && text[0] === "'" && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function scalar(text: string, line: number): unknown {
  if (text.startsWith('[')) return flowSequence(text, line);
  if (text.startsWith('{')) throw new YamlError('a flow mapping is outside this reader\'s subset', line);
  if (text === '|' || text === '>' || text.startsWith('>-') || text.startsWith('|-')) {
    throw new YamlError('a block scalar is outside this reader\'s subset', line);
  }
  if (text[0] === '"' || text[0] === "'") return unquote(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?[0-9]+$/.test(text)) return Number(text);
  if (/^-?[0-9]+\.[0-9]+$/.test(text)) return Number(text);
  return text;
}

function flowSequence(text: string, line: number): unknown[] {
  if (!text.endsWith(']')) throw new YamlError('an unterminated flow sequence', line);
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  const out: unknown[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(scalar(inner.slice(start, i).trim(), line));
      start = i + 1;
    }
  }
  out.push(scalar(inner.slice(start).trim(), line));
  return out;
}
