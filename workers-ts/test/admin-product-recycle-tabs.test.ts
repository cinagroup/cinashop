import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const markerKey = 'admin_recycle_unconfirmed_v1', markersLock = 'cinashop:product-recycle-markers';
const outcomeLock = 'cinashop:product-recycle-outcome:20:51';
const body = 0 as const;
const query = { page: 1, limit: 10, type: '' as const, store_name: '' };
const gate = <T = void>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; };
async function flush() { for (let turn = 0; turn < 35; turn++) await Promise.resolve(); }
type Runtime = {
  request: { defaults: { adapter: (config: { method: string; url: string; data?: string; headers: Record<string, unknown> }) => Promise<unknown> } };
  apiAdminProductRecycle(id: number, value: typeof body): Promise<void>;
  apiAdminProductList(value: typeof query): Promise<{ list: Array<{ id: number; is_del: number }> }>;
  acknowledgeRecycleRead(id: number): Promise<void>;
  canAcknowledgeRecycle(id: number): boolean;
  hasUnconfirmedRecycle(id: number): boolean;
  isRecycleWritePending(id: number): boolean;
};

/** Explicit Web Locks host fixture: one exclusive lock per name, FIFO waiting
 * for ordinary requests, ifAvailable callbacks receive null without waiting,
 * and callback settlement releases the lock BEFORE the returned promise.
 * The two compiled API instances do not share their module pending/observed
 * maps. They share only browser storage and this cross-context lock host. */
function lockHost() {
  type Job = { callback: (lock: { name: string; mode: 'exclusive' } | null) => unknown; resolve(value: unknown): void; reject(error: unknown): void };
  const held = new Set<string>(), waiting = new Map<string, Job[]>(), unavailable: string[] = [];
  function start(name: string, job: Job) {
    held.add(name);
    const finish = () => { held.delete(name); const next = waiting.get(name)?.shift(); if (next) start(name, next); };
    Promise.resolve().then(() => job.callback({ name, mode: 'exclusive' })).then(value => { finish(); job.resolve(value); }, error => { finish(); job.reject(error); });
  }
  function request(name: string, options: { ifAvailable?: boolean } | Job['callback'], callback?: Job['callback']): Promise<unknown> {
    const action = typeof options === 'function' ? options : callback;
    if (!action) return Promise.reject(Error('Fixture lock callback missing'));
    if (held.has(name) && typeof options !== 'function' && options.ifAvailable) { unavailable.push(name); return Promise.resolve().then(() => action(null)); }
    return new Promise((resolve, reject) => {
      const job: Job = { callback: action, resolve, reject };
      if (held.has(name)) { const queue = waiting.get(name) ?? []; queue.push(job); waiting.set(name, queue); }
      else start(name, job);
    });
  }
  return { request, held, unavailable, queued: (name: string) => waiting.get(name)?.length ?? 0 };
}

