// Copy bindings — Appendix B of the specification.
//
// `copy` members are presentation strings that may name declared facts. The
// language is frozen and small: a substitution, a conditional, and nothing
// else. It is not the condition language of section 5 and not a host template
// dialect. Parsing happens at load — a malformed construct or an unknown
// binding is a load failure, never a runtime default ([OAR-COPY-2],
// [OAR-COPY-3], [OAR-COPY-4]). Rendering happens after the decision is
// resolved ([OAR-COPY-1], [OAR-COPY-7]).

import type { Environment } from './env.js';
import { factValue, type EvalContext, type Value } from './eval.js';
import { RuleLoadError } from './load.js';

/** The copy members a rule document may carry ([OAR-DOC-18]). */
export const COPY_MEMBERS = ['what', 'cause', 'why', 'fix', 'instead', 'message'] as const;
export type CopyMember = (typeof COPY_MEMBERS)[number];

export type CopyPart =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'binding'; readonly name: string }
  | {
      readonly kind: 'conditional';
      readonly name: string;
      readonly negated: boolean;
      readonly then: readonly CopyPart[];
      readonly other: readonly CopyPart[];
    };

/** Rendering failed because an observation is unavailable or wrongly typed. */
export class CopyRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopyRenderError';
  }
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/y;

/**
 * Parses and validates one copy member. Load-time rules enforced here:
 * every `{{ }}` and `{% %}` construct must derive from the Appendix B grammar
 * ([OAR-COPY-3]); every binding and conditional must name a declared fact
 * ([OAR-COPY-2]); every binding must name an interpolatable type
 * ([OAR-COPY-4]). Conditionals may test a fact of any type — every type has a
 * zero value under [OAR-FACT-25].
 */
export function parseCopyTemplate(
  ruleID: string,
  member: string,
  text: string,
  env: Environment,
): CopyPart[] {
  const seg = parseSegments(ruleID, member, text, 0, false);
  const parts = seg.parts;
  checkBindings(ruleID, member, parts, env);
  return parts;
}

/**
 * Every fact name a template references through a binding or a conditional,
 * for the [OAR-COPY-5] requires_facts check.
 */
export function copyReferences(parts: readonly CopyPart[]): Set<string> {
  const names = new Set<string>();
  const walk = (ps: readonly CopyPart[]) => {
    for (const p of ps) {
      if (p.kind === 'binding') names.add(p.name);
      if (p.kind === 'conditional') {
        names.add(p.name);
        walk(p.then);
        walk(p.other);
      }
    }
  };
  walk(parts);
  return names;
}

/**
 * Renders a parsed template against a fact map. Throws CopyRenderError when a
 * value has the wrong runtime type for its binding — a fact-provider failure
 * the caller routes per [OAR-COPY-10].
 */
export function renderCopy(
  parts: readonly CopyPart[],
  facts: Readonly<Record<string, Value>>,
  env: Environment,
): string {
  const ctx: EvalContext = { facts, env, functions: {} };
  let out = '';
  for (const part of parts) {
    if (part.kind === 'literal') {
      out += part.text;
    } else if (part.kind === 'binding') {
      out += renderValue(factValue(part.name, ctx));
    } else {
      const nonZero = isNonZero(factValue(part.name, ctx));
      const branch = (part.negated ? !nonZero : nonZero) ? part.then : part.other;
      out += renderCopy(branch, facts, env);
    }
  }
  return out;
}

/** Renders every member of a rule's copy object. */
export function renderCopyRecord(
  copy: Readonly<Record<string, readonly CopyPart[]>>,
  facts: Readonly<Record<string, Value>>,
  env: Environment,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [member, parts] of Object.entries(copy)) {
    out[member] = renderCopy(parts, facts, env);
  }
  return out;
}

// --- parsing -----------------------------------------------------------------

type Segment =
  | { readonly terminator: null; readonly parts: CopyPart[]; readonly end: number }
  | { readonly terminator: 'else' | 'endif'; readonly parts: CopyPart[]; readonly end: number };

/**
 * Scans copy text from `start` until end-of-text or the next `{% else %}` /
 * `{% endif %}` directive (which is consumed and reported, not included).
 */
