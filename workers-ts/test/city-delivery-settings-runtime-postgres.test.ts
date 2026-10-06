import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeDeliveryOrder, storeOrder, cityDeliveryCallbackEvent, cityDeliveryCallbackOutbox, cityDeliveryReconciliationCase } from '../src/models/schema';
import { CityDeliverySettingsRejected } from '../src/services/admin/AdminCityDeliverySettingsInput';
import { dadaApiSignature } from '../src/services/delivery/DadaCityDeliveryProvider';
import { uuApiSignature } from '../src/services/delivery/UuCityDeliveryProvider';
import { normalizeUuCityDeliveryQuery } from '../src/services/delivery/UuCityDeliveryCallback';
import { dadaCallbackChecksum } from '../src/services/delivery/DadaCityDeliveryCallback';
import { isCityDeliveryCallbackOutboxMessage } from '../src/services/delivery/CityDeliveryCallbackService';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { cityDeliverySettingsFixture, citySettingsActor, citySettingsBindings, citySettingsInput, observeCitySettingsDb } from './helpers/cityDeliverySettingsFixture';
import { CITY_DELIVERY_CREDENTIAL_KEYS } from '../../view/common/cityDeliverySettings';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual city delivery runtime shares sealed SQL authority and guarded account rotation', () => {
  let f: Awaited<ReturnType<typeof cityDeliverySettingsFixture>>;
  beforeEach(async () => { f = await cityDeliverySettingsFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  type Peer = Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  const profiles = (run: (app: Peer, admin: Peer) => Promise<void>) => f.withRuntimeRole(app => f.withRuntimeRole(async admin => { await f.installSlice(app, admin); await run(app, admin); }));
  const confirm = (p: { request_id: string; client_nonce: string; payload_hash: string }) => ({ request_id: p.request_id, client_nonce: p.client_nonce, payload_hash: p.payload_hash });
  async function managed(admin: Peer) { const service = f.serviceFor(admin.db), input = citySettingsInput((await service.read()).revision);
    for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) input.credentials[key] = { action: 'replace', value: `new-${key}` };
    const prepared = await service.prepare(input, citySettingsActor); await service.confirm(confirm(prepared), citySettingsActor); return service; }
  const uuBody = (openId = citySettingsBindings.UU_OPEN_ID, state = 777, changeTime = Math.floor(Date.now() / 1000) * 1000) => JSON.stringify({ openId, timestamp: changeTime,
    sign: '0123456789ABCDEF0123456789ABCDEF', biz: JSON.stringify({ originId: 'runtime-uu', orderCode: 'runtime-uu-code', state, changeTime, stateText: 'owned state' }) });

  it('uses all six managed credentials in real provider-query request signatures even while global/provider flags are disabled', async () => profiles(async (app, admin) => {
    await managed(admin); const runtime = f.runtimeFor(app.db), requests: { url: string; body: Record<string, string | number>; headers: Headers }[] = [];
    await f.db.update(storeOrder).set({ deliveryType: 'city_delivery' }).where(eq(storeOrder.id, 91));
    await f.db.insert(storeOrder).values({ id: 92, orderId: 'owned-runtime-uu', unique: 'owned-runtime-uu-checkout', uid: 77, paid: 1, status: 1, deliveryType: 'city_delivery' });
    await f.db.insert(storeDeliveryOrder).values([{ id: 91, oid: 91, uid: 77, stationType: 1, type: 1, relationId: 7, orderId: 'runtime-dada' },
      { id: 92, oid: 92, uid: 77, stationType: 2, type: 0, relationId: 0, orderId: 'runtime-uu', deliveryNo: 'runtime-uu-code' }]);
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body, headers: new Headers(init?.headers) });
      return Response.json(String(url).includes('imdada') ? { status: 'success', code: 0, result: { order_id: 'runtime-dada', status: 2 } }
        : { state: 1, code: 1, body: { originId: 'runtime-uu', orderCode: 'runtime-uu-code', state: 3, changeTime: Date.now(), stateText: 'owned query' } }); });
    expect(await runtime.callback.seedReconciliation()).toBe(2); expect(await runtime.callback.reconcileDue(2)).toMatchObject({ queried: 2, failed: 0 }); expect(mock).toHaveBeenCalledTimes(2);
    const dada = requests.find(row => row.url.includes('imdada'))!, { signature, ...fields } = dada.body;
    expect(fields).toMatchObject({ app_key: 'new-dada_app_key', source_id: 'new-dada_source_id' }); expect(signature).toBe(dadaApiSignature(fields, 'new-dada_app_sercret'));
    const uu = requests.find(row => row.url.includes('uupt'))!; expect(uu.headers.get('X-App-Id')).toBe('new-uupt_app_id'); expect(uu.body.openId).toBe('new-uupt_open_id'); expect(uu.body.sign).toBe(uuApiSignature(String(uu.body.biz), 'new-uupt_appkey', Number(uu.body.timestamp)));
    for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) expect(JSON.stringify(runtime.messages)).not.toContain(`new-${key}`);
    expect((await f.serviceFor(admin.db).read()).flags.city_delivery_status).toBe(0);
  }));
  it('feeds the four SQL flags to actual StoreMobile deliveryInfo without using stale CONFIG_KV values', async () => profiles(async (app, admin) => {
    const runtime = f.runtimeFor(app.db), service = f.serviceFor(admin.db); let input = citySettingsInput((await service.read()).revision); input.flags = { city_delivery_status: 1, self_delivery_status: 0, dada_delivery_status: 1, uu_delivery_status: 0 };
    let prepared = await service.prepare(input, citySettingsActor); await service.confirm(confirm(prepared), citySettingsActor);
    expect(await runtime.store.deliveryInfo(77, 'owned-settings-order')).toMatchObject({ city_delivery_status: true, self_delivery_status: false, dada_delivery_status: true, uu_delivery_status: false });
    input = citySettingsInput((await service.read()).revision, { flags: { ...input.flags, city_delivery_status: 0 } }); prepared = await service.prepare(input, citySettingsActor); await service.confirm(confirm(prepared), citySettingsActor);
    expect(await runtime.store.deliveryInfo(77, 'owned-settings-order')).toMatchObject({ city_delivery_status: false, self_delivery_status: false, dada_delivery_status: false, uu_delivery_status: false }); expect((await service.read()).flags.dada_delivery_status).toBe(1);
  }));
  it('authenticates the deployment token before SQL and rejects an old unrecorded identity at both verification and the fresh receive fence', async () => profiles(async (app, admin) => {
    expect((await app.exec("SELECT has_table_privilege(current_user,'system_config','UPDATE') AS write"))[0]).toEqual({ write: false });
    const runtime = f.runtimeFor(app.db), old = await runtime.callback.verifyUu(uuBody(), citySettingsBindings.UU_CALLBACK_TOKEN); await managed(admin); const before = await f.snapshot();
    await expect(runtime.callback.verifyUu(uuBody(), citySettingsBindings.UU_CALLBACK_TOKEN)).rejects.toThrow('uu_open_id_mismatch'); await expect(runtime.callback.receive(old)).rejects.toThrow('uu_callback_account_changed');
    await expect(runtime.callback.verifyUu(uuBody('new-uupt_open_id'), 'incorrect-token')).rejects.toThrow('uu_callback_token_mismatch'); expect(await f.snapshot()).toEqual(before);
    expect((await runtime.callback.verifyUu(uuBody('new-uupt_open_id'), citySettingsBindings.UU_CALLBACK_TOKEN)).clientId).toBe('new-uupt_open_id');
  }));
  it('ACKs only an exact completed old-account callback replay after rotation, rejecting mutation, failed/dead and query evidence without new DML', async () => profiles(async (app, admin) => {
    const runtime = f.runtimeFor(app.db), raw = uuBody(), event = await runtime.callback.verifyUu(raw, citySettingsBindings.UU_CALLBACK_TOKEN), received = await runtime.callback.receive(event);
    await runtime.callback.dispatchById(received.outboxId); const message = runtime.messages.shift(); if (!message || !isCityDeliveryCallbackOutboxMessage(message)) throw Error('Actual callback dispatch message missing'); expect(await runtime.callback.processMessage(message)).toBe('completed');
    expect((await f.snapshot()).events[0].status).toBe('IGNORED'); await managed(admin); const before = await f.snapshot();
    const exact = await runtime.callback.verifyUu(raw, citySettingsBindings.UU_CALLBACK_TOKEN); expect(await runtime.callback.receive(exact)).toMatchObject({ duplicate: true, historicalReplay: true, eventId: received.eventId, outboxId: received.outboxId }); expect(runtime.messages).toHaveLength(0); expect(await f.snapshot()).toEqual(before);
    await expect(runtime.callback.verifyUu(uuBody(citySettingsBindings.UU_OPEN_ID, 776, event.providerUpdateTime * 1000), citySettingsBindings.UU_CALLBACK_TOKEN)).rejects.toThrow('uu_open_id_mismatch');
    const query = normalizeUuCityDeliveryQuery({ originId: 'runtime-uu', orderCode: 'runtime-uu-code', state: 777, changeTime: event.providerUpdateTime * 1000, stateText: 'owned state' }, { expectedOpenId: citySettingsBindings.UU_OPEN_ID, originId: 'runtime-uu', observedAt: event.providerUpdateTime });
    await expect(runtime.callback.receive(query)).rejects.toThrow('uu_callback_account_changed');
    for (const state of ['FAILED', 'DEAD'] as const) { await f.db.update(cityDeliveryCallbackEvent).set({ status: state }).where(eq(cityDeliveryCallbackEvent.id, received.eventId)); const snapshot = await f.snapshot();
      await expect(runtime.callback.verifyUu(raw, citySettingsBindings.UU_CALLBACK_TOKEN)).rejects.toThrow('uu_open_id_mismatch'); await expect(runtime.callback.receive(exact)).rejects.toThrow('uu_callback_account_changed'); expect(await f.snapshot()).toEqual(snapshot); }
  }));
  it.each(['dada', 'uu'] as const)('blocks %s credential rotation for nonterminal/unknown attempts and any unfinished event/outbox/reconciliation', async provider => profiles(async (app, admin) => {
    const service = f.serviceFor(admin.db), runtime = f.runtimeFor(app.db), key = provider === 'dada' ? 'dada_app_key' : 'uupt_appkey';
    const input = citySettingsInput((await service.read()).revision); input.credentials[key] = { action: 'replace', value: 'rotation-blocked-new' }; const prepared = await service.prepare(input, citySettingsActor);
    const blocked = async () => { const before = await f.snapshot(); await expect(service.confirm(confirm(prepared), citySettingsActor)).rejects.toBeInstanceOf(CityDeliverySettingsRejected); expect(await f.snapshot()).toEqual(before); };
    await f.db.insert(storeDeliveryOrder).values({ id: 91, oid: 91, uid: 77, stationType: provider === 'dada' ? 1 : 2, orderId: 'rotation-unknown', status: 777 }); await blocked(); await f.db.delete(storeDeliveryOrder);
    const updateTime = Math.floor(Date.now() / 1000), event = provider === 'uu' ? await runtime.callback.verifyUu(uuBody(), citySettingsBindings.UU_CALLBACK_TOKEN)
      : runtime.callback.verifyDada(JSON.stringify({ client_id: citySettingsBindings.DADA_CLIENT_ID, order_id: 'runtime-dada', order_status: 777, update_time: updateTime, signature: dadaCallbackChecksum(citySettingsBindings.DADA_CLIENT_ID, 'runtime-dada', updateTime) }), citySettingsBindings.DADA_CALLBACK_TOKEN);
    const received = await runtime.callback.receive(event); await blocked();
    await f.db.update(cityDeliveryCallbackEvent).set({ status: 'IGNORED' }).where(eq(cityDeliveryCallbackEvent.id, received.eventId)); await blocked();
    await f.db.update(cityDeliveryCallbackOutbox).set({ status: 'COMPLETED' }).where(eq(cityDeliveryCallbackOutbox.id, received.outboxId));
    await f.db.insert(storeDeliveryOrder).values({ id: 91, oid: 91, uid: 77, stationType: provider === 'dada' ? 1 : 2, orderId: 'terminal-attempt', status: 4 });
    await f.db.insert(cityDeliveryReconciliationCase).values({ provider, subjectKeyHash: event.subjectKeyHash, deliveryOrderId: 91, status: 'DEAD' }); await blocked();
    await f.db.update(cityDeliveryReconciliationCase).set({ status: 'RESOLVED' }); await service.confirm(confirm(prepared), citySettingsActor);
  }));
  it('holds provider tables before reading attempts and blocks a direct importer phantom until the atomic journal commits', async () => profiles(async (_app, admin) => {
    const service = f.serviceFor(admin.db), input = citySettingsInput((await service.read()).revision); input.credentials.uupt_open_id = { action: 'replace', value: 'rotated-open-id' };
    const prepared = await service.prepare(input, citySettingsActor), entered = gate(), release = gate(); let gated = false;
    const db = observeCitySettingsDb(admin.db, async (_tx, command) => { if (!gated && /LOCK TABLE.*store_delivery_order.*SHARE ROW EXCLUSIVE/i.test(command)) { gated = true; entered.resolve(); await release.promise; } });
    const saving = outcome(f.serviceFor(db).confirm(confirm(prepared), citySettingsActor)); await entered.promise;
    await f.withPeer(async importer => { const inserting = outcome(importer.db.insert(storeDeliveryOrder).values({ oid: 91, uid: 77, stationType: 2, orderId: 'late-importer', status: 0 }));
      try { await waitForFinanceBlock(f.db, importer.pid, admin.pid); expect((await f.exec(`SELECT mode FROM pg_locks WHERE pid=${admin.pid} AND relation='store_delivery_order'::regclass AND granted`)).some(row => row.mode === 'ShareRowExclusiveLock')).toBe(true); }
      finally { release.resolve(); }
      expect((await saving).ok).toBe(true); expect((await inserting).ok).toBe(true); });
    expect((await f.snapshot()).logs.filter(row => row.type === 'city_delivery_settings')).toHaveLength(1);
  }));
  it('waits for an existing importer and then reads fresh committed in-flight evidence before any effective DML', async () => profiles(async (_app, admin) => {
    const service = f.serviceFor(admin.db), input = citySettingsInput((await service.read()).revision); input.credentials.uupt_appkey = { action: 'clear' }; const prepared = await service.prepare(input, citySettingsActor);
    await f.withPeer(async importer => { const entered = gate(), release = gate(); const writing = importer.db.transaction(async tx => { await tx.insert(storeDeliveryOrder).values({ oid: 91, uid: 77, stationType: 2, orderId: 'prior-importer', status: 777 }); entered.resolve(); await release.promise; }); await entered.promise;
      const saving = outcome(service.confirm(confirm(prepared), citySettingsActor)); try { await waitForFinanceBlock(f.db, admin.pid, importer.pid); } finally { release.resolve(); await writing; }
      const result = await saving; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(CityDeliverySettingsRejected); });
    expect((await f.snapshot()).logs.filter(row => row.type === 'city_delivery_settings')).toEqual([]); expect((await service.read()).credentials.uupt_appkey.source).toBe('env');
  }));
});
