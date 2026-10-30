import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { systemAdmin, systemRole, systemAttachment, systemAttachmentCategory, systemConfig, cityArea } from '@/models/schema';
import { AdminStoreSupportService, checkedStoreRegionDirectory } from '@/services/admin/AdminStoreSupportService';
import { md5 } from '@/utils/jwt';
import { createAdminLevelFixture } from './helpers/adminLevelFixture';

const password = 'owned-store-support-password';
const actor = (id = 3) => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const key = 'owned-store-support-application-key';
const raster = (id: number, patch = {}) => ({ attId: id, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
  attDir: `/api/assets/${id}`, sattDir: `/api/assets/${id}`, name: `attachments/admin/1/2026/10/store-${id}.png`, attType: 'image/png', realName: `图片${id}`, ...patch });

describe('pickup-store support real restricted SQL, exact store.manage and no metadata/provider writes', () => {
  let f: Awaited<ReturnType<typeof createAdminLevelFixture>>, service: AdminStoreSupportService;
  beforeAll(async () => {
    f = await createAdminLevelFixture([cityArea]);
    // This new suite alone adds the existing production SELECT entitlement for
    // its optional city table. It does not broaden the mature Level helper.
    await f.exec(`GRANT SELECT ON public.city_area TO ${f.names.admin}`);
    service = new AdminStoreSupportService(f.container, { APP_KEY: key });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Store support must not call providers or R2'));
  }, 30000);
  afterAll(async () => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); }, 30000);
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemRole).values([{ id: 1, rules: 'store.view' }, { id: 2, rules: 'store.manage' }, { id: 3, rules: 'attachment.manage' }]);
    await f.db.insert(systemAdmin).values([
      { id: 1, account: 'root', pwd: password, level: 0 }, { id: 2, account: 'store_reader', pwd: password, level: 1, roles: '1' },
      { id: 3, account: 'store_writer', pwd: password, level: 1, roles: '2' }, { id: 4, account: 'attachment_writer', pwd: password, level: 1, roles: '3' },
      { id: 5, account: 'supplier', pwd: password, level: 0, adminType: 4 }, { id: 6, account: 'foreign_scope', pwd: password, level: 0, relationId: 7 },
    ]);
    await f.db.insert(systemAttachmentCategory).values([
      { id: 1, type: 1, relationId: 0, fileType: 1, name: '平台图片' },
      { id: 2, type: 4, relationId: 9, fileType: 1, name: '供应商私有' }, { id: 3, type: 1, relationId: 0, fileType: 2, name: '视频' },
    ]);
    await f.db.insert(systemAttachment).values([raster(1), raster(2), raster(3, { type: 3, relationId: 11, moduleType: 3, name: 'attachments/user/11/private.png' }),
      raster(4, { fileType: 2, name: 'attachments/admin/1/video.mp4', attType: 'video/mp4' }), raster(5, { attDir: '/api/assets/1' }),
      raster(6, { name: 'attachments/admin/2/foreign.png' }), raster(7, { pid: 1 }), raster(8, { attDir: 'http://legacy.example/public.png', imageType: 1, name: 'legacy/public.png' })]);
    await f.db.insert(cityArea).values([
      { id: 10, name: '甲省', level: 1, snum: 10 }, { id: 11, name: '乙市', parentId: 10, level: 2 },
      { id: 12, name: '丙区', parentId: 11, level: 3 }, { id: 13, name: '丁街道', parentId: 12, level: 4 },
      { id: 14, name: '戊区', parentId: 11, level: 3 }, { id: 20, name: '根叶地区', level: 1 },
    ]);
  });
  const options = (query = '', id = 3) => f.asAdmin(() => service.options(new URLSearchParams(query), actor(id)));
  const regions = (query = '', id = 3) => f.asAdmin(() => service.regions(new URLSearchParams(query), actor(id)));
  const map = (query = '', id = 3) => f.asAdmin(() => service.mapConfig(new URLSearchParams(query), actor(id)));
  const categories = (query = '', id = 3) => f.asAdmin(() => service.categories(new URLSearchParams(query), actor(id)));
  async function snapshot() {
    const tables = ['system_admin', 'system_role', 'system_attachment', 'system_attachment_category', 'system_config', 'city_area'];
    return { tables: await Promise.all(tables.map(async table => ({ table, rows: Array.from(await f.db.execute(sql.raw(`SELECT * FROM public.${table} ORDER BY 1`))) }))),
      sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)) };
  }
  it('pages only after checking the complete eligible category, exposing stable refs and preview tickets separately', async () => {
    const before = await snapshot(), first = await options('page=1&limit=2'), second = await options('page=2&limit=2');
    expect(first.count).toBe(3); expect(first.list.map(row => row.att_id)).toEqual([8, 2]); expect(second.list.map(row => row.att_id)).toEqual([1]);
    expect(first.list[0]).toEqual({ att_id: 8, pid: 0, real_name: '图片8', reference: 'https://legacy.example/public.png', preview: 'https://legacy.example/public.png' });
    expect(first.list[1]!.reference).toBe('/api/assets/2'); expect(first.list[1]!.preview).toMatch(/^\/api\/assets\/2\?expires=\d+&signature=/u);
    expect(JSON.stringify(first)).not.toContain('attachments/'); expect(await snapshot()).toEqual(before);
  });
  it('lists only platform image categories and checks the requested category realm before reading options', async () => {
    expect(await categories()).toEqual({ list: [{ id: 1, pid: 0, name: '平台图片' }] });
    expect((await options('pid=1')).list.map(row => row.att_id)).toEqual([7]);
    for (const pid of [2, 3, 999]) await expect(options(`pid=${pid}`)).rejects.toThrow(/分类不存在/);
    expect((await options('name=图片2')).list.map(row => row.att_id)).toEqual([2]);
  });
  it.each([0, 2, 4, 5, 6])('refuses all four support reads for guest/view-only/attachment-only/foreign actor%d', async id => {
    const before = await snapshot();
    for (const read of [options, categories, regions, map]) await expect(read('', id)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('validates live role/password/session deadline and missing role references independently of initial admission', async () => {
    await f.db.update(systemRole).set({ rules: 'store.view' }).where(eq(systemRole.id, 2)); await expect(regions()).rejects.toThrow();
    await f.db.update(systemRole).set({ rules: 'store.manage' }).where(eq(systemRole.id, 2));
    await expect(f.asAdmin(() => service.mapConfig(new URLSearchParams(), { ...actor(), authVersion: 'a'.repeat(32) }))).rejects.toThrow();
    await expect(f.asAdmin(() => service.categories(new URLSearchParams(), { ...actor(), expiresAt: 1 }))).rejects.toThrow();
    await f.db.update(systemAdmin).set({ roles: '999' }).where(eq(systemAdmin.id, 3)); await expect(options()).rejects.toThrow();
    expect((await options('', 1)).count).toBe(3);
  });
  it.each(['page=0', 'page=1&page=2', 'limit=101', 'limit=1e1', 'pid=-1', 'pid=01', 'scope=user', 'file_type=2', 'name=%00', 'unknown=1'])('refuses malformed/foreign-scope option query%s without writes', async query => {
    const before = await snapshot(); await expect(options(query)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it('rejects all unexpected parameters on category/region/map reads, including attempted key or provider URL injection', async () => {
    const before = await snapshot();
    for (const read of [categories, regions, map]) {
      for (const query of ['pid=0', 'key=attacker', 'url=https://evil.example', 'scope=admin&scope=user']) await expect(read(query)).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });
  it('returns a complete stable flat province/city/area catalogue, retaining legal shallow leaves and excluding street data', async () => {
    const before = await snapshot(), result = await regions();
    expect(result).toEqual({ list: [
      { id: 20, pid: 0, level: 1, name: '根叶地区' }, { id: 10, pid: 0, level: 1, name: '甲省' },
      { id: 11, pid: 10, level: 2, name: '乙市' }, { id: 12, pid: 11, level: 3, name: '丙区' }, { id: 14, pid: 11, level: 3, name: '戊区' },
    ], count: 5 });
    expect(JSON.stringify(result)).not.toContain('丁街道'); expect(await snapshot()).toEqual(before);
  });
  it.each([
    ['orphan', { id: 12, parentId: 999 }], ['wrong parent level', { id: 12, parentId: 10 }],
    ['root cycle', { id: 10, parentId: 12 }], ['empty name', { id: 12, name: '' }], ['trimmed history', { id: 12, name: ' 丙区' }],
  ] as const)('refuses %s region history rather than silently trimming, filtering or repairing it', async (_name, patch) => {
    await f.db.update(cityArea).set(patch).where(eq(cityArea.id, patch.id));
    const before = await snapshot(); await expect(regions()).rejects.toThrow(/目录|父级|层级/); expect(await snapshot()).toEqual(before);
  });
  it('refuses ambiguous same-parent names, while equal names under distinct parents remain independently selectable', async () => {
    await f.db.insert(cityArea).values({ id: 21, parentId: 20, level: 2, name: '乙市' }); expect((await regions()).count).toBe(6);
    await f.db.insert(cityArea).values({ id: 15, parentId: 11, level: 3, name: '丙区' }); await expect(regions()).rejects.toThrow(/歧义/);
  });
  it('returns a missing map key explicitly unavailable and never falls back to unrelated or store-local keys', async () => {
    await f.db.insert(systemConfig).values([{ menuName: 'unrelated_secret', value: 'must-not-leak' }, { isStore: 1, menuName: 'tengxun_map_key', value: 'wrong-scope-key' }]);
    const before = await snapshot(); expect(await map()).toEqual({ available: false, url: '', origin: 'https://apis.map.qq.com' });
    expect(await snapshot()).toEqual(before);
  });
  it('reads only the deterministic platform key winner, decodes the existing JSON scalar and constructs the fixed iframe URL', async () => {
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'tengxun_map_key', value: 'older-key', sort: 10 }, { id: 2, menuName: 'tengxun_map_key', value: '"controlled-public-browser-key"', sort: 10 },
      { id: 3, menuName: 'tengxun_map_key', value: 'lower-priority-key', sort: 1 }, { id: 4, isStore: 1, menuName: 'tengxun_map_key', value: 'foreign-key', sort: 999 },
      { id: 5, menuName: 'worker_provider_secret', value: 'must-not-leak', sort: 999 },
    ]);
    const before = await snapshot(), result = await map(), url = new URL(result.url);
    expect(result.available).toBe(true); expect(Object.keys(result)).toEqual(['available', 'url', 'origin']);
    expect(url.origin).toBe(result.origin); expect(url.pathname).toBe('/tools/locpicker');
    expect([...url.searchParams]).toEqual([['type', '1'], ['key', 'controlled-public-browser-key'], ['referer', 'myapp']]);
    expect(JSON.stringify(result)).not.toContain('must-not-leak'); expect(await snapshot()).toEqual(before);
  });
  it.each(['', '0', 'has space', 'key&backurl=https://evil.example', '<script>', 'x'.repeat(256), '{"secret":"value"}'])('marks malformed configured key%j unavailable instead of passing it to an arbitrary URL', async value => {
    await f.db.insert(systemConfig).values({ menuName: 'tengxun_map_key', value });
    expect(await map()).toEqual({ available: false, url: '', origin: 'https://apis.map.qq.com' });
  });
  it('rejects an over5000 actual image source before search/paging and preserves all source/sequence bytes', async () => {
    for (let start = 100; start < 5101; start += 250) {
      await f.db.insert(systemAttachment).values(Array.from({ length: Math.min(250, 5101 - start) }, (_unused, offset) => raster(start + offset, { attDir: `/static/${start + offset}.png`, imageType: 1 })));
    }
    const before = await snapshot(); await expect(options('limit=1&name=no-match')).rejects.toThrow(/5000/); expect(await snapshot()).toEqual(before);
  });
  it('does not acquire attachment management or region/config mutation rights while reading support data', async () => {
    await options(); await regions(); await map();
    await expect(f.asAdmin(() => f.exec('UPDATE public.city_area SET name=\'unauthorized\' WHERE id=10'))).rejects.toMatchObject({ code: '42501' });
    await expect(f.asAdmin(() => f.exec('UPDATE public.system_attachment SET real_name=\'unauthorized\' WHERE att_id=1'))).rejects.toMatchObject({ code: '42501' });
    await expect(f.asAdmin(() => f.exec('UPDATE public.system_config SET value=\'unauthorized\''))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('complete region protocol validation without mutation or forced third-level leaves', () => {
  it('retains exact full paths, shallow leaves and input order without changing raw names', () => {
    const rows = [{ id: 1, pid: 0, level: 1, name: '香港' }, { id: 2, pid: 0, level: 1, name: '甲省' },
      { id: 3, pid: 2, level: 2, name: '乙市' }, { id: 4, pid: 3, level: 3, name: '丙区' }], before = structuredClone(rows);
    expect(checkedStoreRegionDirectory(rows)).toEqual(rows); expect(rows).toEqual(before);
  });
  it.each([
    [{ id: 1, pid: 0, level: 1, name: 'A' }, { id: 1, pid: 0, level: 1, name: 'B' }],
    [{ id: 0, pid: 0, level: 1, name: 'A' }], [{ id: 1, pid: 0, level: 4, name: 'street' }],
    [{ id: 1, pid: 1, level: 1, name: 'cycle' }], [{ id: 1, pid: 0, level: 3, name: 'orphan' }],
    [{ id: 1, pid: 0, level: 1, name: 'control\u0000' }],
  ].map(rows => ({ rows })))('rejects invalid complete region input%j without rewriting it', ({ rows }) => {
    const before = structuredClone(rows); expect(() => checkedStoreRegionDirectory(rows)).toThrow(); expect(rows).toEqual(before);
  });
  it('accepts the full10000-row local capacity and explicitly rejects10001 without truncating or mutating the tail', () => {
    const rows = Array.from({ length: 10000 }, (_unused, index) => ({ id: index + 1, pid: 0, level: 1, name: `地区${index + 1}` }));
    expect(checkedStoreRegionDirectory(rows)).toHaveLength(10000);
    const over = [...rows, { id: 10001, pid: 0, level: 1, name: '最后地区' }], before = structuredClone(over);
    expect(() => checkedStoreRegionDirectory(over)).toThrow(/10000/); expect(over).toEqual(before);
  });
});
