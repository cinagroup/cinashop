import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductReply, storeProductCategory,
  storeProductRelation, storeProductLabel, storeProductDescription, liveGoods, storeOrderStatus, luckLottery, luckLotteryEntitlement,
  systemMenus, systemAdmin, systemRole, systemAttachment } from '@/models/schema';
import { AdminProductFictitiousReplyService } from '@/services/admin/AdminProductFictitiousReplyService';
import { financePostgres } from './financePostgres';
import { replyActor, replySchema, seedReplies } from './adminProductReplies';

export const fictitiousSchema = { ...replySchema, storeProductCategory, storeProductRelation,
  storeProductLabel, storeProductDescription, liveGoods, storeOrderStatus, luckLottery, luckLotteryEntitlement, systemAttachment };
export const fictitiousActor = replyActor;
export const fictitiousAttachment = (attId = 31) => ({ attId, type: 1, fileType: 1, relationId: 0,
  moduleType: 1, imageType: 8, name: `attachments/admin/1/2026/10/fictitious-${attId}.png`,
  attDir: `/api/assets/${attId}`, sattDir: `/api/assets/${attId}`, attSize: '68', attType: 'image/png',
  pid: 0, time: 1_797_000_000, realName: `平台素材-${attId}.png`, scanToken: '' });
export const fictitiousPrivateMediaBody = () => fictitiousBody({ avatar: '/api/assets/31', pics: ['/api/assets/31'] });
/** Actual addReply.vue payload: image carries the selected product; unique is a SKU alias. */
export const fictitiousBody = (overrides: Record<string, unknown> = {}) => ({
  image: { image: 'https://fixture.invalid/product-10.png', product_id: 10 },
  unique: 'replysku', avatar: '/uploads/virtual-avatar.png', nickname: '运营自评昵称',
  comment: '自评正文，不能绑定真实顾客或订单', product_score: 2, service_score: 4,
  delivery_score: 3, reply_score: '2', pics: ['/uploads/virtual-review.png'],
  add_time: '2026-08-02 12:00:00', ...overrides,
});

