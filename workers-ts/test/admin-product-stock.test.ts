import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { AdminProductStockService, normalizeAdminProductStockAdjustments } from '@/services/admin/AdminProductStockService';
import { PRODUCT_STOCK_EFFECTS_EVENT } from '@/services/product/ProductStockEffects';
import { storeProductAttrValue, storeProductStockRecord, storeOrderOutbox, systemLog, systemRole, systemAdmin, systemConfig, systemMenus } from '@/models/schema';
import { stockFixture, seedStocks, resetStockSequences, stockActor, stockBody, stockRows, stockSnapshot } from './helpers/adminProductStocks';

describe('genuine Admin stock source reads, relative changes and complete transaction receipts', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  beforeAll(async () => { f = await stockFixture(); }, 30000);
  beforeEach(async () => { await f.reset(); await seedStocks(f.db); await resetStockSequences(f.exec); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Stock unit forbids remote I/O')); }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  it('reads complete id-ordered ordinary SKU DTOs including tombstones and parentless rows without writes; card secrets always redact', async () => {
    const before = await stockSnapshot(f.db), rows = await f.service.attrs(10, stockActor(102));
    expect(rows.map(row => row.id)).toEqual([11, 12, 13]);
    expect(rows[0]).toMatchObject({ product_id: 10, unique: 'stock001', stock: 10, sum_stock: 10, bar_code: 'SKU条码', code: 'SKU编码', price: '12.00', cost: '1.25', image: '/uploads/blue.png', disk_info: null });
    expect(rows[2]).toMatchObject({ is_retired: 1, retired_by: 101, retire_reason: 'fixture retired' });
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys((await stockRows(f.db)).skus[0]).map(key => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)).sort());
    expect(await f.service.attrs(998, stockActor())).toEqual([]);
    expect(await f.service.attrs(999, stockActor())).toMatchObject([{ id: 91, image: '', disk_info: null }]);
    expect(await f.service.attrs(50, stockActor())).toMatchObject([{ id: 51, disk_info: null }]);
    expect(await stockSnapshot(f.db)).toEqual(before);
  });
  it('preserves canonical numeric strings, outbound zero and source unknown skip while rejecting unsupported bodies before writes', async () => {
    expect(normalizeAdminProductStockAdjustments({ attrs: [{ unique: 'stock001', pm: '0', stock: '0' }] })).toEqual([{ unique: 'stock001', pm: 0, stock: 0 }]);
    const before = await stockSnapshot(f.db);
    for (const body of [null, [], {}, { attrs: [] }, { attrs: [{ unique: 'stock001', pm: 2, stock: 0 }] }, { attrs: [{ unique: 'stock001', pm: 1, stock: -1 }] }, { attrs: [{ unique: 'stock001', pm: 1, stock: 0.5 }] }, { attrs: [{ unique: 'stock001', pm: 1, stock: '01' }] }, { attrs: [{ unique: 'stock001', pm: 1, stock: 0, product_id: 20 }] }, { ...stockBody(), id: 20 }]) await expect(f.service.save(10, body, stockActor())).rejects.toThrow();
    expect(await stockSnapshot(f.db)).toEqual(before);
  });
  it('atomically writes relative stock, signed sum_stock, exact requested ledger, full audit and durable source alert/cache intent', async () => {
    const before = await stockSnapshot(f.db);
    expect(await f.service.save(10, stockBody(3), stockActor())).toEqual({ stock: '13' });
    const after = await stockRows(f.db); expect(after.parent).toMatchObject({ stock: 13, isSold: 0, isPolices: 1 });
    expect(after.skus.find(row => row.id === 11)).toMatchObject({ stock: 13, sumStock: 13, sales: 2, price: '12.00', unique: 'stock001' });
    const records = await f.db.select().from(storeProductStockRecord); expect(records).toHaveLength(2);
    expect(records.find(row => row.id === 1000)).toMatchObject({ storeId: 0, productId: 10, unique: 'stock001', costPrice: '1.25', number: 3, pm: 1 });
    const [audit] = await f.db.select().from(systemLog); expect(Object.keys(audit)).toHaveLength(12);
    expect(audit).toMatchObject({ adminId: 101, storeId: 0, merchantId: 0, adminName: '', ip: '', path: 'product/product/saveStocks/10', method: 'PUT', page: '商品库存管理', type: 'product_stock_adjustment' });
    const [event] = await f.db.select().from(storeOrderOutbox); expect(event).toMatchObject({ aggregateType: 'product', aggregateId: 10, eventType: PRODUCT_STOCK_EFFECTS_EVENT, status: 'PENDING', payload: { productId: 10, auditId: audit.id, warning: true } });
    expect(Object.keys(event.payload).sort()).toEqual(['auditId', 'productId', 'warning']);
    const final = await stockSnapshot(f.db); for (const key of Object.keys(before).filter(key => !['storeProduct', 'storeProductAttrValue', 'storeProductStockRecord', 'systemLog', 'storeOrderOutbox'].includes(key))) expect(final[key]).toEqual(before[key]);
  });
  it('records requested outbound quantity beyond available stock, clamps main/SKU only, and allows signed cumulative stock', async () => {
    expect(await f.service.save(10, stockBody(20, 0), stockActor())).toEqual({ stock: 0 });
    const rows = await stockRows(f.db); expect(rows.parent).toMatchObject({ stock: 0, isSold: 1, isPolices: 1 });
    expect(rows.skus.find(row => row.id === 11)).toMatchObject({ stock: 0, sumStock: -10 });
    expect((await f.db.select().from(storeProductStockRecord)).find(row => row.id === 1000)).toMatchObject({ number: 20, pm: 0 });
  });
  it('retains repeated request original-snapshot overwrite, last encountered duplicate alias and main net delta divergence', async () => {
    await f.db.insert(storeProductAttrValue).values({ id: 15, productId: 10, unique: 'stock001', stock: 20, sumStock: 25, cost: '9.00' });
    expect(await f.service.save(10, { attrs: [{ unique: 'stock001', pm: 1, stock: 3 }, { unique: 'stock001', pm: 1, stock: 4 }] }, stockActor())).toEqual({ stock: '17' });
    const rows = await stockRows(f.db); expect(rows.skus.find(row => row.id === 11)).toMatchObject({ stock: 10, sumStock: 10 });
    expect(rows.skus.find(row => row.id === 15)).toMatchObject({ stock: 24, sumStock: 29 });
    expect(rows.parent?.stock).toBe(17); expect(rows.skus.filter(row => row.type === 0).reduce((sum, row) => sum + row.stock, 0)).toBe(40);
    expect((await f.db.select().from(storeProductStockRecord)).filter(row => row.id >= 1000).map(row => [row.number, row.costPrice])).toEqual([[3, '9.00'], [4, '9.00']]);
  });
  it('accepts every unchanged source-modal row including retired zero and unknown-only adjustments with independent durable effects', async () => {
    expect(await f.service.save(10, { attrs: [{ unique: 'stock001', pm: 0, stock: 0 }, { unique: 'stock002', pm: 1, stock: 0 }, { unique: 'old00001', pm: 1, stock: 0 }] }, stockActor())).toEqual({ stock: '10' });
    expect((await f.db.select().from(storeProductStockRecord)).filter(row => row.id >= 1000)).toHaveLength(3);
    expect(await f.service.save(10, stockBody(99, 1, 'unknown1'), stockActor())).toEqual({ stock: '10' });
    expect((await f.db.select().from(storeProductStockRecord)).filter(row => row.id >= 1000)).toHaveLength(3);
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(2);
    expect(new Set((await f.db.select().from(storeOrderOutbox)).map(row => row.eventKey)).size).toBe(2);
    const before = await stockSnapshot(f.db); await expect(f.service.save(10, stockBody(1, 1, 'old00001'), stockActor())).rejects.toThrow('退休'); expect(await stockSnapshot(f.db)).toEqual(before);
  });
  it('allows genuine Admin adjustments to supplier/store and deleted/unverified source parents without changing owner tuple or ledger default store_id', async () => {
    for (const [product, alias, stock] of [[20, 'supply01', 21], [30, 'stores01', 31], [40, 'deleted1', 6]] as const) {
      expect(await f.service.save(product, stockBody(1, 1, alias), stockActor())).toEqual({ stock: String(stock) });
      expect((await f.db.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId, product)))[0].storeId).toBe(0);
    }
    expect((await stockRows(f.db, 20)).parent).toMatchObject({ type: 2, relationId: 20 });
    expect((await stockRows(f.db, 40)).parent).toMatchObject({ isDel: 1, isVerify: 0, isShow: 0 });
  });
  it('requires actual independent view/manage authority and refuses copied numeric stock rules without inventing source seeds', async () => {
    const permissions = new AdminPermissionService(f.container);
    expect((await permissions.resolveRulePermissionKeys('product.manage')).includes('product.manage')).toBe(true);
    for (const id of [102, 104, 105, 107, 108]) await expect(f.service.save(10, stockBody(), stockActor(id))).rejects.toThrow('权限');
    await expect(f.service.attrs(10, stockActor(103))).rejects.toThrow('权限');
    await expect(f.service.attrs(10, stockActor(109))).rejects.toThrow('身份');
    const admins = await f.db.select().from(systemAdmin); const many = await permissions.resolveManyAdminPermissionKeys(admins);
    for (let i = 0; i < admins.length; i++) expect(many[i]).toEqual(await permissions.resolveAdminPermissionKeys(admins[i]));
    expect((await permissions.resolveRulePermissionKeys('999')).includes('product.manage')).toBe(false);
    await f.db.update(systemMenus).set({ apiUrl: 'product/product/saveStocks/<id>', methods: 'PUT' }).where(eq(systemMenus.id, 105));
    await expect(f.service.save(10, stockBody(), stockActor(106))).rejects.toThrow('权限');
  });
  it('refuses card fabrication, malformed ownership, invalid ERP/config, integer overflow and changed actor atomically', async () => {
    for (const [product, alias] of [[50, 'virtual1'], [60, 'malform1'], [998, 'unknown1']] as const) { const before = await stockSnapshot(f.db); await expect(f.service.save(product, stockBody(1, 1, alias), stockActor())).rejects.toThrow(); expect(await stockSnapshot(f.db)).toEqual(before); }
    for (const value of ['1', '"true"', '"broken"']) { await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, 'erp_open')); const before = await stockSnapshot(f.db); await expect(f.service.save(10, stockBody(), stockActor())).rejects.toThrow('ERP'); expect(await stockSnapshot(f.db)).toEqual(before); }
    await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'erp_open'));
    for (const change of [{ stock: 2_147_483_647 }, { sumStock: 2_147_483_647 }]) { await f.db.update(storeProductAttrValue).set({ stock: 10, sumStock: 10, ...change }).where(eq(storeProductAttrValue.id, 11)); const before = await stockSnapshot(f.db); await expect(f.service.save(10, stockBody(), stockActor())).rejects.toThrow('范围'); expect(await stockSnapshot(f.db)).toEqual(before); }
    await f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1)); await expect(f.service.save(10, stockBody(), stockActor())).rejects.toThrow('权限');
  });
  it('uses source ALL ordinary SKU threshold and sold predicates, with global current config winner instead of main-stock-only/SUM', async () => {
    await f.db.update(storeProductAttrValue).set({ stock: 7 }).where(eq(storeProductAttrValue.id, 13));
    await f.db.insert(systemConfig).values({ id: 3, menuName: 'store_stock', sort: 5, value: '5' });
    await f.service.save(10, stockBody(0), stockActor()); expect((await stockRows(f.db)).parent).toMatchObject({ stock: 10, isSold: 0, isPolices: 1 });
    await f.db.update(storeProductAttrValue).set({ stock: 6 }).where(eq(storeProductAttrValue.id, 12));
    await f.service.save(10, stockBody(0), stockActor()); expect((await stockRows(f.db)).parent).toMatchObject({ isSold: 0, isPolices: 0 });
    await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 13));
    await f.service.save(10, stockBody(0), stockActor()); expect((await stockRows(f.db)).parent).toMatchObject({ isSold: 1, isPolices: 1 });
  });
  it('rolls back suppressed/rewritten SKU, product, ledger and full audit fields including post-audit mutations and extra ledger rows', async () => {
    const mutations = [
      ['store_product_attr_value', 'BEFORE UPDATE', 'RETURN NULL'],
      ['store_product_attr_value', 'BEFORE UPDATE', "NEW.sales:=NEW.sales+1; RETURN NEW"],
      ['store_product', 'BEFORE UPDATE', 'RETURN NULL'],
      ['store_product_stock_record', 'BEFORE INSERT', 'RETURN NULL'],
      ['store_product_stock_record', 'BEFORE INSERT', "NEW.cost_price:='99.00'; RETURN NEW"],
      ['system_log', 'BEFORE INSERT', 'RETURN NULL'],
      ['system_log', 'BEFORE INSERT', "NEW.admin_name:='rewritten'; RETURN NEW"],
      ['system_log', 'AFTER INSERT', "UPDATE store_product_attr_value SET stock=99 WHERE id=11; RETURN NEW"],
      ['system_log', 'AFTER INSERT', "INSERT INTO store_product_stock_record(product_id,number) VALUES(10,99); RETURN NEW"],
      ['store_order_outbox', 'BEFORE INSERT', 'RETURN NULL'],
    ];
    for (const [table, timing, action] of mutations) {
      const before = await stockSnapshot(f.db);
      await f.exec(`CREATE FUNCTION stock_trigger_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${action}; END $$; CREATE TRIGGER stock_trigger_fixture ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION stock_trigger_fixture()`);
      try { await expect(f.service.save(10, stockBody(), stockActor())).rejects.toThrow(); expect(await stockSnapshot(f.db)).toEqual(before); }
      finally { await f.exec(`DROP TRIGGER stock_trigger_fixture ON ${table}; DROP FUNCTION stock_trigger_fixture()`); }
    }
  });
  it('dispatches committed durable effects only after transaction release and never converts a queue failure to false stock write failure', async () => {
    const observed: number[] = [], service = new AdminProductStockService(f.container, undefined, { async dispatch(outboxId) {
      expect((await stockRows(f.db)).parent?.stock).toBe(13); expect((await f.db.select().from(storeOrderOutbox))[0].id).toBe(outboxId); observed.push(outboxId); throw Error('Queue fixture unavailable');
    } });
    expect(await service.save(10, stockBody(), stockActor())).toEqual({ stock: '13' }); expect(observed).toHaveLength(1);
  });
});
