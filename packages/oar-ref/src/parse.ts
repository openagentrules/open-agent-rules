// Tokenizer and Pratt parser for the condition subset this implementation
// accepts. The grammar is frozen and deliberately small: everything outside it
// raises UnsupportedCelConstruct naming the construct and its offset, so a rule
// that would be mis-evaluated is refused instead.

// The clause each rejection applies ([OAR-EXPR-1]); anything else is outside
// the grammar itself.
const CLAUSE_FOR: Readonly<Record<string, string>> = {
  comment: 'OAR-EXPR-6',
  'string escape': 'OAR-EXPR-3',
  'chained relational operator': 'OAR-EXPR-4',
};

export class UnsupportedCelConstruct extends Error {
  constructor(
    readonly construct: string,
    readonly offset: number,
    detail?: string,
  ) {
    super(
      `unsupported construct ${construct} at offset ${offset}` +
        (detail ? `: ${detail}` : '') +
        ` [${CLAUSE_FOR[construct] ?? 'OAR-EXPR-1'}]`,
    );
    this.name = 'UnsupportedCelConstruct';
  }
}

export class CelSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset} [OAR-EXPR-1]`);
    this.name = 'CelSyntaxError';
  }
}

export type Node =
  | { kind: 'bool'; value: boolean; offset: number }
  | { kind: 'int'; value: bigint; offset: number }
  | { kind: 'double'; value: number; offset: number }
  | { kind: 'string'; value: string; offset: number }
  | { kind: 'list'; items: Node[]; offset: number }
  | { kind: 'ident'; name: string; offset: number }
  | { kind: 'select'; target: string; field: string; offset: number }
  | { kind: 'call'; name: string; args: Node[]; offset: number }
  | { kind: 'unary'; op: '!' | '-'; operand: Node; offset: number }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node; offset: number }
  | { kind: 'ternary'; cond: Node; then: Node; other: Node; offset: number };

export type BinaryOp =
  | '||' | '&&'
  | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in'
  | '+' | '-' | '*' | '/' | '%';

// Macros and comprehension forms are named so the error can say which one.
const MACROS = new Set(['has', 'all', 'exists', 'exists_one', 'map', 'filter']);

type Token =
  | { t: 'num'; int: boolean; text: string; at: number }
  | { t: 'str'; value: string; at: number }
  | { t: 'ident'; name: string; at: number }
  | { t: 'punct'; text: string; at: number }
  | { t: 'eof'; at: number };

const PUNCT = [
  '&&', '||', '==', '!=', '<=', '>=',
  '(', ')', '[', ']', '{', '}', ',', '.', '?', ':',
  '<', '>', '!', '+', '-', '*', '/', '%',
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      throw new UnsupportedCelConstruct('comment', i);
    }
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let value = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          const esc = src[i + 1];
          switch (esc) {
            case 'n': value += '\n'; break;
            case 't': value += '\t'; break;
            case 'r': value += '\r'; break;
            case '"': value += '"'; break;
            case "'": value += "'"; break;
            case '\\': value += '\\'; break;
            default: throw new UnsupportedCelConstruct('string escape', i, `\\${esc ?? ''}`);
          }
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (i >= src.length) throw new CelSyntaxError('unterminated string', start);
      i++;
      out.push({ t: 'str', value, at: start });
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      let isInt = true;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        isInt = false;
        i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        isInt = false;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      if (src[i] === 'u' || src[i] === 'U') {
        throw new UnsupportedCelConstruct('unsigned literal', i);
      }
      out.push({ t: 'num', int: isInt, text: src.slice(start, i), at: start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      out.push({ t: 'ident', name: src.slice(start, i), at: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT.includes(two)) {
      out.push({ t: 'punct', text: two, at: i });
      i += 2;
      continue;
    }
    if (PUNCT.includes(c)) {
      out.push({ t: 'punct', text: c, at: i });
      i++;
      continue;
    }
    throw new CelSyntaxError(`unexpected character ${JSON.stringify(c)}`, i);
  }
  out.push({ t: 'eof', at: src.length });
  return out;
}

// Binding powers, loosest to tightest. The ternary is handled separately
// because it is right-associative and three-armed.
const RELATIONAL = 3;
const BINDING: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3, in: 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
};

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.pos]!;
  }

  private next(): Token {
    return this.toks[this.pos++]!;
  }

  private atPunct(text: string): boolean {
    const t = this.peek();
    return t.t === 'punct' && t.text === text;
  }

  private expect(text: string): Token {
    const t = this.next();
    if (t.t !== 'punct' || t.text !== text) {
      throw new CelSyntaxError(`expected ${JSON.stringify(text)}`, t.at);
    }
    return t;
  }

  parse(): Node {
    const node = this.expression();
    const end = this.peek();
    if (end.t !== 'eof') {
      throw new CelSyntaxError('unexpected trailing input', end.at);
    }
    return node;
  }

  // expression := ternary (loosest level)
  expression(): Node {
    const cond = this.binary(0);
    if (this.atPunct('?')) {
      const at = this.next().at;
      const then = this.expression();
      this.expect(':');
      const other = this.expression();
      return { kind: 'ternary', cond, then, other, offset: at };
    }
    return cond;
  }

  private binary(minBp: number): Node {
    let left = this.unary();
    let relational = false;
    for (;;) {
      const t = this.peek();
      let op: string | undefined;
      if (t.t === 'punct' && BINDING[t.text] !== undefined) op = t.text;
      else if (t.t === 'ident' && t.name === 'in') op = 'in';
      if (op === undefined) break;
      const bp = BINDING[op]!;
      if (bp < minBp) break;
      // [OAR-EXPR-4] A relation holds at most one relational operator.
      if (bp === RELATIONAL) {
        if (relational) throw new UnsupportedCelConstruct('chained relational operator', t.at);
        relational = true;
      }
      const at = this.next().at;
      const right = this.binary(bp + 1);
      left = { kind: 'binary', op: op as BinaryOp, left, right, offset: at };
    }
    return left;
  }

  private unary(): Node {
    const t = this.peek();
    if (t.t === 'punct' && (t.text === '!' || t.text === '-')) {
      const at = this.next().at;
      return { kind: 'unary', op: t.text as '!' | '-', operand: this.unary(), offset: at };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.next();
    if (t.t === 'punct' && t.text === '(') {
      const inner = this.expression();
      this.expect(')');
      return inner;
    }
    if (t.t === 'punct' && t.text === '[') {
      const items: Node[] = [];
      if (!this.atPunct(']')) {
        for (;;) {
          items.push(this.expression());
          if (this.atPunct(',')) {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expect(']');
      return this.noIndex({ kind: 'list', items, offset: t.at });
    }
    if (t.t === 'punct' && t.text === '{') {
      throw new UnsupportedCelConstruct('map literal', t.at);
    }
    if (t.t === 'num') {
      const node: Node = t.int
        ? { kind: 'int', value: BigInt(t.text), offset: t.at }
        : { kind: 'double', value: Number(t.text), offset: t.at };
      return this.noIndex(node);
    }
    if (t.t === 'str') {
      return this.noIndex({ kind: 'string', value: t.value, offset: t.at });
    }
    if (t.t === 'ident') {
      if (t.name === 'true' || t.name === 'false') {
        return this.noIndex({ kind: 'bool', value: t.name === 'true', offset: t.at });
      }
      if (this.atPunct('(')) {
        if (MACROS.has(t.name)) {
          throw new UnsupportedCelConstruct(`macro ${t.name}`, t.at);
        }
        this.next();
        const args: Node[] = [];
        if (!this.atPunct(')')) {
          for (;;) {
            args.push(this.expression());
            if (this.atPunct(',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect(')');
        return this.noIndex({ kind: 'call', name: t.name, args, offset: t.at });
      }
      if (this.atPunct('.')) {
        this.next();
        const field = this.next();
        if (field.t !== 'ident') {
          throw new CelSyntaxError('expected a field name after "."', field.at);
        }
        if (this.atPunct('(')) {
          throw new UnsupportedCelConstruct(`method call .${field.name}()`, field.at);
        }
        if (this.atPunct('.')) {
          throw new UnsupportedCelConstruct('chained field selection', this.peek().at);
        }
        return this.noIndex({ kind: 'select', target: t.name, field: field.name, offset: t.at });
      }
      return this.noIndex({ kind: 'ident', name: t.name, offset: t.at });
    }
    throw new CelSyntaxError('expected an expression', t.at);
  }

  // Indexing is outside the grammar wherever it appears, and so is any
  // selection or call hanging off something that is not a bare identifier —
  // that shape is a macro or a method call.
  private noIndex(node: Node): Node {
    if (this.atPunct('[')) {
      throw new UnsupportedCelConstruct('index expression', this.peek().at);
    }
    if (this.atPunct('.')) {
      const at = this.peek().at;
      const field = this.toks[this.pos + 1];
      const name = field && field.t === 'ident' ? field.name : '';
      if (MACROS.has(name)) {
        throw new UnsupportedCelConstruct(`macro ${name}`, at);
      }
      const after = this.toks[this.pos + 2];
      if (after && after.t === 'punct' && after.text === '(') {
        throw new UnsupportedCelConstruct(`method call .${name}()`, at);
      }
      throw new UnsupportedCelConstruct('chained field selection', at);
    }
    return node;
  }
}

/** Parse a condition into the accepted AST, or throw naming what is unsupported. */
export function parse(src: string): Node {
  return new Parser(tokenize(src)).parse();
}