export async function seedFictitiousReplies(db: DbClient) {
  await seedReplies(db);
  await db.insert(systemRole).values([
    { id: 9, rules: '184' }, { id: 10, rules: '185' }, { id: 11, rules: '579' },
    { id: 12, rules: '999' }, { id: 13, rules: 'product.view' }, { id: 14, rules: '193' },
    { id: 15, rules: 'reply.manage,product.view' },
    { id: 16, rules: 'reply.manage,product.view,attachment.view' }, { id: 17, rules: 'attachment.view' },
  ]);
  await db.insert(systemAdmin).values([109, 110, 111, 112, 113, 114, 115, 116, 117].map(id => ({ id,
    account: `fictitious-${id}`, pwd: 'reply-fixture-password', level: 1, roles: String(id - 100) })));
  await db.insert(systemMenus).values([
    { id: 184, type: 1, authType: 2, apiUrl: 'product/reply/fictitious_reply/<product_id>', methods: 'GET', menuPath: '/adminproduct/reply/fictitious_reply', uniqueAuth: '' },
    { id: 185, type: 1, authType: 2, apiUrl: 'product/reply/save_fictitious_reply', methods: 'POST', menuPath: '/adminproduct/reply/save_fictitious_reply', uniqueAuth: 'product-reply-save_fictitious_reply' },
    { id: 193, type: 1, authType: 2, apiUrl: 'product/product/list', methods: 'GET', menuPath: '/adminproduct/product/list', uniqueAuth: '' },
    { id: 579, type: 1, authType: 1, apiUrl: '', methods: '', menuPath: '/admin*', uniqueAuth: '' },
    { id: 999, type: 1, authType: 2, apiUrl: 'product/reply/save_fictitious_reply', methods: 'POST', menuPath: '/adminproduct/reply/save_fictitious_reply', uniqueAuth: 'product-reply-save_fictitious_reply' },
  ]);
  await db.update(storeProduct).set({ isVerify: 1, cateId: '2', sliderImage: '["/uploads/product.png"]' }).where(eq(storeProduct.id, 10));
  await db.update(storeProduct).set({ isVerify: 1, isShow: 0, storeLabelId: '1' }).where(eq(storeProduct.id, 20));
  await db.update(storeProduct).set({ isVerify: 1 }).where(eq(storeProduct.id, 30));
  await db.insert(storeProduct).values([
    { id: 41, storeName: '待审核不可新建', isVerify: 0 },
    { id: 42, storeName: '已删除不可新建', isVerify: 1, isDel: 1 },
    { id: 43, storeName: '合法 VIP 产品', isVerify: 1, isVipProduct: 1, isNew: 0 },
    { id: 44, storeName: '合法预售产品', isVerify: 1, isPresaleProduct: 1, isNew: 1 },
  ]);
  await db.insert(storeProductAttrValue).values([
    { id: 73, productId: 20, unique: 'supplysk', suk: '供应商蓝色', type: 0, stock: 7 },
    { id: 74, productId: 10, unique: 'retireds', suk: '退役规格', type: 0, isRetired: 1, retiredAt: 100, retiredBy: 101, retireReason: '已退役' },
    { id: 75, productId: 10, unique: 'seckills', suk: '活动规格', type: 1 },
    { id: 76, productId: 30, unique: 'storesku', suk: '门店规格', type: 0 },
  ]);
  await db.insert(storeProductReply).values([
    { id: 60, productId: 10, type: 2, relationId: 20, uid: 1, comment: '跨 owner 同商品计入评分', productScore: 4, status: 0 },
    { id: 61, productId: 10, type: 1, relationId: 30, uid: 0, comment: '隐藏自评同样计入评分', productScore: 1, status: 0 },
  ]);
  await db.insert(storeProductCategory).values([
    { id: 1, cateName: '根分类' }, { id: 2, pid: 1, cateName: '子分类', path: '1', level: 1 },
  ]);
  await db.insert(storeProductLabel).values({ id: 1, labelName: '可选择标签' });
  await db.insert(storeProductRelation).values([
    { id: 1, type: 1, productId: 10, relationId: 2, relationPid: 1 },
    { id: 2, type: 1, productId: 20, relationId: 2, relationPid: 1 },
    { id: 3, type: 3, productId: 20, relationId: 1 },
    { id: 4, type: 3, productId: 43, relationId: 4 },
  ]);
  await db.insert(storeProductDescription).values({ productId: 10, type: 0, description: '<p>商品详情 Unicode 😀</p>' });
  await db.insert(systemAttachment).values([
    fictitiousAttachment(),
    { ...fictitiousAttachment(32), type: 4, relationId: 20, name: 'attachments/supplier/20/2026/10/foreign.png' },
    { ...fictitiousAttachment(33), type: 3, relationId: 1, moduleType: 3, name: 'attachments/user/1/2026/10/private.png' },
    { ...fictitiousAttachment(34), name: 'attachments/admin/1/../foreign.png' },
    { ...fictitiousAttachment(35), attType: 'text/html' },
    { ...fictitiousAttachment(36), moduleType: 3 },
    { ...fictitiousAttachment(37), imageType: 1 },
    { ...fictitiousAttachment(38), attDir: '/api/assets/31' },
  ]);
}

export async function resetFictitiousSequences(exec: (statement: string) => Promise<unknown>) {
  await exec("SELECT setval(pg_get_serial_sequence('store_product_reply','id'),1000,false)");
  await exec("SELECT setval(pg_get_serial_sequence('store_product_reply_comment','id'),1000,false)");
  await exec("SELECT setval(pg_get_serial_sequence('user_relation','id'),2,true)");
}

export async function fictitiousReplyFixture() {
  const f = await financePostgres(Object.values(fictitiousSchema), { namespace: 'public' });
  await seedFictitiousReplies(f.db); await resetFictitiousSequences(f.exec);
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductFictitiousReplyService(container) };
}
