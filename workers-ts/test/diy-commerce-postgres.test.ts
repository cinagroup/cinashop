import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { eq } from 'drizzle-orm';
import { storeActivity, storeBargain, storeCombination, storeProduct, storeProductLabel, storeSeckill, storeSeckillTime } from '@/models/schema';
import { diyCommerceFixture, DIY_COMMERCE_FAMILIES, DIY_COMMERCE_NOW } from './helpers/diyCommerceFixture';
import { sortedDiyState, type DiyStateRow, type DiyStateSnapshot, type DiyStateViewer } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned DIY commerce SQL'); return wiring.container;
} }));
const viewers = [0, 11, 22] as const;
// PostgreSQL jsonb serializes timestamp-without-time-zone without Z and trims
// fractional trailing zeros; retain every nonzero millisecond exactly.
const pgTimestamp = (value: Date) => value.toISOString().replace(/Z$/u, '').replace(/\.([0-9]*?)0+$/u, (_match, digits: string) => digits ? `.${digits}` : '');

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native DIY commerce real catalogues and manual coupon claims', () => {
  let f: Awaited<ReturnType<typeof diyCommerceFixture>>; const app = createApp();
  beforeAll(async () => {
    vi.setSystemTime(DIY_COMMERCE_NOW); f = await diyCommerceFixture(DIY_COMMERCE_NOW); wiring.container = f.container;
    expect(f.tables).toHaveLength(46); expect(f.sequences).toHaveLength(43);
    expect(f.seedStorage.puts).toBe(1); expect(f.seedStorage.deletes).toBe(0); expect(f.seedStorage.keys).toHaveLength(1);
  }, 30_000);
  afterAll(async () => { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }, 30_000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned DIY commerce fixture forbids provider I/O')); });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  const storage = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, keys: [...f.objects.keys()],
    queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
  async function request(path: string, viewer: DiyStateViewer = 11, body?: unknown, raw?: string) {
    const waits: Promise<unknown>[] = [], headers: Record<string, string> = viewer ? { Authorization: `Bearer ${viewer === 11 ? f.token : f.otherToken}` } : {};
    const post = body !== undefined || raw !== undefined;
    if (post) headers['Content-Type'] = 'application/json';
    const res = await app.fetch(new Request(`http://localhost${path}`, { method: post ? 'POST' : 'GET', headers,
      ...(post ? { body: raw ?? JSON.stringify(body) } : {}) }), f.env,
    { waitUntil: work => { waits.push(work); }, passThroughOnException() {} } as ExecutionContext);
    await Promise.all(waits); return res;
  }
  async function read(path: string, viewer: DiyStateViewer = 11, status = 200) {
    const before = await f.snapshot(), beforeStorage = storage(), res = await request(path, viewer);
    expect(res.status).toBe(200); const body = await res.json() as DiyStateRow; expect(body.status).toBe(status);
    expect(await f.snapshot()).toEqual(before); expect(storage()).toEqual(beforeStorage); return body;
  }
  async function reject(body: unknown, viewer: DiyStateViewer = 11, status = 400, message?: string, raw?: string) {
    const before = await f.snapshot(), beforeStorage = storage(), res = await request('/api/coupon/receive', viewer, body, raw);
    expect(res.status).toBe(200); const result = await res.json() as DiyStateRow; expect(result.status).toBe(status);
    if (message) expect(result.msg).toBe(message);
    expect(await f.snapshot()).toEqual(before); expect(storage()).toEqual(beforeStorage); return result;
  }
  function claimReceipt(before: DiyStateSnapshot, after: DiyStateSnapshot, uid: 11 | 22, issueId: number, couponUserId: number) {
    const want = structuredClone(before), issue = before.store_coupon_issue.find(row => row.id === issueId)!;
    const seq = want.__sequences.find(row => row.name === 'store_coupon_user_id_seq')!;
    const nextId = seq.called ? Number(seq.last) + 1 : Number(seq.last);
    expect(couponUserId).toBe(nextId); seq.last = String(nextId); seq.called = true;
    const coupon = { id: nextId, uid, issue_coupon_id: issueId, coupon_title: issue.coupon_title || issue.title,
      coupon_price: issue.coupon_price, use_min_price: issue.use_min_price, status: 0, start_time: pgTimestamp(f.now),
      end_time: pgTimestamp(new Date(f.now.getTime() + issue.day * 86400000)), use_time: null, type: issue.type,
      receive_time: f.seconds, receive_source: 'get', is_fail: 0 };
    want.store_coupon_issue = want.store_coupon_issue.map(row => row.id === issueId ? { ...row, remain_count: row.remain_count - 1 } : row);
    want.store_coupon_user.push(coupon); want.store_coupon_issue_user.push({ uid, issue_coupon_id: issueId, add_time: f.seconds });
    expect(after).toEqual(sortedDiyState(want)); return { coupon, before, after };
  }
  async function claim(body: unknown, viewer: 11 | 22, issueId: number) {
    const before = await f.snapshot(), beforeStorage = storage(), res = await request('/api/coupon/receive', viewer, body);
    expect(res.status).toBe(200); const result = await res.json() as DiyStateRow;
    expect(result).toEqual({ status: 200, msg: '领取成功', data: { couponUserId: expect.any(Number) } });
    const receipt = claimReceipt(before, await f.snapshot(), viewer, issueId, result.data.couponUserId);
    expect(storage()).toEqual(beforeStorage); return receipt;
  }
  async function fixtureChange(table: string, id: number, fields: DiyStateRow, write: () => PromiseLike<unknown>) {
    const before = await f.snapshot(); await write(); const after = await f.snapshot(), want = structuredClone(before);
    const patch = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
      value instanceof Date ? pgTimestamp(value) : value]));
    expect(want[table].filter(row => row.id === id)).toHaveLength(1);
    want[table] = want[table].map(row => row.id === id ? { ...row, ...patch } : row);
    expect(after).toEqual(sortedDiyState(want));
  }
  const productActivity = (activity: string) => fixtureChange('store_product', 602, { activity }, () => f.db.update(storeProduct).set({ activity }).where(eq(storeProduct.id, 602)));
  const seckillFields = (fields: Partial<typeof storeSeckill.$inferInsert>) => fixtureChange('store_seckill', 1701, fields, () => f.db.update(storeSeckill).set(fields).where(eq(storeSeckill.id, 1701)));
  const combinationFields = (fields: Partial<typeof storeCombination.$inferInsert>) => fixtureChange('store_combination', 1801, fields, () => f.db.update(storeCombination).set(fields).where(eq(storeCombination.id, 1801)));
  const bargainFields = (fields: Partial<typeof storeBargain.$inferInsert>) => fixtureChange('store_bargain', 1901, fields, () => f.db.update(storeBargain).set(fields).where(eq(storeBargain.id, 1901)));
  const parentFields = (fields: Partial<typeof storeActivity.$inferInsert>) => fixtureChange('store_activity', 1501, fields, () => f.db.update(storeActivity).set(fields).where(eq(storeActivity.id, 1501)));
  const slotFields = (fields: Partial<typeof storeSeckillTime.$inferInsert>) => fixtureChange('store_seckill_time', 501, fields, () => f.db.update(storeSeckillTime).set(fields).where(eq(storeSeckillTime.id, 501)));
  const labelFields = (fields: Partial<typeof storeProductLabel.$inferInsert>) => fixtureChange('store_product_label', 704, fields, () => f.db.update(storeProductLabel).set(fields).where(eq(storeProductLabel.id, 704)));
  const navigation = (productId: number, kind = 'product', id: number | null = productId, endsAt: string | null = null) => ({ version: 1, product_id: productId, kind, id, ends_at: endsAt });
  const seckillNavigation = () => navigation(602, 'seckill', 1701, new Date((f.shanghaiDay + 86400) * 1000).toISOString());
  async function currentActivity(id = 602) { const body = await read(`/api/products?ids=${id}&page=1&limit=1`); expect(body.data.list).toHaveLength(1); return body.data.list[0].diy_navigation; }
  it('reads real home and micro schemas containing two independent instances of all eight commerce families', async () => {
    for (const id of [0, 2]) {
      expect((await read(`/api/diy/diy_version/${id}`, 0)).data).toEqual({ version: 'diy-commerce-1' });
      const page = (await read(`/api/diy/get_diy/${id}`, 0)).data;
      expect(page.value).toEqual(f.blocks);
      expect(page.value.filter((row: DiyStateRow) => DIY_COMMERCE_FAMILIES.includes(row.name)).map((row: DiyStateRow) => [row.name, row.timestamp, row.styleConfig.tabVal]))
        .toEqual(DIY_COMMERCE_FAMILIES.flatMap((name, i) => [[name, 301 + 2 * i, 0], [name, 302 + 2 * i, 1]]));
    }
  });
  it('reads exact real promotion ids, preserves zero money and sales+ficti, and isolates each actor cart quantity', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/products?ids=601,611,612&page=1&limit=2', viewer)).data;
      expect(data.count).toBe(2); expect(data.list.map((row: DiyStateRow) => row.id)).toEqual([601, 611]);
      expect(data.list[0]).toMatchObject({ id: 601, store_name: '真实促销零价商品601', price: '0.00', sales: 10, unit_name: '件', cart_num: viewer === 11 ? 2 : viewer === 22 ? 4 : 0, cart_button: 1 });
      expect(data.list[1]).toMatchObject({ id: 611, price: '9.50', sales: 6, cart_num: 0 });
    }
  });
  it('reads a real category promotion tab without keyword-search history or hidden products', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/products?cate_id=701&page=1&limit=1', viewer)).data;
      expect(data.count).toBe(2); expect(data.list.map((row: DiyStateRow) => row.id)).toEqual([601]);
    }
  });
  it('filters the real brand scope before pagination for every actor and excludes other and hidden products', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/products?brand_id=703&page=1&limit=2', viewer)).data;
      expect(data.count).toBe(1); expect(data.list.map((row: DiyStateRow) => row.id)).toEqual([601]);
      expect(data.list[0]).toMatchObject({ brand_name: '真实商城品牌', cart_num: viewer === 11 ? 2 : viewer === 22 ? 4 : 0 });
    }
  });
  it('forwards real label scope through the public controller and retains exact filtered count, labels and actor cart material', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/products?store_label_id=704&page=1&limit=2', viewer)).data;
      expect(data.count).toBe(1); expect(data.list.map((row: DiyStateRow) => row.id)).toEqual([601]);
      expect(data.list[0]).toMatchObject({ store_label: [{ id: 704, label_name: '真实商城标签' }], cart_num: viewer === 11 ? 2 : viewer === 22 ? 4 : 0 });
    }
  });
  it('returns only requested visible label fields and never signs a label icon from a foreign attachment owner', async () => {
    const readLabels = async () => (await read('/api/products?ids=601&page=1&limit=1')).data.list[0].store_label;
    const base = await readLabels(); expect(base).toEqual([{ id: 704, label_name: '真实商城标签', style_type: 1, color: '#375a7f', bg_color: '#eaf0f7', border_color: '#7698ba', icon: '' }]);
    try {
      await labelFields({ isShow: 0 }); expect(await readLabels()).toEqual([]); await labelFields({ isShow: 1 });
      await labelFields({ status: 0 }); expect(await readLabels()).toEqual([]); await labelFields({ status: 1 });
      // Real uploaded user11 media is not a platform label attachment; no R2
      // operation or new signature can turn this persisted reference public.
      await labelFields({ icon: f.image.url, type: 0, relationId: 0 }); expect(await readLabels()).toEqual(base);
    } finally { await labelFields({ isShow: 1, status: 1, icon: '', type: 0, relationId: 0 }); }
  });
  it('uses identical bounded label projection for ordinary, presale and recommendation catalogue paths', async () => {
    const original = (await f.snapshot()).store_product.find(row => row.id === 605)!.store_label_id;
    try {
      await fixtureChange('store_product', 605, { storeLabelId: '704,705,704,706' }, () => f.db.update(storeProduct).set({ storeLabelId: '704,705,704,706' }).where(eq(storeProduct.id, 605)));
      for (const viewer of viewers) {
        const ordinary = (await read('/api/products?ids=601&page=1&limit=1', viewer)).data.list[0].store_label;
        const presale = (await read('/api/presale/list?time_type=2&page=1&limit=3', viewer)).data.list[0].store_label;
        const recommendation = (await read('/api/product/rank/1?page=1&limit=100', viewer)).data.find((row: DiyStateRow) => row.id === 601).store_label;
        expect(presale).toEqual(ordinary); expect(recommendation).toEqual(ordinary); expect(ordinary.map((row: DiyStateRow) => row.id)).toEqual([704]);
      }
    } finally { await fixtureChange('store_product', 605, { storeLabelId: original }, () => f.db.update(storeProduct).set({ storeLabelId: original }).where(eq(storeProduct.id, 605))); }
  });
  it('projects only real activity identities while preserving raw priority and presale precedence for all viewers', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/products?ids=602,603,604,605&page=1&limit=4', viewer)).data;
      expect(data.list.map((row: DiyStateRow) => [row.id, row.diy_navigation])).toEqual([[602, seckillNavigation()], [603, navigation(603, 'combination', 1801)], [604, navigation(604, 'bargain', 1901)], [605, navigation(605, 'presale')]]);
      expect(data.list.slice(0, 3).map((row: DiyStateRow) => row.activity)).toEqual(['1,2,3', '3,2,1', '2,1,3']);
    }
  });
  it('retains existing recommendation_target and raw activity through both actual catalogue decorators', async () => {
    const rows = (await read('/api/product/rank/1?page=1&limit=100')).data;
    const product = rows.find((row: DiyStateRow) => row.id === 602);
    expect(product).toMatchObject({ activity: '1,2,3', diy_navigation: seckillNavigation(),
      recommendation_target: { version: 1, product_id: 602, kind: 'seckill', id: 1701 } });
  });
  it('selects configured family priority and falls through unavailable families using actual associated activity ids', async () => {
    try {
      await combinationFields({ productId: 602 }); await productActivity('3,1,2');
      expect(await currentActivity()).toEqual(navigation(602, 'combination', 1801));
      await productActivity('1,3'); expect(await currentActivity()).toEqual(seckillNavigation());
      await seckillFields({ status: 0 }); expect(await currentActivity()).toEqual(navigation(602, 'combination', 1801));
    } finally { await combinationFields({ productId: 603 }); await productActivity('1,2,3'); await seckillFields({ status: 1 }); }
  });
  it('keeps ordinary, empty, duplicate and damaged priority configurations from inventing an activity id', async () => {
    try { for (const value of ['0,1,2,3', '', '1,bad', '1,1', '9', '{"type":1,"id":1701}']) {
      await productActivity(value); expect(await currentActivity()).toEqual(['0,1,2,3', ''].includes(value) ? navigation(602) : navigation(602, 'unavailable', null));
    } }
    finally { await productActivity('1,2,3'); }
  });
  it('rejects disabled, hidden, deleted and foreign-owner seckill associations without changing them during GETs', async () => {
    try {
      for (const patch of [{ status: 0 }, { isShow: 0 }, { isDel: 1 }, { type: 2, relationId: 22 }, { productType: 1 }]) {
        await seckillFields(patch); expect(await currentActivity()).toEqual(navigation(602));
        await seckillFields({ status: 1, isShow: 1, isDel: 0, type: 0, relationId: 0, productType: 0 });
      }
    } finally { await seckillFields({ status: 1, isShow: 1, isDel: 0, type: 0, relationId: 0, productType: 0 }); }
  });
  it('reuses the real seckill parent and slot admission instead of accepting a bare activity row', async () => {
    try {
      await parentFields({ status: 0 }); expect(await currentActivity()).toEqual(navigation(602)); await parentFields({ status: 1 });
      await parentFields({ timeId: '502' }); expect(await currentActivity()).toEqual(navigation(602)); await parentFields({ timeId: '501,502' });
      await slotFields({ status: 0 }); expect(await currentActivity()).toEqual(navigation(602)); await slotFields({ status: 1 });
      await slotFields({ startTime: '12:00', endTime: '14:00' }); expect(await currentActivity()).toEqual(navigation(602));
      await slotFields({ startTime: '25:00', endTime: '24:00' }); expect(await currentActivity()).toEqual(navigation(602));
    } finally { await parentFields({ status: 1, timeId: '501,502' }); await slotFields({ status: 1, startTime: '00:00', endTime: '24:00' }); }
    expect(await currentActivity()).toEqual(seckillNavigation());
  });
  it('keeps future/expired/foreign-owner combination and bargain associations out of navigation previews', async () => {
    try {
      await combinationFields({ startTime: new Date(f.now.getTime() + 1000) }); expect(await currentActivity(603)).toEqual(navigation(603)); await combinationFields({ startTime: null });
      await combinationFields({ type: 2, relationId: 22 }); expect(await currentActivity(603)).toEqual(navigation(603)); await combinationFields({ type: 0, relationId: 0 });
      await bargainFields({ stopTime: new Date(f.now.getTime() - 1000) }); expect(await currentActivity(604)).toEqual(navigation(604)); await bargainFields({ stopTime: null });
      await bargainFields({ type: 2, relationId: 22 }); expect(await currentActivity(604)).toEqual(navigation(604));
    } finally { await combinationFields({ startTime: null, type: 0, relationId: 0 }); await bargainFields({ stopTime: null, type: 0, relationId: 0 }); }
  });
  it('carries exact versioned expiry and withdraws the candidate after its real stop time with readonly GETs', async () => {
    try {
      await combinationFields({ stopTime: new Date(f.now.getTime() + 1000) });
      expect(await currentActivity(603)).toEqual(navigation(603, 'combination', 1801, new Date(f.now.getTime() + 1001).toISOString()));
      vi.setSystemTime(new Date(f.now.getTime() + 1001)); expect(await currentActivity(603)).toEqual(navigation(603));
    } finally { vi.setSystemTime(f.now); await combinationFields({ stopTime: null }); }
  });
  it('projects real Shanghai seckill slots and keeps disabled slots out without changing schedules', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/seckill/index', viewer)).data;
      expect(data.seckillTimeIndex).toBe(0);
      expect(data.seckillTime.map((row: DiyStateRow) => [row.id, row.start_time, row.end_time, row.status, row.state]))
        .toEqual([[501, '00:00', '24:00', 1, '疯抢中'], [502, '12:00', '14:00', 2, '即将开始']]);
    }
  });
  it('keeps seckill activity and product ids distinct and uses quota rather than unrelated stock', async () => {
    for (const viewer of viewers) {
      expect((await read('/api/seckill/list/501?page=1&limit=3', viewer)).data).toMatchObject([
        { id: 1701, product_id: 602, activity_id: 1501, title: '真实秒杀1701', price: 0, ot_price: 12, quota: 3, quota_show: 10, stock: 3, percent: 70 },
      ]);
      const upcoming = (await read('/api/seckill/list/502?page=1&limit=3', viewer)).data;
      expect(upcoming).toHaveLength(1); expect(upcoming[0]).toMatchObject({ id: 1702, product_id: 611, price: 4, stock: 0, percent: 100 });
    }
  });
  it('reads real combination price, people and completed group count while excluding hidden rows', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/combination/list?page=1&limit=3', viewer)).data;
      expect(data).toHaveLength(1); expect(data[0]).toMatchObject({ id: 1801, product_id: 603, title: '真实三人拼团1801', price: 0, product_price: 15, people: 3, pink_count: 6, stock: 4 });
    }
  });
  it('reads real successful pink participants and avatars while excluding refunds, guests and unfinished groups', async () => {
    for (const viewer of viewers) expect((await read('/api/pink', viewer)).data).toEqual({ pink_count: 2, avatars: ['/static/logo.png', '/static/logo.png'] });
  });
  it('reads real bargain floor, sales and participants without starting or helping a bargain', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/bargain/list?page=1&limit=3', viewer)).data;
      expect(data).toHaveLength(1); expect(data[0]).toMatchObject({ id: 1901, product_id: 604, title: '真实砍价标题1901', price: 20, min_price: 0, ot_price: 30, people: 2, sales: 2, stock: 8 });
    }
  });
  it('derives bargain people from exact type1 help evidence rather than configured quota or other activities', async () => {
    const before = await f.snapshot(); expect(before.store_bargain.find(row => row.id === 1901)!.people).toBe(6);
    expect(before.store_bargain_user_help.filter(row => row.bargain_id === 1901 && row.type === 1)).toHaveLength(2);
    expect((await read('/api/bargain/list?page=1&limit=1')).data[0].people).toBe(2);
    expect((await read('/api/bargain/list?page=2&limit=1')).data).toEqual([]); expect(await f.snapshot()).toEqual(before);
  });
  it('reads real current presale material and registered product identity with exact readonly snapshots', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/presale/list?time_type=2&page=1&limit=3', viewer)).data;
      expect(data.count).toBe(1); expect(data.list).toHaveLength(1);
      expect(data.list[0]).toMatchObject({ id: 605, store_name: '真实预售商品605', price: '8.50', is_presale_product: 1, presale_pay_status: 2 });
      expect((await read('/api/presale/list?time_type=1&page=1&limit=3', viewer)).data).toEqual({ list: [], count: 0 });
    }
  });
  it('reads real zero integral plus cash material without creating an exchange or a cart', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/store_integral/list?page=1&limit=3', viewer)).data;
      expect(data).toHaveLength(1); expect(data[0]).toMatchObject({ id: 2001, product_id: 606, title: '真实零积分商品2001', integral: 0, price: 1.5, sales: 4, stock: 7 });
    }
  });
  it('reads real cash/discount coupons with account-scoped used projection before any explicit claims', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/v2/coupons?page=1&limit=3', viewer)).data;
      expect(data.list.map((row: DiyStateRow) => row.id)).toEqual([901, 902, 903]);
      expect(data.list[0]).toMatchObject({ id: 901, type: 0, coupon_type: 1, coupon_price: 0, is_use: false });
      expect(data.list[1]).toMatchObject({ id: 902, type: 0, coupon_type: 2, coupon_price: 90, is_use: viewer === 22 });
      if (viewer === 22) expect(data.list[1].used).toMatchObject({ uid: 22, cid: 902 });
      else expect(data.list[1].used).toBeUndefined();
    }
  });
  it('reads real local and remote live identities, all three statuses, anchor and goods without provider access', async () => {
    for (const viewer of viewers) {
      const data = (await read('/api/wechat/live?page=1&limit=3', viewer)).data;
      expect(data.map((row: DiyStateRow) => [row.id, row.room_id, row.live_status])).toEqual([[2101, 3101, 101], [2102, 3102, 102], [2103, 3103, 103]]);
      expect(data[0]).toMatchObject({ anchor_name: '真实直播主播', anchor_img: '/static/logo.png', goods: [{ id: 2301, goods_id: 3301, product_id: 601, price: '0.00' }] });
    }
  });
  it('rejects guest manual claims before validation or writes through the real forced-auth route', async () => {
    await reject({ couponId: 901 }, 0, 410000, '请登录'); await reject({ id: 901, uid: 11 }, 0, 410000, '请登录');
  });
  it('rejects missing, noncanonical, noninteger, out-of-range and conflicting aliases before any row or sequence change', async () => {
    const values: unknown[] = [{}, null, [], true, 17, '901', { id: null }, { couponId: null }, { id: 0 }, { couponId: -1 },
      { id: 1.5 }, { couponId: true }, { id: {} }, { couponId: [] }, { id: '0901' }, { couponId: '901.0' }, { id: ' 901' },
      { couponId: '+901' }, { id: '9e2' }, { couponId: 2147483648 }, { id: Number.MAX_SAFE_INTEGER + 1 },
      { id: 901, couponId: 902 }, { id: 901, couponId: '' }, { id: 0, couponId: 901 }, { id: 'bad', couponId: 901 }];
    for (const body of values) await reject(body, 11, 400, '参数错误');
    await reject({}, 11, 400, '参数错误', '{invalid-json');
  });
  it('retains id claims, ignores a forged uid, inserts only one owned coupon and evidence, and rejects duplicates without writes', async () => {
    await claim({ id: 901, uid: 22 }, 11, 901);
    await reject({ id: 901 }, 11, 400, '每人限领 1 张');
    // The other signed actor has its own quota on the same issue.
    await claim({ id: 901, uid: 11 }, 22, 901);
    await reject({ couponId: 901 }, 22, 400, '每人限领 1 张');
  });
  it('accepts the exact PHP couponId alias through the real controller and transaction', async () => {
    await claim({ couponId: 903 }, 11, 903); await reject({ couponId: 903 }, 11, 400, '每人限领 1 张');
  });
  it('accepts equal id/couponId aliases after independently validating both canonical values', async () => {
    await claim({ id: 904, couponId: '904' }, 11, 904); await reject({ id: '904', couponId: 904 }, 11, 400, '每人限领 1 张');
  });
  it('accepts canonical decimal couponId strings while retaining the authenticated actor', async () => {
    await claim({ couponId: '907', uid: 11 }, 22, 907); await claim({ id: '907', uid: 22 }, 11, 907);
  });
  it('preserves a positive configured receive limit and never interprets alias support as unlimited claims', async () => {
    await claim({ couponId: 902 }, 22, 902); await reject({ id: 902 }, 22, 400, '每人限领 2 张');
  });
  it('keeps newcomer, gift, member, hidden-category, stopped, exhausted and nonexistent manual claims closed', async () => {
    for (const viewer of [11, 22] as const) for (const id of [911, 912, 913, 914]) await reject({ couponId: id }, viewer, 400, '该优惠券不允许手动领取');
    await reject({ couponId: 915 }, 11, 404, '优惠券不存在或已停发');
    await reject({ couponId: 916 }, 11, 400, '优惠券已领完');
    await reject({ couponId: 999999 }, 11, 404, '优惠券不存在或已停发');
  });
  it('retains zero-limit historical evidence even when no owned coupon remains', async () => {
    await reject({ couponId: 908 }, 11, 400, '每人限领 1 张');
    await claim({ couponId: 908 }, 22, 908);
  });
  it('recovers an unknown client outcome only by rereading real coupon state without replaying the POST', async () => {
    const before = await f.snapshot(), beforeStorage = storage();
    // The response is deliberately not exposed to a client state machine. This
    // native case proves the server receipt and recovery GET, not network loss.
    const ignored = await request('/api/coupon/receive', 11, { couponId: 905 }); expect(ignored.status).toBe(200);
    const after = await f.snapshot(), inserted = after.store_coupon_user.filter(row => !before.store_coupon_user.some(old => old.id === row.id));
    expect(inserted).toHaveLength(1); claimReceipt(before, after, 11, 905, inserted[0].id); expect(storage()).toEqual(beforeStorage);
    const mine = (await read('/api/v2/coupons?page=1&limit=20', 11)).data.list.find((row: DiyStateRow) => row.id === 905);
    const other = (await read('/api/v2/coupons?page=1&limit=20', 22)).data.list.find((row: DiyStateRow) => row.id === 905);
    expect(mine.is_use).toBe(true); expect(mine.used).toMatchObject({ uid: 11, cid: 905 }); expect(other.is_use).toBe(false);
    expect(await f.snapshot()).toEqual(after);
  });
  it('serializes competing real HTTP actor claims on the last stock and records exactly one successful receipt', async () => {
    const before = await f.snapshot(), beforeStorage = storage();
    const responses = await Promise.all(([11, 22] as const).map(async viewer => {
      const res = await request('/api/coupon/receive', viewer, { couponId: 906 });
      expect(res.status).toBe(200); return { viewer, body: await res.json() as DiyStateRow };
    }));
    expect(responses.map(row => row.body.status).sort()).toEqual([200, 400]);
    const winner = responses.find(row => row.body.status === 200)!, loser = responses.find(row => row.body.status === 400)!;
    expect(loser.body.msg).toBe('优惠券已领完');
    claimReceipt(before, await f.snapshot(), winner.viewer, 906, winner.body.data.couponUserId); expect(storage()).toEqual(beforeStorage);
    await reject({ id: 906 }, loser.viewer, 400, '优惠券已领完');
  });
  it('uses the real fixture Admin schema transaction and version without changing commerce rows or sequences', async () => {
    const next = structuredClone(f.blocks); next[1] = { ...next[1], numberConfig: { val: 1 }, titleTxtConfig: { value: '真实更新后的促销' } };
    const receipt = await f.saveSchema(2, next); expect(receipt.response.status).toBe(200); expect(receipt.body.status).toBe(200);
    const updated = receipt.body.data, want = structuredClone(receipt.before); expect(updated.version).not.toBe('diy-commerce-1');
    want.system_dise = want.system_dise.map(row => row.id === 2 ? { ...row, value: JSON.stringify(next), version: updated.version, update_time: updated.update_time } : row);
    expect(receipt.after).toEqual(sortedDiyState(want));
    expect((await read('/api/diy/get_diy/2', 0)).data.value).toEqual(next);
    expect((await read('/api/diy/get_diy/0', 0)).data.value).toEqual(f.blocks);
  });
  it('records the actual station boundary: DIY schema closes while legacy marketing reads retain their existing route policy', async () => {
    async function station(value: string) {
      const receipt = await f.setConfig('station_open', value), want = structuredClone(receipt.before);
      want.system_config = want.system_config.map(row => row.menu_name === 'station_open' && row.is_store === 0 ? { ...row, value } : row);
      expect(receipt.after).toEqual(sortedDiyState(want));
    }
    try {
      await station('0'); expect((await read('/api/diy/diy_version/0', 0, 410010)).msg).toBe('站点升级中，请稍候访问');
      expect((await read('/api/diy/get_diy/0', 11, 410010)).msg).toBe('站点升级中，请稍候访问');
      expect((await read('/api/seckill/list/501?page=1&limit=3', 11)).data).toHaveLength(1);
      expect((await read('/api/combination/list?page=1&limit=3', 0)).data).toHaveLength(1);
    } finally { await station('1'); }
  });
});
