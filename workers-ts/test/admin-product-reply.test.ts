import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeProductReply, storeProductReplyComment, storeProduct, storeProductAttrValue,
  storeOrder, storeOrderCartInfo, userRelation, systemLog, systemAdmin, systemRole,
  systemMenus, systemConfig } from '@/models/schema';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { productReplyFixture, seedReplies, replyActor, replyBody, replyEpoch } from './helpers/adminProductReplies';

const query = (value = '') => new URLSearchParams(value);
describe('Admin real product-review moderation PHP contracts and complete SQL receipts', () => {
  let f: Awaited<ReturnType<typeof productReplyFixture>>;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Reply fixture forbids external I/O'));
    f = await productReplyFixture();
  }, 30000);
  beforeEach(async () => {
    await f.exec(`DROP TRIGGER IF EXISTS skip_reply_dml ON store_product_reply;
      DROP TRIGGER IF EXISTS skip_comment_dml ON store_product_reply_comment;
      DROP TRIGGER IF EXISTS rewrite_reply_dml ON store_product_reply;
      DROP TRIGGER IF EXISTS rewrite_comment_dml ON store_product_reply_comment;
      DROP TRIGGER IF EXISTS skip_reply_audit ON system_log;
      DROP TRIGGER IF EXISTS rewrite_reply_audit ON system_log;
      DROP TRIGGER IF EXISTS rewrite_reply_audit_identity ON system_log;
      DROP TRIGGER IF EXISTS rewrite_reply_audit_after ON system_log;
      DROP TRIGGER IF EXISTS mutate_reply_after_audit ON system_log;
      DROP TRIGGER IF EXISTS resurrect_comment_after_audit ON system_log`);
    await f.reset(); await seedReplies(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_reply_comment','id'),1000,false)");
  }, 30000);
  afterAll(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  const setReply = (id = 10, content = '平台回复内容', actor = replyActor()) => f.service.setReply(id, replyBody(content), actor);
  const saveComment = (replyId = 10, id = 101, content = '平台二级回复', actor = replyActor()) => f.service.saveComment(replyId, id, replyBody(content), actor);
  const remove = (id = 10, body: unknown = undefined, actor = replyActor(), legacy = true) => f.service.remove(id, query(), body, actor, legacy);
  const removeComment = (id = 100, body: unknown = undefined, actor = replyActor()) => f.service.removeComment(id, query(), body, actor);
  async function snapshot() {
    return { replies: await f.db.select().from(storeProductReply).orderBy(storeProductReply.id),
      comments: await f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id),
      relations: await f.db.select().from(userRelation).orderBy(userRelation.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('lists all valid review owners and orphan histories with PHP paging, joined filtering and Shanghai date projections', async () => {
    const page = await f.service.list(query('page=2&limit=2'), replyActor());
    expect(page.count).toBe(5);
    expect(page.list.map(row => row.id)).toEqual([20, 10]);
    expect(page.list[1]).toMatchObject({ store_name: '平台保温杯', image: 'https://fixture.invalid/product-10.png',
      account: '评价快照张三', comment: '客户原始评价正文', add_time: '2026-08-02 12:00:00',
      create_time: '2026-08-02 12:00:00', score: '4', pics: ['https://fixture.invalid/review.png'], replyComment: null });
    expect(typeof page.list[1].time).toBe('string');
    expect((await f.service.list(query(), replyActor())).list.map(row => row.id)).toEqual([40, 30, 20, 10, 11]);
    for (const [filter, ids] of [['store_name=钢材关键词', [10, 11]], ['store_name=20', [20]],
      ['account=快照张', [10]], ['product_id=10&is_reply=0', [10]], ['store_name=%', [40, 30, 20, 10, 11]]] as const) {
      expect((await f.service.list(query(filter), replyActor())).list.map(row => row.id)).toEqual(ids);
    }
    expect((await f.service.list(query('data=2026/08/02 - 2026/08/03'), replyActor())).list.map(row => row.id)).toEqual([20, 10]);
    const modern = await f.service.list(query('page=1&limit=10'), replyActor(), false);
    expect(Array.isArray(modern)).toBe(true);
    expect(modern).toEqual(expect.arrayContaining([expect.objectContaining({ id: 10, productId: 10, addTime: replyEpoch(2), status: 0 })]));
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('decodes historical PHP pics JSON without silently replacing legal non-array values', async () => {
    for (const [raw, parsed] of [['{"image":"historical"}', { image: 'historical' }], ['false', false],
      ['null', null], ['0', 0], ['{broken', null], ['{}', []],
      ['{"0":"a","1":"b"}', ['a', 'b']], ['{"1":"b","0":"a"}', { 1: 'b', 0: 'a' }],
      ['{"0":"a","2":"c"}', { 0: 'a', 2: 'c' }],
      ['[{}, {"0":"a","1":"b"}, {"1":"b","0":"a"}]', [[], ['a', 'b'], { 1: 'b', 0: 'a' }]],
      ['{"0":"first","1":"b","0":"last"}', ['last', 'b']],
      ['{"\\u0030":"a","1":"b"}', ['a', 'b']], ['["\\ud800"]', null],
      ['['.repeat(513) + '0' + ']'.repeat(513), null]] as const) {
      await f.db.update(storeProductReply).set({ pics: raw }).where(eq(storeProductReply.id, 10));
      expect((await f.service.list(query('product_id=10&is_reply=0'), replyActor())).list[0].pics).toEqual(parsed);
    }
    await f.db.update(storeProductReply).set({ pics: '[{}]' }).where(eq(storeProductReply.id, 10));
    expect((await f.service.list(query('product_id=10'), replyActor(), false))[0].pics).toEqual([{}]);
    for (const raw of ['[9007199254740993]', '[1e309]']) {
      await f.db.update(storeProductReply).set({ pics: raw }).where(eq(storeProductReply.id, 10));
      await expect(f.service.list(query('product_id=10&is_reply=0'), replyActor())).rejects.toThrow(/安全|数值|精确/);
    }
  });

  it('moderates orphan and hidden reviews without using current product ownership as authority while quarantining malformed review tuples', async () => {
    await setReply(40, '保留缺商品历史的中央回复');
    expect((await f.service.getReply(40, query(), replyActor())).content).toBe('保留缺商品历史的中央回复');
    await f.db.update(storeProduct).set({ type: 2, relationId: 77, isDel: 1 }).where(eq(storeProduct.id, 10));
    await setReply(10, '隐藏评价与当前商品变更仍由中央管理');
    expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 10)))[0])
      .toMatchObject({ type: 0, relationId: 0, status: 0, isReply: 1, comment: '客户原始评价正文' });
    await f.db.update(storeProductReply).set({ relationId: 77 }).where(eq(storeProductReply.id, 11));
    const before = await snapshot();
    await expect(f.service.getReply(11, query(), replyActor())).rejects.toThrow('异常');
    await expect(setReply(11)).rejects.toThrow('异常');
    await expect(remove(11)).rejects.toThrow('异常');
    for (const id of [0, -1, NaN, 2147483648, 999]) {
      await expect(f.service.getReply(id, query(), replyActor())).rejects.toThrow();
      await expect(setReply(id)).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('returns only the exact platform root and ten PHP comment fields while Supplier roots remain separate', async () => {
    expect(await f.service.getReply(10, query(), replyActor())).toEqual({ content: '' });
    expect(await f.service.getReply(20, query(), replyActor())).toEqual({ content: '' });
    expect(await f.service.getReply(11, query(), replyActor())).toEqual({ id: 200, type: 0, relation_id: 0,
      reply_id: 11, pid: 0, uid: 0, content: '现有平台一级回复', praise: 0,
      create_time: '2026-08-01 12:00:00', update_time: '1970-01-01 08:00:00' });
    await setReply(20, '中央 Admin 回复供应商评价');
    const roots = await f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.replyId, 20));
    expect(roots).toEqual(expect.arrayContaining([expect.objectContaining({ id: 110, type: 2, relationId: 20, content: '供应商自己的一级回复' }),
      expect.objectContaining({ id: 1000, type: 0, relationId: 0, uid: 0, pid: 0, updateTime: 0, content: '中央 Admin 回复供应商评价' })]));
    expect((await f.db.select().from(storeProductReply).where(eq(storeProductReply.id, 20)))[0].isReply).toBe(0);
    expect((await f.service.list(query('product_id=20'), replyActor())).list[0].replyComment).toMatchObject({ id: 1000, type: 0, relation_id: 0 });
  });

  it('updates an existing platform response in place and preserves all customer, order, SKU and praise evidence', async () => {
    const before = await snapshot();
    await setReply(11, '更新既有平台回复');
    const after = await snapshot();
    expect(after.replies).toEqual(before.replies);
    expect(after.comments).toHaveLength(before.comments.length);
    expect(after.comments.find(row => row.id === 200)).toMatchObject({ content: '更新既有平台回复', addTime: replyEpoch(1) });
    expect(after.comments.find(row => row.id === 200)!.updateTime).toBeGreaterThan(0);
    for (const key of ['relations', 'products', 'skus', 'orders', 'carts'] as const) expect(after[key]).toEqual(before[key]);
    await setReply();
    const created = await snapshot();
    const parent = created.replies.find(row => row.id === 10)!;
    expect(parent).toEqual({ ...before.replies.find(row => row.id === 10)!, isReply: 1 });
    expect(created.comments.find(row => row.id === 1000)).toMatchObject({ type: 0, relationId: 0, uid: 0, pid: 0, replyId: 10, updateTime: 0 });
  });

  it('projects user roots with anonymous nicknames, PHP grade and VIP values, a single unmasked child and site fallback', async () => {
    const data = await f.service.comments(10, query('page=1&limit=1'), replyActor());
    expect(data.count).toBe(2); expect(data.list).toHaveLength(1);
    expect(data.list[0]).toMatchObject({ id: 100, content: '用户一级评论', create_time: '2026-08-02 12:00:00',
      is_praise: false, user: { avatar: 'https://fixture.invalid/user-1.png', level_name: 3, vip_status: 1 },
      children: { id: 102, pid: 100, uid: 2, is_praise: false, user: { nickname: '客户李四' } } });
    expect(data.list[0].user.nickname).not.toBe('客户张三');
    const noPaid = (await f.service.comments(10, query('page=2&limit=1'), replyActor())).list[0];
    expect(noPaid).toMatchObject({ id: 101, children: null, user: { vip_status: 0 } });
    await saveComment();
    const child = (await f.service.comments(10, query('page=2&limit=1'), replyActor())).list[0].children;
    expect(child).toMatchObject({ uid: 0, pid: 101, user: { nickname: '评价测试商城', avatar: 'https://fixture.invalid/site.png' }, is_praise: false });
    expect((await f.service.comments(20, query(), replyActor())).list.map(row => row.id)).toEqual([120]);
    expect((await f.service.comments(10, query('time=2026/08/03 - 2026/08/03'), replyActor())).list.map(row => row.id)).toEqual([101]);
    await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.id, 4));
    expect((await f.service.comments(10, query('limit=1'), replyActor())).list[0].user.vip_status).toBe(0);
    for (const value of ['{}', '[]', '"0"']) {
      await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.id, 4));
      await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.id, 3));
      const root = (await f.service.comments(10, query('limit=1'), replyActor())).list[0];
      expect(root.user).toMatchObject({ vip_status: 0, level_name: '' });
    }
    for (const value of ['"1"', '1']) {
      await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.id, 4));
      await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.id, 3));
      expect((await f.service.comments(10, query('limit=1'), replyActor())).list[0].user).toMatchObject({ vip_status: 1, level_name: 3 });
    }
  });

  it('creates and updates a platform child using its actual parent chain without inheriting Supplier ownership', async () => {
    await saveComment(20, 120, 'Admin 对 Supplier 用户根回复');
    const first = (await f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, 1000)))[0];
    expect(first).toMatchObject({ replyId: 20, pid: 120, uid: 0, type: 0, relationId: 0, updateTime: 0 });
    await saveComment(20, 120, '更新同一平台孩子');
    const second = (await f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, 1000)))[0];
    expect(second).toEqual({ ...first, content: '更新同一平台孩子', updateTime: second.updateTime });
    expect(second.addTime).toBe(first.addTime); expect(second.updateTime).toBeGreaterThan(0);
    const before = await snapshot();
    for (const [replyId, id] of [[10, 120], [20, 100], [10, 102], [11, 200], [10, 999]]) {
      await expect(saveComment(replyId, id)).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('soft-deletes only the review and physically removes only a comment and its direct children', async () => {
    await f.db.insert(storeProductReplyComment).values([
      { id: 103, replyId: 10, pid: 102, uid: 1, content: '深层历史证据', addTime: replyEpoch(5) },
      { id: 104, replyId: 10, pid: 100, uid: 1, content: '另一个待清理历史直属孩子', addTime: replyEpoch(5) },
    ]);
    const before = await snapshot();
    await removeComment(100, { ids: '' });
    const removed = await snapshot();
    expect(removed.comments).toEqual(before.comments.filter(row => ![100, 102, 104].includes(row.id)));
    for (const key of ['replies', 'relations', 'products', 'skus', 'orders', 'carts'] as const) expect(removed[key]).toEqual(before[key]);
    await remove(10, { ids: '' });
    const deleted = await snapshot();
    expect(deleted.replies).toEqual(before.replies.map(row => row.id === 10 ? { ...row, isDel: 1 } : row));
    expect(deleted.comments).toEqual(removed.comments);
    for (const key of ['relations', 'products', 'skus', 'orders', 'carts'] as const) expect(deleted[key]).toEqual(before[key]);
    expect((await f.service.list(query(), replyActor())).count).toBe(4);
    await expect(setReply(10)).rejects.toThrow();
    await expect(f.service.comments(10, query(), replyActor())).rejects.toThrow();
  });

  it('uses the PHP exclusive open end and inclusive complete range at the next Shanghai midnight', async () => {
    await f.db.insert(storeProductReply).values({ id: 60, productId: 10, uid: 1, comment: '截止次日零点', addTime: replyEpoch(3, 0) });
    await f.db.insert(storeProductReplyComment).values({ id: 130, replyId: 10, uid: 1, content: '截止次日零点评论', addTime: replyEpoch(3, 0) });
    expect((await f.service.list(query('data=-2026/08/02'), replyActor())).list.map(row => row.id)).toEqual([10, 11]);
    expect((await f.service.list(query('data=2026/08/02-2026/08/02'), replyActor())).list.map(row => row.id)).toEqual([60, 10]);
    expect((await f.service.comments(10, query('time=-2026/08/02'), replyActor())).list.map(row => row.id)).toEqual([100]);
    expect((await f.service.comments(10, query('time=2026/08/02-2026/08/02'), replyActor())).list.map(row => row.id)).toEqual([100, 130]);
    const epochZero = '1970/01/01 08:00:00';
    expect((await f.service.list(query(`data=${epochZero}-2026/08/02`), replyActor())).list.map(row => row.id)).toEqual([10, 11]);
    expect((await f.service.comments(10, query(`time=${epochZero}-2026/08/02`), replyActor())).list.map(row => row.id)).toEqual([100]);
    expect((await f.service.list(query(`data=2026/08/02-${epochZero}`), replyActor())).list.map(row => row.id)).toEqual([40, 30, 20, 60, 10]);
    expect((await f.service.list(query(`data=${epochZero}-${epochZero}`), replyActor())).count).toBe(6);
  });

  it('projects and filters imported Shanghai summer-time timestamps through the actual IANA calendar', async () => {
    await f.db.insert(storeProductReply).values({ id: 70, productId: 10, uid: 1, comment: '历史夏令时评价', addTime: 583729200 });
    await f.db.insert(storeProductReplyComment).values([
      { id: 140, replyId: 70, uid: 1, content: '历史夏令时用户评论', addTime: 583729200 },
      { id: 141, replyId: 70, uid: 0, content: '历史夏令时平台回复', addTime: 583729200, updateTime: 583729200 },
    ]);
    expect((await f.service.list(query('data=1988/07/01-1988/07/01'), replyActor())).list).toMatchObject([{ id: 70, add_time: '1988-07-01 12:00:00', create_time: '1988-07-01 12:00:00' }]);
    expect(await f.service.getReply(70, query(), replyActor())).toMatchObject({ id: 141, create_time: '1988-07-01 12:00:00', update_time: '1988-07-01 12:00:00' });
    expect((await f.service.comments(70, query('time=1988/07/01 11:30:00-1988/07/01 12:30:00'), replyActor())).list).toMatchObject([{ id: 140, create_time: '1988-07-01 12:00:00' }]);
    expect((await f.service.comments(70, query('time=1988/07/01 12:30:00-1988/07/01 13:30:00'), replyActor())).list).toEqual([]);
    const actor = replyActor(), now = Date.parse('1988-04-24T02:30:00+09:00');
    await f.db.insert(storeProductReply).values([
      { id: 80, productId: 10, uid: 1, comment: '历史命名日历当前行', addTime: Math.floor(now / 1000) },
      { id: 83, productId: 10, uid: 1, comment: '相对七天夏令时缺口规范后边界', addTime: Math.floor(Date.parse('1988-04-17T03:30:00+09:00') / 1000) },
      { id: 84, productId: 10, uid: 1, comment: '相对七天边界之前', addTime: Math.floor(Date.parse('1988-04-17T03:15:00+09:00') / 1000) },
    ]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect((await f.service.list(query('data=today'), actor)).list.map(row => row.id)).toEqual([80]);
      expect((await f.service.list(query('data=month'), actor)).list.map(row => row.id)).toEqual([80, 83, 84]);
      expect((await f.service.list(query('data=lately7'), actor)).list.map(row => row.id)).toEqual([80, 83]);
      expect((await f.service.list(query('data=1988/07/01-1988/07/01'), actor)).list.map(row => row.id)).toEqual([70]);
    } finally { clock.mockRestore(); }
  });

  it('cleans exact deep or orphan comments and duplicated roots even after the review is soft-deleted', async () => {
    await f.db.insert(storeProductReplyComment).values([
      { id: 103, replyId: 10, pid: 102, uid: 2, content: '非递归留下的孙评论' },
      { id: 105, replyId: 10, pid: 103, uid: 1, content: '孙评论的直属孩子' },
      { id: 201, replyId: 11, uid: 0, content: '重复平台根可按确定ID清理' },
    ]);
    const before = await snapshot();
    await f.service.removeComment(100, query(), undefined, replyActor());
    expect((await f.db.select().from(storeProductReplyComment)).map(row => row.id)).toContain(103);
    await f.service.removeComment(103, query(), undefined, replyActor());
    expect((await f.db.select().from(storeProductReplyComment)).map(row => row.id)).not.toContain(105);
    await expect(f.service.getReply(11, query(), replyActor())).rejects.toThrow(/重复/);
    await f.service.removeComment(200, query(), undefined, replyActor());
    expect(await f.service.getReply(11, query(), replyActor())).toMatchObject({ id: 201 });
    await f.service.remove(11, query(), undefined, replyActor());
    await f.service.removeComment(201, query(), undefined, replyActor());
    const after = await snapshot();
    expect(after.relations).toEqual(before.relations); expect(after.orders).toEqual(before.orders); expect(after.skus).toEqual(before.skus);
    expect(after.comments.some(row => [100, 102, 103, 105, 200, 201].includes(row.id))).toBe(false);
  });

  it('rejects duplicate or polluted platform roots instead of treating Supplier or secondary rows as the platform response', async () => {
    for (const mutation of [{ id: 201, replyId: 11, uid: 0, content: '重复平台根' },
      { id: 201, replyId: 11, uid: 0, type: 0, relationId: 7, content: '污染平台根' }]) {
      await f.db.insert(storeProductReplyComment).values(mutation);
      const before = await snapshot();
      await expect(f.service.getReply(11, query(), replyActor())).rejects.toThrow();
      await expect(f.service.list(query('product_id=10'), replyActor())).rejects.toThrow();
      await expect(setReply(11)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await f.db.delete(storeProductReplyComment).where(eq(storeProductReplyComment.id, 201));
    }
    await f.db.insert(storeProductReplyComment).values({ id: 201, replyId: 10, uid: 0, pid: 101, content: '纯二级平台回复' });
    expect(await f.service.getReply(10, query(), replyActor())).toEqual({ content: '' });
  });

  it('refuses ambiguous children and cross-review child corruption before any moderation side effect', async () => {
    await f.db.insert(storeProductReplyComment).values({ id: 201, replyId: 10, pid: 100, uid: 0, content: '另一直属孩子' });
    const before = await snapshot();
    await expect(f.service.comments(10, query(), replyActor())).rejects.toThrow();
    await expect(saveComment(10, 100)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await f.db.delete(storeProductReplyComment).where(eq(storeProductReplyComment.id, 201));
    await f.db.update(storeProductReplyComment).set({ replyId: 20 }).where(eq(storeProductReplyComment.id, 102));
    const crossed = await snapshot();
    await expect(removeComment(100)).rejects.toThrow();
    expect(await snapshot()).toEqual(crossed);
  });

  it('supports exactly 1000 Unicode reply codepoints, distinct PHP string-zero contracts and strict read-only body refusal', async () => {
    const content = '😀'.repeat(1000);
    await setReply(10, content);
    expect((await f.service.getReply(10, query(), replyActor())).content).toBe(content);
    await saveComment(10, 101, content);
    expect((await f.service.comments(10, query('page=2&limit=1'), replyActor())).list[0].children?.content).toBe(content);
    await setReply(10, '0');
    expect((await f.service.getReply(10, query(), replyActor())).content).toBe('0');
    const before = await snapshot();
    for (const bad of ['', ' ', '😀'.repeat(1001), '\u0000bad', '\u0085bad', '\ud800']) {
      await expect(setReply(10, bad)).rejects.toThrow(); await expect(saveComment(10, 101, bad)).rejects.toThrow();
    }
    await expect(saveComment(10, 101, '0')).rejects.toThrow();
    for (const body of [null, [], {}, { content: true }, { content: '合法', uid: 0 }, { content: '合法', reply_id: 10 },
      { content: '合法', type: 0 }, { content: '合法', is_reply: 1 }, { content: '合法', unknown: true }]) {
      await expect(f.service.setReply(10, body, replyActor())).rejects.toThrow();
      await expect(f.service.saveComment(10, 101, body, replyActor())).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('rejects unsupported or duplicate queries and delete bodies without modifying evidence', async () => {
    const before = await snapshot();
    for (const value of ['page=0', 'page=01', 'limit=101', 'page=1000001', 'page=1&page=2', 'is_reply=2',
      'account=a&account=b', 'type=2', 'status=1', 'data=2026/02/30 - 2026/03/01', 'data=2026/08/03 - 2026/08/02',
      'store_name='+encodeURIComponent('😀'.repeat(129))]) {
      await expect(f.service.list(query(value), replyActor())).rejects.toThrow();
    }
    await expect(f.service.comments(10, query('uid=1'), replyActor())).rejects.toThrow();
    await expect(f.service.getReply(10, query('id=10'), replyActor())).rejects.toThrow();
    for (const body of [null, [], {}, { ids: '10' }, { ids: '', unknown: true }]) {
      await expect(remove(10, body)).rejects.toThrow(); await expect(removeComment(100, body)).rejects.toThrow();
    }
    await expect(remove(10, { ids: '' }, replyActor(), false)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('admits exact reply reader seeds and preserves reply/product permission separation', async () => {
    const permission = new AdminPermissionService(f.container);
    for (const id of [102, 106, 107]) {
      expect((await f.service.list(query(), replyActor(id))).count).toBe(5);
      await expect(setReply(10, '权限拒绝', replyActor(id))).rejects.toThrow('权限');
      await expect(remove(10, undefined, replyActor(id))).rejects.toThrow('权限');
      await expect(saveComment(10, 101, '权限拒绝', replyActor(id))).rejects.toThrow('权限');
    }
    for (const id of [103, 104, 108]) await expect(f.service.list(query(), replyActor(id))).rejects.toThrow('权限');
    expect(await permission.resolveManyRulePermissionKeys(['6', '188', '189', '190', '580']))
      .toEqual([['reply.view'], ['reply.manage', 'reply.view'], ['reply.manage', 'reply.view'], ['reply.view'], []]);
    const original = { type: 1, authType: 1, apiUrl: '', methods: '', menuPath: '/admin/product/product_reply', uniqueAuth: 'product-product-reply' };
    for (const change of [{ type: 2 }, { authType: 2 }, { menuPath: '/admin/product/product_Reply' },
      { uniqueAuth: 'product-product-Reply' }, { apiUrl: 'product/reply' }, { methods: 'GET' }]) {
      await f.db.update(systemMenus).set({ ...original, ...change }).where(eq(systemMenus.id, 6));
      expect(await permission.resolveRulePermissionKeys('6')).toEqual([]);
      expect(await permission.resolveManyRulePermissionKeys(['6'])).toEqual([[]]);
    }
    for (const tuple of [original, { ...original, authType: 2, apiUrl: 'product/reply/set_reply/<id>', methods: 'PUT' }]) {
      await f.db.update(systemMenus).set(tuple).where(eq(systemMenus.id, 580));
      expect(await permission.resolveRulePermissionKeys('580')).toEqual([]);
    }
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('revalidates current roles, password version, central Admin identity and actor expiry at the SQL boundary', async () => {
    const before = await snapshot();
    await f.db.update(systemRole).set({ rules: 'user.manage' }).where(eq(systemRole.id, 1));
    await expect(setReply()).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    await expect(f.service.comments(10, query(), replyActor(102))).rejects.toThrow('凭据');
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    await expect(f.service.list(query(), replyActor(100))).rejects.toThrow('身份');
    await expect(setReply(10, 'expired', { ...replyActor(), expiresAt: 1 })).rejects.toThrow('过期');
    expect(await snapshot()).toEqual(before);
  });

  it('keeps modern status moderation constrained to status and all audited actions content-free', async () => {
    const before = await snapshot();
    await f.service.status(10, { status: 1 }, replyActor());
    const after = await snapshot();
    expect(after.replies).toEqual(before.replies.map(row => row.id === 10 ? { ...row, status: 1 } : row));
    expect(after.comments).toEqual(before.comments);
    await setReply(10, '不会记录到日志的秘密回复', replyActor(105));
    await saveComment(10, 101, '不会记录到日志的秘密二级回复', replyActor(105));
    await removeComment(101, undefined, replyActor(105));
    await remove(10, undefined, replyActor(105));
    const logs = await f.db.select().from(systemLog).orderBy(systemLog.id);
    expect(logs).toHaveLength(5);
    for (const log of logs) {
      expect(log).toMatchObject({ storeId: 0, merchantId: 0, adminName: '', ip: '', type: 'product_reply_moderation' });
      expect(log.id).toBeGreaterThan(0); expect(log.addTime).toBeGreaterThan(0);
      expect(JSON.parse(log.action)).toHaveProperty('operation');
      expect(JSON.stringify(log)).not.toContain('秘密');
    }
    expect(logs.slice(1).map(row => row.adminId)).toEqual([105, 105, 105, 105]);
  });

  it('rolls back skipped review or comment DML and complete row rewrites for every applicable operation', async () => {
    const before = await snapshot();
    await f.exec(`CREATE OR REPLACE FUNCTION skip_reply_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_reply_dml BEFORE UPDATE ON store_product_reply FOR EACH ROW EXECUTE FUNCTION skip_reply_dml();
      CREATE TRIGGER skip_comment_dml BEFORE INSERT OR UPDATE OR DELETE ON store_product_reply_comment FOR EACH ROW EXECUTE FUNCTION skip_reply_dml()`);
    for (const operation of [() => setReply(), () => setReply(11), () => saveComment(), () => removeComment(),
      () => remove(), () => f.service.status(10, { status: 1 }, replyActor())]) await expect(operation()).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_reply_dml ON store_product_reply; DROP TRIGGER skip_comment_dml ON store_product_reply_comment');
    await f.exec(`CREATE OR REPLACE FUNCTION rewrite_comment_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.nickname='隐藏业务字段改写'; RETURN NEW; END $$;
      CREATE TRIGGER rewrite_comment_dml BEFORE INSERT OR UPDATE ON store_product_reply_comment FOR EACH ROW EXECUTE FUNCTION rewrite_comment_dml()`);
    for (const operation of [() => setReply(), () => setReply(11), () => saveComment()]) await expect(operation()).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER rewrite_comment_dml ON store_product_reply_comment');
    await f.exec(`CREATE OR REPLACE FUNCTION rewrite_reply_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.comment='改写客户原文'; RETURN NEW; END $$;
      CREATE TRIGGER rewrite_reply_dml BEFORE UPDATE ON store_product_reply FOR EACH ROW EXECUTE FUNCTION rewrite_reply_dml()`);
    for (const operation of [() => setReply(), () => remove(), () => f.service.status(10, { status: 1 }, replyActor())]) await expect(operation()).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back every moderation mutation when audit INSERT is skipped or its method is rewritten', async () => {
    const before = await snapshot();
    const operations = [() => setReply(), () => setReply(11), () => saveComment(), () => removeComment(),
      () => remove(), () => f.service.status(10, { status: 1 }, replyActor())];
    await f.exec(`CREATE OR REPLACE FUNCTION skip_reply_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_reply_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_reply_audit()`);
    for (const operation of operations) await expect(operation()).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_reply_audit ON system_log');
    await f.exec(`CREATE OR REPLACE FUNCTION rewrite_reply_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.method='GET'; RETURN NEW; END $$;
      CREATE TRIGGER rewrite_reply_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_reply_audit()`);
    for (const operation of operations) await expect(operation()).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
  });

  it('checks all default audit scope and identity fields before and after audit INSERT for all write kinds', async () => {
    const before = await snapshot();
    const operations = [() => setReply(), () => saveComment(), () => removeComment(), () => remove(),
      () => f.service.status(10, { status: 1 }, replyActor())];
    for (const [column, value] of [['store_id', '73'], ['merchant_id', '91'], ['admin_name', "'forged actor'"], ['ip', "'203.0.113.91'"]]) {
      await f.exec(`CREATE OR REPLACE FUNCTION rewrite_reply_audit_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.${column}=${value}; RETURN NEW; END $$;
        CREATE TRIGGER rewrite_reply_audit_identity BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_reply_audit_identity()`);
      for (const operation of operations) await expect(operation()).rejects.toThrow('审计');
      expect(await snapshot()).toEqual(before);
      await f.exec('DROP TRIGGER rewrite_reply_audit_identity ON system_log');
      await f.exec(`CREATE OR REPLACE FUNCTION rewrite_reply_audit_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE system_log SET ${column}=${value} WHERE id=NEW.id; RETURN NEW; END $$;
        CREATE TRIGGER rewrite_reply_audit_after AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_reply_audit_after()`);
      for (const operation of operations) await expect(operation()).rejects.toThrow('审计');
      expect(await snapshot()).toEqual(before);
      await f.exec('DROP TRIGGER rewrite_reply_audit_after ON system_log');
    }
  });

  it('rechecks immutable customer evidence and physical deletion after a successful audit trigger', async () => {
    const before = await snapshot();
    await f.exec(`CREATE OR REPLACE FUNCTION mutate_reply_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_reply SET comment='审计后篡改客户正文' WHERE id=10; RETURN NEW; END $$;
      CREATE TRIGGER mutate_reply_after_audit AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION mutate_reply_after_audit()`);
    for (const operation of [() => setReply(), () => saveComment(), () => remove(),
      () => f.service.status(10, { status: 1 }, replyActor())]) await expect(operation()).rejects.toThrow(/回执|核验/);
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER mutate_reply_after_audit ON system_log');
    await f.exec(`CREATE OR REPLACE FUNCTION resurrect_comment_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO store_product_reply_comment(id,reply_id,pid,uid,content) VALUES(100,10,0,1,'审计后复活'); RETURN NEW; END $$;
      CREATE TRIGGER resurrect_comment_after_audit AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION resurrect_comment_after_audit()`);
    await expect(removeComment()).rejects.toThrow(/回执|核验/);
    expect(await snapshot()).toEqual(before);
  });
});
