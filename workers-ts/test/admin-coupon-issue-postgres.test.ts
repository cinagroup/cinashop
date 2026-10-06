import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { storeBrand, storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponTemplate,
  storeCouponTemplateIssue, storeCouponUser, storeProductCoupon, systemLog } from '../src/models/schema';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { AdminCouponIssueService } from '../src/services/admin/AdminCouponIssueService';
import { AdminCouponTemplateService } from '../src/services/admin/AdminCouponTemplateService';
import { ActivityService } from '../src/services/activity/ActivityService';
import { couponIssueBody } from './helpers/couponIssueFixture';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { couponTemplateSnapshot, observeCouponTemplateDb, publicationBody, seedCouponTemplates,
  withCouponTemplatePeer, type CouponTemplateRuntimePeer } from './helpers/couponTemplateFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const actor = { id: 8 }, q = (value = '') => new URLSearchParams(value);
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Result = { ok: boolean; error?: unknown; value?: unknown };
function diagnostics(result: Result) {
  const error = (value: unknown, depth = 0): unknown => {
    if (!value || typeof value !== 'object' || depth > 6) return String(value);
    const row = value as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    return { name: row.name, message: row.message, code: row.code, cause: row.cause ? error(row.cause, depth + 1) : undefined };
  };
  return JSON.stringify(result.ok ? result : { ok: false, error: error(result.error) });
}
/** Pause only after a genuine SQL statement has executed. No SQL/result/auth
 * replacement is involved; the second backend must identify this exact PID. */
