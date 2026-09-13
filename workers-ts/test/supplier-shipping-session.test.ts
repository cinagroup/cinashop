import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let actual: any;
let surface: EventTarget;
let storage: Storage;
let auth: any;
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../view/supplier-ts');
  const output = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export * as shipping from './src/api/supplier';
    export { http, ApiError } from './src/api/http';
    export { useAuthStore } from './src/stores/auth';
    export * as session from './src/utils/supplierSession';
    export { createPinia, setActivePinia, disposePinia } from 'pinia';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"' },
    bundle: true, write: false, platform: 'browser', format: 'esm' });
  actual = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
});
let pinia: any;
const scopes: any[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, removeItem: key => { values.delete(key); } } as Storage;
  surface = new EventTarget();
  vi.stubGlobal('localStorage', storage); vi.stubGlobal('window', surface);
  storage.setItem('supplier-token', 'fixture-a'); storage.setItem('supplier-user', '{"id":20}');
  storage.setItem('supplier-permissions', '["supplier.shipping.view","supplier.shipping.manage"]');
  pinia = actual.createPinia(); actual.setActivePinia(pinia); auth = actual.useAuthStore();
});
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); actual.disposePinia(pinia); vi.unstubAllGlobals(); });
function scope(changed = vi.fn()) { const s = actual.session.createSupplierSessionScope(changed); scopes.push(s); return s; }
function response(config: unknown, data: unknown) { return { config, data, status: 200, statusText: 'fixture', headers: {} }; }
function deferredRequest() {
  let finish!: (value: unknown) => void, begin!: (config: any) => void;
  const started = new Promise<any>(resolve => { begin = resolve; });
  actual.http.defaults.adapter = (config: any) => { begin(config); return new Promise(resolve => { finish = resolve; }); };
  return { started, finish: (config: any, data: unknown) => finish(response(config, data)) };
}
function replaceIdentity() {
  storage.setItem('supplier-token', 'fixture-b'); storage.setItem('supplier-user', '{"id":30}');
  storage.setItem('supplier-permissions', '["supplier.shipping.view"]');
  surface.dispatchEvent(new Event('supplier-session-changed'));
}