function parseSegments(
  ruleID: string,
  member: string,
  text: string,
  start: number,
  nested: boolean,
): Segment {
  const parts: CopyPart[] = [];
  let i = start;
  let literalStart = start;
  const flush = () => {
    if (i > literalStart) parts.push({ kind: 'literal', text: text.slice(literalStart, i) });
  };
  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      flush();
      const parsed = parseBinding(ruleID, member, text, i);
      parts.push({ kind: 'binding', name: parsed.name });
      i = parsed.end;
      literalStart = i;
    } else if (text.startsWith('{%', i)) {
      const directive = peekDirective(ruleID, member, text, i);
      if (directive === 'else' || directive === 'endif') {
        if (!nested) {
          throw new RuleLoadError(
            `rule ${ruleID} copy member ${member}: {% ${directive} %} outside a conditional`,
          );
        }
        flush();
        const end = skipDirective(text, i);
        return { terminator: directive, parts, end };
      }
      flush();
      const parsed = parseConditional(ruleID, member, text, i);
      parts.push(parsed.part);
      i = parsed.end;
      literalStart = i;
    } else {
      i += 1;
    }
  }
  flush();
  return { terminator: null, parts, end: text.length };
}

function parseBinding(
  ruleID: string,
  member: string,
  text: string,
  start: number,
): { name: string; end: number } {
  let i = start + 2;
  i = skipWs(text, i);
  const name = readIdentifier(ruleID, member, text, i, 'binding');
  i = skipWs(text, i + name.length);
  if (!text.startsWith('}}', i)) {
    throw new RuleLoadError(
      `rule ${ruleID} copy member ${member}: unterminated binding — expected }}`,
    );
  }
  return { name, end: i + 2 };
}

function parseConditional(
  ruleID: string,
  member: string,
  text: string,
  start: number,
): { part: CopyPart; end: number } {
  let i = start + 2;
  i = skipWs(text, i);
  if (!text.startsWith('if', i) || !isWsOrEnd(text, i + 2)) {
    throw new RuleLoadError(
      `rule ${ruleID} copy member ${member}: {% %} must open with if — the construct is not in the copy grammar`,
    );
  }
  i = skipWs(text, i + 2);
  let negated = false;
  if (text.startsWith('not', i) && isWsOrEnd(text, i + 3)) {
    negated = true;
    i = skipWs(text, i + 3);
  }
  const name = readIdentifier(ruleID, member, text, i, 'conditional');
  i = skipWs(text, i + name.length);
  if (!text.startsWith('%}', i)) {
    throw new RuleLoadError(
      `rule ${ruleID} copy member ${member}: unterminated conditional header — expected %}`,
    );
  }
  i += 2;
  const thenSeg = parseSegments(ruleID, member, text, i, true);
  let other: CopyPart[] = [];
  let terminator = thenSeg.terminator;
  let end = thenSeg.end;
  if (terminator === 'else') {
    const elseSeg = parseSegments(ruleID, member, text, thenSeg.end, true);
    if (elseSeg.terminator !== 'endif') {
      throw new RuleLoadError(
        `rule ${ruleID} copy member ${member}: unterminated conditional — expected {% endif %}`,
      );
    }
    other = elseSeg.parts;
    terminator = elseSeg.terminator;
    end = elseSeg.end;
  }
  if (terminator !== 'endif') {
    throw new RuleLoadError(
      `rule ${ruleID} copy member ${member}: unterminated conditional — expected {% endif %}`,
    );
  }
  return { part: { kind: 'conditional', name, negated, then: thenSeg.parts, other }, end };
}

/** Reads the keyword of the directive opening at `start` (`{% keyword`). */
function peekDirective(ruleID: string, member: string, text: string, start: number): string {
  let i = skipWs(text, start + 2);
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
  const word = m?.[0] ?? '';
  if (word !== 'if' && word !== 'else' && word !== 'endif') {
    throw new RuleLoadError(
      `rule ${ruleID} copy member ${member}: {% ${word || '…'} %} is not a construct of the copy grammar — expected if, else, or endif`,
    );
  }
  return word;
}

function skipDirective(text: string, start: number): number {
  const close = text.indexOf('%}', start);
  return close === -1 ? text.length : close + 2;
}

