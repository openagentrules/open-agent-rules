// Appendix A, section A.1: the frozen grammar of the condition language.
//
// The parser accepts exactly what the EBNF derives ([OAR-EXPR-1]).

export class ConditionSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'ConditionSyntaxError';
  }
}

export type BinaryOp =
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

export type Node =
  | { kind: 'bool'; value: boolean; offset: number }
  | { kind: 'int'; value: bigint; offset: number }
  | { kind: 'double'; value: number; offset: number }
  | { kind: 'string'; value: string; offset: number }
  | { kind: 'list'; items: Node[]; offset: number }
  | { kind: 'ident'; name: string; offset: number }
  | { kind: 'call'; name: string; args: Node[]; offset: number }
  | { kind: 'index'; target: Node; index: Node; offset: number }
  | { kind: 'unary'; op: '!' | '-'; operand: Node; offset: number }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node; offset: number }
  | { kind: 'ternary'; cond: Node; then: Node; other: Node; offset: number };

/** Count the nodes of a parse tree, for the [OAR-EXPR-17] limit. */
export function countNodes(node: Node): number {
  switch (node.kind) {
    case 'list':
      return 1 + node.items.reduce((n, i) => n + countNodes(i), 0);
    case 'call':
      return 1 + node.args.reduce((n, a) => n + countNodes(a), 0);
    case 'index':
      return 1 + countNodes(node.target) + countNodes(node.index);
    case 'unary':
      return 1 + countNodes(node.operand);
    case 'binary':
      return 1 + countNodes(node.left) + countNodes(node.right);
    case 'ternary':
      return 1 + countNodes(node.cond) + countNodes(node.then) + countNodes(node.other);
    default:
      return 1;
  }
}

type Token =
  | { t: 'int'; text: string; at: number }
  | { t: 'double'; text: string; at: number }
  | { t: 'string'; value: string; at: number }
  | { t: 'name'; text: string; at: number }
  | { t: 'punct'; text: string; at: number }
  | { t: 'eof'; at: number };

const TWO_CHAR = ['&&', '||', '==', '!=', '<=', '>='];
const ONE_CHAR = ['(', ')', '[', ']', ',', '?', ':', '<', '>', '!', '+', '-', '*', '/', '%'];

function isLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // [OAR-EXPR-6] A comment is not part of the language.
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      throw new ConditionSyntaxError('[OAR-EXPR-6] a comment is not part of the condition language', i);
    }
    if (c === '#') {
      throw new ConditionSyntaxError('[OAR-EXPR-6] a comment is not part of the condition language', i);
    }
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let value = '';
      for (;;) {
        if (i >= src.length) throw new ConditionSyntaxError('unterminated string literal', start);
        const ch = src[i]!;
        if (ch === quote) {
          i++;
          break;
        }
        if (ch === '\\') {
          // [OAR-EXPR-3] The escape set is closed.
          const esc = src[i + 1];
          if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === "'") value += "'";
          else if (esc === 'n') value += '\n';
          else if (esc === 'r') value += '\r';
          else if (esc === 't') value += '\t';
          else if (esc === 'u') {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
              throw new ConditionSyntaxError('[OAR-EXPR-3] \\u must be followed by exactly four hexadecimal digits', i);
            }
            value += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          } else {
            throw new ConditionSyntaxError(
              `[OAR-EXPR-3] unsupported string escape \\${esc ?? ''}`,
              i,
            );
          }
          i += 2;
          continue;
        }
        if (ch === '\n' || ch === '\r') throw new ConditionSyntaxError('[OAR-EXPR-1] literal line break in string', i);
        value += ch;
        i++;
      }
      out.push({ t: 'string', value, at: start });
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (i < src.length && isDigit(src[i]!)) i++;
      // double = digit {digit} "." digit {digit} — a fractional part is required
      // on both sides of the point, and there is no exponent form.
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        i++;
        while (i < src.length && isDigit(src[i]!)) i++;
        if (src[i] === '.') throw new ConditionSyntaxError('malformed number literal', start);
        if (src[i] === 'e' || src[i] === 'E') {
          throw new ConditionSyntaxError('[OAR-EXPR-1] exponent notation is not part of the condition language', i);
        }
        out.push({ t: 'double', text: src.slice(start, i), at: start });
        continue;
      }
      if (src[i] === '.') throw new ConditionSyntaxError('malformed number literal', start);
      if (src[i] === 'e' || src[i] === 'E') {
        throw new ConditionSyntaxError('[OAR-EXPR-1] exponent notation is not part of the condition language', i);
      }
      if (src[i] === 'u' || src[i] === 'U') {
        throw new ConditionSyntaxError('[OAR-EXPR-1] an unsigned literal is not part of the condition language', i);
      }
      if (src[i] !== undefined && (isLetter(src[i]!) || src[i] === '_')) {
        throw new ConditionSyntaxError('malformed number literal', start);
      }
      out.push({ t: 'int', text: src.slice(start, i), at: start });
      continue;
    }
    if (isLetter(c) || c === '_') {
      // identifier = name { "." name } — a dotted identifier is a single name.
      const start = i;
      for (;;) {
        while (i < src.length && (isLetter(src[i]!) || isDigit(src[i]!) || src[i] === '_')) i++;
        if (src[i] === '.' && (isLetter(src[i + 1] ?? '') || src[i + 1] === '_')) {
          i++;
          continue;
        }
        break;
      }
      if (src[i] === '.') throw new ConditionSyntaxError('a "." must be followed by a name', i);
      out.push({ t: 'name', text: src.slice(start, i), at: start });
      continue;
    }
    if (c === '{' || c === '}') {
      throw new ConditionSyntaxError('[OAR-EXPR-1] a map literal is not part of the condition language', i);
    }
    if (c === '.') {
      throw new ConditionSyntaxError('[OAR-EXPR-2] there is no field-selection operator; index a map<string,string> or call a typed accessor', i);
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      out.push({ t: 'punct', text: two, at: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR.includes(c)) {
      out.push({ t: 'punct', text: c, at: i });
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      throw new ConditionSyntaxError(`bitwise ${JSON.stringify(c)} is not part of the condition language`, i);
    }
    if (c === '=') {
      throw new ConditionSyntaxError('[OAR-EXPR-1] assignment is not part of the condition language', i);
    }
    throw new ConditionSyntaxError(`unexpected character ${JSON.stringify(c)}`, i);
  }
  out.push({ t: 'eof', at: src.length });
  return out;
}

const RELOPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in']);

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
  private expect(text: string): void {
    const t = this.next();
    if (t.t !== 'punct' || t.text !== text) {
      throw new ConditionSyntaxError(`expected ${JSON.stringify(text)}`, t.at);
    }
  }

  parse(): Node {
    const node = this.ternary();
    const end = this.peek();
    if (end.t !== 'eof') throw new ConditionSyntaxError('unexpected trailing input', end.at);
    return node;
  }

  // ternary = disjunction [ "?" ternary ":" ternary ] — right-associative.
  private ternary(): Node {
    const cond = this.disjunction();
    if (this.atPunct('?')) {
      const at = this.next().at;
      const then = this.ternary();
      this.expect(':');
      const other = this.ternary();
      return { kind: 'ternary', cond, then, other, offset: at };
    }
    return cond;
  }

  private disjunction(): Node {
    let left = this.conjunction();
    while (this.atPunct('||')) {
      const at = this.next().at;
      left = { kind: 'binary', op: '||', left, right: this.conjunction(), offset: at };
    }
    return left;
  }

  private conjunction(): Node {
    let left = this.relation();
    while (this.atPunct('&&')) {
      const at = this.next().at;
      left = { kind: 'binary', op: '&&', left, right: this.relation(), offset: at };
    }
    return left;
  }

  // relation = addition [ relop addition ] — the grammar admits at most one
  // relational operator, so `a < b == c` is not derivable and is rejected.
  private relation(): Node {
    const left = this.addition();
    const t = this.peek();
    const op = t.t === 'punct' && RELOPS.has(t.text) ? t.text : t.t === 'name' && t.text === 'in' ? 'in' : null;
    if (op === null) return left;
    const at = this.next().at;
    const right = this.addition();
    const after = this.peek();
    const chained =
      (after.t === 'punct' && RELOPS.has(after.text)) || (after.t === 'name' && after.text === 'in');
    if (chained) {
      throw new ConditionSyntaxError('[OAR-EXPR-4] a relation admits at most one relational operator', after.at);
    }
    return { kind: 'binary', op: op as BinaryOp, left, right, offset: at };
  }

  private addition(): Node {
    let left = this.multiplication();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'punct' || (t.text !== '+' && t.text !== '-')) break;
      const at = this.next().at;
      left = { kind: 'binary', op: t.text as BinaryOp, left, right: this.multiplication(), offset: at };
    }
    return left;
  }

  private multiplication(): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'punct' || (t.text !== '*' && t.text !== '/' && t.text !== '%')) break;
      const at = this.next().at;
      left = { kind: 'binary', op: t.text as BinaryOp, left, right: this.unary(), offset: at };
    }
    return left;
  }

  // unary = [ "!" | "-" ] postfix — exactly zero or one prefix operator, so
  // `!!x` and `--x` are outside the grammar.
  private unary(): Node {
    const t = this.peek();
    if (t.t === 'punct' && (t.text === '!' || t.text === '-')) {
      const at = this.next().at;
      const after = this.peek();
      if (after.t === 'punct' && (after.text === '!' || after.text === '-')) {
        throw new ConditionSyntaxError('[OAR-EXPR-4] a unary operator may not be repeated', after.at);
      }
      // [OAR-EXPR-21] The magnitude 9223372036854775808 is admitted as the
      // immediate operand of unary minus, without which the least value of the
      // int type could not be written at all.
      if (t.text === '-' && after.t === 'int' && after.text === '9223372036854775808') {
        this.next();
        return { kind: 'unary', op: '-', operand: { kind: 'int', value: 9223372036854775808n, offset: after.at }, offset: at };
      }
      return { kind: 'unary', op: t.text as '!' | '-', operand: this.postfix(), offset: at };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.atPunct('[')) {
      const at = this.next().at;
      const index = this.ternary();
      this.expect(']');
      node = { kind: 'index', target: node, index, offset: at };
    }
    return node;
  }

  private primary(): Node {
    const t = this.next();
    if (t.t === 'punct' && t.text === '(') {
      const inner = this.ternary();
      this.expect(')');
      return inner;
    }
    if (t.t === 'punct' && t.text === '[') {
      const items: Node[] = [];
      if (!this.atPunct(']')) {
        for (;;) {
          items.push(this.ternary());
          if (this.atPunct(',')) {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expect(']');
      return { kind: 'list', items, offset: t.at };
    }
    if (t.t === 'int') {
      // [OAR-EXPR-21] An integer literal that does not fit 64 bits is rejected
      // at load rather than silently losing precision.
      const value = BigInt(t.text);
      if (value > 9223372036854775807n) {
        throw new ConditionSyntaxError(`[OAR-EXPR-21] integer literal ${t.text} does not fit int`, t.at);
      }
      return { kind: 'int', value, offset: t.at };
    }
    if (t.t === 'double') {
      const value = Number(t.text);
      // [OAR-EXPR-21] A double literal whose nearest binary64 value is not
      // finite is rejected at load, for the same reason [OAR-EXPR-14] refuses
      // to produce an infinity.
      if (!Number.isFinite(value)) {
        throw new ConditionSyntaxError(`double literal ${t.text} is not a finite binary64 value`, t.at);
      }
      return { kind: 'double', value, offset: t.at };
    }
    if (t.t === 'string') return { kind: 'string', value: t.value, offset: t.at };
    if (t.t === 'name') {
      if (t.text === 'true' || t.text === 'false') {
        return { kind: 'bool', value: t.text === 'true', offset: t.at };
      }
      if (t.text === 'in') throw new ConditionSyntaxError('"in" is a reserved word', t.at);
      if (this.atPunct('(')) {
        this.next();
        const args: Node[] = [];
        if (!this.atPunct(')')) {
          for (;;) {
            args.push(this.ternary());
            if (this.atPunct(',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect(')');
        return { kind: 'call', name: t.text, args, offset: t.at };
      }
      return { kind: 'ident', name: t.text, offset: t.at };
    }
    throw new ConditionSyntaxError('expected an expression', t.at);
  }
}

/** Parse a condition, or throw naming the offending construct and its offset. */
export function parse(src: string): Node {
  return new Parser(tokenize(src)).parse();
}
