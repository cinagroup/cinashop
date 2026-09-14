import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { normalizeSupplierShippingTemplateInput } from '@/services/product/ShippingTemplateRules';
import { outRequestHash } from '@/services/out/OutIdempotency';

// Bundle the actual browser modules, as in other frontend contract tests. Do not
// add DOM globals to the Worker compilation or weaken either app's typecheck.
interface CreationIdentity { ownerType: 0 | 2; relationId: number; actorId: number }
interface Intent { schema: number; scope: string; requestKey: string; requestHash: string; payload: Record<string, unknown>; receipt: null | { id: number } }
interface Client { load(): Promise<Intent | null>; prepare(value: Record<string, unknown>): Promise<Intent>;
  send(key: string): Promise<Intent>; recover(key: string): Promise<Intent>; acknowledge(key: string): Promise<void> }
let creationHash: (payload: Record<string, unknown>, owner: 0 | 2) => Promise<string>;
let creationScope: (identity: CreationIdentity) => string;
let createShippingCreation: (identity: CreationIdentity, current: () => boolean,
  transport: { create: (...args: any[]) => Promise<unknown>; lookup: (...args: any[]) => Promise<unknown> }) => Client;
let postShippingCreation: (url: string, header: string, token: string | null, key: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../view/shared');
  const output = await build({ stdin: { resolveDir: root, contents: `export * from './shippingCreation'; export * from './shippingCreationTransport';` },
    bundle: true, write: false, platform: 'browser', format: 'esm' });
  ({ creationHash, creationScope, createShippingCreation, postShippingCreation } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));
});

const admin: CreationIdentity = { ownerType: 0, relationId: 0, actorId: 7 };
const supplier: CreationIdentity = { ownerType: 2, relationId: 40, actorId: 27 };
function payload() { return { id: 0, name: '  运费模板  ', type: 1, status: 1, sort: 0, appoint: 0, no_delivery: 0,
  region_info: [{ city_ids: [[0]], first: '01', first_price: '1.2', continue: 1, continue_price: '0' }], appoint_info: [], no_delivery_info: [] }; }
