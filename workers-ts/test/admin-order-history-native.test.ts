import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createContainerFromDb } from '@/lib/di';
import { storeOrder, storeOrderStatus, systemRole, systemAdmin } from '@/models/schema';
import { AdminOrderHistoryService } from '@/services/admin/AdminOrderHistoryService';
import { md5 } from '@/utils/jwt';
import { withRemarkScenario, type RemarkScenario } from './helpers/adminOrderRemark';
import { withEditScenario } from './helpers/adminOrderEdit';

const oid = 820001, number = 'HistoryOrder';
async function seed(s: RemarkScenario) {
  await s.seed(oid, number);
  await s.f.db.insert(storeOrderStatus).values([
    { id: 860003, oid, changeTime: 50, changeType: 'future_event', changeMessage: '后一个同秒记录' },
    { id: 860001, oid, changeTime: 0, changeType: 'unknown_kind', changeMessage: '  原文\n😀  ' },
    { id: 860002, oid, changeTime: 50, changeType: '', changeMessage: '<script>alert(1)</script>' },
    { id: 860004, oid, changeTime: -1, changeType: 'legacy', changeMessage: '前一秒' },
  ]);
}
async function unchanged(s: RemarkScenario) {
  return { rows: await s.snapshot(), sequences: await s.f.exec('SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname=\'public\' ORDER BY sequencename') };
}
const url = (prefix = '/adminapi', page = 1, revision?: string) => `${prefix}/order/history/${oid}?order_id=${number}&page=${page}&limit=2${revision ? '&revision=' + revision : ''}`;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin chronological order history through real JWT and restricted native LOGINs', () => {
  it.each(['/adminapi', '/api/admin'])('returns original PHP fields, unknown events, raw whitespace and chronological ties through %s', async prefix => withRemarkScenario(async s => {
    await seed(s); const before = await unchanged(s);
    const result = await s.request('GET', `${prefix}/order/status/${oid}?page=99&limit=1`, undefined, s.token('viewer'));
    expect(result.status, result.msg).toBe(200); expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.data.map((r: { id: number }) => r.id)).toEqual([860004, 860001, 860002, 860003]);
    expect(result.data[1]).toEqual({ id: 860001, oid, change_type: 'unknown_kind', change_message: '  原文\n😀  ', change_time: '1970-01-01 08:00:00' });
    expect(result.data[2].change_message).toBe('<script>alert(1)</script>'); expect(result.data[2].change_type).toBe('');
    expect(await unchanged(s)).toEqual(before);
  }), 120000);

  it('keeps exact orphan/deleted histories and never falls back from a numeric primary ID to an order number', async () => withRemarkScenario(async s => {
    await seed(s); await s.seed(820002, String(oid));
    await s.f.db.insert(storeOrderStatus).values({ oid: 820002, changeTime: 1, changeMessage: '其他订单' });
    for (const flags of [{ isDel: 1, isSystemDel: 0 }, { isDel: 0, isSystemDel: 1 }, { isDel: 1, isSystemDel: 1 }]) {
      await s.f.db.update(storeOrder).set(flags).where(eq(storeOrder.id, oid));
      expect((await s.request('GET', `/adminapi/order/status/${oid}`)).data).toHaveLength(4);
    }
    await s.f.db.delete(storeOrder).where(eq(storeOrder.id, oid));
    expect((await s.request('GET', `/adminapi/order/status/${oid}`)).data).toHaveLength(4);
    expect((await s.request('GET', '/adminapi/order/status/820099')).data).toEqual([]);
    expect((await s.request('GET', url())).status).not.toBe(200);
  }), 120000);

  it('pages the same exact identity across aliases while the old endpoint still returns the complete array', async () => withRemarkScenario(async s => {
    await seed(s); const before = await unchanged(s);
    const first = await s.request('GET', url(), undefined, s.token('viewer'));
    expect(first.status, first.msg).toBe(200); expect(first.data).toMatchObject({ id: oid, order_id: number, page: 1, limit: 2, count: 4 });
    expect(first.data.list.map((r: { id: number }) => r.id)).toEqual([860004, 860001]);
    const second = await s.request('GET', url('/api/admin', 2, first.data.revision), undefined, s.token('viewer'));
    expect(second.status, second.msg).toBe(200); expect(second.data.list.map((r: { id: number }) => r.id)).toEqual([860002, 860003]);
    expect(second.data.revision).toBe(first.data.revision);
    expect((await s.request('GET', url().replace(number, 'OtherOrder'))).status).not.toBe(200);
    expect(await unchanged(s)).toEqual(before);
  }), 120000);

  it('keeps source parents, current children, siblings and different buyers separate without reading purchase JSON', async () => withRemarkScenario(async s => {
    await seed(s); await s.seed(820002, 'ChildOrder'); await s.seed(820003, 'OtherBuyerSibling');
    await s.f.db.update(storeOrder).set({ pid: -1, cartId: '旧'.repeat(100000), virtualInfo: '原'.repeat(100000) }).where(eq(storeOrder.id, oid));
    await s.f.db.update(storeOrder).set({ pid: oid }).where(eq(storeOrder.id, 820002));
    await s.f.db.update(storeOrder).set({ pid: oid, uid: 12 }).where(eq(storeOrder.id, 820003));
    await s.f.db.insert(storeOrderStatus).values({ oid: 820002, changeTime: 1, changeMessage: '仅属于子单' });
    await s.f.db.insert(storeOrderStatus).values({ oid: 820003, changeTime: 1, changeMessage: '另一个买家的同族记录' });
    const result = await s.request('GET', url()); expect(result.status, result.msg).toBe(200); expect(result.data.count).toBe(4);
    expect((await s.request('GET', '/adminapi/order/status/820002')).data[0].change_message).toBe('仅属于子单');
  }), 120000);

  it('denies anonymous disabled and supplier JWTs, accepts view-only readers and rechecks live role/password state', async () => withRemarkScenario(async s => {
    await seed(s); const before = await unchanged(s);
    for (const prefix of ['/adminapi', '/api/admin']) for (const endpoint of [`${prefix}/order/status/${oid}`, url(prefix)]) {
      for (const token of [null, s.token('disabled'), s.token('supplier')]) {
        const result = await s.request('GET', endpoint, undefined, token); expect(result.status).not.toBe(200); expect(result.headers.get('cache-control')).toContain('no-store');
      }
      expect((await s.request('GET', endpoint, undefined, s.token('viewer'))).status).toBe(200);
    }
    expect(await unchanged(s)).toEqual(before);
    await s.f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 820002));
    expect((await s.request('GET', url(), undefined, s.token('viewer'))).status).not.toBe(200);
    await s.f.db.update(systemRole).set({ rules: 'order.view' }).where(eq(systemRole.id, 820002));
    await s.f.db.update(systemAdmin).set({ pwd: 'owned-replaced-password' }).where(eq(systemAdmin.id, 103));
    expect((await s.request('GET', url(), undefined, s.token('viewer'))).status).not.toBe(200);
  }), 120000);

  it('rejects malformed IDs, duplicate queries, unbound pages and actor/identity/limit revision substitutions without writes', async () => withRemarkScenario(async s => {
    await seed(s); const before = await unchanged(s), first = await s.request('GET', url(), undefined, s.token('viewer'));
    for (const path of ['/adminapi/order/status/0', '/adminapi/order/status/0820001', '/adminapi/order/status/2147483648',
      url() + '&page=1', url() + '&supplier_id=7', url('/adminapi', 2), url().replace('limit=2', 'limit=101')]) {
      expect((await s.request('GET', path)).status).not.toBe(200);
    }
    expect((await s.request('GET', url('/adminapi', 2, first.data.revision))).status).toBe(409);
    expect((await s.request('GET', url('/adminapi', 2, first.data.revision).replace('limit=2', 'limit=3'), undefined, s.token('viewer'))).status).toBe(409);
    expect(await unchanged(s)).toEqual(before);
  }), 120000);

  it.each(['insert', 'update', 'delete'] as const)('refuses a stale page after a peer %s, then returns the complete refreshed state', async kind => withRemarkScenario(async s => {
    await seed(s); const first = await s.request('GET', url());
    if (kind === 'insert') await s.f.db.insert(storeOrderStatus).values({ oid, changeTime: -2, changeMessage: '迟到的早期记录' });
    if (kind === 'update') await s.f.db.update(storeOrderStatus).set({ changeMessage: '修订记录' }).where(eq(storeOrderStatus.id, 860003));
    if (kind === 'delete') await s.f.db.delete(storeOrderStatus).where(eq(storeOrderStatus.id, 860003));
    const after = await unchanged(s);
    expect((await s.request('GET', url('/adminapi', 2, first.data.revision))).status).toBe(409);
    const fresh = await s.request('GET', url()); expect(fresh.status, fresh.msg).toBe(200); expect(fresh.data.revision).not.toBe(first.data.revision);
    expect(fresh.data.count).toBe(kind === 'insert' ? 5 : kind === 'delete' ? 3 : 4); expect(await unchanged(s)).toEqual(after);
  }), 120000);

  it('uses one real read-only repeatable-read snapshot when a peer inserts between the fingerprint and page query', async () => withRemarkScenario(async s => {
    await seed(s); const before = await s.request('GET', url()); let reached = false;
    const actual = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = actual.apply(this, args);
      if (args[0].sql.includes('FROM (SELECT * FROM public.store_order_status')) {
        const execute = prepared.execute.bind(prepared);
        prepared.execute = async values => {
          const result = await execute(values);
          if (!reached) { reached = true;
            const [settings] = await this.client.unsafe(`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
            expect(settings).toEqual({ readonly: 'on', isolation: 'repeatable read' });
            await s.f.db.insert(storeOrderStatus).values({ oid, changeTime: -2, changeMessage: '并发写入' });
          }
          return result;
        };
      }
      return prepared;
    });
    try { expect((await s.request('GET', url())).data).toEqual(before.data); } finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect((await s.request('GET', url())).data.count).toBe(5);
  }), 120000);

  it('reads with a separate genuinely SELECT-only LOGIN and restores read-only and timeout settings', async () => withRemarkScenario(async s => {
    await seed(s);
    await s.f.withRuntimeRole!(async role => {
      await s.f.db.execute(sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role.role}"`));
      const settings = () => role.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
      const before = await settings();
      const result = await new AdminOrderHistoryService(createContainerFromDb(role.db), 'owned-history-key').page(oid,
        { order_id: number }, { id: 103, authVersion: md5('owned-remark-admin-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      expect(result.count).toBe(4); expect(await settings()).toEqual(before);
      const [rights] = await role.db.execute(sql`SELECT has_table_privilege(current_user,'public.store_order_status','INSERT,UPDATE,DELETE') AS writes`);
      expect(rights.writes).toBe(false);
    });
  }), 120000);

  it.each(['legacy-count', 'legacy-bytes', 'modern-count', 'modern-bytes'] as const)('rejects the explicit %s boundary without truncating or mutating history', async kind => withRemarkScenario(async s => {
    await s.seed(oid, number); const count = kind === 'legacy-count' ? 2001 : kind === 'legacy-bytes' ? 2000 : kind === 'modern-count' ? 10001 : 10000;
    const message = kind.endsWith('bytes') ? '😀'.repeat(256) : '';
    await s.f.db.execute(sql`INSERT INTO public.store_order_status(oid,change_type,change_message,change_time) SELECT ${oid},'',${message},n FROM generate_series(1,${count}) n`);
    const before = await unchanged(s), legacy = kind.startsWith('legacy');
    const result = await s.request('GET', legacy ? `/adminapi/order/status/${oid}` : url());
    expect(result.status).not.toBe(200); expect(result.data).toBeNull(); expect(await unchanged(s)).toEqual(before);
    if (legacy) { const paged = await s.request('GET', url()); expect(paged.status, paged.msg).toBe(200); expect(paged.data.count).toBe(count); }
  }), 120000);

  it('matches PostgreSQL named Shanghai clocks including negative epoch and historical daylight saving', async () => withRemarkScenario(async s => {
    await s.seed(oid, number); const seconds = [-1, 0, Date.UTC(1991, 5, 1) / 1000, Date.UTC(1991, 0, 1) / 1000];
    for (const changeTime of seconds) await s.f.db.insert(storeOrderStatus).values({ oid, changeTime, changeMessage: String(changeTime) });
    const result = await s.request('GET', `/adminapi/order/status/${oid}`);
    for (const row of result.data) {
      const [pg] = await s.f.db.execute(sql`SELECT to_char(to_timestamp(${Number(row.change_message)}) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS text`);
      expect(row.change_time).toBe(pg.text);
    }
  }), 120000);

  it('reaches the final admitted record when the caller deliberately selects one record per page', async () => withRemarkScenario(async s => {
    await s.seed(oid, number);
    await s.f.db.execute(sql`INSERT INTO public.store_order_status(oid,change_type,change_message,change_time) SELECT ${oid},'','',n FROM generate_series(1,10000) n`);
    const first = await s.request('GET', url().replace('limit=2', 'limit=1'));
    expect(first.status, first.msg).toBe(200); expect(first.data.count).toBe(10000);
    const last = await s.request('GET', url('/adminapi', 10000, first.data.revision).replace('limit=2', 'limit=1'));
    expect(last.status, last.msg).toBe(200); expect(last.data.list).toHaveLength(1);
    expect(last.data.list[0].timestamp).toBe(10000); expect(last.data.page).toBe(10000);
  }), 120000);

  it('shows actual committed Admin price and remark operations after an explicit refresh', async () => withEditScenario(async s => {
    const order = await s.checkout(); const path = `/adminapi/order/history/${order.id}?order_id=${order.orderId}`;
    const before = await s.request('GET', path);
    const form = await s.request('GET', `/adminapi/order/edit/${order.id}`);
    expect((await s.request('PUT', `/adminapi/order/update/${order.id}`, { ...form.data.values, revision: form.data.revision, pay_price: '18.75', gain_integral: '17' })).status).toBe(200);
    expect((await s.request('POST', `/adminapi/order/remark/${order.orderId}`, { remark: '历史核对备注' })).status).toBe(200);
    expect((await s.request('GET', path + '&revision=' + before.data.revision)).status).toBe(409);
    const result = await s.request('GET', path); expect(result.status, result.msg).toBe(200);
    expect(result.data.list.filter((row: { change_type: string }) => ['order_edit', 'admin_order_remark'].includes(row.change_type)).map((row: { change_type: string }) => row.change_type)).toEqual(['order_edit', 'admin_order_remark']);
  }), 120000);
});
