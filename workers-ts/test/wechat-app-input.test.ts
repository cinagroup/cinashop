import { describe, expect, it } from 'vitest';
import { WECHAT_APP_KEYS, isWechatAppConfigKey, parseWechatAppSave, parseWechatAppStoredText,
  wechatAppPending, wechatAppRequestId, wechatAppRevision, wechatAppStoredValue } from '../../view/common/wechatApp';
import { planWechatAppIntents, wechatAppWinningRows } from '../src/services/admin/AdminWechatAppIntentPlan';

const id = 'c1ba9549-9c31-4f98-a901-e36880263014', revision = 'a'.repeat(64);
const request = () => ({ request_id: id, revision, confirmed: true,
  fields: { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' } } });
const row = (id: number, menuName = 'wechat_app_appid', value: string | null = '"old-app"', sort = 0) =>
  ({ id, menuName, value, sort, isStore: 0, version: '1234', info: 'original metadata', status: 0 });

describe('native App exact two-field text/secret intent contract', () => {
  it('owns only the two native keys without website Open, official or mini credentials', () => {
    expect(WECHAT_APP_KEYS).toEqual(['wechat_app_appid', 'wechat_app_appsecret']);
    for (const key of WECHAT_APP_KEYS) expect(isWechatAppConfigKey(key)).toBe(true);
    for (const key of ['wechat_open_app_id', 'wechat_open_app_secret', 'wechat_appid', 'wechat_appsecret', 'routine_appId', 'wechat_app_appid ', null])
      expect(isWechatAppConfigKey(key)).toBe(false);
  });
  it('requires complete keep intents without echoing historical values', () => {
    expect(parseWechatAppSave(request()).fields).toEqual(request().fields);
    expect(planWechatAppIntents([], request()).changes).toEqual([]);
  });
  for (const value of ['', 'unformatted legacy AppID', ' '.repeat(257), 'line1\nline2', '🧭'.repeat(4998), 'x'.repeat(4998), 'a\0b']) {
    it(`preserves fixed-PHP optional text semantics: ${JSON.stringify(value).slice(0, 48)}`, () => {
      const body = request() as Record<string, any>;
      body.fields.wechat_app_appid = { action: 'replace', value };
      expect(parseWechatAppSave(body).fields.wechat_app_appid).toEqual({ action: 'replace', value });
      expect(JSON.parse(wechatAppStoredValue(value))).toBe(value);
    });
  }
  for (const value of ['x'.repeat(4999), '🧭'.repeat(4999), '"'.repeat(2500), '\0'.repeat(834), '\ud800', '\udfff', 'x\ud800y']) {
    it(`rejects serialized-capacity or invalid-Unicode input: ${JSON.stringify(value).slice(0, 48)}`, () => {
      expect(() => wechatAppStoredValue(value)).toThrow();
    });
  }
  it('counts JSON escaping and supplementary codepoints rather than input code units or bytes', () => {
    expect([...wechatAppStoredValue('"'.repeat(2499))]).toHaveLength(5000);
    expect([...wechatAppStoredValue('🧭'.repeat(4998))]).toHaveLength(5000);
    expect(new TextEncoder().encode(wechatAppStoredValue('🧭'.repeat(4998))).length).toBeGreaterThan(5000);
  });
  it('accepts a long or whitespace Secret without inventing the website replacement policy', () => {
    for (const value of ['s'.repeat(300), ' one two\nthree ', '\0']) {
      const body = request() as Record<string, any>;
      body.fields.wechat_app_appsecret = { action: 'replace', value };
      expect(parseWechatAppSave(body).fields.wechat_app_appsecret).toEqual({ action: 'replace', value });
    }
  });
  it('represents an empty Secret with an explicit clear and never a hidden replacement', () => {
    const body = request() as Record<string, any>;
    body.fields.wechat_app_appsecret = { action: 'clear' };
    expect(parseWechatAppSave(body).fields.wechat_app_appsecret).toEqual({ action: 'clear' });
    body.fields.wechat_app_appsecret = { action: 'replace', value: '' };
    expect(() => parseWechatAppSave(body)).toThrow('明确选择清空');
  });
  for (const field of ['request_id', 'revision', 'fields', 'confirmed']) {
    it(`rejects missing ${field}`, () => { const body = request() as Record<string, unknown>; delete body[field]; expect(() => parseWechatAppSave(body)).toThrow(); });
  }
  for (const patch of [{ settings: {} }, { database_credentials: true }, { arbitrary: 1 }, { confirmed: 'true' }, { request_id: id.toUpperCase() }, { revision: 'A'.repeat(64) }]) {
    it(`rejects cross-domain, extra or nonexact envelope ${Object.keys(patch).join(',')}`, () => {
      expect(() => parseWechatAppSave({ ...request(), ...patch })).toThrow();
    });
  }
  for (const invalid of [null, [], 'keep', { action: 'skip' }, { action: 'keep', value: 'secret' }, { action: 'replace' }, { action: 'replace', value: 1 }, { action: 'clear', value: '' }]) {
    it(`rejects ambiguous secret intent ${JSON.stringify(invalid)}`, () => {
      const body = request() as Record<string, any>; body.fields.wechat_app_appsecret = invalid;
      expect(() => parseWechatAppSave(body)).toThrow();
    });
  }
  it('rejects partial, mixed-domain and public clear fields', () => {
    for (const fields of [{ wechat_app_appid: { action: 'keep' } }, { ...request().fields, wechat_open_app_id: '' },
      { ...request().fields, wechat_app_appid: { action: 'clear' } }]) expect(() => parseWechatAppSave({ ...request(), fields })).toThrow();
  });
  it('rejects accessor, inherited, class and symbolic input before reading a value', () => {
    let invoked = false;
    const getter = { ...request() }; Object.defineProperty(getter, 'revision', { enumerable: true, get() { invoked = true; return revision; } });
    expect(() => parseWechatAppSave(getter)).toThrow(); expect(invoked).toBe(false);
    expect(() => parseWechatAppSave(Object.create(request()))).toThrow();
    expect(() => parseWechatAppSave(Object.assign(new Date(), request()))).toThrow();
    expect(() => parseWechatAppSave({ ...request(), [Symbol('secret')]: 'hidden' })).toThrow();
  });
  it('returns a detached intent object and a credential-free journal', () => {
    const body = request() as Record<string, any>; body.fields.wechat_app_appsecret = { action: 'replace', value: 'private replacement' };
    const parsed = parseWechatAppSave(body); body.fields.wechat_app_appsecret.value = 'mutated';
    expect(parsed.fields.wechat_app_appsecret).toEqual({ action: 'replace', value: 'private replacement' });
    expect(wechatAppPending(parsed, 19)).toEqual({ version: 1, domain: 'wechat_app', actor_id: 19, request_id: id });
    expect(JSON.stringify(wechatAppPending(parsed, 19))).not.toMatch(/private|revision|fields|token/u);
  });
  it('uses an exact lowercase UUIDv4 and a SHA-shaped revision', () => {
    expect(wechatAppRequestId(id)).toBe(true); expect(wechatAppRevision(revision)).toBe(true);
    for (const value of [id.toUpperCase(), id.replace('-4f98-', '-5f98-'), `${id}\n`, '', 4]) expect(wechatAppRequestId(value)).toBe(false);
    for (const value of [revision.toUpperCase(), revision + 'a', revision.slice(1), '', null]) expect(wechatAppRevision(value)).toBe(false);
  });
});

describe('native App legacy rows and write planning', () => {
  for (const [raw, expected] of [['""', ''], ['', ''], ['"line\\ntext"', 'line\ntext'], ['legacy-text', 'legacy-text'], ['  imported  ', '  imported  ']] as const) {
    it(`projects bounded text ${JSON.stringify(raw)}`, () => expect(parseWechatAppStoredText(raw)).toBe(expected));
  }
  for (const raw of [null, undefined, '{"secret":"do not expose"}', '["private"]', '"unterminated', '"\\ud800"', '"' + 'a'.repeat(4999) + '"']) {
    it(`does not project malformed or nontext stored value ${JSON.stringify(raw)?.slice(0, 40)}`, () => expect(parseWechatAppStoredText(raw)).toBeNull());
  }
  it('keeps missing, malformed, oversized and losing original rows without any write', () => {
    const rows = [row(1, 'wechat_app_appid', '{broken'), row(2, 'wechat_app_appsecret', 'old'.repeat(4000)), row(3, 'wechat_app_appid', null, -1)];
    const before = structuredClone(rows); expect(planWechatAppIntents(rows, request()).changes).toEqual([]); expect(rows).toEqual(before);
  });
  it('selects highest sort then highest identity independently of row input order', () => {
    const rows = [row(1, 'wechat_app_appid', 'a', 2), row(6, 'wechat_app_appid', 'b', 2), row(20, 'wechat_app_appid', 'c', 1)];
    expect(wechatAppWinningRows(rows).get('wechat_app_appid')).toBe(rows[1]);
    expect(wechatAppWinningRows([...rows].reverse()).get('wechat_app_appid')).toBe(rows[1]);
  });
  it('changes only explicit winner raw values and leaves shadow metadata untouched', () => {
    const rows = [row(1), row(2), row(3, 'wechat_app_appsecret', 'private')]; const before = structuredClone(rows);
    const body = request() as Record<string, any>; body.fields.wechat_app_appid = { action: 'replace', value: 'new-app' };
    const plan = planWechatAppIntents(rows, body); expect(plan.changes).toEqual([{ key: 'wechat_app_appid', winner: rows[1], raw: '"new-app"' }]);
    expect(plan.appIdValueChanged).toBe(true); expect(rows).toEqual(before);
  });
  it('does not rewrite an exact explicit value, but canonicalizes a deliberately replaced legacy raw string', () => {
    const body = request() as Record<string, any>; body.fields.wechat_app_appid = { action: 'replace', value: 'old-app' };
    expect(planWechatAppIntents([row(1)], body).changes).toEqual([]);
    const plan = planWechatAppIntents([row(1, 'wechat_app_appid', 'old-app')], body);
    expect(plan.changes).toHaveLength(1); expect(plan.appIdValueChanged).toBe(false);
  });
  it('marks missing inserts explicitly and does not invent any seed id or metadata', () => {
    const body = request() as Record<string, any>; body.fields.wechat_app_appsecret = { action: 'clear' };
    expect(planWechatAppIntents([], body).changes).toEqual([{ key: 'wechat_app_appsecret', winner: null, raw: '""' }]);
  });
  it('refuses complete histories over64 rows or1MiB rather than returning a prefix', () => {
    expect(() => wechatAppWinningRows(Array.from({ length: 65 }, (_, index) => row(index + 1)))).toThrow('完整读取容量');
    expect(() => wechatAppWinningRows([row(1, 'wechat_app_appid', 'x'.repeat(1024 * 1024))])).toThrow('完整读取容量');
  });
  for (const patch of [{ isStore: 1 }, { id: 0 }, { id: 0.5 }, { sort: Number.NaN }, { menuName: 'wechat_open_app_id' }, { version: '' }, { value: 4 }]) {
    it(`rejects a mismatched source row ${Object.keys(patch).join(',')}${'id' in patch ? '=' + String(patch.id) : ''}`, () => expect(() => wechatAppWinningRows([{ ...row(1), ...patch } as any])).toThrow());
  }
  it('refuses duplicate physical identities', () => expect(() => wechatAppWinningRows([row(1), row(1)])).toThrow('行身份重复'));
});