let values: Map<string, string>, storage: Storage, locks: Set<string>;
beforeEach(() => {
  values = new Map(); locks = new Set();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } } as Storage;
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', { locks: { request: async (key: string, _options: unknown, action: (lock: unknown) => unknown) => {
    if (locks.has(key)) return action(null);
    locks.add(key); try { return await action({ name: key }); } finally { locks.delete(key); }
  } } });
});
afterEach(() => vi.unstubAllGlobals());
function harness(identity = admin) {
  let current = true;
  const transport = { create: vi.fn(), lookup: vi.fn() };
  const instance = () => createShippingCreation(identity, () => current, transport);
  return { instance, transport, invalidate: () => { current = false; } };
}
function success(intent: { requestKey: string; requestHash: string }, replayed?: boolean) {
  return { version: 'shipping-create-v1', requestKey: intent.requestKey, requestHash: intent.requestHash, id: 55, ...(replayed === undefined ? {} : { replayed }) };
}
describe('shipping durable browser intent: exact payload, scope, lock and receipt', () => {
  it.each([admin, supplier])('persists before dispatch and recovers across a new mounted instance (%j)', async identity => {
    const h = harness(identity), first = h.instance(), input = payload();
    const preparing = first.prepare(input); input.name = 'changed while hashing';
    const intent = await preparing;
    expect(intent.payload.name).toBe('  运费模板  '); expect(h.transport.create).not.toHaveBeenCalled();
    h.transport.create.mockImplementation(async (body, key) => {
      const stored = JSON.parse([...values.values()][0]); expect(stored.requestKey).toBe(key); expect(stored.payload).toEqual(body);
      throw new Error('response lost after server commit');
    });
    await expect(first.send(intent.requestKey)).rejects.toThrow('response lost');
    const second = h.instance(); expect(await second.load()).toEqual(intent);
    h.transport.lookup.mockResolvedValue(success(intent));
    const result = await second.recover(intent.requestKey);
    expect(result.receipt?.id).toBe(55); expect(h.transport.create).toHaveBeenCalledTimes(1);
    expect(await h.instance().load()).toEqual(result);
    await second.acknowledge(intent.requestKey); expect(await second.load()).toBeNull();
    expect((await second.prepare(payload())).requestKey).not.toBe(intent.requestKey);
  });
  it('a null lookup never replaces key or payload; only explicit original send retries', async () => {
    const h = harness(), first = h.instance(), intent = await first.prepare(payload());
    h.transport.lookup.mockResolvedValue(null);
    expect(await first.recover(intent.requestKey)).toEqual(intent);
    await expect(first.acknowledge(intent.requestKey)).rejects.toThrow('结果未确认');
    const changed = payload(); changed.name = 'different';
    expect(await h.instance().prepare(changed)).toEqual(intent);
    h.transport.create.mockResolvedValue(success(intent, true));
    expect((await first.send(intent.requestKey)).receipt?.id).toBe(55);
    expect(h.transport.create).toHaveBeenCalledWith(intent.payload, intent.requestKey);
  });
  it.each(['quota', 'readback', 'get', 'no-lock'])('storage/lock failure %s cannot dispatch or mint a fallback', async mode => {
    const h = harness();
    if (mode === 'quota') storage.setItem = () => { throw new Error('quota'); };
    if (mode === 'readback') storage.setItem = () => {};
    if (mode === 'get') storage.getItem = () => { throw new Error('denied'); };
    if (mode === 'no-lock') vi.stubGlobal('navigator', {});
    await expect(h.instance().prepare(payload())).rejects.toBeDefined();
    expect(h.transport.create).not.toHaveBeenCalled(); expect(values.size).toBe(0);
  });
  it.each(['json', 'hash', 'identity', 'uuid', 'schema', 'payload', 'receipt', 'size'])('corrupt %s storage is not treated as absence', async kind => {
    const h = harness(), intent = await h.instance().prepare(payload()), [key] = [...values.keys()];
    const bad: any = structuredClone(intent);
    if (kind === 'hash') bad.requestHash = '0'.repeat(64);
    if (kind === 'identity') bad.scope = '0:0:999';
    if (kind === 'uuid') bad.requestKey = 'invalid';
    if (kind === 'schema') bad.schema = 2;
    if (kind === 'payload') bad.payload.name = 'modified';
    if (kind === 'receipt') bad.receipt = {};
    values.set(key, kind === 'json' ? '{' : kind === 'size' ? ' '.repeat(400001) : JSON.stringify(bad));
    await expect(h.instance().prepare(payload())).rejects.toBeDefined();
    expect(h.transport.create).not.toHaveBeenCalled();
  });
  it.each(['version', 'key', 'hash', 'id', 'extra', 'missing-replayed', 'bad-replayed'])('rejects malformed creation receipt %s without discarding intent', async kind => {
    const h = harness(), client = h.instance(), intent = await client.prepare(payload());
    const result: any = success(intent, false);
    if (kind === 'version') result.version = 'other';
    if (kind === 'key') result.requestKey = crypto.randomUUID();
    if (kind === 'hash') result.requestHash = '0'.repeat(64);
    if (kind === 'id') result.id = '55';
    if (kind === 'extra') result.secret = 'unexpected';
    if (kind === 'missing-replayed') delete result.replayed;
    if (kind === 'bad-replayed') result.replayed = 'false';
    h.transport.create.mockResolvedValue(result);
    await expect(client.send(intent.requestKey)).rejects.toBeDefined();
    expect(await client.load()).toEqual(intent);
  });
  it('serializes tabs and blocks second create while first transport is in flight', async () => {
    const h = harness(), first = h.instance(), second = h.instance(), intent = await first.prepare(payload());
    let finish!: (value: unknown) => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    h.transport.create.mockImplementation(() => { began(); return new Promise(resolve => { finish = resolve; }); });
    const sending = first.send(intent.requestKey); await started;
    await expect(second.prepare(payload())).rejects.toThrow('另一标签页');
    await expect(second.send(intent.requestKey)).rejects.toThrow('另一标签页');
    finish(success(intent, false)); await sending;
    await second.send(intent.requestKey); expect(h.transport.create).toHaveBeenCalledTimes(1);
  });
  it('late old response after identity change cannot mark a receipt confirmed', async () => {
    const h = harness(), client = h.instance(), intent = await client.prepare(payload());
    h.transport.create.mockImplementation(async () => { h.invalidate(); return success(intent, false); });
    await expect(client.send(intent.requestKey)).rejects.toThrow('登录身份');
    expect(JSON.parse([...values.values()][0]).receipt).toBeNull();
    expect((await harness().instance().load())?.requestKey).toBe(intent.requestKey);
  });
  it('actor, owner and supplier relation isolate stored intents, not tokens', async () => {
    const original = await harness(supplier).instance().prepare(payload());
    for (const identity of [admin, { ...supplier, actorId: 28 }, { ...supplier, relationId: 41 }]) expect(await harness(identity).instance().load()).toBeNull();
    expect(await harness(supplier).instance().load()).toEqual(original);
  });
  it('failed receipt persistence keeps the original pending attempt recoverable', async () => {
    const h = harness(), client = h.instance(), intent = await client.prepare(payload());
    h.transport.create.mockResolvedValue(success(intent, false));
    storage.setItem = () => { throw new Error('quota after commit'); };
    await expect(client.send(intent.requestKey)).rejects.toThrow('quota after commit');
    expect((await client.load())?.receipt).toBeNull();
  });
  it('old acknowledgement cannot remove a newer attempt and pending cannot be abandoned', async () => {
    const h = harness(), client = h.instance(), old = await client.prepare(payload());
    h.transport.create.mockResolvedValue(success(old, false)); await client.send(old.requestKey); await client.acknowledge(old.requestKey);
    const newer = await client.prepare(payload());
    await expect(client.acknowledge(old.requestKey)).rejects.toThrow('另一标签页');
    await expect(client.acknowledge(newer.requestKey)).rejects.toThrow('结果未确认');
    expect(await client.load()).toEqual(newer);
  });
  it('confirmed receipt does not become absent or change id', async () => {
    const h = harness(), client = h.instance(), intent = await client.prepare(payload());
    h.transport.create.mockResolvedValue(success(intent, false)); await client.send(intent.requestKey);
    h.transport.lookup.mockResolvedValue(null); await expect(client.recover(intent.requestKey)).rejects.toThrow('已确认回执');
    h.transport.lookup.mockResolvedValue({ ...success(intent), id: 56 }); await expect(client.recover(intent.requestKey)).rejects.toThrow('ID改变');
    expect((await client.load())?.receipt?.id).toBe(55);
  });
  it.each([{ ...admin, actorId: 0 }, { ...admin, relationId: 1 }, { ...supplier, relationId: 0 }])('rejects invalid scope %j', value => {
    expect(() => creationScope(value)).toThrow();
  });
});

