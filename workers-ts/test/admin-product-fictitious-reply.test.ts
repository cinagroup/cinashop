import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeProductReply, storeProductReplyComment, storeProduct, storeProductAttrValue,
  storeOrder, storeOrderCartInfo, user, userRelation, systemLog, systemAdmin, systemRole, systemMenus, liveGoods, systemAttachment } from '@/models/schema';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { AdminProductReplyService } from '@/services/admin/AdminProductReplyService';
import { AdminProductFictitiousReplyService } from '@/services/admin/AdminProductFictitiousReplyService';
import { fictitiousReplyFixture, seedFictitiousReplies, resetFictitiousSequences,
  fictitiousActor, fictitiousBody, fictitiousPrivateMediaBody } from './helpers/adminProductFictitiousReplies';

const query = (value = '') => new URLSearchParams(value);
describe('Admin virtual reviews and real PHP commodity selector with SQL business receipts', () => {
  let f: Awaited<ReturnType<typeof fictitiousReplyFixture>>;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Virtual-review fixture forbids remote I/O'));
    f = await fictitiousReplyFixture();
  }, 30000);
  beforeEach(async () => {
    await f.exec(`DROP TRIGGER IF EXISTS fake_reply_dml ON store_product_reply;
      DROP TRIGGER IF EXISTS fake_product_dml ON store_product;
      DROP TRIGGER IF EXISTS fake_audit_dml ON system_log;
      DROP TRIGGER IF EXISTS fake_audit_after ON system_log`);
    await f.reset(); await seedFictitiousReplies(f.db); await resetFictitiousSequences(f.exec);
  }, 30000);
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const create = (body: unknown = fictitiousBody(), actor = fictitiousActor()) => f.service.create(body, actor);
  async function snapshot() {
    return { reviews: await f.db.select().from(storeProductReply).orderBy(storeProductReply.id),
      comments: await f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      customers: await f.db.select().from(user).orderBy(user.uid),
      relations: await f.db.select().from(userRelation).orderBy(userRelation.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
      attachments: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId) };
  }
  async function created() {
    const rows = await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 1000));
    expect(rows).toHaveLength(1); return rows[0];
  }

  it('preserves source zero/positive form fields, submit target, field defaults and path product identity', async () => {
    const form = await f.service.form(0, query(), fictitiousActor(109));
    expect(form).toMatchObject({ title: '添加虚拟评论', action: 'product/reply/save_fictitious_reply', method: 'POST' });
    expect(form.rules.map(rule => rule.field)).toEqual(['image', 'avatar', 'nickname', 'comment', 'product_score', 'service_score', 'pics', 'add_time']);
    expect(form.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'product_score', value: 0 }),
      expect.objectContaining({ field: 'service_score', value: 0 }),
      expect.objectContaining({ field: 'add_time', value: '' }),
    ]));
    const positive = await f.service.form(20, query('product_id=20'), fictitiousActor(107));
    expect(positive.rules[0]).toMatchObject({ type: 'hidden', field: 'product_id', value: 20 });
    expect(positive.rules).toHaveLength(8);
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('returns approved active catalogue across platform/Supplier/store including off-shelf with actual ordinary attrValue rows and count', async () => {
    const all = await f.service.products(query('page=1&limit=100&is_integral=1'), fictitiousActor(114));
    expect(all.count).toBe(5);
    expect(all.list.map(row => row.id).sort((a, b) => a - b)).toEqual([10, 20, 30, 43, 44]);
    const supplier = all.list.find(row => row.id === 20)!;
    expect(supplier).toMatchObject({ id: 20, type: 2, relation_id: 20, is_show: 0,
      attrValue: [{ unique: 'supplysk', suk: '供应商蓝色', product_id: 20, type: 0 }] });
    expect(all.list.find(row => row.id === 10)!.attrValue.map(row => row.unique)).toEqual(['replysku']);
    expect(all.list.find(row => row.id === 10)).toMatchObject({ price: 12, cate_name: '根分类/子分类',
      slider_image: ['/uploads/product.png'], description: '<p>商品详情 Unicode 😀</p>' });
    expect(all.list.find(row => row.id === 10)).not.toHaveProperty('descriptions');
    expect(supplier).toHaveProperty('description', null);
    expect(supplier).not.toHaveProperty('descriptions');
    expect(supplier).toMatchObject({ store_label: '可选择标签' });
    const page = await f.service.products(query('page=2&limit=2'), fictitiousActor(113));
    expect(page.count).toBe(5); expect(page.list).toHaveLength(2);
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('uses actual category relations, label, source keyword/ID search and optional live exclusions without manufacturing platform ownership', async () => {
    for (const [filter, ids] of [['cate_id=1', [10, 20]], ['cate_id=2', [10, 20]],
      ['store_label_id=1', [20]], ['store_name=钢材关键词', [10]], ['store_name=20', [20]],
      ['is_new=1', [43]], ['is_supplier=1', [20]], ['is_vip_product=0&is_presale_product=0', [10, 20, 30]],
      ['ids=10,20', [10, 20]]] as const) {
      const data = await f.service.products(query(filter), fictitiousActor(115));
      expect(data.list.map(row => row.id).sort((a, b) => a - b)).toEqual(ids);
      expect(data.count).toBe(ids.length);
    }
    expect((await f.service.products(query('store_name=%'), fictitiousActor(115))).count).toBe(5);
    await f.db.insert(liveGoods).values([{ id: 1, productId: 10, auditStatus: 0 },
      { id: 2, productId: 20, auditStatus: 3 }, { id: 3, productId: 30, auditStatus: 0, isDel: 1 }]);
    expect((await f.service.products(query('is_live=1'), fictitiousActor(115))).list.map(row => row.id).sort((a, b) => a - b)).toEqual([20, 30, 43, 44]);
  });

  it('creates an exact complete new platform self-review, copies only selected canonical SKU and preserves real customer/order/stock evidence', async () => {
    const before = await snapshot(); await create(); const row = await created();
    expect(row.unique).toMatch(/^[a-f0-9]{32}$/); expect(row.unique).not.toBe('replysku');
    expect(row).toEqual({ id: 1000, productId: 10, oid: 0, orderCartInfoId: null,
      unique: row.unique, uid: 0, nickname: '运营自评昵称', avatar: '/uploads/virtual-avatar.png',
      comment: '自评正文，不能绑定真实顾客或订单', sku: '蓝', skuUnique: 'replysku',
      type: 0, relationId: 0, replyType: 'product', replyScore: 2, productScore: 2,
      serviceScore: 4, logisticsScore: 3, deliveryScore: 3, pics: '["/uploads/virtual-review.png"]',
      isReply: 0, merchantReply: '', merchantReplyContent: '', merchantReplyTime: 0,
      praise: 0, viewsNum: 0, status: 1, top: 0, isDel: 0,
      addTime: Math.floor(Date.parse('2026-08-02T12:00:00+08:00') / 1000) });
    const after = await snapshot();
    expect(after.reviews.filter(item => item.id !== 1000)).toEqual(before.reviews);
    for (const key of ['comments', 'skus', 'orders', 'carts', 'customers', 'relations'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.products).toEqual(before.products.map(product => product.id === 10 ? { ...product, star: '3.4' } : product));
    expect(after.logs).toHaveLength(1);
    expect(after.logs[0].id).toBeGreaterThan(0);
    expect(after.logs[0]).toEqual({ id: after.logs[0].id, storeId: 0, merchantId: 0, adminId: 101, adminName: '', ip: '',
      path: 'product/reply/save_fictitious_reply', page: '商品评价管理', method: 'POST', type: 'product_fictitious_reply',
      action: JSON.stringify({ operation: 'create', id: 1000, productId: 10, skuId: 72 }), addTime: after.logs[0].addTime });
    expect(Object.keys(after.logs[0])).toHaveLength(12);
    for (const secret of [row.nickname, row.avatar, row.comment, row.pics!, row.unique]) expect(after.logs[0].action).not.toContain(secret);
    expect(after.logs[0].addTime).toBeGreaterThan(0);
  });

  it('allows valid Supplier/store products but records PHP platform identity and a fresh review identifier for every insert', async () => {
    const before = await snapshot();
    await create(fictitiousBody({ image: { image: '', product_id: 20 }, unique: 'supplysk' }));
    await create(fictitiousBody({ product_id: 30, image: '', unique: 'storesku' }));
    const rows = (await snapshot()).reviews.filter(row => row.id >= 1000);
    expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.unique)).size).toBe(2);
    expect(rows.map(row => ({ productId: row.productId, sku: row.sku, uid: row.uid, oid: row.oid,
      type: row.type, relationId: row.relationId, orderCartInfoId: row.orderCartInfoId })))
      .toEqual([{ productId: 20, sku: '供应商蓝色', uid: 0, oid: 0, type: 0, relationId: 0, orderCartInfoId: null },
        { productId: 30, sku: '门店规格', uid: 0, oid: 0, type: 0, relationId: 0, orderCartInfoId: null }]);
    const after = await snapshot(); for (const key of ['skus', 'orders', 'carts', 'customers', 'relations'] as const) expect(after[key]).toEqual(before[key]);
  });

  it('preserves source controller defaults and string numeric scores while keeping textual zero and optional empty SKU legal', async () => {
    const before = Math.floor(Date.now() / 1000);
    await create({ product_id: '10', nickname: '0', avatar: '/uploads/a.png', comment: '0', add_time: '0' });
    const row = await created();
    expect(row).toMatchObject({ nickname: '0', comment: '0', sku: '', skuUnique: '', replyScore: 3,
      productScore: 5, serviceScore: 5, deliveryScore: 5, logisticsScore: 5, pics: '[]' });
    expect(row.addTime).toBeGreaterThanOrEqual(before); expect(row.addTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    await create(fictitiousBody({ product_score: '1', service_score: '2', delivery_score: '5', reply_score: '1' }));
    expect((await snapshot()).reviews.find(item => item.id === 1001)).toMatchObject({ productScore: 1, serviceScore: 2, deliveryScore: 5, logisticsScore: 5, replyScore: 1 });
  });

  it('keeps Unicode source-column lengths and eight media selections with no fetch or normalization of review content', async () => {
    const nickname = '😀'.repeat(64), comment = '汉'.repeat(512), pics = Array.from({ length: 8 }, (_, index) => `/uploads/${index}.png`);
    await create(fictitiousBody({ nickname, comment, pics }));
    expect(await created()).toMatchObject({ nickname, comment, pics: JSON.stringify(pics) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires an independent live attachment reader for canonical private media while allowing existing external images without that grant', async () => {
    await f.db.update(storeProduct).set({ image: '/api/assets/31' }).where(eq(storeProduct.id, 10));
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/31' }).where(eq(storeProductAttrValue.id, 72));
    const selector = new AdminProductFictitiousReplyService(f.container, 'owned-media-preview-key');
    const selected = await selector.products(query('store_name=10'), fictitiousActor(114));
    expect(selected.count).toBe(1); expect(selected.list[0].image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=/);
    expect(selected.list[0].attrValue[0].image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=/);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0].image).toBe('/api/assets/31');
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 72)))[0].image).toBe('/api/assets/31');
    const before = await snapshot();
    for (const id of [101, 110, 115, 117]) await expect(create(fictitiousPrivateMediaBody(), fictitiousActor(id))).rejects.toThrow('权限');
    expect(await snapshot()).toEqual(before);
    await create(fictitiousPrivateMediaBody(), fictitiousActor(116));
    expect(await created()).toMatchObject({ avatar: '/api/assets/31', pics: '["/api/assets/31"]', uid: 0, type: 0, relationId: 0 });
    expect((await snapshot()).attachments).toEqual(before.attachments);
    await f.db.update(systemRole).set({ rules: 'reply.manage,product.view' }).where(eq(systemRole.id, 16));
    const revoked = await snapshot(); await expect(create(fictitiousPrivateMediaBody(), fictitiousActor(116))).rejects.toThrow('权限');
    expect(await snapshot()).toEqual(revoked);
    const external = 'https://external.invalid/api/assets/31';
    const result = await create(fictitiousBody({ avatar: external, pics: [external] }), fictitiousActor(116));
    expect((await snapshot()).reviews.find(row => row.id === result.id)).toMatchObject({ avatar: external, pics: JSON.stringify([external]) });
  });

  it('rejects private guessed/missing/foreign-owner/MIME/path/module references and signed or noncanonical copies before publishing any self-review', async () => {
    const before = await snapshot();
    for (const reference of ['/api/assets/32', '/api/assets/33', '/api/assets/34', '/api/assets/35',
      '/api/assets/36', '/api/assets/37', '/api/assets/38', '/api/assets/999', '/api/assets/031',
      '/api/assets/31?expires=2000000000&signature=forged', '/api/assets/31#private',
      '/api/assets/31/', 'https://store.invalid/a.png?%65xpires=2000000000&%73ignature=forged']) {
      await expect(create(fictitiousBody({ avatar: reference, pics: [reference] }), fictitiousActor(116))).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });

  it('rolls back audited private-media creation when an owner trigger rewrites or removes its locked complete attachment metadata', async () => {
    const before = await snapshot();
    for (const mutation of ["UPDATE system_attachment SET real_name='hidden metadata rewrite' WHERE att_id=31;",
      'UPDATE system_attachment SET relation_id=20 WHERE att_id=31;', 'DELETE FROM system_attachment WHERE att_id=31;']) {
      await f.exec(`CREATE OR REPLACE FUNCTION fake_audit_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mutation} RETURN NEW; END $$;
        CREATE TRIGGER fake_audit_after AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION fake_audit_after()`);
      try { await expect(create(fictitiousPrivateMediaBody(), fictitiousActor(116))).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
      finally { await f.exec('DROP TRIGGER fake_audit_after ON system_log'); }
    }
  });

  it('parses source Shanghai wall dates including historical DST while rejecting future and invalid calendar values', async () => {
    await create(fictitiousBody({ add_time: '1988-07-01 12:00:00' }));
    expect((await created()).addTime).toBe(583729200);
    for (const [add_time, expected] of [['1970-01-01 07:59:59', -1], ['1970-01-01 08:00:00', 0]] as const) {
      const result = await create(fictitiousBody({ add_time }));
      const [saved] = await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, result.id));
      expect(saved.addTime).toBe(expected);
    }
    for (const add_time of [0, '0'] as const) {
      const started = Math.floor(Date.now() / 1000), result = await create(fictitiousBody({ add_time }));
      const [saved] = await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, result.id));
      expect(saved.addTime).toBeGreaterThanOrEqual(started);
      expect(saved.addTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      expect(saved.addTime).toBeGreaterThan(0);
    }
    const before = await snapshot();
    for (const add_time of ['2099-01-01 00:00:00', '2026-02-30 00:00:00', 'not a date',
      '2026-08-01T00:00:00Z', '1988-04-17 02:30:00']) await expect(create(fictitiousBody({ add_time }))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('rejects forged identity/order/owner/visibility fields, conflicting source image identity and cross-product or retired/activity/ambiguous SKU', async () => {
    const before = await snapshot();
    for (const patch of [{ uid: 1 }, { oid: 70 }, { order_cart_info_id: 71 }, { relation_id: 20 },
      { type: 2 }, { status: 0 }, { top: 1 }, { is_del: 1 }, { unknown: true },
      { product_id: 20 }, { unique: 'supplysk' }, { unique: 'retireds' }, { unique: 'seckills' },
      { unique: 'missing1' }, { image: { image: '', product_id: 10, uid: 1 } }])
      await expect(create(fictitiousBody(patch))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await f.db.insert(storeProductAttrValue).values({ id: 80, productId: 10, unique: 'replysku', suk: '歧义 SKU' });
    const polluted = await snapshot(); await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(polluted);
  });

  it('refuses new orphan/unapproved/deleted/malformed-owner products while imported orphan moderation remains available', async () => {
    const before = await snapshot();
    for (const product_id of [0, -1, 404, 41, 42, '010', 2147483648])
      await expect(create(fictitiousBody({ image: '', product_id, unique: '' }))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const moderator = new AdminProductReplyService(f.container);
    expect(await moderator.getReply(40, query(), fictitiousActor())).toEqual({ content: '' });
    await f.db.update(storeProduct).set({ relationId: 73 }).where(eq(storeProduct.id, 10));
    const malformed = await snapshot(); await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(malformed);
  });

  it('rejects malformed body shapes, scores, media protocols/lengths, Unicode/control bytes and source text overflow without writes', async () => {
    const before = await snapshot();
    for (const body of [null, [], 'x', {}, fictitiousBody({ nickname: '😀'.repeat(65) }),
      fictitiousBody({ comment: '😀'.repeat(513) }), fictitiousBody({ avatar: '/'.repeat(256) }),
      fictitiousBody({ nickname: '\ud800' }), fictitiousBody({ comment: 'x\u0000y' }),
      fictitiousBody({ product_score: 0 }), fictitiousBody({ product_score: 6 }),
      fictitiousBody({ service_score: 4.5 }), fictitiousBody({ delivery_score: '03' }),
      fictitiousBody({ reply_score: 4 }), fictitiousBody({ pics: Array(9).fill('/uploads/a.png') }),
      fictitiousBody({ pics: ['javascript:alert(1)'] }), fictitiousBody({ avatar: 'data:image/png,x' }),
      fictitiousBody({ pics: '[]' }), fictitiousBody({ pics: [null] })]) await expect(create(body)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('rejects duplicate/unknown/noncanonical query and path parameters and side-effect-free reader-only creation', async () => {
    const before = await snapshot();
    for (const id of [102, 103, 104, 106, 107, 108, 109, 111, 112, 113]) await expect(create(undefined, fictitiousActor(id))).rejects.toThrow('权限');
    for (const value of ['page=0', 'page=1&page=2', 'uid=1', 'limit=101', 'cate_id=02', 'ids=10,10', 'is_supplier=2'])
      await expect(f.service.products(query(value), fictitiousActor(115))).rejects.toThrow();
    for (const id of [101, 102, 105, 106, 107, 109, 110, 111, 112])
      await expect(f.service.products(query(), fictitiousActor(id))).rejects.toThrow('权限');
    for (const value of ['product_id=10&product_id=20', 'product_id=30', 'extra=1'])
      await expect(f.service.form(20, query(value), fictitiousActor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await create(undefined, fictitiousActor(110)); expect((await created()).uid).toBe(0);
  });

  it('binds authentic numeric184/185 metadata in both resolvers and refuses forged copies/wildcards and each protected tuple rewrite', async () => {
    const permission = new AdminPermissionService(f.container);
    for (const [id, expected] of [[184, ['reply.view']], [185, ['reply.manage', 'reply.view']], [579, []], [580, []], [999, []]] as const) {
      expect(await permission.resolveRulePermissionKeys(String(id))).toEqual(expected);
      expect(await permission.resolveManyRulePermissionKeys([String(id)])).toEqual([expected]);
    }
    for (const id of [184, 185]) {
      const [original] = await f.db.select().from(systemMenus).where(eq(systemMenus.id, id));
      for (const patch of [{ type: 2 }, { authType: 1 }, { methods: 'DELETE' },
        { menuPath: '' }, { uniqueAuth: id === 184 ? 'product-reply-save_fictitious_reply' : '' },
        { apiUrl: 'reply/status/<id>' }]) {
        await f.db.update(systemMenus).set(patch).where(eq(systemMenus.id, id));
        expect(await permission.resolveRulePermissionKeys(String(id))).toEqual([]);
        expect(await permission.resolveManyRulePermissionKeys([String(id)])).toEqual([[]]);
        await f.db.update(systemMenus).set(original).where(eq(systemMenus.id, id));
      }
    }
    for (const id of [579, 580]) {
      await f.db.update(systemMenus).set({ authType: 2, apiUrl: 'product/reply/save_fictitious_reply', methods: 'POST',
        menuPath: '/adminproduct/reply/save_fictitious_reply', uniqueAuth: 'product-reply-save_fictitious_reply' }).where(eq(systemMenus.id, id));
      expect(await permission.resolveRulePermissionKeys(String(id))).toEqual([]);
      expect(await permission.resolveManyRulePermissionKeys([String(id)])).toEqual([[]]);
    }
  });

  it('revalidates current role/password/platform admin and expiry rather than trusting UI capability or a stale JWT actor', async () => {
    const before = await snapshot();
    await f.db.update(systemRole).set({ rules: 'product.manage' }).where(eq(systemRole.id, 1));
    await expect(create()).rejects.toThrow('权限');
    await f.db.update(systemRole).set({ rules: 'reply.manage' }).where(eq(systemRole.id, 1));
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 101));
    await expect(create()).rejects.toThrow();
    await f.db.update(systemAdmin).set({ pwd: 'reply-fixture-password', adminType: 2, relationId: 20 }).where(eq(systemAdmin.id, 101));
    await expect(create()).rejects.toThrow();
    await expect(create(undefined, { ...fictitiousActor(), expiresAt: 1 })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back every skipped/rewritten review INSERT or prescribed product-star UPDATE receipt', async () => {
    const before = await snapshot();
    for (const [table, event, rewrite] of [['store_product_reply', 'INSERT', 'NEW.uid=1;'],
      ['store_product', 'UPDATE', "NEW.store_name='hidden mutation';"]] as const) {
      const trigger = table === 'store_product' ? 'fake_product_dml' : 'fake_reply_dml';
      for (const code of ['RETURN NULL;', `${rewrite} RETURN NEW;`]) {
        await f.exec(`CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${code} END $$;
          CREATE TRIGGER ${trigger} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
        await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
        await f.exec(`DROP TRIGGER ${trigger} ON ${table}`);
      }
    }
  });

  it('rolls back suppressed audit and all eleven audit fields rewritten before/after INSERT, preserving source contents', async () => {
    const before = await snapshot();
    await f.exec(`CREATE OR REPLACE FUNCTION fake_audit_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER fake_audit_dml BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION fake_audit_dml()`);
    await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER fake_audit_dml ON system_log');
    for (const [column, value] of [['id', '0'], ['store_id', '73'], ['merchant_id', '91'], ['admin_id', '100'],
      ['admin_name', "'forged actor'"], ['ip', "'203.0.113.91'"], ['path', "'wrong/path'"],
      ['page', "'wrong page'"], ['method', "'GET'"], ['action', "'{}'"], ['type', "'wrong'"], ['add_time', '1']] as const) {
      await f.exec(`CREATE OR REPLACE FUNCTION fake_audit_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.${column}=${value}; RETURN NEW; END $$;
        CREATE TRIGGER fake_audit_dml BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION fake_audit_dml()`);
      await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
      await f.exec('DROP TRIGGER fake_audit_dml ON system_log');
      await f.exec(`CREATE OR REPLACE FUNCTION fake_audit_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE system_log SET ${column}=${value} WHERE id=NEW.id; RETURN NEW; END $$;
        CREATE TRIGGER fake_audit_after AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION fake_audit_after()`);
      await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
      await f.exec('DROP TRIGGER fake_audit_after ON system_log');
    }
  });

  it('rechecks both inserted review and complete selected catalogue rows after successful audit triggers', async () => {
    const before = await snapshot();
    for (const mutation of ["UPDATE store_product_reply SET oid=70 WHERE id=1000;",
      "UPDATE store_product SET star=1 WHERE id=10;", "UPDATE store_product SET stock=stock+1 WHERE id=10;",
      "UPDATE store_product_attr_value SET suk='different snapshot' WHERE id=72;"]) {
      await f.exec(`CREATE OR REPLACE FUNCTION fake_audit_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mutation} RETURN NEW; END $$;
        CREATE TRIGGER fake_audit_after AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION fake_audit_after()`);
      await expect(create()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
      await f.exec('DROP TRIGGER fake_audit_after ON system_log');
    }
  });
});
