import { canonicalDouble } from './canonical.js';
// Frozen copy-binding language ([OAR-COPY-1]–[OAR-COPY-8]).
//
// Copy is presentation. This module parses bindings at load, collects the fact
// names they reference, and substitutes after the decision is resolved. It is
// not the condition language, and it is not a host template dialect.

import type { FactType } from './vocab.js';
import { zeroValue, validateFactValue, type Value } from './eval.js';

export class CopyLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopyLoadError';
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const INTERPOLATABLE = new Set<FactType>(['string', 'bool', 'int', 'double', 'list<string>']);

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'bind'; name: string }
  | { kind: 'if'; name: string; negate: boolean; then: Node[]; else: Node[] };

export interface CopyBinding {
  readonly name: string;
  readonly interpolate: boolean;
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i]!)) i++;
  return i;
}

function readIdent(s: string, i: number): { name: string; next: number } | null {
  i = skipWs(s, i);
  const start = i;
  if (i >= s.length || !/[A-Za-z_]/.test(s[i]!)) return null;
  i++;
  while (i < s.length && /[A-Za-z0-9_.]/.test(s[i]!)) i++;
  const name = s.slice(start, i);
  if (!IDENT_RE.test(name)) return null;
  return { name, next: skipWs(s, i) };
}

function parseTag(s: string, i: number, open: '{{' | '{%'): { body: string; next: number } {
  if (i + open.length > s.length) throw new CopyLoadError('endif');
  const close = open === '{{' ? '}}' : '%}';
  const end = s.indexOf(close, i + open.length);
  if (end < 0) throw new CopyLoadError(open === '{{' ? 'binding' : 'conditional');
  return { body: s.slice(i + open.length, end), next: end + close.length };
}

function parseNodes(s: string, from: number, until: Set<string>): { nodes: Node[]; next: number } {
  const nodes: Node[] = [];
  let i = from;
  while (i < s.length) {
    const bindAt = s.indexOf('{{', i);
    const tagAt = s.indexOf('{%', i);
    let next = -1;
    let open: '{{' | '{%' = '{{';
    if (bindAt >= 0 && (tagAt < 0 || bindAt <= tagAt)) {
      next = bindAt;
      open = '{{';
    } else if (tagAt >= 0) {
      next = tagAt;
      open = '{%';
    }
    if (next < 0) {
      if (s.slice(i)) nodes.push({ kind: 'text', value: s.slice(i) });
      return { nodes, next: s.length };
    }
    if (next > i) nodes.push({ kind: 'text', value: s.slice(i, next) });
    const tag = parseTag(s, next, open);
    if (open === '{{') {
      const ident = readIdent(tag.body, 0);
      if (ident === null || ident.next !== tag.body.length) throw new CopyLoadError('binding');
      nodes.push({ kind: 'bind', name: ident.name });
      i = tag.next;
      continue;
    }
    let p = skipWs(tag.body, 0);
    const wordEnd = p;
    while (p < tag.body.length && /[A-Za-z]/.test(tag.body[p]!)) p++;
    const word = tag.body.slice(wordEnd, p);
    p = skipWs(tag.body, p);
    if (until.has(word) && p === tag.body.length) {
      return { nodes, next };
    }
    if (word === 'if') {
      let negate = false;
      if (tag.body.slice(p, p + 3) === 'not' && (p + 3 === tag.body.length || isWs(tag.body[p + 3]!))) {
        negate = true;
        p = skipWs(tag.body, p + 3);
      }
      const ident = readIdent(tag.body, p);
      if (ident === null || ident.next !== tag.body.length) throw new CopyLoadError('if');
      const thenPart = parseNodes(s, tag.next, new Set(['else', 'endif']));
      let elseNodes: Node[] = [];
      let after = thenPart.next;
      const closer = parseTag(s, thenPart.next, '{%');
      let q = skipWs(closer.body, 0);
      const wStart = q;
      while (q < closer.body.length && /[A-Za-z]/.test(closer.body[q]!)) q++;
      const closerWord = closer.body.slice(wStart, q);
      q = skipWs(closer.body, q);
      if (q !== closer.body.length) throw new CopyLoadError(closerWord || 'conditional');
      if (closerWord === 'else') {
        const elsePart = parseNodes(s, closer.next, new Set(['endif']));
        elseNodes = elsePart.nodes;
        const endTag = parseTag(s, elsePart.next, '{%');
        let e = skipWs(endTag.body, 0);
        const eStart = e;
        while (e < endTag.body.length && /[A-Za-z]/.test(endTag.body[e]!)) e++;
        const endWord = endTag.body.slice(eStart, e);
        e = skipWs(endTag.body, e);
        if (endWord !== 'endif' || e !== endTag.body.length) throw new CopyLoadError(endWord || 'endif');
        after = endTag.next;
      } else if (closerWord === 'endif') {
        after = closer.next;
      } else {
        throw new CopyLoadError(closerWord || 'conditional');
      }
      nodes.push({ kind: 'if', name: ident.name, negate, then: thenPart.nodes, else: elseNodes });
      i = after;
      continue;
    }
    throw new CopyLoadError(word || 'conditional');
  }
  return { nodes, next: i };
}

