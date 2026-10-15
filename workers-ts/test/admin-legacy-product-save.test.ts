import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeProduct, storeProductAttr, storeProductDescription, storeProductAttrValue, storeProductAttrResult, storeProductVirtual, storeProductStockRecord,
  storeProductRelation, storeProductCoupon, storeCart, storeDiscountsProducts, storeSeckill, storeBargain, storeCombination,
  storeIntegral, systemSupplier, systemRole, systemAdmin, systemLog, storeOrderOutbox } from '@/models/schema';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { legacySaveFixture, legacySaveActor, legacySaveBody, legacySaveSku } from './helpers/adminLegacyProductSave';

describe('complete legacy product SQL save transaction', () => {
  let f: Awaited<ReturnType<typeof legacySaveFixture>>;
  beforeAll(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Provider I/O forbidden inside save'));
    f = await legacySaveFixture(); }, 30000);
  beforeEach(async () => { await f.seed(); });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const save = (id = 0, changes: Record<string, unknown> = {}) => f.service.save(id, legacySaveBody(changes), legacySaveActor());

  it('creates the full row, stable SKU, description, category, stock ledger, exact audit and durable save event together', async () => {
    const result = await save(0, { is_limit: 1, limit_type: 2, limit_num: 4, is_hot: 1, give_integral: '2.50' });
    expect(result).toMatchObject({ id: 1, committed: true, message: '添加商品成功!' });
    expect(await f.db.select().from(storeProduct)).toEqual([expect.objectContaining({ id: 1, type: 0, isVerify: 1,
      stock: 7, price: '12.50', star: '5.0', isLimit: 1, limitType: 2, limitNum: 4, isHot: 1, giveIntegral: '2.50' })]);
    expect(await f.db.select().from(storeProductStockRecord)).toEqual([expect.objectContaining({ productId: 1, number: 7, pm: 1 })]);
    const [audit] = await f.db.select().from(systemLog), [event] = await f.db.select().from(storeOrderOutbox);
    expect(audit).toMatchObject({ adminId: 1, type: 'product_save', method: 'POST', path: 'product/product/0' });
    expect(event).toMatchObject({ eventType: 'product.save.effects', aggregateType: 'product', aggregateId: 1, status: 'PENDING',
      payload: { productId: 1, requestedId: 0, auditId: audit.id, warning: false } });
  });
  it.each(['description', 'dimension', 'relation'] as const)('refuses an actual allocated parent ID already referenced by an orphan %s before replacing child data', async kind => {
    if (kind === 'description') await f.db.insert(storeProductDescription).values({ productId: 1, type: 0, description: '孤儿描述不得覆盖' });
    if (kind === 'dimension') await f.db.insert(storeProductAttr).values({ productId: 1, type: 0, attrName: '孤儿维度', attrValues: '旧值' });
    if (kind === 'relation') await f.db.insert(storeProductRelation).values({ productId: 1, type: 1, relationId: 999 });
    const before = await f.snapshot();
    await expect(save()).rejects.toThrow('新商品编号');
    expect(await f.snapshot()).toEqual(before);
  });
  it('does not adopt unrelated product_id=0 rows as the baseline of a newly allocated parent', async () => {
    await f.db.insert(storeProductDescription).values({ productId: 0, type: 0, description: '历史零号数据' });
    await save();
    expect((await f.db.select().from(storeProductDescription)).find(row => row.productId === 0)?.description).toBe('历史零号数据');
  });
  it('retains a supplier owner for creation and every activity owner update without rewriting activity prices or sales', async () => {
    await f.db.insert(systemSupplier).values({ id: 20, supplierName: '供应商' });
    const first = await save(0, { supplier_id: 20 });
    for (const table of [storeSeckill, storeCombination, storeBargain, storeIntegral]) await f.db.insert(table).values({ productId: first.id, type: 0, relationId: 0 });
    const before = await f.snapshot();
    await save(first.id, { supplier_id: 99, is_show: 0, attrs: [legacySaveSku({ stock: 8 })] });
    expect((await f.db.select().from(storeProduct))[0]).toMatchObject({ type: 2, relationId: 20, isVerify: 0 });
    for (const name of ['store_seckill', 'store_combination', 'store_bargain', 'store_integral']) {
      const current = (await f.snapshot())[name].map(value => JSON.parse(value as string));
      expect(current).toEqual(before[name].map(value => ({ ...JSON.parse(value as string), type: 2, relationId: 20 })));
    }
  });
  it('updates all parent carts and discount shipping references, including paid/deleted/activity carts, while preserving real sales', async () => {
    const first = await save();
    await f.db.update(storeProduct).set({ sales: 9, labelId: 'historical' }).where(eq(storeProduct.id, first.id));
    await f.db.insert(storeCart).values([{ productId: first.id, uid: 5, status: 1 }, { productId: first.id, uid: 8, status: 0, isPay: 1, isDel: 1, type: 2 }]);
    await f.db.insert(storeDiscountsProducts).values({ productId: first.id, tempId: 99 });
    const [oldSku] = await f.db.select().from(storeProductAttrValue);
    await save(first.id, { is_show: 0, sales: 999, label_id: [], attrs: [legacySaveSku({ unique: oldSku.unique, stock: 4 })] });
    expect((await f.db.select().from(storeProduct))[0]).toMatchObject({ sales: 9, labelId: 'historical', stock: 4 });
    expect((await f.db.select().from(storeCart)).map(row => row.status)).toEqual([0, 0]);
    expect((await f.db.select().from(storeDiscountsProducts))[0].tempId).toBe(0);
    expect((await f.db.select().from(storeProductAttrValue))[0]).toMatchObject({ id: oldSku.id, unique: oldSku.unique, stock: 4 });
  });
  it('preserves true PHP empty-group relation/coupon behavior instead of clearing historical rows silently', async () => {
    const first = await save();
    await f.db.insert(storeProductRelation).values([{ productId: first.id, type: 2, relationId: 999 },
      { productId: first.id, type: 4, relationId: 998 }, { productId: first.id, type: 6, relationId: 997 }]);
    await f.db.insert(storeProductCoupon).values({ productId: first.id, issueCouponId: 996, title: '历史已删除赠券' });
    const coupons = await f.db.select().from(storeProductCoupon);
    const relations = (await f.db.select().from(storeProductRelation)).filter(row => row.type !== 1);
    await save(first.id, { brand_id: [], label_id: [], specs_id: 0, coupon_ids: [] });
    expect((await f.db.select().from(storeProductRelation)).filter(row => row.type !== 1)).toEqual(relations);
    expect(await f.db.select().from(storeProductCoupon)).toEqual(coupons);
  });
  it('imports requested cards once, preserves assigned rows, derives stock from real insertions and synchronizes the result snapshot', async () => {
    const first = await save(0, { product_type: 1, attrs: [legacySaveSku({ stock: 2,
      virtual_list: [{ key: 'A', value: 'secretA' }, { key: 'B', value: 'secretB' }] })] });
    const [sku] = await f.db.select().from(storeProductAttrValue);
    const cards = await f.db.select().from(storeProductVirtual);
    await f.db.update(storeProductVirtual).set({ uid: 88, orderId: 'already-assigned' }).where(eq(storeProductVirtual.id, cards[0].id));
    await f.db.update(storeProductAttrValue).set({ stock: 1 }).where(eq(storeProductAttrValue.id, sku.id));
    await f.db.update(storeProduct).set({ stock: 1 }).where(eq(storeProduct.id, first.id));
    await save(first.id, { product_type: 1, attrs: [legacySaveSku({ stock: 999, unique: sku.unique,
      virtual_list: [{ key: 'A', value: 'secretA' }, { key: 'C', value: 'secretC' }] })] });
    expect(await f.db.select().from(storeProductVirtual)).toHaveLength(3);
    expect((await f.db.select().from(storeProductVirtual)).find(row => row.id === cards[0].id)).toMatchObject({ uid: 88, orderId: 'already-assigned' });
    expect((await f.db.select().from(storeProduct))[0].stock).toBe(2);
    expect((await f.db.select().from(storeProductAttrValue))[0]).toMatchObject({ unique: sku.unique, stock: 2, sumStock: 3 });
    const [snapshot] = await f.db.select().from(storeProductAttrResult);
    expect(JSON.parse(snapshot.result).value[0]).toMatchObject({ stock: 2, sumStock: 3 });
    expect(JSON.stringify(await f.db.select().from(systemLog))).not.toContain('secret');
    expect(JSON.stringify(await f.db.select().from(storeOrderOutbox))).not.toContain('secret');
  });
  it('preserves legacy second-card fixed postage rather than forcing modern free-pickup defaults', async () => {
    await save(0, { product_type: 4, delivery_type: 2, freight: 2, postage: '3.50',
      attrs: [legacySaveSku({ write_times: 3, write_valid: 2, days: 30 })] });
    expect((await f.db.select().from(storeProduct))[0]).toMatchObject({ deliveryType: '2', freight: 2, postage: '3.50', tempId: 0 });
    expect((await f.db.select().from(storeProductAttrValue))[0]).toMatchObject({ writeTimes: 3, writeValid: 2, writeDays: 30 });
  });
  it('preserves an imported historical SKU identity containing punctuation rather than applying the new allocator alphabet to old data', async () => {
    const first = await save();
    await f.db.update(storeProductAttrValue).set({ unique: 'old-sku1' }).where(eq(storeProductAttrValue.productId, first.id));
    await save(first.id, { attrs: [legacySaveSku({ unique: 'old-sku1' })] });
    expect((await f.db.select().from(storeProductAttrValue))[0].unique).toBe('old-sku1');
  });
  it('refuses a drifted inventory-card counter before writing instead of treating a submitted stock number as actual available cards', async () => {
    const first = await save(0, { product_type: 1, attrs: [legacySaveSku({ stock: 1, virtual_list: [{ key: '', value: 'secret' }] })] });
    await f.db.update(storeProductAttrValue).set({ stock: 99 }).where(eq(storeProductAttrValue.productId, first.id));
    const before = await f.snapshot();
    await expect(save(first.id, { product_type: 1 })).rejects.toThrow('未分配卡密');
    expect(await f.snapshot()).toEqual(before);
  });
  it('edits a deleted hidden product, rejects republishing it and leaves all business rows unchanged on refusal', async () => {
    const first = await save();
    await f.db.update(storeProduct).set({ isDel: 1, isShow: 0 }).where(eq(storeProduct.id, first.id));
    await save(first.id, { is_show: 0, store_name: '回收站修改' });
    const before = await f.snapshot();
    await expect(save(first.id, { is_show: 1 })).rejects.toThrow('回收站');
    expect(await f.snapshot()).toEqual(before);
  });
  it('resolves a create source link to the actual existing product and keeps the requested-route audit identity', async () => {
    const first = await save(0, { soure_link: 'https://source.example/item' });
    const next = await save(0, { soure_link: 'https://source.example/item', store_name: '同源更新' });
    expect(next.id).toBe(first.id); expect(await f.db.select().from(storeProduct)).toHaveLength(1);
    const audits = await f.db.select().from(systemLog);
    expect(audits.map(row => row.path)).toEqual(['product/product/0', 'product/product/0']);
    expect(JSON.parse(audits[1].action)).toMatchObject({ sourceLinkResolved: true, requestedId: 0, productId: first.id });
  });
  it('revalidates live role/password and refuses a revoked writer before any business or audit mutation', async () => {
    await save();
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1));
    const before = await f.snapshot();
    await expect(save(1)).rejects.toThrow('权限');
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(systemRole).set({ rules: 'product.manage' }).where(eq(systemRole.id, 1));
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 1));
    const changed = await f.snapshot();
    await expect(save(1)).rejects.toThrow('凭据');
    expect(await f.snapshot()).toEqual(changed);
  });
  it('rolls back a trigger mutation to a SKU column omitted by the existing partial SKU readback', async () => {
    await save();
    await f.exec(`CREATE FUNCTION save_mutate_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.quota=NEW.quota+1; RETURN NEW; END $$;
      CREATE TRIGGER save_mutate_quota BEFORE UPDATE ON store_product_attr_value FOR EACH ROW EXECUTE FUNCTION save_mutate_quota()`);
    try {
      const before = await f.snapshot();
      await expect(save(1, { attrs: [legacySaveSku({ stock: 4 })] })).rejects.toThrow('回读');
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER save_mutate_quota ON store_product_attr_value; DROP FUNCTION save_mutate_quota()'); }
  });
  it('rechecks all business columns after the audit trigger and rolls the entire transaction back', async () => {
    const first = await save(); await f.db.insert(storeCart).values({ productId: first.id, uid: 3 });
    await f.exec(`CREATE FUNCTION save_mutate_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_cart SET cart_num=cart_num+2 WHERE product_id=1; RETURN NEW; END $$;
      CREATE TRIGGER save_mutate_cart AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION save_mutate_cart()`);
    try {
      const before = await f.snapshot();
      await expect(save(first.id, { is_show: 0 })).rejects.toThrow('购物车');
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER save_mutate_cart ON system_log; DROP FUNCTION save_mutate_cart()'); }
  });
  it('keeps a committed save and durable retry intent when provider dispatch fails after commit', async () => {
    const service = new AdminLegacyProductSaveService(f.container, { dispatch: async () => { throw Error('Missing Queue provider'); } });
    expect(await service.save(0, legacySaveBody(), legacySaveActor())).toMatchObject({ committed: true, id: 1 });
    expect((await f.db.select().from(storeOrderOutbox))[0].status).toBe('PENDING');
    expect(await f.db.select().from(storeProduct)).toHaveLength(1);
  });
});
