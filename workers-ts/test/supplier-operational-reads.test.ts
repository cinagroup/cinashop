import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import type { Sql } from 'postgres';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { SupplierOperationalReadService } from '../src/services/supplier/SupplierOperationalReadService';
import { SupplierPickingSheetReadService } from '../src/services/supplier/SupplierPickingSheetReadService';
import { createToken, md5 } from '../src/utils/jwt';
import { storeOrder, storeOrderCartInfo, storeOrderStatus, systemAdmin, systemRole, systemSupplier } from '../src/models/schema';

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
function afterOrder(callback: (client: Sql) => Promise<void>) {
  let reached = false;
  const actual = PostgresJsSession.prototype.prepareQuery;
  const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
    const prepared = actual.apply(this, args);
    if (/^select .* from "store_order" where /s.test(args[0].sql)) {
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
type ReadKind = 'picking' | 'carts' | 'status';
const path = (kind: ReadKind, id: number) => kind === 'picking' ? `/order/distribution_info?ids=${id}`
  : `/order/${kind === 'carts' ? 'split_cart_info' : 'status'}/${id}`;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier picking/cart/status reads through actual Hono and PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const appKey = crypto.randomUUID() + crypto.randomUUID();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.insert(systemRole).values({ id: 990, roleName: 'Local operational reader', type: 4,
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
  async function send(url: string, token = tokens.get(990)!) {
    const response = await app.request(`/supplierapi${url}`, { headers: token ? { 'Authori-zation': `Bearer ${token}` } : {} },
      { ...f.env, NODE_ENV: 'test', APP_KEY: appKey });
    expect(response.headers.get('Cache-Control')).toContain('no-store'); return object(await response.json());
  }
  async function read(kind: ReadKind, id: number) {
    const envelope = await send(path(kind, id)); expect(envelope.status).toBe(200); return envelope.data;
  }

  it('selects the current unrefunded remainder from a retired root after each real refund', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!;
      for (const stage of [1, 2]) {
        if (stage === 2) { const next = await r.apply(remainder); await r.finish(next.refundId); }
        const before = await f.state(), carts = rows(await read('carts', root.id));
        expect(carts).toEqual(await read('carts', remainder)); expect(carts).toHaveLength(stage === 1 ? 2 : 1);
        expect(carts.reduce((sum, cart) => sum + Number(cart.surplus_num), 0)).toBe(stage === 1 ? 2 : 1);
        expect(await f.state()).toEqual(before);
      }
      const last = await r.apply(remainder, 71); await r.finish(last.refundId);
      expect(await read('carts', root.id)).toEqual([]);
      expect(await send(path('carts', receipt.selectedOrderId))).toMatchObject({ status: 400, data: null });
    });
  }, 45_000);

  it('keeps picking headers and items from one generation during a real second refund', async () => {
    await f.withRuntime(async writer => {
      const root = await writer.createPaid(), first = await writer.apply(root.id); await writer.finish(first.refundId);
      const remainder = (await writer.receipt(first.refundId)).remainingOrderId!, next = await writer.apply(remainder);
      await f.withRuntime(async reader => {
        await wire(reader); const before = await read('picking', remainder); let committed: unknown;
        const restore = afterOrder(async () => { expect(await writer.finish(next.refundId)).toBe('completed'); committed = await f.state(); });
        try { expect(await read('picking', remainder)).toEqual(before); } finally { restore(); }
        expect(await read('picking', remainder)).not.toEqual(before); expect(await f.state()).toEqual(committed);
      });
    });
  }, 45_000);

  it('does not read post-refund cart state after selecting a pre-refund active order', async () => {
    await f.withRuntime(async writer => {
      const root = await writer.createPaid();
      await f.withRuntime(async reader => {
        await wire(reader); const before = await read('carts', root.id); let committed: unknown;
        const restore = afterOrder(async () => {
          const application = await writer.apply(root.id); await writer.finish(application.refundId); committed = await f.state();
        });
        try { expect(await read('carts', root.id)).toEqual(before); } finally { restore(); }
        expect(await read('carts', root.id)).not.toEqual(before); expect(await f.state()).toEqual(committed);
      });
    });
  }, 45_000);

  it.each(['picking', 'carts'] as const)('rejects wrong-customer %s snapshots rather than returning them', async kind => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      await f.db.update(storeOrderCartInfo).set({ uid: 22 }).where(eq(storeOrderCartInfo.oid, source.id));
      const before = await f.state(); expect(await send(path(kind, source.id))).toMatchObject({ status: 400, data: null });
      expect(await f.state()).toEqual(before);
    });
  });

  it('does not return status added after an independently committed ownership change', async () => {
    await f.withRuntime(async reader => {
      await wire(reader); const source = await reader.createPaid(), before = await read('status', source.id); let committed: unknown;
      const restore = afterOrder(async () => {
        await f.db.transaction(async tx => {
          await tx.update(storeOrder).set({ supplierId: 8 }).where(eq(storeOrder.id, source.id));
          await tx.insert(storeOrderStatus).values({ oid: source.id, changeType: 'local_tenant_change', changeMessage: 'Other supplier private status', changeTime: 2_000_000_000 });
        }); committed = await f.state();
      });
      try { expect(await read('status', source.id)).toEqual(before); } finally { restore(); }
      expect(await send(path('status', source.id))).toMatchObject({ status: 404, data: null });
      expect(await f.state()).toEqual(committed);
    });
  });

  it('refuses damaged picking snapshots instead of manufacturing a printable fallback', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      await f.db.update(storeOrderCartInfo).set({ cartInfo: '{broken' }).where(eq(storeOrderCartInfo.oid, source.id));
      const before = await f.state(); expect(await send(path('picking', source.id))).toMatchObject({ status: 400, data: null });
      expect(await f.state()).toEqual(before);
    });
  });

  it('can actually ship the scoped remainder selected from a refunded root without changing financial rows', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!;
      const { id: _id, ...template } = await r.order(remainder);
      const invalid = await f.db.insert(storeOrder).values([
        { ...template, uid: 22, orderId: 'wrong-customer-ship', unique: 'wrong-customer-ship' },
        { ...template, storeId: template.storeId + 1, orderId: 'wrong-store-ship', unique: 'wrong-store-ship' },
      ]).returning({ id: storeOrder.id });
      expect(await read('carts', root.id)).toEqual(await read('carts', remainder));
      const before = await f.state();
      for (const row of invalid) {
        expect(await send(path('carts', row.id))).toMatchObject({ status: 404, data: null });
        await expect(new SupplierFulfillmentService(r.container, f.env).deliver(7, row.id, shipping))
          .rejects.toThrow('订单不存在或不属于当前供应商');
        expect(await f.state()).toEqual(before);
      }
      expect(await new SupplierFulfillmentService(r.container, f.env).deliver(7, root.id, shipping))
        .toMatchObject({ order_id: remainder, split: false, idempotent: false });
      expect(await read('carts', root.id)).toEqual([]);
      expect(await r.order(remainder)).toMatchObject({ status: 1, payPrice: '42.20' });
      expect(await r.order(receipt.selectedOrderId)).toMatchObject({ status: 0, refundStatus: 2 });
      for (const row of invalid) expect((await r.order(row.id)).status).toBe(0);
      const after = await f.state();
      for (const [table, state] of Object.entries(before)) if (!['store_order', 'store_order_status', 'store_order_outbox'].includes(table)) {
        expect(after[table], table).toEqual(state);
      }
    });
  }, 45_000);

  it('can split-ship the selected remainder after refund and then ship the remaining family with conserved amounts', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), remainder = receipt.remainingOrderId!;
      const selected = rows(await read('carts', root.id)).find(row => row.product_id === 70)!;
      const before = await f.state(), service = new SupplierFulfillmentService(r.container, f.env);
      const result = await service.splitDelivery(7, root.id, shipping, [{ cartId: String(selected.cart_id), cartNum: 1 }]);
      expect(result).toMatchObject({ split: true, remaining_order_id: remainder });
      expect(await r.order(result.order_id)).toMatchObject({ status: 1, payPrice: '12.80' });
      expect(await r.order(remainder)).toMatchObject({ status: 0, payPrice: '29.40' });
      expect(rows(await read('carts', root.id)).map(row => row.product_id)).toEqual([71]);
      expect(await service.deliver(7, root.id, shipping)).toMatchObject({ order_id: remainder });
      expect(await read('carts', root.id)).toEqual([]);
      const family = await r.db.select({ payPrice: storeOrder.payPrice }).from(storeOrder).where(eq(storeOrder.pid, root.id));
      expect(family.reduce((n, row) => n + Math.round(Number(row.payPrice) * 100), 0)).toBe(5500);
      const after = await f.state();
      for (const table of ['store_order_refund', 'store_order_refund_split', 'store_order_refund_payment', 'user_bill', 'user', 'store_product', 'store_product_attr_value']) {
        expect(after[table], table).toEqual(before[table]);
      }
    });
  }, 45_000);

  it.each(['whole', 'split'] as const)('revalidates child store after reference selection before %s shipment', async mode => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!, [cart] = await r.carts(remainder);
      const service = new SupplierFulfillmentService(r.container, f.env); let committed: unknown;
      const restore = afterOrder(async () => {
        await f.db.update(storeOrder).set({ storeId: 1 }).where(eq(storeOrder.id, remainder));
        committed = await f.state();
      });
      try {
        await expect(mode === 'whole' ? service.deliver(7, remainder, shipping)
          : service.splitDelivery(7, remainder, shipping, [{ cartId: cart.cartId, cartNum: 1 }]))
          .rejects.toThrow('拆分子单不存在或不属于当前供应商');
      } finally { restore(); }
      expect(await f.state()).toEqual(committed);
      expect(await send(path('carts', remainder))).toMatchObject({ status: 404, data: null });
    });
  }, 45_000);

  it('permits an owned child of a completed platform allocation without exposing the platform root', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!;
      await f.db.update(storeOrder).set({ supplierId: 0, supplierAllocationStatus: 1 }).where(eq(storeOrder.id, root.id));
      await f.db.update(storeOrder).set({ storeId: 1 }).where(eq(storeOrder.id, remainder));
      const service = new SupplierFulfillmentService(r.container, f.env), rejected = await f.state();
      expect(await send(path('carts', remainder))).toMatchObject({ status: 404, data: null });
      await expect(service.deliver(7, remainder, shipping)).rejects.toThrow('订单不存在或不属于当前供应商');
      expect(await f.state()).toEqual(rejected);
      await f.db.update(storeOrder).set({ supplierAllocationStatus: 2 }).where(eq(storeOrder.id, root.id));
      const before = await f.state();
      expect(rows(await read('carts', remainder))).toHaveLength(2);
      expect(await send(path('carts', root.id))).toMatchObject({ status: 404, data: null });
      await expect(service.deliver(7, root.id, shipping)).rejects.toThrow('订单不存在或不属于当前供应商');
      expect(await f.state()).toEqual(before);
      expect(await service.deliver(7, remainder, shipping)).toMatchObject({ order_id: remainder, split: false });
      expect(await r.order(remainder)).toMatchObject({ status: 1, payPrice: '42.20', storeId: 1 });
      const after = await f.state();
      for (const [table, state] of Object.entries(before)) if (!['store_order', 'store_order_status', 'store_order_outbox'].includes(table)) {
        expect(after[table], table).toEqual(state);
      }
    });
  }, 45_000);

  it('rejects ambiguous pending siblings and a real open refund even if the summary is incorrectly clear', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const remainder = (await r.receipt(first.refundId)).remainingOrderId!, next = await r.apply(remainder);
      await f.db.update(storeOrder).set({ refundStatus: 0 }).where(eq(storeOrder.id, remainder));
      const before = await f.state();
      expect(await send(path('carts', root.id))).toMatchObject({ status: 400, data: null });
      await expect(new SupplierFulfillmentService(r.container, f.env).deliver(7, root.id, shipping)).rejects.toThrow('进行中的售后');
      expect(await f.state()).toEqual(before);
      await f.db.update(storeOrder).set({ refundStatus: 1 }).where(eq(storeOrder.id, remainder)); await r.finish(next.refundId);
      const { id: _id, ...template } = await r.order(remainder);
      await f.db.insert(storeOrder).values({ ...template, orderId: 'ambiguous-pending', unique: 'ambiguous-pending' });
      const ambiguous = await f.state();
      expect(await send(path('carts', root.id))).toMatchObject({ status: 400, data: null });
      await expect(new SupplierFulfillmentService(r.container, f.env).deliver(7, root.id, shipping)).rejects.toThrow('多个待发货');
      expect(await f.state()).toEqual(ambiguous);
    });
  }, 45_000);

  it.each(['picking', 'carts'] as const)('rejects malformed, foreign or mixed %s data and count overflow as a whole', async kind => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      for (const change of [{ relationId: 8 }, { type: 1 }, { type: 0, relationId: 0 },
        { cartInfo: '{broken' }, { cartInfo: '[]' }, { cartInfo: 'null' },
        { cartInfo: JSON.stringify({ padding: '界'.repeat(kind === 'picking' ? 88000 : 22000) }) }]) {
        await f.db.update(storeOrderCartInfo).set({ type: 2, relationId: 7, cartInfo: '{"sum_price":"1.00"}' }).where(eq(storeOrderCartInfo.oid, source.id));
        await f.db.update(storeOrderCartInfo).set(change).where(eq(storeOrderCartInfo.productId, 70));
        const before = await f.state(); expect(await send(path(kind, source.id))).toMatchObject({ status: 400, data: null });
        expect(await f.state()).toEqual(before);
      }
      await f.db.update(storeOrderCartInfo).set({ type: 2, relationId: 7, cartInfo: '{"sum_price":"1.00"}' }).where(eq(storeOrderCartInfo.oid, source.id));
      await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 198 }, (_, i) => ({ oid: source.id, uid: 11,
        type: 2, relationId: 7, cartId: String(i + 1000), unique: `op-count-${i}`, cartNum: 1, splitSurplusNum: 1, cartInfo: '{"sum_price":"1.00"}' })));
      const data = await read(kind, source.id);
      expect(kind === 'carts' ? rows(data) : rows(rows(object(data).list)[0].items)).toHaveLength(200);
      await f.db.insert(storeOrderCartInfo).values({ oid: source.id, uid: 11, type: 2, relationId: 7,
        cartId: 'extra', unique: 'op-overflow', cartNum: 1, splitSurplusNum: 1, cartInfo: '{"sum_price":"1.00"}' });
      expect(await send(path(kind, source.id))).toMatchObject({ status: 400, data: null });
    });
  }, 45_000);

  it('preserves picking batch order and exact monetary/legacy quantities without exposing private fields', async () => {
    await f.withRuntime(async r => {
      await wire(r); const root = await r.createPaid(), first = await r.apply(root.id); await r.finish(first.refundId);
      const receipt = await r.receipt(first.refundId), ids = [receipt.remainingOrderId!, receipt.selectedOrderId, root.id];
      const response = await send(`/order/distribution_info?ids=${ids.join(',')}`);
      expect(response.status).toBe(200); expect(rows(object(response.data).list).map(row => row.id)).toEqual(ids);
      const exact = JSON.stringify({ sum_price: '0.29', vip_truePrice: '0.07', cart_num: '3', productInfo: { store_name: '旧快照', attrInfo: { suk: '规格' } } });
      await f.db.update(storeOrderCartInfo).set({ cartInfo: exact, cartNum: 0, type: 0, relationId: 0 }).where(eq(storeOrderCartInfo.oid, ids[1]));
      const before = await f.state(), [order] = rows(object(await read('picking', ids[1])).list);
      expect(order).toMatchObject({ vip_true_price: '0.21' });
      expect(rows(order.items)[0]).toMatchObject({ product_name: '旧快照', sku: '规格', quantity: 3, unit_price: '0.29', subtotal: '0.87' });
      expect(order).not.toHaveProperty('uid'); expect(order).not.toHaveProperty('trade_no'); expect(await f.state()).toEqual(before);
      for (const raw of [null, '', '{}', '{"sum_price":true}', '{"sum_price":"NaN"}', '{"sum_price":"-1"}']) {
        await f.db.update(storeOrderCartInfo).set({ cartInfo: raw, cartNum: 1 }).where(eq(storeOrderCartInfo.oid, ids[1]));
        expect(await send(path('picking', ids[1]))).toMatchObject({ status: 400, data: null });
      }
      await f.db.update(storeOrder).set({ supplierId: 8 }).where(eq(storeOrder.id, ids[1]));
      expect(await send(`/order/distribution_info?ids=${ids[0]},${ids[1]}`)).toMatchObject({ status: 404, data: null });
    });
  });

  it('caps combined cart bytes before SQL transport while accepting an exact 256 KiB picking snapshot', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      const max = 256 * 1024, exact = JSON.stringify({ sum_price: '1.00', padding: 'x'.repeat(max - JSON.stringify({ sum_price: '1.00', padding: '' }).length) });
      expect(new TextEncoder().encode(exact).length).toBe(max);
      await f.db.update(storeOrderCartInfo).set({ cartInfo: exact, promotionsId: 'unneeded'.repeat(50000) }).where(eq(storeOrderCartInfo.oid, source.id));
      expect(rows(object(await read('picking', source.id)).list)).toHaveLength(1);
      await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 31 }, (_, i) => ({ oid: source.id, uid: 11,
        type: 2, relationId: 7, unique: `op-byte-${i}`, cartId: String(1000 + i), cartNum: 1, cartInfo: exact })));
      let boundedRows = false;
      const actual = PostgresJsSession.prototype.prepareQuery;
      const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
        const prepared = actual.apply(this, args);
        if (/from "store_order_cart_info"/.test(args[0].sql)) {
          expect(args[0].sql).not.toContain('promotions_id');
          const execute = prepared.execute.bind(prepared);
          prepared.execute = async values => {
            const result = await execute(values); boundedRows = true;
            expect(rows(result).every(row => row.cartInfo === null && row.oversized === true)).toBe(true);
            return result;
          };
        }
        return prepared;
      });
      try { expect(await send(path('picking', source.id))).toMatchObject({ status: 400, data: null }); }
      finally { spy.mockRestore(); }
      expect(boundedRows).toBe(true);
    });
  });

  it('keeps status DTO and deterministic ordering at 500 rows, rejects overflow, and retains customer-deleted history', async () => {
    await f.withRuntime(async r => {
      await wire(r); const source = await r.createPaid();
      const existing = rows(await read('status', source.id));
      await f.db.insert(storeOrderStatus).values(Array.from({ length: 500 - existing.length }, (_, i) => ({
        oid: source.id, changeType: 'local_history', changeMessage: `Record ${i}`, changeTime: 1234,
      })));
      await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, source.id));
      const before = await f.state(), logs = rows(await read('status', source.id));
      expect(logs).toHaveLength(500);
      expect(logs[0]).toMatchObject({ oid: source.id, changeType: 'local_history', changeTime: 1234 });
      expect(logs.slice(0, -1).map(row => row.id)).toEqual(logs.slice(0, -1).map(row => Number(row.id)).sort((a, b) => b - a));
      expect(await f.state()).toEqual(before);
      await f.db.insert(storeOrderStatus).values({ oid: source.id, changeType: 'overflow' });
      expect(await send(path('status', source.id))).toMatchObject({ status: 400, data: null });
      await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, source.id));
      expect(await send(path('status', source.id))).toMatchObject({ status: 404, data: null });
    });
  });

  it.each(['picking', 'carts', 'status'] as const)('%s uses actual auth and an independent minimum SELECT-only role with local restored settings', async kind => {
    await f.withRuntime(async writer => {
      const source = await writer.createPaid();
      await f.withRuntimeRole!(async peer => {
        const container = createContainerFromDb(peer.db); await wire({ ...peer, container });
        const tables = kind === 'status' ? 'store_order,store_order_status'
          : kind === 'carts' ? 'store_order,store_order_cart_info,store_order_refund' : 'store_order,store_order_cart_info';
        await f.exec(`GRANT SELECT ON ${tables} TO "${peer.role}"`);
        expect(peer.pid).not.toBe(writer.pid);
        const [role] = await peer.db.execute(sql`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
          has_table_privilege(current_user,'store_order','UPDATE') AS can_write,
          (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owned
          FROM pg_roles WHERE rolname=current_user`);
        expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, can_write: false, owned: 0 });
        for (const timeout of ['0', '3s']) {
          await peer.exec(`SET statement_timeout='${timeout}'`);
          const restore = afterOrder(async client => {
            const [settings] = await client.unsafe(`SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
            expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: timeout === '0' ? '5s' : '3s' });
          });
          try { await read(kind, source.id); } finally { restore(); }
        }
        const before = await f.state();
        for (const sample of [{ token: '', status: 410000 }, { token: 'invalid', status: 410001 },
          { token: tokens.get(991)!, status: 400011 }, { token: tokens.get(992)!, status: 404 }]) {
          expect(await send(path(kind, source.id), sample.token)).toMatchObject({ status: sample.status, data: null });
        }
        const service = new SupplierOperationalReadService(container), picking = new SupplierPickingSheetReadService(container);
        const call = (id: number) => kind === 'picking' ? picking.read(7, [id]) : kind === 'carts' ? service.splitCartInfo(7, id) : service.statusLogs(7, id);
        const transactions = vi.spyOn(container.db, 'transaction');
        for (const id of [0, -1, 1.5, 2_147_483_648, Number.NaN]) await expect(call(id)).rejects.toThrow();
        if (kind === 'picking') for (const ids of [[], [source.id, source.id], Array.from({ length: 11 }, (_, i) => i + 1)]) await expect(picking.read(7, ids)).rejects.toThrow();
        expect(transactions).not.toHaveBeenCalled(); transactions.mockRestore();
        const revoke = kind === 'status' ? 'store_order_status' : 'store_order_cart_info';
        await f.exec(`REVOKE SELECT ON ${revoke} FROM "${peer.role}"`);
        await expect(call(source.id)).rejects.toMatchObject({ cause: { code: '42501' } });
        const [settings] = await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
        expect(settings).toEqual({ readonly: 'off', timeout: '3s' }); expect(await f.state()).toEqual(before);
      });
    });
  });
});
