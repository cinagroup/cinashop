import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import type { Sql } from 'postgres';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { createToken, md5 } from '../src/utils/jwt';
import { storeOrder, storeOrderCartInfo, systemAdmin, systemRole } from '../src/models/schema';
import { AdminOrderReadService } from '../src/services/admin/AdminOrderReadService';

// Only binding wiring changes. Hono routing, JWT, roles, controllers and SQL are real.
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/di')>();
  return { ...original, createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Missing isolated database');
    return { container: wiring.container, close: async () => {} };
  }, createContainer: () => {
    if (!wiring.container) throw Error('Missing isolated database');
    return wiring.container;
  } };
});
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected object');
  return value as Record<string, unknown>;
}
function rows(value: unknown) {
  if (!Array.isArray(value)) throw Error('Expected rows');
  return value.map(object);
}
function afterHeader(callback: (client: Sql) => Promise<void>) {
  let reached = false;
  const actual = PostgresJsSession.prototype.prepareQuery;
  const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
    const prepared = actual.apply(this, args);
    if (/^select .* from "store_order" where /s.test(args[0].sql) && !args[0].sql.includes('COUNT(')) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = async values => {
        const result = await execute(values);
        if (!reached) { reached = true; await callback(this.client); }
        return result;
      };
    }
    return prepared;
  });
  return () => { spy.mockRestore(); expect(reached).toBe(true); };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('assembled Admin order reads across refund generations', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const appKey = crypto.randomUUID() + crypto.randomUUID();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.insert(systemRole).values({ id: 990, roleName: 'Local order reader', rules: 'order.view', status: 1 });
    await f.db.insert(systemAdmin).values([
      { id: 990, account: 'local-reader', pwd: 'synthetic-digest', adminType: 1, level: 1, roles: '990' },
      { id: 991, account: 'local-denied', pwd: 'synthetic-digest', adminType: 1, level: 1 },
      { id: 992, account: 'local-supplier', pwd: 'synthetic-digest', adminType: 4, level: 0 },
    ]);
    for (const id of [990, 991, 992]) tokens.set(id, (await createToken(id, 'admin', md5('synthetic-digest'), appKey)).token);
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);
  async function wire(r: { role: string; container: Container }) {
    if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(r.role)) throw Error('Not a local isolated role');
    await f.exec(`GRANT SELECT ON system_admin,system_role,system_menus TO "${r.role}"`);
    wiring.container = r.container;
  }
  async function send(path: string, token = tokens.get(990)!) {
    return app.request(path, { headers: token ? { 'Authori-zation': `Bearer ${token}` } : {} },
      { ...f.env, NODE_ENV: 'test', APP_KEY: appKey });
  }
  async function read(path: string) {
    const response = await send(path), envelope = object(await response.json());
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(envelope.status).toBe(200);
    return object(envelope.data);
  }

  it('lists current physical orders once, with one authoritative count across both aliases', async () => {
    await f.withRuntime(async r => {
      await wire(r);
      const source = await r.createPaid(), application = await r.apply(source.id); await r.finish(application.refundId);
      const receipt = await r.receipt(application.refundId), before = await f.state();
      for (const base of ['/adminapi', '/api/admin']) {
        const result = await read(`${base}/order/list?limit=100`);
        expect(rows(result.list).map(row => row.id).sort()).toEqual([receipt.selectedOrderId, receipt.remainingOrderId].sort());
        expect(result.total).toBe(2);
        expect(rows(result.list).reduce((sum, row) => sum + Math.round(Number(row.payPrice) * 100), 0)).toBe(5500);
        const detail = await read(`${base}/order/detail/${source.orderId}`);
        expect(rows(detail.splitOrders).map(row => row.id).sort()).toEqual([receipt.selectedOrderId, receipt.remainingOrderId].sort());
      }
      expect(await f.state()).toEqual(before);
    });
  });

  it('never mixes an old detail header with carts committed by a concurrent refund finalizer', async () => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid(), application = await writer.apply(source.id);
      await f.withRuntime(async reader => {
        await wire(reader); expect(reader.pid).not.toBe(writer.pid);
        const path = `/adminapi/order/detail/${source.orderId}`, before = await read(path);
        const restore = afterHeader(async () => { expect(await writer.finish(application.refundId)).toBe('completed'); });
        try { expect(await read(path)).toEqual(before); } finally { restore(); }
        expect(await read(path)).not.toEqual(before);
      });
    });
  }, 45_000);

  it('keeps exact pagination, filters and payment-number discovery after three genuine refunds', async () => {
    await f.withRuntime(async r => {
      await wire(r);
      const source = await r.createPaid(), first = await r.apply(source.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!;
      const second = await r.apply(remainder); await r.finish(second.refundId);
      const third = await r.apply(remainder, 71); await r.finish(third.refundId);
      const ids = [receipt.selectedOrderId, (await r.receipt(second.refundId)).selectedOrderId, remainder].sort();
      const before = await f.state();
      const firstPage = await read('/adminapi/order/list?page=1&limit=2&paid=1&uid=11');
      const secondPage = await read('/api/admin/order/list?page=2&limit=2&paid=1&uid=11');
      expect(firstPage.total).toBe(3); expect(secondPage.total).toBe(3);
      const all = [...rows(firstPage.list), ...rows(secondPage.list)];
      expect(all.map(row => row.id).sort()).toEqual(ids);
      expect(all.reduce((n, row) => n + Math.round(Number(row.payPrice) * 100), 0)).toBe(5500);
      expect(rows((await read(`/adminapi/order/list?order_id=${source.orderId}`)).list).map(row => row.id).sort()).toEqual(ids);
      for (const row of all) {
        const detail = await read(`/adminapi/order/detail/${row.orderId}`);
        expect(rows(detail.cartInfo)).toHaveLength(1); expect(detail.splitOrders).toEqual([]);
        expect(rows((await read(`/adminapi/order/list?order_id=${row.orderId}`)).list).map(item => item.id)).toEqual([row.id]);
      }
      for (const query of ['paid=0', 'uid=22', 'status=1', 'order_id=missing']) {
        expect(await read(`/adminapi/order/list?${query}`)).toMatchObject({ list: [], total: 0 });
      }
      expect(await read('/adminapi/order/list?page=4&limit=2')).toMatchObject({ list: [], total: 3 });
      expect(await f.state()).toEqual(before);
    });
  });

  it('counts the six effective legacy states over current physical orders without double counting or inventing refunds', async () => {
    await f.withRuntime(async r => {
      await wire(r);
      const supplier = await r.createPaid();
      expect(supplier).toMatchObject({ pid: expect.any(Number), supplierId: 7, paid: 1, status: 0, shippingType: 1 });
      expect(supplier.pid).toBeGreaterThanOrEqual(0);
      await f.db.insert(storeOrder).values([
        { orderId: 'chart-unpaid', uid: 11, paid: 0, status: 0 },
        { orderId: 'chart-store-partial', uid: 11, storeId: 9, paid: 1, status: 4, shippingType: 3 },
        { orderId: 'chart-delivery', uid: 11, paid: 1, status: 1, shippingType: 1 },
        { orderId: 'chart-pickup', uid: 11, paid: 1, status: 0, shippingType: 2 },
        { orderId: 'chart-evaluate', uid: 11, paid: 1, status: 2 },
        { orderId: 'chart-complete', uid: 11, paid: 1, status: 3 },
        { orderId: 'chart-refunded', uid: 11, paid: 1, status: 3, refundStatus: 2 },
        { orderId: 'chart-refunding', uid: 11, paid: 1, status: 0, refundStatus: 1 },
        { orderId: 'chart-deleted', uid: 11, paid: 1, status: 0, isDel: 1 },
        { orderId: 'chart-system-deleted', uid: 11, paid: 1, status: 0, isSystemDel: 1 },
        { orderId: 'chart-payment-parent', uid: 11, pid: -1, paid: 1, status: 0 },
      ]);
      const before = await f.state();
      const expected = { all: 9, unpaid: 1, unshipped: 2, untake: 2, unevaluate: 1, complete: 1 };
      expect(await read('/adminapi/order/chart')).toEqual(expected);
      expect(await read('/api/admin/order/chart')).toEqual(expected);
      // The old default was platform-only and included split payment headers;
      // this screen follows /order/list: all channels, current physical rows.
      expect((await read('/adminapi/order/list?limit=100')).total).toBe(expected.all);
      expect(await f.state()).toEqual(before);
    });
  }, 45_000);

  it('requires real Admin JWT and order.view for both aliases, without broadening supplier or customer access', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      const customer = (await createToken(11, 'api', md5('synthetic-digest'), appKey)).token;
      const cases = [{ token: '', status: 410000 }, { token: 'invalid', status: 410001 },
        { token: tokens.get(991)!, status: 400011 }, { token: tokens.get(992)!, status: 410002 },
        { token: customer, status: 410002 }];
      const before = await f.state();
      for (const base of ['/adminapi', '/api/admin']) for (const path of ['/order/chart', '/order/list', `/order/detail/${source.orderId}`]) {
        for (const sample of cases) {
          const response = await send(base + path, sample.token);
          expect(response.headers.get('Cache-Control')).toContain('no-store');
          expect(await response.json()).toMatchObject({ status: sample.status, data: null });
        }
      }
      await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 990));
      expect(await (await send('/adminapi/order/chart')).json()).toMatchObject({ status: 400011 });
      await f.db.update(systemRole).set({ status: 1 }).where(eq(systemRole.id, 990));
      await f.db.update(systemAdmin).set({ pwd: 'changed-local-digest' }).where(eq(systemAdmin.id, 990));
      expect(await (await send('/api/admin/order/chart')).json()).toMatchObject({ status: 410001 });
      expect(await f.state()).toEqual(before);
    });
  });

  it('rejects malformed/unbounded pagination and selectors before querying business rows', async () => {
    await f.withRuntime(async r => {
      await wire(r); await r.createPaid(); const before = await f.state();
      for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=10001', 'limit=0', 'limit=101', 'limit=NaN',
        'uid=0', 'uid=2147483648', 'paid=2', 'status=6', 'order_id=%25', 'page=1&page=2']) {
        const response = await send(`/adminapi/order/list?${query}`);
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(await response.json()).toMatchObject({ status: 400, data: null });
      }
      expect(await read('/adminapi/order/list?status=&paid=')).toMatchObject({ total: 1 });
      for (const query of ['status=1', 'status=', 'start=1', 'status=1&status=2']) {
        expect(await (await send(`/adminapi/order/chart?${query}`)).json()).toMatchObject({ status: 400, data: null });
      }
      expect(await f.state()).toEqual(before);
    });
  });

  it('keeps list/detail/children deletion filters consistent and binds child and cart owners', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid(), application = await r.apply(source.id); await r.finish(application.refundId);
      const receipt = await r.receipt(application.refundId), child = await r.order(receipt.selectedOrderId);
      for (const deletion of [{ isDel: 1 }, { isDel: 0, isSystemDel: 1 }]) {
        await f.db.update(storeOrder).set(deletion).where(eq(storeOrder.id, child.id));
        const before = await f.state();
        expect(rows((await read('/adminapi/order/list')).list).map(row => row.id)).toEqual([receipt.remainingOrderId]);
        expect(rows((await read(`/adminapi/order/detail/${source.orderId}`)).splitOrders).map(row => row.id)).toEqual([receipt.remainingOrderId]);
        expect(await (await send(`/adminapi/order/detail/${child.orderId}`)).json()).toMatchObject({ status: 404, data: null });
        expect(await f.state()).toEqual(before);
      }
      await f.db.update(storeOrder).set({ isSystemDel: 0, uid: 22 }).where(eq(storeOrder.id, child.id));
      expect(rows((await read(`/adminapi/order/detail/${source.orderId}`)).splitOrders).map(row => row.id)).toEqual([receipt.remainingOrderId]);
      expect(rows((await read(`/adminapi/order/list?order_id=${source.orderId}`)).list).map(row => row.id)).toEqual([receipt.remainingOrderId]);
      expect(await (await send(`/adminapi/order/detail/${child.orderId}`)).json()).toMatchObject({ status: 400, data: null });
    });
  });

  it.each(['json', 'array', 'large-cart', 'large-order', 'large-order-sum', 'large-promotion', 'cart-count', 'child-count'] as const)
  ('fails explicitly for %s bounds/corruption, without empty-success or partial result', async fault => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      if (['json', 'array', 'large-cart'].includes(fault)) await f.db.update(storeOrderCartInfo).set({
        cartInfo: fault === 'json' ? '{invalid' : fault === 'array' ? '[]' : JSON.stringify({ padding: '界'.repeat(22_000) }),
      }).where(eq(storeOrderCartInfo.oid, source.id));
      if (fault === 'large-order') await f.db.update(storeOrder).set({ customForm: '界'.repeat(90_000) }).where(eq(storeOrder.id, source.id));
      if (fault === 'large-order-sum') await f.db.update(storeOrder).set({ customForm: 'a'.repeat(150_000), giveCoupon: 'b'.repeat(150_000) }).where(eq(storeOrder.id, source.id));
      if (fault === 'large-promotion') await f.db.update(storeOrderCartInfo).set({ promotionsId: 'a'.repeat(66_000) }).where(eq(storeOrderCartInfo.oid, source.id));
      if (fault === 'cart-count') await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 199 }, (_, i) => ({
        oid: source.id, uid: 11, cartId: String(1000 + i), unique: `local-bound-${i}`, cartInfo: '{}',
      })));
      if (fault === 'child-count') {
        await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, source.id));
        await f.db.insert(storeOrder).values(Array.from({ length: 201 }, (_, i) => ({
          pid: source.id, uid: 11, orderId: `local-bound-${i}`, unique: `local-bound-${i}`,
        })));
      }
      const before = await f.state(), response = await send(`/adminapi/order/detail/${source.orderId}`);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.json()).toMatchObject({ status: 400, data: null });
      if (fault.startsWith('large-order')) expect(await (await send('/adminapi/order/list')).json()).toMatchObject({ status: 400, data: null });
      expect(await f.state()).toEqual(before);
    });
  });

  it('works through separately authenticated SELECT-only access and restores timeout/read-only state on denied reads', async () => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid(), application = await writer.apply(source.id); await writer.finish(application.refundId);
      await f.withRuntimeRole!(async peer => {
        const container = createContainerFromDb(peer.db); await wire({ ...peer, container });
        await f.exec(`GRANT SELECT ON store_order,store_order_cart_info TO "${peer.role}"`);
        const [role] = await peer.db.execute(sql`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
          has_table_privilege(current_user,'store_order','UPDATE') AS can_write,
          (SELECT relowner::regrole::text=current_user FROM pg_class WHERE oid='store_order'::regclass) AS owns
          FROM pg_roles WHERE rolname=current_user`);
        expect(role).toEqual({ current_user: peer.role, session_user: peer.role, rolsuper: false, rolcreatedb: false,
          rolcreaterole: false, rolbypassrls: false, can_write: false, owns: false });
        await peer.exec("SET statement_timeout='0'");
        const restore = afterHeader(async client => {
          const [settings] = await client.unsafe(`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
          expect(settings).toEqual({ readonly: 'on', timeout: '5s' });
        });
        try { expect((await read('/adminapi/order/list')).total).toBe(2); } finally { restore(); }
        expect((await read('/adminapi/order/chart')).all).toBe(2);
        expect(rows((await read(`/adminapi/order/detail/${source.orderId}`)).splitOrders)).toHaveLength(2);
        await f.exec(`REVOKE SELECT ON store_order_cart_info FROM "${peer.role}"`);
        await expect(new AdminOrderReadService(container).detail(source.orderId)).rejects.toMatchObject({ cause: { code: '42501' } });
        const [settings] = await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
        expect(settings).toEqual({ readonly: 'off', timeout: '0' });
        await f.exec(`REVOKE SELECT ON store_order FROM "${peer.role}"`);
        await expect(new AdminOrderReadService(container).list({})).rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(new AdminOrderReadService(container).chart()).rejects.toMatchObject({ cause: { code: '42501' } });
      });
    });
  });

  for (const generation of ['first', 'later'] as const) it.each(['list', 'detail'] as const)(
    `%s keeps one read-only snapshot during the ${generation} real split`, async kind => {
      await f.withRuntime(async writer => {
        const root = await writer.createPaid(); let id = root.id;
        if (generation === 'later') {
          const first = await writer.apply(id); await writer.finish(first.refundId); id = (await writer.receipt(first.refundId)).remainingOrderId!;
        }
        const current = await writer.order(id), application = await writer.apply(id);
        await f.withRuntime(async reader => {
          await wire(reader); expect(reader.pid).not.toBe(writer.pid); await reader.exec("SET statement_timeout='3s'");
          const path = kind === 'list' ? '/api/admin/order/list?limit=100' : `/api/admin/order/detail/${current.orderId}`;
          const before = await read(path);
          let completed: Awaited<ReturnType<typeof f.state>> | undefined;
          const restore = afterHeader(async client => {
            const [settings] = await client.unsafe(`SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
            expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '3s' });
            expect(await writer.finish(application.refundId)).toBe('completed'); completed = await f.state();
          });
          try { expect(await read(path)).toEqual(before); } finally { restore(); }
          expect(await read(path)).not.toEqual(before); expect(await f.state()).toEqual(completed);
        });
      });
    }, 45_000,
  );
});
