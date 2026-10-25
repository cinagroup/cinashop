import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAttachment, user } from '@/models/schema';
import { ActivityJoinService } from '@/services/activity/ActivityJoinService';
import { MAX_PINK_AVATAR_MEDIA, publicPinkAvatarPictures } from '@/services/activity/PinkAvatarMediaPolicy';
import { AttachmentService, userAttachmentScope } from '@/services/system/AttachmentService';
import { diyCommerceAuthorFixture } from './helpers/diyCommerceAuthorFixture';
import type { DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('missing owned public pink SQL'); return wiring.container; },
}));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function observeRead(db: DbClient, active: { count: number }, inspect: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== 'transaction') return Reflect.get(target, key, receiver);
    return (callback: (tx: DbClient) => Promise<unknown>) => target.transaction(async inner => {
      const tx = inner as unknown as DbClient; active.count++; let first = true;
      const observed = new Proxy(tx, { get(transaction, property, transactionReceiver) {
        if (property !== 'execute') return Reflect.get(transaction, property, transactionReceiver);
        return async (statement: Parameters<DbClient['execute']>[0]) => { const result = await transaction.execute(statement); if (first) { first = false; await inspect(transaction); } return result; };
      } });
      try { return await callback(observed); } finally { active.count--; }
    });
  } });
}
function sqlState(error: unknown): string | undefined {
  for (let n = 0; n < 6 && error && typeof error === 'object'; n++) { const item = error as { code?: string; cause?: unknown }; if (item.code) return item.code; error = item.cause; }
}

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('public pink canonical avatars on owned PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof diyCommerceAuthorFixture>>, directory = '', otherAvatar = '';
  let original: typeof systemAttachment.$inferSelect;
  const app = createApp(), evidence: Row[] = [];
  beforeAll(async () => {
    f = await diyCommerceAuthorFixture(); wiring.container = f.container;
    directory = await mkdtemp(join(tmpdir(), 'cinashop-public-pink-media-native-'));
    [original] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, Number(f.image.url.split('/').at(-1))));
    otherAvatar = (await new AttachmentService(f.container, f.env).uploadImage(userAttachmentScope(22), new File([f.png], 'other-avatar.png', { type: 'image/png' }), 0)).url;
  }, 90_000);
  afterAll(async () => { try { if (f && directory) await writeFile(join(directory, 'execution.json'), JSON.stringify({ tables: f.tables, sequences: f.sequences, evidence }, null, 2) + '\n'); process.stdout.write('PUBLIC_PINK_AVATAR_MEDIA_NATIVE ' + JSON.stringify({ directory, checks: evidence.length }) + '\n'); } finally { wiring.container = undefined; await f?.close(); } }, 30_000);
  beforeEach(async () => {
    await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId));
    await f.db.update(user).set({ avatar: f.image.url }).where(eq(user.uid, 11));
    await f.db.update(user).set({ avatar: f.platformImage.url }).where(eq(user.uid, 22));
  });
  async function get(path: string, token = '') {
    const before = await f.snapshot(), resources = f.resources(), waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request('https://owned-pink-media.local' + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} }), f.env,
      { waitUntil: (value: Promise<unknown>) => waits.push(value), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Row : null;
    const after = await f.snapshot(); expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
    evidence.push({ path, status: response.status, business_status: payload?.status, before: hash(before), after: hash(after), resources_unchanged: true, body_sha256: createHash('sha256').update(bytes).digest('hex') });
    return { response, payload, bytes };
  }
  function signed(value: string, reference: string) {
    const url = new URL(value, 'https://owned-pink-media.local'), expires = Number(url.searchParams.get('expires'));
    expect(url.pathname).toBe(reference); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000)); expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update('GET\n' + reference + '\n' + expires).digest('base64url'));
  }
  it('keeps public count and participant order while signing only actual participant-owned or platform avatar metadata for all viewers', async () => {
    for (const token of ['', f.token, f.otherToken]) {
      const result = await get('/api/pink', token); expect(result.payload?.status).toBe(200); expect(result.payload?.data.pink_count).toBe(2);
      const avatars = result.payload!.data.avatars as string[]; expect(avatars).toHaveLength(2);
      for (const [index, reference] of [f.image.url, f.platformImage.url].entries()) { signed(avatars[index], reference); const image = await get(avatars[index]); expect(image.response.status).toBe(200); expect(image.bytes).toEqual(f.png); }
    }
  });
  it.each(['other user', 'supplier', 'missing'] as const)('does not mint %s avatar capabilities merely because a participant stores its reference', async kind => {
    await f.db.update(user).set({ avatar: kind === 'other user' ? otherAvatar : kind === 'supplier' ? f.supplierImage.url : '/api/assets/2147483647' }).where(eq(user.uid, 11));
    await f.db.update(user).set({ avatar: '' }).where(eq(user.uid, 22));
    expect((await get('/api/pink')).payload?.data).toEqual({ pink_count: 2, avatars: [] });
  });
  const mutations: Array<[string, Partial<typeof systemAttachment.$inferInsert>]> = [
    ['foreign uid', { relationId: 22 }], ['kefu namespace', { moduleType: 2 }], ['video', { fileType: 2 }], ['legacy storage', { imageType: 1 }],
    ['wrong directory', { attDir: '/api/assets/2147483647' }], ['wrong R2 owner', { name: 'attachments/user/22/avatar.png' }],
    ['traversal', { name: 'attachments/user/11/../22/avatar.png' }], ['svg', { name: 'attachments/user/11/avatar.svg', attType: 'image/svg+xml' }],
    ['contradictory MIME', { attType: 'image/jpeg' }], ['missing MIME', { attType: '' }],
  ];
  it.each(mutations)('rejects exact participant image metadata mutation: %s', async (_name, patch) => {
    await f.db.update(user).set({ avatar: '' }).where(eq(user.uid, 22));
    await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, original.attId));
    expect((await get('/api/pink')).payload?.data).toEqual({ pink_count: 2, avatars: [] });
  });
  it('refreshes an expired stored ticket only after the same UID metadata check and never persists that response ticket', async () => {
    await f.db.update(user).set({ avatar: f.image.url + '?expires=1&signature=old' }).where(eq(user.uid, 11));
    const result = await get('/api/pink'); signed(result.payload!.data.avatars[0], f.image.url);
    await f.db.update(user).set({ avatar: otherAvatar + '?expires=1&signature=old' }).where(eq(user.uid, 11));
    expect((await get('/api/pink')).payload?.data.avatars).toHaveLength(1);
  });
  it('retains existing static and external HTTPS avatars without provider requests', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('no public avatar remote fetch'));
    try { for (const avatar of ['/static/logo.png', 'https://cdn.example.invalid/avatar.jpg']) {
      await f.db.update(user).set({ avatar }).where(eq(user.uid, 11));
      expect((await get('/api/pink')).payload?.data.avatars[0]).toBe(avatar);
    } expect(network).not.toHaveBeenCalled(); } finally { network.mockRestore(); }
  });
  it.each(['/api/assets/01', '/api/assets/0', '/api/assets/2147483648', 'javascript:alert(1)', '//foreign.invalid/avatar.png', 'data:image/png;base64,AA=='])('does not sign malformed or unsafe avatar %s', async avatar => {
    await f.db.update(user).set({ avatar }).where(eq(user.uid, 11)); await f.db.update(user).set({ avatar: '' }).where(eq(user.uid, 22));
    expect((await get('/api/pink')).payload?.data).toEqual({ pink_count: 2, avatars: [] });
  });
  it('uses the actual RR READ ONLY snapshot, signs after its end and rejects a counterfactual SQL mutation', async () => {
    const active = { count: 0 }; let snapshots = 0, signs = 0; const before = await f.snapshot(), resources = f.resources();
    const db = observeRead(f.db, active, async tx => { const [state] = await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`); expect(state).toEqual({ readonly: 'on', isolation: 'repeatable read' }); snapshots++; });
    const originalSign = crypto.subtle.sign.bind(crypto.subtle), sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args: Parameters<typeof crypto.subtle.sign>) => { expect(active.count).toBe(0); signs++; return originalSign(...args); });
    try { expect((await new ActivityJoinService(createContainerFromDb(db), f.env).pinkStats()).avatars).toHaveLength(2); expect(snapshots).toBe(1); expect(signs).toBeGreaterThan(0); } finally { sign.mockRestore(); }
    const deniedDb = observeRead(f.db, { count: 0 }, async tx => { await tx.update(user).set({ avatar: 'must-not-write' }).where(eq(user.uid, 11)); });
    const failure = await new ActivityJoinService(createContainerFromDb(deniedDb), f.env).pinkStats().then(() => undefined, error => error);
    expect(sqlState(failure)).toBe('25006'); expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  });
  it('does not return a partial list on missing key or a synthetic HMAC failure', async () => {
    const before = await f.snapshot(), resources = f.resources(); await expect(new ActivityJoinService(f.container, { ...f.env, APP_KEY: '' }).pinkStats()).rejects.toThrow('APP_KEY');
    const sign = vi.spyOn(crypto.subtle, 'sign').mockRejectedValue(Error('owned synthetic pink HMAC failure'));
    try { await expect(new ActivityJoinService(f.container, f.env).pinkStats()).rejects.toThrow('owned synthetic pink HMAC failure'); } finally { sign.mockRestore(); }
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  });
  it('rejects the whole avatar input above its bounded public participant capacity before querying', async () => {
    const select = vi.spyOn(f.db, 'select');
    try { await expect(publicPinkAvatarPictures(f.db, Array.from({ length: MAX_PINK_AVATAR_MEDIA + 1 }, () => ({ uid: 11, image: f.image.url })))).rejects.toThrow('完整预览容量'); expect(select).not.toHaveBeenCalled(); } finally { select.mockRestore(); }
  });
});
