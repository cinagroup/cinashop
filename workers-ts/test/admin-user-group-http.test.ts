import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { systemLog, user, userGroup } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { userGroupFixture } from './helpers/adminUserGroups';

const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({
  ...await original<typeof import('@/lib/di')>(),
  createContainer: wiring.application,
  createAdminDatabaseSession: wiring.open,
}));
const env = { APP_KEY: 'user-group-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
type Envelope = { status: number; msg: string; data: unknown };

describe('registered PHP and modern user-group routes with actual JWT and SQL', () => {
  let f: Awaited<ReturnType<typeof userGroupFixture>>;
  const app = createApp(), tokens: Record<number, string> = {};
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('User-group HTTP fixture forbids external I/O'));
    f = await userGroupFixture();
    wiring.application.mockImplementation(() => f.container);
    wiring.open.mockImplementation(() => ({ container: f.container, close: wiring.close }));
    for (const id of [100, 101, 102, 103, 104, 105, 106, 107, 108]) {
      tokens[id] = (await createToken(id, 'admin', md5('group-fixture-password'), env.APP_KEY)).token;
    }
  }, 30000);
  afterAll(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  const counters = () => ({ application: wiring.application.mock.calls.length,
    open: wiring.open.mock.calls.length, close: wiring.close.mock.calls.length });
  function boundary(response: Response, before: ReturnType<typeof counters>) {
    const cache = new Set(response.headers.get('cache-control')?.split(',').map(value => value.trim()));
    expect(cache.has('private')).toBe(true);
    expect(cache.has('no-store')).toBe(true);
    if (response.headers.has('pragma')) expect(response.headers.get('pragma')).toBe('no-cache');
    else expect(cache.has('max-age=0')).toBe(true); // middleware refusals before the controller
    expect(wiring.application.mock.calls.length - before.application).toBe(1);
    const opened = wiring.open.mock.calls.length - before.open;
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(opened).toBeLessThanOrEqual(1);
    expect(wiring.close.mock.calls.length - before.close).toBe(opened);
  }
  async function raw(method: string, path: string, body?: BodyInit, id = 101,
    extraHeaders: Record<string, string> = {}) {
    const before = counters();
    const response = await app.request(path.startsWith('/') ? path : `/adminapi/${path}`, { method,
      headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}),
        'Content-Type': 'application/json', ...extraHeaders }, body }, env);
    boundary(response, before);
    return response;
  }
  async function request(method: string, path: string, body?: unknown, id = 101) {
    const response = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), id);
    return { response, body: await response.json<Envelope>() };
  }
  async function snapshot() {
    return { groups: await f.db.select().from(userGroup).orderBy(userGroup.id),
      users: await f.db.select().from(user).orderBy(user.uid),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('projects legacy list and add/edit forms while retaining modern pagination and search', async () => {
    expect((await request('GET', 'user/user_group/list?page=1&limit=2')).body).toEqual({
      status: 200, msg: 'ok', data: { list: [{ id: 30, group_name: '历史分组' },
        { id: 20, group_name: '会员' }], count: 3 } });
    expect((await request('GET', 'user/user_group/add/0')).body.data).toMatchObject({
      title: '添加分组', action: 'user/user_group/save', method: 'POST',
      rules: [{ field: 'group_name', value: '', props: { maxlength: 20 } }] });
    expect((await request('GET', 'user/user_group/add/20?id=20')).body.data).toMatchObject({
      title: '修改分组', rules: [{ field: 'id', value: 20 }, { field: 'group_name', value: '会员' }] });
    expect((await request('GET', 'user_group/list?page=1&limit=2&group_name=会员')).body.data).toEqual({
      list: [{ id: 20, group_name: '会员' }], count: 1, page: 1, limit: 2 });
  });

  it('completes the four legacy and three modern contracts with distinct write response DTOs', async () => {
    const before = await snapshot();
    expect((await request('POST', 'user/user_group/save', { group_name: 'HTTP旧分组' })).body)
      .toEqual({ status: 200, msg: '提交成功！', data: [] });
    const [legacy] = await f.db.select().from(userGroup).where(eq(userGroup.groupName, 'HTTP旧分组'));
    expect(legacy.id).toBeGreaterThan(0);
    expect((await request('POST', 'user/user_group/save', { id: legacy.id, group_name: 'HTTP旧编辑' })).body)
      .toEqual({ status: 200, msg: '提交成功！', data: [] });
    expect((await request('DELETE', `user/user_group/del/${legacy.id}`)).body)
      .toEqual({ status: 200, msg: '删除成功!', data: [] });
    expect((await request('DELETE', `user/user_group/del/${legacy.id}`)).body)
      .toEqual({ status: 200, msg: '删除成功!', data: [] });

    const created = await request('POST', 'user_group/save', { id: 0, group_name: '中'.repeat(64) });
    expect(created.body).toMatchObject({ status: 200, msg: '提交成功', data: { id: expect.any(Number) } });
    const modernId = (created.body.data as { id: number }).id;
    expect((await request('POST', 'user_group/save', { id: modernId, group_name: 'HTTP现代编辑' })).body)
      .toEqual({ status: 200, msg: '提交成功', data: { id: modernId } });
    expect((await request('DELETE', `user_group/del/${modernId}`)).body)
      .toEqual({ status: 200, msg: '删除成功', data: null });
    const after = await snapshot();
    expect(after.groups).toEqual(before.groups);
    expect(after.users).toEqual(before.users);
    expect(after.logs.slice(before.logs.length).map(row => row.method))
      .toEqual(['POST', 'POST', 'DELETE', 'POST', 'POST', 'DELETE']);
  });

  it('admits numeric menu readers and writers and rejects anonymous, read-only and unrelated accounts', async () => {
    const before = await snapshot();
    for (const id of [102, 105, 106, 107, 108]) {
      expect((await request('GET', 'user/user_group/list', undefined, id)).body.status).toBe(200);
      expect((await request('GET', 'user/user_group/add/20', undefined, id)).body.status).toBe(200);
      for (const path of ['user/user_group/save', 'user_group/save']) {
        expect((await request('POST', path, { group_name: '只读拒绝' }, id)).body)
          .toMatchObject({ status: 400011, data: null });
      }
      for (const path of ['user/user_group/del/20', 'user_group/del/20']) {
        expect((await request('DELETE', path, undefined, id)).body)
          .toMatchObject({ status: 400011, data: null });
      }
    }
    expect((await request('GET', 'user/user_group/list', undefined, 103)).body)
      .toMatchObject({ status: 400011, data: null });
    expect((await request('GET', 'user_group/list', undefined, 103)).body)
      .toMatchObject({ status: 400011, data: null });
    const openBefore = wiring.open.mock.calls.length;
    for (const [method, path] of [['GET', 'user/user_group/list'], ['GET', 'user/user_group/add/0'],
      ['POST', 'user/user_group/save'], ['DELETE', 'user/user_group/del/20'],
      ['GET', 'user_group/list'], ['POST', 'user_group/save'], ['DELETE', 'user_group/del/20']]) {
      expect((await request(method, path, method === 'POST' ? { group_name: '匿名拒绝' } : undefined, 0)).body)
        .toMatchObject({ status: 410000, data: null });
    }
    expect(wiring.open.mock.calls.length).toBe(openBefore);
    expect(await snapshot()).toEqual(before);

    expect((await request('POST', 'user/user_group/save', { group_name: '数字菜单创建' }, 104)).body.status).toBe(200);
    const [created] = await f.db.select().from(userGroup).where(eq(userGroup.groupName, '数字菜单创建'));
    expect((await request('DELETE', `user_group/del/${created.id}`, undefined, 104)).body.status).toBe(200);
    expect((await snapshot()).groups).toEqual(before.groups);
  });
  it('keeps /api/admin group aliases on the same audited authority and modern DTO contracts', async () => {
    expect((await request('GET', '/api/admin/user_group/list?group_name=会员')).body.data)
      .toEqual({ list: [{ id: 20, group_name: '会员' }], count: 1, page: 1, limit: 20 });
    const before = await snapshot();
    const created = await request('POST', '/api/admin/user_group/save', { id: 0, group_name: '移动别名分组' });
    expect(created.body.status).toBe(200);
    const id = (created.body.data as { id: number }).id;
    expect((await request('DELETE', `/api/admin/user_group/del/${id}`)).body).toEqual({ status: 200, msg: '删除成功', data: null });
    expect((await snapshot()).groups).toEqual(before.groups);
    expect((await snapshot()).logs.slice(before.logs.length).map(row => row.type)).toEqual(['user_group_catalog', 'user_group_catalog']);
    for (const actor of [102, 106, 107]) expect((await request('POST', '/api/admin/user_group/save', { group_name: '只读别名拒绝' }, actor)).body.status).toBe(400011);
  });

  it('rejects malformed UTF8/JSON, oversized streams, repeated queries and invalid IDs without effects', async () => {
    const before = await snapshot();
    for (const [method, path, body] of [
      ['POST', 'user/user_group/save', { group_name: '中'.repeat(21) }],
      ['POST', 'user/user_group/save', { id: true, group_name: '畸形ID' }],
      ['POST', 'user_group/save', { id: '01', group_name: '畸形ID' }],
      ['POST', 'user_group/save', { group_name: '未知归属', relation_id: 77 }],
      ['POST', 'user_group/save', { group_name: '控制\u0000字符' }],
      ['POST', 'user/user_group/save?id=20', { group_name: '查询伪造' }],
      ['POST', 'user_group/save', null], ['POST', 'user_group/save', []],
      ['GET', 'user/user_group/list?page=1&page=2', undefined],
      ['GET', 'user/user_group/list?limit=101', undefined],
      ['GET', 'user/user_group/list?group_name=会员', undefined],
      ['GET', 'user/user_group/add/20?id=10', undefined],
      ['GET', 'user/user_group/add/999', undefined],
      ['DELETE', 'user/user_group/del/20?id=10', undefined],
      ['DELETE', 'user_group/del/01', undefined],
      ['DELETE', 'user_group/del/2147483648', undefined],
      ['DELETE', 'user/user_group/del/10', undefined],
      ['DELETE', 'user/user_group/del/30', undefined],
    ] as const) expect((await request(method, path, body)).body.status).not.toBe(200);
    for (const bytes of ['{', '', new Uint8Array([0xff])]) {
      expect(await (await raw('POST', 'user/user_group/save', bytes)).json()).toMatchObject({ status: 400 });
    }
    expect(await (await raw('POST', 'user_group/save', '{}', 101, { 'Content-Length': '8193' })).json())
      .toMatchObject({ status: 400 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(8193)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const beforeStream = counters();
    const response = await app.request(new Request('http://localhost/adminapi/user_group/save', {
      method: 'POST', headers: { 'Authori-zation': `Bearer ${tokens[101]}`, 'Content-Type': 'application/json' },
      body: stream, duplex: 'half',
    } as RequestInit), undefined, env);
    boundary(response, beforeStream);
    expect(await response.json()).toMatchObject({ status: 400 });
    expect(cancelled).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('handles HEAD through the read contracts without a response body or mutation', async () => {
    const before = await snapshot();
    for (const path of ['user/user_group/list', 'user/user_group/add/0', 'user/user_group/add/20', 'user_group/list']) {
      const response = await raw('HEAD', path, undefined, 105);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    }
    expect(await snapshot()).toEqual(before);
  });
});
