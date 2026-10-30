import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { publicRooms } from '@/controllers/api/v1/WechatLiveController';
import { errorHandler } from '@/middleware/error';
import { WechatLiveService } from '@/services/wechat/WechatLiveService';
import { liveAnchor, liveGoods, liveRoom, liveRoomGoods, storeCart, storeOrder, storeProduct, systemAttachment, systemConfig, systemLog, user } from '@/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';

// Fixed PHP8ed2a5b LiveRoomServices::userList56–82 and LiveRoom model76–84:
// public room visibility, local roomGoods.goods association, visible anchor,
// Shanghai date text and status remapping. The keyless relation is a multiset;
// neither PHP hasOne nor the current producer adds goods visibility/purchase
// gates. These tests do not impose the frontend validator's stricter DTO bounds.
// The producer returns raw BUSINESS image references. It performs no asset
// signing/renewal/ownership projection and creates no DIY author media authority.
const START = Date.parse('2026-10-25T00:05:00.000Z') / 1000;
const END = START + 3600;
const tables = [liveAnchor, liveGoods, liveRoom, liveRoomGoods, storeProduct, systemAttachment, systemConfig, systemLog, storeCart, storeOrder, user];
const room = (patch: Partial<typeof liveRoom.$inferInsert> = {}) => ({
  id: 901, roomId: 7001, name: '真实本地直播目录', phone: '13800000002', coverImg: '/static/live-cover.png', shareImg: '/static/live-share.png',
  startTime: START, endTime: END, anchorName: '房间展示主播名', anchorWechat: 'local-anchor', type: 1, screenType: 2,
  closeLike: 1, closeGoods: 1, closeComment: 1, errorMsg: 'private-provider-error', status: 2, liveStatus: 102,
  mark: 'private-room-mark', replayStatus: 1, sort: 5, isShow: 1, isDel: 0, addTime: 123, ...patch,
});
const good = (patch: Partial<typeof liveGoods.$inferInsert> = {}) => ({
  id: 11, goodsId: 811, productId: 211, auditId: 411, name: '本地直播商品', coverImg: '/static/live-good.png', url: '/pages/goods/detail?id=211',
  priceType: 1, costPrice: '1.00', price: '3.25', price2: '4.50', auditStatus: 2, thirdPartTag: 1, sort: 3, isShow: 1, isDel: 0, addTime: 124, ...patch,
});
interface CatalogGood { id: number; goods_id: number; product_id: number; name: string; cover_img: string; url: string; price_type: number; price: string; price2: string }
interface CatalogRoom {
  id: number; room_id: number; roomid: number; name: string; cover_img: string; share_img: string; start_time: number; end_time: number;
  show_time: string; anchor_name: string; anchor_img: string; type: number; screen_type: number; live_status: number; replay_status: number; goods: CatalogGood[];
}

