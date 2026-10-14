import { createContainerFromDb } from '@/lib/di';
import { storeProductReply, storeProductReplyComment, storeProduct, storeProductAttrValue,
  storeOrder, storeOrderCartInfo, user, userRelation, systemUserLevel, userLevel,
  systemAdmin, systemRole, systemMenus, systemLog, systemConfig } from '@/models/schema';
import { AdminProductReplyService } from '@/services/admin/AdminProductReplyService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './financePostgres';

export const replySchema = { storeProductReply, storeProductReplyComment, storeProduct, storeProductAttrValue,
  storeOrder, storeOrderCartInfo, user, userRelation, systemUserLevel, userLevel,
  systemAdmin, systemRole, systemMenus, systemLog, systemConfig };
export const replyActor = (id = 101) => ({ id, authVersion: md5('reply-fixture-password'),
  expiresAt: Math.floor(Date.now() / 1000) + 3600 });
export const replyBody = (content = '平台回复内容') => ({ content });
export const replyEpoch = (day: number, hour = 12) => Math.floor(Date.parse(`2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`) / 1000);

export async function seedReplies(db: ReturnType<typeof createContainerFromDb>['db']) {
  await db.insert(systemRole).values([{ id: 1, rules: 'reply.manage' }, { id: 2, rules: 'reply.view' },
    { id: 3, rules: 'product.manage' }, { id: 4, rules: 'user.manage' }, { id: 5, rules: '188,189' },
    { id: 6, rules: '190' }, { id: 7, rules: '6' }, { id: 8, rules: '580' }]);
  await db.insert(systemMenus).values([
    { id: 6, type: 1, authType: 1, apiUrl: '', methods: '', menuPath: '/admin/product/product_reply', uniqueAuth: 'product-product-reply' },
    { id: 188, type: 1, authType: 2, apiUrl: 'product/reply/<id>', methods: 'DELETE', menuPath: '/adminproduct/reply/<id>' },
    { id: 189, type: 1, authType: 2, apiUrl: 'product/reply/set_reply/<id>', methods: 'PUT', menuPath: '/adminreply/set_reply/<id>' },
    { id: 190, type: 1, authType: 2, apiUrl: 'product/reply', methods: 'GET', menuPath: '/adminproduct/reply' },
    { id: 580, type: 1, authType: 1, apiUrl: '', methods: '', menuPath: '/admin*', uniqueAuth: '' },
  ]);
  await db.insert(systemAdmin).values([100, 101, 102, 103, 104, 105, 106, 107, 108].map(id => ({ id,
    account: `reply-${id}`, pwd: 'reply-fixture-password', level: id === 100 ? 0 : 1,
    roles: id === 100 ? '' : String(id - 100) })));
  await db.insert(systemConfig).values([
    { id: 1, menuName: 'site_name', value: '"评价测试商城"' },
    { id: 2, menuName: 'site_logo_square', value: '"https://fixture.invalid/site.png"' },
    { id: 3, menuName: 'member_func_status', value: '1' },
    { id: 4, menuName: 'member_card_status', value: '1' },
  ]);
  await db.insert(systemUserLevel).values({ id: 1, name: '等级名称不是 PHP level_name', grade: 3, isShow: 1 });
  await db.insert(user).values([
    { uid: 1, nickname: '客户张三', avatar: 'https://fixture.invalid/user-1.png', level: 1,
      isMoneyLevel: 1, overdueTime: 2147483647 },
    { uid: 2, nickname: '客户李四', avatar: 'https://fixture.invalid/user-2.png', isEverLevel: 1 },
  ]);
  await db.insert(storeProduct).values([
    { id: 10, storeName: '平台保温杯', keyword: '钢材关键词', image: 'https://fixture.invalid/product-10.png', stock: 9, price: '12.00' },
    { id: 20, type: 2, relationId: 20, storeName: '供应商保温杯', stock: 7, price: '23.00' },
    { id: 30, type: 1, relationId: 30, storeName: '门店商品', stock: 5 },
  ]);
  await db.insert(storeOrder).values({ id: 70, uid: 1, orderId: 'reply-fixture-order', paid: 1, status: 2, payPrice: '12.00' });
  await db.insert(storeOrderCartInfo).values({ id: 71, uid: 1, oid: 70, productId: 10, skuUnique: 'replysku', cartNum: 1 });
  await db.insert(storeProductAttrValue).values({ id: 72, productId: 10, unique: 'replysku', suk: '蓝', stock: 9, price: '12.00' });
  await db.insert(storeProductReply).values([
    { id: 10, productId: 10, oid: 70, orderCartInfoId: 71, unique: 'customer-evidence', uid: 1,
      nickname: '评价快照张三', comment: '客户原始评价正文', sku: '蓝', skuUnique: 'replysku',
      productScore: 5, serviceScore: 4, deliveryScore: 3, logisticsScore: 3,
      pics: '["https://fixture.invalid/review.png"]', praise: 7, viewsNum: 9, status: 0, addTime: replyEpoch(2) },
    { id: 11, productId: 10, uid: 2, nickname: '评价快照李四', comment: '平台已回复', isReply: 1, addTime: replyEpoch(1) },
    { id: 20, type: 2, relationId: 20, productId: 20, uid: 1, nickname: '供应商客户', comment: '供应商客户评价', addTime: replyEpoch(3) },
    { id: 30, type: 1, relationId: 30, productId: 30, uid: 2, nickname: '门店客户', comment: '门店客户评价', addTime: replyEpoch(4) },
    { id: 40, productId: 404, uid: 1, nickname: '历史缺商品客户', comment: '缺失商品仍可管理的评价', addTime: replyEpoch(5) },
    { id: 50, productId: 10, uid: 1, comment: '已软删证据', isDel: 1, addTime: replyEpoch(6) },
  ]);
  await db.insert(storeProductReplyComment).values([
    { id: 100, replyId: 10, uid: 1, content: '用户一级评论', praise: 5, addTime: replyEpoch(2) },
    { id: 101, replyId: 10, uid: 2, content: '另一用户一级评论', praise: 2, addTime: replyEpoch(3) },
    { id: 102, replyId: 10, pid: 100, uid: 2, content: '用户直属孩子', praise: 1, addTime: replyEpoch(4) },
    { id: 110, type: 2, relationId: 20, replyId: 20, uid: 0, content: '供应商自己的一级回复', addTime: replyEpoch(3) },
    // Public/PHP customer comments keep 0/0 even on a Supplier review.
    { id: 120, replyId: 20, uid: 1, content: '供应商评价下的平台 tuple 用户评论', addTime: replyEpoch(3) },
    { id: 200, replyId: 11, uid: 0, content: '现有平台一级回复', addTime: replyEpoch(1) },
  ]);
  await db.insert(userRelation).values([
    { id: 1, uid: 1, relationId: 100, type: 'like', category: 'comment', addTime: replyEpoch(2) },
    { id: 2, uid: 2, relationId: 102, type: 'like', category: 'comment', addTime: replyEpoch(4) },
  ]);
}

export async function productReplyFixture() {
  const f = await financePostgres(Object.values(replySchema), { namespace: 'public' });
  await seedReplies(f.db);
  await f.exec("SELECT setval(pg_get_serial_sequence('store_product_reply_comment','id'),1000,false)");
  const container = createContainerFromDb(f.db);
  return { ...f, container, service: new AdminProductReplyService(container) };
}
