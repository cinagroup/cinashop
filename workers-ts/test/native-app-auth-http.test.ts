import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import type { Container } from '../src/lib/di';
import * as controller from '../src/controllers/api/v1/NativeAppAuthController';
import { WechatAppAuthService } from '../src/services/wechat/WechatAppAuthService';
import { ServiceUnavailableException, ValidateException } from '../src/utils/errors';

// Actual Hono/controller/body boundary; service stubs are explicit and this is
// neither a full v1 middleware proof nor provider/identity transaction evidence.
const state = '11111111-1111-4111-8111-111111111111', verifier = 'a'.repeat(64);
function app() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => { c.set('container', {} as Container); await next(); });
  app.post('/api/wechat/app_auth/state', controller.state);
  app.post('/api/wechat/app_auth', controller.complete);
  app.post('/api/wechat/app_auth/phone', controller.phone);
  app.onError((error, c) => c.json({ status: 503, msg: error.message, data: null }, 503));
  return app;
}
const post = (path: string, body: unknown) => app().request('https://owned.test/api/wechat/app_auth' + path,
  { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '127.0.0.1' }, body: JSON.stringify(body) });
afterEach(() => { vi.restoreAllMocks(); });

describe('native App OAuth exact HTTP envelopes', () => {
  it('dispatches empty state and retains private no-store for the public challenge response', async () => {
    const service = vi.spyOn(WechatAppAuthService.prototype, 'createState').mockResolvedValue({ state, verifier, appId: 'public-native-app', expiresIn: 300 });
    const response = await post('/state', {});
    expect(service).toHaveBeenCalledExactlyOnceWith('127.0.0.1'); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ status: 200, msg: 'ok', data: { state, verifier, appId: 'public-native-app', expiresIn: 300 } });
  });
  it('returns trusted service uid with a bearer and dispatches only three completion fields', async () => {
    const service = vi.spyOn(WechatAppAuthService.prototype, 'login').mockResolvedValue({ token: 'owned-not-decoded', exp_time: 123, uid: 77 });
    const input = { code: 'owned-code', state, verifier }, response = await post('', input);
    expect(service).toHaveBeenCalledExactlyOnceWith(input, '127.0.0.1');
    expect(await response.json()).toEqual({ status: 200, msg: 'ok', data: { token: 'owned-not-decoded', exp_time: 123, uid: 77 } });
  });
  it('returns only the independent pending capability, then dispatches exact SMS continuation fields', async () => {
    vi.spyOn(WechatAppAuthService.prototype, 'login').mockResolvedValue({ need_phone: true, key: state, expiresIn: 600 });
    expect(await (await post('', { code: 'owned', state, verifier })).json()).toEqual({ status: 200, msg: 'ok', data: { need_phone: true, key: state, expiresIn: 600 } });
    const complete = vi.spyOn(WechatAppAuthService.prototype, 'completePhone').mockResolvedValue({ token: 'owned', exp_time: 321, uid: 78 });
    const input = { key: state, verifier, phone: '13800138000', captcha: '123456' };
    expect(await (await post('/phone', input)).json()).toEqual({ status: 200, msg: 'ok', data: { token: 'owned', exp_time: 321, uid: 78 } });
    expect(complete).toHaveBeenCalledExactlyOnceWith(input, '127.0.0.1');
  });
  it('rejects client identity, duplicate keys and query aliases without calling the service', async () => {
    const service = vi.spyOn(WechatAppAuthService.prototype, 'login');
    for (const body of [{ code: 'owned', state, verifier, openid: 'untrusted' }, { code: 'owned', state, verifier, uid: 77 }]) {
      const response = await post('', body); expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toHaveProperty('status', 400);
    }
    const duplicate = await app().request('https://owned.test/api/wechat/app_auth', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{"code":"a","c\\u006fde":"b"}' });
    expect(await duplicate.json()).toHaveProperty('status', 400);
    expect(await (await post('?openid=untrusted', { code: 'owned', state, verifier })).json()).toHaveProperty('status', 400);
    expect(service).not.toHaveBeenCalled();
  });
  it('normalizes domain validation but lets unavailable storage/provider remain a failed HTTP operation', async () => {
    const service = vi.spyOn(WechatAppAuthService.prototype, 'login').mockRejectedValueOnce(new ValidateException('owned state invalid'));
    expect(await (await post('', { code: 'owned', state, verifier })).json()).toEqual({ status: 400, msg: 'owned state invalid', data: null });
    service.mockRejectedValueOnce(new ServiceUnavailableException('owned unavailable'));
    const response = await post('', { code: 'owned', state, verifier }); expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
