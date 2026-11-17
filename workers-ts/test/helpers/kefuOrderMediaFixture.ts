import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderPromotions,
  storeOrderRefund, storeProduct,
} from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { kefuProductMediaFixture } from './kefuProductMediaFixture';

type ProductMediaFixture = Awaited<ReturnType<typeof kefuProductMediaFixture>>;
export type KefuOrderMediaExec = ProductMediaFixture['exec'];
export type KefuOrderMediaReferences = ProductMediaFixture['refs'];
type RuntimePeer = Parameters<ProductMediaFixture['installPlan']>[0];
type StateRow = Record<string, unknown>;
type OrderSeed = typeof storeOrder.$inferInsert & { id: number };
type CartSeed = typeof storeOrderCartInfo.$inferInsert & { id: number };
type RefundSeed = typeof storeOrderRefund.$inferInsert & { id: number };

const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned Kefu order media fixture identifier');
  return `"${value}"`;
};
const additionalTables = [storeOrderRefund, storeOrderInvoice, storeOrderPromotions] as const;

export const kefuOrderMediaIds = {
  kefuUid: 101, targetKefuUid: 102, customerUid: 201, foreignUid: 202,
  supplierId: 310, foreignSupplierId: 320, storeId: 77,
  orders: {
    history: 7201, active: 7202, unpaid: 7203, foreign: 7204, systemDeleted: 7205,
    store: 7206, child: 7207, userDeleted: 7208, refundExcluded: 7209, completed: 7210,
  },
  carts: {
    platform: 8301, supplier: 8302, store: 8303, foreignAttachment: 8304,
    userAttachment: 8305, legacy: 8306, empty: 8307, duplicate: 8308,
    forgedOwner: 8309, promotion: 8310, activePlatform: 8311, activeSupplier: 8312,
    activeStore: 8313, unpaid: 8314, foreign: 8315, completed: 8316,
  },
  refunds: {
    selected: 9201, returning: 9202, completed: 9203, rejected: 9204,
    unprocessed: 9205, returnRequested: 9206, received: 9207,
    cancelled: 9208, deleted: 9209, foreign: 9210,
  },
  invoiceId: 9401, promotionsId: 9501,
} as const;

/** Snapshots deliberately disagree with the current product catalog. Owner
 * claims in either JSON shape are untrusted; only each persisted cart row's
 * dedicated type/relation_id may authorize a registered picture. */
