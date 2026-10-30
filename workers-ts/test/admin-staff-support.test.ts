import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { systemAdmin, systemRole, systemAttachment, systemAttachmentCategory, user } from '@/models/schema';
import { AdminStaffSupportService, staffUserSelection, type StaffUserSelectionRow } from '@/services/admin/AdminStaffSupportService';
import { md5 } from '@/utils/jwt';
import { createAdminLevelFixture } from './helpers/adminLevelFixture';

const password = 'owned-staff-support-password', key = 'owned-staff-support-key';
const actor = (id = 3) => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const raster = (id: number, patch = {}) => ({ attId: id, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
 attDir: `/api/assets/${id}`, sattDir: `/api/assets/${id}`, name: `attachments/admin/1/2026/10/staff-${id}.png`, attType: 'image/png', realName: `头像${id}`, ...patch });

describe('staff support real restricted SQL: minimal live users and independent platform avatar catalogue', () => {
 let f: Awaited<ReturnType<typeof createAdminLevelFixture>>, service: AdminStaffSupportService;
 beforeAll(async () => { f = await createAdminLevelFixture(); service = new AdminStaffSupportService(f.container, { APP_KEY: key });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Staff support must not call providers or R2')); }, 30000);
 afterAll(async () => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); }, 30000);
 beforeEach(async () => {
  await f.reset(); await f.db.insert(systemRole).values([{ id: 1, rules: 'store.view' }, { id: 2, rules: 'store.manage' }, { id: 3, rules: 'attachment.manage' }, { id: 4, rules: 'user.view' }]);
  await f.db.insert(systemAdmin).values([{ id: 1, account: 'root', pwd: password, level: 0 }, { id: 2, account: 'store_reader', pwd: password, level: 1, roles: '1' },
   { id: 3, account: 'store_writer', pwd: password, level: 1, roles: '2' }, { id: 4, account: 'attachment_writer', pwd: password, level: 1, roles: '3' },
   { id: 5, account: 'user_reader', pwd: password, level: 1, roles: '4' }, { id: 6, account: 'supplier', pwd: password, level: 0, adminType: 4 }, { id: 7, account: 'foreign', pwd: password, level: 0, relationId: 7 }]);
  await f.db.insert(systemAttachmentCategory).values([{ id: 1, type: 1, relationId: 0, fileType: 1, name: '平台头像' },
   { id: 2, type: 3, relationId: 11, fileType: 1, name: '用户私有' }, { id: 3, type: 4, relationId: 9, fileType: 1, name: '供应商私有' }, { id: 4, type: 1, relationId: 0, fileType: 2, name: '视频' }]);
  await f.db.insert(systemAttachment).values([raster(1), raster(2, { pid: 1 }), raster(3, { type: 3, relationId: 11, moduleType: 3, name: 'attachments/user/11/2026/10/current.png' }),
   raster(4, { type: 3, relationId: 99, moduleType: 3, name: 'attachments/user/99/foreign.png' }), raster(5, { attDir: '/api/assets/1' }),
   raster(6, { attDir: 'http://legacy.example/avatar.png', imageType: 1, name: 'old/avatar.png' }), raster(7, { name: 'attachments/admin/2/foreign.png' })]);
  await f.db.insert(user).values([{ uid: 11, nickname: 'Alpha', avatar: '/api/assets/3' }, { uid: 12, nickname: 'Beta', avatar: '/api/assets/1' },
   { uid: 13, nickname: 'Disabled', avatar: '/api/assets/1', status: 0 }, { uid: 14, nickname: 'Deleted', avatar: '/api/assets/1', isDel: 1 },
   { uid: 15, nickname: 'Delete timestamp', avatar: '/api/assets/1', deleteTime: new Date('2026-10-26T00:00:00.000Z') },
   { uid: 16, nickname: 'A_% literal', avatar: 'http://legacy.example/a.png' }, { uid: 17, nickname: 'Unsafe history', avatar: 'javascript:old' },
   { uid: 18, nickname: 'Public name', account: 'SECRET-ACCOUNT', phone: '13899999999', pwd: 'private-password-hash', realName: 'private-real-name', avatar: '/api/assets/4' }]);
 });
 const users = (query = '', id = 3) => f.asAdmin(() => service.users(new URLSearchParams(query), actor(id)));
 const categories = (query = '', id = 3) => f.asAdmin(() => service.categories(new URLSearchParams(query), actor(id)));
 const options = (query = '', id = 3) => f.asAdmin(() => service.options(new URLSearchParams(query), actor(id)));
 async function snapshot() {
  const names = ['system_admin', 'system_role', 'system_attachment', 'system_attachment_category', 'user'];
  return { rows: await Promise.all(names.map(async table => ({ table, rows: Array.from(await f.db.execute(sql.raw(`SELECT * FROM public."${table}" ORDER BY 1`))) }))),
   sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)) };
 }
 it('reads enabled/not-deleted/live-date users in uidDESC, with exact count/page and only the five public picker fields', async () => {
  const frozen = await snapshot(), first = await users('limit=2'), second = await users('page=2&limit=2'), tail = await users('page=3&limit=2');
  expect(first).toMatchObject({ count: 5, page: 1, limit: 2 }); expect(first.list.map(row => row.uid)).toEqual([18, 17]); expect(second.list.map(row => row.uid)).toEqual([16, 12]); expect(tail.list.map(row => row.uid)).toEqual([11]);
  for (const row of [...first.list, ...second.list, ...tail.list]) { expect(Object.keys(row)).toEqual(['uid', 'nickname', 'avatar', 'preview', 'selection']); expect(row.selection).toMatch(/^[a-f0-9]{64}$/u); }
  expect(JSON.stringify(first)).not.toMatch(/private-password-hash|private-real-name|SECRET-ACCOUNT|13899999999|attachments\/|rowVersion|deleteTime/);
  expect(first.list.map(row => row.preview)).toEqual(['', '']); expect(second.list[0]!.preview).toBe('https://legacy.example/a.png'); expect(tail.list[0]!.preview).toMatch(/^\/api\/assets\/3\?expires=\d+&signature=/u);
  expect(await snapshot()).toEqual(frozen);
 });
 it('searches exact uid or literal nickname text, never account or phone', async () => {
  expect((await users('keyword=11')).list.map(row => row.uid)).toEqual([11]); expect((await users('keyword=alpha')).list.map(row => row.uid)).toEqual([11]);
  expect((await users('keyword=A_%25')).list.map(row => row.uid)).toEqual([16]);
  expect((await users('keyword=SECRET-ACCOUNT')).count).toBe(0); expect((await users('keyword=13899999999')).count).toBe(0);
 });
 it('does not impose a5000-page source truncation and preserves a user avatar of the full underlying256-character size', async () => {
  const far = await users('page=2147483647&limit=100'); expect(far).toEqual({ list: [], count: 5, page: 2147483647, limit: 100 });
  await f.db.insert(user).values({ uid: 19, nickname: 'Long legacy avatar', avatar: 'x'.repeat(256) }); const row = (await users('keyword=19')).list[0]!;
  expect(row.avatar).toBe('x'.repeat(256)); expect(row.preview).toBe(''); expect(row.selection).toMatch(/^[a-f0-9]{64}$/u);
 });
 it('binds selection to the real user source/xmin without signing unrelated user-owned media or changing the user', async () => {
  const before = await users('keyword=11'), frozen = await snapshot();
  const [current] = await f.db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar, status: user.status, isDel: user.isDel, deleteTime: user.deleteTime, rowVersion: sql<string>`xmin::text` }).from(user).where(eq(user.uid, 11));
  expect(before.list[0]!.selection).toBe(staffUserSelection(current!)); expect(await snapshot()).toEqual(frozen);
  await f.db.update(user).set({ nickname: 'Alpha renamed' }).where(eq(user.uid, 11)); const after = await users('keyword=11'); expect(after.list[0]!.selection).not.toBe(before.list[0]!.selection);
  await f.db.update(user).set({ nickname: 'Alpha' }).where(eq(user.uid, 11)); expect((await users('keyword=11')).list[0]!.selection).not.toBe(before.list[0]!.selection);
 });
 it.each([0, 2, 4, 5, 6, 7])('refuses user/gallery reads for guest/view-only/unrelated/foreign actor%d without writes', async id => {
  const frozen = await snapshot(); for (const read of [users, categories, options]) await expect(read('', id)).rejects.toThrow(); expect(await snapshot()).toEqual(frozen);
 });
 it('rechecks live role/password/deadline and does not accept a missing role reference', async () => {
  await f.db.update(systemRole).set({ rules: 'store.view' }).where(eq(systemRole.id, 2)); await expect(users()).rejects.toThrow();
  await f.db.update(systemRole).set({ rules: 'store.manage' }).where(eq(systemRole.id, 2));
  await expect(f.asAdmin(() => service.users(new URLSearchParams(), { ...actor(), authVersion: 'a'.repeat(32) }))).rejects.toThrow();
  await expect(f.asAdmin(() => service.categories(new URLSearchParams(), { ...actor(), expiresAt: 1 }))).rejects.toThrow();
  await f.db.update(systemAdmin).set({ roles: '999' }).where(eq(systemAdmin.id, 3)); await expect(options()).rejects.toThrow(); expect((await users('', 1)).count).toBe(5);
 });
 it.each(['page=0', 'page=01', 'page=2147483648', 'page=1&page=2', 'limit=0', 'limit=101', 'limit=1e1', 'keyword=%00', 'scope=user', 'phone=13899999999', 'keyword=' + 'a'.repeat(81)])('refuses malformed or privacy-expanding user query%s', async query => {
  const frozen = await snapshot(); await expect(users(query)).rejects.toThrow(); expect(await snapshot()).toEqual(frozen);
 });
 it('returns only platform gallery rows/categories, with separate stable reference and response preview', async () => {
  const frozen = await snapshot(); expect(await categories()).toEqual({ list: [{ id: 1, pid: 0, name: '平台头像' }] });
  const root = await options('limit=1'); expect(root.count).toBe(2); expect(root.list[0]).toEqual({ att_id: 6, pid: 0, real_name: '头像6', reference: 'https://legacy.example/avatar.png', preview: 'https://legacy.example/avatar.png' });
  expect((await options('page=2&limit=1')).list[0]!.reference).toBe('/api/assets/1'); expect((await options('pid=1')).list.map(row => row.att_id)).toEqual([2]);
  for (const pid of [2, 3, 4, 999]) await expect(options(`pid=${pid}`)).rejects.toThrow(/分类不存在/);
  expect(await snapshot()).toEqual(frozen);
 });
 it.each(['page=0', 'limit=101', 'pid=01', 'pid=-1', 'name=%00', 'scope=user', 'uid=11'])('refuses malformed or user-realm gallery query%s', async query => { const frozen = await snapshot(); await expect(options(query)).rejects.toThrow(); expect(await snapshot()).toEqual(frozen); });
 it('rejects unknown/duplicate category parameters and an over5000 image source before filtering the response', async () => {
  for (const query of ['pid=0', 'scope=admin', 'name=a&name=b']) await expect(categories(query)).rejects.toThrow();
  for (let start = 100; start < 5101; start += 250) await f.db.insert(systemAttachment).values(Array.from({ length: Math.min(250, 5101 - start) }, (_value, i) => raster(start + i, { attDir: `/static/${start + i}.png`, imageType: 1 })));
  const frozen = await snapshot(); await expect(options('limit=1&name=no-match')).rejects.toThrow(/5000/); expect(await snapshot()).toEqual(frozen);
 });
 it('does not grant attachment mutation and requires APP_KEY only for eligible canonical preview', async () => {
  const noKey = new AdminStaffSupportService(f.container, { APP_KEY: '' });
  await expect(f.asAdmin(() => noKey.users(new URLSearchParams('keyword=11'), actor()))).rejects.toThrow(/APP_KEY/);
  expect((await f.asAdmin(() => noKey.users(new URLSearchParams('keyword=16'), actor()))).list[0]!.preview).toBe('https://legacy.example/a.png');
  await expect(f.asAdmin(() => f.exec("UPDATE public.system_attachment SET real_name='forged' WHERE att_id=1"))).rejects.toMatchObject({ code: '42501' });
 });
});

