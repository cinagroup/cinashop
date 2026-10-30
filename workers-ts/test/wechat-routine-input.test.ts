import { describe, expect, it } from 'vitest';
import { WECHAT_ROUTINE_KEYS, isWechatRoutineConfigKey, parseWechatRoutineSave, parseWechatRoutineStoredText,
  parseWechatRoutineStoredRadio, wechatRoutinePending, wechatRoutineRequestId, wechatRoutineRevision,
  wechatRoutineStoredValue, wechatRoutineStoredRadioValue } from '../../view/common/wechatRoutine';
import { planWechatRoutineIntents, wechatRoutineWinningRows, WECHAT_ROUTINE_MAX_CONFIG_ROWS } from '../src/services/admin/AdminWechatRoutineIntentPlan';
import { WECHAT_ROUTINE_INSERT_METADATA } from '../src/services/admin/AdminWechatRoutineMetadata';

const id = 'c1ba9549-9c31-4f98-a901-e36880263014', revision = 'a'.repeat(64);
const request = () => ({ request_id: id, revision, confirmed: true,
  fields: { routine_appId: { action: 'keep' }, routine_appsecret: { action: 'keep' }, routine_name: { action: 'keep' },
    routine_contact_type: { action: 'keep' }, store_user_avatar: { action: 'keep' } } });
const row = (id: number, menuName = 'routine_appId', value: string | null = '"old-mini"', sort = 0) =>
  ({ id, menuName, value, sort, isStore: 0, version: '1234', info: 'original metadata', status: 0, configTabId: 999 });

