import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { storeCouponIssue, storeCouponUser, storeCouponTemplate, storeCouponTemplateIssue, storeCouponProduct,
  storeOrder, storeOrderCartInfo, storeProductCoupon } from '../src/models/schema';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { AdminCouponTemplateService } from '../src/services/admin/AdminCouponTemplateService';
import { ActivityService } from '../src/services/activity/ActivityService';
import { applyRegistrationGifts } from '../src/services/activity/StoreNewcomerService';
import { grantPaidOrderProductCoupons } from '../src/services/activity/ProductCouponService';
import { resolveOrderCoupon } from '../src/services/activity/OrderCouponService';
import { couponWalletQuery, UserCouponWalletService } from '../src/services/activity/UserCouponWalletService';
import { assertCheckoutCouponTemplate } from '../src/services/order/CheckoutCouponTemplateAuthority';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { couponTemplateSnapshot, observeCouponTemplateDb, publicationBody, seedCouponTemplates, templateBody,
  withCouponTemplatePeer, type CouponTemplateRuntimePeer } from './helpers/couponTemplateFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const actor = { id: 8 }, q = (value = '') => new URLSearchParams(value);
function diagnostics(result: { ok: boolean; error?: unknown; value?: unknown }) {
  const details = (error: unknown, depth = 0): unknown => {
    if (!error || typeof error !== 'object' || depth > 4) return String(error);
    const row = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    return { name: row.name, message: row.message, code: row.code, cause: row.cause ? details(row.cause, depth + 1) : undefined };
  };
  return JSON.stringify(result.ok ? result : { ok: false, error: details(result.error) });
}
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('coupon templates on formal 176-step/281-table schema and genuine commissioned LOGIN peers', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O'));
    f = await refundRuntimeFixture(); await seedCouponTemplates(f.db);
  }, 120000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function commissioned(run: (admin: CouponTemplateRuntimePeer, app: CouponTemplateRuntimePeer, service: AdminCouponTemplateService) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.db.execute(sql`SELECT current_database() AS database`);
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.database), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(app.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect((await admin.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: admin.role, session: admin.role });
      expect((await admin.exec('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
        .toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
      await run(admin, app, new AdminCouponTemplateService(createContainerFromDb(admin.db), 'synthetic-unused-key'));
    }));
  }
  it('runs all five reads and four writes under exact Admin grants, denies App source access and enforces immutable definition/proof columns', async () => {
    await commissioned(async (admin, app, service) => {
      expect((await service.list(q())).count).toBe(3);
      expect((await service.options()).categories).toContainEqual({ id: 4001, pid: 0, cate_name: '真实商品分类' });
      expect((await service.products(q('keyword=选择商品%25_'))).list[0].id).toBe(4100);
      expect((await service.detail('45001')).product_ids).toEqual([4100, 4101]);
      expect((await service.issues('45001', q())).count).toBe(0);
      const before = await couponTemplateSnapshot(f.db);
      await expect(new AdminCouponTemplateService(createContainerFromDb(app.db)).list(q())).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(new AdminCouponTemplateService(createContainerFromDb(app.db)).mutate('create', undefined, templateBody(), actor)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(admin.exec("UPDATE store_coupon_template SET title='forbidden definition update' WHERE id=45001")).rejects.toMatchObject({ code: '42501' });
      expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      const sourceResult = await service.mutate('create', undefined, templateBody(), actor); if (!('id' in sourceResult)) throw Error('Missing source');
      const source = await service.detail(String(sourceResult.id)), pub = publicationBody(source.id, source.revision);
      const issued = await service.mutate('publish', undefined, pub, actor); if (!('issue_id' in issued)) throw Error('Missing issue');
      const after = await couponTemplateSnapshot(f.db);
      await expect(admin.exec(`UPDATE store_coupon_template_issue SET source_revision='${'a'.repeat(64)}' WHERE issue_id=${issued.issue_id}`)).rejects.toMatchObject({ code: '42501' });
      await expect(admin.exec(`DELETE FROM store_coupon_template_issue WHERE issue_id=${issued.issue_id}`)).rejects.toMatchObject({ code: '42501' });
      expect(await couponTemplateSnapshot(f.db)).toEqual(after);
      expect(await service.mutate('invalidate', String(source.id), { request_id: crypto.randomUUID(), revision: source.revision }, actor)).toEqual({ id: source.id });
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0].status).toBe(1);
      const closed = await service.detail(String(source.id));
      expect(await service.mutate('delete', String(source.id), { request_id: crypto.randomUUID(), revision: closed.revision }, actor)).toEqual({ id: source.id });
      expect(await service.mutate('publish', undefined, pub, actor)).toEqual(issued);
    });
  }, 120000);
  it('uses repeatable-read/read-only snapshots with strict caller deadlines and rejects real writes inside the read transaction', async () => {
    await commissioned(async (admin) => {
      await admin.exec("SET statement_timeout='1s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='1500ms'");
      const settings = sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
        (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
        (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
        (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`;
      const beforeSettings = await admin.db.execute(settings), before = await couponTemplateSnapshot(f.db), states: unknown[] = []; let calls = 0;
      const observed = new AdminCouponTemplateService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (command === 'execute' && ++calls % 2 === 0) states.push((await tx.execute(settings))[0]);
      })));
      await observed.list(q()); await observed.options(); await observed.products(q()); await observed.detail('45001'); await observed.issues('45001', q());
      expect(states).toHaveLength(5);
      for (const state of states) expect(state).toEqual({ isolation: 'repeatable read', read_only: 'on', statement: 1000, lock: 500, idle: 1500 });
      expect(await admin.db.execute(settings)).toEqual(beforeSettings); expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      let attempted = false;
      const writeProbe = new AdminCouponTemplateService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (!attempted && command === 'execute') {
          attempted = true; await tx.update(storeCouponTemplate).set({ status: 0 }).where(eq(storeCouponTemplate.id, 45001));
        }
      })));
      await expect(writeProbe.detail('45001')).rejects.toMatchObject({ cause: { code: '25006' } });
      expect(attempted).toBe(true); expect(await couponTemplateSnapshot(f.db)).toEqual(before);
    });
  }, 120000);
  it('keeps real count/list in the same RR snapshot across another session insertion', async () => {
    await commissioned(async admin => {
      let inserted = false;
      const service = new AdminCouponTemplateService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (_tx, command) => {
        if (!inserted && command.includes('count(*)::integer') && command.includes('from "store_coupon_template"')) {
          inserted = true;
          await f.db.insert(storeCouponTemplate).values({ id: 49001, title: 'Concurrent template', scopeType: 0, couponPrice: '1.00', validDays: 1, addTime: 100 });
        }
      })));
      const page = await service.list(q()); expect(inserted).toBe(true); expect(page.count).toBe(3); expect(page.list).toHaveLength(3);
      expect((await new AdminCouponTemplateService(createContainerFromDb(admin.db)).list(q())).count).toBe(4);
    });
  }, 120000);
  it('serializes simultaneous genuine Admin sessions on one UUID and proves only one issue, proof, scope and audit receipt', async () => {
    await commissioned(async (admin, _app, service) => withCouponTemplatePeer(admin, async second => {
      const source = await service.detail('45001'), body = publicationBody(source.id, source.revision);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
      const firstService = new AdminCouponTemplateService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (command === 'execute') {
          const [state] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS held`);
          if (state.held === true) { entered(); await gate; }
        }
      })));
      const first = outcome(firstService.mutate('publish', undefined, body, actor)); await held;
      const concurrent = outcome(new AdminCouponTemplateService(createContainerFromDb(second.db)).mutate('publish', undefined, body, actor));
      try { await waitForFinanceBlock(f.db, second.pid, admin.pid); }
      finally { release(); }
      const a = await first, b = await concurrent; expect(a.ok, diagnostics(a)).toBe(true); expect(b, diagnostics(b)).toEqual(a);
      expect((await service.issues('45001', q())).count).toBe(1);
      expect(await f.db.select().from(storeCouponTemplateIssue).where(eq(storeCouponTemplateIssue.templateId, 45001))).toHaveLength(1);
      expect(await f.db.select().from(storeCouponProduct)).toHaveLength(2);
      await expect(new AdminCouponTemplateService(createContainerFromDb(second.db)).mutate('publish', undefined, { ...body, count: 6 }, actor)).rejects.toThrow('请求标识');
    }));
  }, 120000);
  it('makes publication/invalidation obey genuine source-row locks and either commits complete ordered state or rolls back under issue contention', async () => {
    await commissioned(async (admin, _app, service) => withCouponTemplatePeer(admin, async second => f.withPeer!(async maintenance => {
      const source = await service.detail('45001'); await maintenance.exec('BEGIN');
      await maintenance.db.execute(sql`SELECT id FROM store_coupon_template WHERE id=45001 FOR UPDATE`);
      const pub = outcome(service.mutate('publish', undefined, publicationBody(45001, source.revision), actor));
      try { await waitForFinanceBlock(f.db, admin.pid, maintenance.pid); }
      finally { await maintenance.exec('COMMIT'); }
      const publication = await pub; expect(publication.ok, diagnostics(publication)).toBe(true);
      if (!publication.ok || !('issue_id' in publication.value)) throw Error('Missing committed publication');
      // Observe and release each actual maintenance wait independently. A
      // second queued observation must not consume the first writer's 2s budget.
      await maintenance.exec('BEGIN');
      await maintenance.db.execute(sql`SELECT id FROM store_coupon_template WHERE id=45001 FOR UPDATE`);
      const stop = outcome(new AdminCouponTemplateService(createContainerFromDb(second.db)).mutate('invalidate', '45001',
        { request_id: crypto.randomUUID(), revision: source.revision }, { id: 9 }));
      try { await waitForFinanceBlock(f.db, second.pid, maintenance.pid); }
      finally { await maintenance.exec('COMMIT'); }
      const invalidation = await stop; expect(invalidation.ok, diagnostics(invalidation)).toBe(true);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, publication.value.issue_id)))[0].status).toBe(-1);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0].status).toBe(1);
      // A second active source has two proven issues; one held issue prevents
      // the complete stop operation from committing any source/issue/log row.
      const active = await service.detail('45002');
      const first = await service.mutate('publish', undefined, publicationBody(45002, active.revision), actor);
      await service.mutate('publish', undefined, publicationBody(45002, active.revision), actor);
      if (!('issue_id' in first)) throw Error('Missing issue');
      const before = await couponTemplateSnapshot(f.db); await maintenance.exec('BEGIN');
      await maintenance.db.execute(sql`SELECT id FROM store_coupon_issue WHERE id=${first.issue_id} FOR UPDATE`);
      const conflict = outcome(service.mutate('invalidate', '45002', { request_id: crypto.randomUUID(), revision: active.revision }, actor));
      try {
        await waitForFinanceBlock(f.db, admin.pid, maintenance.pid);
        const rejected = await conflict; expect(rejected.ok, diagnostics(rejected)).toBe(false);
        if (rejected.ok) throw Error('Unexpected partial invalidation');
        expect(rejected.error).toMatchObject({ code: 400 }); expect(String(rejected.error)).toContain('正在变化');
      } finally { await maintenance.exec('ROLLBACK'); }
      expect(await couponTemplateSnapshot(f.db)).toEqual(before);
    })));
  }, 120000);
  it('orders concurrent publication then invalidation behind the genuine source lock without exposing a live issue after stop', async () => {
    await commissioned(async (admin, _app, service) => withCouponTemplatePeer(admin, async second => {
      const source = await service.detail('45001');
      let entered!: () => void, release!: () => void, gated = false;
      const held = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const publisher = new AdminCouponTemplateService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (_tx, command) => {
        if (!gated && command.includes('from "store_coupon_template"') && command.endsWith('for update')) {
          gated = true; entered(); await gate;
        }
      })));
      const pub = outcome(publisher.mutate('publish', undefined, publicationBody(source.id, source.revision), actor));
      await held;
      const stop = outcome(new AdminCouponTemplateService(createContainerFromDb(second.db)).mutate('invalidate', '45001',
        { request_id: crypto.randomUUID(), revision: source.revision }, { id: 9 }));
      try { await waitForFinanceBlock(f.db, second.pid, admin.pid); }
      finally { release(); }
      const publication = await pub, invalidation = await stop;
      expect(publication.ok, diagnostics(publication)).toBe(true); expect(invalidation.ok, diagnostics(invalidation)).toBe(true);
      if (!publication.ok || !('issue_id' in publication.value)) throw Error('Missing committed publication');
      expect((await service.detail('45001')).status).toBe(0);
      expect((await service.issues('45001', q())).list).toMatchObject([{ issue_id: publication.value.issue_id, status: -1 }]);
      expect(await f.db.select().from(storeCouponTemplateIssue).where(eq(storeCouponTemplateIssue.templateId, 45001))).toHaveLength(1);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0].status).toBe(1);
    }));
  }, 120000);
  it('rolls back all publication/source changes when the final real audit INSERT fails and replays the same UUID after recovery', async () => {
    await commissioned(async (_admin, _app, service) => {
      const source = await service.detail('45001'), body = publicationBody(45001, source.revision), before = await couponTemplateSnapshot(f.db);
      await f.exec("ALTER TABLE system_log ADD CONSTRAINT coupon_template_failure_probe CHECK(type <> 'coupon_template') NOT VALID");
      await expect(service.mutate('publish', undefined, body, actor)).rejects.toMatchObject({ cause: { code: '23514' } });
      expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      await f.exec('ALTER TABLE system_log DROP CONSTRAINT coupon_template_failure_probe');
      const result = await service.mutate('publish', undefined, body, actor); expect(await service.mutate('publish', undefined, body, actor)).toEqual(result);
      expect((await service.issues('45001', q())).count).toBe(1);
    });
  }, 120000);
  it('denies hidden/member direct claim under real App LOGIN without changes and preserves trusted gift/newcomer grants and owned history after source invalidation', async () => {
    await commissioned(async (_admin, app, service) => {
      const source = await service.detail('45001'), activity = new ActivityService(createContainerFromDb(app.db));
      const normal = await service.mutate('publish', undefined, publicationBody(45001, source.revision), actor);
      if (!('issue_id' in normal)) throw Error('Missing manual issue');
      const claimed = await activity.receiveCoupon(4110, normal.issue_id);
      for (const fields of [{ receiveType: 0 }, { receiveType: 2 }, { receiveType: 3 }, { receiveType: 4 }, { category: 2 }, { appType: 1 }]) {
        await f.db.update(storeCouponIssue).set({ receiveType: 1, category: 0, appType: 0, ...fields }).where(eq(storeCouponIssue.id, 46001));
        const before = await couponTemplateSnapshot(f.db);
        await expect(activity.receiveCoupon(4110, 46001)).rejects.toThrow('不允许手动领取');
        expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      }
      const gift = await service.mutate('publish', undefined, publicationBody(45001, source.revision, { receive_type: 3 }), actor);
      const newcomer = await service.mutate('publish', undefined, publicationBody(45001, source.revision, { receive_type: 2 }), actor);
      if (!('issue_id' in gift) || !('issue_id' in newcomer)) throw Error('Missing trusted issues');
      await f.db.insert(storeOrder).values({ id: 61001, uid: 4110, orderId: 'coupon-template-trusted-gift', unique: 'coupon-template-trusted-gift', paid: 1 });
      await f.db.insert(storeOrderCartInfo).values({ id: 61001, oid: 61001, uid: 4110, productId: 4100, unique: 'coupon-template-gift-cart' });
      await f.db.insert(storeProductCoupon).values({ productId: 4100, issueCouponId: gift.issue_id });
      const now = Math.floor(Date.now() / 1000);
      const appContainer = createContainerFromDb(app.db);
      expect(await withTx(appContainer, tx => grantPaidOrderProductCoupons(tx, 61001, 4110, now))).toBe(1);
      expect(await withTx(appContainer, tx => grantPaidOrderProductCoupons(tx, 61001, 4110, now))).toBe(0);
      expect(await withTx(appContainer, tx => applyRegistrationGifts(tx, 4110, { enabled: true, integral: 0, moneyUnits: 0, couponIds: [newcomer.issue_id] }, now)))
        .toEqual({ integral: 0, money: '0.00', coupons: 1 });
      const users = await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.uid, 4110)), scopes = await f.db.select().from(storeCouponProduct);
      expect(users.map(row => row.receiveSource)).toEqual(['get', 'order', 'newcomer']);
      expect(users.find(row => row.id === claimed.couponUserId)).toMatchObject({ couponPrice: '5.00', useMinPrice: '10.00', status: 0 });
      const items = [{ cart: { cartNum: 1 }, product: { id: 4100, pid: 0, cateId: '4001', brandId: 0 }, unitPriceCents: 2000 }];
      const evaluated = await resolveOrderCoupon(appContainer, 4110, claimed.couponUserId, items);
      expect(evaluated.priceCents).toBe(500); expect(evaluated.quoteFacts).toMatchObject({ productIds: [4100, 4101], eligibleSubtotalCents: 2000 });
      if (!evaluated.template) throw Error('Missing owned coupon authority');
      await withTx(appContainer, tx => assertCheckoutCouponTemplate(tx, evaluated.template!));
      const wallet = new UserCouponWalletService(appContainer), counts = await wallet.counts(4110);
      await service.mutate('invalidate', '45001', { request_id: crypto.randomUUID(), revision: source.revision }, actor);
      expect(await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.uid, 4110))).toEqual(users);
      expect(await f.db.select().from(storeCouponProduct)).toEqual(scopes);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, normal.issue_id)))[0].status).toBe(-1);
      expect(await resolveOrderCoupon(appContainer, 4110, claimed.couponUserId, items)).toEqual(evaluated);
      await withTx(appContainer, tx => assertCheckoutCouponTemplate(tx, evaluated.template!));
      expect(await wallet.counts(4110)).toEqual(counts);
      expect((await wallet.list(4110, couponWalletQuery('0', {}))).list.find(row => row.id === claimed.couponUserId))
        .toMatchObject({ availability: 'available', coupon_price: '5.00', use_min_price: '10.00', applicable_type: 2 });
      await expect(activity.receiveCoupon(4110, normal.issue_id)).rejects.toThrow('停发');
    });
  }, 120000);
  it('preserves a real unpaid order reservation and identical creation retry after its source invalidates the issue', async () => {
    await commissioned(async (_admin, app, service) => {
      const createdSource = await service.mutate('create', undefined, templateBody({ product_ids: [70, 71] }), actor);
      if (!('id' in createdSource)) throw Error('Missing source');
      const source = await service.detail(String(createdSource.id));
      const issued = await service.mutate('publish', undefined, publicationBody(source.id, source.revision), actor);
      if (!('issue_id' in issued)) throw Error('Missing issue');
      const appContainer = createContainerFromDb(app.db);
      const claimed = await new ActivityService(appContainer).receiveCoupon(11, issued.issue_id);
      const runtime = { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'coupon_template_reserved_order' };
      const params = { uid: 11, key: 'coupon-template-reservation', cartIds: [1, 2], addressId: 11,
        couponId: claimed.couponUserId, useIntegral: false, userIp: '127.0.0.1' };
      const order = await StoreOrderCreateService.createWithRuntime(appContainer, runtime, params);
      const [reserved] = await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, claimed.couponUserId));
      const [orderBefore] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, order.orderId));
      expect(reserved).toMatchObject({ status: 3, isFail: 0, couponPrice: '5.10', useMinPrice: '10.00' });
      expect(orderBefore).toMatchObject({ couponId: claimed.couponUserId, couponPrice: '5.10', paid: 0 });
      const wallet = new UserCouponWalletService(appContainer), counts = await wallet.counts(11);
      expect(counts.reserved).toBe(1);
      await service.mutate('invalidate', String(source.id), { request_id: crypto.randomUUID(), revision: source.revision }, actor);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, issued.issue_id)))[0].status).toBe(-1);
      expect((await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, claimed.couponUserId)))[0]).toEqual(reserved);
      expect((await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, order.orderId)))[0]).toEqual(orderBefore);
      expect(await wallet.counts(11)).toEqual(counts);
      expect((await wallet.list(11, couponWalletQuery('3', {}))).list).toMatchObject([{ id: claimed.couponUserId, availability: 'reserved' }]);
      await expect(resolveOrderCoupon(appContainer, 11, claimed.couponUserId,
        [{ cart: { cartNum: 1 }, product: { id: 70, pid: 0, cateId: '', brandId: 0 }, unitPriceCents: 2000 }])).rejects.toThrow('已使用或已失效');
      expect(await StoreOrderCreateService.createWithRuntime(appContainer, runtime, params)).toEqual(order);
      expect(await f.db.select().from(storeOrder).where(eq(storeOrder.couponId, claimed.couponUserId))).toHaveLength(1);
      expect((await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, claimed.couponUserId)))[0]).toEqual(reserved);
    });
  }, 120000);
});
