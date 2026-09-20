import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import type { Sql } from 'postgres';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { createToken, md5 } from '../src/utils/jwt';
import { storeOrder, storeOrderCartInfo, systemAdmin, systemRole, systemSupplier } from '../src/models/schema';
import { SupplierService } from '../src/services/supplier/SupplierService';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/di')>();
  return { ...original, createContainer: () => {
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
  let releaseCount = () => {};
  const headerDone = new Promise<void>(resolve => { releaseCount = resolve; });
  const actual = PostgresJsSession.prototype.prepareQuery;
  const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
    const prepared = actual.apply(this, args);
    // Delay the real count query until the independent writer has committed.
    // This also exercises the former Promise.all implementation deterministically.
    if (/^select .*COUNT\(.* from "store_order" where /s.test(args[0].sql)) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = async values => { await headerDone; return execute(values); };
    }
    if (/^select .* from "store_order" where /s.test(args[0].sql) && !args[0].sql.includes('COUNT(')) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = async values => {
        const result = await execute(values);
        if (!reached) { reached = true; try { await callback(this.client); } finally { releaseCount(); } }
        return result;
      };
    }
    return prepared;
  });
  return () => { releaseCount(); spy.mockRestore(); expect(reached).toBe(true); };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('assembled Supplier order reads across refund generations', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const appKey = crypto.randomUUID() + crypto.randomUUID();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.insert(systemRole).values({ id: 990, roleName: 'Local supplier order reader', type: 4,
      relationId: 7, rules: 'supplier.order.view', status: 1 });
    await f.db.insert(systemSupplier).values({ id: 8, adminId: 992, supplierName: 'Other local supplier' });
    await f.db.insert(systemAdmin).values([
      { id: 990, account: 'local-reader', pwd: 'synthetic-digest', adminType: 4, relationId: 7, roles: '990' },
      { id: 991, account: 'local-denied', pwd: 'synthetic-digest', adminType: 4, relationId: 7 },
      { id: 992, account: 'local-other', pwd: 'synthetic-digest', adminType: 4, relationId: 8 },
    ]);
    for (const id of [990, 991, 992]) tokens.set(id, (await createToken(id, 'supplier', md5('synthetic-digest'), appKey)).token);
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 45_000);
  async function wire(r: { role: string; container: Container }) {
    if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(r.role)) throw Error('Not a local isolated role');
    await f.exec(`GRANT SELECT ON system_admin,system_role,system_supplier TO "${r.role}"`);
    wiring.container = r.container;
  }
  async function send(path: string, token = tokens.get(990)!) {
    return app.request(`/supplierapi${path}`, { headers: token ? { 'Authori-zation': `Bearer ${token}` } : {} },
      { ...f.env, NODE_ENV: 'test', APP_KEY: appKey });
  }
  async function read(path: string) {
    const response = await send(path), envelope = object(await response.json());
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(envelope.status).toBe(200);
    return object(envelope.data);
  }

  for (const generation of ['first', 'later'] as const) it.each(['list', 'detail'] as const)(`%s retains one generation during an independently committed ${generation} refund`, async kind => {
    await f.withRuntime(async writer => {
      const root = await writer.createPaid(); let remainder = root.id;
      if (generation === 'later') {
        const first = await writer.apply(root.id); await writer.finish(first.refundId);
        remainder = (await writer.receipt(first.refundId)).remainingOrderId!;
      }
      const application = await writer.apply(remainder);
      await f.withRuntime(async reader => {
        await wire(reader); expect(reader.pid).not.toBe(writer.pid);
        await reader.exec("SET statement_timeout='3s'");
        const path = kind === 'list' ? '/order/list?limit=100' : `/order/info/${remainder}`;
        const before = await read(path);
        let committed: Awaited<ReturnType<typeof f.state>> | undefined;
        const restore = afterHeader(async client => {
          const [settings] = await client.unsafe(`SELECT current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
          expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '3s' });
          expect(await writer.finish(application.refundId)).toBe('completed'); committed = await f.state();
        });
        try { expect(await read(path)).toEqual(before); } finally { restore(); }
        expect(await read(path)).not.toEqual(before);
        expect(await f.state()).toEqual(committed);
      });
    });
  }, 45_000);

  it('rejects a cart belonging to a different customer instead of returning its snapshot', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      await f.db.update(storeOrderCartInfo).set({ uid: 22 }).where(eq(storeOrderCartInfo.oid, source.id));
      const before = await f.state();
      expect(await (await send(`/order/info/${source.id}`)).json()).toMatchObject({ status: 400, data: null });
      expect(await f.state()).toEqual(before);
    });
  });

  it('preserves physical pagination, filters, historical-root detail and raw cart DTO after three refunds', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!;
      const second = await r.apply(remainder); await r.finish(second.refundId);
      const third = await r.apply(remainder, 71); await r.finish(third.refundId);
      const before = await f.state();
      const firstPage = await read('/order/list?page=1&limit=2&paid=1&pay_type=yue');
      const secondPage = await read('/order/list?page=2&limit=2&paid=1&pay_type=yue');
      expect(firstPage.count).toBe(3); expect(secondPage.count).toBe(3);
      const all = [...rows(firstPage.list), ...rows(secondPage.list)];
      expect(all.map(row => row.id)).toEqual([remainder, receipt.selectedOrderId, (await r.receipt(second.refundId)).selectedOrderId].sort((a,b) => b-a));
      expect(all.reduce((n, row) => n + Math.round(Number(row.pay_price)*100), 0)).toBe(5500);
      const rootDetail = await read(`/order/info/${root.id}`);
      expect(rootDetail).toMatchObject({ pid: -1, pay_price: '55.00', total_num: 3 });
      expect(rows(rootDetail.cart_info)).toHaveLength(2);
      for (const row of all) {
        const detail = await read(`/order/info/${row.id}`), carts = rows(detail.cart_info);
        expect(detail).toMatchObject(row); expect(carts).toHaveLength(1);
        expect(typeof carts[0].cartInfo).toBe('string');
        expect(carts[0]).toMatchObject({ oid: row.id, uid: 11, cartNum: 1, relationId: 7 });
        expect(rows((await read(`/order/list?order=${row.order_id}`)).list).map(item => item.id)).toEqual([row.id]);
        expect(detail).not.toHaveProperty('ownerUid'); expect(detail).not.toHaveProperty('tradeNo');
      }
      expect((await read('/order/list?real_name='+encodeURIComponent(root.realName))).count).toBe(3);
      for (const query of ['paid=0', 'status=1', 'pay_type=weixin', 'order=no-such-order'])
        expect(await read(`/order/list?${query}`)).toMatchObject({ list: [], count: 0 });
      expect(await read('/order/list?page=3&limit=2')).toMatchObject({ list: [], count: 3 });
      expect(await f.state()).toEqual(before);
    });
  });

  it('requires actual Supplier JWT, active tenant-bound role and unchanged password; read permission cannot write', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid(), before = await f.state();
      const customer = (await createToken(11, 'api', md5('synthetic-digest'), appKey)).token;
      const admin = (await createToken(990, 'admin', md5('synthetic-digest'), appKey)).token;
      for (const path of ['/order/list', `/order/info/${source.id}`]) for (const sample of [
        { token: '', status: 410000 }, { token: 'invalid', status: 410001 },
        { token: tokens.get(991)!, status: 400011 }, { token: customer, status: 410002 }, { token: admin, status: 410002 },
      ]) {
        const response = await send(path, sample.token);
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(await response.json()).toMatchObject({ status: sample.status, data: null });
      }
      expect(await (await send('/order/list?supplier_id=7', tokens.get(992))).json()).toMatchObject({ status: 200, data: { list: [], count: 0 } });
      expect(await (await send(`/order/info/${source.id}?supplier_id=7`, tokens.get(992))).json()).toMatchObject({ status: 404, data: null });
      expect((await read('/order/list?supplier_id=8')).count).toBe(1);
      const write = await app.request(`/supplierapi/order/remark/${source.id}`, { method: 'PUT',
        headers: { 'Authori-zation': `Bearer ${tokens.get(990)}`, 'Content-Type': 'application/json' }, body: '{"remark":"must not write"}' },
        { ...f.env, NODE_ENV: 'test', APP_KEY: appKey });
      expect(await write.json()).toMatchObject({ status: 400011, data: null });
      for (const update of [{ status: 0 }, { status: 1, relationId: 8 }]) {
        await f.db.update(systemRole).set(update).where(eq(systemRole.id, 990));
        expect(await (await send('/order/list')).json()).toMatchObject({ status: 400011 });
      }
      await f.db.update(systemRole).set({ status: 1, relationId: 7 }).where(eq(systemRole.id, 990));
      await f.db.update(systemAdmin).set({ pwd: 'changed-local-digest' }).where(eq(systemAdmin.id, 990));
      expect(await (await send('/order/list')).json()).toMatchObject({ status: 410001 });
      expect(await f.state()).toEqual(before);
    });
  });

  it('rejects malformed, duplicate and unbounded selectors before starting a business transaction', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid(), before = await f.state();
      const transactions = vi.spyOn(r.container.db, 'transaction');
      for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=10001', 'page=99999999999999999999',
        'limit=0', 'limit=101', 'limit=NaN', 'paid=2', 'status=6', 'page=1&page=2', 'paid=0&paid=1',
        'order='+ 'a'.repeat(257), 'real_name=%00', 'pay_type='+ 'a'.repeat(33)]) {
        expect(await (await send(`/order/list?${query}`)).json()).toMatchObject({ status: 400, data: null });
      }
      for (const id of ['0', '-1', '1e0', '1.1', '2147483648', '99999999999999999999'])
        expect(await (await send(`/order/info/${id}`)).json()).toMatchObject({ status: 400, data: null });
      expect(transactions).not.toHaveBeenCalled(); transactions.mockRestore();
      expect(await read('/order/list?paid=&status=')).toMatchObject({ count: 1, page: 1, limit: 20 });
      expect((await read(`/order/info/${source.id}`)).id).toBe(source.id);
      expect(await f.state()).toEqual(before);
    });
  });

  it('retains staff access after customer deletion, but excludes system-deleted or foreign orders', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, source.id));
      expect((await read('/order/list')).count).toBe(1); expect((await read(`/order/info/${source.id}`)).id).toBe(source.id);
      for (const update of [{ isSystemDel: 1 }, { isSystemDel: 0, supplierId: 8 }]) {
        await f.db.update(storeOrder).set(update).where(eq(storeOrder.id, source.id)); const before = await f.state();
        expect(await read('/order/list')).toMatchObject({ list: [], count: 0 });
        expect(await (await send(`/order/info/${source.id}`)).json()).toMatchObject({ status: 404, data: null });
        expect(await f.state()).toEqual(before);
      }
    });
  });

  it.each(['foreign-tenant', 'store-cart', 'mixed-legacy', 'json', 'array', 'null-json', 'large-cart', 'large-promotions', 'combined-bytes', 'cart-count'] as const)
  ('rejects %s details explicitly instead of leaking, truncating or returning empty success', async fault => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      if (fault === 'foreign-tenant') await f.db.update(storeOrderCartInfo).set({ relationId: 8 }).where(eq(storeOrderCartInfo.oid, source.id));
      if (fault === 'store-cart') await f.db.update(storeOrderCartInfo).set({ type: 1 }).where(eq(storeOrderCartInfo.oid, source.id));
      if (fault === 'mixed-legacy') await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0 }).where(eq(storeOrderCartInfo.productId, 70));
      if (['json', 'array', 'null-json', 'large-cart'].includes(fault)) await f.db.update(storeOrderCartInfo).set({
        cartInfo: fault === 'json' ? '{invalid' : fault === 'array' ? '[]' : fault === 'null-json' ? 'null' : JSON.stringify({ padding: '界'.repeat(22000) }),
      }).where(eq(storeOrderCartInfo.oid, source.id));
      if (fault === 'large-promotions') await f.db.update(storeOrderCartInfo).set({ promotionsId: 'x'.repeat(66000) }).where(eq(storeOrderCartInfo.oid, source.id));
      if (fault === 'combined-bytes') await f.db.update(storeOrderCartInfo).set({ promotionsId: 'x'.repeat(33000), cartInfo: JSON.stringify({ text: 'x'.repeat(33000) }) }).where(eq(storeOrderCartInfo.oid, source.id));
      if (fault === 'cart-count') await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 199 }, (_, i) => ({
        oid: source.id, uid: 11, type: 2, relationId: 7, cartId: String(1000+i), unique: `local-bound-${i}`, cartInfo: '{}',
      })));
      const before = await f.state(), response = await send(`/order/info/${source.id}`);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.json()).toMatchObject({ status: 400, data: null });
      expect(await f.state()).toEqual(before);
    });
  });

  it('preserves all-legacy ownership, explicit type-zero supplier metadata and null/empty snapshots', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      for (const relationId of [7, 0]) for (const cartInfo of [null, '', '{}']) {
        await f.db.update(storeOrderCartInfo).set({ type: 0, relationId, cartInfo }).where(eq(storeOrderCartInfo.oid, source.id));
        const before = await f.state();
        expect(rows((await read(`/order/info/${source.id}`)).cart_info).map(row => row.cartInfo)).toEqual([cartInfo, cartInfo]);
        expect(await f.state()).toEqual(before);
      }
    });
  });

  it('accepts exactly 200 carts and a 64 KiB snapshot while excluding unused private header TEXT', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      const exact = JSON.stringify({ padding: 'x'.repeat(65536-JSON.stringify({ padding: '' }).length) });
      expect(new TextEncoder().encode(exact).length).toBe(65536);
      await f.db.update(storeOrderCartInfo).set({ cartInfo: exact }).where(eq(storeOrderCartInfo.productId, 70));
      await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 198 }, (_, i) => ({
        oid: source.id, uid: 11, type: 2, relationId: 7, cartId: String(1000+i), unique: `local-edge-${i}`, cartInfo: '{}', cartNum: 1,
      })));
      await f.db.update(storeOrder).set({ totalNum: 201, customForm: 'not-part-of-supplier-header'.repeat(20000) }).where(eq(storeOrder.id, source.id));
      const before = await f.state(), statements: string[] = [];
      const actual = PostgresJsSession.prototype.prepareQuery;
      const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
        statements.push(args[0].sql); return actual.apply(this, args);
      });
      let detail: Record<string, unknown>;
      try { detail = await read(`/order/info/${source.id}`); } finally { spy.mockRestore(); }
      const carts = rows(detail.cart_info);
      expect(carts).toHaveLength(200); expect(carts[0].cartInfo).toBe(exact);
      expect(detail).not.toHaveProperty('customForm');
      const headerQuery = statements.find(statement => /^select .* from "store_order" where /s.test(statement));
      expect(headerQuery).toBeDefined(); expect(headerQuery).not.toMatch(/custom_form|virtual_info|trade_no|express_dump/);
      expect(await f.state()).toEqual(before);
    });
  });

  it('uses an independent SELECT-only LOGIN and restores session settings after denied reads', async () => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid();
      await f.withRuntimeRole!(async peer => {
        const container = createContainerFromDb(peer.db); await wire({ ...peer, container });
        await f.exec(`GRANT SELECT ON store_order,store_order_cart_info TO "${peer.role}"`);
        expect(peer.pid).not.toBe(writer.pid);
        const [role] = await peer.db.execute(sql`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
          has_table_privilege(current_user,'store_order','UPDATE') AS can_write,
          (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owned
          FROM pg_roles WHERE rolname=current_user`);
        expect(role).toEqual({ current_user: peer.role, session_user: peer.role, rolsuper: false, rolcreatedb: false,
          rolcreaterole: false, rolbypassrls: false, can_write: false, owned: 0 });
        await peer.exec("SET statement_timeout='0'");
        const restore = afterHeader(async client => {
          const [settings] = await client.unsafe(`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
          expect(settings).toEqual({ readonly: 'on', timeout: '5s' });
        });
        try { expect((await read('/order/list')).count).toBe(1); } finally { restore(); }
        expect((await read(`/order/info/${source.id}`)).id).toBe(source.id);
        const service = new SupplierService(container, f.env);
        const before = await f.state();
        await f.exec(`REVOKE SELECT ON store_order_cart_info FROM "${peer.role}"`);
        await expect(service.orderDetail(7, source.id)).rejects.toMatchObject({ cause: { code: '42501' } });
        await f.exec(`REVOKE SELECT ON store_order FROM "${peer.role}"`);
        await expect(service.orderList(7, {})).rejects.toMatchObject({ cause: { code: '42501' } });
        const [settings] = await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
        expect(settings).toEqual({ readonly: 'off', timeout: '0' }); expect(await f.state()).toEqual(before);
      });
    });
  });
});
