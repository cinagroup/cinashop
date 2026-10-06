import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env, OrderPaidOutboxMessage } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { storeCart, storeCouponIssue, storeCouponIssueUser, storeCouponUser, storeOrder, storeOrderStatus,
  storeOrderOutbox, storeOrderProductCouponReward, storeProduct, storeProductCoupon,
  systemConfig, user, userBill, userMoney } from '../src/models/schema';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { LoginService } from '../src/services/user/LoginService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { OrderOutboxService } from '../src/services/order/OrderOutboxService';
import { setTokenBucket } from '../src/utils/cache';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { withCouponTemplatePeer, type CouponTemplateRuntimePeer } from './helpers/couponTemplateFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

// Only the external token store is replaced. Real independently authenticated
// App/Admin LOGINs execute production registration, checkout, wallet payment and
// paid-outbox SQL. This does not certify HTTP auth, SMS/provider payment or KV.
vi.mock('../src/utils/cache', async original => ({
  ...await original<typeof import('../src/utils/cache')>(),
  setTokenBucket: vi.fn(async () => true),
}));

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Pick<CouponTemplateRuntimePeer, 'db' | 'pid' | 'exec' | 'role'>;
type Flow = 'registration' | 'paid-outbox';
type Witness = { ok: true; value: unknown } | { ok: false; error: unknown };
const flows: Flow[] = ['registration', 'paid-outbox'];
const firstIssue = 51001;
const phone = (n: number) => `1391001${String(n).padStart(4, '0')}`;
const issueLock = (command: string) => command.includes('from "store_coupon_issue"') && command.endsWith('for update');
const accountLock = (command: string) => command.includes('from "user"') && command.endsWith('for update');

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const row = error as { code?: string; cause?: unknown };
  return row.code ?? errorCode(row.cause);
}
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item instanceof Error
  ? { name: item.name, message: item.message, cause: item.cause, code: errorCode(item) } : item);

/** Observe only actual SELECT SQL/results. Link observer failures into the
 * caller's rejection callback as well as the returned Promise, so an await of
 * this thenable rolls back instead of leaving an unhandled rejected child. */
function observeGiftDb(db: DbClient, observe: (tx: DbClient, command: string) => Promise<void>): DbClient {
  const builder = (target: object, tx: DbClient): object => new Proxy(target, { get(object, key, receiver) {
    const method: unknown = Reflect.get(object, key, receiver);
    if (typeof method !== 'function') return method;
    if (key === 'then') return (fulfilled?: (rows: unknown) => unknown, rejected?: (error: unknown) => unknown) => {
      const queried: unknown = Reflect.apply(method, object, [(rows: unknown) => rows]);
      return Promise.resolve(queried).then(async rows => {
        const statement = Reflect.get(object, 'toSQL') as () => { sql: string };
        await observe(tx, Reflect.apply(statement, object, []).sql);
        return rows;
      }).then(fulfilled, rejected);
    };
    return (...args: unknown[]) => {
      const result: unknown = Reflect.apply(method, object, args);
      return result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function' ? builder(result, tx) : result;
    };
  } });
  return new Proxy(db, { get(target, key, receiver) {
    const method: unknown = Reflect.get(target, key, receiver);
    if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: DbClient) => unknown, ...options: unknown[]) => Reflect.apply(method, target, [(tx: DbClient) =>
      callback(new Proxy(tx, { get(transaction, property, transactionReceiver) {
        const operation: unknown = Reflect.get(transaction, property, transactionReceiver);
        if (typeof operation !== 'function') return operation;
        if (property === 'select') return (...args: unknown[]) => builder(Reflect.apply(operation, transaction, args), transaction);
        return operation.bind(transaction);
      } })), ...options]);
  } });
}

/** Pause only AFTER a genuine SQL statement has executed. No SQL, result,
 * identity, grant or production clock is fabricated by this observation. */
