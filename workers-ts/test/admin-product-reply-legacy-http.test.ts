import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { storeProduct, storeProductReply, storeProductReplyComment, systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { parseAdminProductReplyQuery } from '../src/services/admin/AdminProductReplyService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Legacy review fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Legacy review fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: 'local-admin-review-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const ids = { reader: 9831, manager: 9832, adjacent: 9833 } as const;
type Identity = keyof typeof ids;
const tokens = new Map<Identity, string>();
const start = Date.parse('2026-10-12T00:00:00+08:00') / 1_000;
let fixture: Awaited<ReturnType<typeof financePostgres>>;

beforeEach(async () => {
  fixture = await financePostgres([storeProduct, storeProductReply, storeProductReplyComment, systemAdmin, systemRole, systemMenus]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(storeProduct).values([
    { id: 11, storeName: '平台保温杯', keyword: '保温', image: '/platform.png', type: 0, relationId: 0 },
    { id: 22, storeName: '供应商咖啡', keyword: '咖啡', image: '/supplier.png', type: 2, relationId: 91 },
    { id: 33, storeName: '门店蛋糕', keyword: '蛋糕', image: '/store.png', type: 1, relationId: 81 },
  ]);
  await fixture.db.insert(storeProductReply).values([
    { id: 101, productId: 11, nickname: '平台买家', type: 0, relationId: 0, addTime: start + 3_600,
      comment: '不错', productScore: 5, serviceScore: 4, deliveryScore: 3, replyScore: 3, pics: '["/a.png","/b.png"]' },
    { id: 102, productId: 22, nickname: '供应商买家', type: 2, relationId: 91, addTime: start + 86_400, replyScore: 2 },
    { id: 103, productId: 33, nickname: '门店买家', type: 1, relationId: 81, addTime: start - 1, replyScore: 1 },
    { id: 104, productId: 999, nickname: '旧商品买家', type: 0, relationId: 0, addTime: start + 60 },
    { id: 105, productId: 11, nickname: '已删除买家', type: 0, relationId: 0, addTime: start + 2, isDel: 1 },
  ]);
  await fixture.db.insert(storeProductReplyComment).values([
    { id: 501, replyId: 102, uid: 0, pid: 0, type: 2, relationId: 91, content: '供应商原回复', addTime: start, updateTime: start },
    { id: 502, replyId: 101, uid: 77, pid: 0, type: 0, relationId: 0, content: '用户跟评', addTime: start, updateTime: start },
    { id: 503, replyId: 101, uid: 0, pid: 502, type: 0, relationId: 0, content: '二级回复', addTime: start, updateTime: start },
  ]);
  const grants: Record<Identity, string> = { reader: 'product.view', manager: 'product.manage', adjacent: 'reply.manage' };
  const password = 'legacy-review-fixture';
  await fixture.db.insert(systemRole).values(Object.entries(ids).map(([name, id]) => ({
    id, roleName: name, rules: grants[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(ids).map(([name, id]) => ({
    id, account: 'review-' + name, pwd: password, roles: String(id), level: 1, adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(ids)) tokens.set(name as Identity,
    (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
}, 30_000);

afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(path = '', identity: Identity | 'anonymous' = 'manager', method = 'GET', body?: unknown) {
  const response = await app.request('/adminapi/product/reply' + path, {
    method, headers: {
      ...(identity === 'anonymous' ? {} : { Authorization: 'Bearer ' + tokens.get(identity) }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  return response.json<{ status: number; msg: string; data: any }>();
}

it('returns the global legacy list including all owners and missing-product history with the old Vue projections', async () => {
  const result = await request('', 'reader');
  expect(result.status).toBe(200);
  expect(result.data).toMatchObject({ count: 4, page: 1, limit: 15 });
  expect(result.data.list.map((row: any) => row.id)).toEqual([102, 101, 104, 103]);
  expect(result.data.list.find((row: any) => row.id === 101)).toMatchObject({
    product_id: 11, store_name: '平台保温杯', image: '/platform.png', nickname: '平台买家', account: '平台买家',
    comment: '不错', pics: ['/a.png', '/b.png'], score: '4', reply_score: 3,
    add_time: '2026-10-12 01:00:00', create_time: '2026-10-12 01:00:00', replyComment: null,
  });
  expect(result.data.list[0]).toMatchObject({ type: 2, relation_id: 91, reply_score: 2,
    replyComment: { id: 501, content: '供应商原回复', type: 2, relation_id: 91 } });
  expect(result.data.list.find((row: any) => row.id === 104)).toMatchObject({ store_name: '', image: '' });
});

it('applies matching count, pagination, product/account and the original slash-date boundary filter', async () => {
  const range = await request('?data=2026%2F10%2F12-2026%2F10%2F12&limit=2&page=2');
  expect(range.data.count).toBe(3);
  expect(range.data.list.map((row: any) => row.id)).toEqual([104]);
  const filtered = await request('?product_id=11&store_name=%E4%BF%9D%E6%B8%A9&account=%E5%B9%B3%E5%8F%B0');
  expect(filtered.data.count).toBe(1);
  expect(filtered.data.list[0].id).toBe(101);
  expect(parseAdminProductReplyQuery({ data: 'today' }, start + 43_200))
    .toMatchObject({ startTime: start, endTime: start + 86_399 });
  expect(parseAdminProductReplyQuery({ data: 'lately7' }, start))
    .toMatchObject({ startTime: start - 7 * 86_400, endTime: start });
  expect(parseAdminProductReplyQuery({ data: 'quarter' }, start))
    .toMatchObject({ startTime: Date.parse('2026-10-01T00:00:00+08:00') / 1_000,
      endTime: Date.parse('2026-12-31T00:00:00+08:00') / 1_000 });
  expect(parseAdminProductReplyQuery({ data: '2026/10/12-' }, start)).toMatchObject({ startTime: start });
  expect(parseAdminProductReplyQuery({ data: '-2026/10/12' }, start)).toMatchObject({ endTime: start + 86_399 });
  expect(() => parseAdminProductReplyQuery({ data: 'constructor' }, start)).toThrow('评价时间范围无效');
  expect((await request('?data=2026%2F02%2F30-2026%2F03%2F01')).status).not.toBe(200);
  expect((await request('?limit=101')).status).not.toBe(200);
});

it('requires the existing product view/manage capabilities on all four legacy routes', async () => {
  expect(requiredAdminPermission('GET', '/adminapi/product/reply')).toBe('product.view');
  expect(requiredAdminPermission('GET', '/adminapi/product/reply/get_reply/101')).toBe('product.view');
  expect(requiredAdminPermission('PUT', '/adminapi/product/reply/set_reply/101')).toBe('product.manage');
  expect(requiredAdminPermission('DELETE', '/adminapi/product/reply/101')).toBe('product.manage');
  expect((await request('', 'anonymous')).status).not.toBe(200);
  expect((await request('', 'adjacent')).status).not.toBe(200);
  expect((await request('/set_reply/101', 'reader', 'PUT', { content: '无权修改' })).status).not.toBe(200);
  expect((await request('/101', 'reader', 'DELETE')).status).not.toBe(200);
  expect((await fixture.db.select().from(storeProductReply).where(eq(storeProductReply.id, 101)))[0])
    .toMatchObject({ isReply: 0, isDel: 0 });
});

it('creates one platform root reply and updates it in place while preserving unrelated comment history', async () => {
  expect(await request('/get_reply/101', 'reader')).toMatchObject({ status: 200, data: { content: '' } });
  const before = await fixture.db.select().from(storeProductReplyComment);
  const first = await request('/set_reply/101', 'manager', 'PUT', { content: '  感谢反馈  ' });
  expect(first).toMatchObject({ status: 200, data: { id: 101, is_reply: 1 } });
  const id = first.data.comment_id;
  expect(await request('/set_reply/101', 'manager', 'PUT', { content: '已经处理' }))
    .toMatchObject({ status: 200, data: { comment_id: id, is_reply: 1 } });
  expect(await request('/get_reply/101', 'reader')).toMatchObject({ status: 200, data: {
    id, reply_id: 101, uid: 0, pid: 0, type: 0, relation_id: 0, content: '已经处理',
  } });
  const after = await fixture.db.select().from(storeProductReplyComment);
  expect(after).toHaveLength(before.length + 1);
  for (const row of before) expect(after.find(item => item.id === row.id)).toEqual(row);
});

it('keeps a supplier review state and supplier reply intact when a platform Admin replies', async () => {
  const supplier = (await fixture.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, 501)))[0];
  expect(await request('/set_reply/102', 'manager', 'PUT', { content: '平台管理员说明' }))
    .toMatchObject({ status: 200, data: { id: 102, is_reply: 0 } });
  const [parent] = await fixture.db.select().from(storeProductReply).where(eq(storeProductReply.id, 102));
  expect(parent).toMatchObject({ type: 2, relationId: 91, isReply: 0 });
  expect((await fixture.db.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, 501)))[0])
    .toEqual(supplier);
  expect(await request('/get_reply/102', 'reader')).toMatchObject({ status: 200, data: {
    uid: 0, pid: 0, type: 0, relation_id: 0, content: '平台管理员说明',
  } });
});

it('soft-deletes only the target review and preserves its original fields and comment records', async () => {
  const before = await fixture.db.select().from(storeProductReply);
  const comments = await fixture.db.select().from(storeProductReplyComment);
  expect(await request('/102', 'manager', 'DELETE')).toMatchObject({ status: 200, msg: '删除成功!' });
  const after = await fixture.db.select().from(storeProductReply);
  for (const row of before) expect(after.find(item => item.id === row.id))
    .toEqual(row.id === 102 ? { ...row, isDel: 1 } : row);
  expect(await fixture.db.select().from(storeProductReplyComment)).toEqual(comments);
  expect((await request()).data.count).toBe(3);
  expect((await request('/get_reply/102')).status).not.toBe(200);
  expect((await request('/set_reply/102', 'manager', 'PUT', { content: '删除后回复' })).status).not.toBe(200);
});

it('rejects invalid identities and reply content without writing any review or comment', async () => {
  const reviews = await fixture.db.select().from(storeProductReply);
  const comments = await fixture.db.select().from(storeProductReplyComment);
  for (const suffix of ['/set_reply/0', '/set_reply/1e2', '/set_reply/2147483648', '/set_reply/99999']) {
    expect((await request(suffix, 'manager', 'PUT', { content: '无效目标' })).status).not.toBe(200);
  }
  for (const content of ['', '   ', '评'.repeat(1_001), { text: '无效' }]) {
    expect((await request('/set_reply/101', 'manager', 'PUT', { content })).status).not.toBe(200);
  }
  expect((await request('/set_reply/101', 'manager', 'PUT', { content: '评'.repeat(9_000) })).status).not.toBe(200);
  expect(await fixture.db.select().from(storeProductReply)).toEqual(reviews);
  expect(await fixture.db.select().from(storeProductReplyComment)).toEqual(comments);
});

it('updates every historical duplicate platform root reply while leaving other owners untouched', async () => {
  await fixture.db.insert(storeProductReplyComment).values([
    { id: 601, replyId: 101, uid: 0, pid: 0, type: 0, relationId: 0, content: '旧回复一' },
    { id: 602, replyId: 101, uid: 0, pid: 0, type: 0, relationId: 0, content: '旧回复二' },
    { id: 603, replyId: 101, uid: 0, pid: 0, type: 2, relationId: 91, content: '其他端回复' },
  ]);
  expect((await request('/set_reply/101', 'manager', 'PUT', { content: '统一更正' })).status).toBe(200);
  const roots = await fixture.db.select().from(storeProductReplyComment).where(and(
    eq(storeProductReplyComment.replyId, 101), eq(storeProductReplyComment.uid, 0), eq(storeProductReplyComment.pid, 0),
  ));
  expect(roots.filter(row => row.type === 0 && row.relationId === 0).map(row => row.content)).toEqual(['统一更正', '统一更正']);
  expect(roots.find(row => row.id === 603)?.content).toBe('其他端回复');
});

it('accepts the Admin comment column limit without narrowing it to the Supplier content limit', async () => {
  const content = '评'.repeat(1_000);
  expect((await request('/set_reply/101', 'manager', 'PUT', { content })).status).toBe(200);
  expect((await request('/get_reply/101')).data.content).toBe(content);
});