function readIdentifier(
  ruleID: string,
  member: string,
  text: string,
  start: number,
  what: string,
): string {
  IDENT_RE.lastIndex = start;
  const m = IDENT_RE.exec(text);
  if (!m || m.index !== start) {
    throw new RuleLoadError(
      `rule ${ruleID} copy member ${member}: ${what} must name a fact identifier`,
    );
  }
  return m[0];
}

function skipWs(text: string, i: number): number {
  while (i < text.length && isWs(text[i]!)) i += 1;
  return i;
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isWsOrEnd(text: string, i: number): boolean {
  return i >= text.length || isWs(text[i]!);
}

// --- load-time binding checks -------------------------------------------------

function checkBindings(
  ruleID: string,
  member: string,
  parts: readonly CopyPart[],
  env: Environment,
): void {
  const walk = (ps: readonly CopyPart[]) => {
    for (const p of ps) {
      if (p.kind === 'conditional') {
        requireFact(ruleID, member, p.name, env, 'conditional');
        walk(p.then);
        walk(p.other);
      } else if (p.kind === 'binding') {
        const decl = requireFact(ruleID, member, p.name, env, 'binding');
        if (!INTERPOLATABLE.has(decl.type)) {
          throw new RuleLoadError(
            `rule ${ruleID} copy member ${member} binds {{ ${p.name} }} of type ${decl.type}, which cannot be interpolated`,
          );
        }
      }
    }
  };
  walk(parts);
}

function requireFact(
  ruleID: string,
  member: string,
  name: string,
  env: Environment,
  what: string,
): { type: string } {
  const decl = env.facts[name];
  if (!decl) {
    throw new RuleLoadError(
      `rule ${ruleID} copy member ${member} ${what === 'binding' ? 'binds' : 'tests'} {{ ${name} }}, which is not a declared fact`,
    );
  }
  return decl;
}

const INTERPOLATABLE = new Set(['string', 'bool', 'int', 'double', 'list<string>']);

// --- rendering ----------------------------------------------------------------

function isNonZero(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (v === null) return false;
  return Object.keys(v).length > 0;
}

function renderValue(v: Value): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return canonicalDouble(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== 'string') {
        throw new CopyRenderError('list<string> member is not a string at render time');
      }
    }
    return v.join(', ');
  }
  throw new CopyRenderError('value of a map type cannot be interpolated');
}

/**
 * [OAR-COPY-9] The shortest decimal significand that round-trips to the same
 * finite binary64 value, expanded into ordinary decimal notation with a
 * leading zero before a fractional value and `.0` appended when there is no
 * fractional part. Both signed zeroes render as `0.0`.
 */
export function canonicalDouble(v: number): string {
  if (!Number.isFinite(v)) throw new CopyRenderError('double is not finite');
  if (v === 0) return '0.0';
  const neg = v < 0;
  const abs = neg ? -v : v;
  // Number.prototype.toPrecision rounds correctly; the first precision whose
  // result round-trips is the shortest round-tripping significand. (Exact
  // ties between two equally close p-digit decimals choose the larger under
  // toPrecision; a tie that still round-trips is unreachable for binary64 at
  // the shortest length, so this matches the ties-to-even rule in practice.)
  let s = '';
  for (let p = 1; p <= 17; p++) {
    s = abs.toPrecision(p);
    if (Number(s) === abs) break;
  }
  let t = expandExponent(s);
  if (t.startsWith('.')) t = '0' + t;
  if (!t.includes('.')) t += '.0';
  return (neg ? '-' : '') + t;
}

/** Rewrites `1.5e-7` as `0.00000015` and `1e+21` as `1000000000000000000000`. */
function expandExponent(s: string): string {
  const e = s.indexOf('e');
  if (e === -1) return s;
  const mant = s.slice(0, e);
  const exp = Number(s.slice(e + 1));
  const neg = mant.startsWith('-');
  const unsigned = neg ? mant.slice(1) : mant;
  const point = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '');
  const decimalPos = (point === -1 ? unsigned.length : point) + exp;
  let t: string;
  if (decimalPos <= 0) {
    t = '0.' + '0'.repeat(-decimalPos) + digits;
  } else if (decimalPos >= digits.length) {
    t = digits + '0'.repeat(decimalPos - digits.length);
  } else {
    t = digits.slice(0, decimalPos) + '.' + digits.slice(decimalPos);
  }
  return neg ? '-' + t : t;
}
