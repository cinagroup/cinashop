/** PREPARATION ONLY: these test candidates have not been run. */
import { describe, expect, it } from 'vitest';
import {
  PC_BASE_KEYS, PC_BASE_OPEN_RESERVED_KEYS, PC_BASE_MAX_BODY_BYTES,
  isPcBaseConfigKey, normalizePcBaseValues, parsePcBaseSave,
  pcBaseImage, pcBaseLink, pcBasePending, serializePcBaseValues,
  validPcBaseContact, type PcBaseSave, type PcBaseValues,
} from '../../view/common/pcBase';
import type { PcBaseFieldIntents, PcBaseIntentSave } from '../../view/common/pcBaseIntent';
import { parsePcBaseRequestText, readPcBaseSaveRequest } from '../src/services/admin/AdminPcBaseInput';

function values(): PcBaseValues {
  return {
    pc_logo: '/api/assets/11', bast_number: 4, first_number: 4, product_phone_buy_url: 1,
    contact_number: '4001234567', company_address: '  示例市 地址  ', copyright: '版权原文 ',
    seo_title: '旧SEO标题', site_keywords: '商城,商品', site_description: '首行\r\n第二行\n',
    links_open: 1, links_list: [
      { name: '  乙  ', url: 'https://example.test/z', sort: 0.5 },
      { name: '甲', url: '/goods?q=商品', sort: 10 },
    ],
    filing_list: [{ icon: '', name: '', url: '', sort: 0 },
      { icon: '/api/assets/12', name: '公安备案', url: 'http://beian.example.test/', sort: 2.25 }],
  };
}
function draft(): PcBaseSave {
  return { request_id: '11111111-1111-4111-8111-111111111111', revision: 'a'.repeat(64), settings: values(), confirmed: true };
}
function intentDraft(): PcBaseIntentSave {
  return { request_id: draft().request_id, revision: draft().revision, confirmed: true,
    fields: Object.fromEntries(PC_BASE_KEYS.map(key => [key, { action: 'keep' }])) as PcBaseFieldIntents };
}
function streamRequest(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
  return new Request('https://admin.example.test/config/pc', init);
}

