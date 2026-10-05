import { describe, expect, it } from 'vitest';
import { PC_BANNER_DEFAULT_FIELDS, PC_BANNER_DEFAULT_METADATA, parsePcBannerFields, parsePcBannerQuery,
  pcBannerCanonical, pcBannerHash, pcBannerImage, pcBannerLink, pcBannerValuesForFields, readPcBannerBody } from '../src/services/admin/AdminPcBannerInput';

const nonce = '00000000-0000-4000-8000-000000000001', revision = 'a'.repeat(64);
const input = () => ({ request_id: nonce, revision, values: { url: '/goods', title: '  原始标题 🌿  ', image: '/legacy/banner.png' }, sort: 0, status: 1 });
describe('complete PC banner input contract', () => {
  it('decodes every legacy field type, choice syntax, multiline placeholders and unknown-type input fallback', () => {
    expect(parsePcBannerFields(PC_BANNER_DEFAULT_METADATA)).toEqual({ valid: true, fields: PC_BANNER_DEFAULT_FIELDS, issues: [] });
    const result = parsePcBannerFields(JSON.stringify(['input', 'textarea', 'radio', 'checkbox', 'select', 'upload', 'uploads', 'future'].map((type, id) =>
      ({ name: `字段${id}`, title: `key${id}`, type, param: ['radio', 'checkbox', 'select'].includes(type) ? '1=>一\r\n2=>二=>旧多余部分' : type === 'textarea' ? '原样\r\n提示\t' : '' }))));
    expect(result.valid).toBe(true); expect(result.fields.map(field => field.type)).toEqual(['input', 'textarea', 'radio', 'checkbox', 'select', 'upload', 'uploads', 'input']);
    expect(result.fields[1].placeholder).toBe('原样\r\n提示\t'); expect(result.fields[2].choices).toEqual([{ value: '1', label: '一' }, { value: '2', label: '二' }]);
    expect(result.issues).toHaveLength(1);
  });
  it('never substitutes default metadata for malformed, duplicate or unsafe definitions', () => {
    for (const raw of ['{', '[]', '[{"title":"x","title":"y"}]', '[{"name":"x","title":"__proto__","type":"input"}]',
      JSON.stringify([{ name: 'x', title: 'x', type: 'radio', param: 'a=>甲\na=>乙' }]),
      JSON.stringify([{ name: 'x', title: 'x', type: 'input' }, { name: 'x', title: 'x', type: 'input' }])]) {
      expect(parsePcBannerFields(raw)).toMatchObject({ fields: [], valid: false });
    }
  });
  it('hashes a fixed canonical operation including ID and revision, sorted field keys and original string/array order', async () => {
    const a = pcBannerCanonical('create', undefined, input());
    const b = pcBannerCanonical('create', 999, { ...input(), request_id: crypto.randomUUID(), values: { image: '/legacy/banner.png', title: '  原始标题 🌿  ', url: '/goods' } });
    expect(JSON.stringify(a.canonical)).toBe(`{"operation":"create","id":0,"revision":"${revision}","values":{"image":"/legacy/banner.png","title":"  原始标题 🌿  ","url":"/goods"},"sort":0,"status":1}`);
    expect(await pcBannerHash(a.canonical)).toBe(await pcBannerHash(b.canonical));
    expect(await pcBannerHash(pcBannerCanonical('update', 1, input()).canonical)).not.toBe(await pcBannerHash(a.canonical));
    const list = { ...input(), values: { images: ['/a.png', '/b.png'] } };
    expect(await pcBannerHash(pcBannerCanonical('create', 0, list).canonical)).not.toBe(await pcBannerHash(pcBannerCanonical('create', 0, { ...list, values: { images: [...list.values.images].reverse() } }).canonical));
  });
  it('requires complete metadata values and valid choices while preserving whitespace and textarea line endings', () => {
    const fields = parsePcBannerFields(JSON.stringify([
      { name: '说明', title: 'note', type: 'textarea', param: '' }, { name: '复选', title: 'checks', type: 'checkbox', param: '1=>一\n2=>二' },
      { name: '图片', title: 'images', type: 'uploads', param: '' },
    ])).fields;
    const values = { note: ' 首行\r\n\t次行 ', checks: ['2', '1'], images: ['/a.png', '/a.png'] };
    expect(pcBannerValuesForFields(values, fields)).toBe(values);
    for (const bad of [{ ...values, note: 'bad\u0000' }, { ...values, checks: ['1', '1'] }, { ...values, checks: ['3'] },
      { ...values, images: Array(6).fill('/a.png') }, { note: 'x', checks: ['1'] }, { ...values, foreign: 'extra' }]) {
      expect(() => pcBannerValuesForFields(bad, fields)).toThrow();
    }
  });
  it('accepts safe legacy HTTP/HTTPS and internal targets, including encoded ordinary spaces', () => {
    for (const url of ['/goods?q=white%20shirt', '/unknown/path#anchor', 'http://example.com/catalog', 'https://example.com/My%20Banner?q=white%20shirt']) expect(pcBannerLink(url)).toBe(url);
    for (const image of ['/legacy/My%20Banner.png', 'https://cdn.example/My%20Banner.png', '/api/assets/41']) expect(pcBannerImage(image)).toBe(image);
  });
  it('rejects unsafe schemes, userinfo, backslashes, encoded control characters and protocol-relative aliases across decoding layers', () => {
    for (const value of ['javascript:alert(1)', 'data:image/png;base64,x', '//evil.test', 'https:example.com', 'http:example.com',
      'https://user:pass@example.com/x', '/%2fevil.test', '/%252fevil.test', '/%25252fevil.test', '/foo%250a', '/foo%5cbar',
      'https://example.com/a\\b', '/foo bar', '/foo\u007f', '/foo%zz%20', '/%2525252561',
      '/a/..//evil.test', '/a/%2e%2e//evil.test', '/a/%252e%252e//evil.test']) expect(() => pcBannerLink(value), value).toThrow();
  });
  it('requires stable canonical platform images and rejects signed assets, encoded aliases and insecure external images', () => {
    for (const value of ['/api/assets/0', '/api/assets/01', '/api/assets/2147483648', '/api/assets/41?expires=1&signature=x',
      '/api/assets/41#fragment', '/api/%61ssets/41', '/a/../api/assets/41', '/a/%2e%2e/api/assets/41', '/a/%252e%252e/api/assets/41',
      'http://cdn.example/image.png', 'https://cdn.example/image.png?X-Amz-Signature=x']) {
      expect(() => pcBannerImage(value), value).toThrow();
    }
  });
  it('rejects unknown body keys, noncanonical IDs, invalid revisions, incomplete and out-of-range scalar intent', () => {
    for (const change of [{ gid: 66 }, { sort: -1 }, { sort: 2147483648 }, { status: '1' }, { status: 2 }, { revision: 'A'.repeat(64) },
      { request_id: nonce.toUpperCase().replace('00000000', 'AAAAAAAA') }, { values: null }]) expect(() => pcBannerCanonical('create', undefined, { ...input(), ...change })).toThrow();
    for (const id of ['01', '0', -1, '2147483648']) expect(() => pcBannerCanonical('delete', id, { request_id: nonce, revision })).toThrow();
    expect(() => pcBannerCanonical('status', 1, { request_id: nonce, revision, status: 0, values: {} })).toThrow();
  });
  it('parses only bounded canonical pagination and status filters, rejecting unknown and duplicate query keys', () => {
    expect(parsePcBannerQuery(new URLSearchParams())).toEqual({ page: 1, limit: 20, offset: 0 });
    expect(parsePcBannerQuery(new URLSearchParams('page=2&limit=100&status=0'))).toEqual({ page: 2, limit: 100, offset: 100, status: 0 });
    for (const query of ['gid=66', 'status=1&status=0', 'page=01', 'limit=101', 'page=100002', 'page=100001&limit=2', 'status=-1']) expect(() => parsePcBannerQuery(new URLSearchParams(query))).toThrow();
  });
  it('rejects duplicate decoded JSON keys and oversized UTF-8 bodies before mutation', async () => {
    await expect(readPcBannerBody(new Request('https://local.test', { method: 'POST', body: '{"values":{"title":"a","ti\\u0074le":"b"}}' }))).rejects.toThrow();
    await expect(readPcBannerBody(new Request('https://local.test', { method: 'POST', body: JSON.stringify({ title: '中'.repeat(90_000) }) }))).rejects.toThrow();
    expect(await readPcBannerBody(new Request('https://local.test', { method: 'POST', body: JSON.stringify(input()) }))).toEqual(input());
  });
});
