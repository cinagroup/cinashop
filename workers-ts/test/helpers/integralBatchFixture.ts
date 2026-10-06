/** Owned local SQL data for real bulk cloning and real type-4 checkout. No
 * provider, Redis, production database or fabricated transaction results. */
import { and, asc, eq } from 'drizzle-orm';
import type { Env } from '../../src/env';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { AdminIntegralBatchService } from '../../src/services/admin/AdminIntegralBatchService';
import { financePostgres } from './financePostgres';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { runPurchaseCancellationEvidenceSchema } from '../../src/migrations/runPurchaseCancellationEvidence';
import { REFUND_ORDER_SPLIT_SQL } from '../../src/migrations/refundOrderSplit';
import type { PgTable } from 'drizzle-orm/pg-core';
import { agentLevel, luckLottery, orderWaybillJob, printDocument, shippingTemplates,
  storeIntegral, storeProduct, storeProductAttr, storeProductAttrResult,
  storeProductAttrValue, storeProductCategory, storeProductDescription,
  storeProductLabel, storeProductRelation, storeProductSkuRetirementLog,
  systemAdmin, systemAttachment, systemLog, systemMenus, systemRole,
  systemStore, systemSupplier, storeCouponIssue, storeCouponIssueUser,
  storeCouponUser, storeOrder, storeOrderCartInfo, storeOrderEconomize,
  storeOrderInvoice, storeOrderOutbox, storeOrderProductCouponReward,
  storeOrderPromotionGiftCouponReward, storeProductCoupon, storeOrderRefund,
  storeOrderRefundPayment, storeOrderStatus, supplierFlowingWater,
  supplierTransactions, user, userBrokerage, userLabel,
  userLabelRelation } from '../../src/models/schema';

export const integralBatchTables = [storeIntegral, storeProduct, storeProductAttr,
  storeProductAttrResult, storeProductAttrValue, storeProductDescription,
  storeProductSkuRetirementLog, storeProductCategory, storeProductLabel,
  storeProductRelation, systemAdmin, systemRole, systemMenus, systemStore,
  systemSupplier, systemAttachment, systemLog, shippingTemplates];

const lifecycleTables = [agentLevel, luckLottery, orderWaybillJob, printDocument,
  storeCouponIssue, storeCouponIssueUser, storeCouponUser, storeOrder,
  storeOrderCartInfo, storeOrderEconomize, storeOrderInvoice, storeOrderOutbox,
  storeOrderProductCouponReward, storeOrderPromotionGiftCouponReward,
  storeProductCoupon, storeOrderRefund, storeOrderRefundPayment, storeOrderStatus,
  supplierFlowingWater, supplierTransactions, userBrokerage, userLabel,
  userLabelRelation];

export const integralBatchActor = { id: 7 };
export const integralBatchKey = 'local-integral-batch-test-key';