function pauseAfter(db: DbClient, matches: (command: string) => boolean) {
  let entered!: () => void, release!: () => void, paused = false;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return {
    db: observeGiftDb(db, async (_tx, command) => {
      if (!paused && matches(command)) { paused = true; entered(); await gate; }
    }),
    release,
    entered: (work: Promise<unknown>) => Promise.race([held, work.then(result => {
      throw Error(`Production operation ended before the expected SQL barrier: ${diagnostic(result)}`);
    })]),
  };
}

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('gift use windows through real registration and paid outbox (native PG16)', () => {
  let f: Fixture | undefined;
  let env: Env;
  let cartNumber: number;
  const config = new Map<string, string>();
  const queue = { send: vi.fn(async () => { throw Error('No external queue delivery'); }),
    sendBatch: vi.fn(async () => { throw Error('No external queue delivery'); }) } as unknown as Queue<OrderPaidOutboxMessage>;
  const fixture = () => { if (!f) throw Error('Fixture not initialized'); return f; };

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O'));
    vi.clearAllMocks(); config.clear(); cartNumber = 100;
    f = await refundRuntimeFixture();
    try {
      // Separate platform orders allow two outbox workers to reach the SAME
      // issuer row without first serializing on a common supplier row.
      await f.db.update(storeProduct).set({ type: 0, relationId: 0 }).where(inArray(storeProduct.id, [70, 71]));
      await f.db.update(user).set({ nowMoney: '1000.00' }).where(eq(user.uid, 11));
      env = { ...f.env, APP_KEY: 'isolated-gift-window-only',
        UPSTASH_REDIS_URL: 'https://unused.invalid', UPSTASH_REDIS_TOKEN: 'unused',
        CONFIG_KV: { get: async (key: string) => config.has(key) ? config.get(key)! : f!.env.CONFIG_KV.get(key),
          put: async (key: string, value: string) => { config.set(key, value); },
          delete: async (key: string) => { config.delete(key); } },
      } as Env;
    } catch (error) { await f.close(); f = undefined; throw error; }
  }, 120000);
  afterEach(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled(); expect(queue.sendBatch).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await f?.close(); f = undefined; }
  }, 30000);

  async function bounded(peer: Peer) {
    await peer.exec("SET statement_timeout='5s'; SET lock_timeout='2s'; SET idle_in_transaction_session_timeout='5s'");
  }
  async function commissioned(run: (app: CouponTemplateRuntimePeer, admin: CouponTemplateRuntimePeer) => Promise<void>) {
    const f = fixture();
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.db.execute(sql`SELECT current_database() AS database`);
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test',
        database: String(identity.database), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      for (const [peer, profile] of [[app, 'app'], [admin, 'admin']] as const) {
        expect(await auditRuntimeBusinessPrivileges(peer.db, profile, names)).toMatchObject({ ready: true, failures: [] });
        const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,current_setting('server_version_num') AS version");
        expect(identity).toMatchObject({ role: peer.role, session: peer.role });
        expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
        expect((await peer.exec('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
          .toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
        await bounded(peer);
      }
      await run(app, admin);
    }));
  }
  async function seedIssue(id = firstIssue, overrides: Partial<typeof storeCouponIssue.$inferInsert> = {}) {
    const now = Math.floor(Date.now() / 1000);
    await fixture().db.insert(storeCouponIssue).values({ id, title: `Gift ${id}`, couponTitle: `Gift ${id}`,
      couponType: 0, couponPrice: '3.00', useMinPrice: '0.00', receiveType: 3, category: 0, appType: 0,
      day: 0, totalCount: 5, remainCount: 5, status: 1, isDel: 0,
      useStartTime: new Date((now - 86400) * 1000), useEndTime: new Date((now + 86400) * 1000), ...overrides });
  }
  async function sources(flow: Flow, ids: number[]) {
    const f = fixture();
    if (flow === 'registration') {
      const values: Record<string, string> = { newcomer_status: '1', register_integral_status: '1', register_give_integral: '7',
        register_money_status: '1', register_give_money: '3', register_coupon_status: '1', register_give_coupon: JSON.stringify(ids) };
      for (const [menuName, value] of Object.entries(values)) {
        const changed = await f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0))).returning();
        if (!changed.length) await f.db.insert(systemConfig).values({ menuName, value });
        config.set(`cfg_${menuName}`, value);
      }
    } else {
      // Both products reference each issuer; the real per-order reward guard
      // must deduplicate this rather than granting twice for two purchased items.
      await f.db.insert(storeProductCoupon).values(ids.flatMap(issueCouponId => [70, 71].map(productId => ({ productId, issueCouponId }))));
    }
  }
  async function registration(peer: Peer, n: number, db = peer.db) {
    const result = await new LoginService(createContainerFromDb(db), env).register(phone(n), 'Gift-fixture-password', 0);
    expect(result.token).toEqual(expect.any(String));
    const [created] = await fixture().db.select().from(user).where(eq(user.phone, phone(n)));
    expect(created).toMatchObject({ account: phone(n), integral: 7, nowMoney: '3.00' });
    return created.uid;
  }
  async function checkout(peer: Peer, n: number) {
    const f = fixture(), cartIds = [cartNumber++, cartNumber++];
    await f.db.insert(storeCart).values([{ id: cartIds[0], uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 1, isNew: 1, status: 1 },
      { id: cartIds[1], uid: 11, productId: 71, productAttrUnique: 'runtim71', cartNum: 1, isNew: 1, status: 1 }]);
    const container = createContainerFromDb(peer.db), identity = `gift_window_${n}`;
    return StoreOrderCreateService.createWithRuntime(container,
      { CONFIG_KV: env.CONFIG_KV, nextOrderId: async () => identity },
      { uid: 11, key: identity, cartIds, addressId: 11, userIp: '127.0.0.1', useIntegral: false });
  }
  async function payment(peer: Peer, n: number) {
    const f = fixture(), container = createContainerFromDb(peer.db), created = await checkout(peer, n);
    const before = (await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney;
    const paid = await applyStoreOrderBalancePayment(container, { uid: 11, orderId: created.orderId });
    expect(paid.outcome).toBe('paid'); expect(paid.outbox).not.toBeNull();
    const after = (await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney;
    expect(Number(after)).toBeLessThan(Number(before));
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)))[0].paid).toBe(1);
    return { action: 'processOrderPaidOutbox', outboxId: paid.outbox!.id, eventKey: paid.outbox!.eventKey } satisfies OrderPaidOutboxMessage;
  }
  function consumer(peer: Peer, db = peer.db) {
    return new OrderOutboxService(createContainerFromDb(db), { ORDER_QUEUE: queue as unknown as Queue<import('../src/env').OrderMessage> });
  }
  async function prepare(flow: Flow, peer: Peer, n: number) {
    const message = flow === 'paid-outbox' ? await payment(peer, n) : undefined;
    return { message, run: async (db = peer.db): Promise<number | string> => flow === 'registration'
      ? await registration(peer, n, db) : await consumer(peer, db).processMessage(message!) };
  }
  async function giftRows(ids: number[]) {
    const db = fixture().db;
    return { issues: await db.select().from(storeCouponIssue).where(inArray(storeCouponIssue.id, ids)).orderBy(storeCouponIssue.id),
      owned: await db.select().from(storeCouponUser).where(inArray(storeCouponUser.issueCouponId, ids)).orderBy(storeCouponUser.id),
      raw: await db.select().from(storeCouponIssueUser).where(inArray(storeCouponIssueUser.issueCouponId, ids))
        .orderBy(storeCouponIssueUser.issueCouponId, storeCouponIssueUser.uid, storeCouponIssueUser.addTime),
      rewards: await db.select().from(storeOrderProductCouponReward).where(inArray(storeOrderProductCouponReward.issueCouponId, ids))
        .orderBy(storeOrderProductCouponReward.id) };
  }
  async function granted(flow: Flow, ids: number[], count = 1) {
    const rows = await giftRows(ids);
    expect(rows.owned).toHaveLength(ids.length * count); expect(rows.raw).toHaveLength(ids.length * count);
    expect(rows.rewards).toHaveLength(flow === 'paid-outbox' ? ids.length * count : 0);
    expect(rows.owned.map(row => row.receiveSource)).toEqual(Array(ids.length * count).fill(flow === 'registration' ? 'newcomer' : 'order'));
    return rows;
  }

  // Four independent red witnesses: all use production entries, never call an
  // eligibility function. Missing day0 end and negative day with a future end
  // share one real operation but must BOTH leave their separate inventories.
  it.each(flows.flatMap(flow => (['expired', 'malformed'] as const).map(kind => ({ flow, kind }))))
   ('$flow does not grant $kind fixed-use configuration or consume its inventory/evidence', async ({ flow, kind }) => {
      await commissioned(async app => {
        const now = Math.floor(Date.now() / 1000);
        await seedIssue(firstIssue, { useEndTime: kind === 'expired' ? new Date((now - 86400) * 1000) : null });
        const ids = kind === 'expired' ? [firstIssue] : [firstIssue, firstIssue + 1];
        if (kind === 'malformed') await seedIssue(firstIssue + 1, { day: -1, useEndTime: new Date((now + 86400) * 1000) });
        await sources(flow, ids); const before = await giftRows(ids);
        const task = await prepare(flow, app, 1); await task.run();
        expect(await giftRows(ids)).toEqual(before);
        if (task.message) expect((await fixture().db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, task.message.outboxId)))[0].status).toBe('COMPLETED');
      });
    }, 120000);

  it('uses paid-processing time across a fixed-use cutoff, retains the real payment, and starts rolling validity at processing', async () => {
    await commissioned(async app => {
      const now = Math.floor(Date.now() / 1000), cutoff = now + 60, processing = cutoff + 86400;
      await seedIssue(firstIssue, { useEndTime: new Date(cutoff * 1000) });
      await seedIssue(firstIssue + 1, { day: 7, useEndTime: new Date((now - 86400) * 1000) });
      await sources('paid-outbox', [firstIssue, firstIssue + 1]);
      const task = await prepare('paid-outbox', app, 9), db = fixture().db;
      const [paidOrder] = await db.select().from(storeOrder).where(eq(storeOrder.orderId, 'gift_window_9'));
      expect(paidOrder.paid).toBe(1); expect(paidOrder.payTime).toBeLessThan(cutoff);
      const wallet = (await db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney;
      const bills = await db.select().from(userBill).where(and(eq(userBill.uid, 11), eq(userBill.type, 'pay_product'))).orderBy(userBill.id);
      expect(bills).toHaveLength(1); const before = await giftRows([firstIssue]);
      // Move only Date.now; native timers, SQL/row locks and the event loop keep
      // running. Processing uses its real production clock API, not payTime.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(processing * 1000);
      try {
        expect(await task.run()).toBe('completed');
        expect(await giftRows([firstIssue])).toEqual(before);
        const rolling = await granted('paid-outbox', [firstIssue + 1]);
        expect(rolling.owned[0]).toMatchObject({ receiveTime: processing,
          startTime: new Date(processing * 1000), endTime: new Date((processing + 7 * 86400) * 1000) });
        expect(rolling.issues[0].remainCount).toBe(4);
        expect((await db.select().from(storeOrder).where(eq(storeOrder.id, paidOrder.id)))[0])
          .toMatchObject({ paid: 1, payTime: paidOrder.payTime, payType: 'yue' });
        expect((await db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe(wallet);
        expect(await db.select().from(userBill).where(and(eq(userBill.uid, 11), eq(userBill.type, 'pay_product'))).orderBy(userBill.id)).toEqual(bills);
        expect((await db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, task.message!.outboxId)))[0].status).toBe('COMPLETED');
        const saved = await fixture().state(), gifts = await giftRows([firstIssue, firstIssue + 1]);
        expect(await consumer(app).processMessage(task.message!)).toBe('already-completed');
        expect(await fixture().state()).toEqual(saved); expect(await giftRows([firstIssue, firstIssue + 1])).toEqual(gifts);
      } finally { clock.mockRestore(); }
    });
  }, 120000);

  it.each(flows)('%s preserves valid fixed/future-start, rolling, finite and unlimited gift semantics', async flow => {
    await commissioned(async app => {
      const now = Math.floor(Date.now() / 1000), ids = Array.from({ length: 5 }, (_, i) => firstIssue + i);
      await seedIssue(ids[0]);
      await seedIssue(ids[1], { useStartTime: new Date((now + 86400) * 1000), useEndTime: new Date((now + 172800) * 1000) });
      await seedIssue(ids[2], { day: 7, useStartTime: null, useEndTime: new Date((now - 86400) * 1000) });
      await seedIssue(ids[3], { isPermanent: 1, totalCount: 0, remainCount: 0 });
      await seedIssue(ids[4], { totalCount: 0, remainCount: 1 });
      await sources(flow, [...ids, ids[0]]);
      const task = await prepare(flow, app, 2);
      let inclusiveClock: number | undefined;
      if (flow === 'registration') {
        // Obtain this REAL operation's captured second from its newly inserted
        // account, then set the issuer end to exactly that second BEFORE its
        // lock/read. This verifies >= without mocking time or returned rows.
        const observed = observeGiftDb(app.db, async (tx, command) => {
          if (inclusiveClock === undefined && accountLock(command)) {
            const [created] = await tx.select({ now: user.addTime }).from(user).where(eq(user.phone, phone(2)));
            if (!created) throw Error('The real registration operation clock is required');
            inclusiveClock = created.now;
            await fixture().db.update(storeCouponIssue).set({ useEndTime: new Date(created.now * 1000) }).where(eq(storeCouponIssue.id, ids[0]));
          }
        });
        await task.run(observed);
      } else {
        inclusiveClock = Math.floor(Date.now() / 1000) + 60;
        await fixture().db.update(storeCouponIssue).set({ useEndTime: new Date(inclusiveClock * 1000) }).where(eq(storeCouponIssue.id, ids[0]));
        // Fix only the processing clock API. Payment has already committed at
        // its actual earlier second; native timers/locks remain unmodified.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(inclusiveClock * 1000);
        try { expect(await task.run()).toBe('completed'); }
        finally { clock.mockRestore(); }
      }
      const rows = await granted(flow, ids), byId = new Map(rows.owned.map(row => [row.issueCouponId, row]));
      for (const id of [ids[0], ids[1], ids[3], ids[4]]) {
        const source = rows.issues.find(row => row.id === id)!;
        expect(byId.get(id)).toMatchObject({ startTime: source.useStartTime, endTime: source.useEndTime, couponPrice: '3.00', status: 0 });
      }
      const rolling = byId.get(ids[2])!;
      expect(inclusiveClock).toEqual(expect.any(Number));
      expect(byId.get(ids[0])!.endTime?.getTime()).toBe(inclusiveClock! * 1000);
      expect(byId.get(ids[0])!.receiveTime).toBe(inclusiveClock);
      expect(rolling.startTime?.getTime()).toBe(rolling.receiveTime * 1000);
      expect(rolling.endTime?.getTime()).toBe((rolling.receiveTime + 7 * 86400) * 1000);
      expect(rows.issues.map(row => row.remainCount)).toEqual([4, 4, 4, 0, flow === 'registration' ? 0 : 1]);
      if (task.message) {
        const before = await giftRows(ids);
        expect(await consumer(app).processMessage(task.message)).toBe('already-completed');
        expect(await giftRows(ids)).toEqual(before);
      }
    });
  }, 120000);

  it('serializes concurrent same-phone registration and grants the newcomer set only once', async () => {
    await commissioned(async app => withCouponTemplatePeer(app, async peer => {
      await bounded(peer); await seedIssue(); await sources('registration', [firstIssue]);
      const pause = pauseAfter(app.db, issueLock), first = outcome(registration(app, 3, pause.db));
      let second: Promise<Witness> | undefined;
      try {
        await pause.entered(first); second = outcome(registration(peer, 3));
        await waitForFinanceBlock(fixture().db, peer.pid, app.pid);
      } finally { pause.release(); await first; if (second) await second; }
      const one = await first, two = await second;
      if (!one.ok) throw one.error;
      expect(two?.ok).toBe(false);
      if (two && !two.ok) expect(String(two.error)).toContain('该手机号已注册');
      expect(await fixture().db.select().from(user).where(eq(user.phone, phone(3)))).toHaveLength(1);
      await granted('registration', [firstIssue]);
      expect((await giftRows([firstIssue])).issues[0].remainCount).toBe(4);
      expect(vi.mocked(setTokenBucket)).toHaveBeenCalledTimes(1);
    }));
  }, 120000);

  it.each(flows)('%s concurrent independent operations consume the last finite coupon only once', async flow => {
    await commissioned(async app => withCouponTemplatePeer(app, async peer => {
      await bounded(peer); await seedIssue(firstIssue, { totalCount: 1, remainCount: 1 }); await sources(flow, [firstIssue]);
      const a = await prepare(flow, app, 4), b = await prepare(flow, peer, 5);
      const pause = pauseAfter(app.db, issueLock), first = outcome(a.run(pause.db));
      let second: Promise<Witness> | undefined;
      try {
        await pause.entered(first); second = outcome(b.run());
        await waitForFinanceBlock(fixture().db, peer.pid, app.pid);
      } finally { pause.release(); await first; if (second) await second; }
      if (!second) throw Error('Second production operation was not started');
      const results = [await first, await second];
      for (const result of results) if (!result.ok) throw result.error;
      const rows = await granted(flow, [firstIssue]); expect(rows.issues[0].remainCount).toBe(0);
    }));
  }, 120000);

  it('serializes duplicate real paid messages and replay without a second stock/owned/reward/raw effect', async () => {
    await commissioned(async app => withCouponTemplatePeer(app, async peer => {
      await bounded(peer); await seedIssue(); await sources('paid-outbox', [firstIssue]);
      const task = await prepare('paid-outbox', app, 6), pause = pauseAfter(app.db, issueLock);
      const first = outcome(task.run(pause.db)); let second: Promise<Witness> | undefined;
      try {
        await pause.entered(first); second = outcome(consumer(peer).processMessage(task.message!));
        await waitForFinanceBlock(fixture().db, peer.pid, app.pid);
      } finally { pause.release(); await first; if (second) await second; }
      if (!second) throw Error('Second production operation was not started');
      const one = await first, two = await second;
      if (!one.ok) throw one.error; if (!two.ok) throw two.error;
      expect(one.value).toBe('completed'); expect(two.value).toBe('already-completed');
      await granted('paid-outbox', [firstIssue]); const before = await fixture().state(), gifts = await giftRows([firstIssue]);
      expect(await consumer(app).processMessage(task.message!)).toBe('already-completed');
      expect(await fixture().state()).toEqual(before); expect(await giftRows([firstIssue])).toEqual(gifts);
    }));
  }, 120000);

  it.each(flows.flatMap(flow => (['stop', 'delete', 'expire'] as const).map(change => ({ flow, change }))))
   ('$flow rechecks a committed $change after waiting for the issuer UPDATE lock', async ({ flow, change }) => {
      await commissioned(async (app, admin) => withCouponTemplatePeer(admin, async writer => {
        await bounded(writer); await seedIssue(); await sources(flow, [firstIssue]);
        const task = await prepare(flow, app, 7);
        let entered!: () => void, release!: () => void;
        const held = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
        const writing = outcome(writer.db.transaction(async tx => {
          await tx.update(storeCouponIssue).set(change === 'stop' ? { status: 0 } : change === 'delete' ? { isDel: 1 }
            : { useEndTime: new Date((Math.floor(Date.now() / 1000) - 86400) * 1000) }).where(eq(storeCouponIssue.id, firstIssue));
          entered(); await gate;
        }));
        let reading: Promise<Witness> | undefined;
        try {
          await Promise.race([held, writing.then(result => { throw Error(`Writer ended before row-lock barrier: ${diagnostic(result)}`); })]);
          reading = outcome(task.run()); await waitForFinanceBlock(fixture().db, app.pid, writer.pid);
        } finally { release(); await writing; if (reading) await reading; }
        const written = await writing; if (!written.ok) throw written.error;
        if (!reading) throw Error('Production reader was not started');
        const read = await reading; if (!read.ok) throw read.error;
        const rows = await giftRows([firstIssue]); expect(rows.issues[0].remainCount).toBe(5);
        expect(rows.owned).toEqual([]); expect(rows.raw).toEqual([]); expect(rows.rewards).toEqual([]);
        // This witnesses latest locked ROW state. The production operation's
        // captured second is retained; no claim of re-sampling time after wait.
      }));
    }, 120000);

  it.each(flows)('%s rolls back its gift transaction on a real late SQL failure and safely retries', async flow => {
    await commissioned(async app => {
      await seedIssue(firstIssue, flow === 'registration' ? { title: '', couponTitle: 'X'.repeat(65) } : {});
      await sources(flow, [firstIssue]);
      let committedAuditId: number | undefined;
      if (flow === 'paid-outbox') {
        // Ordinary checkout and balance payment do not create a committed
        // status audit. Manufacture NO audit rows: a separate genuine unpaid
        // checkout/cancel commits its own production cancellation evidence.
        const extra = await checkout(app, 80);
        await new StoreOrderCreateService(createContainerFromDb(app.db), env).cancel(11, extra.orderId);
        const [cancelled] = await fixture().db.select({ id: storeOrder.id, paid: storeOrder.paid })
          .from(storeOrder).where(eq(storeOrder.orderId, extra.orderId));
        expect(cancelled?.paid).toBe(0);
        const [audit] = await fixture().db.select({ id: storeOrderStatus.id }).from(storeOrderStatus)
          .where(and(eq(storeOrderStatus.oid, cancelled.id), eq(storeOrderStatus.changeType, 'cancel'))).limit(1);
        committedAuditId = Number(audit?.id);
        expect(Number.isSafeInteger(committedAuditId), diagnostic({ cancelled, audit })).toBe(true);
        expect(committedAuditId, diagnostic({ cancelled, audit })).toBeGreaterThan(0);
      }
      const task = await prepare(flow, app, 8);
      const before = await fixture().state(), gifts = await giftRows([firstIssue]);
      const extra = { money: await fixture().db.select().from(userMoney).orderBy(userMoney.id),
        bills: await fixture().db.select().from(userBill).orderBy(userBill.id) };
      let armed = false;
      const observed = flow === 'registration' ? app.db : observeGiftDb(app.db, async (_tx, command) => {
        if (!armed && issueLock(command)) {
          armed = true;
          // Allocation already executed; the real committed cancellation audit
          // PK collides only with the later pay_success insert AFTER gifts.
          if (!Number.isSafeInteger(committedAuditId) || committedAuditId! <= 0) throw Error('Committed cancellation audit is required');
          await fixture().db.execute(sql`SELECT setval('public.store_order_status_id_seq'::regclass, ${committedAuditId!}, false)`);
        }
      });
      const failed = await outcome(task.run(observed)); expect(failed.ok, diagnostic(failed)).toBe(false);
      if (failed.ok) throw Error('Expected real SQL constraint failure');
      expect(errorCode(failed.error), diagnostic(failed)).toBe(flow === 'registration' ? '22001' : '23505');
      const after = await fixture().state();
      // Wallet debit/paid/outbox creation committed BEFORE paid processing.
      // Only runClaimedEvent effects roll back; compare to the already-paid
      // snapshot and permit the separately persisted FAILED lease metadata.
      for (const [table, rows] of Object.entries(before)) if (table !== 'store_order_outbox') expect(after[table], table).toEqual(rows);
      expect(await giftRows([firstIssue])).toEqual(gifts);
      expect(await fixture().db.select().from(userMoney).orderBy(userMoney.id)).toEqual(extra.money);
      expect(await fixture().db.select().from(userBill).orderBy(userBill.id)).toEqual(extra.bills);
      if (flow === 'registration') {
        expect(vi.mocked(setTokenBucket)).not.toHaveBeenCalled();
        await fixture().db.update(storeCouponIssue).set({ title: 'Repaired fixture', couponTitle: 'Repaired fixture' }).where(eq(storeCouponIssue.id, firstIssue));
      } else {
        expect(armed).toBe(true);
        expect((await fixture().db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, task.message!.outboxId)))[0].status).toBe('FAILED');
        await fixture().db.execute(sql`SELECT setval('public.store_order_status_id_seq'::regclass,
          (SELECT greatest(coalesce(max(id), 0), 1) FROM store_order_status), true)`);
      }
      await task.run(); const committed = await granted(flow, [firstIssue]); expect(committed.issues[0].remainCount).toBe(4);
      if (task.message) {
        const saved = await giftRows([firstIssue]);
        expect(await consumer(app).processMessage(task.message)).toBe('already-completed');
        expect(await giftRows([firstIssue])).toEqual(saved);
      }
    });
  }, 120000);
});