// Full-value fixtures exercise shared replacement rules, never a second HTTP writer.
describe('PC base thirteen-field input candidate', () => {
  it('owns exactly thirteen original non-Open keys and serializes only those keys', () => {
    expect(PC_BASE_KEYS).toHaveLength(13);
    expect(Object.keys(serializePcBaseValues(values()))).toEqual([...PC_BASE_KEYS]);
    for (const key of PC_BASE_OPEN_RESERVED_KEYS) expect(isPcBaseConfigKey(key)).toBe(false);
    expect(isPcBaseConfigKey('site_name')).toBe(false);
    expect(isPcBaseConfigKey('site_logo')).toBe(false);
  });
  it.each(PC_BASE_KEYS)('requires the original field %s even when its control is hidden', key => {
    const input = values() as unknown as Record<string, unknown>; delete input[key];
    expect(() => normalizePcBaseValues(input)).toThrow('字段不完整');
  });
  it.each(PC_BASE_OPEN_RESERVED_KEYS)('rejects the entire mixed PC settings object carrying %s', key => {
    expect(() => parsePcBaseSave({ ...draft(), settings: { ...values(), [key]: 'must-not-write' } })).toThrow('未知字段');
  });
  it('rejects flat generic, Base/Open-shaped and query-override envelopes', () => {
    expect(() => parsePcBaseSave(values())).toThrow();
    expect(() => parsePcBaseSave({ ...draft(), database_credentials: false, secrets: {} })).toThrow('未知字段');
    expect(() => parsePcBaseSave({ ...draft(), database_callback: false, secrets: {} })).toThrow('未知字段');
    expect(() => parsePcBaseSave({ ...draft(), is_store: 1 })).toThrow('未知字段');
  });
  it('retains raw whitespace, textarea line endings, array order and fractional sort values', () => {
    const input = draft(), parsed = parsePcBaseSave(input);
    expect(parsed).toEqual(input);
    expect(parsed.settings.links_list.map(row => row.sort)).toEqual([0.5, 10]);
    parsed.settings.links_list[0]!.name = 'changed';
    expect(input.settings.links_list[0]!.name).toBe('  乙  ');
  });
  it('preserves the stored friendship list when the switch is off', () => {
    const input = values(); input.links_open = 0;
    expect(normalizePcBaseValues(input).links_list).toEqual(input.links_list);
  });
  it('allows empty tables and optional filing fields while rejecting empty friendship cells', () => {
    const input = values(); input.links_list = [];
    expect(normalizePcBaseValues(input).filing_list[0]).toEqual({ icon: '', name: '', url: '', sort: 0 });
    input.filing_list = [];
    expect(normalizePcBaseValues(input).filing_list).toEqual([]);
    input.links_list = [{ name: '', url: '/goods', sort: 0 }];
    expect(() => normalizePcBaseValues(input)).toThrow('名称不能为空');
    input.links_list = [{ name: '示例', url: '', sort: 0 }];
    expect(() => normalizePcBaseValues(input)).toThrow('地址不能为空');
  });
  it('keeps legacy seo_title required despite its disabled seed display status', () => {
    expect(() => normalizePcBaseValues({ ...values(), seo_title: '' })).toThrow('历史SEO标题不能为空');
    // PHP valiDateValue checks exactly empty, not trim().
    expect(normalizePcBaseValues({ ...values(), seo_title: ' ' }).seo_title).toBe(' ');
  });
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '4', true, null])('rejects a nonpositive/noncanonical product count case %# (%j)', value => {
    expect(() => normalizePcBaseValues({ ...values(), bast_number: value })).toThrow('正整数');
    expect(() => normalizePcBaseValues({ ...values(), first_number: value })).toThrow('正整数');
  });
  it('preserves count values beyond the current reader cap instead of silently clamping to100', () => {
    expect(normalizePcBaseValues({ ...values(), bast_number: 101, first_number: 1000 })).toMatchObject({ bast_number: 101, first_number: 1000 });
  });
  it.each([-1, -0, Number.NaN, Number.POSITIVE_INFINITY, '2'])('rejects an invalid or coercible sort number case %# (%j)', value => {
    const input = values(); (input.links_list[0] as unknown as { sort: unknown }).sort = value;
    expect(() => normalizePcBaseValues(input)).toThrow('排序号');
  });
  it.each([0, 3, '1', null, true])('accepts neither unknown nor coerced phone purchase option case %# (%j)', value => {
    expect(() => normalizePcBaseValues({ ...values(), product_phone_buy_url: value })).toThrow('手机购买入口');
  });
  it.each([-1, 2, '0', true, null])('accepts neither unknown nor coerced link switch case %# (%j)', value => {
    expect(() => normalizePcBaseValues({ ...values(), links_open: value })).toThrow('友情链接开关');
  });
  it('retains the exact optional PHP contact validation, including its documented partial anchors', () => {
    for (const value of ['', '13812345678', '4001234567', '010-12345678', '4001234567ext', '010-12345678ext']) {
      expect(validPcBaseContact(value)).toBe(true);
      expect(normalizePcBaseValues({ ...values(), contact_number: value }).contact_number).toBe(value);
    }
    for (const value of ['10086', '+8613812345678', '16612345678', ' 13812345678']) expect(validPcBaseContact(value)).toBe(false);
  });
  it('bounds actual serialized PostgreSQL value characters including quotes, escapes and supplementary Unicode', () => {
    const input = values(); input.company_address = '😀'.repeat(4998);
    expect([...serializePcBaseValues(input).company_address]).toHaveLength(5000);
    input.company_address += '😀';
    expect(() => normalizePcBaseValues(input)).toThrow('序列化值');
    input.company_address = '"'.repeat(2500);
    expect(() => normalizePcBaseValues(input)).toThrow('序列化值');
  });
  it('rejects over-budget structured rows without truncation or reordering', () => {
    const input = values(); input.links_list = Array.from({ length: 100 }, (_, index) => ({ name: '名称'.repeat(20), url: '/goods/' + index, sort: index }));
    const original = JSON.stringify(input);
    expect(() => normalizePcBaseValues(input)).toThrow('序列化值');
    expect(JSON.stringify(input)).toBe(original);
  });
  it('rejects invalid Unicode and controls without removing or replacing authored characters', () => {
    for (const value of ['a\u0000b', '\ud800', '标题\n下一行']) expect(() => normalizePcBaseValues({ ...values(), copyright: value })).toThrow();
    expect(() => normalizePcBaseValues({ ...values(), site_description: '\u000b' })).toThrow();
  });
  it('rejects sparse/extra-property tables, inherited objects, getters and row extension fields', () => {
    const sparse = new Array(1); expect(() => normalizePcBaseValues({ ...values(), links_list: sparse })).toThrow('连续');
    const extra = [] as unknown[] & { extra?: boolean }; extra.extra = true;
    expect(() => normalizePcBaseValues({ ...values(), links_list: extra })).toThrow('连续');
    const inherited = Object.assign(Object.create({ hidden: true }), values());
    expect(() => normalizePcBaseValues(inherited)).toThrow('JSON对象');
    const getter = { ...values() }; Object.defineProperty(getter, 'seo_title', { enumerable: true, get() { throw Error('getter must not execute'); } });
    expect(() => normalizePcBaseValues(getter)).toThrow('JSON数据字段');
    const input = values(); (input.links_list[0] as unknown as Record<string, unknown>).html = '<script>';
    expect(() => normalizePcBaseValues(input)).toThrow('未知字段');
  });
  it('requires lowercase UUIDv4, a complete SHA revision and explicit true confirmation', () => {
    for (const request_id of ['', '11111111-1111-1111-8111-111111111111', '11111111-1111-4111-7111-111111111111', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) expect(() => parsePcBaseSave({ ...draft(), request_id })).toThrow();
    for (const revision of ['', 'a'.repeat(63), 'A'.repeat(64)]) expect(() => parsePcBaseSave({ ...draft(), revision })).toThrow();
    for (const confirmed of [false, 1, 'true', null]) expect(() => parsePcBaseSave({ ...draft(), confirmed })).toThrow();
  });
  it('journals only owner and operation identity, with no values, revision or tickets', () => {
    expect(pcBasePending(draft(), 17)).toEqual({ version: 1, actor_id: 17, request_id: draft().request_id });
    expect(() => pcBasePending(draft(), 0)).toThrow('归属');
  });
  it('rejects duplicate decoded JSON keys, nested duplicates, invalid JSON and over-budget transport', () => {
    const input = intentDraft(), raw = JSON.stringify(input);
    expect(parsePcBaseRequestText(raw)).toEqual(input);
    expect(() => parsePcBaseRequestText(raw.replace('"confirmed":true', '"confirmed":true,"conf\\u0069rmed":true'))).toThrow('重复');
    expect(() => parsePcBaseRequestText(raw.replace('"action":"keep"', '"action":"keep","act\\u0069on":"replace"'))).toThrow('重复');
    expect(() => parsePcBaseRequestText('{')).toThrow('JSON');
    expect(() => parsePcBaseRequestText(' '.repeat(PC_BASE_MAX_BODY_BYTES) + raw)).toThrow('256KiB');
  });
});

