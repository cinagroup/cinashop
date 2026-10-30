import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemRole, systemAttachment, systemAttachmentCategory } from '@/models/schema';
import { AdminLevelAttachmentService } from '@/services/admin/AdminLevelAttachmentService';
import { adminapiRoutes } from '@/routes/adminapi';
import { v1Routes } from '@/routes/v1';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { errorHandler } from '@/middleware/error';
import { createToken, md5 } from '@/utils/jwt';
import { createAdminLevelFixture } from './helpers/adminLevelFixture';

const ports = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createAdminDatabaseSession: ports.open }));
const env = { APP_KEY: 'owned-level-attachment-hono-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'owned-level-attachment-password';
const actor = (id = 1) => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const raster = (id: number, patch = {}) => ({ attId: id, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
  attDir: `/api/assets/${id}`, sattDir: `/api/assets/${id}`, name: `attachments/admin/1/2026/10/catalog-${id}.png`, attType: 'image/png', realName: `图标${id}`, ...patch });

describe('level-only existing image directory real restricted SQL/JWT/Hono, no attachment write authority', () => {
  let f: Awaited<ReturnType<typeof createAdminLevelFixture>>, service: AdminLevelAttachmentService;
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.onError(errorHandler); app.use('*', async (c, next) => { c.set('container', f.container); await next(); });
  app.route('/adminapi', adminapiRoutes); app.route('/api', v1Routes);
  beforeAll(async () => {
    f = await createAdminLevelFixture(); service = new AdminLevelAttachmentService(f.container, env.APP_KEY);
    ports.open.mockImplementation(() => ({ container: createContainerFromDb(f.db), close: ports.close }));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No attachment provider/R2 network I/O'));
  }, 30000);
  afterAll(async () => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); }, 30000);
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemRole).values([{ id: 1, rules: 'level.view' }, { id: 2, rules: 'level.manage' }, { id: 3, rules: 'attachment.view' }]);
    await f.db.insert(systemAdmin).values([
      { id: 1, account: 'root', pwd: password, level: 0 }, { id: 2, account: 'read', pwd: password, level: 1, roles: '1' },
      { id: 3, account: 'writer', pwd: password, level: 1, roles: '2' }, { id: 4, account: 'attachment_reader', pwd: password, level: 1, roles: '3' },
      { id: 5, account: 'supplier', pwd: password, level: 0, adminType: 4 }, { id: 6, account: 'scoped', pwd: password, level: 0, relationId: 7 },
    ]);
    await f.db.insert(systemAttachmentCategory).values([
      { id: 1, type: 1, relationId: 0, fileType: 1, pid: 0, name: '平台图' },
      { id: 2, type: 4, relationId: 9, fileType: 1, pid: 0, name: '供应商私有' },
      { id: 3, type: 1, relationId: 0, fileType: 2, pid: 0, name: '视频' },
    ]);
    await f.db.insert(systemAttachment).values([
      raster(1), raster(2), raster(3, { type: 3, relationId: 11, moduleType: 3, name: 'attachments/user/11/private.png' }),
      raster(4, { fileType: 2, name: 'attachments/admin/1/video.mp4', attType: 'video/mp4' }),
      raster(5, { attDir: '/api/assets/1' }), raster(6, { name: 'attachments/admin/2/foreign.png' }),
      raster(7, { pid: 1 }), raster(8, { attDir: 'http://legacy.example/public.png', imageType: 1, name: 'legacy/public.png' }),
    ]);
  });
  async function request(path: string, id = 3, method = 'GET', body?: unknown) {
    const token = id ? (await createToken(id, 'admin', md5(password), env.APP_KEY)).token : '';
    return f.asAdmin(async () => {
      const response = await app.request(path, { method, headers: { ...(token ? { 'Authori-zation': `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
      const text = await response.text();
      let responseBody: { status: number; data: any; msg: string };
      try { responseBody = JSON.parse(text); } catch { responseBody = { status: response.status, data: null, msg: text }; }
      return { status: response.status, headers: response.headers, body: responseBody };
    });
  }
  const options = (query = '', id = 3) => f.asAdmin(() => service.options(new URLSearchParams(query), actor(id)));
  async function snapshot() { return {
    attachments: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId),
    categories: await f.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id),
    authority: await f.db.select().from(systemAdmin).orderBy(systemAdmin.id),
    receipts: Array.from(await f.db.execute(sql`SELECT * FROM public.admin_level_operation ORDER BY operation_id`)),
    sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)),
  }; }
  it('validates eligible rows before paging/count; never signs another id from a disguised attachment row', async () => {
    const before = await snapshot(), first = await options('page=1&limit=2'), second = await options('page=2&limit=2');
    expect(first.count).toBe(3); expect(first.list.map(row => row.att_id)).toEqual([8, 2]); expect(second.list.map(row => row.att_id)).toEqual([1]);
    expect(first.list[0]).toEqual({ att_id: 8, pid: 0, real_name: '图标8', reference: 'https://legacy.example/public.png', preview: 'https://legacy.example/public.png' });
    expect(first.list[1]!.reference).toBe('/api/assets/2'); expect(first.list[1]!.preview).toMatch(/^\/api\/assets\/2\?expires=\d+&signature=/u);
    expect(await snapshot()).toEqual(before);
  });
  it('returns all and only platform image categories; selected category filters actual source rows', async () => {
    expect(await f.asAdmin(() => service.categories(new URLSearchParams(), actor(3)))).toEqual({ list: [{ id: 1, pid: 0, name: '平台图' }] });
    expect((await options('pid=1')).list.map(row => row.att_id)).toEqual([7]);
    for (const pid of [2, 3, 999]) await expect(options(`pid=${pid}`)).rejects.toThrow(/分类不存在/);
    expect((await options('name=图标2')).list.map(row => row.att_id)).toEqual([2]);
  });
  it.each(['/adminapi/level/attachment-options', '/api/admin/level/attachment-options'])('real registered %s admits level.manage without attachment.view', async path => {
    const response = await request(path); expect(response.body.status).toBe(200); expect(response.body.data.list.map((row: { att_id: number }) => row.att_id)).toEqual([8, 2, 1]);
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(JSON.stringify(response.body)).not.toContain('attachments/admin/');
  });
  it.each(['/adminapi/level/attachment-categories', '/api/admin/level/attachment-categories'])('real registered %s is level-manage only, private and read-only', async path => {
    const response = await request(path); expect(response.body.status).toBe(200); expect(response.body.data).toEqual({ list: [{ id: 1, pid: 0, name: '平台图' }] }); expect(response.headers.get('pragma')).toBe('no-cache');
  });
  it.each([0, 2, 4, 5, 6])('guest/view-only/attachment-only/foreign actor%d cannot read this selection directory', async id => {
    const before = await snapshot(); const response = await request('/adminapi/level/attachment-options', id); expect(response.body.status).not.toBe(200); expect(await snapshot()).toEqual(before);
    if (id) await expect(options('', id)).rejects.toThrow();
  });
  it('rechecks current roles, credentials and deadline instead of trusting initial admission', async () => {
    await f.db.update(systemRole).set({ rules: 'level.view' }).where(eq(systemRole.id, 2));
    await expect(options()).rejects.toThrow();
    await f.db.update(systemRole).set({ rules: 'level.manage' }).where(eq(systemRole.id, 2));
    await expect(f.asAdmin(() => service.options(new URLSearchParams(), { ...actor(3), authVersion: 'a'.repeat(32) }))).rejects.toThrow();
    await expect(f.asAdmin(() => service.options(new URLSearchParams(), { ...actor(3), expiresAt: 1 }))).rejects.toThrow();
    expect((await options()).count).toBe(3);
  });
  it('unknown/missing numeric role IDs fail closed rather than resurrecting a directory grant', async () => {
    await f.db.update(systemAdmin).set({ roles: '999' }).where(eq(systemAdmin.id, 3));
    await expect(options()).rejects.toThrow();
  });
  it.each(['page=0', 'page=1&page=2', 'limit=101', 'limit=1e1', 'pid=-1', 'pid=01', 'file_type=2', 'name=%00', 'unknown=1'])('rejects malformed query%s without any writes', async query => {
    const before = await snapshot(); await expect(options(query)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it('explicitly refuses an over5000 source rather than authorizing a truncated page', async () => {
    for (let start = 100; start < 5101; start += 250) await f.db.insert(systemAttachment).values(
      Array.from({ length: Math.min(250, 5101 - start) }, (_unused, offset) => raster(start + offset, { attDir: `/static/${start + offset}.png`, imageType: 1 })));
    const before = await snapshot(); await expect(options()).rejects.toThrow(/5000/); expect(await snapshot()).toEqual(before);
  });
  it('does not offer any upload/move/delete endpoint or gain attachment mutation permission', async () => {
    expect(requiredAdminPermission('GET', 'level/attachment-options')).toBe('level.manage');
    expect(requiredAdminPermission('GET', 'level/attachment-categories')).toBe('level.manage');
    expect((await request('/adminapi/file/file/delete', 3, 'POST', { ids: [1] })).body.status).not.toBe(200);
    expect((await request('/adminapi/level/attachment-options', 3, 'POST', {})).body.status).not.toBe(200);
    expect(await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, 1))).toHaveLength(1);
  });
});
