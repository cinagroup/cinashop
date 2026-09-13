import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Bundle the real Admin auth + Axios + shipping API, not a duplicate state machine.
let actual: any;
let storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
let surface: EventTarget;
const scopes: Array<{ dispose(): void }> = [];
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../view/admin-ts');
  const bundled = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export * as auth from './src/utils/auth';
    export * as shipping from './src/api/shipping';
    export { createAdminSessionScope } from './src/utils/adminSessionScope';
    export { default as request, AdminResponseError } from './src/utils/request';
  ` }, alias: { '@': resolve(root, 'src') }, bundle: true, write: false, platform: 'browser', format: 'esm' });
  actual = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  const values = new Map<string, string>();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, removeItem: key => { values.delete(key); } };
  surface = new EventTarget();
  vi.stubGlobal('localStorage', storage); vi.stubGlobal('window', Object.assign(surface, { location: { pathname: '/shipping' } }));
  actual.auth.setToken('fixture-a'); storage.setItem('admin_session', '{"uid":1}');
});
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); vi.unstubAllGlobals(); });
function scope(invalidate = vi.fn()) { const value = actual.createAdminSessionScope(invalidate); scopes.push(value); return value; }
function response(config: unknown, data: unknown) { return { config, data, status: 200, statusText: 'fixture', headers: {} }; }

describe('actual Admin shipping session and mutation response boundaries', () => {
  it('aborts a queued Axios write before dispatch when the same-tab identity changes', async () => {
    const current = scope(), adapter = vi.fn(); actual.request.defaults.adapter = adapter;
    const saving = actual.shipping.apiAdminShippingTemplateSave({ id: 10 }, current.signal);
    actual.auth.setToken('fixture-b');
    await expect(saving).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(adapter).not.toHaveBeenCalled(); expect(current.isCurrent()).toBe(false);
  });
  it.each(['token', 'session', 'logout', 'expired', 'storage-token', 'storage-session', 'storage-clear'])('invalidates %s exactly once and cannot resurrect on A -> B -> A', kind => {
    const changed = vi.fn(), current = scope(changed);
    if (kind === 'token') { actual.auth.setToken('fixture-b'); actual.auth.setToken('fixture-a'); }
    if (kind === 'session') actual.auth.setAdminSession({ userInfo: { id: 2 }, menus: [], uniqueAuth: [] });
    if (kind === 'logout') actual.auth.clearAuth();
    if (kind === 'expired') surface.dispatchEvent(new Event('admin-auth-expired'));
    if (kind.startsWith('storage-')) {
      const event = Object.assign(new Event('storage'), { storageArea: storage, key: kind === 'storage-clear' ? null : kind === 'storage-token' ? 'admin_token' : 'admin_session' });
      surface.dispatchEvent(event); surface.dispatchEvent(event);
    }
    expect(current.isCurrent()).toBe(false); expect(current.signal.aborted).toBe(true); expect(changed).toHaveBeenCalledTimes(1);
    actual.auth.setToken('fixture-a'); storage.setItem('admin_session', '{"uid":1}'); expect(current.isCurrent()).toBe(false);
  });
  it('ignores unrelated storage and identical token writes, and removes listeners on dispose', () => {
    const changed = vi.fn(), current = scope(changed);
    actual.auth.setToken('fixture-a');
    surface.dispatchEvent(Object.assign(new Event('storage'), { storageArea: storage, key: 'theme' }));
    surface.dispatchEvent(Object.assign(new Event('storage'), { storageArea: {}, key: 'admin_token' }));
    expect(current.isCurrent()).toBe(true); current.dispose(); actual.auth.setToken('fixture-b');
    expect(current.isCurrent()).toBe(false); expect(current.signal.aborted).toBe(true); expect(changed).not.toHaveBeenCalled();
  });
  it('checks unannounced storage changes before starting another operation', () => {
    const current = scope(); storage.setItem('admin_session', '{"uid":2}'); expect(current.isCurrent()).toBe(false);
  });
  it('does not accept an anonymous operation scope', () => {
    actual.auth.clearAuth(); const current = scope(); expect(current.isCurrent()).toBe(false);
  });
  it('ignores a late old-account authentication failure without clearing its replacement', async () => {
    let finish!: (result: unknown) => void;
    let begin!: (config: any) => void; const started = new Promise<any>(resolve => { begin = resolve; });
    actual.request.defaults.adapter = (config: any) => { begin(config); return new Promise(resolve => { finish = resolve; }); };
    const saving = actual.shipping.apiAdminShippingTemplateSave({ id: 10 });
    const config = await started; actual.auth.setToken('fixture-b');
    finish(response(config, { status: 410000, msg: 'expired', data: null }));
    await expect(saving).rejects.toMatchObject({ status: 410000 }); expect(actual.auth.getToken()).toBe('fixture-b');
  });
  it.each([null, {}, { id: 0 }, { id: '10' }, { id: 11 }, { id: 2147483648 }])('treats malformed/mismatched save receipt %j as unknown, not a business rejection', async data => {
    actual.request.defaults.adapter = async (config: unknown) => response(config, { status: 200, data });
    await expect(actual.shipping.apiAdminShippingTemplateSave({ id: 10 })).rejects.toThrow('结果未知');
  });
  it('accepts exact edit and positive create receipts', async () => {
    actual.request.defaults.adapter = async (config: unknown) => response(config, { status: 200, data: { id: 10 } });
    expect(await actual.shipping.apiAdminShippingTemplateSave({ id: 10 })).toEqual({ id: 10 });
    expect(await actual.shipping.apiAdminShippingTemplateSave({ id: 0 })).toEqual({ id: 10 });
  });
  it('distinguishes explicit status 400 rejection from malformed envelopes and status 500', async () => {
    for (const body of [{ status: 400, msg: 'conflict' }, {}, { status: 500, msg: 'unknown' }]) {
      actual.request.defaults.adapter = async (config: unknown) => response(config, body);
      const error = await actual.shipping.apiAdminShippingTemplateSave({ id: 10 }).catch((e: unknown) => e);
      expect(error instanceof actual.AdminResponseError).toBe(true); expect(error.status).toBe(body.status);
      expect(error.status === 400).toBe(body.status === 400);
    }
  });
  it('requires a null deletion receipt and carries cancellation on every shipping API', async () => {
    actual.request.defaults.adapter = async (config: unknown) => response(config, { status: 200, data: {} });
    await expect(actual.shipping.apiAdminShippingTemplateDel(10)).rejects.toThrow('结果未知');
    actual.request.defaults.adapter = async (config: unknown) => response(config, { status: 200, data: null });
    expect(await actual.shipping.apiAdminShippingTemplateDel(10)).toBeNull();
    const current = scope(); current.dispose(); const adapter = vi.fn(); actual.request.defaults.adapter = adapter;
    for (const call of [() => actual.shipping.apiAdminShippingTemplateList({ limit: 20 }, current.signal),
      () => actual.shipping.apiAdminShippingTemplateDetail(10, current.signal), () => actual.shipping.apiAdminShippingCities(current.signal),
      () => actual.shipping.apiAdminShippingTemplateDel(10, current.signal)]) await expect(call()).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(adapter).not.toHaveBeenCalled();
  });
});