describe('staff user selection source-stamp protocol, not a user authorization credential', () => {
 const row: StaffUserSelectionRow = { uid: 11, nickname: 'Alpha', avatar: '/api/assets/3', status: 1, isDel: 0, deleteTime: null, rowVersion: '7' };
 it('has a deterministic complete source binding without exposing the row in the picker DTO', () => {
  expect(staffUserSelection(row)).toBe('bcf5f3d9bdeacd63cf3f8d96924e387470cae36ad09aee01fa70b40f5de37bfb'); expect(staffUserSelection({ ...row })).toBe(staffUserSelection(row));
 });
 it.each([{ uid: 12 }, { nickname: 'alpha' }, { avatar: '/api/assets/4' }, { status: 0 }, { isDel: 1 }, { deleteTime: new Date('2026-10-26T00:00:00.000Z') }, { rowVersion: '8' }])('retires a changed source field%j', patch => {
  expect(staffUserSelection({ ...row, ...patch })).not.toBe(staffUserSelection(row));
 });
 it('serializes an equal real Date by ISO and rejects invalid source fields rather than coercing or truncating', () => {
  const date = new Date('2026-10-26T00:00:00.000Z'); expect(staffUserSelection({ ...row, deleteTime: date })).toBe(staffUserSelection({ ...row, deleteTime: new Date(date.getTime()) }));
  for (const patch of [{ uid: 0 }, { uid: 2_147_483_648 }, { nickname: 'n'.repeat(61) }, { avatar: 'a'.repeat(257) }, { status: NaN }, { deleteTime: new Date('invalid') }, { rowVersion: '' }, { rowVersion: '0' }]) expect(() => staffUserSelection({ ...row, ...patch })).toThrow();
 });
});