describe('client hash compared with actual server normalizer and canonical hash', () => {
  for (const owner of [0, 2] as const) for (const type of [1, 2, 3]) for (const enabled of [0, 1]) {
    it(`owner=${owner} type=${type} enabled=${enabled}`, async () => {
      const input = { ...payload(), type, status: 0, appoint: enabled, no_delivery: enabled,
        appoint_info: [{ city_ids: [[10, 20]], number: '001.0', price: '2.2' }], no_delivery_info: [{ city_ids: [[30]], ignored: 'not hashed' }] };
      expect(await creationHash(input, owner)).toBe(await outRequestHash({ version: 'shipping-create-v1', input: normalizeSupplierShippingTemplateInput(input), status: owner === 2 ? 1 : 0 }));
    });
  }
  it.each(['name', 'type', 'first', 'default', 'loop', 'duplicates', 'free', 'edit'])('rejects invalid %s before persisting', async kind => {
    const input: any = payload();
    if (kind === 'name') input.name = '';
    if (kind === 'type') input.type = 4;
    if (kind === 'first') input.region_info[0].first = '0';
    if (kind === 'default') input.region_info[0].city_ids = [[1]];
    if (kind === 'loop') input.region_info[0].city_ids = [[1, 1]];
    if (kind === 'duplicates') input.region_info.push(structuredClone(input.region_info[0]));
    if (kind === 'free') input.appoint_info = [{ city_ids: [[0]], number: '1', price: '0' }];
    if (kind === 'edit') input.expectedRevision = 'shipping-v1:old';
    await expect(harness().instance().prepare(input)).rejects.toBeDefined(); expect(values.size).toBe(0);
  });
});

describe('real browser transport uses bounded JSON and captured auth', () => {
  it('POST sends exact key/body and captured authorization without retry/redirect', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 200, data: null }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(postShippingCreation('/adminapi/shipping_template/creation-receipt', 'Authori-zation', 'fixture', 'key', {}, new AbortController().signal)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}', redirect: 'error', cache: 'no-store', credentials: 'omit', headers: { 'Authori-zation': 'Bearer fixture', 'Idempotency-Key': 'key' } });
  });
  it.each(['http409', 'http500', 'html', 'large', 'invalid', 'business500', 'missing-data'])('fails closed on %s', async kind => {
    const status = kind === 'http409' ? 409 : kind === 'http500' ? 500 : 200;
    const body = kind === 'large' ? ' '.repeat(4097) : kind === 'invalid' ? '{' : JSON.stringify(kind === 'missing-data' ? { status: 200 } : { status: 500, data: null });
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status, headers: { 'content-type': kind === 'html' ? 'text/html' : 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(postShippingCreation('/fixture', 'Authorization', 'fixture', 'key', {}, new AbortController().signal)).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('aborted or unauthenticated request cannot dispatch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const controller = new AbortController(); controller.abort();
    await expect(postShippingCreation('/fixture', 'Authorization', 'fixture', 'key', {}, controller.signal)).rejects.toBeDefined();
    await expect(postShippingCreation('/fixture', 'Authorization', null, 'key', {}, new AbortController().signal)).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
