import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import type { Sql } from 'postgres';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { createToken, md5 } from '../src/utils/jwt';
import { storeOrder, storeOrderCartInfo, systemAdmin, systemRole, systemSupplier } from '../src/models/schema';
import { SupplierSplitOrderReadService } from '../src/services/supplier/SupplierSplitOrderReadService';

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
function afterChildren(callback: (client: Sql) => Promise<void>) {
  let reached = false;
  const actual = PostgresJsSession.prototype.prepareQuery;
  const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
    const prepared = actual.apply(this, args);
    if (/from "store_order" where /s.test(args[0].sql) && args[0].sql.includes('order by "store_order"."id" asc')) {
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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier split-order history through actual Hono and PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const appKey = crypto.randomUUID() + crypto.randomUUID();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.insert(systemRole).values({ id: 990, roleName: 'Local split history reader', type: 4,
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
    if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(r.role)) throw Error('Not an isolated role');
    await f.exec(`GRANT SELECT ON system_admin,system_role,system_supplier TO "${r.role}"`);
    wiring.container = r.container;
  }
  async function send(id: number | string, token = tokens.get(990)!) {
    const response = await app.request(`/supplierapi/order/split_order/${id}`, {
      headers: token ? { 'Authori-zation': `Bearer ${token}` } : {},
    }, { ...f.env, NODE_ENV: 'test', APP_KEY: appKey });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    return object(await response.json());
  }
  async function read(id: number) {
    const envelope = await send(id); expect(envelope.status).toBe(200); return rows(envelope.data);
  }

  it('reads history from a retired root after real partial refunds without requiring one pending child', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!;
      for (const stage of [1, 2, 3]) {
        if (stage > 1) { const next = await r.apply(remainder, stage === 3 ? 71 : 70); await r.finish(next.refundId); }
        const before = await f.state(), history = await read(root.id);
        expect(history).toEqual(await read(remainder));
        expect(history).toHaveLength(stage === 1 ? 2 : 3);
        expect(history.some(row => row.id === root.id)).toBe(false);
        expect(history.reduce((sum, row) => sum + Math.round(Number(row.pay_price) * 100), 0)).toBe(5500);
        expect(await f.state()).toEqual(before);
      }
    });
  }, 45_000);

  it('does not pair old child headers with carts from an independently committed second refund', async () => {
    await f.withRuntime(async writer => {
      const root = await writer.createPaid(), first = await writer.apply(root.id); await writer.finish(first.refundId);
      const remainder = (await writer.receipt(first.refundId)).remainingOrderId!, next = await writer.apply(remainder);
      await f.withRuntime(async reader => {
        await wire(reader); expect(reader.pid).not.toBe(writer.pid);
        await reader.exec("SET statement_timeout='3s'");
        const before = await read(remainder); let committed: Awaited<ReturnType<typeof f.state>> | undefined;
        const restore = afterChildren(async client => {
          const [settings] = await client.unsafe(`SELECT current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
          expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '3s' });
          expect(await writer.finish(next.refundId)).toBe('completed'); committed = await f.state();
        });
        try { expect(await read(remainder)).toEqual(before); } finally { restore(); }
        expect(await read(remainder)).not.toEqual(before); expect(await f.state()).toEqual(committed);
      });
    });
  }, 45_000);

  it('excludes sibling headers whose customer or store does not belong to the requested family', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!, expected = await read(remainder);
      const { id: _id, ...template } = await r.order(remainder);
      const invalid = await f.db.insert(storeOrder).values([
        { ...template, orderId: 'wrong-customer-history', unique: 'wrong-customer-history', uid: 22 },
        { ...template, orderId: 'wrong-store-history', unique: 'wrong-store-history', storeId: template.storeId + 1 },
      ]).returning({ id: storeOrder.id });
      const selected = (await r.receipt(first.refundId)).selectedOrderId;
      // Legacy ownership is assessed per order: a legacy historical sibling
      // and a modern remaining sibling may coexist in a valid family.
      await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0 }).where(eq(storeOrderCartInfo.oid, selected));
      const before = await f.state(); expect(await read(remainder)).toEqual(expected);
      for (const row of invalid) expect(await send(row.id)).toMatchObject({ status: 404, data: null });
      expect(await f.state()).toEqual(before);
    });
  });

  it('rejects a cart with a different customer instead of exposing its snapshot', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      await f.db.update(storeOrderCartInfo).set({ uid: 22 }).where(eq(storeOrderCartInfo.oid, source.id));
      const before = await f.state(); expect(await send(source.id)).toMatchObject({ status: 400, data: null });
      expect(await f.state()).toEqual(before);
    });
  });

  it('keeps a platform-owned allocation root and other suppliers private when entered through an owned child', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!, selected = receipt.selectedOrderId;
      await f.db.update(storeOrder).set({ supplierId: 0, supplierAllocationStatus: 2 }).where(eq(storeOrder.id, root.id));
      await f.db.update(storeOrder).set({ supplierId: 8 }).where(eq(storeOrder.id, selected));
      await f.db.update(storeOrderCartInfo).set({ relationId: 8 }).where(eq(storeOrderCartInfo.oid, selected));
      const before = await f.state();
      expect((await read(remainder)).map(row => row.id)).toEqual([remainder]);
      expect(rows((await send(selected, tokens.get(992))).data).map(row => row.id)).toEqual([selected]);
      for (const token of [tokens.get(990), tokens.get(992)]) expect(await send(root.id, token)).toMatchObject({ status: 404, data: null });
      expect(await send(selected)).toMatchObject({ status: 404, data: null });
      expect(await send(remainder, tokens.get(992))).toMatchObject({ status: 404, data: null });
      expect(await f.state()).toEqual(before);
      await f.db.update(storeOrder).set({ supplierAllocationStatus: 1 }).where(eq(storeOrder.id, root.id));
      expect(await send(remainder)).toMatchObject({ status: 404, data: null });
    });
  });

  it('preserves legacy/current cart DTO and customer-deleted history', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      const legacy = { productInfo: { store_name: 'Legacy product', image: 'legacy-test.png', attrInfo: { suk: 'Legacy SKU' } } };
      for (const relationId of [0, 7]) for (const raw of [null, '', '{}', JSON.stringify(legacy)]) {
        await f.db.update(storeOrderCartInfo).set({ type: 0, relationId, cartInfo: raw }).where(eq(storeOrderCartInfo.oid, source.id));
        const before = await f.state(), [order] = await read(source.id), carts = rows(order.cart_info);
        expect(order).toMatchObject({ id: source.id, pid: 0, pay_price: '55.00', total_num: 3 });
        expect(carts).toHaveLength(2);
        expect(carts[0]).toMatchObject({ cart_num: 2, surplus_num: 2, refund_num: 0,
          cart_info: raw ? JSON.parse(raw) : null, product_name: raw === JSON.stringify(legacy) ? 'Legacy product' : '商品快照',
          sku: raw === JSON.stringify(legacy) ? 'Legacy SKU' : 'qared001', image: raw === JSON.stringify(legacy) ? 'legacy-test.png' : '' });
        expect(carts[0]).not.toHaveProperty('uid'); expect(order).not.toHaveProperty('supplierId');
        expect(await f.state()).toEqual(before);
      }
      await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, source.id));
      expect(await read(source.id)).toHaveLength(1);
      await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, source.id));
      expect(await send(source.id)).toMatchObject({ status: 404, data: null });
    });
  });

  it('rejects malformed/oversized snapshots and foreign/mixed/store ownership without silent fallback', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      for (const change of [
        { cartInfo: '{broken' }, { cartInfo: '[]' }, { cartInfo: 'null' }, { cartInfo: 'true' },
        { cartInfo: JSON.stringify({ padding: '界'.repeat(22000) }) },
        { relationId: 8 }, { type: 1 }, { type: 0, relationId: 0 },
      ]) {
        await f.db.update(storeOrderCartInfo).set({ type: 2, relationId: 7, cartInfo: '{}' }).where(eq(storeOrderCartInfo.oid, source.id));
        await f.db.update(storeOrderCartInfo).set(change).where(eq(storeOrderCartInfo.productId, 70));
        const before = await f.state(); expect(await send(source.id)).toMatchObject({ status: 400, data: null });
        expect(await f.state()).toEqual(before);
      }
    });
  });

  it('accepts exactly 200 carts/64 KiB but rejects overflow and never selects unused private TEXT', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      const exact = JSON.stringify({ padding: 'x'.repeat(65536 - JSON.stringify({ padding: '' }).length) });
      expect(new TextEncoder().encode(exact).length).toBe(65536);
      await f.db.update(storeOrderCartInfo).set({ cartInfo: exact, promotionsId: 'unused'.repeat(30000) }).where(eq(storeOrderCartInfo.productId, 70));
      await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 198 }, (_, i) => ({
        oid: source.id, uid: 11, type: 2, relationId: 7, cartId: String(1000 + i), unique: `split-bound-${i}`, cartInfo: '{}',
      })));
      await f.db.update(storeOrder).set({ customForm: 'unused private'.repeat(20000) }).where(eq(storeOrder.id, source.id));
      const before = await f.state(), statements: string[] = [], actual = PostgresJsSession.prototype.prepareQuery;
      const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
        statements.push(args[0].sql); return actual.apply(this, args);
      });
      try {
        const [order] = await read(source.id), carts = rows(order.cart_info);
        expect(carts).toHaveLength(200); expect(carts[0].cart_info).toEqual(JSON.parse(exact));
      } finally { spy.mockRestore(); }
      const businessQueries = statements.filter(statement => /from "store_order(?:_cart_info)?"/.test(statement));
      expect(businessQueries.length).toBeGreaterThanOrEqual(3);
      for (const query of businessQueries) expect(query).not.toMatch(/custom_form|virtual_info|trade_no|express_dump|promotions_id/);
      expect(await f.state()).toEqual(before);
      await f.db.insert(storeOrderCartInfo).values({ oid: source.id, uid: 11, type: 2, relationId: 7, unique: 'overflow' });
      expect(await send(source.id)).toMatchObject({ status: 400, data: null });
    });
  });

  it('accepts exactly 200 scoped child headers and rejects 201 rather than silently truncating', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      const { id: _id, ...template } = await r.order(source.id);
      await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, source.id));
      await f.db.insert(storeOrder).values(Array.from({ length: 200 }, (_, i) => ({
        ...template, pid: source.id, orderId: `split-bound-${i}`, unique: `split-bound-${i}`,
      })));
      const before = await f.state(); expect(await read(source.id)).toHaveLength(200); expect(await f.state()).toEqual(before);
      await f.db.insert(storeOrder).values({ ...template, pid: source.id, orderId: 'split-overflow', unique: 'split-overflow' });
      expect(await send(source.id)).toMatchObject({ status: 400, data: null });
    });
  });

  it('requires actual auth/role and reads through an independent SELECT-only login with bounded restored settings', async () => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid();
      await f.withRuntimeRole!(async peer => {
        const container = createContainerFromDb(peer.db); await wire({ ...peer, container });
        await f.exec(`GRANT SELECT ON store_order,store_order_cart_info TO "${peer.role}"`);
        expect(peer.pid).not.toBe(writer.pid);
        const [role] = await peer.db.execute(sql`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
          has_table_privilege(current_user,'store_order','UPDATE') AS can_write,
          (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owned
          FROM pg_roles WHERE rolname=current_user`);
        expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, can_write: false, owned: 0 });
        await peer.exec("SET statement_timeout='0'");
        const restore = afterChildren(async client => {
          const [settings] = await client.unsafe(`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
          expect(settings).toEqual({ readonly: 'on', timeout: '5s' });
        });
        try { expect(await read(source.id)).toHaveLength(1); } finally { restore(); }
        const before = await f.state();
        const customer = (await createToken(11, 'api', md5('synthetic-digest'), appKey)).token;
        for (const sample of [{ token: '', status: 410000 }, { token: 'invalid', status: 410001 },
          { token: tokens.get(991)!, status: 400011 }, { token: customer, status: 410002 }]) {
          expect(await send(source.id, sample.token)).toMatchObject({ status: sample.status, data: null });
        }
        const service = new SupplierSplitOrderReadService(container), transactions = vi.spyOn(container.db, 'transaction');
        for (const id of [0, -1, 1.5, 2_147_483_648, Number.NaN]) await expect(service.read(7, id)).rejects.toThrow('身份');
        await expect(service.read(0, source.id)).rejects.toThrow('身份');
        expect(transactions).not.toHaveBeenCalled(); transactions.mockRestore();
        await f.exec(`REVOKE SELECT ON store_order_cart_info FROM "${peer.role}"`);
        await expect(service.read(7, source.id)).rejects.toMatchObject({ cause: { code: '42501' } });
        await f.exec(`REVOKE SELECT ON store_order FROM "${peer.role}"`);
        await expect(service.read(7, source.id)).rejects.toMatchObject({ cause: { code: '42501' } });
        const [settings] = await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
        expect(settings).toEqual({ readonly: 'off', timeout: '0' }); expect(await f.state()).toEqual(before);
      });
    });
  });
});