function walk(nodes: Node[], visit: (n: Node) => void): void {
  for (const n of nodes) {
    visit(n);
    if (n.kind === 'if') {
      walk(n.then, visit);
      walk(n.else, visit);
    }
  }
}

/** Parse a copy member and return every fact it names. */
export function parseCopy(source: string): CopyBinding[] {
  const { nodes, next } = parseNodes(source, 0, new Set());
  if (next !== source.length && next < source.length) {
    // A leftover `{% else %}` / `{% endif %}` at the top level is an illegal construct.
    if (source.slice(next).includes('{%')) throw new CopyLoadError('conditional');
  }
  const out: CopyBinding[] = [];
  const seen = new Set<string>();
  walk(nodes, (n) => {
    if (n.kind === 'bind') {
      if (!seen.has(`bind:${n.name}`)) {
        seen.add(`bind:${n.name}`);
        out.push({ name: n.name, interpolate: true });
      }
    } else if (n.kind === 'if') {
      if (!seen.has(`if:${n.name}`)) {
        seen.add(`if:${n.name}`);
        out.push({ name: n.name, interpolate: false });
      }
    }
  });
  return out;
}

function isZero(value: Value): boolean {
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'bigint') return value === 0n;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0;
  return true;
}

function interpolate(value: Value): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') return canonicalDouble(value);
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
    return (value as readonly string[]).join(', ');
  }
  return '';
}

function renderNodes(nodes: Node[], lookup: (name: string) => Value): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      out += n.value;
      continue;
    }
    if (n.kind === 'bind') {
      out += interpolate(lookup(n.name));
      continue;
    }
    const take = n.negate ? isZero(lookup(n.name)) : !isZero(lookup(n.name));
    out += renderNodes(take ? n.then : n.else, lookup);
  }
  return out;
}

/** Substitute bindings in a copy member that has already passed load. */
export function renderCopy(source: string, lookup: (name: string) => Value): string {
  if (!source.includes('{{') && !source.includes('{%')) return source;
  const { nodes } = parseNodes(source, 0, new Set());
  return renderNodes(nodes, lookup);
}

export function copyLookup(
  facts: Readonly<Record<string, unknown>>,
  types: ReadonlyMap<string, FactType>,
): (name: string) => Value {
  return (name: string): Value => {
    const raw = facts[name];
    if (raw !== undefined) return validateFactValue(raw, types.get(name) ?? "string", name);
    const typ = types.get(name);
    return typ === undefined ? '' : zeroValue(typ);
  };
}

export { INTERPOLATABLE };
