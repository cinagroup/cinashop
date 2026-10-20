/** First group: mounted Admin/JWT and an explicitly synthetic-principal public
 * catalogue. Second group: actual full App/JWT, registered PG and LOGIN author.
 * All fixtures are owned; neither group claims production/provider authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, storeSeckill, systemRole, user, userBill } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { ApiException } from '@/utils/errors';
import { assertCurrentSeckillBaseSkuIdentity } from '@/services/activity/ActivityOrderSkuService';
import { activityEdit } from './helpers/seckillActivityFixture';
import { seckillShortSkuRuntimeFixture } from './helpers/seckillShortSkuRuntime';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { seckillShortAdminFixture, seckillShortAdminInput,
  seckillShortPublicFixture, seckillShortUnique } from './helpers/seckillShortSku';

const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>(), opened: 0, closed: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: (env: object) => {
    const container = wiring.containers.get(env); if (!container) throw Error('Owned seckill App SQL missing'); return container;
  },
  createAdminDatabaseSession: (env: object) => {
    const container = wiring.containers.get(env); if (!container) throw Error('Owned seckill Admin SQL missing');
    wiring.opened++; return { container, close: async () => { wiring.closed++; } };
  },
}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Seckill short base SKU mounted HTTP on owned PG16', () => {
  let close: (() => Promise<void>) | undefined;
  beforeEach(() => {
    close = undefined;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned seckill short-SKU reds forbid provider dispatch'));
  });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { try { await close?.(); } finally { vi.restoreAllMocks(); } }
  }, 30_000);
  const paddedIdentity = { raw_unique: 'short7  ', storage_type: 'character', bytes: 8 };

  it('reads a canonical valid short base SKU through actual Admin seckill source options', async () => {
    const f = await seckillShortAdminFixture(); close = f.close;
    expect(await f.rawIdentity()).toEqual(paddedIdentity);
    const before = await f.publicSnapshot(), sequences = await f.publicSequences();
    const { response, body } = await f.request('/products/101');
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    // Read-only proof is checked before the expected pre-fix identity failure.
    expect(await f.publicSnapshot()).toEqual(before);
    expect(await f.publicSequences()).toEqual(sequences);
    expect(body.data).toMatchObject({ product_id: 101, valid: true, issues: [] });
    expect(body.data.skus.find((row: { base_sku_id: number }) => row.base_sku_id === 11))
      .toMatchObject({ base_unique: seckillShortUnique, price: '18.88', valid: true, issues: [] });
  }, 120_000);

  it('saves an actual Admin seckill activity from a canonical short base SKU', async () => {
    const f = await seckillShortAdminFixture(); close = f.close;
    expect(await f.rawIdentity()).toEqual(paddedIdentity);
    const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 11));
    const { response, body } = await f.request('', { method: 'POST', body: seckillShortAdminInput() });
    expect(response.status).toBe(200);
    // Saving an activity must not rewrite the original selected base row.
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 11)))[0]).toEqual(base);
    expect(body.status, body.msg).toBe(200);
    const after = await f.snapshot();
    expect(after.parents).toHaveLength(1); expect(after.children).toHaveLength(1);
    expect(after.parents[0].id).toBe(body.data.id);
    expect(after.children[0]).toMatchObject({ activityId: body.data.id, productId: 101, status: 1 });
    const skus = after.skus.filter(row => row.productId === after.children[0].id && row.type === 1);
    expect(skus).toHaveLength(1);
    expect(skus[0]).toMatchObject({ suk: base.suk, price: '6.25', stock: 5, quota: 5, quotaShow: 5, isRetired: 0 });
    expect(skus[0].unique).toMatch(/^[a-f0-9]{8}$/);
    expect(skus[0].unique).not.toBe(seckillShortUnique);
    expect(after.logs).toHaveLength(1);
  }, 120_000);

  it('reads a public seckill catalogue with a short base mapped to an independently bootstrapped eight-character activity key', async () => {
    const f = await seckillShortPublicFixture(); close = f.close;
    expect(await f.rawIdentity()).toEqual(paddedIdentity);
    const [activity] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 3));
    expect(activity).toMatchObject({ productId: 20, type: 1, unique: 'actred20', price: '6.25' });
    const before = await f.publicSnapshot(), sequences = await f.publicSequences();
    // Anonymous public read on the existing synthetic-principal fixture app.
    const response = await f.app.request('/api/seckill/detail/20?view=skus', {}, f.env);
    const body = await response.json<{ status: number; msg: string; data: {
      selection_only: boolean; type: number; seckill_id: number; product_id: number;
      skus: Array<{ unique: string; base_unique: string; catalog_price: string }> } | null }>();
    expect(response.status).toBe(200);
    expect(await f.publicSnapshot()).toEqual(before);
    expect(await f.publicSequences()).toEqual(sequences);
    expect(body.status, body.msg).toBe(200);
    expect(body.data).toMatchObject({ selection_only: true, type: 1, seckill_id: 20, product_id: 70 });
    expect(body.data!.skus.find(row => row.unique === 'actred20'))
      .toMatchObject({ unique: 'actred20', base_unique: seckillShortUnique, catalog_price: '6.25' });
  }, 120_000);
});

/** Complete runAll185/actual createApp/JWT fixture. Admin/customer HTTP uses
 * owned maintenance SQL; only strict create/replay run on the verified LOGIN. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Seckill short base SKU complete App/JWT and independent LOGIN', () => {
  type Fixture = Awaited<ReturnType<typeof seckillShortSkuRuntimeFixture>>;
  const app = createApp();
  let f: Fixture | undefined;
  beforeEach(() => {
    f = undefined; wiring.opened = 0; wiring.closed = 0;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned seckill full-chain forbids provider dispatch'));
  });
  afterEach(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled(); expect(wiring.opened).toBe(wiring.closed);
      if (f) { expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]); }
    } finally { try { await f?.close(); } finally { vi.restoreAllMocks(); } }
  }, 30_000);
  function fixture() { if (!f) throw Error('Owned full seckill fixture missing'); return f; }
  async function request(path: string, body?: object, admin = false, method = body ? 'POST' : 'GET') {
    const f = fixture(), env: Env = { ...f.env }; wiring.containers.set(env, f.container);
    const response = await app.request(path, { method, headers: { Authorization: 'Bearer ' + (admin ? f.adminToken : f.token),
      'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  async function unchanged(before: Awaited<ReturnType<Fixture['snapshot']>>, sequences: Awaited<ReturnType<Fixture['sequences']>>) {
    expect(Object.keys(before)).toHaveLength(283); expect(sequences).toHaveLength(229);
    expect(await fixture().snapshot()).toEqual(before); expect(await fixture().sequences()).toEqual(sequences);
  }
  type Writer = Parameters<Parameters<Fixture['withSeckillRuntime']>[0]>[0];
  type Selection = { parentId: number; childId: number; selected: any; detail: any };
  async function campaign(): Promise<Selection> {
    f = await seckillShortSkuRuntimeFixture();
    const saved = await request('/adminapi/activity/seckill-activities', f.adminInput(), true);
    expect(saved.body.status, saved.body.msg).toBe(200);
    const detail = await request('/adminapi/activity/seckill-activities/' + saved.body.data.id, undefined, true);
    expect(detail.body.status, detail.body.msg).toBe(200);
    const child = detail.body.data.products[0];
    return { parentId: saved.body.data.id, childId: child.child_id, selected: child.skus[0], detail: detail.body.data };
  }
  function addInput(selection: Selection) {
    return { productId: 70, activityId: selection.childId, type: 1,
      unique: selection.selected.unique, cartNum: 1, new: 1 };
  }
  async function added(selection: Selection) {
    const response = await request('/api/cart/add', addInput(selection));
    expect(response.body.status, response.body.msg).toBe(200); return response.body.data.cartId as number;
  }
  function quoteInput(selection: Selection, id: number) {
    return { cartIds: [id], addressId: 11, useIntegral: false, type: 1, seckillId: selection.childId };
  }
  async function quoted(selection: Selection, id: number) {
    const before = await fixture().snapshot(), sequences = await fixture().sequences();
    const response = await request('/api/order/confirm', quoteInput(selection, id));
    expect(response.body.status, response.body.msg).toBe(200);
    expect(response.body.data.priceGroup).toMatchObject({ total_price: '6.25', pay_price: '6.25', pay_postage: '0.00' });
    await unchanged(before, sequences); return response.body.data;
  }
  function strictCreate(writer: Writer, selection: Selection, id: number, receipt: any,
    nextOrderId = async () => 'owned_seckill_boundary') {
    return StoreOrderCreateService.createWithRuntime(writer.container,
      { CONFIG_KV: fixture().env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId },
      { uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, cartIds: [id], addressId: 11,
        type: 1, seckillId: selection.childId, userIp: '127.0.0.1', useIntegral: false });
  }
  async function rejected(path: string, body: object | undefined, message: RegExp, admin = false, method = body ? 'POST' : 'GET') {
    const before = await fixture().snapshot(), sequences = await fixture().sequences();
    const response = await request(path, body, admin, method);
    expect(response.response.status).toBeLessThan(500);
    expect(response.body.status, response.body.msg).toBe(400); expect(response.body.msg).toMatch(message);
    await unchanged(before, sequences);
  }
  async function orderSequenceOnly(before: Awaited<ReturnType<Fixture['sequences']>>) {
    const after = await fixture().sequences(); expect(before).toHaveLength(229); expect(after).toHaveLength(229);
    for (const entry of before) if (entry.name !== 'store_order_id_seq') expect(after.find(row => row.name === entry.name), entry.name).toEqual(entry);
  }
  it.each(['x', 'short7', 'qared001'])(
    'completes %s actual Admin catalogue, buyer checkout, raw-compatible LOGIN receipts, replay and once-only cancellation', async unique => {
      f = await seckillShortSkuRuntimeFixture({ unique });
      const rawUnique = unique.padEnd(8, ' ');
      const [raw] = await f.db.execute(sql`SELECT "unique" AS raw_unique,pg_typeof("unique")::text AS storage_type,
        octet_length("unique") AS bytes FROM public.store_product_attr_value WHERE id=1`);
      expect(raw).toEqual({ raw_unique: rawUnique, storage_type: 'character', bytes: 8 });
      const sourceBefore = await f.snapshot(), sourceSequences = await f.sequences();
      const source = await request('/adminapi/activity/seckill-activities/products/70', undefined, true);
      expect(source.body.status, source.body.msg).toBe(200);
      expect(source.body.data.skus).toEqual([expect.objectContaining({ base_sku_id: 1, base_unique: unique, price: '18.88', valid: true })]);
      await unchanged(sourceBefore, sourceSequences);
      const saved = await request('/adminapi/activity/seckill-activities', f.adminInput(), true);
      expect(saved.body.status, saved.body.msg).toBe(200);
      const parentId = saved.body.data.id;
      const beforeRead = await f.snapshot(), readSequences = await f.sequences();
      const firstRead = await request('/adminapi/activity/seckill-activities/' + parentId, undefined, true);
      expect(firstRead.body.status, firstRead.body.msg).toBe(200);
      const detail = firstRead.body.data, child = detail.products[0], selected = child.skus[0];
      expect(selected).toMatchObject({ base_unique: unique, price: '6.25', valid: true });
      expect(selected.unique).toMatch(/^[a-f0-9]{8}$/);
      await unchanged(beforeRead, readSequences);
      const resaved = await request('/adminapi/activity/seckill-activities/' + parentId, activityEdit(detail), true, 'PUT');
      expect(resaved.body.status, resaved.body.msg).toBe(200);
      const reread = await request('/adminapi/activity/seckill-activities/' + parentId, undefined, true);
      expect(reread.body.status, reread.body.msg).toBe(200);
      expect(reread.body.data.products[0].skus[0]).toMatchObject({ id: selected.id, unique: selected.unique, base_unique: unique });
      const childId = child.child_id, beforeCatalogue = await f.snapshot(), catalogueSequences = await f.sequences();
      const catalogue = await request('/api/seckill/detail/' + childId + '?view=skus');
      expect(catalogue.body.status, catalogue.body.msg).toBe(200);
      expect(catalogue.body.data.skus).toEqual([expect.objectContaining({ unique: selected.unique, base_unique: unique, catalog_price: '6.25' })]);
      await unchanged(beforeCatalogue, catalogueSequences);
      const added = await request('/api/cart/add', { productId: 70, activityId: childId, type: 1,
        unique: selected.unique, cartNum: 1, new: 1 });
      expect(added.body.status, added.body.msg).toBe(200); const cartId = added.body.data.cartId;
      expect(cartId).toBeGreaterThan(2);
      expect((await f.db.select().from(storeCart).where(eq(storeCart.id, cartId)))[0])
        .toMatchObject({ uid: 11, productId: 70, activityId: childId, type: 1, productAttrUnique: rawUnique, cartNum: 1, isNew: 1, isPay: 0 });
      const changed = await request('/api/cart/num', { id: cartId, cartNum: 2 });
      expect(changed.body.status, changed.body.msg).toBe(200);
      const beforeList = await f.snapshot(), listSequences = await f.sequences();
      const list = await request('/api/cart/list?scope=buy&ids=' + cartId);
      expect(list.body.status, list.body.msg).toBe(200);
      expect(list.body.data).toEqual([expect.objectContaining({ id: cartId, cartNum: 2, isValid: true, truePrice: '6.25' })]);
      await unchanged(beforeList, listSequences);
      const beforeQuote = await f.snapshot(), quoteSequences = await f.sequences();
      const quoted = await request('/api/order/confirm', { cartIds: [cartId], addressId: 11, useIntegral: false, type: 1, seckillId: childId });
      expect(quoted.body.status, quoted.body.msg).toBe(200);
      const receipt = quoted.body.data;
      expect(receipt.priceGroup).toMatchObject({ total_price: '12.50', pay_price: '12.50', pay_postage: '0.00' });
      expect(receipt.orderKey).toBeTruthy(); expect(receipt.quoteToken).toBeTruthy();
      await unchanged(beforeQuote, quoteSequences);
      const [beforeProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
      const [beforeBase] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      const [beforeActivity] = await f.db.select().from(storeSeckill).where(eq(storeSeckill.id, childId));
      const [beforeActivitySku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selected.id));
      const [beforeUser] = await f.db.select().from(user).where(eq(user.uid, 11));
      const nextOrderId = vi.fn(async () => 'owned_seckill_short_' + unique);
      let created: { orderId: string } | undefined;
      await f.withSeckillRuntime(async writer => {
        const create = () => StoreOrderCreateService.createWithRuntime(writer.container,
          { CONFIG_KV: fixture().env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId },
          { uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, cartIds: [cartId], addressId: 11,
            type: 1, seckillId: childId, userIp: '127.0.0.1', useIntegral: false });
        if (unique === 'short7') {
          await fixture().withPeer!(async holder => {
            const [observer] = await fixture().db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            expect(new Set([observer.pid, holder.pid, writer.pid]).size).toBe(3);
            await holder.exec('BEGIN');
            try {
              await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
              const pending = outcome(create()); await waitForFinanceBlock(fixture().db, writer.pid, holder.pid);
              await holder.db.execute(sql`SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT`);
              await holder.exec('COMMIT'); const result = await pending;
              if (!result.ok) throw result.error; created = result.value;
            } finally { await holder.exec('ROLLBACK'); }
          });
        } else created = await create();
        const afterCreate = await fixture().snapshot(), afterCreateSequences = await fixture().sequences();
        const writes = [...fixture().kvWrites], deletes = [...fixture().kvDeletes];
        expect(await create()).toEqual(created); expect(nextOrderId).toHaveBeenCalledTimes(1);
        await unchanged(afterCreate, afterCreateSequences);
        expect(fixture().kvWrites).toEqual(writes); expect(fixture().kvDeletes).toEqual(deletes);
      });
      expect(created).toBeDefined();
      const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created!.orderId));
      expect(root).toMatchObject({ uid: 11, type: 1, activityId: childId, totalNum: 2, totalPrice: '12.50', payPrice: '12.50', paid: 0, pid: 0, cartId: String(cartId) });
      const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id));
      expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({ productId: 70, cartId: String(cartId), cartNum: 2, skuUnique: rawUnique });
      expect(JSON.parse(lines[0].cartInfo!)).toMatchObject({ financial_version: 'checkout-line-finance-v1',
        sku: { id: 1, unique: rawUnique, price: '6.25' }, activitySku: { id: selected.id, unique: selected.unique, price: '6.25' } });
      const charged = { rowId: lines[0].id, cartId: String(cartId), productId: 70, skuId: 1, skuUnique: rawUnique, quantity: 2, usedPoints: 0 };
      const [origin] = await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`);
      const [physical] = await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`);
      expect(origin).toMatchObject({ version: 'purchase-origin-v1', order_type: 1, buyer_id: 11, total_num: 2, lines: [charged] });
      expect(physical).toMatchObject({ version: 'purchase-physical-origin-v1', order_type: 1, buyer_id: 11, total_num: 2, lines: [{ ...charged, kind: 'charged', gift: null }] });
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toEqual({ ...beforeProduct, stock: beforeProduct.stock - 2, sales: beforeProduct.sales + 2 });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual({ ...beforeBase, stock: beforeBase.stock - 2, sales: beforeBase.sales + 2 });
      expect((await f.db.select().from(storeSeckill).where(eq(storeSeckill.id, childId)))[0]).toEqual({ ...beforeActivity, stock: beforeActivity.stock - 2, quota: beforeActivity.quota - 2, sales: beforeActivity.sales + 2 });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selected.id)))[0]).toEqual({ ...beforeActivitySku, stock: beforeActivitySku.stock - 2, quota: beforeActivitySku.quota - 2, sales: beforeActivitySku.sales + 2 });
      const canceled = await request('/api/order/cancel', { order_id: root.orderId }); expect(canceled.body.status, canceled.body.msg).toBe(200);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toEqual(beforeProduct);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(beforeBase);
      expect((await f.db.select().from(storeSeckill).where(eq(storeSeckill.id, childId)))[0]).toEqual(beforeActivity);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selected.id)))[0]).toEqual(beforeActivitySku);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toEqual(beforeUser);
      expect(await f.db.select().from(userBill)).toEqual([]);
      expect(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id))).toEqual(lines);
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`))[0]).toEqual(origin);
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`))[0]).toEqual(physical);
      const afterCancel = await f.snapshot(), cancelSequences = await f.sequences();
      const again = await request('/api/order/cancel', { order_id: root.orderId });
      expect(again.body.status).toBe(400); expect(again.body.msg).toMatch(/订单状态不允许取消/);
      await unchanged(afterCancel, cancelSequences);
    }, 120_000);

  it.each(['base unique', 'base SUK'] as const)(
    'rejects a late duplicate %s after a proven base-SKU wait in genuine LOGIN create', async mode => {
      f = await seckillShortSkuRuntimeFixture();
      const saved = await request('/adminapi/activity/seckill-activities', f.adminInput(), true);
      expect(saved.body.status, saved.body.msg).toBe(200);
      const detail = await request('/adminapi/activity/seckill-activities/' + saved.body.data.id, undefined, true);
      expect(detail.body.status, detail.body.msg).toBe(200);
      const child = detail.body.data.products[0], selected = child.skus[0], childId = child.child_id;
      const added = await request('/api/cart/add', { productId: 70, activityId: childId, type: 1,
        unique: selected.unique, cartNum: 1, new: 1 });
      expect(added.body.status, added.body.msg).toBe(200); const cartId = added.body.data.cartId;
      const quoted = await request('/api/order/confirm', { cartIds: [cartId], addressId: 11,
        useIntegral: false, type: 1, seckillId: childId });
      expect(quoted.body.status, quoted.body.msg).toBe(200); const receipt = quoted.body.data;
      const before = await f.snapshot(), sequences = await f.sequences();
      const skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
      const base = skus.find(row => row.id === 1)!;
      const duplicate = { ...base, id: 900,
        unique: mode === 'base unique' ? base.unique : 'DUPKEY01',
        suk: mode === 'base SUK' ? base.suk : 'Owned different combination' };
      await f.withSeckillRuntime(async writer => fixture().withPeer!(async holder => {
        const [observer] = await fixture().db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        expect(new Set([observer.pid, holder.pid, writer.pid]).size).toBe(3);
        await holder.exec('BEGIN');
        try {
          await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
          // This insertion is invisible to the initial quote/read until the
          // holder commits after the real writer has reached the locked SKU.
          await holder.db.insert(storeProductAttrValue).values(duplicate);
          const pending = outcome(StoreOrderCreateService.createWithRuntime(writer.container,
            { CONFIG_KV: fixture().env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true,
              nextOrderId: async () => 'owned_late_seckill_' + (mode === 'base unique' ? 'unique' : 'suk') },
            { uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, cartIds: [cartId], addressId: 11,
              type: 1, seckillId: childId, userIp: '127.0.0.1', useIntegral: false }));
          await waitForFinanceBlock(fixture().db, writer.pid, holder.pid);
          await holder.exec('COMMIT');
          const result = await pending;
          const after = await fixture().snapshot(), afterSequences = await fixture().sequences();
          const changedTables = Object.keys(before).filter(table => JSON.stringify(after[table]) !== JSON.stringify(before[table]));
          const changedSequences = sequences.filter(entry => JSON.stringify(afterSequences.find(row => row.name === entry.name)) !== JSON.stringify(entry)).map(row => row.name);
          // Preserve a small real-gate observation even when the intended
          // exact-one contract is still red. Never print credentials/tokens or
          // substitute a SQL/permission exception for a business rejection.
          process.stdout.write('SECKILL_SHORT_SKU_BASE_WAIT_OBSERVED ' + JSON.stringify({ mode,
            observer_pid: observer.pid, writer_pid: writer.pid, holder_pid: holder.pid,
            actual_blocking_gate_passed: true, holder_committed_duplicate: true, create_succeeded: result.ok,
            error_name: result.ok ? null : result.error.name, changed_tables: changedTables,
            changed_sequences: changedSequences, order_rows: (after.store_order as unknown[]).length,
            origin_rows: (after.store_order_purchase_origin as unknown[]).length,
            physical_rows: (after.store_order_purchase_physical_origin as unknown[]).length }) + '\n');
          expect(result.ok).toBe(false);
          if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/规格|身份|重复|唯一|变化/); }
          expect(changedTables).toEqual(['store_product_attr_value']);
          // PostgreSQL can consume the attempted order sequence before rolling
          // back. Capture it; never claim that nextval is transactional.
          expect(changedSequences.every(name => name === 'store_order_id_seq')).toBe(true);
        } finally { await holder.exec('ROLLBACK'); }
      }));
      const after = await f.snapshot();
      for (const table of Object.keys(before)) if (table !== 'store_product_attr_value') expect(after[table], table).toEqual(before[table]);
      expect(await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id)).toEqual([...skus, duplicate]);
    }, 120_000);

  it('preserves an explicitly retained server-padded type1 cart through strict raw-identity receipts', async () => {
    const selection = await campaign(), f = fixture();
    await f.db.update(storeCart).set({ type: 1, activityId: selection.childId,
      productAttrUnique: 'short7  ', cartNum: 1 }).where(eq(storeCart.id, 1));
    const receipt = await quoted(selection, 1);
    await f.withSeckillRuntime(async writer => {
      const created = await strictCreate(writer, selection, 1, receipt);
      const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id));
      expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({ cartId: '1', cartNum: 1, skuUnique: 'short7  ' });
      expect(JSON.parse(lines[0].cartInfo!).sku).toMatchObject({ id: 1, unique: 'short7  ' });
      const [origin] = await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`);
      const [physical] = await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`);
      expect(origin).toMatchObject({ total_num: 1, lines: [expect.objectContaining({ skuUnique: 'short7  ', quantity: 1 })] });
      expect(physical).toMatchObject({ total_num: 1, lines: [expect.objectContaining({ skuUnique: 'short7  ', quantity: 1, kind: 'charged' })] });
    });
    expect((await f.db.select().from(storeCart).where(eq(storeCart.id, 1)))[0]).toMatchObject({ productAttrUnique: 'short7  ', isPay: 1 });
  }, 120_000);

  it.each(['        ', ' short7', 'short7\t', 'short7\n'])(
    'rejects malformed DB base identity %j in actual Admin replacement and public catalogue', async unique => {
      const selection = await campaign(), f = fixture();
      await f.db.update(storeProductAttrValue).set({ unique }).where(eq(storeProductAttrValue.id, 1));
      await rejected('/adminapi/activity/seckill-activities/' + selection.parentId, activityEdit(selection.detail), /规格|标识|基础/, true, 'PUT');
      await rejected('/api/seckill/detail/' + selection.childId + '?view=skus', undefined, /规格|标识|基础/);
    }, 120_000);

  it.each(['foreign product', 'wrong type', 'retired', 'missing'] as const)(
    'rejects a current %s base SKU through actual Admin, catalogue, add and retained quote without fallback', async mode => {
      const selection = await campaign(), id = await added(selection), f = fixture();
      if (mode === 'missing') await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      else await f.db.update(storeProductAttrValue).set(mode === 'foreign product' ? { productId: 71 }
        : mode === 'wrong type' ? { type: 2 } : { isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
      await rejected('/adminapi/activity/seckill-activities/' + selection.parentId, activityEdit(selection.detail), /规格|基础|标识/, true, 'PUT');
      await rejected('/api/seckill/detail/' + selection.childId + '?view=skus', undefined, /规格|基础|标识/);
      await rejected('/api/cart/add', addInput(selection), /规格|商品|失效/);
      await rejected('/api/order/confirm', quoteInput(selection, id), /规格|商品|失效/);
    }, 120_000);

  it.each(['base unique', 'base SUK'] as const)(
    'rejects current duplicate %s for both activity-key add and retained base-key quote', async mode => {
      const selection = await campaign(), id = await added(selection), f = fixture();
      const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      await f.db.insert(storeProductAttrValue).values({ ...base, id: 900,
        unique: mode === 'base unique' ? base.unique : 'DUPKEY01',
        suk: mode === 'base SUK' ? base.suk : 'Owned other combination' });
      await rejected('/adminapi/activity/seckill-activities/' + selection.parentId, activityEdit(selection.detail), /规格|重复|唯一/, true, 'PUT');
      await rejected('/api/seckill/detail/' + selection.childId + '?view=skus', undefined, /规格|重复|唯一/);
      // These are deliberately separate aliases: neither alias may bypass the
      // selected base's complete current unique and SUK identity sets.
      await rejected('/api/cart/add', addInput(selection), /规格|重复|唯一|变化/);
      await rejected('/api/order/confirm', quoteInput(selection, id), /规格|重复|唯一|失效|变化/);
    }, 120_000);

  it('refuses a real cross-namespace activity-key collision on a different base combination', async () => {
    const selection = await campaign(), id = await added(selection), f = fixture();
    const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductAttrValue).values({ ...base, id: 900,
      unique: selection.selected.unique, suk: 'Owned other combination' });
    await rejected('/adminapi/activity/seckill-activities/' + selection.parentId, activityEdit(selection.detail), /规格|冲突|标识/, true, 'PUT');
    await rejected('/api/seckill/detail/' + selection.childId + '?view=skus', undefined, /规格|冲突|标识/);
    await rejected('/api/cart/add', addInput(selection), /规格|冲突|标识/);
    await rejected('/api/order/confirm', quoteInput(selection, id), /规格|冲突|标识|失效|变化/);
  }, 120_000);

  it.each(['unique', 'SUK'] as const)(
    'rejects a stale selected raw base %s through the actual PG helper on an independent LOGIN', async mode => {
      const selection = await campaign(), f = fixture();
      const [selectedRawBase] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      expect(selectedRawBase).toMatchObject({ id: 1, productId: 70, type: 0, isRetired: 0,
        unique: 'short7  ', suk: '短规格' });
      expect(selection.selected.unique).toMatch(/^[a-f0-9]{8}$/);
      // Model the bounded resolver's stale selected row with real committed
      // owned maintenance SQL. The other OR alias deliberately stays equal.
      const edit = mode === 'unique' ? { unique: 'fresh001' } : { suk: 'Owned changed combination' };
      await f.db.update(storeProductAttrValue).set(edit).where(eq(storeProductAttrValue.id, selectedRawBase.id));
      const [editedBase] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selectedRawBase.id));
      expect(editedBase).toEqual({ ...selectedRawBase, ...edit });
      await f.withSeckillRuntime(async writer => {
        // The fixture verifies the distinct authenticated nonowner LOGIN and
        // its declared grants before this real SELECT; no mocked row results.
        const beforeCheck = await f.snapshot(), beforeSequences = await f.sequences();
        const result = await outcome(assertCurrentSeckillBaseSkuIdentity(writer.db, selectedRawBase, selection.selected.unique));
        // Check zero writes before the expected id-only-helper red assertion.
        await unchanged(beforeCheck, beforeSequences);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ApiException);
          expect(result.error.message).toMatch(/规格|身份|组合|变化|重新确认/);
        }
      });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selectedRawBase.id)))[0])
        .toEqual(editedBase);
    }, 120_000);

  it.each(['anonymous', 'buyer JWT', 'read-only Admin'] as const)(
    'refuses %s at the actual App Admin write boundary before opening SQL', async principal => {
      f = await seckillShortSkuRuntimeFixture();
      if (principal === 'read-only Admin') await f.db.update(systemRole).set({ rules: 'seckill_activity.view' }).where(eq(systemRole.id, f.adminRoleId));
      const before = await f.snapshot(), sequences = await f.sequences(), env: Env = { ...f.env };
      wiring.containers.set(env, f.container);
      const response = await app.request('/adminapi/activity/seckill-activities', { method: 'POST',
        headers: { Authorization: principal === 'anonymous' ? '' : 'Bearer ' + (principal === 'buyer JWT' ? f.token : f.adminToken),
          'content-type': 'application/json' }, body: JSON.stringify(f.adminInput()) }, env);
      const body = await response.json<{ status: number; msg: string }>();
      expect(body.status).not.toBe(200); expect(body.msg).toMatch(/登录|权限/);
      expect(wiring.opened).toBe(0); await unchanged(before, sequences);
    }, 120_000);

  it.each(['activity price', 'parent status'] as const)(
    'rolls back strict LOGIN create after a real Admin %s change in the next-order-id boundary', async mode => {
      const selection = await campaign(), id = await added(selection), receipt = await quoted(selection, id), f = fixture();
      let edited: Awaited<ReturnType<Fixture['snapshot']>> | undefined;
      let editedSequences: Awaited<ReturnType<Fixture['sequences']>> | undefined;
      await f.withSeckillRuntime(async writer => {
        const result = await outcome(strictCreate(writer, selection, id, receipt, async () => {
          const edit = activityEdit(selection.detail);
          if (mode === 'activity price') edit.products[0].skus[0].price = '9.00';
          const body = mode === 'activity price' ? edit : {
            request_id: crypto.randomUUID(), revision: selection.detail.revision, status: 0 };
          const response = await request('/adminapi/activity/seckill-activities/' + selection.parentId + (mode === 'parent status' ? '/status' : ''), body, true, 'PUT');
          expect(response.body.status, response.body.msg).toBe(200);
          edited = await f.snapshot(); editedSequences = await f.sequences(); return 'owned_stale_seckill_quote';
        }));
        expect(edited).toBeDefined(); expect(result.ok).toBe(false);
        if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/秒杀|排期|活动|规格|变化|重新确认/); }
      });
      expect(await f.snapshot()).toEqual(edited!); await orderSequenceOnly(editedSequences!);
    }, 120_000);

  it.each(['stock', 'base price'] as const)(
    'rejects a committed %s change after an actual SKU wait in strict LOGIN create', async mode => {
      const selection = await campaign(), id = await added(selection), receipt = await quoted(selection, id), f = fixture();
      const before = await f.snapshot(), sequences = await f.sequences();
      const skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
      const edit = mode === 'stock' ? { stock: 0 } : { price: '21.25' };
      await f.withSeckillRuntime(async writer => f.withPeer!(async holder => {
        const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        expect(new Set([observer.pid, holder.pid, writer.pid]).size).toBe(3); await holder.exec('BEGIN');
        try {
          await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
          await holder.db.update(storeProductAttrValue).set(edit).where(eq(storeProductAttrValue.id, 1));
          const pending = outcome(strictCreate(writer, selection, id, receipt));
          await waitForFinanceBlock(f.db, writer.pid, holder.pid); await holder.exec('COMMIT');
          const result = await pending; expect(result.ok).toBe(false);
          if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/库存|规格|变化|重新确认/); }
        } finally { await holder.exec('ROLLBACK'); }
      }));
      const after = await f.snapshot();
      for (const table of Object.keys(before)) if (table !== 'store_product_attr_value') expect(after[table], table).toEqual(before[table]);
      expect(await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id))
        .toEqual(skus.map(row => row.id === 1 ? { ...row, ...edit } : row));
      await orderSequenceOnly(sequences);
    }, 120_000);

  it('does not repair a stored non-padding alias or let its earlier quote authorize create', async () => {
    const selection = await campaign(), id = await added(selection), receipt = await quoted(selection, id), f = fixture();
    await f.db.update(storeCart).set({ productAttrUnique: 'short7\t' }).where(eq(storeCart.id, id));
    const before = await f.snapshot(), sequences = await f.sequences();
    await rejected('/api/order/confirm', quoteInput(selection, id), /规格|商品|失效/);
    await f.withSeckillRuntime(async writer => {
      const result = await outcome(strictCreate(writer, selection, id, receipt)); expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
    });
    await unchanged(before, sequences);
  }, 120_000);

  it('keeps cumulative base history incomplete at actual confirmation and strict creation', async () => {
    const selection = await campaign(), id = await added(selection), receipt = await quoted(selection, id), f = fixture();
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 2, limitNum: 10 }).where(eq(storeProduct.id, 70));
    const before = await f.snapshot(), sequences = await f.sequences();
    await rejected('/api/order/confirm', quoteInput(selection, id), /累计|历史/);
    await f.withSeckillRuntime(async writer => {
      const result = await outcome(strictCreate(writer, selection, id, receipt)); expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/累计|历史/); }
    });
    await unchanged(before, sequences);
  }, 120_000);
});
