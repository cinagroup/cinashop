import { Buffer } from 'node:buffer';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWechatRoutineStoredText } from '../../view/common/wechatRoutine';
import {
  ADMIN_WECHAT_ROUTINE_STORED_TEXT_BODY,
  ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION,
  ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE,
  ADMIN_WECHAT_ROUTINE_STORED_TEXT_SQL,
} from '@/migrations/adminWechatRoutineStoredText';
import { financePostgres } from './helpers/financePostgres';

type Sample = { label: string; raw: string | null };
const samples: Sample[] = [
  { label: 'SQL NULL', raw: null },
  { label: 'empty legacy', raw: '' },
  { label: 'untrimmed legacy', raw: '  owned legacy value  ' },
  { label: 'legacy JSON whitespace only', raw: ' \t\r\n' },
  { label: 'legacy quotes and backslashes', raw: 'owned "quoted" \\ path' },
  { label: 'SQL-shaped legacy remains data', raw: "owned '; SELECT 1; -- text" },
  { label: 'empty JSON string', raw: '""' },
  { label: 'JSON string with JSON surrounding whitespace', raw: ' \t\r\n"  untrimmed  "\t\n' },
  { label: 'all simple JSON escapes', raw: String.raw`"\"\\\/\b\f\n\r\t"` },
  { label: 'escaped NUL', raw: String.raw`"\u0000"` },
  { label: 'escaped NUL between text', raw: String.raw`"before\u0000after\u0000"` },
  { label: 'escaped BMP and mixed-case hex', raw: String.raw`"\u0041\u4e2D\u03a9"` },
  { label: 'escaped first supplementary scalar', raw: String.raw`"\uD800\uDC00"` },
  { label: 'escaped final supplementary scalar', raw: String.raw`"\uDBFF\uDFFF"` },
  { label: 'mixed-case paired surrogates', raw: String.raw`"\ud83D\uDe00"` },
  { label: 'literal supplementary scalars', raw: JSON.stringify('😀𠀀' + String.fromCodePoint(0x10ffff)) },
  { label: 'Unicode line separators inside JSON', raw: JSON.stringify('\u2028\u2029') },
  { label: 'Unicode noncharacters remain scalars', raw: JSON.stringify('\ufffe\uffff' + String.fromCodePoint(0x10ffff)) },
  { label: 'lone high surrogate escape', raw: String.raw`"\uD800"` },
  { label: 'lone low surrogate escape', raw: String.raw`"\uDC00"` },
  { label: 'two high surrogate escapes', raw: String.raw`"\uD800\uDBFF"` },
  { label: 'low then high surrogate escapes', raw: String.raw`"\uDC00\uD800"` },
  { label: 'high surrogate followed by BMP escape', raw: String.raw`"\uD800\u0041"` },
  { label: 'high surrogate followed by literal supplementary scalar', raw: '"\\uD800😀"' },
  { label: 'paired surrogate followed by lone low', raw: String.raw`"\uD800\uDC00\uDFFF"` },
  { label: 'incomplete Unicode escape', raw: String.raw`"\u123"` },
  { label: 'nonhex Unicode escape', raw: String.raw`"\u12x4"` },
  { label: 'incomplete high surrogate pair', raw: String.raw`"\uD800\uDC0"` },
  { label: 'unknown JSON escape', raw: String.raw`"\q"` },
  { label: 'unterminated JSON string', raw: '"owned' },
  { label: 'unterminated escape', raw: '"owned\\' },
  { label: 'JSON string trailing token', raw: '"owned" true' },
  { label: 'adjacent JSON strings', raw: '"first""second"' },
  { label: 'raw newline in JSON string', raw: '"owned\nvalue"' },
  { label: 'raw tab in JSON string', raw: '"owned\tvalue"' },
  { label: 'valid object', raw: '{"value":"owned"}' },
  { label: 'valid array', raw: '["owned"]' },
  { label: 'malformed object', raw: '{owned' },
  { label: 'malformed array', raw: '[owned' },
  { label: 'deep array import is rejected without recursive decoding', raw: '['.repeat(2400) + ']'.repeat(2400) },
  { label: 'valid JSON containing an escaped NUL in an object', raw: String.raw`{"value":"\u0000"}` },
  { label: 'valid JSON containing a lone surrogate in an array', raw: String.raw`["\uD800"]` },
  { label: 'JSON true', raw: 'true' },
  { label: 'JSON false', raw: ' \tfalse\r\n' },
  { label: 'JSON null', raw: 'null' },
  { label: 'JSON zero', raw: '0' },
  { label: 'JSON negative zero', raw: '-0' },
  { label: 'JSON fraction and exponent', raw: '-12.25e+30' },
  { label: 'JSON enormous exponent is still a nonstring', raw: '1e999999' },
  { label: 'large JSON integer remains nonstring', raw: '9'.repeat(1000) },
  { label: 'legacy leading-zero number shape', raw: '01' },
  { label: 'legacy positive-sign number shape', raw: '+1' },
  { label: 'legacy incomplete decimal', raw: '1.' },
  { label: 'legacy incomplete exponent', raw: '1e' },
  { label: 'legacy hexadecimal shape', raw: '0x10' },
  { label: 'legacy NaN', raw: 'NaN' },
  { label: 'legacy Infinity', raw: 'Infinity' },
  { label: 'legacy undefined', raw: 'undefined' },
  { label: 'legacy uppercase true', raw: 'TRUE' },
  { label: 'legacy multiple scalar tokens', raw: 'true false' },
  { label: 'legacy NEL is not ECMAScript whitespace', raw: '\u0085"owned"' },
  { label: 'legacy Mongolian vowel separator is not ECMAScript whitespace', raw: '\u180e"owned"' },
  { label: 'plain canonical capacity boundary', raw: 'x'.repeat(4998) },
  { label: 'plain canonical capacity overflow below raw bound', raw: 'x'.repeat(4999) },
  { label: 'plain at raw bound still fails canonical capacity', raw: 'x'.repeat(5000) },
  { label: 'plain raw capacity overflow', raw: 'x'.repeat(5001) },
  { label: 'supplementary plain uses codepoints rather than bytes', raw: '😀'.repeat(4998) },
  { label: 'supplementary canonical overflow', raw: '😀'.repeat(4999) },
  { label: 'quoted supplementary raw capacity boundary', raw: JSON.stringify('😀'.repeat(4998)) },
  { label: 'quoted supplementary raw capacity overflow', raw: JSON.stringify('😀'.repeat(4999)) },
  { label: 'escaped raw capacity boundary', raw: '"' + String.raw`\u0061`.repeat(833) + '"' },
  { label: 'escaped raw capacity overflow', raw: '"' + String.raw`\u0061`.repeat(834) + '"' },
  { label: 'plain control canonical capacity boundary', raw: 'x' + '\u0001'.repeat(832) },
  { label: 'plain control canonical capacity overflow', raw: 'x' + '\u0001'.repeat(833) },
  { label: 'plain quote canonical capacity boundary', raw: 'x' + '"'.repeat(2498) },
  { label: 'plain quote canonical capacity overflow', raw: 'x' + '"'.repeat(2499) },
  { label: 'plain backslash canonical capacity boundary', raw: 'x' + '\\'.repeat(2498) },
  { label: 'plain backslash canonical capacity overflow', raw: 'x' + '\\'.repeat(2499) },
];