describe('Mini Program exact five-field intent contract', () => {
  it('owns only the five fixed-PHP fields and excludes the two existing authors', () => {
    expect(WECHAT_ROUTINE_KEYS).toEqual(['routine_appId', 'routine_appsecret', 'routine_name', 'routine_contact_type', 'store_user_avatar']);
    for (const key of WECHAT_ROUTINE_KEYS) expect(isWechatRoutineConfigKey(key)).toBe(true);
    for (const key of ['routine_auth_type', 'order_shipping_open', 'store_user_agreement', 'wechat_app_appid', 'routine_appid', 'routine_appId ', null])
      expect(isWechatRoutineConfigKey(key)).toBe(false);
  });
  it('accepts a complete keep envelope and never fills missing fields with seed defaults', () => {
    expect(parseWechatRoutineSave(request()).fields).toEqual(request().fields);
    expect(planWechatRoutineIntents([], request()).changes).toEqual([]);
  });
  for (const key of ['routine_appId', 'routine_name'] as const) {
    for (const [label, value] of [['empty', ''], ['unformatted', ' legacy mini text '], ['newline', 'line1\nline2'],
      ['supplementary boundary', '🧭'.repeat(4998)], ['NUL', 'a\0b']] as const) {
      it(`preserves optional ${key} text without trimming: ${label}`, () => {
        const body = request() as Record<string, any>; body.fields[key] = { action: 'replace', value };
        expect(parseWechatRoutineSave(body).fields[key]).toEqual({ action: 'replace', value });
        expect(JSON.parse(wechatRoutineStoredValue(value))).toBe(value);
      });
    }
  }
  it('counts serialized escapes/codepoints rather than field code units or UTF8 bytes', () => {
    expect([...wechatRoutineStoredValue('x'.repeat(4998))]).toHaveLength(5000);
    expect([...wechatRoutineStoredValue('"'.repeat(2499))]).toHaveLength(5000);
    expect([...wechatRoutineStoredValue('🧭'.repeat(4998))]).toHaveLength(5000);
    expect(new TextEncoder().encode(wechatRoutineStoredValue('🧭'.repeat(4998))).length).toBeGreaterThan(5000);
  });
  for (const [label, value] of [['ASCII overflow', 'x'.repeat(4999)], ['supplementary overflow', '🧭'.repeat(4999)],
    ['quote overflow', '"'.repeat(2500)], ['escaped NUL overflow', '\0'.repeat(834)], ['lone high', '\ud800'],
    ['lone low', '\udfff'], ['broken pair', 'x\ud800y']] as const) {
    it(`rejects invalid Unicode or serialized capacity: ${label}`, () => expect(() => wechatRoutineStoredValue(value)).toThrow());
  }
  it('requires Secret clear explicitly but preserves long/whitespace replacement text', () => {
    const body = request() as Record<string, any>;
    for (const value of ['s'.repeat(300), ' one two\nthree ', '\0']) {
      body.fields.routine_appsecret = { action: 'replace', value };
      expect(parseWechatRoutineSave(body).fields.routine_appsecret).toEqual({ action: 'replace', value });
    }
    body.fields.routine_appsecret = { action: 'clear' };
    expect(parseWechatRoutineSave(body).fields.routine_appsecret).toEqual({ action: 'clear' });
    body.fields.routine_appsecret = { action: 'replace', value: '' };
    expect(() => parseWechatRoutineSave(body)).toThrow('明确选择清空');
  });
  for (const key of ['routine_contact_type', 'store_user_avatar'] as const) {
    it(`uses numeric PHP radio values and unquoted JSON storage for ${key}`, () => {
      const body = request() as Record<string, any>;
      for (const value of [0, 1] as const) {
        body.fields[key] = { action: 'replace', value };
        expect(parseWechatRoutineSave(body).fields[key]).toEqual({ action: 'replace', value });
        expect(wechatRoutineStoredRadioValue(value)).toBe(String(value));
      }
    });
    for (const [label, value] of [['string0', '0'], ['string1', '1'], ['false', false], ['true', true],
      ['null', null], ['missing', undefined], ['out of range', 2], ['negative', -1], ['NaN', NaN], ['object', {}]] as const) {
      it(`rejects coercion or unsupported ${key} replacement: ${label}`, () => {
        const body = request() as Record<string, any>; body.fields[key] = { action: 'replace', value };
        expect(() => parseWechatRoutineSave(body)).toThrow();
      });
    }
  }
  it('requires every exact envelope and field key without another author or account-policy flag', () => {
    for (const key of ['request_id', 'revision', 'fields', 'confirmed']) {
      const body = request() as Record<string, unknown>; delete body[key]; expect(() => parseWechatRoutineSave(body)).toThrow();
    }
    for (const key of WECHAT_ROUTINE_KEYS) {
      const body = request() as Record<string, any>; delete body.fields[key]; expect(() => parseWechatRoutineSave(body)).toThrow();
    }
    for (const extra of ['routine_auth_type', 'order_shipping_open', 'store_user_agreement', 'wechat_app_appid'])
      expect(() => parseWechatRoutineSave({ ...request(), fields: { ...request().fields, [extra]: { action: 'keep' } } })).toThrow();
    for (const patch of [{ arbitrary: 1 }, { history_empty: true }, { confirmed: 'true' }, { request_id: id.toUpperCase() }, { revision: 'A'.repeat(64) }])
      expect(() => parseWechatRoutineSave({ ...request(), ...patch })).toThrow();
  });
  it('rejects public clear, ambiguous intents and trailing intent data', () => {
    for (const key of ['routine_appId', 'routine_name', 'routine_contact_type', 'store_user_avatar']) {
      const body = request() as Record<string, any>; body.fields[key] = { action: 'clear' }; expect(() => parseWechatRoutineSave(body)).toThrow();
    }
    for (const invalid of [null, [], 'keep', { action: 'skip' }, { action: 'keep', value: 'private' },
      { action: 'replace' }, { action: 'replace', value: 1 }, { action: 'clear', value: '' }]) {
      const body = request() as Record<string, any>; body.fields.routine_appsecret = invalid; expect(() => parseWechatRoutineSave(body)).toThrow();
    }
  });
  it('rejects accessors, inherited/nonenumerable/symbolic data before invoking a getter', () => {
    let invoked = false;
    const body = request(); Object.defineProperty(body.fields.routine_appId, 'action', { enumerable: true, get() { invoked = true; return 'keep'; } });
    expect(() => parseWechatRoutineSave(body)).toThrow(); expect(invoked).toBe(false);
    expect(() => parseWechatRoutineSave(Object.create(request()))).toThrow();
    expect(() => parseWechatRoutineSave(Object.assign(new Date(), request()))).toThrow();
    expect(() => parseWechatRoutineSave({ ...request(), [Symbol('private')]: 'hidden' })).toThrow();
    const hidden = request(); Object.defineProperty(hidden, 'extra', { value: true }); expect(() => parseWechatRoutineSave(hidden)).toThrow();
  });
  it('detaches all replacement intents and journals only request identity', () => {
    const body = request() as Record<string, any>;
    body.fields.routine_appsecret = { action: 'replace', value: 'private replacement' };
    body.fields.routine_contact_type = { action: 'replace', value: 1 };
    const parsed = parseWechatRoutineSave(body); body.fields.routine_appsecret.value = 'mutated'; body.fields.routine_contact_type.value = 0;
    expect(parsed.fields.routine_appsecret).toEqual({ action: 'replace', value: 'private replacement' });
    expect(parsed.fields.routine_contact_type).toEqual({ action: 'replace', value: 1 });
    expect(wechatRoutinePending(parsed, 19)).toEqual({ version: 1, domain: 'wechat_routine', actor_id: 19, request_id: id });
    expect(JSON.stringify(wechatRoutinePending(parsed, 19))).not.toMatch(/private|revision|fields|token/u);
  });
  it('requires lowercase UUIDv4 and a lowercase SHA-shaped revision', () => {
    expect(wechatRoutineRequestId(id)).toBe(true); expect(wechatRoutineRevision(revision)).toBe(true);
    for (const value of [id.toUpperCase(), id.replace('-4f98-', '-5f98-'), `${id}\n`, '', 4]) expect(wechatRoutineRequestId(value)).toBe(false);
    for (const value of [revision.toUpperCase(), revision + 'a', revision.slice(1), '', null]) expect(wechatRoutineRevision(value)).toBe(false);
  });
});

