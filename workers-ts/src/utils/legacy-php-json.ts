import { ServiceUnavailableException } from '@/utils/errors';

const MAX_PICS_CHARACTERS = 32_768;
const PHP_DEFAULT_JSON_DEPTH = 512;

/** The wire value after PHP json_decode(raw, true) followed by default
 * json_encode: decoded objects are associative arrays, including [] for {}.
 * Object insertion order matters when PHP decides whether an array is a list;
 * JSON.parse's reordered integer property names cannot prove that order. */
export function legacyPhpJsonDecodeWire(raw: string | null): unknown {
  if (raw === null) return null;
  if (raw.length > MAX_PICS_CHARACTERS) throw new ServiceUnavailableException('历史评价图片数据过大，请核对数据');
  try { JSON.parse(raw); } catch { return null; }

  let index = 0;
  const invalid = Symbol('PHP JSON decode failure');
  const unsupportedNumber = Symbol('PHP number cannot be represented safely');
  const numeric = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const whitespace = () => { while (index < raw.length && /[ \t\r\n]/.test(raw[index])) index++; };
  const string = (): string => {
    if (raw[index] !== '"') throw invalid;
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') { index += 2; continue; }
      if (raw[index++] === '"') {
        const value = JSON.parse(raw.slice(start, index)) as string;
        // PHP rejects an unpaired UTF-16 surrogate even when JS JSON.parse
        // accepts its escape. Valid surrogate pairs form a single codepoint.
        if (/[\ud800-\udfff]/u.test(value)) throw invalid;
        return value;
      }
    }
    throw invalid;
  };
  const value = (depth: number): unknown => {
    whitespace();
    const token = raw[index];
    if (token === '"') return string();
    if (token === '[' || token === '{') {
      // PHP's parser starts depth at 1 and checks >= max_depth before entering
      // each container: default512 permits511 nested containers, not512.
      // php-src PHP-8.2/ext/json/json_parser.y:32-37,283-284.
      if (depth >= PHP_DEFAULT_JSON_DEPTH) throw invalid;
      index++; whitespace();
      if (token === '[') {
        const rows: unknown[] = [];
        if (raw[index] === ']') { index++; return rows; }
        for (;;) {
          rows.push(value(depth + 1)); whitespace();
          if (raw[index] === ']') { index++; return rows; }
          if (raw[index++] !== ',') throw invalid;
        }
      }
      const entries = new Map<string, unknown>();
      if (raw[index] === '}') { index++; return []; }
      for (;;) {
        whitespace(); const key = string(); whitespace();
        if (raw[index++] !== ':') throw invalid;
        // Map.set overwrites a duplicate key without changing the position
        // established by its first appearance, as zend_symtable_update does.
        entries.set(key, value(depth + 1)); whitespace();
        if (raw[index] === '}') { index++; break; }
        if (raw[index++] !== ',') throw invalid;
      }
      let next = 0, isList = true;
      for (const key of entries.keys()) if (key !== String(next++)) { isList = false; break; }
      return isList ? [...entries.values()] : Object.fromEntries(entries);
    }
    for (const [literal, result] of [['null', null], ['true', true], ['false', false]] as const) {
      if (raw.startsWith(literal, index)) { index += literal.length; return result; }
    }
    numeric.lastIndex = index;
    const match = numeric.exec(raw);
    if (!match) throw invalid;
    const text = match[0], result = Number(text), integer = /^-?(?:0|[1-9]\d*)$/.test(text);
    index = numeric.lastIndex;
    if (!Number.isFinite(result) || integer && !Number.isSafeInteger(result)) return unsupportedNumber;
    // PHP parses a lexical integer -0 as integer zero. Finite decimal/exponent
    // tokens retain the same binary64 number representation as PHP floats.
    return integer && result === 0 ? 0 : result;
  };
  try {
    const result = value(1); whitespace();
    if (index !== raw.length) throw invalid;
    // Decode failures (Unicode/depth) take precedence over this wire boundary:
    // inspect the complete valid input and retained values. A duplicate key
    // which overwrites an unsafe number with a safe value remains representable.
    const check = (entry: unknown): void => {
      if (entry === unsupportedNumber) throw new ServiceUnavailableException('历史评价图片JSON数值无法安全精确表示，请核对数据');
      if (entry && typeof entry === 'object') for (const child of Object.values(entry)) check(child);
    };
    check(result);
    return result;
  } catch (error) {
    if (error === invalid) return null;
    throw error;
  }
}
