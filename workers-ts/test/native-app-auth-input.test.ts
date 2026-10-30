import { describe, expect, it, vi } from 'vitest';
import { nativeAppAuthObject, nativeAppProviderCode, parseNativeAppAuthComplete, parseNativeAppAuthPhone,
  parseNativeAppAuthState, readNativeAppAuthBody } from '../src/services/wechat/NativeAppAuthInput';

const state = '11111111-1111-4111-8111-111111111111', verifier = 'a'.repeat(64);
const complete = { code: 'owned-code_1', state, verifier };
const phone = { key: state, verifier, phone: '13800138000', captcha: '123456' };
const request = (body: BodyInit, headers: HeadersInit = {}, suffix = '') => new Request('https://owned.test/api/wechat/app_auth' + suffix,
  { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('native App authorization strict input boundary', () => {
  it('accepts only the exact empty state, three-field completion and four-field phone DTOs', () => {
    expect(parseNativeAppAuthState({})).toEqual({}); expect(parseNativeAppAuthComplete(complete)).toEqual(complete);
    expect(parseNativeAppAuthPhone(phone)).toEqual(phone);
    expect(parseNativeAppAuthComplete(Object.assign(Object.create(null), complete))).toEqual(complete);
  });
  it.each(['openid', 'unionid', 'userInfo', 'phone', 'access_token', 'appid', 'appSecret', 'redirect_uri'])('rejects client identity or alias %s', key => {
    expect(() => parseNativeAppAuthComplete({ ...complete, [key]: 'untrusted' })).toThrow();
  });
  it.each([
    { name: 'null', value: null }, { name: 'array', value: [] }, { name: 'number', value: 1 },
    { name: 'string', value: '{}' }, { name: 'date', value: new Date(0) }, { name: 'custom-prototype', value: Object.create({}) },
  ])('rejects non JSON-own object $name', ({ value }) => {
    expect(() => parseNativeAppAuthComplete(value)).toThrow();
  });
  it('rejects symbols, nonenumerable unknown keys and undefined accessors without evaluating them', () => {
    const getter = vi.fn(() => 'owned-code'), own = { ...complete };
    Object.defineProperty(own, 'code', { get: getter, enumerable: true });
    expect(() => parseNativeAppAuthComplete(own)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const hidden = Object.defineProperty({ ...complete }, 'hidden', { value: 1 });
    expect(() => parseNativeAppAuthComplete(hidden)).toThrow();
    const undefinedAccessor = Object.defineProperty({ ...complete }, 'code', { get: undefined, enumerable: true });
    expect(() => parseNativeAppAuthComplete(undefinedAccessor)).toThrow();
    expect(() => parseNativeAppAuthComplete({ ...complete, [Symbol('hidden')]: 1 })).toThrow();
    expect(() => nativeAppAuthObject(Object.defineProperty({ code: 'ok' }, 'code', { enumerable: false }), ['code'])).toThrow();
  });
  it.each(['', ' code', 'code ', 'a\nb', '\u0000', '\ud800', 'x'.repeat(513)])('rejects invalid code %j without trimming or coercion', value => {
    expect(() => nativeAppProviderCode(value)).toThrow();
  });
  it.each([false, 123, {}, ['code']])('rejects non-string code %j', code => {
    expect(() => parseNativeAppAuthComplete({ ...complete, code })).toThrow();
  });
  it('retains bounded non-wx-format codes and rejects non-v4 states or noncanonical verifiers', () => {
    expect(nativeAppProviderCode('x'.repeat(512))).toHaveLength(512);
    for (const value of [state.toUpperCase().replace('11111111', 'ABCDEFAB'), state.replace('-4', '-1'), 'not-state'])
      expect(() => parseNativeAppAuthComplete({ ...complete, state: value })).toThrow();
    for (const value of [verifier.toUpperCase(), 'a'.repeat(63), 123])
      expect(() => parseNativeAppAuthComplete({ ...complete, verifier: value })).toThrow();
  });
  it('rejects phone aliases, coercion and incomplete SMS continuation', () => {
    for (const change of [{ phone: 13800138000 }, { phone: '+8613800138000' }, { captcha: 123456 }, { captcha: ' 123456' }, { key: 'social_pending:legacy' }])
      expect(() => parseNativeAppAuthPhone({ ...phone, ...change })).toThrow();
    expect(() => parseNativeAppAuthState({ verifier })).toThrow();
    expect(() => parseNativeAppAuthPhone({ ...phone, openid: 'client' })).toThrow();
  });
  it('rejects duplicate decoded keys at any depth and invalid or empty JSON', async () => {
    for (const raw of ['{"code":"a","c\\u006fde":"b"}', '{"outer":{"x":1,"x":2}}', '', '{'])
      await expect(readNativeAppAuthBody(request(raw))).rejects.toThrow('JSON');
    expect(await readNativeAppAuthBody(request(JSON.stringify(complete)))).toEqual(complete);
  });
  it('rejects method, query parameters and form bodies before consuming them', async () => {
    await expect(readNativeAppAuthBody(new Request('https://owned.test/api/wechat/app_auth'))).rejects.toThrow('POST');
    const body = request('{}', {}, '?code=untrusted'), spy = vi.spyOn(body.body!, 'getReader');
    await expect(readNativeAppAuthBody(body)).rejects.toThrow('POST'); expect(spy).not.toHaveBeenCalled();
    await expect(readNativeAppAuthBody(request('{}', { 'content-type': 'application/x-www-form-urlencoded' }))).rejects.toThrow('JSON');
  });
  it('enforces declared bytes before reading and actual UTF-8 bytes rather than JS string length', async () => {
    const declared = request('{}', { 'content-length': '8193' }), reader = vi.spyOn(declared.body!, 'getReader');
    await expect(readNativeAppAuthBody(declared)).rejects.toThrow('8 KiB'); expect(reader).not.toHaveBeenCalled();
    const raw = JSON.stringify({ value: '😀'.repeat(2100) }); expect(raw.length).toBeLessThan(8192);
    await expect(readNativeAppAuthBody(request(raw))).rejects.toThrow('8 KiB');
    await expect(readNativeAppAuthBody(request(new Uint8Array([0xc3, 0x28])))).rejects.toThrow('UTF-8');
  });
});