describe('Mini Program legacy projection and pure intent planning', () => {
  it('projects bounded legacy text without trimming or accepting nontext JSON', () => {
    for (const [raw, expected] of [['""', ''], ['', ''], ['"line\\ntext"', 'line\ntext'], ['legacy-text', 'legacy-text'], ['  imported  ', '  imported  ']] as const)
      expect(parseWechatRoutineStoredText(raw)).toBe(expected);
    for (const raw of [null, undefined, '{"private":1}', '["private"]', '0', 'true', 'null', '"unterminated', '"\\ud800"', '"' + 'a'.repeat(4999) + '"'])
      expect(parseWechatRoutineStoredText(raw)).toBeNull();
  });
  it('projects numeric/legacy string radios but never guesses malformed or other values', () => {
    for (const [raw, expected] of [['0', 0], ['1', 1], ['"0"', 0], ['"1"', 1], [' 1 ', 1]] as const)
      expect(parseWechatRoutineStoredRadio(raw)).toBe(expected);
    for (const raw of [null, undefined, '', '2', '-1', '01', 'true', 'null', '" 1"', '[1]', '{"value":1}', '"\\ud800"'])
      expect(parseWechatRoutineStoredRadio(raw)).toBeNull();
  });
  it('keeps missing, unreadable, oversized and shadow values without changing metadata', () => {
    const rows = [row(1, 'routine_appId', '{broken'), row(2, 'routine_appsecret', 'old'.repeat(4000)),
      row(3, 'routine_contact_type', 'unsupported'), row(4, 'routine_appId', null, -1)];
    const before = structuredClone(rows), plan = planWechatRoutineIntents(rows, request());
    expect(plan.changes).toEqual([]); expect(plan.appIdValueChanged).toBe(false); expect(plan.credentialMaterialChanged).toBe(false); expect(rows).toEqual(before);
  });
  it('selects sort DESC/id DESC without changing original row order or references', () => {
    const rows = [row(1, 'routine_appId', 'a', 2), row(6, 'routine_appId', 'b', 2), row(20, 'routine_appId', 'c', 1)];
    const before = structuredClone(rows);
    expect(wechatRoutineWinningRows(rows).get('routine_appId')).toBe(rows[1]);
    expect(wechatRoutineWinningRows([...rows].reverse()).get('routine_appId')).toBe(rows[1]); expect(rows).toEqual(before);
  });
  it('updates only explicit winners, preserving every losing row and metadata', () => {
    const rows = [row(1), row(2), row(3, 'routine_appsecret', 'private')], before = structuredClone(rows);
    const body = request() as Record<string, any>; body.fields.routine_appId = { action: 'replace', value: 'new-mini' };
    const plan = planWechatRoutineIntents(rows, body);
    expect(plan.changes).toEqual([{ key: 'routine_appId', winner: rows[1], raw: '"new-mini"' }]);
    expect(plan.appIdValueChanged).toBe(true); expect(plan.credentialMaterialChanged).toBe(true); expect(rows).toEqual(before);
  });
  it('distinguishes raw canonicalization from actual AppID or Secret material changes', () => {
    const body = request() as Record<string, any>;
    body.fields.routine_appId = { action: 'replace', value: 'old-mini' };
    body.fields.routine_appsecret = { action: 'replace', value: 'old-secret' };
    const plan = planWechatRoutineIntents([row(1, 'routine_appId', 'old-mini'), row(2, 'routine_appsecret', 'old-secret')], body);
    expect(plan.changes.map(x => x.raw)).toEqual(['"old-mini"', '"old-secret"']);
    expect(plan.appIdValueChanged).toBe(false); expect(plan.credentialMaterialChanged).toBe(false);
    expect(planWechatRoutineIntents([row(1), row(2, 'routine_appsecret', '"old-secret"')], body).changes).toEqual([]);
  });
  it('marks Secret replacement/clear separately from AppID changes', () => {
    const body = request() as Record<string, any>; body.fields.routine_appsecret = { action: 'replace', value: 'new-secret' };
    const rows = [row(1), row(2, 'routine_appsecret', '"old-secret"')];
    for (const intent of [{ action: 'replace', value: 'new-secret' }, { action: 'clear' }]) {
      body.fields.routine_appsecret = intent; const plan = planWechatRoutineIntents(rows, body);
      expect(plan.appIdValueChanged).toBe(false); expect(plan.credentialMaterialChanged).toBe(true);
    }
  });
  it('does not classify an unreadable existing credential as an unchanged empty value', () => {
    const body = request() as Record<string, any>; body.fields.routine_appId = { action: 'replace', value: '' };
    expect(planWechatRoutineIntents([row(1, 'routine_appId', null)], body).appIdValueChanged).toBe(true);
    body.fields.routine_appId = { action: 'keep' }; body.fields.routine_appsecret = { action: 'clear' };
    expect(planWechatRoutineIntents([row(1, 'routine_appsecret', '{broken')], body).credentialMaterialChanged).toBe(true);
  });
  it('marks first nonempty AppID material but does not invent material for a missing empty pair', () => {
    const body = request() as Record<string, any>; body.fields.routine_appId = { action: 'replace', value: 'first-mini' };
    expect(planWechatRoutineIntents([], body).appIdValueChanged).toBe(true);
    body.fields.routine_appId.value = ''; body.fields.routine_appsecret = { action: 'clear' };
    const plan = planWechatRoutineIntents([], body); expect(plan.changes).toHaveLength(2); expect(plan.credentialMaterialChanged).toBe(false);
  });
  it('does not mark policy/name changes as credential rotation or rewrite kept legacy radio strings', () => {
    const body = request() as Record<string, any>; body.fields.routine_name = { action: 'replace', value: '新名称' };
    body.fields.store_user_avatar = { action: 'replace', value: 1 };
    const rows = [row(1, 'routine_contact_type', '"1"'), row(2, 'store_user_avatar', '"1"')];
    const plan = planWechatRoutineIntents(rows, body);
    expect(plan.changes.map(x => [x.key, x.raw])).toEqual([['routine_name', '"新名称"'], ['store_user_avatar', '1']]);
    expect(plan.appIdValueChanged).toBe(false); expect(plan.credentialMaterialChanged).toBe(false);
  });
  it('emits all five missing inserts without seed IDs, default values or metadata mutation', () => {
    const body = request() as Record<string, any>;
    body.fields = { routine_appId: { action: 'replace', value: 'first' }, routine_appsecret: { action: 'clear' },
      routine_name: { action: 'replace', value: '' }, routine_contact_type: { action: 'replace', value: 1 }, store_user_avatar: { action: 'replace', value: 0 } };
    expect(planWechatRoutineIntents([], body).changes).toEqual([
      { key: 'routine_appId', winner: null, raw: '"first"' }, { key: 'routine_appsecret', winner: null, raw: '""' },
      { key: 'routine_name', winner: null, raw: '""' }, { key: 'routine_contact_type', winner: null, raw: '1' },
      { key: 'store_user_avatar', winner: null, raw: '0' },
    ]);
  });
  it('refuses incomplete row/byte histories rather than using a sorted prefix', () => {
    const boundary = Array.from({ length: WECHAT_ROUTINE_MAX_CONFIG_ROWS }, (_, i) => row(i + 1));
    expect(wechatRoutineWinningRows(boundary).size).toBe(1);
    expect(() => wechatRoutineWinningRows([...boundary, row(boundary.length + 1)])).toThrow('完整读取容量');
    expect(() => wechatRoutineWinningRows([row(1, 'routine_appId', 'x'.repeat(1024 * 1024))])).toThrow('完整读取容量');
  });
  for (const patch of [{ isStore: 1 }, { id: 0 }, { id: 0.5 }, { sort: Number.NaN }, { menuName: 'routine_auth_type' }, { version: '' }, { value: 4 }]) {
    it(`rejects mismatched source rows ${Object.keys(patch).join(',')}${'id' in patch ? '=' + String(patch.id) : ''}`, () =>
      expect(() => wechatRoutineWinningRows([{ ...row(1), ...patch } as any])).toThrow());
  }
  it('refuses duplicate physical row identities even across different keys', () =>
    expect(() => wechatRoutineWinningRows([row(1), row(1, 'routine_name')])).toThrow('行身份重复'));
});

