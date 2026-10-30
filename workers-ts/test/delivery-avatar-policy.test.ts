import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import * as signing from '@/services/system/AttachmentService';
import { deliveryAvatarInput, publicDeliveryAvatarReferences, renderDeliveryAvatarReferences, assertDeliveryAvatarChange } from '@/services/delivery/DeliveryAvatarPolicy';
import { createAdminStaffFixture } from './helpers/adminStaffFixture';

const key = 'owned-delivery-avatar-key', ticket = (id: number) => `/api/assets/${id}?expires=1&signature=old`;
const raster = (id: number, patch = {}) => ({ attId: id, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
  attDir: `/api/assets/${id}`, sattDir: `/api/assets/${id}`, name: `attachments/admin/1/2026/10/avatar-${id}.png`, attType: 'image/png', ...patch });

describe('delivery avatar platform and exact selected-user ownership with real restricted SQL', () => {
 let f: Awaited<ReturnType<typeof createAdminStaffFixture>>;
 beforeAll(async () => { f = await createAdminStaffFixture(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Delivery avatar policy cannot fetch providers or objects')); }, 30000);
 afterAll(async () => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); }, 30000);
 beforeEach(async () => { await f.reset(); await f.db.insert(systemAttachment).values([raster(1), raster(2),
  raster(3, { type: 3, relationId: 11, moduleType: 3, name: 'attachments/user/11/2026/10/avatar.png' }),
  raster(4, { type: 3, relationId: 12, moduleType: 3, name: 'attachments/user/12/2026/10/avatar.png' })]); });
 const read = (rows: Parameters<typeof publicDeliveryAvatarReferences>[1]) => f.asAdmin(() => publicDeliveryAvatarReferences(f.db, rows));
 const assert = (old: Parameters<typeof assertDeliveryAvatarChange>[1], next: Parameters<typeof assertDeliveryAvatarChange>[2]) =>
  f.asAdmin(() => f.db.transaction(tx => assertDeliveryAvatarChange(tx as unknown as DbClient, old, next)));
 async function snapshot() { return { rows: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId),
  sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)) }; }
 it('signs current platform or exact selected-user avatars without mutating raw rows or granting unknown slots', async () => {
  const rows = [{ avatar: ticket(1), uid: 11, userAvatar: ticket(3), unknown: '/api/assets/4' }, { avatar: ticket(3), uid: 11, userAvatar: ticket(3), image: '/api/assets/4' }], before = structuredClone(rows), frozen = await snapshot();
  const references = await read(rows); expect(references).toEqual([{ avatar: '/api/assets/1' }, { avatar: '/api/assets/3' }]);
  const rendered = await renderDeliveryAvatarReferences(key, references);
  expect(rendered[0]!.avatar).toMatch(/^\/api\/assets\/1\?expires=\d+&signature=/u); expect(rendered[1]!.avatar).toMatch(/^\/api\/assets\/3\?expires=\d+&signature=/u);
  expect(rows).toEqual(before); expect(await snapshot()).toEqual(frozen);
 });
 it('requires exact current raw user avatar, uid and metadata together, not just a claimed attachment id', async () => {
  expect(await read([{ avatar: '/api/assets/3', uid: 11 }, { avatar: '/api/assets/3', uid: 12, userAvatar: '/api/assets/3' },
   { avatar: '/api/assets/3', uid: 11, userAvatar: ticket(3) }, { avatar: '/api/assets/4', uid: 11, userAvatar: '/api/assets/4' }]))
   .toEqual([{ avatar: '' }, { avatar: '' }, { avatar: '' }, { avatar: '' }]);
  await assert(null, { avatar: '/api/assets/3', uid: 11, userAvatar: '/api/assets/3' });
  await expect(assert(null, { avatar: '/api/assets/3', uid: 11, userAvatar: '/api/assets/4' })).rejects.toThrow();
  await expect(assert({ avatar: '/api/assets/3', uid: 11 }, { avatar: '/api/assets/3', uid: 12, userAvatar: '/api/assets/3' })).rejects.toThrow();
 });
 it.each([
  ['another user metadata', { relationId: 12 }], ['supplier realm', { type: 4, relationId: 11, moduleType: 1 }],
  ['visitor namespace', { moduleType: 4 }], ['kefu namespace', { type: 1, relationId: 11, moduleType: 2 }],
  ['nonraster kind', { fileType: 2 }], ['non-R2', { imageType: 1 }], ['foreign user key', { name: 'attachments/user/12/2026/10/avatar.png' }],
  ['platform key in user realm', { name: 'attachments/admin/1/2026/10/avatar.png' }], ['traversal', { name: 'attachments/user/11/2026/10/../avatar.png' }],
  ['SVG extension', { name: 'attachments/user/11/2026/10/avatar.svg' }], ['SVG MIME', { attType: 'image/svg+xml' }], ['MIME mismatch', { attType: 'image/jpeg' }],
  ['another current path', { attDir: '/api/assets/4' }], ['metadata ticket', { attDir: ticket(3) }], ['metadata entity', { attDir: '/&#97;pi/assets/3' }],
 ] as const)('rejects selected-user %s before signature and changed-reference authorization', async (_name, patch) => {
  await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, 3)); const frozen = await snapshot();
  expect(await read([{ avatar: ticket(3), uid: 11, userAvatar: ticket(3) }])).toEqual([{ avatar: '' }]);
  await expect(assert(null, { avatar: '/api/assets/3', uid: 11, userAvatar: '/api/assets/3' })).rejects.toThrow(); expect(await snapshot()).toEqual(frozen);
 });
 it.each([
  ['foreign platform relation', { relationId: 2 }], ['foreign admin folder', { name: 'attachments/admin/2/avatar.png' }],
  ['user module', { moduleType: 3 }], ['foreign platform realm', { type: 3 }],
 ] as const)('rejects platform %s even with an exact user-avatar string', async (_name, patch) => {
  await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, 1));
  expect(await read([{ avatar: '/api/assets/1', uid: 11, userAvatar: '/api/assets/1' }])).toEqual([{ avatar: '' }]);
  await expect(assert(null, { avatar: '/api/assets/1', uid: 11, userAvatar: '/api/assets/1' })).rejects.toThrow();
 });
 it('refuses missing changed canonical metadata and allows legacy empty MIME only with a real matching raster key', async () => {
  await f.db.delete(systemAttachment).where(eq(systemAttachment.attId, 3)); await f.db.update(systemAttachment).set({ attType: '' }).where(eq(systemAttachment.attId, 1));
  expect(await read([{ avatar: '/api/assets/3', uid: 11, userAvatar: '/api/assets/3' }, { avatar: '/api/assets/1', uid: 11 }])).toEqual([{ avatar: '' }, { avatar: '/api/assets/1' }]);
  await expect(assert(null, { avatar: '/api/assets/3', uid: 11, userAvatar: '/api/assets/3' })).rejects.toThrow();
 });
 it('retains same raw and uid without SQL, while changing uid requires current ownership', async () => {
  const query = vi.spyOn(f.db, 'select');
  try { for (const avatar of ['javascript:old', 'http://legacy.example/avatar.png', ticket(3)]) await assertDeliveryAvatarChange(f.db, { avatar, uid: 11 }, { avatar, uid: 11, userAvatar: '' }); expect(query).not.toHaveBeenCalled(); }
  finally { query.mockRestore(); }
  await expect(assert({ avatar: '/api/assets/3', uid: 11 }, { avatar: '/api/assets/3', uid: 12, userAvatar: '/api/assets/3' })).rejects.toThrow();
 });
 it('may copy the real selected raw HTTP/unsafe history, while independent new avatars remain safe and stable', async () => {
  for (const avatar of ['http://legacy.example/avatar.png', 'javascript:old']) await assert(null, { avatar, uid: 11, userAvatar: avatar });
  expect(await read([{ avatar: 'http://legacy.example/avatar.png', uid: 11, userAvatar: 'http://legacy.example/avatar.png' }, { avatar: 'javascript:old', uid: 11, userAvatar: 'javascript:old' }]))
   .toEqual([{ avatar: 'https://legacy.example/avatar.png' }, { avatar: '' }]);
  for (const avatar of ['http://legacy.example/other.png', 'javascript:new', ticket(1)]) await expect(assert(null, { avatar, uid: 11, userAvatar: '' })).rejects.toThrow();
  for (const avatar of ['https://cdn.example/avatar.png', '/static/avatar.png', '']) await assert(null, { avatar, uid: 11, userAvatar: '' });
 });
 it('copies an exact current user ticket only after stable id/current owner metadata checks and returns a fresh display ticket', async () => {
  const avatar = ticket(3); await assert(null, { avatar, uid: 11, userAvatar: avatar });
  const [row] = await renderDeliveryAvatarReferences(key, await read([{ avatar, uid: 11, userAvatar: avatar }])); expect(row!.avatar).not.toBe(avatar); expect(row!.avatar).toMatch(/^\/api\/assets\/3\?expires=\d+/u);
  await expect(assert(null, { avatar: '/api/assets/0', uid: 11, userAvatar: '/api/assets/0' })).rejects.toThrow();
 });
 it('does not decode entities, query SQL or sign independent public/static paths', async () => {
  const rows = [{ avatar: '/&#97;pi/assets/3', uid: 11 }, { avatar: 'https://cdn.example/a.png?x=1&amp;y=2', uid: 11 }, { avatar: '/static/a&amp;b.png', uid: 11 }], before = structuredClone(rows);
  const query = vi.spyOn(f.db, 'select'), sign = vi.spyOn(signing, 'signAttachmentReferences');
  try { const refs = await publicDeliveryAvatarReferences(f.db, rows); expect(await renderDeliveryAvatarReferences(undefined, refs)).toEqual(rows.map(row => ({ avatar: row.avatar }))); expect(rows).toEqual(before); expect(query).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled(); }
  finally { query.mockRestore(); sign.mockRestore(); }
 });
 it.each(['//foreign.test/a.png', 'data:image/png;base64,AA==', 'blob:old', 'file:///private', 'https://name:secret@host/a.png', '/static/a b.png', '/static/a\\b.png', '/api/assets/2147483648'])('does not display unsafe history %s', async avatar => {
  expect(await read([{ avatar, uid: 11, userAvatar: avatar }])).toEqual([{ avatar: '' }]);
 });
 it('validates input and preserves a whole20000-row directory without trimming or hidden-slot traversal', async () => {
  for (const value of [null, undefined, 2, {}, [], 'a'.repeat(251)]) expect(() => deliveryAvatarInput(value)).toThrow();
  expect(deliveryAvatarInput('/api/assets/1')).toBe('/api/assets/1');
  const rows = Array.from({ length: 20000 }, () => ({ avatar: '/api/assets/1', uid: 11 })), before = structuredClone(rows), refs = await read(rows);
  expect(refs).toHaveLength(20000); expect(refs.at(-1)).toEqual({ avatar: '/api/assets/1' }); expect(rows).toEqual(before);
  const query = vi.spyOn(f.db, 'select'); try { await expect(publicDeliveryAvatarReferences(f.db, [...rows, rows[0]!])).rejects.toThrow(/容量/); await expect(renderDeliveryAvatarReferences(key, [...refs, refs[0]!])).rejects.toThrow(/容量/); expect(query).not.toHaveBeenCalled(); } finally { query.mockRestore(); }
 });
 it('enforces the actual250-character avatar column without truncating a selected256-character user source', async () => {
  const public250 = 'https://cdn.example/' + 'a'.repeat(230);
  expect([...public250]).toHaveLength(250); expect(deliveryAvatarInput(public250)).toBe(public250);
  await assert(null, { avatar: public250, uid: 11, userAvatar: '' });
  expect(() => deliveryAvatarInput(public250 + 'a')).toThrow(/250/);
  for (const length of [251, 256]) { const raw = 'x'.repeat(length); await expect(assert(null, { avatar: raw, uid: 11, userAvatar: raw })).rejects.toThrow(); expect(raw).toHaveLength(length); }
 });
 it('requires a configured signature key only for a currently authorized canonical avatar, without acquiring write rights', async () => {
  await expect(renderDeliveryAvatarReferences(undefined, await read([{ avatar: '/api/assets/1', uid: 11 }]))).rejects.toThrow(/APP_KEY/);
  await expect(f.asAdmin(() => f.exec("UPDATE public.system_attachment SET real_name='forged' WHERE att_id=1"))).rejects.toMatchObject({ code: '42501' });
 });
});