describe('PC base modern bounded HTTP intent adapter', () => {
  it('reads a complete keep/replace fields intent across split UTF-8 stream chunks', async () => {
    const input = intentDraft(); input.fields.copyright = { action: 'replace', value: '中文版权' };
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    const split = bytes.findIndex(byte => byte >= 0x80) + 1;
    expect(split).toBeGreaterThan(0);
    await expect(readPcBaseSaveRequest(streamRequest([bytes.slice(0, split), bytes.slice(split)]))).resolves.toEqual(input);
  });
  it('rejects the former full settings envelope instead of treating it as a second writer', async () => {
    await expect(readPcBaseSaveRequest(new Request('https://admin.example.test/config/pc', {
      method: 'POST', body: JSON.stringify(draft()),
    }))).rejects.toThrow('未知字段');
  });
  it('rejects an oversized declared length before touching the body', async () => {
    const request = new Request('https://admin.example.test/config/pc', {
      method: 'POST', headers: { 'content-length': String(PC_BASE_MAX_BODY_BYTES + 1) },
      body: JSON.stringify(intentDraft()),
    });
    let touched = false;
    Object.defineProperty(request, 'body', { get() { touched = true; throw Error('body must not be touched'); } });
    await expect(readPcBaseSaveRequest(request)).rejects.toThrow(/256\s*KiB/u);
    expect(touched).toBe(false);
  });
  it('bounds actual streamed UTF-8 bytes without a declared length or character-count shortcut', async () => {
    const text = '中'.repeat(Math.floor(PC_BASE_MAX_BODY_BYTES / 3) + 1);
    const bytes = new TextEncoder().encode(text);
    expect(text.length).toBeLessThan(PC_BASE_MAX_BODY_BYTES);
    expect(bytes.byteLength).toBeGreaterThan(PC_BASE_MAX_BODY_BYTES);
    const request = streamRequest([bytes.slice(0, PC_BASE_MAX_BODY_BYTES), bytes.slice(PC_BASE_MAX_BODY_BYTES)]);
    expect(request.headers.has('content-length')).toBe(false);
    await expect(readPcBaseSaveRequest(request)).rejects.toThrow(/256\s*KiB/u);
  });
  it('rejects invalid streamed UTF-8 before decoding replacement JSON', async () => {
    await expect(readPcBaseSaveRequest(streamRequest([
      new Uint8Array([0x7b]), new Uint8Array([0xff]), new Uint8Array([0x7d]),
    ]))).rejects.toThrow('UTF-8');
  });
});

