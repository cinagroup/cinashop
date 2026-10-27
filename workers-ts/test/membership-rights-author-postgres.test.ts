import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { agreement, memberRight, memberShip, memberCard, memberCardBatch, otherOrder, otherOrderStatus, user,
  userBill, storeCouponIssue, storeCouponUser, storeOrderEconomize, systemAdmin, systemRole, systemMenus,
  systemAttachment, systemAttachmentCategory, systemConfig } from '@/models/schema';
import { AdminMembershipRightAuthorService, type MembershipRightAuthorPage, type MembershipRightAuthorRow } from '@/services/admin/AdminMembershipRightAuthorService';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, opened: 0, closed: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned membership-right fixture'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned membership-right Admin fixture'); wiring.opened++;
    return { container: wiring.container, close: async () => { wiring.closed++; } }; },
}));
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Envelope = { status: number; msg: string; data: unknown };
const password = 'owned-membership-right-password', userPassword = md5('owned-membership-right-user');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const coreKeys = ['id','right_type','title','show_title','image','explain','content','number','sort','status','add_time'].sort();
const metadata = (row: MembershipRightAuthorRow): Row => ({ right_type: row.right_type, title: row.title, show_title: row.show_title,
  image: row.image, explain: row.explain, number: row.number, sort: row.sort });
const createBody = (extra: Row = {}): Row => ({ author: 1, version: 'absent', right_type: 'offline', title: '线下付款', show_title: '线下优惠',
  image: '/api/assets/101', explain: '折扣说明', number: 80, sort: 9, status: 1, ...extra });

/** Registered createApp/JWT/permission/SQL and actual multipart/R2 byte paths on
 * this owned fixture. Native PG16 peers alone prove blocking interleavings;
 * fallback PGlite still executes every business assertion without skips.
 * This does not commission independent application/Admin LOGIN grants. */
