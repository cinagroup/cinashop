import { expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as tokenCache from '@/utils/cache';
import { md5 } from '@/utils/jwt';
import { PublicProductReviewService } from '@/services/product/PublicProductReviewService';
import { storeProductReply, storeProductReplyComment, systemConfig, systemSupplier, systemUserLevel, user, userRelation } from '@/models/schema';
import { withBuyerInvoices } from './helpers/buyerInvoices';
type S = Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
const prefix = '/api/product/review/910001', list = '/api/product/reviews/70';
async function seed(s: S) {
  await s.f.db.update(user).set({ nickname: '评价客户甲', level: 910, isEverLevel: 1 }).where(eq(user.uid, 11));
  await s.f.db.insert(systemUserLevel).values({ id: 910, name: '本机金牌', isShow: 1 });
  for (const [menuName, value] of [['member_func_status', '1'], ['member_card_status', '1'], ['site_name', '本机平台']]) {
    await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName, menuName)); await s.f.db.insert(systemConfig).values({ menuName, value });
  }
  await s.f.db.update(systemSupplier).set({ supplierName: '本机供应商身份', avatar: '/supplier/local.png' }).where(eq(systemSupplier.id, 7));
  await s.f.db.insert(storeProductReply).values([
    { id: 910001, productId: 70, uid: 11, nickname: '评价客户甲', comment: '置顶评价', type: 2, relationId: 7, top: 1, addTime: 100, productScore: 5, serviceScore: 4, deliveryScore: 5, logisticsScore: 5, replyScore: 1, viewsNum: 8, oid: 912345, unique: 'must-not-leak' },
    { id: 910002, productId: 70, uid: 22, nickname: '评价客户乙', comment: '差评按维度', type: 2, relationId: 7, addTime: 200, productScore: 5, serviceScore: 5, deliveryScore: 2, logisticsScore: 2, replyScore: 3 },
    { id: 910003, productId: 70, uid: 22, nickname: '评价客户乙', comment: '全五星', type: 2, relationId: 7, addTime: 200 },
    { id: 910004, productId: 70, uid: 11, comment: '隐藏评价', status: 0, addTime: 999 },
    { id: 910005, productId: 70, uid: 11, comment: '删除评价', isDel: 1, addTime: 999 },
  ]);
  await s.f.db.insert(storeProductReplyComment).values([
    { id: 920001, replyId: 910001, uid: 11, nickname: '用户根甲', content: '首根', addTime: 200 },
    { id: 920002, replyId: 910001, uid: 22, nickname: '用户根乙', content: '次根', addTime: 200 },
    { id: 920003, replyId: 910001, uid: 11, content: '被删根', isDel: 1, addTime: 999 },
    { id: 920004, replyId: 910001, uid: 0, type: 2, relationId: 7, pid: 920002, content: '供应商直属回复', addTime: 201 },
    { id: 920005, replyId: 910002, uid: 0, pid: 920002, content: '跨评价伪子不能展示', praise: 100, addTime: 999 },
    { id: 920006, replyId: 910001, uid: 0, pid: 920004, content: '孙级不可展示', addTime: 999 },
    { id: 920007, replyId: 910001, uid: 11, pid: 920002, content: '非商家子不可展示', praise: 100, addTime: 999 },
    { id: 920008, replyId: 910001, uid: 0, type: 2, relationId: 8, pid: 920002, content: '其他供应商不可展示', praise: 100, addTime: 999 },
  ]);
}
async function state(s: S) { return { replies: await s.f.db.select().from(storeProductReply).orderBy(storeProductReply.id), comments: await s.f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id), relations: await s.f.db.select().from(userRelation).orderBy(userRelation.id) }; }
async function ok(s: S, path: string, body?: unknown, bearer?: string | null) { const r = await s.request(path, body, bearer); expect(r.status, r.msg).toBe(200); expect(r.headers.get('cache-control')).toContain('no-store'); return r.data; }
it('revalidates successful writes on the commissioned transaction connection without opening a second connection', async () => withBuyerInvoices(async s => {
  await seed(s);
  const [account] = await s.f.db.select({ pwd: user.pwd }).from(user).where(eq(user.uid, 11));
  let before = 0, inside = 0;
  const service = new PublicProductReviewService(s.appContainer, s.env.APP_KEY, { uid: 11, authVersion: md5(account.pwd), expiresAt: Math.floor(Date.now() / 1000) + 60 }, async db => {
    if (!db) { before++; return; }
    inside++; expect(db).not.toBe(s.appContainer.db);
    const [identity] = await db.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role`);
    expect(Number(identity.pid)).toBe(s.appPid); expect(identity.role).toBe(s.appRole);
  });
  expect((await service.visit(910001)).detail.reply.views_num).toBe(9);
  expect(before).toBe(1); expect(inside).toBe(1);
  expect((await ok(s, prefix)).detail.reply.views_num).toBe(9);
}), 120000);
it('rolls back every write when the exact token bucket is revoked before commit without an external call', async () => withBuyerInvoices(async s => {
  await seed(s); const bearer = await s.token(), before = await state(s);
  const cache = vi.spyOn(tokenCache, 'getTokenBucket');
  s.env.UPSTASH_REDIS_URL = 'https://local-token-bucket.invalid'; s.env.UPSTASH_REDIS_TOKEN = 'owned-in-process-token-bucket';
  try {
    for (const [tail, body] of [['visit', { version: 1 }], ['comment', { version: 1, content: 'revoked before commit' }], ['praise', { version: 1, praised: true }], ['comments/920004/praise', { version: 1, praised: true }]] as const) {
      cache.mockReset(); let reads = 0;
      cache.mockImplementation(async key => {
        expect(key).toBe(md5(bearer));
        return ++reads < 3 ? { uid: 11, type: 'api', token: bearer, exp: 60 } : null;
      });
      expect((await s.request(prefix + '/' + tail, body, bearer)).status).not.toBe(200);
      expect(reads).toBe(3); expect(await state(s)).toEqual(before);
    }
  } finally { cache.mockRestore(); s.env.UPSTASH_REDIS_URL = ''; s.env.UPSTASH_REDIS_TOKEN = ''; }
  expect((await ok(s, prefix)).detail.reply.views_num).toBe(8);
}), 120000);
it('serves actual anonymous and authenticated rich directories with complete buckets, deterministic pages and V1 isolation without writes', async () => withBuyerInvoices(async s => {
  await seed(s); const before = await state(s), first = await ok(s, list + '?limit=1', undefined, null);
  expect(first).toMatchObject({ version: 1, uid: 0, productId: 70, page: 1, limit: 1, type: 0, total: 3, stats: { sum_count: 3, good_count: 1, in_count: 1, poor_count: 1 } });
  expect(first.items[0]).toMatchObject({ id: 910001, star: 4, level_name: '本机金牌', vip_status: 1, views_num: 8, comment_sum: 2, is_praise: false, replyComment: { id: 920002, sum: 2, children: { id: 920004, user: { nickname: '本机供应商身份' } } } });
  expect((await ok(s, list + '?page=2&limit=1')).items.map((r: { id: number }) => r.id)).toEqual([910003]);
  expect((await ok(s, list + '?page=3&limit=1')).items.map((r: { id: number }) => r.id)).toEqual([910002]);
  expect((await ok(s, list + '?page=4&limit=1')).items).toEqual([]);
  for (const [type, id] of [[1, 910003], [2, 910001], [3, 910002]]) { const page = await ok(s, list + '?type=' + type); expect(page.total).toBe(1); expect(page.items[0].id).toBe(id); }
  const modern = await ok(s, '/api/v2/reply/list/70'), old = await ok(s, '/api/reply/list/70'); expect(modern[0]).toHaveProperty('replyComment'); expect(old[0]).not.toHaveProperty('replyComment'); expect(old[0].star).toBe(5);
  expect(await state(s)).toEqual(before);
}), 120000);
it('decodes PHP JSON-quoted and TS raw scalar branding and membership configuration before public projection', async () => withBuyerInvoices(async s => {
  await seed(s);
  await s.f.db.insert(storeProductReplyComment).values({ id: 920010, replyId: 910001, uid: 0, type: 0, relationId: 0, content: '平台根回复', addTime: 300 });
  const before = await state(s);
  for (const encoded of [false, true]) {
    const values = { site_name: '平台正式名称', site_logo_square: '/uploads/system/platform.png', member_func_status: '1', member_card_status: '1' };
    for (const [menuName, scalar] of Object.entries(values)) {
      await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName, menuName));
      await s.f.db.insert(systemConfig).values({ menuName, value: encoded ? JSON.stringify(scalar) : scalar });
    }
    const directory = await ok(s, list), comments = await ok(s, prefix + '/comments'), detail = await ok(s, prefix);
    expect(directory.items[0]).toMatchObject({ level_name: '本机金牌', vip_status: 1, replyComment: { user: { nickname: values.site_name, avatar: values.site_logo_square } } });
    expect(comments.items.find((item: { id: number }) => item.id === 920010).user).toMatchObject({ nickname: values.site_name, avatar: values.site_logo_square });
    expect(detail.detail.user).toMatchObject({ level_name: '本机金牌', vip_status: 1 });
    for (const menuName of ['member_func_status', 'member_card_status']) await s.f.db.update(systemConfig).set({ value: encoded ? JSON.stringify('0') : '0' }).where(eq(systemConfig.menuName, menuName));
    expect((await ok(s, list)).items[0]).toMatchObject({ level_name: '', vip_status: 0 });
    expect((await ok(s, prefix)).detail.user).toMatchObject({ level_name: '', vip_status: 0 });
  }
  expect(await state(s)).toEqual(before);
}), 120000);
it('does not publish a hidden member level on review cards, authors or root comments', async () => withBuyerInvoices(async s => {
  await seed(s);
  await s.f.db.update(systemUserLevel).set({ isShow: 0 }).where(eq(systemUserLevel.id, 910));
  const before = await state(s);
  expect((await ok(s, list)).items[0].level_name).toBe('');
  expect((await ok(s, prefix)).detail.user.level_name).toBe('');
  expect((await ok(s, prefix + '/comments')).items.find((item: { id: number }) => item.id === 920001).user.level_name).toBe('');
  expect(await state(s)).toEqual(before);
}), 120000);
it('reads private detail and paginated complete roots without increments; one explicit visit increments exactly once', async () => withBuyerInvoices(async s => {
  await seed(s); const before = await state(s), detail = await ok(s, prefix), page = await ok(s, prefix + '/comments?limit=1');
  expect(detail).toMatchObject({ version: 1, uid: 11, replyId: 910001, detail: { reply: { id: 910001, views_num: 8, comment_sum: 2 }, star: '4' } });
  for (const key of ['oid', 'order_cart_info_id', 'unique', 'sku_unique', 'community_sync_digest']) expect(detail.detail.reply).not.toHaveProperty(key);
  expect(page).toMatchObject({ total: 2, page: 1, limit: 1, items: [{ id: 920002, children: { id: 920004 } }] });
  expect((await ok(s, prefix + '/comments?page=2&limit=1')).items[0].id).toBe(920001); expect(await state(s)).toEqual(before);
  const visited = await ok(s, prefix + '/visit', { version: 1 }); expect(visited.detail.reply.views_num).toBe(9); expect((await ok(s, prefix)).detail.reply.views_num).toBe(9);
  expect((await s.request(prefix, undefined, null)).status).not.toBe(200); expect((await s.request(prefix + '/comments', undefined, null)).status).not.toBe(200);
}), 120000);
it('writes only root comments, binds praise to review and category, and reconciles explicit repeated praise/cancellation', async () => withBuyerInvoices(async s => {
  await seed(s); const created = await ok(s, prefix + '/comment', { version: 1, content: '  我的新回复🙂  ' });
  const [row] = await s.f.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, created.commentId)); expect(row).toMatchObject({ uid: 11, replyId: 910001, pid: 0, content: '我的新回复🙂', type: 0, relationId: 0 });
  expect((await ok(s, prefix + '/comments')).total).toBe(3);
  for (const path of [prefix + '/praise', prefix + '/comments/920002/praise', prefix + '/comments/920004/praise']) {
    expect(await ok(s, path, { version: 1, praised: true })).toMatchObject({ uid: 11, replyId: 910001, praise: 1, isPraise: true });
    expect(await ok(s, path, { version: 1, praised: true })).toMatchObject({ praise: 1, isPraise: true });
    expect(await ok(s, path, { version: 1, praised: false })).toMatchObject({ praise: 0, isPraise: false });
    expect(await ok(s, path, { version: 1, praised: false })).toMatchObject({ praise: 0, isPraise: false });
  }
  for (const id of [920003, 920005, 920006, 920007, 920008]) expect((await s.request(prefix + '/comments/' + id + '/praise', { version: 1, praised: true })).status).not.toBe(200);
  await ok(s, prefix + '/praise', { version: 1, praised: true }); expect((await ok(s, list)).items[0].is_praise).toBe(true); expect((await ok(s, list, undefined, null)).items[0].is_praise).toBe(false);
}), 120000);
it('rejects duplicate/query/body aliases, hidden parents and revoked actors with no writes', async () => withBuyerInvoices(async s => {
  await seed(s); const oldToken = await s.token(), before = await state(s);
  for (const url of [list + '?page=1&page=2', list + '?type=4', list + '?limit=51', prefix + '?x=1', prefix + '/comments?type=1', '/api/product/review/0910001']) expect((await s.request(url)).status).not.toBe(200);
  for (const body of [{ version: 1, praised: 'true' }, { version: 1, praised: true, uid: 22 }, { version: 2, praised: true }]) expect((await s.request(prefix + '/praise', body)).status).not.toBe(200);
  expect((await s.request(prefix + '/comment', { version: 1, content: 'x', pid: 920001 })).status).not.toBe(200);
  const duplicate = await s.fetch(new Request('http://127.0.0.1' + prefix + '/visit', { method: 'POST', headers: { authorization: 'Bearer ' + oldToken, 'content-type': 'application/json' }, body: '{"version":1,"version":1}' })); expect((await duplicate.json<{ status: number }>()).status).not.toBe(200);
  for (const id of [910004, 910005]) for (const tail of ['', '/comments']) expect((await s.request('/api/product/review/' + id + tail)).status).not.toBe(200);
  await s.f.db.update(user).set({ pwd: 'owned-new-password' }).where(eq(user.uid, 11));
  expect((await s.request(prefix + '/visit', { version: 1 }, oldToken)).status).not.toBe(200); expect(await state(s)).toEqual(before);
}), 120000);
for (const mutation of ['visit', 'comment', 'praise'] as const) it('rolls back complete ' + mutation + ' receipt on an AFTER trigger drift', async () => withBuyerInvoices(async s => {
  await seed(s); const before = await state(s), table = mutation === 'comment' ? 'store_product_reply_comment' : 'store_product_reply';
  const change = mutation === 'comment' ? "UPDATE public.store_product_reply_comment SET uid=22 WHERE id=NEW.id;" : "UPDATE public.store_product_reply SET comment='owned trigger drift' WHERE id=NEW.id;";
  await s.f.exec(`CREATE FUNCTION local_public_review_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 THEN ${change} END IF; RETURN NEW; END $$; CREATE TRIGGER local_public_review_drift AFTER ${mutation === 'comment' ? 'INSERT' : 'UPDATE'} ON public.${table} FOR EACH ROW EXECUTE FUNCTION local_public_review_drift()`);
  const body = mutation === 'comment' ? { version: 1, content: 'must roll back' } : mutation === 'praise' ? { version: 1, praised: true } : { version: 1 };
  expect((await s.request(prefix + '/' + mutation, body)).status).not.toBe(200); expect(await state(s)).toEqual(before);
}), 120000);
it('returns promptly behind a proven parent lock and commits one relation under competing explicit likes', async () => withBuyerInvoices(async s => {
  await seed(s); const before = await state(s);
  await s.f.withPeer!(async peer => {
    let release!: () => void, locked!: () => void, failed!: (e: unknown) => void; const held = new Promise<void>((yes, no) => { locked = yes; failed = no; }), gate = new Promise<void>(yes => release = yes);
    const blocking = peer.db.transaction(async tx => { await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SELECT id FROM public.store_product_reply WHERE id=910001 FOR UPDATE NOWAIT`); locked(); await gate; }); void blocking.catch(failed);
    try { await held; expect((await s.request(prefix + '/visit', { version: 1 })).status).not.toBe(200); expect(await state(s)).toEqual(before); } finally { release(); await blocking; }
  });
  const results = await Promise.all([s.request(prefix + '/praise', { version: 1, praised: true }), s.request(prefix + '/praise', { version: 1, praised: true })]); expect(results.some(row => row.status === 200)).toBe(true);
  expect(await ok(s, prefix + '/praise', { version: 1, praised: true })).toMatchObject({ praise: 1, isPraise: true });
  expect((await s.f.db.select().from(userRelation)).filter(row => row.category === 'reply' && row.relationId === 910001)).toHaveLength(1);
}), 120000);