export function kefuOrderMediaSeeds(refs: KefuOrderMediaReferences) {
  const ids = kefuOrderMediaIds;
  const commonOrder = {
    uid: ids.customerUid, realName: '历史订单客户', userPhone: '13900000201',
    province: '历史省份', userAddress: '历史订单地址一号', freightPrice: '1.23',
    totalNum: 1, totalPrice: '79.00', totalPostage: '1.23', payPrice: '74.56',
    payPostage: '1.23', deductionPrice: '0.11', couponPrice: '0.22',
    promotionsPrice: '0.33', firstOrderPrice: '0.44', paid: 1, status: 0,
    shippingType: 1, payType: 'weixin', payTime: 1_700_000_510,
    addTime: 1_700_000_500, deliveryType: 'express', deliveryName: '历史快递',
    deliveryCode: 'owned-history', deliveryId: 'OWNED-HISTORY-TRACK',
    mark: '保留历史订单备注', remark: '保留客服订单备注',
  } satisfies typeof storeOrder.$inferInsert;
  const order = (id: number, name: string, overrides: Partial<OrderSeed> = {}): OrderSeed => ({
    ...commonOrder, id, orderId: `kefu-order-media-${name}`, unique: `owned-order-${id}`,
    verifyCode: `SECRET${id}`, userIp: `10.0.0.${id % 100}`,
    ...overrides,
  });
  const orders: OrderSeed[] = [
    order(ids.orders.history, 'history', { totalNum: 11, type: 7, supplierId: ids.foreignSupplierId }),
    order(ids.orders.active, 'active', { totalNum: 3, refundStatus: 1, refundType: 1,
      payType: 'yue', addTime: 1_700_000_600 }),
    order(ids.orders.unpaid, 'unpaid', { paid: 0, payTime: 0, addTime: 1_700_000_700 }),
    order(ids.orders.foreign, 'foreign', { uid: ids.foreignUid, realName: 'PRIVATE OTHER CUSTOMER',
      userPhone: '13900000202', userAddress: 'PRIVATE OTHER ADDRESS' }),
    order(ids.orders.systemDeleted, 'system-deleted', { isSystemDel: 1 }),
    order(ids.orders.store, 'store-only', { storeId: ids.storeId }),
    order(ids.orders.child, 'child', { pid: ids.orders.history }),
    order(ids.orders.userDeleted, 'user-deleted', { isDel: 1 }),
    order(ids.orders.refundExcluded, 'refund-excluded', { refundType: 2, refundStatus: 1 }),
    order(ids.orders.completed, 'completed', { status: 3, addTime: 1_700_000_800 }),
  ];
  const legacy = (name: string, image: unknown, productId = 501) => ({
    product: { id: productId, store_name: name, image: refs.user, price: '19.99', type: 2, relation_id: 320 },
    sku: { suk: '购买时规格', image, price: '12.34' },
    truePrice: '12.34', vip_truePrice: '0.11', postage_price: '0.12',
    coupon_price: '0.13', integral_price: '0.14', promotions_true_price: '0.15',
  });
  const modern = (name: string, image: unknown, productId = 502) => ({
    product: { id: productId, store_name: '不得降级到旧商品字段', image: refs.user, price: '99.99' },
    productInfo: { id: productId, store_name: name, image: refs.foreign, price: '23.45',
      type: 0, relation_id: 0, attrInfo: { suk: '购买时规格', image, price: '21.23' } },
    true_price: '21.23', vip_true_price: '0.22', postagePrice: '0.23',
    couponPrice: '0.24', integralPrice: '0.25', promotionsTruePrice: '0.26',
  });
  const cart = (id: number, cartId: string, snapshot: unknown, overrides: Partial<CartSeed> = {}): CartSeed => ({
    id, oid: ids.orders.history, uid: ids.customerUid, cartId, type: 0, relationId: 0,
    productId: 501, productType: 0, skuUnique: `owned-sku-${id}`, unique: `owned-line-${id}`,
    cartNum: 1, refundNum: 0, surplusNum: 1, isGift: 0, isSupportRefund: 1,
    cartInfo: JSON.stringify(snapshot), addTime: 1_700_000_500, ...overrides,
  });
  const promotionAllocation = { promotionId: 101, rootId: 101, type: 1,
    savingsCents: 50, discountQuantity: 1, labelIds: [], name: '历史半价促销' };
  const promotion = {
    product: { id: 501, store_name: '历史精确促销商品', image: refs.platform, price: '1.00' },
    cart_num: 2, sku: { price: '0.67', suk: '历史混合价格', image: refs.platform },
    vip_truePrice: '0.07', coupon_price: '0.05', integral_price: '0.00',
    first_order_price: '0.00', sum_true_price: '1.30',
    promotion_quote_version: 'order-promotion-quote-v1', promotion_line_price: '1.35',
    promotion_line_savings: '0.50', promotion_line_member_savings: '0.15',
    promotion_discount_quantity: 1, promotion_allocations: [promotionAllocation],
    promotion_segments: [
      { quantity: 1, rawGrossCents: 100, totalPriceCents: 50, unitPriceCents: 50,
        membershipSavingsCents: 0, promotionIds: [101], promotionAllocations: [promotionAllocation], couponEligibleGrossCents: 0 },
      { quantity: 1, rawGrossCents: 100, totalPriceCents: 85, unitPriceCents: 85,
        membershipSavingsCents: 15, promotionIds: [], promotionAllocations: [], couponEligibleGrossCents: 85 },
    ],
  };
  const carts: CartSeed[] = [
    cart(ids.carts.platform, 'snapshot-platform', legacy('历史平台快照商品', refs.platform)),
    cart(ids.carts.supplier, 'snapshot-supplier', modern('历史供应商快照商品', refs.supplier),
      { type: 2, relationId: ids.supplierId, productId: 502 }),
    cart(ids.carts.store, 'snapshot-store', {
      productInfo: { id: 503, store_name: '历史门店快照商品', image: refs.platform, price: '34.56',
        attrInfo: { suk: '历史门店规格', price: '32.10' } }, truePrice: '32.10', vip_truePrice: '0.33',
    }, { type: 1, relationId: ids.storeId, productId: 503 }),
    cart(ids.carts.foreignAttachment, 'snapshot-foreign-asset', modern('外属附件不应签名', refs.foreign),
      { type: 2, relationId: ids.supplierId, productId: 502 }),
    cart(ids.carts.userAttachment, 'snapshot-user-asset', legacy('用户附件不应签名', refs.user)),
    cart(ids.carts.legacy, 'snapshot-legacy', legacy('历史外链图片商品', 'https://legacy.example.test/order-snapshot.png?v=1&x=2')),
    cart(ids.carts.empty, 'snapshot-empty', {
      productInfo: { id: 501, store_name: '显式空图片保持空', image: refs.platform, price: '4.56',
        attrInfo: { image: '', suk: '空图片规格', price: '4.56' } }, truePrice: '4.56',
    }),
    cart(ids.carts.duplicate, 'snapshot-duplicate', legacy('历史平台快照重复商品', refs.platform)),
    cart(ids.carts.forgedOwner, 'snapshot-forged-owner', {
      ...modern('JSON 归属不能授权', refs.supplier), type: 2, relation_id: ids.supplierId,
      productInfo: { id: 502, store_name: 'JSON 归属不能授权', image: refs.supplier,
        type: 2, relation_id: ids.supplierId, attrInfo: { image: refs.supplier, suk: '伪造归属', price: '21.23' } },
    }, { productId: 502 }),
    cart(ids.carts.promotion, 'snapshot-promotion', promotion, { cartNum: 2, surplusNum: 2 }),
    cart(ids.carts.activePlatform, 'active-platform', legacy('售后平台历史商品', refs.platform), { oid: ids.orders.active }),
    cart(ids.carts.activeSupplier, 'active-supplier', modern('售后供应商历史商品', refs.supplier),
      { oid: ids.orders.active, type: 2, relationId: ids.supplierId, productId: 502 }),
    cart(ids.carts.activeStore, 'active-store', modern('售后门店历史商品', refs.platform, 503),
      { oid: ids.orders.active, type: 1, relationId: ids.storeId, productId: 503 }),
    cart(ids.carts.unpaid, 'unpaid-platform', legacy('未付款历史商品', refs.platform), { oid: ids.orders.unpaid }),
    cart(ids.carts.foreign, 'foreign-platform', legacy('PRIVATE OTHER ORDER ITEM', refs.platform),
      { oid: ids.orders.foreign, uid: ids.foreignUid }),
    cart(ids.carts.completed, 'completed-platform', legacy('已完成历史商品', refs.platform), { oid: ids.orders.completed }),
  ];
  const refund = (id: number, name: string, overrides: Partial<RefundSeed> = {}): RefundSeed => ({
    id, uid: ids.customerUid, storeOrderId: ids.orders.history, orderId: `kefu-refund-media-${name}`,
    supplierId: ids.foreignSupplierId, applyType: 1, applyPrice: '21.23', refundType: 1,
    refundNum: 1, refundPrice: '21.23', refundedPrice: '0.00', refundReason: '保留历史退款原因',
    refundGoodsType: 1, refundPhone: '13900000201', refundExpress: `OWNED-RETURN-${id}`,
    refundExpressName: '历史退货快递', refundExplain: '保留退款说明', remark: '保留退款备注',
    cartInfo: JSON.stringify([{ cart_id: 'snapshot-supplier' }]),
    isCancel: 0, isDel: 0, addTime: 1_700_001_000 + (9300 - id) * 10, ...overrides,
  });
  const refunds: RefundSeed[] = [
    refund(ids.refunds.selected, 'selected', { refundNum: 2, refundPrice: '53.33',
      // Repeated selectors are a set; JSON images/owners are not authority.
      cartInfo: JSON.stringify([{ cart_id: 'snapshot-supplier', image: refs.user, type: 0, relation_id: 0 },
        { id: ids.carts.store }, { cart_id: 'snapshot-supplier' }]) }),
    refund(ids.refunds.returning, 'returning', { storeOrderId: ids.orders.active, refundType: 4,
      refundNum: 2, refundPrice: '33.57', applyType: 2,
      cartInfo: JSON.stringify({ cart_ids: ['active-platform', ids.carts.activeSupplier] }) }),
    refund(ids.refunds.completed, 'completed', { refundType: 6, refundedPrice: '21.23', refundedTime: 1_700_002_000,
      cartInfo: JSON.stringify([ids.carts.platform]) }),
    refund(ids.refunds.rejected, 'rejected', { refundType: 3, refuseReason: '保留拒绝原因' }),
    refund(ids.refunds.unprocessed, 'unprocessed', { refundType: 0 }),
    refund(ids.refunds.returnRequested, 'return-requested', { refundType: 2, applyType: 2 }),
    refund(ids.refunds.received, 'received', { refundType: 5, applyType: 2,
      cartInfo: JSON.stringify({ cartIds: ['snapshot-store'] }) }),
    refund(ids.refunds.cancelled, 'cancelled', { isCancel: 1 }),
    refund(ids.refunds.deleted, 'deleted', { isDel: 1 }),
    refund(ids.refunds.foreign, 'foreign', { uid: ids.foreignUid, storeOrderId: ids.orders.foreign,
      cartInfo: JSON.stringify(['foreign-platform']), refundReason: 'PRIVATE OTHER REFUND' }),
  ];
  const invoices: (typeof storeOrderInvoice.$inferInsert)[] = [{
    id: ids.invoiceId, uid: ids.customerUid, orderId: ids.orders.history, invoiceId: 9411,
    headerType: 2, type: 1, name: '历史订单发票抬头', dutyNumber: 'OWNED-HISTORY-TAX',
    drawerPhone: '13900000201', email: 'owned-history@example.test', isPay: 1, isRefund: 0,
    isInvoice: 1, invoiceNumber: 'OWNED-HISTORY-INVOICE', invoiceAmount: '74.56',
    remark: '保留发票备注', invoiceTime: 1_700_000_900, isDel: 0, addTime: 1_700_000_800,
  }];
  const promotions: (typeof storeOrderPromotions.$inferInsert)[] = [{
    id: ids.promotionsId, oid: ids.orders.history, uid: ids.customerUid, promotionsId: 101,
    productId: 501, promotionsPrice: '0.50', addTime: 1_700_000_500,
  }];
  return {
    orders, carts, refunds, invoices, promotions,
    expectedCustomerOrderIds: [ids.orders.completed, ids.orders.unpaid, ids.orders.active, ids.orders.history],
    expectedCustomerActiveRefundIds: [ids.refunds.selected, ids.refunds.returning, ids.refunds.unprocessed,
      ids.refunds.returnRequested, ids.refunds.received],
    expectedRefundListIds: [ids.refunds.selected, ids.refunds.returning, ids.refunds.completed,
      ids.refunds.rejected, ids.refunds.unprocessed, ids.refunds.returnRequested, ids.refunds.received],
    selectedRefundCartIds: [ids.carts.supplier, ids.carts.store],
    returningRefundCartIds: [ids.carts.activePlatform, ids.carts.activeSupplier],
  };
}

