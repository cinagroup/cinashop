/** Real Admin assisted checkout -> default RSA/AES Routine payment -> App paid
 * consumer -> actual Admin grant -> exported current-store Manager HTTP router -> real
 * notice/immutable receipt -> App Queue shipping and first upload. Only provider,
 * KV/Queue transport and the explicitly labelled late SQL-fault adapter are local.
 * No paid/cart/grant/outbox/delivery success is seeded by maintenance SQL. This
 * proves controlled-author correlation, not independent App assignment approval
 * or createApp full-stack coverage. The exported router retains real middleware. */
import { randomUUID } from 'node:crypto';
import { and, eq, SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as Di from '@/lib/di';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { orderNotificationDelivery, storeOrder, storeOrderCartInfo, storeOrderOutbox, systemStoreStaff } from '@/models/schema';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { StoreManagerAssignedFulfillmentService } from '@/services/store/StoreManagerAssignedFulfillmentService';
import { requireStoreManagerScope, merchantOrderRevision } from '@/services/store/StoreManagerScope';
import { ASSIGNED_FULFILLMENT_VERSION, assignedFulfillmentHash, type AssignedFulfillmentInput } from '@/services/store/ManagerAssignedFulfillmentInput';
import { readRoutineAppId } from '@/services/wechat/RoutineRuntimeConfig';
import { assignmentRequestHash, type AssignmentRequest } from '@/services/order/FulfillmentAssignmentProtocol';
import type { RoutineShippingDispatch, RoutineShippingRequest } from '@/services/payment/RoutineShippingDispatch';
import { managerAssignedFulfillmentFixture, ASSIGNED_APP, ASSIGNED_PAYER, ASSIGNED_AES, ASSIGNED_BUYER_BINDING,
  ASSIGNED_SHIPPING_SECRET, ASSIGNED_CARRIER } from './helpers/managerAssignedFulfillmentFixture';

type Fixture = Awaited<ReturnType<typeof managerAssignedFulfillmentFixture>>;
type Query = Pick<DbClient, 'execute'>;
type Review = Awaited<ReturnType<StoreManagerAssignedFulfillmentService['review']>>;
type Inbox = Awaited<ReturnType<StoreManagerAssignedFulfillmentService['inbox']>>;
const base = '/store/manager/assigned-order';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Manager assigned whole express through HTTP outbox and App shipping', () => {
  let f: Fixture;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>, connections: MockInstance<typeof Di.createDbFromConnectionString>;
  const logs: unknown[] = [];
  const service = (db: DbClient = f.managerRuntime.db) => new StoreManagerAssignedFulfillmentService(createContainerFromDb(db), f.env, f.peers);
  const consumer = () => new OrderNotificationDeliveryService(f.application(), f.env);
  const noSecrets = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const secret of [ASSIGNED_PAYER, ASSIGNED_BUYER_BINDING, ASSIGNED_AES, ASSIGNED_SHIPPING_SECRET, f.env.APP_KEY, 'BEGIN PRIVATE KEY'])
      expect(text).not.toContain(secret);
  };
  const receipts = async (id: number) => Array.from(await f.maintenanceDb.execute<{ row: unknown; xmin: string }>(sql`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin
    FROM public.manager_assigned_fulfillment_request t WHERE order_id=${id} ORDER BY actor_uid,request_key`));
  const grants = async (id: number) => Array.from(await f.maintenanceDb.execute<{ row: unknown; xmin: string }>(sql`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin
    FROM public.store_order_fulfillment_assignment t WHERE order_id=${id} ORDER BY ordinal`));
  const carts = (id: number) => f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id));
  const notices = (id: number) => f.maintenanceDb.select().from(storeOrderOutbox)
    .where(and(eq(storeOrderOutbox.aggregateId, id), eq(storeOrderOutbox.eventType, 'order.delivery.notice')));
  const facts = async (id: number) => {
    const [row] = await f.maintenanceDb.execute<{ value: unknown }>(sql`SELECT pg_catalog.jsonb_build_object(
      'order',(SELECT pg_catalog.to_jsonb(t) FROM public.store_order t WHERE id=${id}),
      'carts',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY id) FROM public.store_order_cart_info t WHERE oid=${id}),
      'status',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY id) FROM public.store_order_status t WHERE oid=${id}),
      'outbox',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY id) FROM public.store_order_outbox t WHERE aggregate_id=${id} AND aggregate_type='order'),
      'assignments',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY ordinal) FROM public.store_order_fulfillment_assignment t WHERE order_id=${id}),
      'receipts',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY actor_uid,request_key) FROM public.manager_assigned_fulfillment_request t WHERE order_id=${id}),
      'stock',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY id) FROM public.store_product_attr_value t),
      'products',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY id) FROM public.store_product t)) AS value`);
    return row.value;
  };
  const reviewed = async (id: number, uid = 103, store = 77): Promise<Review> => {
    const r = await f.http(base + '/review/' + id + '?store_id=' + store, undefined, { uid }); noSecrets(r.body);
    expect(r.response.status).toBe(200); expect(r.body.status, r.body.msg).toBe(200);
    expect(r.response.headers.get('Cache-Control')).toBe('private, no-store'); return r.body.data;
  };
  const inbox = async (after = 0, uid = 103, store = 77): Promise<Inbox> => {
    const r = await f.http(base + '/inbox?store_id=' + store + '&after=' + after, undefined, { uid }); noSecrets(r.body);
    expect(r.response.status).toBe(200); expect(r.body.status, r.body.msg).toBe(200);
    expect(r.response.headers.get('Cache-Control')).toBe('private, no-store'); return r.body.data;
  };
  const lastOrderId = async () => (await f.maintenanceDb.execute<{ id: number }>(sql`SELECT COALESCE(max(id),0)::integer AS id FROM public.store_order`))[0].id;
  function input(r: Review, tracking = 'ASSIGNED-' + r.order_id): AssignedFulfillmentInput {
    return { version: ASSIGNED_FULFILLMENT_VERSION, order_id: r.order_id, store_id: r.store_id, scope_key: r.scope_key,
      assignment_operation_id: r.grant.operation_id, assignment_ordinal: r.grant.ordinal, assignment_payload_hash: r.grant.payload_hash,
      expected_assignment_source_hash: r.grant.source_hash, expected_order_revision: r.order_revision,
      payload: { type: 1, express_record_type: 1, delivery_name: ASSIGNED_CARRIER.name, delivery_code: ASSIGNED_CARRIER.code, delivery_id: tracking } };
  }
  async function committed(body: AssignedFulfillmentInput, key = randomUUID(), uid = 103) {
    const r = await f.http(base + '/commit', body, { key, uid }); noSecrets(r.body);
    expect(r.response.status).toBe(200); expect(r.body.status, r.body.msg).toBe(200);
    expect(r.response.headers.get('Cache-Control')).toBe('private, no-store'); return { key, result: r.body.data };
  }
  async function prepared(type: 0 | 1 = 1) {
    const order = await f.paid(1, type), grant = await f.decide(order.id), r = await reviewed(order.id);
    expect(r).toMatchObject({ order_id: order.id, store_id: 77, financial_store_id: 0,
      grant: { operation_id: grant.receipt.operation_id, ordinal: 1, payload_hash: grant.receipt.payload_hash, source_hash: grant.receipt.source_hash } });
    expect(r.order_revision).toBe(grant.receipt.order_revision);
    expect(r.carriers).toEqual(expect.arrayContaining([ASSIGNED_CARRIER]));
    return { order, grant, reviewed: r, body: input(r) };
  }
  async function hold(lock: (tx: Query) => Promise<unknown>, work: () => Promise<void>) {
    await f.withMaintenancePeer(async peer => {
      let ready!: () => void, release!: () => void;
      const acquired = new Promise<void>(r => { ready = r; }), released = new Promise<void>(r => { release = r; });
      const held = peer.transaction(async tx => { await lock(tx); ready(); await released; });
      try { await Promise.race([acquired, held.then(() => { throw Error('Assigned business lock holder ended early'); })]); await work(); }
      finally { release(); await held; }
    });
  }
  async function queuedShipping(id: number) {
    const events = await notices(id); expect(events).toHaveLength(1); const event = events[0];
    const outbox = new OrderOutboxService(f.application(), f.env);
    let message = f.messages.filter(isOrderNotificationOutboxMessage).find(m => m.outboxId === event.id && m.eventKey === event.eventKey);
    if (!message) {
      expect((await outbox.dispatchById(event.id)).enqueued).toBe(1);
      message = f.messages.filter(isOrderNotificationOutboxMessage).find(m => m.outboxId === event.id && m.eventKey === event.eventKey);
    }
    expect(message).toBeDefined(); noSecrets(message);
    expect(await outbox.processMessage(message!)).toBe('completed');
    const rows = await f.maintenanceDb.select().from(orderNotificationDelivery)
      .where(and(eq(orderNotificationDelivery.eventKey, event.eventKey), eq(orderNotificationDelivery.channel, 'wechat_shipping')));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: 'PENDING', orderId: id, target: '' });
    const before = f.messages.length;
    expect((await consumer().dispatchPending(20, event.eventKey)).enqueued).toBeGreaterThan(0);
    const shipped = f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m => m.channel === 'wechat_shipping' && m.deliveryId === rows[0].id);
    expect(shipped).toHaveLength(1); expect(Object.keys(shipped[0]).sort()).toEqual(['action', 'channel', 'deliveryId', 'eventKey']);
    noSecrets(shipped); return { event, delivery: rows[0], message: shipped[0] };
  }
  function transport(order: typeof storeOrder.$inferSelect, tracking: string) {
    let uploads = 0, tokens = 0, carriers = 0; const bodies: RoutineShippingRequest[] = [];
    network.mockImplementation(async (urlInput, init) => {
      const url = new URL(String(urlInput)); expect(url.origin).toBe('https://api.weixin.qq.com');
      if (url.pathname === '/cgi-bin/token') {
        tokens++; expect(url.searchParams.get('appid')).toBe(ASSIGNED_APP); expect(url.searchParams.get('secret')).toBe(ASSIGNED_SHIPPING_SECRET);
        return Response.json({ access_token: 'synthetic-assigned-original-access', expires_in: 7200 });
      }
      expect(url.searchParams.get('access_token')).toBe('synthetic-assigned-original-access'); expect(init?.method).toBe('POST');
      if (url.pathname.endsWith('/get_delivery_list')) {
        carriers++; return Response.json({ errcode: 0, errmsg: 'ok', count: 1, delivery_list: [{ delivery_id: 'OWN', delivery_name: ASSIGNED_CARRIER.name }] });
      }
      expect(url.pathname).toBe('/wxa/sec/order/upload_shipping_info'); uploads++;
      const body = JSON.parse(String(init?.body)) as RoutineShippingRequest; bodies.push(body);
      expect(body).toMatchObject({ order_key: { order_number_type: 2, transaction_id: order.tradeNo }, payer: { openid: ASSIGNED_PAYER },
        logistics_type: 1, delivery_mode: 1, shipping_list: [{ tracking_no: tracking, express_company: 'OWN' }] });
      expect(body.shipping_list).toHaveLength(1); expect(JSON.stringify(body)).not.toContain(ASSIGNED_BUYER_BINDING);
      // The real provider transport runs after the App SQL snapshot released
      // its physical source and notification locks, never inside the Manager tx.
      await f.withMaintenancePeer(async peer => withTx(createContainerFromDb(peer), async tx => {
        expect(await tx.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.id, order.id)).for('update', { noWait: true })).toHaveLength(1);
        expect(await tx.select({ id: orderNotificationDelivery.id }).from(orderNotificationDelivery)
          .where(and(eq(orderNotificationDelivery.orderId, order.id), eq(orderNotificationDelivery.channel, 'wechat_shipping'))).for('update', { noWait: true })).toHaveLength(1);
        const [idle] = await tx.execute<{ n: number }>(sql`SELECT pg_catalog.count(*)::integer AS n FROM pg_catalog.pg_stat_activity
          WHERE usename IN(${f.appRuntime.role},${f.managerRuntime.role}) AND state='idle in transaction'`);
        expect(idle.n).toBe(0);
      }));
      return Response.json({ errcode: 0, errmsg: 'ok' });
    });
    return { uploads: () => uploads, tokens: () => tokens, carriers: () => carriers, bodies: () => bodies };
  }

  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No unplanned provider transport in assigned fulfillment acceptance'));
    for (const name of ['log', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation((...args: unknown[]) => { logs.push(args); });
    f = await managerAssignedFulfillmentFixture(); connections = vi.spyOn(Di, 'createDbFromConnectionString');
  }, 180000);
  beforeEach(() => { network.mockReset().mockRejectedValue(Error('No unplanned provider transport in assigned fulfillment acceptance')); connections.mockClear(); });
  afterEach(() => { noSecrets(logs); noSecrets(f.messages); });
  afterAll(async () => { try { if (f) await f.close(); } finally { vi.restoreAllMocks(); } }, 30000);

  it('delivers a real inventory-store-one root under store77 grant through production Manager HTTP and first archived-App upload', async () => {
    const c = await prepared(), beforeCarts = await carts(c.order.id), beforeGrant = await grants(c.order.id);
    expect(beforeCarts).toHaveLength(1); expect(beforeCarts[0]).toMatchObject({ type: 1, relationId: 1 });
    expect(c.order).toMatchObject({ paid: 1, pid: 0, storeId: 0, supplierId: 0, status: 0, isChannel: 2 });
    expect(network).not.toHaveBeenCalled();
    const { key, result } = await committed(c.body);
    expect(result).toMatchObject({ replayed: false, receipt: { request_key: key, actor_uid: 103, target_store_id: 77, staff_id: 901,
      root_order_id: c.order.id, order_id: c.order.id, financial_store_id: 0, supplier_id: 0,
      kind: 'assigned_whole_express', outcome: 'delivery-recorded', assignment_operation_id: c.grant.receipt.operation_id } });
    expect(result.receipt).not.toHaveProperty('intent');
    expect(await f.actual(c.order.id)).toMatchObject({ status: 1, deliveryType: 'express', deliveryName: ASSIGNED_CARRIER.name,
      deliveryCode: ASSIGNED_CARRIER.code, deliveryId: c.body.payload.delivery_id, storeId: 0, supplierId: 0 });
    expect(await carts(c.order.id)).toEqual(beforeCarts); expect(await grants(c.order.id)).toEqual(beforeGrant);
    const immutableReceipt = await receipts(c.order.id); expect(immutableReceipt).toHaveLength(1);
    expect(immutableReceipt[0].row).toMatchObject({ ...result.receipt, intent: c.body });
    expect(result.receipt.request_hash).toBe(await assignedFulfillmentHash(103, key, c.body));
    expect(result.receipt.post_order_revision).toBe(await merchantOrderRevision(await f.actual(c.order.id)));
    const [event] = await notices(c.order.id); expect(event).toBeDefined();
    expect(result.receipt).toMatchObject({ delivery_outbox_id: event.id, delivery_event_key: event.eventKey, delivery_payload_hash: await outRequestHash(event.payload) });
    // Notice retains the real financial/order/buyer shipping facts. It contains
    // no invented Manager provenance or changed financial store 77.
    expect(event.payload).toMatchObject({ orderId: c.order.id, userId: 11, deliveryId: c.body.payload.delivery_id });
    expect(event.payload).not.toHaveProperty('actor'); expect(event.payload).not.toHaveProperty('assignment');
    const altered = await f.http(base + '/commit', { ...c.body, payload: { ...c.body.payload, delivery_id: 'CHANGED-' + c.order.id } }, { key });
    expect(altered.body.status).not.toBe(200); expect(await receipts(c.order.id)).toEqual(immutableReceipt);
    expect(await notices(c.order.id)).toHaveLength(1);
    const revoke = await f.decide(c.order.id, 77, 'revoke'); expect(revoke.receipt.kind).toBe('revoke');
    expect((await committed(c.body, key)).result).toEqual({ ...result, replayed: true });
    await f.configure(true);
    expect(await readRoutineAppId(f.application())).toBe('wx_assigned_current_B');
    expect(await readRoutineAppId(f.application())).not.toBe(ASSIGNED_APP);
    const staged = await queuedShipping(c.order.id), calls = transport(c.order, c.body.payload.delivery_id);
    expect(await consumer().processMessage(staged.message)).toBe('sent'); expect(calls.uploads()).toBe(1); expect(calls.carriers()).toBe(1);
    const [sent] = await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, staged.delivery.id));
    expect(sent).toMatchObject({ status: 'SENT', responseCode: '0' });
    const dispatch = await f.maintenanceDb.execute<{ payload: RoutineShippingDispatch['payload'] }>(sql`SELECT payload FROM public.routine_shipping_dispatch WHERE delivery_id=${staged.delivery.id}`);
    expect(dispatch).toHaveLength(1);
    const [appIdentity] = await f.maintenanceDb.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${f.appRuntime.role}`);
    expect(dispatch[0].payload.actor).toEqual({ role: f.appRuntime.role, roleOid: appIdentity.oid });
    expect(dispatch[0].payload.identity).toMatchObject({ rootId: c.order.id, appId: ASSIGNED_APP, payerId: ASSIGNED_PAYER });
    expect(await f.maintenanceDb.execute(sql`SELECT e.evidence_id FROM public.routine_shipping_provider_evidence e
      JOIN public.routine_shipping_dispatch d ON d.dispatch_id=e.dispatch_id WHERE d.delivery_id=${staged.delivery.id}`)).toHaveLength(1);
    expect(connections.mock.calls.filter(call => call[2]?.applicationName === 'cinashop_routine_shipping_verify').length).toBeGreaterThan(0);
    expect(await consumer().processMessage(staged.message)).toBe('already-sent'); expect(calls.uploads()).toBe(1);
    expect(await receipts(c.order.id)).toEqual(immutableReceipt); expect(await carts(c.order.id)).toEqual(beforeCarts);
    // Explicit current-role revocation is an adversarial fixture change. Owner
    // JWT recovery remains minimal and must not re-deliver or disclose intent.
    await f.maintenanceDb.update(systemStoreStaff).set({ isManager: 0, isAdmin: 0 }).where(eq(systemStoreStaff.id, 901));
    try {
      const recovered = await f.http(base + '/receipt/' + key); expect(recovered.body.status, recovered.body.msg).toBe(200);
      expect(recovered.body.data).toEqual({ state: 'recorded', receipt: result.receipt }); noSecrets(recovered.body);
      expect(recovered.body.data.receipt).not.toHaveProperty('intent');
      expect((await f.http(base + '/receipt/' + key, undefined, { uid: 105 })).body.data).toEqual({ state: 'unknown', receipt: null });
      expect((await f.http(base + '/receipt/' + randomUUID())).body.data).toEqual({ state: 'unknown', receipt: null });
      expect((await f.http(base + '/commit', c.body, { key })).body.status).not.toBe(200);
    } finally { await f.maintenanceDb.update(systemStoreStaff).set({ isManager: 1 }).where(eq(systemStoreStaff.id, 901)); }
  }, 90000);

  it('also admits a real type-zero platform inventory source without changing its financial owner', async () => {
    const c = await prepared(0), before = await carts(c.order.id);
    const saved = await committed(c.body); expect(saved.result.replayed).toBe(false);
    expect(await f.actual(c.order.id)).toMatchObject({ status: 1, storeId: 0, supplierId: 0 });
    expect(await carts(c.order.id)).toEqual(before); expect(await receipts(c.order.id)).toHaveLength(1); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('refuses a genuinely current other-store Manager before disclosing or delivering an assigned root', async () => {
    const c = await prepared(), before = await facts(c.order.id), scope = await requireStoreManagerScope(f.managerRuntime.db, 105, 78);
    const r = await f.http(base + '/review/' + c.order.id + '?store_id=78', undefined, { uid: 105 });
    expect(r.body.status).not.toBe(200); expect(r.body.data ?? {}).not.toHaveProperty('source');
    expect((await f.http(base + '/commit', { ...c.body, store_id: 78, scope_key: scope.scope_key }, { uid: 105, key: randomUUID() })).body.status).not.toBe(200);
    expect(await facts(c.order.id)).toEqual(before); expect(await notices(c.order.id)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects a stale reviewed grant after the real Admin reassigns to another store', async () => {
    const c = await prepared(); await f.decide(c.order.id, 78);
    const before = await facts(c.order.id), r = await f.http(base + '/commit', c.body, { key: randomUUID() });
    expect(r.body.status).not.toBe(200); expect(await facts(c.order.id)).toEqual(before);
    expect(await receipts(c.order.id)).toHaveLength(0); expect(await notices(c.order.id)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects a reviewed grant after its real immutable Admin revocation', async () => {
    const c = await prepared(); await f.decide(c.order.id, 77, 'revoke');
    const before = await facts(c.order.id), r = await f.http(base + '/commit', c.body, { key: randomUUID() });
    expect(r.body.status).not.toBe(200); expect(await facts(c.order.id)).toEqual(before);
    expect(await receipts(c.order.id)).toHaveLength(0); expect(await notices(c.order.id)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects explicitly corrupted current cart source and leaves no delivery receipt or notice', async () => {
    const c = await prepared(), [cart] = await carts(c.order.id);
    // Explicit counterexample only; this SQL does not create an accepted source.
    await f.maintenanceDb.update(storeOrderCartInfo).set({ cartNum: cart.cartNum + 1, surplusNum: cart.surplusNum + 1, splitSurplusNum: cart.splitSurplusNum + 1 }).where(eq(storeOrderCartInfo.id, cart.id));
    try {
      const before = await facts(c.order.id), r = await f.http(base + '/commit', c.body, { key: randomUUID() });
      expect(r.body.status).not.toBe(200); expect(await facts(c.order.id)).toEqual(before);
      expect(await receipts(c.order.id)).toHaveLength(0); expect(await notices(c.order.id)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
    } finally {
      await f.maintenanceDb.update(storeOrderCartInfo).set({ cartNum: cart.cartNum, surplusNum: cart.surplusNum, splitSurplusNum: cart.splitSurplusNum }).where(eq(storeOrderCartInfo.id, cart.id));
    }
  }, 90000);

  it('rejects a real root row holder and makes no successful receipt from a lock failure', async () => {
    const c = await prepared(), before = await facts(c.order.id);
    await hold(tx => tx.execute(sql`SELECT id FROM public.store_order WHERE id=${c.order.id} FOR UPDATE NOWAIT`), async () => {
      expect((await f.http(base + '/commit', c.body, { key: randomUUID() })).body.status).not.toBe(200);
    });
    expect(await facts(c.order.id)).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('refuses App Admin Financial Cashier and maintenance real LOGINs as the Manager author', async () => {
    const c = await prepared(), before = await facts(c.order.id);
    for (const peer of [f.appRuntime, f.adminRuntime, f.financialRuntime, f.cashierRuntime, { db: f.maintenanceDb }]) {
      await expect(service(peer.db).inbox(new URLSearchParams({ store_id: '77' }), f.managerActor())).rejects.toThrow();
      await expect(service(peer.db).review(String(c.order.id), new URLSearchParams({ store_id: '77' }), f.managerActor())).rejects.toThrow();
      await expect(service(peer.db).commit(c.body, { actor: f.managerActor(), request_key: randomUUID() })).rejects.toThrow();
      expect(await facts(c.order.id)).toEqual(before);
    }
    expect(await receipts(c.order.id)).toHaveLength(0); expect(await notices(c.order.id)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('closes the production HTTP route when the explicit full declaration is missing', async () => {
    const c = await prepared(), before = await facts(c.order.id), bindings = { ...f.env, MANAGER_FULFILLMENT_ASSIGNMENT_RUNTIME: undefined };
    expect((await f.http(base + '/inbox?store_id=77', undefined, { bindings })).body.status).not.toBe(200);
    expect((await f.http(base + '/review/' + c.order.id + '?store_id=77', undefined, { bindings })).body.status).not.toBe(200);
    expect((await f.http(base + '/commit', c.body, { key: randomUUID(), bindings })).body.status).not.toBe(200);
    expect(await facts(c.order.id)).toEqual(before); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rolls a genuine delivery notice and order transition back on the actual late receipt SQL failure then retries the same key', async () => {
    const c = await prepared(), before = await facts(c.order.id), beforeMessages = f.messages.length, key = randomUUID();
    const fault = lateReceiptSqlFailure(f.managerRuntime.db, c.order.id);
    await expect(service(fault.db).commit(c.body, { actor: f.managerActor(), request_key: key })).rejects.toThrow();
    expect(fault.witness()).toMatchObject({ reached: true, status: 1, noticeCount: 1 });
    expect(await facts(c.order.id)).toEqual(before); expect(await receipts(c.order.id)).toHaveLength(0); expect(await notices(c.order.id)).toHaveLength(0);
    expect(f.messages).toHaveLength(beforeMessages); expect(network).not.toHaveBeenCalled();
    const saved = await committed(c.body, key); expect(saved.result).toMatchObject({ replayed: false, receipt: { request_key: key, order_id: c.order.id } });
    expect(await receipts(c.order.id)).toHaveLength(1); expect(await notices(c.order.id)).toHaveLength(1);
  }, 90000);

  it('paginates eleven real assigned roots by fixed ten-row pages without disclosing source or claiming admission', async () => {
    const after = await lastOrderId(), created: Array<Awaited<ReturnType<typeof prepared>>> = [];
    for (let n = 0; n < 11; n++) created.push(await prepared(n % 2 ? 0 : 1));
    const first = await inbox(after), firstIds = created.slice(0, 10).map(c => c.order.id);
    expect(first).toMatchObject({ version: 'merchant-assigned-whole-express-inbox-v1', actor_uid: 103, store_id: 77,
      admission: 'requires_review', next_after: firstIds[9] });
    expect(first.list.map(row => row.order_id)).toEqual(firstIds); expect(first.list).toHaveLength(10);
    for (const [index, row] of first.list.entries()) {
      const c = created[index];
      expect(Object.keys(row).sort()).toEqual(['admission', 'financial_store_id', 'grant', 'order_id', 'order_no', 'total_num']);
      expect(row).toEqual({ order_id: c.order.id, order_no: c.order.orderId, total_num: 1, financial_store_id: 0,
        admission: 'requires_review', grant: { operation_id: c.grant.receipt.operation_id, ordinal: 1,
          payload_hash: c.grant.receipt.payload_hash, source_hash: c.grant.receipt.source_hash, order_revision: c.grant.receipt.order_revision } });
      expect(await receipts(c.order.id)).toHaveLength(0); expect(await notices(c.order.id)).toHaveLength(0);
    }
    const second = await inbox(first.next_after!);
    expect(second.list.map(row => row.order_id)).toEqual([created[10].order.id]); expect(second.next_after).toBeNull();
    expect((await inbox(created[10].order.id)).list).toEqual([]);
    expect((await inbox(2147483647)).next_after).toBeNull();
    expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('removes revoked reassigned and genuinely delivered roots while retaining only the current target grant', async () => {
    const after = await lastOrderId(), revoked = await prepared(), reassigned = await prepared(), delivered = await prepared(), active = await prepared();
    expect((await inbox(after)).list.map(row => row.order_id)).toEqual([revoked.order.id, reassigned.order.id, delivered.order.id, active.order.id]);
    await f.decide(revoked.order.id, 77, 'revoke'); await f.decide(reassigned.order.id, 78);
    await committed(delivered.body);
    expect((await inbox(after)).list.map(row => row.order_id)).toEqual([active.order.id]);
    const moved = await inbox(after, 105, 78);
    expect(moved.list.map(row => row.order_id)).toEqual([reassigned.order.id]); expect(moved.list[0].grant.ordinal).toBe(2);
    expect(await f.actual(delivered.order.id)).toMatchObject({ status: 1, storeId: 0, supplierId: 0 });
    expect(await notices(delivered.order.id)).toHaveLength(1); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('rejects malformed inbox queries wrong-store actors and revoked staff, and requires separate source review', async () => {
    const c = await prepared(), after = c.order.id - 1, before = await facts(c.order.id);
    for (const query of ['', '?store_id=77&store_id=77', '?store_id=77&after=0&after=0', '?store_id=77&limit=100',
      '?store_id=77&after=-1', '?store_id=77&after=01', '?store_id=77&after=2147483648', '?store_id=0'])
      expect((await f.http(base + '/inbox' + query)).body.status).not.toBe(200);
    expect((await f.http(base + '/inbox?store_id=78&after=' + after)).body.status).not.toBe(200);
    expect((await f.http(base + '/inbox?store_id=77&after=' + after, undefined, { uid: 105 })).body.status).not.toBe(200);
    await f.maintenanceDb.update(systemStoreStaff).set({ isManager: 0, isAdmin: 0 }).where(eq(systemStoreStaff.id, 901));
    try { expect((await f.http(base + '/inbox?store_id=77&after=' + after)).body.status).not.toBe(200); }
    finally { await f.maintenanceDb.update(systemStoreStaff).set({ isManager: 1 }).where(eq(systemStoreStaff.id, 901)); }
    expect(await facts(c.order.id)).toEqual(before);
    const [cart] = await carts(c.order.id);
    // Negative source mutation only. Discovery must say requires_review; it
    // does not claim the current cart snapshot passes review or commit.
    await f.maintenanceDb.update(storeOrderCartInfo).set({ cartNum: cart.cartNum + 1, surplusNum: cart.surplusNum + 1, splitSurplusNum: cart.splitSurplusNum + 1 })
      .where(eq(storeOrderCartInfo.id, cart.id));
    try {
      expect((await inbox(after)).list).toMatchObject([{ order_id: c.order.id, admission: 'requires_review' }]);
      expect((await f.http(base + '/review/' + c.order.id + '?store_id=77')).body.status).not.toBe(200);
      expect(await receipts(c.order.id)).toHaveLength(0); expect(await notices(c.order.id)).toHaveLength(0);
    } finally { await f.maintenanceDb.update(storeOrderCartInfo).set({ cartNum: cart.cartNum, surplusNum: cart.surplusNum, splitSurplusNum: cart.splitSurplusNum }).where(eq(storeOrderCartInfo.id, cart.id)); }
    expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('refuses a damaged complete chain in the eleventh lookahead instead of returning a successful truncated page', async () => {
    const after = await lastOrderId(), created: Array<Awaited<ReturnType<typeof prepared>>> = [];
    for (let n = 0; n < 11; n++) created.push(await prepared());
    const c = created[10];
    // Explicit rejected ledger counterexample under the actual Admin LOGIN.
    // The real checkout, payment and first grant remain untouched. This raw
    // SQL append is not presented as an accepted business-author operation.
    await f.adminRuntime.db.execute(sql`INSERT INTO public.store_order_fulfillment_assignment(operation_id,format_version,kind,actor_id,
      root_order_id,order_id,target_store_id,customer_uid,financial_store_id,ordinal,previous_ref,order_revision,payload_hash,source_hash,source)
      SELECT ${randomUUID()}::uuid,format_version,kind,actor_id,root_order_id,order_id,target_store_id,customer_uid,financial_store_id,
        ordinal+1,operation_id,order_revision,${'a'.repeat(64)},source_hash,source
      FROM public.store_order_fulfillment_assignment WHERE operation_id=${c.grant.receipt.operation_id}::uuid`);
    const before = await facts(c.order.id), r = await f.http(base + '/inbox?store_id=77&after=' + after);
    expect(r.body.status).not.toBe(200); expect(r.body.data ?? {}).not.toHaveProperty('list');
    expect(await facts(c.order.id)).toEqual(before); expect(await receipts(c.order.id)).toHaveLength(0);
    expect(await notices(c.order.id)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);

  it('refuses an actual sixty-five-event chain instead of treating its first sixty-four events as the current grant', async () => {
    const c = await prepared(), after = c.order.id - 1;
    const [stored] = await f.maintenanceDb.execute<{ source: unknown }>(sql`SELECT source FROM public.store_order_fulfillment_assignment
      WHERE operation_id=${c.grant.receipt.operation_id}::uuid`);
    let previous = c.grant.receipt.operation_id;
    // Bounded raw SQL counterexample only: source facts and the initial grant
    // are real; 64 deliberately over-cap append specimens are not UI success.
    // Each specimen has a reproducible hash and alternating target, so the
    // capacity rejection does not depend on an invalid digest or duplicate grant.
    for (let ordinal = 2; ordinal <= 65; ordinal++) {
      const operation = randomUUID(), target = ordinal % 2 ? 77 : 78;
      const request: AssignmentRequest = { format_version: 1, operation_id: operation, kind: 'grant', order_id: c.order.id,
        target_store_id: target, expected_head: { ordinal: ordinal - 1, operation_id: previous },
        expected_order_revision: c.grant.receipt.order_revision, expected_source_hash: c.grant.receipt.source_hash };
      const hash = await assignmentRequestHash(request, 1);
      await f.adminRuntime.db.execute(sql`INSERT INTO public.store_order_fulfillment_assignment(operation_id,format_version,kind,actor_id,
        root_order_id,order_id,target_store_id,customer_uid,financial_store_id,ordinal,previous_ref,order_revision,payload_hash,source_hash,source)
        VALUES(${operation}::uuid,1,'grant',1,${c.order.id},${c.order.id},${target},${c.order.uid},0,${ordinal},${previous}::uuid,
          ${c.grant.receipt.order_revision},${hash},${c.grant.receipt.source_hash},${JSON.stringify(stored.source)}::jsonb)`);
      previous = operation;
    }
    expect(await grants(c.order.id)).toHaveLength(65);
    const before = await facts(c.order.id), r = await f.http(base + '/inbox?store_id=77&after=' + after);
    expect(r.body.status).not.toBe(200); expect(r.body.data ?? {}).not.toHaveProperty('list');
    expect(await facts(c.order.id)).toEqual(before); expect(await receipts(c.order.id)).toHaveLength(0);
    expect(await notices(c.order.id)).toHaveLength(0); expect(network).not.toHaveBeenCalled();
  }, 90000);
});

/** Labelled fault adapter only. All business SQL and real Manager identity run
 * unchanged. At the actual final receipt INSERT, witness the already-written
 * real order/notice in that same transaction and ask PostgreSQL to raise 22012.
 * This never supplies a success, substitutes rows, alters a catalog or invents
 * a negative receipt; the real caller transaction must roll everything back. */
function lateReceiptSqlFailure(db: DbClient, orderId: number) {
  let observed: { reached: boolean; status?: number; noticeCount?: number } = { reached: false };
  const dialect = new PgDialect();
  const transaction = (tx: DbClient): DbClient => new Proxy(tx, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key === 'transaction' && typeof value === 'function') return (callback: (inner: DbClient) => Promise<unknown>, ...options: unknown[]) =>
        Reflect.apply(value, target, [(inner: DbClient) => callback(transaction(inner)), ...options]);
      if (key === 'execute' && typeof value === 'function') return async (...args: unknown[]) => {
        const query = args[0], text = query instanceof SQL ? dialect.sqlToQuery(query).sql : typeof query === 'string' ? query : '';
        if (/insert\s+into\s+(?:public\.)?manager_assigned_fulfillment_request\b/iu.test(text)) {
          const [w] = await target.execute<{ status: number; noticeCount: number }>(sql`SELECT status,
            (SELECT pg_catalog.count(*)::integer FROM public.store_order_outbox WHERE aggregate_id=${orderId} AND event_type='order.delivery.notice') AS "noticeCount"
            FROM public.store_order WHERE id=${orderId}`);
          observed = { reached: true, status: w?.status, noticeCount: w?.noticeCount };
          await target.execute(sql`SELECT 1/0 AS owned_late_receipt_sql_fault`);
        }
        return Reflect.apply(value, target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: new Proxy(db, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key === 'transaction' && typeof value === 'function') return (callback: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) =>
        Reflect.apply(value, target, [(tx: DbClient) => callback(transaction(tx)), ...options]);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }), witness: () => observed };
}