describe('actual recycle APIs in two independent browser-module instances sharing Web Locks', () => {
  let compiled: string, values: Map<string, string>, locks: ReturnType<typeof lockHost>, first: Runtime, second: Runtime;
  let calls: Array<{ tab: string; method: string; path: string; bearer: unknown }>, serverState: number;
  let firstPost: ReturnType<typeof gate<number>> | undefined, secondGet: ReturnType<typeof gate<number>> | undefined;
  beforeAll(async () => {
    const built = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'],
      alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, stdin: { resolveDir: root,
        contents: `export * from './src/api/productRecycle';export {apiAdminProductList} from './src/api/product';export {default as request} from './src/utils/request';` } });
    compiled = built.outputFiles[0].text;
  }, 30000);
  beforeEach(() => {
    values = new Map(); locks = lockHost(); calls = []; serverState = 0; firstPost = secondGet = undefined;
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product', search: '', href: '' } }));
    vi.stubGlobal('navigator', { locks }); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Cross-tab API proof forbids remote I/O'));
    login();
    const instance = (tab: string) => {
      const module = { exports: {} }; new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
      const api = module.exports as Runtime;
      api.request.defaults.adapter = async config => {
        calls.push({ tab, method: config.method, path: config.url, bearer: config.headers['Authori-zation'] });
        let status = 200, data: unknown = null;
        if (config.method === 'delete') { status = firstPost ? await firstPost.promise : 200; data = []; }
        else if (config.url === '/product/product') {
          const state = tab === 'second' && secondGet ? await secondGet.promise : serverState;
          data = { list: [{ id: 51, product_type: 0, is_del: state, stock: 12 }], count: 1 };
        } else throw Error(`Unexpected actual API path ${config.url}`);
        return { data: { status, msg: status === 200 ? 'ok' : 'lost result', data }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
      };
      return api;
    };
    first = instance('first'); second = instance('second');
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function login(id = 20, token = 'same-owner-token') {
    values.set('admin_token', token);
    values.set('admin_session', JSON.stringify({ userInfo: { id, account: `manager-${id}`, level: 1, roles: '7' }, menus: [], uniqueAuth: ['product.view', 'product.manage'] }));
  }
  const lost = (work: Promise<void>) => work.then(() => null, (error: unknown) => error);

  it('rejects a second-tab decision and never treats a read begun while another tab owns the pending request as recovery evidence', async () => {
    firstPost = gate<number>();
    const writing = lost(first.apiAdminProductRecycle(51, body)); await flush();
    expect(calls.filter(call => call.method === 'delete')).toHaveLength(1); expect(locks.held.has(outcomeLock)).toBe(true);
    expect(first.isRecycleWritePending(51)).toBe(true); expect(second.isRecycleWritePending(51)).toBe(false);
    await expect(second.apiAdminProductRecycle(51, body)).rejects.toThrow('其他页面');
    expect((await second.apiAdminProductList(query)).list[0].is_del).toBe(0);
    expect(locks.unavailable).toContain(outcomeLock); expect(second.canAcknowledgeRecycle(51)).toBe(false);
    await expect(second.acknowledgeRecycleRead(51)).rejects.toThrow('其他页面');
    serverState = 1; firstPost.resolve(500); expect(await writing).toMatchObject({ message: 'lost result' });
    expect(locks.held.has(outcomeLock)).toBe(false); expect(second.hasUnconfirmedRecycle(51)).toBe(true);
    expect(second.canAcknowledgeRecycle(51)).toBe(false);
    await expect(second.acknowledgeRecycleRead(51)).rejects.toThrow('先重新读取');
    expect((await second.apiAdminProductList(query)).list[0].is_del).toBe(1);
    expect(second.canAcknowledgeRecycle(51)).toBe(true); await second.acknowledgeRecycleRead(51);
    expect(JSON.parse(values.get(markerKey)!)).toEqual([]); expect(calls.filter(call => call.method === 'delete')).toHaveLength(1);
  });

  it('does not let an earlier second-tab GET arriving after unknown write completion reconcile the new run marker', async () => {
    secondGet = gate<number>();
    const reading = second.apiAdminProductList(query); await flush();
    firstPost = gate<number>(); const writing = lost(first.apiAdminProductRecycle(51, body)); await flush();
    serverState = 1; firstPost.resolve(500); expect(await writing).toMatchObject({ message: 'lost result' });
    secondGet.resolve(0); expect((await reading).list[0].is_del).toBe(0); secondGet = undefined;
    expect(second.canAcknowledgeRecycle(51)).toBe(false); await expect(second.acknowledgeRecycleRead(51)).rejects.toThrow('先重新读取');
    expect((await second.apiAdminProductList(query)).list[0].is_del).toBe(1); await second.acknowledgeRecycleRead(51);
    expect(calls.filter(call => call.method === 'delete')).toHaveLength(1);
  });

  it('rechecks identity after waiting for the real marker mutex and sends no old-owner request with a replacement bearer', async () => {
    const release = gate<void>();
    const hold = locks.request(markersLock, async () => release.promise); await flush();
    const writing = lost(first.apiAdminProductRecycle(51, body)); await flush();
    expect(locks.queued(markersLock)).toBe(1); expect(locks.held.has(outcomeLock)).toBe(true);
    login(21, 'replacement-owner-token'); release.resolve(); await hold;
    expect(await writing).toMatchObject({ message: '登录身份已变化，请重新读取商品' });
    expect(calls.filter(call => call.method === 'delete')).toHaveLength(0); expect(values.has(markerKey)).toBe(false);
    expect(locks.held.has(outcomeLock)).toBe(false); login(); expect(first.isRecycleWritePending(51)).toBe(false);
  });
  it('releases both locks after rejecting an existing unknown marker, so a fresh read and acknowledgement can follow',async()=>{
    firstPost=gate<number>();const writing=lost(first.apiAdminProductRecycle(51,body));await flush();firstPost.resolve(500);await writing;
    await expect(second.apiAdminProductRecycle(51,body)).rejects.toThrow('尚未确认');
    expect(locks.held.has(outcomeLock)).toBe(false);expect(locks.held.has(markersLock)).toBe(false);
    await second.apiAdminProductList(query);await second.acknowledgeRecycleRead(51);
    expect(second.hasUnconfirmedRecycle(51)).toBe(false);expect(calls.filter(call=>call.method==='delete')).toHaveLength(1);
  });
});