it('rejects relation-trigger drift, root deletion under comment praise and post-lock actor revocation atomically', async () => withBuyerInvoices(async s => {
  await seed(s); const before = await state(s);
  await s.f.exec("CREATE FUNCTION local_relation_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 THEN INSERT INTO public.user_relation(uid,relation_id,type,category,add_time) VALUES(22,NEW.relation_id,'like',NEW.category,1); END IF; RETURN NEW; END $$; CREATE TRIGGER local_relation_drift AFTER INSERT ON public.user_relation FOR EACH ROW EXECUTE FUNCTION local_relation_drift()");
  expect((await s.request(prefix + '/praise', { version: 1, praised: true })).status).not.toBe(200); expect(await state(s)).toEqual(before);
  await s.f.exec('DROP TRIGGER local_relation_drift ON public.user_relation; DROP FUNCTION local_relation_drift()');
  await s.f.exec("CREATE FUNCTION local_root_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 THEN UPDATE public.store_product_reply_comment SET is_del=1 WHERE id=920002; END IF; RETURN NEW; END $$; CREATE TRIGGER local_root_drift AFTER UPDATE ON public.store_product_reply_comment FOR EACH ROW EXECUTE FUNCTION local_root_drift()");
  expect((await s.request(prefix + '/comments/920004/praise', { version: 1, praised: true })).status).not.toBe(200); expect(await state(s)).toEqual(before);
  await s.f.exec('DROP TRIGGER local_root_drift ON public.store_product_reply_comment; DROP FUNCTION local_root_drift()');
  await s.f.exec("CREATE FUNCTION local_actor_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.\"user\" SET status=0 WHERE uid=11; RETURN NEW; END $$; CREATE TRIGGER local_actor_drift AFTER UPDATE ON public.store_product_reply FOR EACH ROW EXECUTE FUNCTION local_actor_drift()");
  expect((await s.request(prefix + '/visit', { version: 1 })).status).not.toBe(200); expect(await state(s)).toEqual(before);
  expect((await s.f.db.select({ status: user.status }).from(user).where(eq(user.uid, 11)))[0].status).toBe(1);
}), 120000);
it('does not silently truncate malformed or excessive historical media and preserves empty private slots', async () => withBuyerInvoices(async s => {
  await seed(s);
  await s.f.db.update(storeProductReply).set({ pics: '["","/api/assets/2147483000"]' }).where(eq(storeProductReply.id, 910001));
  expect((await ok(s, list)).items[0].pics).toEqual(['', '']);
  for (const pics of ['invalid', JSON.stringify(Array(10).fill('/legacy.png')), JSON.stringify(['x'.repeat(20001)])]) {
    await s.f.db.update(storeProductReply).set({ pics }).where(eq(storeProductReply.id, 910001)); const before = await state(s);
    expect((await s.request(list)).status).not.toBe(200); expect((await s.request(prefix)).status).not.toBe(200); expect(await state(s)).toEqual(before);
  }
}), 120000);