describe('PC base stable media and public link input candidate', () => {
  it.each(['', '/api/assets/1', '/api/assets/2147483647', '/uploads/标识.png', 'https://cdn.example.test/logo.png', 'http://cdn.example.test/logo.png'])('preserves a canonical image %s', value => {
    expect(pcBaseImage(value)).toBe(value);
  });
  it.each([
    '/api/assets/01', '/api/assets/2147483648', '/api/assets/1?signature=temporary',
    '/kefuapi/assets/1', 'https://cdn.example.test/api/assets/1', '/x/../api/assets/1',
    '/api/%61ssets/1', '/%61pi/assets/1', '/api/assets/1#preview',
    '//cdn.example.test/logo.png',
    'https://user:password@cdn.example.test/logo.png', 'data:image/png;base64,AA',
    'https://cdn.example.test/logo.png?X-Amz-Signature=temporary',
  ])('rejects an unstable/private-alias image %s', value => expect(() => pcBaseImage(value)).toThrow());
  it.each(['http://example.test/', 'https://example.test/a?q=值', '/goods?q=商品', '/terms%20and%20conditions', 'https://example.test/a?expires=business-value'])('preserves a supported footer link %s', value => {
    expect(pcBaseLink(value)).toBe(value);
  });
  it.each([
    'javascript:alert(1)', 'data:text/html,unsafe', ' //evil.example', '//evil.example',
    '/%2fevil.example', '/%252fevil.example', 'https://safe.example\\@evil.example',
    'https://user@host.example', '/api/assets/1', '/api/%61ssets/1',
    'https://example.test/a%0d%0aLocation:evil',
  ])('rejects unsafe/footer-private link %s', value => expect(() => pcBaseLink(value)).toThrow());
});
