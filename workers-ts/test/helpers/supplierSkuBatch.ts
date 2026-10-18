import { and, asc, eq, getTableName, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductVirtual,
  systemAttachment, systemFormData, userLabel } from '@/models/schema';
import { normalizeProductSkuEditorPayload, productSkuSummary } from '@/services/product/ProductSkuEditorService';
import { installSupplierProductCopyOperation } from '@/migrations/supplierProductCopyOperation';
import { legacySaveSchema } from './adminLegacyProductSave';
import { supplierProductSystemFormsFixture } from './supplierProductSystemForms';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';

export const supplierSkuBatchDimensions = [{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺码', detail: ['S', 'M'] }];
export const supplierSkuBatchValues = { image: '/api/assets/31', settle_price: '7.65', stock: 20,
  bar_code: 'BATCH-BARCODE', code: 'BATCH-CODE', weight: '1.2', volume: '0.35' };

/** Only a newly owned PG16 fixture is altered. Ordinary Supplier requests run
 * through the inherited independent minimum-grant LOGINs and real JWT/App. */
export async function supplierSkuBatchFixture() {
  const f = await supplierProductSystemFormsFixture();
  try {
    const attrs = ['红,S', '红,M', '蓝,S', '蓝,M'].map((suk, index) => ({ suk,
      detail: { 颜色: suk.split(',')[0], 尺码: suk.split(',')[1] }, image: `/owned-media/sku-${index}.png`,
      price: `${20 + index}.01`, settle_price: `${10 + index}.02`, cost: `${4 + index}.03`, ot_price: `${30 + index}.04`,
      vip_price: `${18 + index}.05`, stock: 3 + index * 2, bar_code: `BAR-${index}`, code: `CODE-${index}`,
      weight: `${index}.10`, volume: `0.${index + 1}0`, brokerage: '1.00', brokerage_two: '0.50' }));
    const payload = normalizeProductSkuEditorPayload({ spec_type: 1, items: supplierSkuBatchDimensions, attrs });
    const assigned = payload.skus.map((sku, index) => ({ ...sku, id: 8001 + index,
      unique: ['sbtred01', 'sbtred02', 'sbtblu01', 'sbtblu02'][index], sales: 11 + index, sumStock: 100 + index }));
    // Owner-only initial seed, before any tested operation or historical order.
    // The production editor's no-delete/no-rename rule is never bypassed by an HTTP request.
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.productId, 80));
    await f.db.delete(storeProductAttr).where(eq(storeProductAttr.productId, 80));
    await f.db.delete(storeProductAttrResult).where(eq(storeProductAttrResult.productId, 80));
    await f.db.insert(storeProductAttr).values(supplierSkuBatchDimensions.map(dimension => ({ productId: 80,
      attrName: dimension.value, attrValues: dimension.detail.join(','), type: 0 })));
    await f.db.insert(storeProductAttrValue).values(assigned.map(row => ({ ...row, productId: 80, productType: 0, type: 0 })));
    await f.db.insert(storeProductAttrValue).values({ id: 8099, productId: 80, productType: 0, type: 0, suk: '旧色,旧码',
      unique: 'sbtold01', image: '/owned-media/retired.png', price: '99.00', settlePrice: '88.00', cost: '77.00',
      stock: 2, sales: 40, sumStock: 50, isRetired: 1, retiredAt: 123, retiredBy: 21, retireReason: '历史退役保持' });
    await f.db.insert(storeProductAttrResult).values({ productId: 80, type: 0,
      result: JSON.stringify({ attr: supplierSkuBatchDimensions, value: assigned }), changeTime: 100 });
    await f.db.update(storeProduct).set({ ...productSkuSummary(payload), specType: 1, storeName: '本机SKU批量商品',
      sales: 50, spu: 'SKU-BATCH-SPU' }).where(eq(storeProduct.id, 80));
    // The second owned product remains a real card-backed control; its stock
    // cannot be increased by the ordinary complete product editor.
    const [card] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, 81));
    await f.db.update(storeProduct).set({ productType: 1, stock: 1, storeName: '卡密库存权威对照' }).where(eq(storeProduct.id, 81));
    await f.db.update(storeProductAttrValue).set({ productType: 1, stock: 1, sumStock: 7 }).where(eq(storeProductAttrValue.id, card.id));
    await f.db.insert(storeProductVirtual).values({ productId: 81, attrUnique: card.unique,
      cardNo: 'OWNED-CARD-SECRET', cardPwd: 'OWNED-CARD-PASSWORD' });
    await f.db.insert(systemFormData).values({ uid: 999, systemFormId: '71', relationId: 900, value: 'UNCHANGED-CUSTOMER-ANSWER' });
    await f.db.insert(userLabel).values({ id: 61, type: 2, relationId: 7, name: '既有用户标签' });
    await f.db.insert(systemAttachment).values([
      { attId: 31, type: 4, moduleType: 1, relationId: 7, fileType: 1, imageType: 8,
        name: 'attachments/supplier/7/batch.png', attDir: '/api/assets/31', attType: 'image/png' },
      { attId: 32, type: 4, moduleType: 1, relationId: 8, fileType: 1, imageType: 8,
        name: 'attachments/supplier/8/foreign.png', attDir: '/api/assets/32', attType: 'image/png' },
    ]);
    await f.exec("SELECT setval('public.store_product_attr_value_id_seq',8099,true)");
    const objectReads: string[] = [];
    Object.assign(f.env, { ASSETS_BUCKET: { get: async (key: string) => {
      objectReads.push(key);
      if (key !== 'attachments/supplier/7/batch.png') return null;
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2iD2UAAAAASUVORK5CYII='), value => value.charCodeAt(0));
      return { body: new Blob([bytes]).stream(), size: bytes.length, etag: 'owned-sku-batch', httpEtag: '"owned-sku-batch"',
        httpMetadata: { contentType: 'image/png' }, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
    } } } as unknown as Pick<Env, 'ASSETS_BUCKET'>);
    const body = async (overrides: Record<string, unknown> = {}, id = 80): Promise<Record<string, unknown>> => {
      const detail = await f.service.productDetail(7, id);
      return { ...f.body(), product_type: detail.product_type, store_name: detail.store_name,
        spec_type: detail.spec_type, items: detail.items, attrs: detail.attrs, ...overrides };
    };
    const rows = (id = 80) => f.db.select().from(storeProductAttrValue)
      .where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0))).orderBy(asc(storeProductAttrValue.id));
    const withWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withWriter(async runtime => {
      // FOR SHARE on a referenced private attachment needs a column UPDATE
      // privilege. Its identity alone is enough; no metadata edit is granted.
      await f.exec(`GRANT UPDATE(att_id) ON public.system_attachment TO "${runtime.role}"`);
      return work(runtime);
    });
    let copyInstalled = false;
    const prepareCopy = async () => {
      if (copyInstalled) return;
      await f.db.transaction(tx => installSupplierProductCopyOperation(tx));
      copyInstalled = true;
    };
    // Exact mature copy lock/write surface, restricted to this owned fixture.
    // Ordinary seven-field saves use f.withWriter instead of these wider grants.
    const withCopyWriter = <T>(work: (runtime: SupplierProductScheduleRuntime) => Promise<T>) => f.withRuntimeRole!(async peer => {
      await prepareCopy();
      const locked = ['system_admin', 'system_supplier', 'system_role', 'system_menus', 'system_config', 'shipping_templates', 'system_form', 'user_label',
        'store_product_category', 'store_brand', 'store_product_label', 'store_product_ensure', 'category', 'store_product_specs', 'store_coupon_issue', 'system_attachment',
        'store_product', 'store_product_attr_value', 'store_cart', 'store_product_relation', 'store_product_attr', 'store_product_attr_result', 'store_product_description',
        'store_product_virtual', 'store_product_stock_record', 'store_product_coupon', 'store_discounts_products', 'store_seckill', 'store_combination', 'store_bargain', 'store_integral', 'system_log', 'store_order_outbox'];
      await f.exec(`GRANT SELECT ON ${Object.values(legacySaveSchema).map(table => 'public."' + getTableName(table) + '"').join(',')},public.supplier_product_copy_operation_v1 TO "${peer.role}";
        GRANT UPDATE ON ${locked.map(name => 'public."' + name + '"').join(',')} TO "${peer.role}";
        GRANT INSERT ON public.store_product,public.store_product_attr_value,public.store_product_relation,public.store_product_attr,public.store_product_attr_result,public.store_product_description,public.store_product_stock_record,public.store_product_coupon,public.system_log,public.store_order_outbox,public.supplier_product_copy_operation_v1 TO "${peer.role}";
        GRANT DELETE ON public.store_product_attr,public.store_product_attr_result,public.store_product_description,public.store_product_relation,public.store_product_coupon TO "${peer.role}"`);
      const sequences = await f.sequences();
      if (sequences.length) await f.exec(`GRANT USAGE,SELECT ON SEQUENCE ${sequences.map(row => 'public."' + row.name + '"').join(',')} TO "${peer.role}"`);
      return work({ ...peer, container: createContainerFromDb(peer.db) });
    });
    const snapshot = async (): Promise<Record<string, any[]>> => ({ ...await f.snapshot(),
      ...(copyInstalled ? { supplier_product_copy_operation_v1: await f.db.execute(sql`SELECT to_jsonb(t) AS row FROM public.supplier_product_copy_operation_v1 t ORDER BY operation_id`) } : {}) });
    return { ...f, body, rows, snapshot, prepareCopy, withWriter, withCopyWriter, objectReads,
      dimensions: supplierSkuBatchDimensions, batch: supplierSkuBatchValues,
      ids: { product: 80, cardProduct: 81, foreignProduct: 90, retiredSku: 8099, image: 31, foreignImage: 32 } };
  } catch (error) { await f.close(); throw error; }
}
