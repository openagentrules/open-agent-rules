import { createHash } from 'node:crypto';

/** Canonical finite binary64 decimal [OAR-COPY-10]. */
export function canonicalDouble(value: number): string {
  if (!Number.isFinite(value)) throw new Error('[OAR-FACT-23] non-finite double');
  if (value === 0) return '0.0';
  const negative = value < 0;
  const [mantissa, exponent] = Math.abs(value).toString().split('e');
  const parts = mantissa!.split('.');
  const digits = parts.join('');
  const point = parts[0]!.length + Number(exponent ?? 0);
  const decimal = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${'0'.repeat(point - digits.length)}.0`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? '-' : '') + decimal;
}

function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, c => c.codePointAt(0)!);
  const y = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

function quoted(value: string): string {
  return '"' + value.replace(/["\\\u0000-\u001f]/g, c => {
    if (c === '"' || c === '\\') return '\\' + c;
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  }) + '"';
}

/** Canonical JSON for tool-call identity [OAR-FACT-28]. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return canonicalDouble(value);
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isFinite(number) || BigInt(number) !== value) {
      throw new Error('[OAR-FACT-28] integer loses precision');
    }
    return canonicalDouble(number);
  }
  if (typeof value === 'string') return quoted(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort(compareCodePoints)
      .map(key => quoted(key) + ':' + canonicalJson(object[key])).join(',') + '}';
  }
  throw new Error('[OAR-FACT-28] tool arguments must be JSON');
}

export function toolFingerprint(tool: string, args: Readonly<Record<string, unknown>>): string {
  return tool === '' ? '' : createHash('sha256')
    .update('oar-tool-1.0\0').update(canonicalJson([tool, args]), 'utf8').digest('hex');
}
