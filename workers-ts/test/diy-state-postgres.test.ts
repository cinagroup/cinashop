import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemUserLevel } from '@/models/schema';
import { diyStateFixture, DIY_STATE_NOW, sortedDiyState, type DiyStateRow, type DiyStateViewer } from './helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned DIY state SQL'); return wiring.container;
} }));
const viewers = [0, 11, 22] as const;
const diyRoutes = ['/api/diy/get_diy/0', '/api/diy/diy_version/0', '/api/diy/user_info', '/api/diy/video_list?page=1&limit=2',
  '/api/diy/newcomer_list?page=1&limit=10', '/api/diy/product_rank?limit=3', '/api/diy/sign', '/api/diy/get_suspended'];

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native DIY state widgets real read consumers', () => {
  let f: Awaited<ReturnType<typeof diyStateFixture>>; const app = createApp();
  beforeAll(async () => { vi.setSystemTime(DIY_STATE_NOW); f = await diyStateFixture(DIY_STATE_NOW); wiring.container = f.container;
    expect(f.tables).toHaveLength(35); expect(f.sequences).toHaveLength(34); expect(f.seedStorage.puts).toBe(1);
    expect(f.seedStorage.deletes).toBe(0); expect(f.seedStorage.keys).toHaveLength(1);
  }, 30_000);
  afterAll(async () => { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }, 30_000);
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned DIY state fixture forbids provider I/O')); });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  const storage = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, keys: [...f.objects.keys()] });
  async function request(path: string, viewer: DiyStateViewer = 11, bearer?: string) {
    const waits: Promise<unknown>[] = [];
    const res = await app.fetch(new Request(`http://localhost${path}`, { headers: bearer ? { Authorization: `Bearer ${bearer}` }
      : viewer ? { Authorization: `Bearer ${viewer === 11 ? f.token : f.otherToken}` } : {} }), f.env,
    { waitUntil: work => { waits.push(work); }, passThroughOnException() {} } as ExecutionContext);
    await Promise.all(waits); return res;
  }
  async function read(path: string, viewer: DiyStateViewer = 11, status = 200, bearer?: string) {
    const before = await f.snapshot(), beforeStorage = storage(), res = await request(path, viewer, bearer);
    expect(res.status).toBe(200); const body = await res.json() as DiyStateRow; expect(body.status).toBe(status);
    if (path.startsWith('/api/diy/')) expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(await f.snapshot()).toEqual(before); expect(storage()).toEqual(beforeStorage); return body;
  }
  async function config(key: Parameters<typeof f.setConfig>[0], value: string) {
    const receipt = await f.setConfig(key, value), want = structuredClone(receipt.before);
    expect(want.system_config.filter(row => row.menu_name === key && row.is_store === 0)).toHaveLength(1);
    want.system_config = want.system_config.map(row => row.menu_name === key && row.is_store === 0 ? { ...row, value } : row);
    expect(receipt.after).toEqual(sortedDiyState(want)); return receipt;
  }
  async function changeLevel(fields: Partial<typeof systemUserLevel.$inferInsert>) {
    const before = await f.snapshot(); await f.db.update(systemUserLevel).set(fields).where(eq(systemUserLevel.id, 1));
    const after = await f.snapshot(), want = structuredClone(before);
    const names: Record<string, string> = { isShow: 'is_show', isDel: 'is_del' };
    want.system_user_level = want.system_user_level.map(row => row.id === 1 ? { ...row, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [names[key] ?? key, value])) } : row);
    expect(after).toEqual(sortedDiyState(want));
  }
  it('reads actual home0 and micro2 with eight independent PHP-authored state blocks and retained other content', async () => {
    for (const id of [0, 2]) {
      expect((await read(`/api/diy/diy_version/${id}`, 0)).data).toEqual({ version: 'diy-state-1' });
      const page = (await read(`/api/diy/get_diy/${id}`, 0)).data;
      expect(page.value).toEqual(f.blocks); expect(page.is_show).toBe(1);
      expect(page.value.filter((r: DiyStateRow) => ['userInfor', 'newVip', 'signIn', 'ranking'].includes(r.name)).map((r: DiyStateRow) => [r.name, r.timestamp, r.styleConfig.tabVal]))
        .toEqual(['userInfor', 'newVip', 'signIn', 'ranking'].flatMap((name, i) => [[name, 101 + 2 * i, 0], [name, 102 + 2 * i, 1]]));
    }
  });
  it('keeps explicit missing-page fallback separate from its null version instead of inventing cache identity', async () => {
    expect((await read('/api/diy/diy_version/999', 0)).data).toEqual({ version: null });
    const fallback = (await read('/api/diy/get_diy/999', 0)).data;
    expect(fallback.title).toBe('实际数据组件首页'); expect(fallback.value).toEqual(f.blocks);
  });
  it('returns guest[] and exact current-account member counters without materializing personal records', async () => {
    expect((await read('/api/diy/user_info', 0)).data).toEqual([]);
    expect((await read('/api/diy/user_info', 11)).data).toMatchObject({ uid: 11, nickname: '零值会员11', now_money: '0.00', integral: 0, exp: '0.00', level: 1, vip_name: '蓝色会员', next_exp: 200, coupon_num: 2, collectCount: 1, visit_num: 0 });
    expect((await read('/api/diy/user_info', 22)).data).toMatchObject({ uid: 22, nickname: '另一会员22', now_money: '88.00', integral: 50, exp: '50.00', level: 2, vip_name: '绿色会员', next_exp: 200, coupon_num: 0, collectCount: 1, visit_num: 1 });
  });
  it('preserves guest issue numbers, logged coupon accessors and store_newcomer identity without claims', async () => {
    const guest = (await read('/api/diy/newcomer_list?page=1&limit=10', 0)).data;
    expect(guest.newcomer_integral).toBe(0); expect(guest.newcomer_coupon.map((r: DiyStateRow) => [r.id, r.coupon_type, r.type, r.coupon_price, r.status, r.uid]))
      .toEqual([[82, 2, 2, '90.00', 1, undefined], [81, 1, 0, '0.00', 1, undefined]]);
    const own = (await read('/api/diy/newcomer_list?page=1&limit=10', 11)).data;
    expect(own.newcomer_coupon.map((r: DiyStateRow) => [r.id, r.uid, r.coupon_type, r.applicable_type, r.status]))
      .toEqual([[92, 11, 2, 2, '未使用'], [91, 11, 1, 0, '未使用']]);
    expect(own.newcomer_products).toMatchObject([{ id: 71, product_id: 301, store_name: '榜单真实商品301', price: '0.00' }]);
    expect(own.newcomer_products[0].id).not.toBe(own.newcomer_products[0].product_id);
    expect((await read('/api/diy/newcomer_list?page=1&limit=10', 22)).data).toEqual({ newcomer_products: [], newcomer_integral: [], newcomer_coupon: [] });
  });
  it('projects Shanghai Monday-to-Sunday calendar, account-specific sign marks and first real continuous reward', async () => {
    for (const viewer of viewers) {
      const state = (await read('/api/diy/sign', viewer)).data;
      expect(state.signList).toHaveLength(1); expect(state.signList[0].map((d: DiyStateRow) => d.day)).toEqual(['10/19', '10/20', '10/21', '10/22', '10/23', '10/24', '10/25']);
      expect(state.signList[0].filter((d: DiyStateRow) => d.sign_day).map((d: DiyStateRow) => d.day)).toEqual(['10/21']);
      expect(state.signList[0].filter((d: DiyStateRow) => d.is_sign).map((d: DiyStateRow) => d.day)).toEqual(viewer === 11 ? ['10/19'] : viewer === 22 ? ['10/21'] : []);
      expect(state.signList[0].every((d: DiyStateRow) => d.type === 2 && d.point === 0)).toBe(true);
      expect(state.checkSign).toBe(viewer === 22); expect(state.sign_give_point).toBe(0); expect(state.signStatus).toBe(1);
      expect(state.nextContinuousSignRewardList).toEqual([{ id: 1, type: 0, days: 7, point: 0, exp: 3 }]);
    }
  });
  it('takes fresh sign configuration and keeps rule changes separate from the read-only preview', async () => {
    try { await config('sign_give_point', '5'); f.cache.set('cfg_sign_give_point', '999'); const state = (await read('/api/diy/sign')).data;
      expect(state.sign_give_point).toBe(5); expect(state.signList[0].every((d: DiyStateRow) => d.type === 1 && d.point === 5)).toBe(true);
    } finally { await config('sign_give_point', '0'); }
  });
  it('reads three real independently ordered public ranks for every viewer and excludes lifecycle or typed-owner bystanders', async () => {
    for (const viewer of viewers) {
      const rank = (await read('/api/diy/product_rank?limit=3', viewer)).data;
      expect(rank.sales.map((r: DiyStateRow) => r.id)).toEqual([301, 302, 303]);
      expect(rank.star.map((r: DiyStateRow) => r.id)).toEqual([302, 303, 301]);
      expect(rank.collect.map((r: DiyStateRow) => r.id)).toEqual([303, 301, 302]);
      expect(rank.sales[0]).toMatchObject({ price: '0.00', product_id: 301, store_name: '榜单真实商品301' });
    }
  });
  it('adds minimal real grade/color aliases while retaining all four existing camelCase fields', async () => {
    for (const viewer of [11, 22] as const) {
      const state = (await read('/api/user/level/info', viewer)).data;
      expect(Object.keys(state).sort()).toEqual(['currentExp', 'level', 'level_info', 'level_list', 'nextExpNeed', 'nextLevel']);
      expect(state.level_info).toMatchObject({ id: viewer === 11 ? 1 : 2, grade: viewer === 11 ? 1 : 2, vip: true });
      expect(state.level_list.map((r: DiyStateRow) => [r.id, r.grade, r.color])).toEqual([[1, 1, '#375a7f'], [2, 2, '#246e49']]);
      expect(state.currentExp).toBe(viewer === 11 ? 0 : 50);
    }
  });
  it('uses fresh global member switch over stale KV and restores aliases without activation writes', async () => {
    try { await config('member_func_status', '0'); f.cache.set('cfg_member_func_status', '1');
      const state = (await read('/api/user/level/info')).data; expect(state.level_info).toEqual([]); expect(state.level_list).toEqual([]); expect(state.currentExp).toBe(0);
    } finally { await config('member_func_status', '1'); }
    f.cache.set('cfg_member_func_status', '0'); expect((await read('/api/user/level/info')).data.level_info).toMatchObject({ id: 1, grade: 1 });
  });
  it('rejects hidden/deleted current grade aliases even when legacy level KV pretends they are active', async () => {
    try {
      f.cache.set('level_1', JSON.stringify({ id: 1, grade: 1, color: '#ffffff', name: '过期缓存' }));
      await changeLevel({ isShow: 0 }); let state = (await read('/api/user/level/info')).data;
      expect(state.level).toBe(null); expect(state.level_info).toEqual([]); expect(state.level_list).toEqual([]);
      await changeLevel({ isShow: 1, isDel: 1 }); state = (await read('/api/user/level/info')).data;
      expect(state.level).toBe(null); expect(state.level_info).toEqual([]); expect(state.level_list).toEqual([]);
    } finally { await changeLevel({ isShow: 1, isDel: 0 }); }
  });
  it('rejects all eight DIY routes station-first with exact HTTP200 code/message/no-store and no analytics', async () => {
    try { await config('station_open', '0'); f.cache.set('cfg_station_open', '1');
      for (const viewer of viewers) for (const path of diyRoutes) {
        const body = await read(path, viewer, 410010); expect(body.msg).toBe('站点升级中，请稍候访问');
      }
      expect((await read('/api/diy/user_info', 0, 410010, 'malformed-fixture-token')).msg).toBe('站点升级中，请稍候访问');
    } finally { await config('station_open', '1'); }
  }, 30_000);
  it('retains the readonly suspended endpoint and signed community preview without crossing either data domain', async () => {
    for (const viewer of viewers) expect((await read('/api/diy/get_suspended', viewer)).data).toEqual({ is_show: 0, index: 1, shifting: 1, main_ago_image: '', main_after_image: '', button: [] });
    const community = (await read('/api/community/list?page=1&limit=1', 11)).data;
    expect(community).toMatchObject([{ id: 1, title: '实际社区预览', content: '独立社区域内容' }]);
    expect(community[0].image).toMatch(/^\/api\/assets\/\d+\?expires=\d+&signature=/u);
    const before = await f.snapshot(), beforeStorage = storage(), image = await request(community[0].image, 0);
    expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/png'); expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);
    expect(await f.snapshot()).toEqual(before); expect(storage()).toEqual(beforeStorage);
  });
  it('records only separately requested short-video plays with exact rows/counters/sequence receipt for each viewer', async () => {
    for (const viewer of viewers) {
      const before = await f.snapshot(), beforeStorage = storage(), res = await request('/api/diy/video_list?page=1&limit=2', viewer);
      expect(res.status).toBe(200); expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      const body = await res.json() as DiyStateRow; expect(body.status).toBe(200);
      expect(body.data.map((r: DiyStateRow) => [r.id, r.desc])).toEqual([[1, '独立旧视频一'], [2, '独立旧视频二']]);
      const after = await f.snapshot(), want = structuredClone(before), inserted = after.user_relation.filter(row => !before.user_relation.some(previous => previous.id === row.id));
      expect(inserted).toHaveLength(2);
      for (const row of inserted) expect(row).toEqual({ id: row.id, uid: viewer, relation_id: row.relation_id, type: 'play', category: 'video', add_time: f.seconds });
      expect(inserted.map(row => row.relation_id).sort()).toEqual([1, 2]);
      const seq = want.__sequences.find(row => row.name === 'user_relation_id_seq')!, start = Number(seq.last);
      expect(inserted.map(row => row.id).sort((a, b) => a - b)).toEqual([start + 1, start + 2]); seq.last = String(start + 2); seq.called = true;
      want.user_relation.push(...inserted); want.video = want.video.map(row => row.id === 1 || row.id === 2 ? { ...row, play_num: row.play_num + 1 } : row);
      expect(after).toEqual(sortedDiyState(want)); expect(storage()).toEqual(beforeStorage);
    }
  });
  it('uses the real Admin parser/catalog lock/version transaction for a fixture schema update then reads the new identity', async () => {
    const next: DiyStateRow[] = structuredClone(f.blocks); next[0] = { ...next[0], titleConfig: { value: '实际保存后的商城标题' } };
    const receipt = await f.saveSchema(2, next); expect(receipt.response.status).toBe(200); expect(receipt.body.status).toBe(200);
    const updated = receipt.body.data, want = structuredClone(receipt.before); expect(updated.id).toBe(2); expect(updated.version).not.toBe('diy-state-1');
    want.system_dise = want.system_dise.map(row => row.id === 2 ? { ...row, value: JSON.stringify(next), version: updated.version, update_time: updated.update_time } : row);
    expect(receipt.after).toEqual(sortedDiyState(want));
    expect((await read('/api/diy/diy_version/2', 0)).data).toEqual({ version: updated.version });
    expect((await read('/api/diy/get_diy/2', 0)).data.value).toEqual(next);
    expect((await read('/api/diy/get_diy/0', 0)).data.value).toEqual(f.blocks);
  });
});
