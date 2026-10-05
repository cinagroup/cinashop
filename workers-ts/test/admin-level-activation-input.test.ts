import { describe, expect, it } from 'vitest';
import { parseAdminLevelActivationCouponQuery, parseAdminLevelActivationInput, parseLevelActivationJson,
  readAdminLevelActivationBody } from '../src/services/admin/AdminLevelActivationInput';
import { normalizeLevelActivationFields } from '../src/services/user/UserLevelService';

const hash = 'a'.repeat(64);
const input = () => ({ member_func_status: 1, level_activate_status: 1, level_extend_info: [], level_integral_status: 1,
  level_give_integral: 7, level_money_status: 1, level_give_money: '15', level_coupon_status: 1, level_give_coupon: [2, 1],
  coupon_revisions: [{ id: 2, revision: hash }, { id: 1, revision: hash }], revision: hash,
  request_id: '00000000-0000-4000-8000-000000000001' });

describe('ordinary level activation dedicated input', () => {
  it('normalizes only the bounded coupon set, preserving profile selection order and whole currency', () => {
    const parsed = parseAdminLevelActivationInput({ ...input(), level_give_money: '9999999999', level_give_integral: 2147483647,
      level_extend_info: [{ field_key: 'b'.repeat(64), required: 1 }, { field_key: hash, required: 0 }] });
    expect(parsed.level_give_coupon).toEqual([1, 2]);
    expect(parsed.coupon_revisions.map(row => row.id)).toEqual([1, 2]);
    expect(parsed.level_extend_info.map(row => row.field_key)).toEqual(['b'.repeat(64), hash]);
    expect(parsed.level_give_money).toBe('9999999999');
  });
  it.each(['1.50', '1e3', '01', '-1', '+1', '10000000000', 1, null, true])('rejects ambiguous whole currency %s', value => {
    expect(() => parseAdminLevelActivationInput({ ...input(), level_give_money: value })).toThrow();
  });
  it.each(['7', 0.5, 2147483648, NaN, Infinity, true, null])('rejects non-integer integral input %s', value => {
    expect(() => parseAdminLevelActivationInput({ ...input(), level_give_integral: value })).toThrow();
  });
  it('does not grant arbitrary configuration or profile-column editing', () => {
    for (const key of ['user_extend_info', 'member_card_status', 'order_give_exp', 'member_price_status']) {
      expect(() => parseAdminLevelActivationInput({ ...input(), [key]: 1 })).toThrow('不支持的字段');
    }
    expect(() => parseAdminLevelActivationInput({ ...input(), level_extend_info: [{ field_key: hash, required: 0, param: 'now_money' }] })).toThrow();
    expect(() => parseAdminLevelActivationInput({ ...input(), level_extend_info: [{ field_key: hash, required: 0, value: 'preset' }] })).toThrow();
  });
  it('requires all nine fields and exactly one proof per unique selected coupon', () => {
    const { level_money_status: omitted, ...partial } = input();
    expect(omitted).toBe(1);
    expect(() => parseAdminLevelActivationInput(partial)).toThrow();
    expect(() => parseAdminLevelActivationInput({ ...input(), level_give_coupon: [1, 1] })).toThrow();
    expect(() => parseAdminLevelActivationInput({ ...input(), coupon_revisions: [{ id: 1, revision: hash }, { id: 1, revision: hash }] })).toThrow();
    expect(() => parseAdminLevelActivationInput({ ...input(), coupon_revisions: [] })).toThrow();
    expect(() => parseAdminLevelActivationInput({ ...input(), request_id: 'not-a-uuid' })).toThrow();
    expect(() => parseAdminLevelActivationInput({ ...input(), revision: 'A'.repeat(64) })).toThrow();
  });
  it('detects repeated decoded JSON keys before their earlier values are discarded', () => {
    expect(() => parseLevelActivationJson('{"revision":"a","revision":"b"}')).toThrow('不能重复');
    expect(() => parseLevelActivationJson('{"a":[{"id":1,"\\u0069d":2}]}')).toThrow('不能重复');
    expect(parseLevelActivationJson('{"a":"escaped\\\"value","b":[{"id":1},{"id":2}],"c":null}')).toEqual({ a: 'escaped"value', b: [{ id: 1 }, { id: 2 }], c: null });
  });
  it('bounds streamed UTF-8 JSON before parsing it', async () => {
    const request = new Request('https://test/config', { method: 'POST', body: JSON.stringify({ value: 'a'.repeat(65536) }) });
    await expect(readAdminLevelActivationBody(request)).rejects.toThrow('64 KiB');
  });
  it('uses bounded strict pagination and keeps literal search text', () => {
    expect(parseAdminLevelActivationCouponQuery(new URLSearchParams())).toEqual({ page: 1, limit: 10, offset: 0, keyword: '' });
    expect(parseAdminLevelActivationCouponQuery(new URLSearchParams('page=101&limit=100&keyword=50%25_'))).toEqual({ page: 101, limit: 100, offset: 10000, keyword: '50%_' });
    for (const query of ['page=1&page=2', 'page=', 'page=1e2', 'limit=101', 'page=102&limit=100', 'status=1', 'keyword=%00']) {
      expect(() => parseAdminLevelActivationCouponQuery(new URLSearchParams(query))).toThrow();
    }
  });
});

describe('configured activation profile value validation', () => {
  const radio = [{ info: '餐食', format: 'radio', param: '', singlearr: ['标准', '素食'], required: 1 }];
  it('does not satisfy an omitted required custom field with another empty-param field', () => {
    const submitted = [{ info: 'B', param: '', value: 'provided B' }];
    const template = [{ info: 'A', tip: '必须填写A', param: '', format: 'text', required: 1 },
      { info: 'B', param: '', format: 'text', required: 0 }];
    const before = JSON.stringify({ submitted, template });
    expect(() => normalizeLevelActivationFields(submitted, template)).toThrow('必须填写A');
    expect(JSON.stringify({ submitted, template })).toBe(before);
  });
  it.each(['0', 1, '素食'])('accepts legacy radio indices and exact labels: %s', value => {
    const result = normalizeLevelActivationFields([{ info: '餐食', value }], radio);
    expect(result.extendInfo[0].value).toBe(value);
    expect(Object.keys(result.fields)).toEqual(['levelExtendInfo']);
  });
  it.each(['2', -1, '1.5', '未知', {}, [], true, null])('rejects invalid radio/scalar values: %s', value => {
    expect(() => normalizeLevelActivationFields([{ info: '餐食', value }], radio)).toThrow();
  });
  it('preserves the standard sex mapping even when legacy option metadata is absent', () => {
    expect(normalizeLevelActivationFields([{ info: '性别', value: '女' }], [{ info: '性别', param: 'sex', format: 'radio' }]).fields.sex).toBe(2);
  });
  it('validates custom real calendar dates without writing the standard birthday column', () => {
    const template = [{ info: '纪念日', param: '', format: 'date' }];
    expect(normalizeLevelActivationFields([{ info: '纪念日', value: '2024-02-29' }], template).fields).not.toHaveProperty('birthday');
    for (const value of ['2023-02-29', '2024-13-01', '1900-02-29', '1899-01-01']) {
      expect(() => normalizeLevelActivationFields([{ info: '纪念日', value }], template)).toThrow('生日格式错误');
    }
  });
});