describe('liveBroadcast author real local SQL catalogue and guest public controller', () => {
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: ReturnType<typeof createContainerFromDb>, bindings: Env;
  let external: ReturnType<typeof vi.fn>;
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  // Only the container is a fixture boundary. No admin/shopper identity, auth
  // bypass mock, provider response or row fallback is supplied to this handler.
  app.use('*', async (c, next) => { c.set('container', container); await next(); });
  app.onError(errorHandler);
  app.get('/api/wechat/live', publicRooms);
  beforeAll(async () => {
    fixture = await financeMemoryPostgres(tables); container = createContainerFromDb(fixture.db);
    // The shared fixture builds real ORM columns; explicitly install this table's
    // unusual ORM composite key so legitimate duplicate local IDs are exercised.
    await fixture.exec('ALTER TABLE "live_room" ADD CONSTRAINT "live_room_pk" PRIMARY KEY ("id", "phone")');
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(liveAnchor).values({ id: 10, name: '不替换房间展示名', wechat: 'local-anchor', phone: '13800000003', coverImg: '/static/live-anchor.png', isShow: 1, isDel: 0 });
    await fixture.db.insert(liveGoods).values(good());
    await fixture.db.insert(liveRoom).values(room());
    await fixture.db.insert(liveRoomGoods).values({ liveRoomId: 901, liveGoodsId: 11 });
    await fixture.db.insert(storeProduct).values({ id: 211, storeName: '不可代替直播商品的基础资料', price: '999.00', stock: 0, isShow: 0, isVerify: 0, isDel: 1 });
    await fixture.db.insert(systemAttachment).values({ attId: 61, type: 4, relationId: 99, moduleType: 1, imageType: 8, fileType: 1, attType: 'image/png', name: 'attachments/supplier/99/private.png', attDir: '/api/assets/61' });
    await fixture.db.insert(systemConfig).values([{ id: 71, menuName: 'routine_appId', value: 'never-read-by-public-catalogue' }, { id: 72, menuName: 'routine_appsecret', value: 'local-fixture-placeholder' }]);
    await fixture.db.insert(systemLog).values({ id: 81, adminId: 1, action: 'unrelated-before-live-read', type: 'fixture' });
    await fixture.db.insert(storeCart).values({ id: 91, uid: 11, productId: 211, cartNum: 2 });
    await fixture.db.insert(storeOrder).values({ id: 101, uid: 11, orderId: 'LOCAL_LIVE_UNCHANGED', paid: 0 });
    await fixture.db.insert(user).values({ uid: 11, nickname: '只读旁观用户' });
    external = vi.fn(async () => { throw Error('Public live catalogue must not contact provider, queue, KV or bucket'); });
    bindings = { APP_KEY: 'unused-local-live-catalogue-key', CONFIG_KV: { get: external, put: external, delete: external }, ORDER_QUEUE: { send: external, sendBatch: external }, ASSETS_BUCKET: { get: external, put: external, head: external, list: external, delete: external } } as unknown as Env;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Public live catalogue cannot fetch provider or remote images'));
  });
  afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function snapshot() {
    const rows = await Promise.all(tables.map(async table => [getTableConfig(table).name,
      Array.from(await fixture.db.execute(sql.raw(`SELECT * FROM "${getTableConfig(table).name}" ORDER BY 1,2`)), row => ({ ...row }))] as const));
    return { rows: Object.fromEntries(rows), sequences: Array.from(await fixture.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`), row => ({ ...row })) };
  }
  async function unchanged<T>(work: () => Promise<T>): Promise<T> {
    const before = await snapshot();
    try { return await work(); }
    finally { expect(await snapshot()).toEqual(before); }
  }
  async function response(query = 'page=1&limit=10', headers: Record<string, string> = {}) {
    return unchanged(async () => {
      const result = await app.request(`/api/wechat/live${query ? `?${query}` : ''}`, { method: 'GET', headers }, bindings);
      const body = await result.json() as { status: number; msg: string; data: CatalogRoom[] | null };
      return { result, body };
    });
  }
  async function read(query = 'page=1&limit=10', headers: Record<string, string> = {}) {
    const { result, body } = await response(query, headers);
    expect(result.status).toBe(200); expect(body.status).toBe(200); expect(Array.isArray(body.data)).toBe(true);
    return body.data!;
  }

  it('returns the exact guest DTO with local/provider/product identities and no credential, moderation or cost columns', async () => {
    const routes = readFileSync('src/routes/v1/index.ts', 'utf8');
    expect(routes).toMatch(/v1Routes\.get\("\/wechat\/live",\s*WechatLiveController\.publicRooms\);/u);
    expect(fixture.isMemory).toBe(true);
    expect(await read()).toEqual([{ id: 901, room_id: 7001, roomid: 7001, name: '真实本地直播目录', cover_img: '/static/live-cover.png', share_img: '/static/live-share.png',
      start_time: START, end_time: END, show_time: '10/25 08:05', anchor_name: '房间展示主播名', anchor_img: '/static/live-anchor.png', type: 1, screen_type: 2, live_status: 102, replay_status: 1,
      goods: [{ id: 11, goods_id: 811, product_id: 211, name: '本地直播商品', cover_img: '/static/live-good.png', url: '/pages/goods/detail?id=211', price_type: 1, price: '3.25', price2: '4.50' }] }]);
  });
  it('keeps guest reads independent of forged actor, visibility, purchase and sync-looking query values', async () => {
    expect(await read('page=1&limit=10&uid=999&spid=8&is_show=0&is_del=1&status=0&sync=1&room_id=9', { Authorization: 'Bearer deliberately-invalid-unused-token' })).toEqual(await read());
  });
  it.each([{ isShow: 0 }, { isShow: 2 }, { isDel: 1 }, { isDel: 2 }] as const)('excludes unavailable room %j before joins or pagination', async patch => {
    await fixture.db.update(liveRoom).set(patch); expect(await read()).toEqual([]);
  });
  it.each([[101, 101], [102, 102], [103, 103], [104, 103], [105, 101], [106, 101], [107, 103], [108, 108], [0, 0]] as const)('projects stored live status%s to%s without inventing an extra SQL gate', async (stored, expected) => {
    await fixture.db.update(liveRoom).set({ liveStatus: stored }); expect((await read())[0].live_status).toBe(expected);
  });
  it('does not mistake room moderation, close-goods, replay, type or date metadata for public visibility/purchase admission', async () => {
    for (const patch of [{ status: 0 }, { status: -1 }, { closeGoods: 1 }, { replayStatus: 0 }, { type: 0 }, { startTime: 0, endTime: 0 }, { startTime: 1, endTime: 2 }]) {
      await fixture.db.update(liveRoom).set(patch); expect((await read()).map(row => row.id)).toEqual([901]);
    }
  });
  it('filters high-sort hidden/deleted rows before sortDESC/idDESC/phoneASC pages under the real composite key', async () => {
    await fixture.db.insert(liveRoom).values([
      room({ id: 902, roomId: 7002, sort: 6, name: 'sort6' }), room({ id: 903, roomId: 7003, sort: 5, name: 'id903' }),
      room({ id: 901, phone: '13800000001', roomId: 7101, sort: 5, name: 'phone-first' }),
      room({ id: 990, roomId: 7990, sort: 99, isShow: 0 }), room({ id: 991, roomId: 7991, sort: 99, isDel: 1 }),
    ]);
    const first = await read('page=1&limit=2'), second = await read('page=2&limit=2');
    expect(first.map(row => row.name)).toEqual(['sort6', 'id903']); expect(second.map(row => row.name)).toEqual(['phone-first', '真实本地直播目录']);
    expect(second.map(row => row.id)).toEqual([901, 901]); expect(await read('page=3&limit=2')).toEqual([]);
    expect(second.every(row => !Object.hasOwn(row, 'phone'))).toBe(true);
  });
  it('preserves default20 and max50 with real full pages, stable descending IDs and an empty next page', async () => {
    await fixture.db.insert(liveRoom).values(Array.from({ length: 54 }, (_, index) => room({ id: 902 + index, roomId: 7002 + index })));
    expect((await read('')).map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => 955 - index));
    expect((await read('page=1&limit=50')).map(row => row.id)).toEqual(Array.from({ length: 50 }, (_, index) => 955 - index));
    expect((await read('page=2&limit=50')).map(row => row.id)).toEqual([905, 904, 903, 902, 901]); expect(await read('page=3&limit=50')).toEqual([]);
  });
  it.each(['page=0', 'page=-1', 'page=1.5', 'page=1000001', 'page=Infinity', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=51', 'limit=NaN'])('rejects invalid catalogue pagination%s without writes or provider fallback', async query => {
    const { result, body } = await response(query); expect(result.status).toBe(200); expect(body.status).not.toBe(200); expect(body.msg).toMatch(/页码|每页数量/u); expect(body.data).toBeNull();
  });
  it('accepts the existing maximum page and empty-default parameters without creating a fallback dataset', async () => {
    expect(await read('page=1000000&limit=50')).toEqual([]); expect(await read('page=&limit=')).toEqual(await read(''));
  });
  it.each([[0, ''], [-1, ''], [Date.parse('2026-10-24T16:05:00.000Z') / 1000, '10/25 00:05']] as const)('formats Shanghai start time%s as%s without consulting provider or browser time zone', async (startTime, expected) => {
    await fixture.db.update(liveRoom).set({ startTime }); expect((await read())[0].show_time).toBe(expected);
  });
  it('binds goods by the LOCAL room ID and LOCAL goods ID, never provider room_id/goods_id or base product ID', async () => {
    await fixture.db.insert(liveGoods).values(good({ id: 12, goodsId: 812, productId: 212, name: 'provider-ID干扰项' }));
    await fixture.db.insert(liveRoomGoods).values([{ liveRoomId: 7001, liveGoodsId: 12 }, { liveRoomId: 901, liveGoodsId: 811 }, { liveRoomId: 901, liveGoodsId: 211 }]);
    expect((await read())[0].goods.map(row => [row.id, row.goods_id, row.product_id])).toEqual([[11, 811, 211]]);
  });
  it('preserves live decimal prices, zero and price-type metadata instead of substituting base-product price or range endpoints', async () => {
    await fixture.db.update(liveGoods).set({ price: '0.00', price2: '9.50', priceType: 3 });
    expect((await read())[0].goods[0]).toMatchObject({ id: 11, price: '0.00', price2: '9.50', price_type: 3 });
  });
  it('does not invent goods isShow/isDel/audit/base-product gates absent from the original hasOne relation', async () => {
    await fixture.db.update(liveGoods).set({ isShow: 0, isDel: 1, auditStatus: 3, productId: 999 });
    expect((await read())[0].goods.map(row => [row.id, row.product_id, row.price])).toEqual([[11, 999, '3.25']]);
  });
  it('ignores dangling goods relations while retaining every real related goods row', async () => {
    await fixture.db.insert(liveRoomGoods).values([{ liveRoomId: 901, liveGoodsId: 999 }, { liveRoomId: 901, liveGoodsId: 0 }]);
    expect((await read())[0].goods.map(row => row.id)).toEqual([11]);
  });
  it('preserves repeated keyless room-goods links as repeated DTO rows instead of silently deduplicating imported material', async () => {
    await fixture.db.insert(liveRoomGoods).values({ liveRoomId: 901, liveGoodsId: 11 }); expect((await read())[0].goods.map(row => row.id)).toEqual([11, 11]);
  });
  it('does not truncate raw goods to the separate strict frontend100 boundary', async () => {
    await fixture.db.insert(liveGoods).values(Array.from({ length: 100 }, (_, index) => good({ id: 1001 + index, goodsId: 2001 + index })));
    await fixture.db.insert(liveRoomGoods).values(Array.from({ length: 100 }, (_, index) => ({ liveRoomId: 901, liveGoodsId: 1001 + index })));
    const goods = (await read())[0].goods; expect(goods).toHaveLength(101); expect(new Set(goods.map(row => row.id)).size).toBe(101);
  });
  it('keeps legacy zero/duplicate provider IDs and duplicate local IDs permitted by the source composite key', async () => {
    await fixture.db.insert(liveRoom).values([room({ id: 902, roomId: 0 }), room({ id: 903, roomId: 7001 }), room({ id: 901, phone: '13800000001', roomId: 7101 })]);
    expect((await read()).map(row => [row.id, row.room_id])).toEqual([[903, 7001], [902, 0], [901, 7101], [901, 7001]]);
  });
  it('selects the lowest visible nondeleted anchor ID for the exact wechat key and keeps the ROOM anchor display name', async () => {
    await fixture.db.insert(liveAnchor).values([
      { id: 1, wechat: 'unrelated', coverImg: '/wrong-key.png' }, { id: 2, wechat: 'local-anchor', coverImg: '/hidden.png', isShow: 0 },
      { id: 3, wechat: 'local-anchor', coverImg: '/deleted.png', isDel: 1 }, { id: 12, wechat: 'local-anchor', coverImg: '/later.png' },
    ]);
    expect((await read())[0]).toMatchObject({ anchor_name: '房间展示主播名', anchor_img: '/static/live-anchor.png' });
  });
  it('returns empty relations and avatar when no matching goods or visible anchor exist, with no dummy replacements', async () => {
    await fixture.db.delete(liveRoomGoods); await fixture.db.update(liveAnchor).set({ isShow: 0 }); expect((await read())[0]).toMatchObject({ goods: [], anchor_img: '' });
  });
  it.each(['/static/business-live.png', 'https://images.example.invalid/live.png', 'http://images.example.invalid/live.png', '/api/assets/61', '/api/assets/61?expires=1&signature=old'])('returns raw business image%s without granting attachment authority, signing, renewal or remote image reads', async image => {
    await fixture.db.update(liveRoom).set({ coverImg: image, shareImg: image }); await fixture.db.update(liveAnchor).set({ coverImg: image }); await fixture.db.update(liveGoods).set({ coverImg: image });
    const row = (await read())[0]; expect([row.cover_img, row.share_img, row.anchor_img, row.goods[0].cover_img]).toEqual([image, image, image, image]);
    // In particular, a supplier-owned sentinel or stale ticket is NOT upgraded
    // into a newly signed public asset. Safe display filtering belongs to the
    // consumer; raw persistence remains untouched and no author slot is created.
    expect((await fixture.db.select().from(systemAttachment))[0]).toMatchObject({ type: 4, relationId: 99, attDir: '/api/assets/61' });
  });
  it('uses only local DB reads even with absent credentials and an injected provider client that would reject any call', async () => {
    const providerFetch = vi.fn<typeof fetch>().mockRejectedValue(Error('No direct live provider I/O'));
    const rows = await unchanged(() => new WechatLiveService(container, {} as Env, providerFetch).publicRooms({ page: '1', limit: '10' }));
    expect(rows).toEqual(await read()); expect(providerFetch).not.toHaveBeenCalled();
  });
  it('joins only the selected page rooms without borrowing an off-page room goods or anchor identity', async () => {
    await fixture.db.insert(liveRoom).values(room({ id: 902, roomId: 7002, sort: 6, anchorWechat: 'off-page-anchor', anchorName: '独立显示名' }));
    await fixture.db.insert(liveGoods).values(good({ id: 12, goodsId: 812, productId: 212 }));
    await fixture.db.insert(liveRoomGoods).values({ liveRoomId: 902, liveGoodsId: 12 });
    const first = (await read('page=1&limit=1'))[0], second = (await read('page=2&limit=1'))[0];
    expect([first.id, first.anchor_name, first.anchor_img, first.goods.map(row => row.id)]).toEqual([902, '独立显示名', '', [12]]);
    expect([second.id, second.anchor_img, second.goods.map(row => row.id)]).toEqual([901, '/static/live-anchor.png', [11]]);
  });
  it('returns a genuine empty catalogue after all room rows disappear without using configuration, product or provider fallback', async () => {
    await fixture.db.delete(liveRoom); expect(await read()).toEqual([]);
  });
});