/** Discover the entire random owned database each time, so a browser harness
 * adding adjacent tables or sequences cannot silently escape GET snapshots. */
export async function discoverOwnedKefuOrderMediaInventory(exec: KefuOrderMediaExec) {
  const [identity] = await exec("SELECT current_database() AS name,current_setting('server_version_num') AS version");
  if (!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(String(identity?.name))
    || Math.floor(Number(identity?.version) / 10_000) !== 16) {
    throw Error('Order media state snapshots require the owned native PG16 database');
  }
  const schemas = await exec("SELECT nspname AS name FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname");
  if (JSON.stringify(schemas.map(row => String(row.name))) !== JSON.stringify(['public'])) {
    throw Error('Unexpected non-system schema in owned Kefu order media database');
  }
  const tables = (await exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
  const sequences = (await exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
  [...tables, ...sequences].forEach(identifier);
  return { tables, sequences };
}

export async function snapshotOwnedKefuOrderMediaState(exec: KefuOrderMediaExec) {
  const { tables, sequences } = await discoverOwnedKefuOrderMediaInventory(exec);
  const state: Record<string, StateRow[]> = {};
  for (const name of tables) {
    const [row] = await exec(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public.${identifier(name)} t`);
    if (!Array.isArray(row?.rows)) throw Error('Incomplete Kefu order media business table snapshot');
    state[name] = row.rows as StateRow[];
  }
  state.__sequences = sequences.length ? await exec(sequences.map(name =>
    `SELECT '${name}'::text AS name,last_value::text AS last_value,is_called FROM public.${identifier(name)}`
  ).join(' UNION ALL ') + ' ORDER BY name') : [];
  return state;
}

/** Thin extension of the existing real LOGIN/Hono/media fixture. It adds only
 * order-domain SQL tables and data. Infrastructure counters, real PNG bytes,
 * ordinary app privileges, signing and authorization remain the base behavior. */
export async function kefuOrderMediaFixture() {
  const base = await kefuProductMediaFixture();
  try {
    const dialect = new PgDialect();
    for (const table of additionalTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const value = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL
          ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${value}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}${column.isUnique ? ' UNIQUE' : ''}`;
      });
      await base.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    await base.exec('CREATE INDEX sor_store_order_id ON public.store_order_refund(store_order_id)');
    await base.exec('CREATE INDEX sor_uid_idx ON public.store_order_refund(uid)');
    await base.exec('CREATE INDEX sor_kefu_customer_refunds ON public.store_order_refund(uid,add_time DESC,id DESC) WHERE is_cancel=0 AND is_del=0');
    await base.exec('CREATE INDEX sor_order_id ON public.store_order_refund(order_id)');
    await base.exec('CREATE INDEX sor_cancel_oid_idx ON public.store_order_refund(is_cancel,store_order_id)');
    await base.exec("CREATE INDEX sor_pink_recovery_scan ON public.store_order_refund(id,add_time) WHERE is_cancel=0 AND is_del=0 AND apply_type=1 AND refund_type IN(0,1,2,4,5) AND refund_reason='用户手动取消拼团' AND refund_explain='用户手动取消未成团的拼团订单' AND left(order_id,12)='pink_cancel_'");
    await base.exec('CREATE INDEX soi_order ON public.store_order_invoice(order_id)');
    await base.exec('CREATE INDEX soi_uid_state_time ON public.store_order_invoice(uid,is_del,is_refund,add_time)');
    await base.exec('CREATE INDEX soi_issue_state_time ON public.store_order_invoice(is_pay,is_del,is_invoice,add_time)');
    await base.exec('CREATE INDEX sop_order_promotion ON public.store_order_promotions(oid,promotions_id)');
    await base.exec('CREATE INDEX sop_order_product ON public.store_order_promotions(oid,product_id)');
    await base.exec('CREATE INDEX sop_uid_time ON public.store_order_promotions(uid,add_time)');

    const seeds = kefuOrderMediaSeeds(base.refs);
    const orderRows: (typeof storeOrder.$inferSelect)[] = [];
    const cartRows: (typeof storeOrderCartInfo.$inferSelect)[] = [];
    const refundRows: (typeof storeOrderRefund.$inferSelect)[] = [];
    const reset = async () => {
      for (const table of [...additionalTables].reverse()) await base.db.delete(table);
      await base.reset();
      await base.db.delete(storeOrderCartInfo);
      await base.db.delete(storeOrder);
      await base.db.insert(storeOrder).values(seeds.orders);
      await base.db.insert(storeOrderCartInfo).values(seeds.carts);
      await base.db.insert(storeOrderRefund).values(seeds.refunds);
      await base.db.insert(storeOrderInvoice).values(seeds.invoices);
      await base.db.insert(storeOrderPromotions).values(seeds.promotions);
      // Current catalog data cannot replace or authorize historical snapshots.
      await base.db.update(storeProduct).set({ storeName: 'CURRENT CHANGED CATALOG DO NOT PROJECT',
        image: base.refs.foreign, price: '999.99', type: 2, relationId: kefuOrderMediaIds.foreignSupplierId })
        .where(eq(storeProduct.id, base.productIds.platform));
      await base.db.delete(storeProduct).where(eq(storeProduct.id, base.productIds.supplier));
      orderRows.splice(0, orderRows.length, ...await base.db.select().from(storeOrder).orderBy(storeOrder.id));
      cartRows.splice(0, cartRows.length, ...await base.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id));
      refundRows.splice(0, refundRows.length, ...await base.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id));
      base.resetResources();
    };
    const installPlan = async (peer: RuntimePeer) => {
      await base.installPlan(peer);
      const plan = runtimeBusinessPrivilegePlan('app');
      for (const table of additionalTables) {
        const definition = getTableConfig(table), privileges = plan.tables[definition.name];
        if (!privileges?.includes('SELECT')) throw Error('Actual app cannot read additional Kefu order media table');
        await base.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        const columns = plan.updateColumns[definition.name];
        if (columns?.length) await base.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        if (privileges.includes('INSERT')) for (const column of definition.columns) {
          if (column.getSQLType() === 'serial') await base.exec(`GRANT USAGE ON SEQUENCE public.${identifier(`${definition.name}_${column.name}_seq`)} TO ${identifier(peer.role)}`);
        }
      }
    };
    await reset();
    const inventory = () => discoverOwnedKefuOrderMediaInventory(base.exec);
    const initial = await inventory();
    const expectedTables = [...base.tables, ...additionalTables.map(table => getTableConfig(table).name)].sort();
    const expectedSequences = [...base.sequences, ...additionalTables.flatMap(table => {
      const definition = getTableConfig(table);
      return definition.columns.filter(column => column.getSQLType() === 'serial').map(column => `${definition.name}_${column.name}_seq`);
    })].sort();
    if (JSON.stringify(initial.tables) !== JSON.stringify(expectedTables)
      || JSON.stringify(initial.sequences) !== JSON.stringify(expectedSequences)) {
      throw Error('Incomplete owned Kefu order media table/sequence inventory');
    }
    const snapshot = () => snapshotOwnedKefuOrderMediaState(base.exec);
    return { ...base, reset, installPlan, snapshot, inventory, tables: initial.tables, sequences: initial.sequences,
      ids: kefuOrderMediaIds, seeds, orderRows, cartRows, refundRows };
  } catch (error) {
    await base.close();
    throw error;
  }
}