describe('membership-right authoring, public styled HTML and media ownership', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, app: ReturnType<typeof createApp>, env: Env, tables: string[], sequences: string[];
  const tokens = new Map<number, string>(), objects = new Map<string, { bytes: Uint8Array; type: string }>(), replies: Row[] = [];
  const bucket = {
    put: vi.fn(async (key: string, stream: ReadableStream<Uint8Array>, options: { httpMetadata?: { contentType?: string } }) => {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer()); objects.set(key, { bytes, type: options.httpMetadata?.contentType ?? '' }); return { size: bytes.length };
    }),
    get: vi.fn(async (key: string) => { const value = objects.get(key); return value ? { body: new Response(value.bytes).body, size: value.bytes.length,
      httpEtag: '"owned-membership-right"', httpMetadata: { contentType: value.type }, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', value.type) } : null; }),
    head: vi.fn(async () => { throw Error('Unexpected membership-right R2 head'); }), list: vi.fn(async () => { throw Error('Unexpected membership-right R2 list'); }),
    delete: vi.fn(async () => { throw Error('Unexpected membership-right R2 delete'); }),
  };
  const queue = { send: vi.fn(async () => { throw Error('Unexpected membership-right queue'); }), sendBatch: vi.fn(async () => { throw Error('Unexpected membership-right queue batch'); }) };
  const cache = { get: vi.fn(async (key: string) => key === 'cfg_site_name' ? '原生权益商店' : null),
    put: vi.fn(async () => { throw Error('Unexpected membership-right cache put'); }), delete: vi.fn(async () => { throw Error('Unexpected membership-right cache delete'); }) };
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    const orm = [agreement, memberRight, memberShip, memberCard, memberCardBatch, otherOrder, otherOrderStatus, user, userBill,
      storeCouponIssue, storeCouponUser, storeOrderEconomize, systemAdmin, systemRole, systemMenus, systemAttachment, systemAttachmentCategory, systemConfig];
    f = await financePostgres(orm, { namespace: 'public' });
    env = { APP_KEY: 'owned-membership-right-jwt-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ASSETS_BUCKET: bucket, ORDER_QUEUE: queue, CONFIG_KV: cache } as unknown as Env;
    wiring.container = createContainerFromDb(f.db); app = createApp();
    for (const id of [100,101,102,103,104,105,106]) tokens.set(id, (await createToken(id, 'admin', md5(id === 106 ? 'old-password' : password), env.APP_KEY)).token);
    tokens.set(11, (await createToken(11, 'api', md5(userPassword), env.APP_KEY)).token);
    tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    expect(tables).toEqual(orm.map(table => getTableConfig(table).name).sort());
    expect(sequences).toEqual(orm.flatMap(table => { const c = getTableConfig(table); return c.columns.filter(column => column.getSQLType() === 'serial').map(column => `${c.name}_${column.name}_seq`); }).sort());
  }, 30000);
  beforeEach(async () => {
    await f.reset(); objects.clear(); for (const operation of [...Object.values(bucket), ...Object.values(queue), ...Object.values(cache)]) operation.mockClear();
    await f.db.insert(systemRole).values([{ id: 1, roleName: '权益管理和图库', rules: 'paid_membership.manage,attachment.manage', status: 1 },
      { id: 2, roleName: '权益只读', rules: 'paid_membership.view,attachment.view', status: 1 }, { id: 3, roleName: '其他权限', rules: 'user.view', status: 1 }]);
    await f.db.insert(systemAdmin).values([{ id: 100, account: 'right-super', pwd: password, level: 0, status: 1 },
      { id: 101, account: 'right-manager', pwd: password, level: 1, roles: '1', status: 1 }, { id: 102, account: 'right-reader', pwd: password, level: 1, roles: '2', status: 1 },
      { id: 103, account: 'right-other', pwd: password, level: 1, roles: '3', status: 1 }, { id: 104, account: 'right-disabled', pwd: password, level: 1, roles: '1', status: 0 },
      { id: 105, account: 'right-supplier', pwd: password, adminType: 2, relationId: 9, level: 1, roles: '1', status: 1 },
      { id: 106, account: 'right-stale', pwd: password, level: 1, roles: '1', status: 1 }]);
    await f.db.insert(user).values({ uid: 11, account: 'right-customer', pwd: userPassword, nickname: '权益客户', nowMoney: '103.25', integral: 17, levelExtendInfo: '[{"preserve":true}]' });
    await f.db.insert(systemConfig).values([{ menuName: 'station_open', value: '1' }, { menuName: 'member_card_status', value: '1' }]);
    await f.db.insert(memberShip).values({ id: 701, title: '不可改套餐', type: 'month', vipDay: 30, price: '20.00', prePrice: '10.00' });
    await f.db.insert(otherOrder).values({ id: 801, uid: 11, orderId: 'immutable-member-order', memberType: '701', paid: 1, payPrice: '10.00' });
    await f.db.insert(memberRight).values([
      { id: 501, rightType: 'integral', title: '积分奖励', showTitle: '双倍积分', image: '/api/assets/101', explain: '积分翻倍', content: '<p style="color:#123ABC;font-size:20px"><strong>原介绍</strong><img src="/api/assets/101"></p>', number: 2, sort: 100, status: 1 },
      { id: 502, rightType: 'express', title: '运费折扣', showTitle: '运费优惠', image: '/api/assets/102', explain: '运费八折', content: '<script>bad()</script><p onclick="bad()">运费<img src="/api/assets/102"></p>', number: 80, sort: 100, status: 1 },
      { id: 503, rightType: 'vip_price', title: '隐藏权益', showTitle: '隐藏权益', image: '/api/assets/101', content: null, number: 0, sort: 101, status: 0 },
      { id: 504, rightType: 'sign', title: '历史签到', showTitle: '历史展示名称超过八字', image: '', explain: '历史简介超过八个字且保留空格  ', content: null, number: 0, sort: 99, status: 1 },
      ...Array.from({ length: 31 }, (_, index) => ({ id: 600 + index, rightType: 'coupon', title: '优惠券' + index, showTitle: '券' + index,
        image: '/static/logo.png', explain: '优惠券', content: '<p>优惠券说明</p>', number: 0, sort: index % 3, status: index % 2 })),
    ]);
    await f.db.insert(systemAttachment).values([
      { attId: 101, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/right.png', attDir: '/api/assets/101', attType: 'image/png' },
      { attId: 102, type: 4, relationId: 9, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/9/private.png', attDir: '/api/assets/102', attType: 'image/png' },
      { attId: 103, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: 8, name: 'attachments/user/11/private.png', attDir: '/api/assets/103', attType: 'image/png' },
      { attId: 104, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/9/wrong.png', attDir: '/api/assets/104', attType: 'image/png' },
      { attId: 105, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/vector.svg', attDir: '/api/assets/105', attType: 'image/svg+xml' },
      { attId: 106, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/mismatch.jpg', attDir: '/api/assets/106', attType: 'image/png' },
    ]);
    objects.set('attachments/admin/1/right.png', { bytes: png, type: 'image/png' });
  }, 30000);
  afterAll(async () => { try { expect(replies.length).toBeGreaterThan(0); expect(wiring.opened).toBe(wiring.closed);
    expect(fetch).not.toHaveBeenCalled(); expect(queue.send).not.toHaveBeenCalled(); expect(queue.sendBatch).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled(); expect(cache.delete).not.toHaveBeenCalled();
  } finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function snapshot(): Promise<Snapshot> {
    const result: Snapshot = {}; for (const table of tables) result[table] = (await f.db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`)).map(row => row.row);
    result.__sequences = await f.db.execute<Row>(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `)); return result;
  }
  const resources = () => ({ objects: [...objects].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, sha256: sha(value.bytes), type: value.type })),
    reads: bucket.get.mock.calls.length + bucket.head.mock.calls.length + bucket.list.mock.calls.length,
    writes: bucket.put.mock.calls.length, deletes: bucket.delete.mock.calls.length, queue: queue.send.mock.calls.length + queue.sendBatch.mock.calls.length, cache: cache.put.mock.calls.length + cache.delete.mock.calls.length });
  async function request(path: string, body?: Row | string, actor = 101) {
    const before = await snapshot(), oldResources = resources();
    const response = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(actor ? { Authorization: 'Bearer ' + tokens.get(actor) } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }, env);
    const raw = await response.text(), envelope = JSON.parse(raw) as Envelope;
    replies.push({ path, actor, http: response.status, status: envelope.status, sha256: sha(raw) });
    expect(response.headers.get('content-type'), raw).toContain('application/json'); expect(resources()).toEqual(oldResources);
    return { ...envelope, before, after: await snapshot(), response };
  }
  async function unchanged(path: string, body?: Row | string, actor = 101, expected = 200) { const r = await request(path, body, actor); expect(r.status, r.msg).toBe(expected); if (expected === 409) expect(r.response.status, 'PHP-compatible conflict HTTP status').toBe(200); expect(r.after).toEqual(r.before); return r; }
  async function page(actor = 101, query = 'author=1&page=1&limit=30') { const r = await unchanged('/adminapi/member/right?' + query, undefined, actor); expect(r.response.headers.get('cache-control')).toContain('no-store'); return r.data as MembershipRightAuthorPage; }
  async function right(id = 501) { return (await page(101, 'author=1&page=1&limit=100')).list.find(row => row.id === id)!; }
  function onlyRight(before: Snapshot, after: Snapshot, id: number, fields: Row) { const expected = structuredClone(before), row = expected.member_right!.find(row => row.id === id)!; Object.assign(row, fields); expect(after).toEqual(expected); }
  function ticket(value: string, reference: string) { const url = new URL(value, 'https://owned-right.test'); expect(url.pathname).toBe(reference);
    const expires = url.searchParams.get('expires')!, signature = url.searchParams.get('signature')!; expect(Number(expires)).toBeGreaterThan(Date.now() / 1000);
    const expected = createHmac('sha256', env.APP_KEY).update(`GET\n${reference}\n${expires}`).digest('base64url'); expect(signature).toBe(expected); }

  it('keeps the default11-field list and offers real author identity, PHP ordering, complete pagination and separate editing/preview values', async () => {
    const legacy = (await unchanged('/adminapi/member/right', undefined, 102)).data as { list: Row[]; count: number };
    expect(legacy.count).toBe(35); expect(legacy.list).toHaveLength(35); expect(Object.keys(legacy.list[0]!).sort()).toEqual(coreKeys);
    expect(legacy.list.filter(row => row.sort === 100).map(row => row.id)).toEqual([501, 502]);
    const first = await page(102), second = await page(102, 'author=1&page=2&limit=30');
    expect(first).toMatchObject({ author: 1, actor_id: 102, page: 1, limit: 30, count: 35 }); expect(second.list).toHaveLength(5);
    expect(first.list.slice(0, 3).map(row => row.id)).toEqual([503, 502, 501]); expect(new Set([...first.list, ...second.list].map(row => row.id)).size).toBe(35);
    const good = first.list.find(row => row.id === 501)!, foreign = first.list.find(row => row.id === 502)!;
    expect(Object.keys(good).sort()).toEqual([...coreKeys, 'version', 'image_preview', 'content_preview'].sort()); expect(good.version).toMatch(/^[a-f0-9]{64}$/);
    expect(good.image).toBe('/api/assets/101'); expect(good.content).toContain('src="/api/assets/101"'); ticket(good.image_preview, good.image);
    expect(good.content_preview).toContain('color:#123ABC'); expect(good.content_preview).toContain('font-size:20px'); expect(good.content_preview).toContain('signature=');
    expect(foreign.image).toBe('/api/assets/102'); expect(foreign.image_preview).toBe(''); expect(foreign.content_preview).not.toMatch(/script|onclick|signature=/);
  });
  it.each(['author=0','author=01','author=1&author=1','author=1&page=0','author=1&page=01','author=1&limit=101','author=1&limit=0','author=1&page=1002&limit=100','author=1&status=1'])('rejects unreviewed author query %s without writes', async query => {
    await unchanged('/adminapi/member/right?' + query, undefined, 101, 400);
  });
  it('uploads real multipart bytes through the registered Admin route, then independently saves metadata/content/status and serves the authorized object', async () => {
    const beforeUpload = await snapshot(), beforeObjects = resources(), form = new FormData(); form.set('file', new File([png], 'right-upload.png', { type: 'image/png' })); form.set('pid', '0');
    const uploadRequest = new Request('https://owned-right.test/adminapi/file/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.get(101) }, body: form });
    const bytes = new Uint8Array(await uploadRequest.arrayBuffer()); const headers = new Headers(uploadRequest.headers); headers.set('Content-Length', String(bytes.length));
    const uploaded = await app.fetch(new Request(uploadRequest.url, { method: 'POST', headers, body: bytes }), env); const upload = await uploaded.json() as Envelope;
    expect(upload.status, upload.msg).toBe(200); const data = upload.data as { url: string; src: string; att_id: number }; expect(data.url).toBe('/api/assets/' + data.att_id);
    const afterUpload = await snapshot(); for (const name of tables) if (name !== 'system_attachment') expect(afterUpload[name], name).toEqual(beforeUpload[name]);
    expect(afterUpload.system_attachment).toHaveLength(beforeUpload.system_attachment!.length + 1); expect(resources().writes).toBe(beforeObjects.writes + 1);
    expect(afterUpload.__sequences!.filter(row => row.name !== 'system_attachment_att_id_seq')).toEqual(beforeUpload.__sequences!.filter(row => row.name !== 'system_attachment_att_id_seq'));
    expect(afterUpload.__sequences!.find(row => row.name === 'system_attachment_att_id_seq')).toMatchObject({ last: String(data.att_id), called: true });
    const asset = afterUpload.system_attachment!.find(row => row.att_id === data.att_id)!; expect(asset).toMatchObject({ type: 1, relation_id: 0, module_type: 1, file_type: 1, image_type: 8, att_dir: data.url });
    expect(objects.get(String(asset.name))!.bytes).toEqual(png); expect(String(asset.att_type).trim()).toBe('image/png');
    const initial = await right(); const saved = await request('/adminapi/member_right/save/501', { author: 1, version: initial.version, ...metadata(initial), image: data.src, show_title: '新权益' });
    expect(saved.status, saved.msg).toBe(200); onlyRight(saved.before, saved.after, 501, { image: data.url, show_title: '新权益' });
    const meta = await right(); expect(meta.version).not.toBe(initial.version); ticket(meta.image_preview, data.url);
    const content = '<h3 style="color:red;font-size:24px">权益介绍</h3><ul><li>第一项</li></ul><p><img src="' + data.src + '" onerror="bad()"></p><script>bad()</script>';
    const rich = await request('/adminapi/member/save/content/501', { author: 1, version: meta.version, content }); expect(rich.status, rich.msg).toBe(200);
    const stored = rich.after.member_right!.find(row => row.id === 501)!.content as string; expect(stored).toContain('<h3 style="color:red;font-size:24px">'); expect(stored).toContain('<li>第一项</li>');
    expect(stored).toContain('src="' + data.url + '"'); expect(stored).not.toMatch(/signature=|expires=|script|onerror/); onlyRight(rich.before, rich.after, 501, { content: stored });
    const edited = await right(); const toggled = await request('/adminapi/member_right/save/501', { author: 1, version: edited.version, status: 0 });
    expect(toggled.status, toggled.msg).toBe(200); onlyRight(toggled.before, toggled.after, 501, { status: 0 });
    const beforeRead = await snapshot(), getCount = bucket.get.mock.calls.length, served = await app.fetch(new Request('https://owned-right.test' + meta.image_preview), env);
    expect(served.status).toBe(200); expect(new Uint8Array(await served.arrayBuffer())).toEqual(png); expect(await snapshot()).toEqual(beforeRead); expect(bucket.get.mock.calls.length).toBe(getCount + 1);
  });
  it('preserves every unchanged long/invalid historical field and signed raw HTML byte while no-op writes preserve null and sequences', async () => {
    const rawImage = '/api/assets/101?expires=1&signature=old', rawContent = '<p style="color:red"><img src="/api/assets/101?expires=1&amp;signature=old"></p>';
    await f.db.update(memberRight).set({ image: rawImage, content: rawContent }).where(eq(memberRight.id, 504));
    const row = await right(504); expect(row.image).toBe('/api/assets/101'); expect(row.content).toContain('src="/api/assets/101"');
    await unchanged('/adminapi/member_right/save/504', { author: 1, version: row.version, ...metadata(row) });
    await unchanged('/adminapi/member/save/content/504', { author: 1, version: row.version, content: row.content });
    expect((await f.db.select().from(memberRight).where(eq(memberRight.id, 504)))[0]).toMatchObject({ image: rawImage, content: rawContent, number: 0 });
    const nil = await right(503); await unchanged('/adminapi/member/save/content/503', { author: 1, version: nil.version, content: '' });
    expect((await f.db.select().from(memberRight).where(eq(memberRight.id, 503)))[0]!.content).toBeNull();
    const changed = await request('/adminapi/member_right/save/504', { author: 1, version: row.version, show_title: '新标题' }); expect(changed.status, changed.msg).toBe(200);
    onlyRight(changed.before, changed.after, 504, { show_title: '新标题' });
  });
  it('creates through the existing id0 route with8exact fields, leaving every financial table untouched', async () => {
    const r = await request('/adminapi/member_right/save/0', createBody()); expect(r.status, r.msg).toBe(200); const data = r.data as { id: number; version: string };
    expect(data.id).toBeGreaterThan(0); expect(data.version).toMatch(/^[a-f0-9]{64}$/); for (const name of tables) if (name !== 'member_right') expect(r.after[name], name).toEqual(r.before[name]);
    expect(r.after.__sequences!.filter(row => row.name !== 'member_right_id_seq')).toEqual(r.before.__sequences!.filter(row => row.name !== 'member_right_id_seq'));
    expect(r.after.__sequences!.find(row => row.name === 'member_right_id_seq')).toMatchObject({ last: String(data.id), called: true });
    expect(r.after.member_right).toHaveLength(36); expect(r.after.member_right!.find(row => row.id === data.id)).toMatchObject({ right_type: 'offline', image: '/api/assets/101', number: 80, content: null, status: 1 });
  });
  it.each([102,103,104,105,106,11,0])('refuses writer actor%s before any database/resource mutation', async actor => {
    const row = await right(); const r = await request('/adminapi/member_right/save/501', { author: 1, version: row.version, status: 0 }, actor); expect(r.status).not.toBe(200); expect(r.after).toEqual(r.before);
  });
  it('rechecks live role and password authority inside a retained writer service after admission', async () => {
    const row = await right(), actor = { id: 101, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    await f.db.update(systemRole).set({ rules: 'paid_membership.view' }).where(eq(systemRole.id, 1)); const before = await snapshot();
    await expect(new AdminMembershipRightAuthorService(wiring.container!, env).save(501, { author: 1, version: row.version, status: 0 }, actor)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it.each(['/api/assets/102','/api/assets/103','/api/assets/104','/api/assets/105','/api/assets/106','/api/assets/999'])('refuses foreign/malformed image and HTML capabilities %s without signing or writes', async reference => {
    const row = await right(); await unchanged('/adminapi/member_right/save/501', { author: 1, version: row.version, image: reference }, 101, 400);
    await unchanged('/adminapi/member/save/content/501', { author: 1, version: row.version, content: '<p><img src="' + reference + '?expires=9999999999&signature=copied"></p>' }, 101, 400);
  });
  it.each([{ show_title: '修改后展示名超过八字' }, { explain: '修改后简介超过八个字' }, { number: -1 }, { number: 0 }, { number: 1.5 }, { sort: '1' }, { image: '' }, { image: 'javascript:bad()' },
    { content: '<p>误走资料</p>' }, { status: 0, show_title: '混合保存' }, { unknown: true }, { image_preview: '/api/assets/101?signature=copied' }, { id: 501 }])('rejects unreviewed metadata edit%s', async extra => {
    const row = await right(); await unchanged('/adminapi/member_right/save/501', { author: 1, version: row.version, ...extra }, 101, 400);
  });
  it('rejects duplicate JSON, malformed versions, over-limit bytes and mixed content fields atomically', async () => {
    const row = await right(); const raw = '{"author":1,"version":"' + row.version + '","status":0,"status":1}';
    await unchanged('/adminapi/member_right/save/501', raw, 101, 400);
    await unchanged('/adminapi/member_right/save/501', '{"author":1,"author":0,"version":"' + row.version + '","status":0}', 101, 400);
    for (const version of ['', 'absent', 'A'.repeat(64)]) await unchanged('/adminapi/member_right/save/501', { author: 1, version, status: 0 }, 101, 400);
    await unchanged('/adminapi/member/save/content/501', { author: 1, version: row.version, content: 'x'.repeat(270000) }, 101, 400);
    await unchanged('/adminapi/member/save/content/501', { author: 1, version: row.version, content: '<p>介绍</p>', title: '不能覆盖' }, 101, 400);
    await unchanged('/adminapi/member/save/content/501', { author: 1, version: row.version, content: '' }, 101, 400);
    await unchanged('/adminapi/member_right/save/501?author=1', { author: 1, version: row.version, status: 0 }, 101, 400);
    await unchanged('/adminapi/member_right/save/0', { ...createBody(), extra: 1 }, 101, 400);
  });
  it('rejects stale versions across metadata, status and content without replaying or overwriting', async () => {
    const row = await right(); const first = await request('/adminapi/member_right/save/501', { author: 1, version: row.version, show_title: '并发标题' }); expect(first.status, first.msg).toBe(200);
    await unchanged('/adminapi/member_right/save/501', { author: 1, version: row.version, status: 0 }, 101, 409);
    await unchanged('/adminapi/member/save/content/501', { author: 1, version: row.version, content: '<p>过期介绍</p>' }, 101, 409);
    await unchanged('/adminapi/member_right/save/501', { author: 1, version: '0'.repeat(64), ...metadata(row) }, 101, 409);
  });
  it('keeps legacy no-author metadata/content behavior and raw DTO without the modern validation contract', async () => {
    const row = await right(); const legacy = { ...metadata(row), show_title: '旧API允许长于八字的展示名', number: 0, content: '<p>旧API原始HTML</p>' };
    const r = await request('/adminapi/member_right/save/501', legacy); expect(r.status, r.msg).toBe(200); expect(r.data).toEqual({ id: 501 });
    const cleared = await request('/adminapi/member/save/content/501', { content: '' }); expect(cleared.status, cleared.msg).toBe(200); onlyRight(cleared.before, cleared.after, 501, { content: '' });
    const list = (await unchanged('/adminapi/member/right')).data as { list: Row[] }; expect(Object.keys(list.list[0]!).sort()).toEqual(coreKeys);
  });
  it('publishes only enabled rows, preserves default keys/raw content and adds owner-bound styled previews only forrights1', async () => {
    const path = '/api/user/member/card/index', legacy = await unchanged(path, undefined, 11), details = await unchanged(path + '?rights=1', undefined, 11);
    const old = legacy.data as { member_rights: Array<Row> }, next = details.data as { rights_owner_uid: number; member_rights: Array<Row> };
    expect(Object.hasOwn(legacy.data as Row, 'rights_owner_uid')).toBe(false); expect(next.rights_owner_uid).toBe(11);
    expect(next.member_rights.some(row => row.id === 503)).toBe(false); expect(next.member_rights.slice(0, 2).map(row => row.id)).toEqual([502,501]);
    const oldGood = old.member_rights.find(row => row.id === 501)!, good = next.member_rights.find(row => row.id === 501)!, foreign = next.member_rights.find(row => row.id === 502)!;
    expect(Object.keys(oldGood).sort()).toEqual(['id','right_type','title','pic','explain','content','number'].sort()); expect(Object.keys(good).sort()).toEqual([...Object.keys(oldGood), 'content_preview'].sort());
    expect(good.content).toBe(oldGood.content); ticket(String(good.pic), '/api/assets/101'); expect(String(good.content_preview)).toContain('font-size:20px'); expect(String(good.content_preview)).toContain('signature=');
    expect(foreign.pic).toBe(''); expect(String(foreign.content_preview)).not.toMatch(/script|onclick|signature=/);
    await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'member_card_status'));
    expect((await unchanged(path + '?rights=1', undefined, 11)).data).toMatchObject({ rights_owner_uid: 11, member_rights: [] });
  });
  it.each(['rights=0','rights=1&rights=1','rights=1&uid=22'])('refuses malformed public detail query%s without writes', async query => {
    await unchanged('/api/user/member/card/index?' + query, undefined, 11, 400);
  });
  it('observes a real native row blocker before detecting the changed full version; fallback executes the same conflict business outcome', async () => {
    const row = await right(), actor = { id: 101, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    if (!process.env.TEST_FINANCE_POSTGRES_URL) {
      await f.db.update(memberRight).set({ content: '<p>并发已保存</p>' }).where(eq(memberRight.id, 501)); const before = await snapshot();
      await expect(new AdminMembershipRightAuthorService(wiring.container!, env).save(501, { author: 1, version: row.version, status: 0 }, actor)).rejects.toThrow('会员权益已变化'); expect(await snapshot()).toEqual(before);
      await unchanged('/adminapi/member_right/save/501', { author: 1, version: row.version, status: 0 }, 101, 409); return;
    }
    await withFinancePeers(f.db, async ([blocker, writer, observer]) => {
      let entered!: () => void, release!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const holder = blocker.db.transaction(async tx => { await tx.select().from(memberRight).where(eq(memberRight.id, 501)).for('update'); entered(); await gate; await tx.update(memberRight).set({ content: '<p>并发已保存</p>' }).where(eq(memberRight.id, 501)); });
      await ready; const saving = outcome(new AdminMembershipRightAuthorService(createContainerFromDb(writer.db), env).save(501, { author: 1, version: row.version, status: 0 }, actor));
      try { await waitForFinanceBlock(observer.db, writer.pid, blocker.pid); } finally { release(); }
      await holder; const before = await snapshot(), result = await saving; expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('会员权益已变化'); expect(await snapshot()).toEqual(before);
    });
    // The same full-version refusal must retain the PHP HTTP200 envelope at the registered route.
    await unchanged('/adminapi/member_right/save/501', { author: 1, version: row.version, status: 0 }, 101, 409);
  }, 20000);
});
