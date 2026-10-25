import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { liveAnchor, liveGoods, liveRoom, liveRoomGoods, storeProduct, systemAttachment, systemSupplier } from '@/models/schema';
import { WechatLiveService } from '@/services/wechat/WechatLiveService';
import { MAX_WECHAT_LIVE_MEDIA_REFERENCES, publicWechatLivePictures } from '@/services/wechat/WechatLiveMediaPolicy';
import { diyCommerceAuthorFixture } from './helpers/diyCommerceAuthorFixture';
import type { DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('missing owned public live SQL'); return wiring.container; },
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

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('public WeChat live canonical images on owned PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof diyCommerceAuthorFixture>>, directory = '';
  let original: typeof systemAttachment.$inferSelect, relationRows: Array<typeof liveRoomGoods.$inferSelect>;
  const app = createApp(), evidence: Row[] = [];
  beforeAll(async () => {
    f = await diyCommerceAuthorFixture(); wiring.container = f.container; directory = await mkdtemp(join(tmpdir(), 'cinashop-public-live-media-native-'));
    [original] = await f.db.select().from(systemAttachment).where(eq(systemAttachment.attId, Number(f.platformImage.url.split('/').at(-1)))); relationRows = await f.db.select().from(liveRoomGoods);
    await f.db.insert(systemSupplier).values({ id: 84062, name: 'active unrelated live image supplier', isShow: 1, isDel: 0 });
  }, 90_000);
  afterAll(async () => { try { if (f && directory) await writeFile(join(directory, 'execution.json'), JSON.stringify({ tables: f.tables, sequences: f.sequences, evidence }, null, 2) + '\n'); process.stdout.write('PUBLIC_WECHAT_LIVE_MEDIA_NATIVE ' + JSON.stringify({ directory, checks: evidence.length }) + '\n'); } finally { wiring.container = undefined; await f?.close(); } }, 30_000);
  beforeEach(async () => {
    await f.db.update(systemAttachment).set(original).where(eq(systemAttachment.attId, original.attId));
    await f.db.update(systemSupplier).set({ isShow: 1, isDel: 0 }).where(eq(systemSupplier.id, 84061));
    await f.db.update(storeProduct).set({ type: 0, relationId: 0 }).where(eq(storeProduct.id, 601));
    await f.db.update(liveRoom).set({ coverImg: f.platformImage.url, shareImg: f.secondIcon.url }).where(eq(liveRoom.id, 2101));
    await f.db.update(liveAnchor).set({ coverImg: f.secondIcon.url, isShow: 1, isDel: 0 }).where(eq(liveAnchor.id, 2201));
    await f.db.update(liveGoods).set({ coverImg: f.platformImage.url, productId: 601 }).where(eq(liveGoods.id, 2301));
    await f.db.delete(liveRoomGoods); await f.db.insert(liveRoomGoods).values(relationRows);
  });
  async function get(path: string) {
    const before = await f.snapshot(), resources = f.resources(), waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request('https://owned-live-media.local' + path), f.env,
      { waitUntil: (value: Promise<unknown>) => waits.push(value), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(waits); const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Row : null;
    const after = await f.snapshot(); expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
    evidence.push({ path, status: response.status, business_status: payload?.status, before: hash(before), after: hash(after), resources_unchanged: true, body_sha256: createHash('sha256').update(bytes).digest('hex') }); return { response, payload, bytes };
  }
  const rooms = async () => { const result = await get('/api/wechat/live?page=1&limit=3'); expect(result.payload?.status).toBe(200); return result.payload!.data as Row[]; };
  function signed(value: string, reference: string) {
    const url = new URL(value, 'https://owned-live-media.local'), expires = Number(url.searchParams.get('expires'));
    expect(url.pathname).toBe(reference); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000)); expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update('GET\n' + reference + '\n' + expires).digest('base64url'));
  }
  it('keeps visible room identities, statuses, pagination, goods relation and exact DTO fields while signing all four declared media roles', async () => {
    const data = await rooms(); expect(data.map(row => [row.id, row.room_id, row.live_status])).toEqual([[2101, 3101, 101], [2102, 3102, 102], [2103, 3103, 103]]);
    expect(data[0]).toMatchObject({ roomid: 3101, anchor_name: '真实直播主播', goods: [{ id: 2301, goods_id: 3301, product_id: 601, price: '0.00' }] });
    const slots = [[data[0].cover_img, f.platformImage.url], [data[0].share_img, f.secondIcon.url], [data[0].anchor_img, f.secondIcon.url], [data[0].goods[0].cover_img, f.platformImage.url]];
    for (const [value, reference] of slots) { signed(value, reference); const image = await get(value); expect(image.response.status).toBe(200); expect(image.bytes).toEqual(f.png); }
    expect((await get('/api/wechat/live?page=4&limit=1')).payload?.data).toEqual([]);
  });
  it('uses the exact linked product supplier and denies inactive or a different supplier without changing the goods DTO', async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 84061 }).where(eq(storeProduct.id, 601)); await f.db.update(liveGoods).set({ coverImg: f.supplierImage.url }).where(eq(liveGoods.id, 2301));
    const first = (await rooms())[0].goods[0]; signed(first.cover_img, f.supplierImage.url); expect((await get(first.cover_img)).bytes).toEqual(f.png);
    await f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 84061)); expect((await rooms())[0].goods[0]).toMatchObject({ id: 2301, product_id: 601, cover_img: '' });
    await f.db.update(systemSupplier).set({ isShow: 1 }).where(eq(systemSupplier.id, 84061)); await f.db.update(storeProduct).set({ relationId: 84062 }).where(eq(storeProduct.id, 601)); expect((await rooms())[0].goods[0].cover_img).toBe('');
  });
  it('follows existing SKU store-product media mapping only for a valid persisted store relation and still rejects supplier or user attachment scopes', async () => {
    for (const relationId of [77, 2147483647]) {
      await f.db.update(storeProduct).set({ type: 1, relationId }).where(eq(storeProduct.id, 601));
      await f.db.update(liveGoods).set({ coverImg: f.platformImage.url }).where(eq(liveGoods.id, 2301));
      signed((await rooms())[0].goods[0].cover_img, f.platformImage.url);
      for (const image of [f.supplierImage.url, f.image.url]) { await f.db.update(liveGoods).set({ coverImg: image }).where(eq(liveGoods.id, 2301)); expect((await rooms())[0].goods[0].cover_img).toBe(''); }
      for (const image of ['/static/logo.png', 'https://cdn.example.invalid/store-live.jpg']) { await f.db.update(liveGoods).set({ coverImg: image }).where(eq(liveGoods.id, 2301)); expect((await rooms())[0].goods[0].cover_img).toBe(image); }
    }
    await f.db.update(storeProduct).set({ type: 1, relationId: -1 }).where(eq(storeProduct.id, 601)); await f.db.update(liveGoods).set({ coverImg: f.platformImage.url }).where(eq(liveGoods.id, 2301)); expect((await rooms())[0].goods[0].cover_img).toBe('');
    await f.db.update(storeProduct).set({ relationId: 0 }).where(eq(storeProduct.id, 601)); signed((await rooms())[0].goods[0].cover_img, f.platformImage.url);
  });
  it.each(['user', 'supplier'] as const)('does not authorize %s attachments in platform-only room, share or anchor slots', async kind => {
    const image = kind === 'user' ? f.image.url : f.supplierImage.url;
    await f.db.update(liveRoom).set({ coverImg: image, shareImg: image }).where(eq(liveRoom.id, 2101)); await f.db.update(liveAnchor).set({ coverImg: image }).where(eq(liveAnchor.id, 2201));
    const first = (await rooms())[0]; expect([first.cover_img, first.share_img, first.anchor_img]).toEqual(['', '', '']); signed(first.goods[0].cover_img, f.platformImage.url);
  });
  it.each([0, 2147483647, 84033])('does not infer canonical goods ownership from another picture or product when exact productId is %s', async productId => {
    await f.db.update(liveGoods).set({ productId, coverImg: f.image.url }).where(eq(liveGoods.id, 2301)); expect((await rooms())[0].goods[0]).toMatchObject({ id: 2301, product_id: productId, cover_img: '' });
  });
  const mutations: Array<[string, Partial<typeof systemAttachment.$inferInsert>]> = [
    ['other namespace', { moduleType: 2 }], ['video', { fileType: 2 }], ['legacy storage', { imageType: 1 }], ['other directory', { attDir: '/api/assets/2147483647' }],
    ['wrong platform folder', { name: 'attachments/admin/0/live.png' }], ['traversal', { name: 'attachments/admin/1/../2/live.png' }],
    ['SVG', { name: 'attachments/admin/1/live.svg', attType: 'image/svg+xml' }], ['contradictory MIME', { attType: 'image/jpeg' }],
  ];
  it.each(mutations)('rejects platform room and product image metadata mutation: %s', async (_name, patch) => {
    await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId, original.attId)); const first = (await rooms())[0]; expect(first.cover_img).toBe(''); expect(first.goods[0].cover_img).toBe(''); signed(first.anchor_img, f.secondIcon.url);
  });
  it('refreshes old stored tickets only after rechecking explicit platform and product media ownership', async () => {
    const ticket = f.platformImage.url + '?expires=1&signature=old'; await f.db.update(liveRoom).set({ coverImg: ticket }).where(eq(liveRoom.id, 2101)); await f.db.update(liveGoods).set({ coverImg: ticket }).where(eq(liveGoods.id, 2301));
    const first = (await rooms())[0]; signed(first.cover_img, f.platformImage.url); signed(first.goods[0].cover_img, f.platformImage.url);
  });
  it('retains each static or external HTTPS media slot without making provider requests', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('no public live provider fetch'));
    try { for (const image of ['/static/logo.png', 'https://cdn.example.invalid/live.jpg']) { await f.db.update(liveRoom).set({ coverImg: image, shareImg: image }).where(eq(liveRoom.id, 2101)); await f.db.update(liveAnchor).set({ coverImg: image }).where(eq(liveAnchor.id, 2201)); await f.db.update(liveGoods).set({ coverImg: image }).where(eq(liveGoods.id, 2301)); const first = (await rooms())[0]; expect([first.cover_img, first.share_img, first.anchor_img, first.goods[0].cover_img]).toEqual([image, image, image, image]); } expect(network).not.toHaveBeenCalled(); } finally { network.mockRestore(); }
  });
  it('uses one actual RR READ ONLY snapshot and signs after transaction closure, with a real SQL DML counterfactual', async () => {
    const active = { count: 0 }; let snapshots = 0, signs = 0; const before = await f.snapshot(), resources = f.resources();
    const db = observeRead(f.db, active, async tx => { const [state] = await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`); expect(state).toEqual({ readonly: 'on', isolation: 'repeatable read' }); snapshots++; });
    const originalSign = crypto.subtle.sign.bind(crypto.subtle), sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args: Parameters<typeof crypto.subtle.sign>) => { expect(active.count).toBe(0); signs++; return originalSign(...args); });
    try { expect(await new WechatLiveService(createContainerFromDb(db), f.env).publicRooms({ limit: '3' })).toHaveLength(3); expect(snapshots).toBe(1); expect(signs).toBeGreaterThan(0); } finally { sign.mockRestore(); }
    const deniedDb = observeRead(f.db, { count: 0 }, async tx => { await tx.update(liveRoom).set({ coverImg: 'must-not-write' }).where(eq(liveRoom.id, 2101)); }); const failure = await new WechatLiveService(createContainerFromDb(deniedDb), f.env).publicRooms({}).then(() => undefined, error => error);
    expect(sqlState(failure)).toBe('25006'); expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  });
  it.each([MAX_WECHAT_LIVE_MEDIA_REFERENCES + 1, MAX_WECHAT_LIVE_MEDIA_REFERENCES - 8])('rejects complete nested relation/media overflow of %s without returning a prefix or signing', async count => {
    await f.db.delete(liveRoomGoods); await f.db.insert(liveRoomGoods).values(Array.from({ length: count }, () => ({ liveRoomId: 2101, liveGoodsId: 2301 })));
    const before = await f.snapshot(), resources = f.resources(), sign = vi.spyOn(crypto.subtle, 'sign');
    try { await expect(new WechatLiveService(f.container, f.env).publicRooms({ limit: '3' })).rejects.toThrow('完整预览容量'); expect(sign).not.toHaveBeenCalled(); } finally { sign.mockRestore(); }
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  });
  it('rejects an over-budget media policy input before SQL and never returns a partial signed DTO on missing key or HMAC failure', async () => {
    const select = vi.spyOn(f.db, 'select');
    try { await expect(publicWechatLivePictures(f.db, Array.from({ length: MAX_WECHAT_LIVE_MEDIA_REFERENCES + 1 }, () => ({ image: f.platformImage.url, scope: 'platform' as const })))).rejects.toThrow('完整预览容量'); expect(select).not.toHaveBeenCalled(); } finally { select.mockRestore(); }
    const before = await f.snapshot(), resources = f.resources(); await expect(new WechatLiveService(f.container, { ...f.env, APP_KEY: '' }).publicRooms({})).rejects.toThrow('APP_KEY');
    const sign = vi.spyOn(crypto.subtle, 'sign').mockRejectedValue(Error('owned synthetic live HMAC failure'));
    try { await expect(new WechatLiveService(f.container, f.env).publicRooms({})).rejects.toThrow('owned synthetic live HMAC failure'); } finally { sign.mockRestore(); }
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  });
});