// Every control that PostgreSQL text can carry is compared independently. NUL
// enters through the JSON escape case above, never as an invalid text parameter.
for (let code = 1; code < 32; code++) {
  const value = String.fromCharCode(code);
  samples.push({ label: `escaped control U+${code.toString(16).padStart(4, '0')}`, raw: JSON.stringify(value) });
  samples.push({ label: `plain control U+${code.toString(16).padStart(4, '0')}`, raw: 'owned' + value });
}
const ecmaWhitespace = [9, 10, 11, 12, 13, 32, 160, 5760,
  ...Array.from({ length: 11 }, (_, index) => 8192 + index), 8232, 8233, 8239, 8287, 12288, 65279];
for (const code of ecmaWhitespace) {
  const whitespace = String.fromCodePoint(code), label = code.toString(16).padStart(4, '0');
  samples.push({ label: `quoted prefix whitespace U+${label}`, raw: whitespace + '"owned"' });
  samples.push({ label: `object prefix whitespace U+${label}`, raw: whitespace + '{broken' });
  samples.push({ label: `array prefix whitespace U+${label}`, raw: whitespace + '[broken' });
  samples.push({ label: `quoted suffix whitespace U+${label}`, raw: '"owned"' + whitespace });
  samples.push({ label: `plain prefix whitespace U+${label}`, raw: whitespace + 'owned' });
}