type IntegralBatchDatabase = Pick<Awaited<ReturnType<typeof financePostgres>>, 'db' | 'exec' | 'close'>;
export async function integralBatchFixture(lifecycle = false,
  createDatabase: (tables: PgTable[]) => Promise<IntegralBatchDatabase> = tables => financePostgres(tables, { namespace: 'public' })) {
  const checkout = lifecycle ? await createPcCheckoutQuoteFixture([
    ...integralBatchTables, ...lifecycleTables]) : undefined;
  const f = checkout ?? await createDatabase(integralBatchTables);
  const env = (checkout?.env ?? {}) as Env;
  Object.assign(env, { APP_KEY: integralBatchKey, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' });
  try {
    if (checkout) {
      await checkout.setConfig(Object.fromEntries(Object.keys(checkout.config).map(key => [key, '0'])));
      await f.db.update(user).set({ nowMoney: '100.00', integral: 100, spreadUid: 0 }).where(eq(user.uid, 11));
      await f.exec('CREATE UNIQUE INDEX integral_batch_outbox_event ON store_order_outbox(event_key)');
      await f.exec('CREATE INDEX integral_batch_status_oid ON store_order_status(oid)');
      await f.exec('CREATE INDEX integral_batch_bill_link ON user_bill(category,type,link_id)');
      await f.exec('CREATE INDEX soi_order ON store_order_invoice(order_id)');
      await f.exec('CREATE INDEX soi_uid_state_time ON store_order_invoice(uid,is_del,is_refund,add_time)');
      await f.exec('CREATE INDEX soi_issue_state_time ON store_order_invoice(is_pay,is_del,is_invoice,add_time)');
      await f.exec(REFUND_ORDER_SPLIT_SQL);
      await runPurchaseCancellationEvidenceSchema(f.db);
      await f.exec("SELECT setval(pg_get_serial_sequence('store_cart','id'),1,true)");
    } else {
      await f.db.insert(shippingTemplates).values({ id: 10, name: '批量来源运费', type: 1 });
      await f.db.insert(storeProduct).values({ id: 70 });
      await f.db.insert(storeProductAttrValue).values({ id: 1, productId: 70 });
    }
    await f.db.insert(systemSupplier).values({ id: 7, adminId: 700, supplierName: '测试供应商', isShow: 1, isDel: 0 });
    await f.db.insert(systemStore).values({ id: 11, name: '测试来源门店', isShow: 1, isDel: 0, isStore: 1 });
    await f.db.insert(shippingTemplates).values({ id: 11, name: '门店批量来源运费',
      ownerType: 1, relationId: 11, type: 1 });
    await f.db.update(storeProduct).set({ type: 0, relationId: 0, pid: 0,
      storeName: '批量商品甲', storeInfo: '源商品说明甲', unitName: '件',
      image: '/images/source-70.png', sliderImage: '["/images/source-70.png"]',
      price: '10.00', otPrice: '15.00', stock: 20, isVerify: 1,
      isShow: 1, isDel: 0, isVipProduct: 0, isPresaleProduct: 0,
      productType: 0, specType: 1, freight: 1, postage: '0.00', tempId: 0,
      deliveryType: '1', customForm: '[]', systemFormId: 0,
      storeLabelId: '21', ensureId: '31', specs: '[{"name":"产地","value":"本地"}]',
      giveIntegral: '0.00', isSub: 0 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values([
      { id: 72, type: 0, relationId: 0, pid: 0, storeName: '批量商品乙',
        unitName: '盒', image: '/images/source-72.png', sliderImage: '["/images/source-72.png"]',
        stock: 10, price: '15.00', isShow: 1, isVerify: 1,
        freight: 2, postage: '3.00', tempId: 0, deliveryType: '1', customForm: '[]' },
      { id: 73, type: 1, relationId: 11, pid: 0, storeName: '门店来源商品',
        unitName: '个', image: '/images/source-73.png', sliderImage: '["/images/source-73.png"]',
        stock: 6, price: '12.00', isShow: 1, isVerify: 1,
        freight: 3, tempId: 11, deliveryType: '1,2', customForm: '[]' },
    ]);
    await f.db.update(storeProductAttrValue).set({ type: 0, unique: 'base0070', suk: '红',
      stock: 8, sumStock: 8, sales: 0, price: '10.00', cost: '2.00',
      settlePrice: '2.50', otPrice: '15.00', vipPrice: '0.00', integral: 0,
      image: '/images/source-red.png', weight: '0.25', volume: '0.10',
      barCode: 'SOURCE-RED', code: 'SOURCE-70-RED', quota: 0,
      isRetired: 0, brokerage: '0.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductAttrValue).values([
      { id: 81, productId: 70, type: 0, unique: 'blue0070', suk: '蓝',
        stock: 12, sumStock: 12, price: '12.00', cost: '4.00', settlePrice: '4.50',
        otPrice: '18.00', image: '/images/source-blue.png', weight: '0.50',
        volume: '0.20', barCode: 'SOURCE-BLUE', code: 'SOURCE-70-BLUE' },
      { id: 82, productId: 72, type: 0, unique: 'base0072', suk: '默认',
        stock: 10, sumStock: 10, price: '15.00', cost: '3.00',
        image: '/images/source-72.png', weight: '1.00', volume: '0.30', code: 'SOURCE-72' },
      { id: 83, productId: 73, type: 0, unique: 'base0073', suk: '默认',
        stock: 6, sumStock: 6, price: '12.00', cost: '1.00', image: '/images/source-73.png' },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),83,true)");
    await f.db.insert(storeProductAttr).values([
      { productId: 70, type: 0, attrName: '颜色', attrValues: '红,蓝' },
      { productId: 72, type: 0, attrName: '规格', attrValues: '默认' },
      { productId: 73, type: 0, attrName: '规格', attrValues: '默认' },
    ]);
    for (const productId of [70, 72, 73]) {
      const attrs = await f.db.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, productId), eq(storeProductAttr.type, 0)));
      const values = await f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0)));
      await f.db.insert(storeProductAttrResult).values({ productId, type: 0,
        result: JSON.stringify({ attr: attrs.map(a => ({ value: a.attrName, detail: a.attrValues.split(',') })),
          value: values.map(v => ({ detail: { [attrs[0].attrName]: v.suk }, price: v.price, pic: v.image })) }) });
      await f.db.insert(storeProductDescription).values({ productId, type: 0, description: `<p>源商品${productId}详情</p>` });
    }
    await f.db.insert(storeProductCategory).values([
      { id: 20, type: 0, relationId: 0, pid: 0, cateName: '批量根分类', isShow: 1 },
      { id: 21, type: 0, relationId: 0, pid: 20, cateName: '批量子分类', isShow: 1 },
    ]);
    await f.db.insert(storeProductLabel).values({ id: 22, type: 0, relationId: 0,
      labelName: '批量隐藏标签', status: 0, isShow: 0 });
    await f.db.insert(storeProductRelation).values([
      { productId: 70, relationId: 21, type: 1, status: 0 },
      { productId: 70, relationId: 22, type: 3, status: 0 },
      { productId: 72, relationId: 20, type: 1, status: 0 },
    ]);
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
        attDir: '/api/assets/41', name: 'attachments/admin/1/sku.png', attType: 'image/png' },
      { attId: 43, type: 4, relationId: 7, moduleType: 1, fileType: 1, imageType: 8,
        attDir: '/api/assets/43', name: 'attachments/supplier/7/sku.png', attType: 'image/png' },
    ]);
    const container = createContainerFromDb(f.db);
    const serviceFor = (db: DbClient = f.db) => new AdminIntegralBatchService(createContainerFromDb(db), env.APP_KEY);
    const snapshot = async () => ({
      products: await f.db.select().from(storeProduct).orderBy(asc(storeProduct.id)),
      skus: await f.db.select().from(storeProductAttrValue).orderBy(asc(storeProductAttrValue.id)),
      integrals: await f.db.select().from(storeIntegral).orderBy(asc(storeIntegral.id)),
      attrs: await f.db.select().from(storeProductAttr).orderBy(asc(storeProductAttr.id)),
      results: await f.db.select().from(storeProductAttrResult).orderBy(asc(storeProductAttrResult.id)),
      descriptions: await f.db.select().from(storeProductDescription).orderBy(asc(storeProductDescription.type), asc(storeProductDescription.productId)),
      logs: await f.db.select().from(systemLog).orderBy(asc(systemLog.id)),
    });
    const input = async (ids = [70, 72]) => ({ request_id: crypto.randomUUID(), is_show: 1,
      products: await Promise.all(ids.map(async productId => {
        const source = await serviceFor().source(productId);
        return { product_id: productId, revision: source.revision,
          skus: source.skus.map(s => ({ base_unique: s.base_unique,
            price: s.base_unique === 'base0070' ? '9.00' : '4.25',
            integral: s.base_unique === 'base0070' ? 5 : 10,
            quota: s.base_unique === 'blue0070' ? 8 : 5,
            image: s.image })) };
      })) });
    return { ...f, checkout, env, container, serviceFor, snapshot, input };
  } catch (error) { await f.close(); throw error; }
}