function pauseAfter(db: DbClient, matches: (tx: DbClient, command: string) => Promise<boolean> | boolean) {
  let signal!: () => void, release!: () => void, paused = false;
  const held = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observed = observeCouponTemplateDb(db, async (tx, command) => {
    if (!paused && await matches(tx, command)) { paused = true; signal(); await gate; }
  });
  return { db: observed, release, entered: async (work: Promise<Result>) => Promise.race([
    held, work.then(result => { throw Error(`Operation ended before its real lock barrier: ${diagnostics(result)}`); }),
  ]) };
}
const issueLock = (_tx: DbClient, command: string) => command.includes('from "store_coupon_issue"') && command.endsWith('for update');

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent coupon issuers on formal PG16 schema and commissioned Admin/App LOGINs', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O'));
    f = await refundRuntimeFixture();
    try {
      await seedCouponTemplates(f.db);
      await f.db.insert(storeBrand).values([
        { id: 4500, brandName: '品牌根', pid: 0, storeId: 0 },
        { id: 4501, brandName: '品牌子', pid: 4500, storeId: 0 },
      ]);
    } catch (error) { await f.close(); throw error; }
  }, 120000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  async function commissioned(run: (admin: CouponTemplateRuntimePeer, app: CouponTemplateRuntimePeer,
    service: AdminCouponIssueService, templates: AdminCouponTemplateService) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.db.execute(sql`SELECT current_database() AS database`);
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.database), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      for (const [peer, profile] of [[admin, 'admin'], [app, 'app']] as const) {
        expect(await auditRuntimeBusinessPrivileges(peer.db, profile, names)).toMatchObject({ ready: true, failures: [] });
        const [login] = await peer.exec('SELECT current_user AS role,session_user AS session,current_setting(\'server_version_num\') AS version');
        expect(login).toMatchObject({ role: peer.role, session: peer.role });
        expect(Math.floor(Number(login.version) / 10000)).toBe(16);
        expect((await peer.exec('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
          .toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
      }
      await run(admin, app, new AdminCouponIssueService(createContainerFromDb(admin.db)),
        new AdminCouponTemplateService(createContainerFromDb(admin.db)));
    }));
  }
  const issue = async (id: number) => (await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, id)))[0];
  const owned = (id: number) => f.db.select().from(storeCouponUser).where(eq(storeCouponUser.issueCouponId, id));
  const history = (id: number) => f.db.select().from(storeCouponIssueUser).where(eq(storeCouponIssueUser.issueCouponId, id));
  const switchBody = (revision: string, status: 0 | 1) => ({ request_id: crypto.randomUUID(), revision, status });
  const deleteBody = (revision: string) => ({ request_id: crypto.randomUUID(), revision });

  it('creates brand-scoped member discount and full windows with genuine Admin grants while preserving existing App template/proof restrictions', async () => {
    await commissioned(async (_admin, app, service) => {
      const now = Date.now(), iso = (offset: number) => new Date(now + offset).toISOString();
      const body = couponIssueBody({ title: '会员品牌折扣', discount_type: 2, scope_type: 3, brand_id: 4501, category: 2,
        coupon_price: '80.50', valid_days: 0, start_time: iso(-60000), end_time: iso(3600000),
        use_start_time: iso(-60000), use_end_time: iso(7200000), receive_type: 4, rule: '会员发行规则\n保留纯文本' });
      const created = await service.mutate('create', undefined, body, actor), row = await service.detail(String(created.id));
      expect(row).toMatchObject({ id: created.id, cid: 0, source_template: null, discount_type: 2, scope_type: 3, category: 2,
        brand_id: 4501, brand_name: '品牌子', coupon_price: '80.50', total_count: 5, remain_count: 5, valid_days: 0,
        receive_type: 4, start_time: body.start_time, end_time: body.end_time, use_start_time: body.use_start_time,
        use_end_time: body.use_end_time, rule: body.rule, app_type: 0, valid: true });
      expect(await service.copy(String(created.id))).toEqual(row);
      expect((await service.list(q('keyword=会员品牌折扣&discount_type=2&receive_type=4&status=1'))).list).toEqual([row]);
      expect((await service.options()).brands).toContainEqual({ id: 4501, pid: 4500, brand_name: '品牌子' });
      expect((await service.options()).categories).toContainEqual({ id: 4001, pid: 0, cate_name: '真实商品分类' });
      expect((await service.products(q('keyword=选择商品%25_'))).list).toEqual([{ id: 4100, store_name: '选择商品%_', deleted: false }]);
      expect(await service.claims(String(created.id), q())).toMatchObject({ source: 'owned', count: 0, list: [] });
      const before = await couponTemplateSnapshot(f.db);
      await expect(new ActivityService(createContainerFromDb(app.db)).receiveCoupon(4110, created.id)).rejects.toThrow('不允许手动领取');
      // Trusted application workflows already insert issuers and system logs.
      // The actual HTTP Admin gate is tested separately; invoking a service
      // directly cannot substitute for that authenticated route boundary.
      const [privileges] = await app.db.execute(sql`SELECT
        has_table_privilege(current_user,'public.store_coupon_issue','INSERT') AS trusted_issue_insert,
        has_table_privilege(current_user,'public.system_log','INSERT') AS trusted_log_insert,
        has_table_privilege(current_user,'public.store_coupon_template','INSERT') AS template_insert,
        has_table_privilege(current_user,'public.store_coupon_template','UPDATE') AS template_update,
        has_table_privilege(current_user,'public.store_coupon_template_issue','INSERT') AS proof_insert,
        has_table_privilege(current_user,'public.store_coupon_template_issue','UPDATE') AS proof_update,
        has_table_privilege(current_user,'public.store_coupon_template_issue','DELETE') AS proof_delete`);
      expect(privileges).toEqual({ trusted_issue_insert: true, trusted_log_insert: true,
        template_insert: false, template_update: false, proof_insert: false, proof_update: false, proof_delete: false });
      await expect(app.exec(`INSERT INTO public.store_coupon_template_issue(issue_id,template_id,issued_at,source_revision)
        VALUES(${created.id},45001,0,'${'a'.repeat(64)}')`)).rejects.toMatchObject({ code: '42501' });
      expect(await couponTemplateSnapshot(f.db)).toEqual(before);
    });
  }, 120000);

  it('copies a proven template publication into a new independent issuer without inherited cid/proof, inventory or financial history', async () => {
    await commissioned(async (_admin, app, service, templates) => {
      const source = await templates.detail('45001');
      const published = await templates.mutate('publish', undefined, publicationBody(source.id, source.revision), actor);
      if (!('issue_id' in published)) throw Error('Missing real published issue');
      await new ActivityService(createContainerFromDb(app.db)).receiveCoupon(4110, published.issue_id);
      const draft = await service.copy(String(published.issue_id));
      expect(draft).toMatchObject({ cid: source.id, source_template: { template_id: source.id, source_revision: source.revision }, remain_count: 4 });
      if (!draft.copy_input) throw Error('Valid copy draft missing');
      const sourceRow = await issue(published.issue_id), sourceOwned = await owned(published.issue_id), sourceHistory = await history(published.issue_id);
      const proofs = await f.db.select().from(storeCouponTemplateIssue);
      const copied = await service.mutate('create', undefined, couponIssueBody({ ...draft.copy_input, title: '独立复制发行',
        source_id: draft.id, source_revision: draft.revision }), actor);
      expect(copied.id).not.toBe(published.issue_id);
      expect(await service.detail(String(copied.id))).toMatchObject({ cid: 0, source_template: null, product_ids: [4100, 4101],
        total_count: 5, remain_count: 5, coupon_price: '5.00', valid: true });
      expect(await f.db.select().from(storeCouponProduct).where(eq(storeCouponProduct.couponId, copied.id)))
        .toEqual([{ couponId: copied.id, productId: 4100 }, { couponId: copied.id, productId: 4101 }]);
      expect(await f.db.select().from(storeCouponTemplateIssue)).toEqual(proofs);
      expect(await issue(published.issue_id)).toEqual(sourceRow);
      expect(await owned(published.issue_id)).toEqual(sourceOwned); expect(await history(published.issue_id)).toEqual(sourceHistory);
      expect(await owned(copied.id)).toEqual([]); expect(await history(copied.id)).toEqual([]);
    });
  }, 120000);

  it('serializes the same UUID on independent Admin LOGINs and commits exactly one issue, stock definition, scope and audit', async () => {
    await commissioned(async (admin, _app, service) => withCouponTemplatePeer(admin, async second => {
      const body = couponIssueBody({ scope_type: 2, product_ids: [4101, 4100] });
      const pause = pauseAfter(admin.db, async (tx, command) => {
        if (command !== 'execute') return false;
        const [state] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS held`);
        if (state.held === true) {
          const [deadlines] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
            (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
            (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
            (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`);
          expect(deadlines).toEqual({ isolation: 'read committed', read_only: 'off', statement: 5000, lock: 2000, idle: 5000 });
        }
        return state.held === true;
      });
      const first = outcome(new AdminCouponIssueService(createContainerFromDb(pause.db)).mutate('create', undefined, body, actor));
      await pause.entered(first);
      const concurrent = outcome(new AdminCouponIssueService(createContainerFromDb(second.db)).mutate('create', undefined, body, actor));
      try { await waitForFinanceBlock(f.db, second.pid, admin.pid); } finally { pause.release(); }
      const a = await first, b = await concurrent;
      expect(a.ok, diagnostics(a)).toBe(true); expect(b, diagnostics(b)).toEqual(a);
      if (!a.ok) throw a.error;
      expect(await issue(a.value.id)).toMatchObject({ totalCount: 5, remainCount: 5, cid: 0 });
      expect((await service.list(q('keyword=新发行'))).list.map(row => row.id)).toEqual([a.value.id]);
      expect(await f.db.select().from(storeCouponProduct).where(eq(storeCouponProduct.couponId, a.value.id))).toHaveLength(2);
      expect(await f.db.select().from(systemLog).where(and(eq(systemLog.type, 'coupon_issue'),
        eq(systemLog.path, `/marketing/coupon-issues/request/${body.request_id}`)))).toHaveLength(1);
      const before = await couponTemplateSnapshot(f.db);
      await expect(service.mutate('create', undefined, { ...body, total_count: 6 }, actor)).rejects.toThrow('请求标识');
      expect(await couponTemplateSnapshot(f.db)).toEqual(before);
    }));
  }, 120000);

  it('orders real public claim against issuer stop in both directions without partial inventory/history or invalidating a claim-independent revision', async () => {
    await commissioned(async (admin, app, service) => {
      const created = await service.mutate('create', undefined, couponIssueBody({ total_count: 2 }), actor);
      const current = await service.detail(String(created.id));
      const adminPause = pauseAfter(admin.db, issueLock);
      const stopped = outcome(new AdminCouponIssueService(createContainerFromDb(adminPause.db)).mutate('status', String(created.id), switchBody(current.revision, 0), actor));
      await adminPause.entered(stopped);
      const claim = outcome(new ActivityService(createContainerFromDb(app.db)).receiveCoupon(4110, created.id));
      try { await waitForFinanceBlock(f.db, app.pid, admin.pid); } finally { adminPause.release(); }
      const stopResult = await stopped, claimResult = await claim;
      expect(stopResult.ok, diagnostics(stopResult)).toBe(true); expect(claimResult.ok, diagnostics(claimResult)).toBe(false);
      if (claimResult.ok) throw Error('Stopped issuer admitted a claim');
      expect(String(claimResult.error)).toContain('停发');
      expect(await issue(created.id)).toMatchObject({ status: 0, remainCount: 2 });
      expect(await owned(created.id)).toEqual([]); expect(await history(created.id)).toEqual([]);
      await service.mutate('status', String(created.id), switchBody((await service.detail(String(created.id))).revision, 1), actor);
      const enabled = await service.detail(String(created.id)), appPause = pauseAfter(app.db, issueLock);
      const firstClaim = outcome(new ActivityService(createContainerFromDb(appPause.db)).receiveCoupon(4110, created.id));
      await appPause.entered(firstClaim);
      const secondStop = outcome(service.mutate('status', String(created.id), switchBody(enabled.revision, 0), actor));
      try { await waitForFinanceBlock(f.db, admin.pid, app.pid); } finally { appPause.release(); }
      const paid = await firstClaim, finalStop = await secondStop;
      expect(paid.ok, diagnostics(paid)).toBe(true); expect(finalStop.ok, diagnostics(finalStop)).toBe(true);
      expect(await issue(created.id)).toMatchObject({ status: 0, remainCount: 1 });
      expect(await owned(created.id)).toMatchObject([{ uid: 4110, couponPrice: '5.10', useMinPrice: '10.00', status: 0 }]);
      expect(await history(created.id)).toMatchObject([{ uid: 4110, issueCouponId: created.id }]);
      expect(await service.claims(String(created.id), q())).toMatchObject({ source: 'issue_log', count: 1 });
    });
  }, 120000);

  it('orders real public claim and soft delete both ways while retaining already issued wallet, claim, scope and paid-product history', async () => {
    await commissioned(async (admin, app, service) => {
      const first = await service.mutate('create', undefined, couponIssueBody({ total_count: 2 }), actor);
      const pause = pauseAfter(admin.db, issueLock);
      const deletion = outcome(new AdminCouponIssueService(createContainerFromDb(pause.db)).mutate('delete', String(first.id),
        deleteBody((await service.detail(String(first.id))).revision), actor));
      await pause.entered(deletion);
      const rejectedClaim = outcome(new ActivityService(createContainerFromDb(app.db)).receiveCoupon(4110, first.id));
      try { await waitForFinanceBlock(f.db, app.pid, admin.pid); } finally { pause.release(); }
      const deleted = await deletion, rejected = await rejectedClaim;
      expect(deleted.ok, diagnostics(deleted)).toBe(true); expect(rejected.ok, diagnostics(rejected)).toBe(false);
      expect(await issue(first.id)).toMatchObject({ isDel: 1, remainCount: 2 });
      expect(await owned(first.id)).toEqual([]); expect(await history(first.id)).toEqual([]);
      const second = await service.mutate('create', undefined, couponIssueBody({ scope_type: 2, product_ids: [4100, 4101], total_count: 2 }), actor);
      await f.db.insert(storeProductCoupon).values({ productId: 4100, issueCouponId: second.id });
      const scopes = await f.db.select().from(storeCouponProduct).where(eq(storeCouponProduct.couponId, second.id));
      const gifts = await f.db.select().from(storeProductCoupon).where(eq(storeProductCoupon.issueCouponId, second.id));
      const revision = (await service.detail(String(second.id))).revision, appPause = pauseAfter(app.db, issueLock);
      const claim = outcome(new ActivityService(createContainerFromDb(appPause.db)).receiveCoupon(4110, second.id));
      await appPause.entered(claim);
      const laterDelete = outcome(service.mutate('delete', String(second.id), deleteBody(revision), actor));
      try { await waitForFinanceBlock(f.db, admin.pid, app.pid); } finally { appPause.release(); }
      const accepted = await claim, finalDelete = await laterDelete;
      expect(accepted.ok, diagnostics(accepted)).toBe(true); expect(finalDelete.ok, diagnostics(finalDelete)).toBe(true);
      expect(await issue(second.id)).toMatchObject({ isDel: 1, remainCount: 1 });
      expect(await owned(second.id)).toMatchObject([{ uid: 4110, couponPrice: '5.10', status: 0 }]);
      expect(await history(second.id)).toMatchObject([{ uid: 4110, issueCouponId: second.id }]);
      expect(await f.db.select().from(storeCouponProduct).where(eq(storeCouponProduct.couponId, second.id))).toEqual(scopes);
      expect(await f.db.select().from(storeProductCoupon).where(eq(storeProductCoupon.issueCouponId, second.id))).toEqual(gifts);
      expect((await service.list(q('status='))).list.map(row => row.id)).not.toContain(second.id);
      expect((await service.copy(String(second.id))).copy_input).toBeNull();
    });
  }, 120000);

  it('lets template invalidation win the issue lock, rejects a stale reopen, then allows an explicitly refreshed independent reopen without restoring its source', async () => {
    await commissioned(async (admin, _app, service, templates) => withCouponTemplatePeer(admin, async second => {
      const source = await templates.detail('45001'), publication = await templates.mutate('publish', undefined, publicationBody(source.id, source.revision), actor);
      if (!('issue_id' in publication)) throw Error('Missing publication');
      const current = await service.detail(String(publication.issue_id)), proof = await f.db.select().from(storeCouponTemplateIssue);
      const pause = pauseAfter(admin.db, async (tx, command) => {
        if (command !== 'execute') return false;
        const [row] = await tx.select({ status: storeCouponIssue.status }).from(storeCouponIssue).where(eq(storeCouponIssue.id, publication.issue_id));
        return row?.status === -1;
      });
      const stopped = outcome(new AdminCouponTemplateService(createContainerFromDb(pause.db)).mutate('invalidate', String(source.id),
        { request_id: crypto.randomUUID(), revision: source.revision }, actor));
      await pause.entered(stopped);
      const reopen = outcome(new AdminCouponIssueService(createContainerFromDb(second.db)).mutate('status', String(publication.issue_id),
        switchBody(current.revision, 1), actor));
      try { await waitForFinanceBlock(f.db, second.pid, admin.pid); } finally { pause.release(); }
      const stopResult = await stopped, reopenResult = await reopen;
      expect(stopResult.ok, diagnostics(stopResult)).toBe(true); expect(reopenResult.ok, diagnostics(reopenResult)).toBe(false);
      if (reopenResult.ok) throw Error('Stale issue confirmation survived source invalidation');
      expect(String(reopenResult.error)).toContain('已变化');
      expect(await issue(publication.issue_id)).toMatchObject({ status: -1, remainCount: 5 });
      await service.mutate('status', String(publication.issue_id), switchBody((await service.detail(String(publication.issue_id))).revision, 1), actor);
      expect(await issue(publication.issue_id)).toMatchObject({ status: 1, remainCount: 5 });
      expect((await f.db.select().from(storeCouponTemplate).where(eq(storeCouponTemplate.id, source.id)))[0].status).toBe(0);
      expect(await f.db.select().from(storeCouponTemplateIssue)).toEqual(proof);
    }));
  }, 120000);

  it('lets an independent issue reopen commit first and a queued template invalidation close it again without rewriting proof or stock', async () => {
    await commissioned(async (admin, _app, service, templates) => withCouponTemplatePeer(admin, async second => {
      const source = await templates.detail('45001'), publication = await templates.mutate('publish', undefined, publicationBody(source.id, source.revision), actor);
      if (!('issue_id' in publication)) throw Error('Missing publication');
      await templates.mutate('invalidate', String(source.id), { request_id: crypto.randomUUID(), revision: source.revision }, actor);
      const sourceClosed = await templates.detail(String(source.id)), current = await service.detail(String(publication.issue_id));
      const proofs = await f.db.select().from(storeCouponTemplateIssue), pause = pauseAfter(admin.db, issueLock);
      const reopened = outcome(new AdminCouponIssueService(createContainerFromDb(pause.db)).mutate('status', String(publication.issue_id), switchBody(current.revision, 1), actor));
      await pause.entered(reopened);
      const invalidated = outcome(new AdminCouponTemplateService(createContainerFromDb(second.db)).mutate('invalidate', String(source.id),
        { request_id: crypto.randomUUID(), revision: sourceClosed.revision }, { id: 9 }));
      try { await waitForFinanceBlock(f.db, second.pid, admin.pid); } finally { pause.release(); }
      const a = await reopened, b = await invalidated;
      expect(a.ok, diagnostics(a)).toBe(true); expect(b.ok, diagnostics(b)).toBe(true);
      expect(await issue(publication.issue_id)).toMatchObject({ status: -1, remainCount: 5 });
      expect((await templates.detail(String(source.id))).status).toBe(0);
      expect(await f.db.select().from(storeCouponTemplateIssue)).toEqual(proofs);
      expect(await owned(publication.issue_id)).toEqual([]); expect(await history(publication.issue_id)).toEqual([]);
    }));
  }, 120000);

  it('fails enabling immediately on a genuine product writer lock and commits no issuer or audit changes before a clean retry', async () => {
    await commissioned(async (_admin, _app, service) => f.withPeer!(async maintenance => {
      const created = await service.mutate('create', undefined, couponIssueBody({ status: 0, scope_type: 2, product_ids: [4100] }), actor);
      const body = switchBody((await service.detail(String(created.id))).revision, 1), before = await couponTemplateSnapshot(f.db);
      await maintenance.exec('BEGIN');
      try {
        await maintenance.db.execute(sql`SELECT id FROM store_product WHERE id=4100 FOR UPDATE`);
        const start = performance.now(), rejected = await outcome(service.mutate('status', String(created.id), body, actor));
        expect(rejected.ok, diagnostics(rejected)).toBe(false);
        if (rejected.ok) throw Error('Scope lock conflict admitted enabling');
        expect(rejected.error).toMatchObject({ code: 400 }); expect(String(rejected.error)).toContain('正在变化');
        expect(performance.now() - start).toBeLessThan(1800);
        expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      } finally { await maintenance.exec('ROLLBACK'); }
      expect(await service.mutate('status', String(created.id), body, actor)).toEqual(created);
      expect(await issue(created.id)).toMatchObject({ status: 1, remainCount: 5 });
    }));
  }, 120000);

  it('uses six genuine RR/read-only reads, preserves stricter deadlines, denies writes and keeps count/list consistent across independent peer insertion', async () => {
    await commissioned(async (admin, _app, service) => {
      await admin.exec("SET statement_timeout='1s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='1500ms'");
      const settings = sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
        (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
        (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
        (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`;
      const baselineSettings = await admin.db.execute(settings), before = await couponTemplateSnapshot(f.db), states: unknown[] = [];
      for (const run of [
        (s: AdminCouponIssueService) => s.list(q()), (s: AdminCouponIssueService) => s.options(),
        (s: AdminCouponIssueService) => s.products(q()), (s: AdminCouponIssueService) => s.detail('46001'),
        (s: AdminCouponIssueService) => s.copy('46001'), (s: AdminCouponIssueService) => s.claims('46001', q()),
      ]) {
        let executes = 0;
        const observed = new AdminCouponIssueService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (tx, command) => {
          if (command === 'execute' && ++executes === 2) states.push((await tx.execute(settings))[0]);
        })));
        await run(observed);
      }
      expect(states).toHaveLength(6);
      for (const state of states) expect(state).toEqual({ isolation: 'repeatable read', read_only: 'on', statement: 1000, lock: 500, idle: 1500 });
      expect(await admin.db.execute(settings)).toEqual(baselineSettings); expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      let attempted = false;
      const probe = new AdminCouponIssueService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (!attempted && command === 'execute') { attempted = true; await tx.update(storeCouponIssue).set({ status: 0 }).where(eq(storeCouponIssue.id, 46001)); }
      })));
      await expect(probe.detail('46001')).rejects.toMatchObject({ cause: { code: '25006' } });
      expect(attempted).toBe(true); expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      await f.withPeer!(async maintenance => {
        let inserted = false;
        const observed = new AdminCouponIssueService(createContainerFromDb(observeCouponTemplateDb(admin.db, async (_tx, command) => {
          if (!inserted && command.includes('count(*)::integer') && command.includes('from "store_coupon_issue"')) {
            inserted = true;
            await maintenance.db.insert(storeCouponIssue).values({ id: 49001, couponType: 0, category: 0, receiveType: 1, day: 7,
              title: '历史孤儿cid-并发新增', couponTitle: '历史孤儿cid-并发新增', couponPrice: '1.00', totalCount: 1, remainCount: 1 });
          }
        })));
        const page = await observed.list(q('keyword=历史孤儿cid'));
        expect(inserted).toBe(true); expect(page.count).toBe(1); expect(page.list.map(row => row.id)).toEqual([46001]);
        expect((await service.list(q('keyword=历史孤儿cid'))).count).toBe(2);
      });
    });
  }, 120000);

  it('rejects invalid actor identities without writes and rolls back a genuine Admin creation when sequence USAGE is withheld', async () => {
    await commissioned(async (admin, _app, service) => {
      const body = couponIssueBody({ scope_type: 2, product_ids: [4100, 4101] }), before = await couponTemplateSnapshot(f.db);
      for (const id of [0, NaN, 2147483648]) await expect(service.mutate('create', undefined, body, { id })).rejects.toThrow('管理员ID');
      expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      await f.exec(`REVOKE USAGE ON SEQUENCE public.store_coupon_issue_id_seq FROM "${admin.role}"`);
      try {
        const [acl] = await admin.db.execute(sql`SELECT has_sequence_privilege(current_user,'public.store_coupon_issue_id_seq','USAGE') AS usage`);
        expect(acl.usage).toBe(false);
        await expect(service.mutate('create', undefined, body, actor)).rejects.toMatchObject({ cause: { code: '42501' } });
        expect(await couponTemplateSnapshot(f.db)).toEqual(before);
      } finally { await f.exec(`GRANT USAGE ON SEQUENCE public.store_coupon_issue_id_seq TO "${admin.role}"`); }
      const created = await service.mutate('create', undefined, body, actor);
      expect(await service.mutate('create', undefined, body, actor)).toEqual(created);
      expect(await issue(created.id)).toMatchObject({ remainCount: 5, totalCount: 5 });
      expect(await f.db.select().from(systemLog).where(and(eq(systemLog.type, 'coupon_issue'),
        eq(systemLog.path, `/marketing/coupon-issues/request/${body.request_id}`)))).toHaveLength(1);
    });
  }, 120000);
});