/** This suite deliberately has no memory fallback: PG16's actual json input
 * validation, bytea, UTF-8, function flags and ACL are part of the contract. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine stored text bytes on owned native PostgreSQL16', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => {
    fixture = await financePostgres([], { namespace: 'public' });
    if (typeof fixture.db.$client !== 'function') throw Error('Routine stored text contract requires explicit native PostgreSQL16');
    const [host] = await fixture.db.execute<{ utf8: boolean; pg16: boolean }>(sql`SELECT
      current_setting('server_encoding')='UTF8' AS utf8,
      current_setting('server_version_num')::integer/10000=16 AS pg16`);
    expect(host).toEqual({ utf8: true, pg16: true });
    await fixture.exec(ADMIN_WECHAT_ROUTINE_STORED_TEXT_SQL);
  });
  afterAll(async () => { await fixture?.close(); });

  async function decode(raw: string | null) {
    const [row] = await fixture.db.execute<{ bytes: Uint8Array | null; hex: string | null }>(sql`SELECT
      decoded.bytes, encode(decoded.bytes, 'hex') AS hex FROM
      (SELECT public.cinashop_wechat_routine_text_bytes_v1(${raw}::text) AS bytes) decoded`);
    return row;
  }

  it('installs the exact immutable strict invoker function with owner-only EXECUTE', async () => {
    expect(ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE).toBe('public.cinashop_wechat_routine_text_bytes_v1(text)');
    const [catalog] = await fixture.db.execute<Record<string, unknown>>(sql`SELECT
      p.proname AS name, p.prosrc AS body, p.provolatile='i' AS immutable,
      p.proisstrict AS strict, NOT p.prosecdef AS invoker,
      p.prorettype='pg_catalog.bytea'::regtype AS returns_bytea,
      p.pronargs=1 AND p.proargtypes='25'::oidvector AND p.proargnames=ARRAY['p_raw'] AS arguments,
      p.proconfig=ARRAY['search_path=pg_catalog'] AS search_path,
      l.lanname='plpgsql' AS language, p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner,
      (SELECT count(*)=1 AND bool_and(a.grantee=p.proowner AND a.grantor=p.proowner
        AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS owner_only_execute,
      NOT EXISTS(SELECT 1 FROM pg_proc other WHERE other.pronamespace=p.pronamespace
        AND other.proname=p.proname AND other.oid<>p.oid) AS no_overloads
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure(${ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE})`);
    expect(catalog).toEqual({ name: ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION,
      body: ADMIN_WECHAT_ROUTINE_STORED_TEXT_BODY, immutable: true, strict: true, invoker: true,
      returns_bytea: true, arguments: true, search_path: true, language: true, owner: true,
      owner_only_execute: true, no_overloads: true });
  });

  it.each(samples)('matches the actual TS parser and Buffer UTF-8 bytes: $label', async ({ raw }) => {
    const expected = parseWechatRoutineStoredText(raw), actual = await decode(raw);
    if (expected === null) {
      expect(actual).toEqual({ bytes: null, hex: null });
    } else {
      const bytes = Buffer.from(expected, 'utf8');
      expect(actual.bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(actual.bytes!)).toEqual(Array.from(bytes));
      expect(actual.hex).toBe(bytes.toString('hex'));
    }
  });

  it('keeps zero bytes and supplementary UTF-8 without a PostgreSQL text intermediate', async () => {
    const actual = await decode(String.raw`"\u0000\uD83D\uDE00\u0000"`);
    expect(actual.hex).toBe('00f09f988000');
    expect(Array.from(actual.bytes!)).toEqual([0, 240, 159, 152, 128, 0]);
    expect(await decode('')).toMatchObject({ hex: '' });
  });
});