describe('actual Supplier Axios, auth store and shipping receipts', () => {
  it('cancels a queued mounted shipping write without invoking the adapter', async () => {
    const s = scope(), adapter = vi.fn(); actual.http.defaults.adapter = adapter;
    const saving = actual.shipping.saveShippingTemplate(10, {}, s.signal); replaceIdentity();
    await expect(saving).rejects.toMatchObject({ code: 'ERR_CANCELED' }); expect(adapter).not.toHaveBeenCalled();
  });
  it.each(['same-tab', 'token', 'user', 'permissions', 'clear'])('sticky %s invalidation cancels exactly once including A -> B -> A', kind => {
    const changed = vi.fn(), s = scope(changed);
    const event = kind === 'same-tab' ? new Event('supplier-session-changed') : Object.assign(new Event('storage'), {
      storageArea: storage, key: kind === 'clear' ? null : 'supplier-' + kind,
    });
    surface.dispatchEvent(event); surface.dispatchEvent(event);
    expect(s.isCurrent()).toBe(false); expect(s.signal.aborted).toBe(true); expect(changed).toHaveBeenCalledTimes(1);
    storage.setItem('supplier-token', 'fixture-a'); expect(s.isCurrent()).toBe(false);
  });
  it('checks silent identity changes, ignores unrelated storage and detaches on dispose', () => {
    const changed = vi.fn(), s = scope(changed);
    surface.dispatchEvent(Object.assign(new Event('storage'), { storageArea: storage, key: 'theme' }));
    surface.dispatchEvent(Object.assign(new Event('storage'), { storageArea: {}, key: 'supplier-token' }));
    expect(s.isCurrent()).toBe(true); storage.setItem('supplier-user', '{"id":99}'); expect(s.isCurrent()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    const detached = scope(changed); detached.dispose(); replaceIdentity(); expect(changed).toHaveBeenCalledTimes(1);
  });
  it('blocks anonymous mounted scopes but permits login requests', async () => {
    actual.session.clearSupplierSession(); expect(scope().isCurrent()).toBe(false);
    actual.http.defaults.adapter = async (config: any) => response(config, { status: 200, data: {token:'signed-in',user_info:{id:20},unique_auth:[]} });
    await auth.signIn('account', 'fixture-password'); expect(auth.token).toBe('signed-in');
  });
  it('late login cannot replace another identity', async () => {
    const request = deferredRequest(), login = auth.signIn('account', 'fixture-password'); const config = await request.started;
    replaceIdentity(); request.finish(config, { status: 200, data: {token:'late-login',user_info:{id:20},unique_auth:[]} });
    await expect(login).rejects.toThrow('登录会话已改变'); expect(auth.token).toBe('fixture-b');
  });
  it('same-token A -> B -> A old expiry cannot clear the current session', async () => {
    const request = deferredRequest(), reading = actual.shipping.getShippingTemplates(); const config = await request.started;
    surface.dispatchEvent(new Event('supplier-session-changed'));
    request.finish(config, { status: 410002, msg: 'expired', data: null });
    await expect(reading).rejects.toMatchObject({ status: 410002 }); expect(auth.token).toBe('fixture-a');
  });
  it('disposal cancellation reaches every shipping endpoint', async () => {
    const s = scope(); s.dispose(); const adapter = vi.fn(); actual.http.defaults.adapter = adapter;
    for (const call of [() => actual.shipping.getShippingTemplates({},s.signal), () => actual.shipping.getShippingTemplate(10,s.signal),
      () => actual.shipping.getShippingCities(s.signal), () => actual.shipping.deleteShippingTemplate(10,s.signal)]) await expect(call()).rejects.toBeDefined();
    expect(adapter).not.toHaveBeenCalled();
  });
  it.each([{}, null, {status:'200'}, {status:500,msg:'unknown'}, {status:400,msg:'rejected'}])('distinguishes explicit rejection from unknown envelope %j', async body => {
    actual.http.defaults.adapter = async (config: any) => response(config,body);
    const error = await actual.shipping.saveShippingTemplate(10,{}).catch((e: any) => e);
    expect(error instanceof actual.ApiError).toBe(true); expect(error.status === 400).toBe(body?.status === 400);
  });
  it('captures the invoking token before asynchronous Axios dispatch', async () => {
    const headers: string[] = [];
    actual.http.defaults.adapter = async (config: any) => { headers.push(config.headers.Authorization); return response(config, { status: 200, data: { id: 10 } }); };
    const saving = actual.shipping.saveShippingTemplate(10, {}); replaceIdentity(); await saving;
    expect(headers).toEqual(['Bearer fixture-a']);
  });
  it('late old-account expiry cannot clear replacement identity or permissions', async () => {
    const request = deferredRequest(); const saving = actual.shipping.saveShippingTemplate(10, {});
    const config = await request.started; replaceIdentity(); request.finish(config, { status: 410000, msg: 'expired', data: null });
    await expect(saving).rejects.toMatchObject({ status: 410000 });
    expect(storage.getItem('supplier-token')).toBe('fixture-b'); expect(auth.token).toBe('fixture-b');
    expect(auth.permissions).toEqual(['supplier.shipping.view']);
  });
  it('current expiry clears all storage and synchronizes Pinia', async () => {
    actual.http.defaults.adapter = async (config: any) => response(config, { status: 410000, msg: 'expired', data: null });
    await expect(actual.shipping.getShippingTemplates()).rejects.toMatchObject({ status: 410000 });
    expect(storage.getItem('supplier-permissions')).toBeNull(); expect(auth.token).toBe(''); expect(auth.user).toBeNull();
  });
  it.each([false, true])('HTTP 401 invalidates only its invoking identity (replaced=%s)', async replaced => {
    let reject!: (error: unknown) => void, begin!: () => void;
    const started = new Promise<void>(resolve => {begin = resolve;});
    actual.http.defaults.adapter = () => {begin(); return new Promise((_resolve, fail) => {reject = fail;});};
    const reading = actual.shipping.getShippingTemplates(); await started;
    if (replaced) replaceIdentity();
    reject({isAxiosError:true,response:{status:401,data:{status:410000}}});
    await expect(reading).rejects.toBeDefined();expect(auth.token).toBe(replaced?'fixture-b':'');
  });
  it.each([{}, undefined])('does not claim server revocation for malformed logout receipt %j', async data => {
    actual.http.defaults.adapter = async (config: any) => response(config, {status:200,data});
    expect(await auth.signOut()).toBe(false);expect(auth.token).toBe('');expect(storage.getItem('supplier-permissions')).toBeNull();
  });
  it('logout clears the local session immediately but late revocation cannot clear a new login', async () => {
    const request = deferredRequest(); const loggingOut = auth.signOut();
    expect(storage.getItem('supplier-token')).toBeNull(); expect(auth.token).toBe('');
    const config = await request.started; expect(config.headers.Authorization).toBe('Bearer fixture-a');
    replaceIdentity(); request.finish(config, { status: 200, data: null });
    expect(await loggingOut).toBe(true); expect(auth.token).toBe('fixture-b');
  });
  it.each([null, {}, { id: 0 }, { id: '10' }, { id: 11 }, { id: 2147483648 }])('rejects malformed edit receipt %j as unknown', async data => {
    actual.http.defaults.adapter = async (config: any) => response(config, { status: 200, data });
    await expect(actual.shipping.saveShippingTemplate(10, {})).rejects.toThrow('结果未知');
  });
  it('accepts exact edit and positive create receipts, and only null deletion receipts', async () => {
    actual.http.defaults.adapter = async (config: any) => response(config, { status: 200, data: { id: 10 } });
    expect(await actual.shipping.saveShippingTemplate(10, {})).toEqual({ id: 10 });
    expect(await actual.shipping.saveShippingTemplate(0, {})).toEqual({ id: 10 });
    await expect(actual.shipping.deleteShippingTemplate(10)).rejects.toThrow('结果未知');
    actual.http.defaults.adapter = async (config: any) => response(config, { status: 200, data: null });
    expect(await actual.shipping.deleteShippingTemplate(10)).toBeNull();
  });
});