describe('Mini Program fixed PHP missing-row metadata', () => {
  it('retains exact five-field ownership and never installs seed IDs or values', () => {
    expect(Object.keys(WECHAT_ROUTINE_INSERT_METADATA)).toEqual([...WECHAT_ROUTINE_KEYS]);
    for (const metadata of Object.values(WECHAT_ROUTINE_INSERT_METADATA)) {
      expect(metadata).not.toHaveProperty('id'); expect(metadata).not.toHaveProperty('value');
      expect(metadata).toMatchObject({ uploadType: 0, required: '', high: 0, sort: 0, status: 1 });
    }
  });
  it('copies the actual tab7 text metadata without using presentation width as a value limit', () => {
    expect(WECHAT_ROUTINE_INSERT_METADATA.routine_appId).toMatchObject({ type: 'text', inputType: 'input', configTabId: 7, parameter: '', width: 100, info: 'appId', desc: '小程序appID' });
    expect(WECHAT_ROUTINE_INSERT_METADATA.routine_appsecret).toMatchObject({ type: 'text', inputType: 'input', configTabId: 7, parameter: '', width: 100, info: 'AppSecret', desc: '小程序AppSecret' });
    expect(WECHAT_ROUTINE_INSERT_METADATA.routine_name).toMatchObject({ type: 'text', inputType: 'input', configTabId: 7, parameter: '', width: 100, info: '小程序名称', desc: '' });
  });
  it('keeps contact tab7 and avatar tab26 with their original radio labels and descriptions', () => {
    expect(WECHAT_ROUTINE_INSERT_METADATA.routine_contact_type).toMatchObject({ type: 'radio', inputType: '', configTabId: 7, width: 0, parameter: '1=>小程序客服\n0=>系统客服', info: '小程序客服类型', desc: '小程序客服类型' });
    expect(WECHAT_ROUTINE_INSERT_METADATA.store_user_avatar).toMatchObject({ type: 'radio', inputType: '', configTabId: 26, width: 0, parameter: '1=>开启\n0=>关闭', info: '强制获取昵称头像', desc: '是否在小程序用户授权之后，弹窗获取用户的昵称和头像' });
  });
});
