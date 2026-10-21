import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { diyStateFixture, sortedDiyState, stableDiyState, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned DIY state Browser SQL'); return wiring.container;
} }));
const digest = (value: unknown) => createHash('sha256').update(stableDiyState(value)).digest('hex');
async function bytes(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0;
  for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; expect(size).toBeLessThan(200_000); chunks.push(chunk); } return Buffer.concat(chunks);
}
it('actual H5 home/micro DIY state widgets remain independent and read-only through closure and recovery', async () => {
  const f = await diyStateFixture(), app = createApp(); wiring.container = f.container;
  const root = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5'), origin = 'http://127.0.0.1:40769';
  const control = '/__diy_state/' + randomUUID(), prefix = '/tmp/cinashop-diy-state-browser-';
  const stages = ['homeFirst', 'homeRetry', 'memberRefresh', 'microInitial', 'schemaChanged', 'guestHome', 'account22', 'return11',
    'rankDestination', 'returnAfterRank', 'signDestination', 'returnAfterSign', 'offlineHome', 'onlineRecovered', 'stationClosed', 'closedRetry', 'reopened', 'finished'];
  const routes = { home: { uid: 11, route: '/pages/index/index', label: '账号11实际首页' }, micro: { uid: 11, route: '/pages/diy/detail?id=2', label: '账号11实际微页面' },
    guest: { uid: 0, route: '/pages/index/index', label: '游客实际首页' }, other: { uid: 22, route: '/pages/index/index', label: '账号22实际首页' } };
  const actions = [
    { stage: 'homeFirst', action: '点击账号11实际首页，等待103/104中恰一新人组件错误及其余7块完成；点375尺寸再checkpoint' },
    { stage: 'homeRetry', action: '按homeFirst结果的retry_selector只点实际失败新人组件重试；等待实际券和商品后点375/checkpoint' },
    { stage: 'memberRefresh', action: '只点101会员组件刷新内容；等待等级颜色后点375/checkpoint' },
    { stage: 'microInitial', action: '点击账号11实际微页面；等待8块与社区预览后点375/checkpoint' },
    { stage: 'schemaChanged', action: '点更新schema配置，再点账号11实际微页面；确认101只积分/优惠券、103无商品、107新标题；点375/checkpoint' },
    { stage: 'guestHome', action: '点游客实际首页；两个会员卡请点击登录、无会员请求；点375/checkpoint' },
    { stage: 'account22', action: '点账号22实际首页；会员50积分88余额绿色等级，新人无权益；点375/checkpoint' },
    { stage: 'return11', action: '点账号11实际首页；确认零值会员恢复；点375/checkpoint' },
    { stage: 'rankDestination', action: '真实点击107排行榜更多真实榜单，等待商品排行榜页面；禁止点击目的地商品；点375/checkpoint' },
    { stage: 'returnAfterRank', action: '点账号11实际首页返回；等待8块后点375/checkpoint' },
    { stage: 'signDestination', action: '真实点击105签到组件目的地按钮，等待每日签到页面；禁止点目的地签到；点375/checkpoint' },
    { stage: 'returnAfterSign', action: '点账号11实际首页返回；等待8块后点375/checkpoint' },
    { stage: 'offlineHome', action: '点仅一次version503控制，再点账号11实际首页；确认当前显示离线缓存及真实8块；点375/checkpoint' },
    { stage: 'onlineRecovered', action: '真实点离线提示的重新核实；等待提示消失与8块恢复；点375/checkpoint' },
    { stage: 'stationClosed', action: '点站点关闭控制，再只点101会员刷新；确认根站点升级提示且8块撤下；点375/checkpoint' },
    { stage: 'closedRetry', action: '真实点根重新加载首页，仍拒绝；点375/checkpoint' },
    { stage: 'reopened', action: '点站点开启控制，再真实点根重新加载首页；等待8块恢复；点375/checkpoint' },
    { stage: 'finished', action: '无业务操作，再点375/checkpoint结束' },
  ];
  const traces: Row[] = [], evidence: Row[] = [], configs: Row[] = [], controls: Row[] = [], staticPaths = new Set<string>();
  let newcomerFailed = false, offlineArmed = false, offlineFailed = false;
  let failedNewcomerKey: 103 | 104 | undefined;
  let done!: () => void, fail!: (error: Error) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned DIY state acceptance forbids provider I/O'));
  const send = (res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  const json = (res: ServerResponse, body: unknown, status = 200) => send(res, JSON.stringify(body), status, 'application/json');
  let pending = Promise.resolve(); function serial<T>(work: () => Promise<T>): Promise<T> { const next = pending.then(work); pending = next.then(() => {}, () => {}); return next; }
  try {
    expect(f.tables).toHaveLength(35); expect(f.sequences).toHaveLength(34);
    const initial = await f.snapshot(); let expected = initial;
    const storage = () => ({ objects: digest([...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: [...item.bytes] }))), puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length });
    const initialStorage = storage(); expect(initialStorage.puts).toBe(1); expect(initialStorage.deletes).toBe(0);
    const identity = (headers: Headers) => { const token = headers.get('Authori-zation') ?? headers.get('Authorization'); return token === `Bearer ${f.token}` ? 11 : token === `Bearer ${f.otherToken}` ? 22 : 0; };
    const protectedReads = ['/api/diy/user_info', '/api/user/level/info'];
    const realPaths = new Set(['/api/diy/get_diy/0', '/api/diy/get_diy/2', '/api/diy/diy_version/0', '/api/diy/diy_version/2', '/api/diy/user_info',
      '/api/diy/newcomer_list', '/api/diy/product_rank', '/api/diy/sign', '/api/diy/get_suspended', '/api/user/level/info', '/api/community/config', '/api/community/list', '/api/get_script']);
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) { return serial(async () => {
      expect(req.method ?? 'GET').toBe('GET'); expect(await bytes(req)).toHaveLength(0);
      expect(url.pathname).not.toMatch(/video_list|\/(?:detail|browse|share)\/|sign\/integral|coupon\/receive/u);
      expect(realPaths.has(url.pathname) || /^\/api\/assets\/\d+$/u.test(url.pathname)).toBe(true);
      const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const viewer = identity(headers); if (protectedReads.includes(url.pathname)) expect(viewer).toBeGreaterThan(0);
      if (url.pathname === '/api/diy/newcomer_list') { expect(url.searchParams.get('page')).toBe('1'); expect(url.searchParams.get('limit')).toBe('10'); }
      if (url.pathname === '/api/diy/product_rank') expect(url.searchParams.get('limit')).toBe('3');
      if (url.pathname === '/api/community/list') { expect(url.searchParams.get('page')).toBe('1'); expect(url.searchParams.get('limit')).toBe('1'); }
      const before = await f.snapshot(); expect(before).toEqual(expected); const waits: Promise<unknown>[] = [];
      const response = await app.fetch(new Request(url.href, { headers }), f.env, { waitUntil: work => { waits.push(work); }, passThroughOnException() {} } as ExecutionContext); await Promise.all(waits);
      expect([200, 206]).toContain(response.status); const raw = Buffer.from(await response.arrayBuffer()), payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
      if (payload) expect([200, 410010]).toContain(payload.status);
      if (url.pathname.startsWith('/api/diy/')) expect(response.headers.get('Cache-Control')).toContain('no-store');
      const after = await f.snapshot(); expect(after).toEqual(before); expect(storage()).toEqual(initialStorage); expected = after;
      const newcomerFailure = !newcomerFailed && url.pathname === '/api/diy/newcomer_list';
      const offlineFailure = offlineArmed && url.pathname === '/api/diy/diy_version/0';
      if (newcomerFailure) { expect(payload.status).toBe(200); newcomerFailed = true; }
      if (offlineFailure) { expect(payload.status).toBe(200); offlineArmed = false; offlineFailed = true; }
      traces.push({ path: url.pathname, query: url.search, viewer, synthetic: false, method: 'GET', business_write: false, status: payload?.status ?? response.status,
        browser_status: newcomerFailure || offlineFailure ? 503 : response.status, injected: newcomerFailure ? 'one-newcomer-read-503' : offlineFailure ? 'one-version-read-503-status410010' : null,
        snapshot: { before: digest(before), after: digest(after), unchanged: true, tables: 35, sequences: 34 } });
      if (newcomerFailure) return json(res, { status: 503, msg: '本地验收：此新人组件读取失败，请单独重试' }, 503);
      if (offlineFailure) return json(res, { status: 410010, msg: '本地验收：版本读取HTTP503，不能确定站点关闭' }, 503);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
    }); }
    const chrome: Row = { '/api/site_config': { site_name: 'DIY数据组件验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: 'DIY数据组件', synopsis: '', img: '' },
      '/api/products': { list: [], count: 0 }, '/api/category': [], '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' },
      '/api/v2/diy/color_change/color_change': {}, '/api/v2/diy/product_detail': {} };
    async function synthetic(req: IncomingMessage, res: ServerResponse, url: URL, value: unknown, scope: string) { return serial(async () => {
      expect(req.method).toBe('GET'); expect(await bytes(req)).toHaveLength(0); const before = await f.snapshot(); expect(before).toEqual(expected);
      const after = await f.snapshot(); expect(after).toEqual(before); expect(storage()).toEqual(initialStorage);
      traces.push({ path: url.pathname, query: url.search, synthetic: true, scope, method: 'GET', business_write: false, status: 200,
        snapshot: { before: digest(before), after: digest(after), unchanged: true, tables: 35, sequences: 34 } });
      json(res, { status: 200, msg: 'Synthetic unrelated/destination navigation chrome only', data: value });
    }); }
    async function configure(req: IncomingMessage, res: ServerResponse) { return serial(async () => {
      const input = JSON.parse((await bytes(req)).toString()), action = input.action; expect(input).toEqual({ action });
      expect(await f.snapshot()).toEqual(expected);
      if (action === 'schema') {
        expect(evidence.at(-1)?.stage).toBe('microInitial'); expect(configs).toHaveLength(0);
        const blocks = structuredClone(f.blocks) as Row[];
        blocks.find(row => row.timestamp === 101)!.checkboxInfo.type = [0, 1]; blocks.find(row => row.timestamp === 103)!.checkboxInfo.type = [0, 1];
        const rank = blocks.find(row => row.timestamp === 107)!; rank.titleConfig.tabVal = 1; rank.titleTxtConfig.value = '更新后的真实榜单';
        for (const id of [1, 2] as const) {
          const receipt = await f.saveSchema(id, blocks); expect(receipt.before).toEqual(expected); expect(receipt.response.status).toBe(200); expect(receipt.body.status).toBe(200);
          const update = receipt.body.data, want = structuredClone(receipt.before); expect(update.id).toBe(id); expect(update.version).not.toBe('diy-state-1');
          want.system_dise = want.system_dise.map(row => row.id === id ? { ...row, value: JSON.stringify(blocks), version: update.version, update_time: update.update_time } : row);
          expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after;
          configs.push({ action: 'schema', id, controller: 'AdminCrud.adminDiseSave fixture-only host', version: update.version,
            before: digest(receipt.before), after: digest(receipt.after), sequence_delta: 0, allowed_fields: ['value', 'version', 'update_time'] });
        }
      } else if (action === 'offline') { expect(evidence.at(-1)?.stage).toBe('returnAfterSign'); expect(offlineArmed || offlineFailed).toBe(false); offlineArmed = true;
      } else {
        const closed = action === 'close'; expect(action).toBe(closed ? 'close' : 'open'); expect(evidence.at(-1)?.stage).toBe(closed ? 'onlineRecovered' : 'closedRetry');
        expect(configs).toHaveLength(closed ? 2 : 3); const receipt = await f.setConfig('station_open', closed ? '0' : '1'), want = structuredClone(receipt.before);
        expect(receipt.before).toEqual(expected); want.system_config = want.system_config.map(row => row.menu_name === 'station_open' && row.is_store === 0 ? { ...row, value: closed ? '0' : '1' } : row);
        expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after; f.cache.set('cfg_station_open', closed ? '1' : '0');
        configs.push({ action, key: 'station_open', value: closed ? '0' : '1', opposite_stale_KV: closed ? '1' : '0', before: digest(receipt.before), after: digest(receipt.after), sequence_delta: 0 });
      }
      expect(await f.snapshot()).toEqual(expected); expect(storage()).toEqual(initialStorage); controls.push({ action, after_stage: evidence.at(-1)?.stage }); json(res, { action, configurations: configs.length });
    }); }
    const widgetReads = ['/api/diy/user_info', '/api/user/level/info', '/api/diy/newcomer_list', '/api/diy/sign', '/api/diy/product_rank'];
    const expectedDelta: Record<string, number[]> = { homeFirst: [2, 2, 2, 2, 2], homeRetry: [0, 0, 1, 0, 0], memberRefresh: [1, 1, 0, 0, 0],
      microInitial: [2, 2, 2, 2, 2], schemaChanged: [2, 2, 2, 2, 2], guestHome: [0, 0, 2, 2, 2], account22: [2, 2, 2, 2, 2], return11: [2, 2, 2, 2, 2],
      rankDestination: [0, 0, 0, 0, 0], returnAfterRank: [2, 2, 2, 2, 2], signDestination: [0, 0, 0, 0, 0], returnAfterSign: [2, 2, 2, 2, 2],
      offlineHome: [2, 2, 2, 2, 2], onlineRecovered: [2, 2, 2, 2, 2], stationClosed: [1, 0, 0, 0, 0], closedRetry: [0, 0, 0, 0, 0], reopened: [2, 2, 2, 2, 2], finished: [0, 0, 0, 0, 0] };
    const day = (seconds: number) => { const date = new Date((seconds + 28800) * 1000); return `${date.getUTCMonth() + 1}/${String(date.getUTCDate()).padStart(2, '0')}`; };
    function checkWidgets(data: Row, stage: string, index: number) {
      const changed = index >= 4, viewer = stage === 'guestHome' ? 0 : stage === 'account22' ? 22 : 11;
      expect(data.text).toContain('保留商城内容'); expect(data.community).toEqual(['实际社区预览']); expect(data.widgets).toHaveLength(8);
      expect(data.widgets.map((w: Row) => [w.key, w.kind, w.style])).toEqual(['userInfor', 'newVip', 'signIn', 'ranking'].flatMap((kind, i) => [[String(101 + i * 2), kind, '0'], [String(102 + i * 2), kind, '1']]));
      if (stage === 'homeFirst') {
        const failed = data.widgets.filter((widget: Row) => widget.kind === 'newVip' && widget.error !== '');
        expect(failed).toHaveLength(1); expect(['103', '104']).toContain(failed[0].key);
        failedNewcomerKey = failed[0].key === '103' ? 103 : 104;
        expect(traces.filter(row => row.injected === 'one-newcomer-read-503')).toHaveLength(1);
      }
      if (stage === 'homeRetry') {
        expect(failedNewcomerKey).toBeDefined();
        const prior = evidence.find(row => row.stage === 'homeFirst')!;
        for (const widget of data.widgets.filter((item: Row) => Number(item.key) !== failedNewcomerKey)) {
          const previous = prior.widgets.find((item: Row) => item.key === widget.key)!;
          expect(widget).toEqual(previous);
        }
      }
      for (const widget of data.widgets) {
        const key = Number(widget.key), own = viewer === 11, guest = viewer === 0;
        if (widget.kind === 'userInfor') {
          expect(widget.member.name).toBe(guest ? '请点击登录' : own ? '零值会员11' : '另一会员22');
          if (guest) { expect(widget.member.metrics).toEqual([]); expect(widget.member.badge).toBe(''); expect(widget.member.exp).toBe(''); }
          else {
            expect(widget.member.badge).toBe(own ? '蓝色会员' : '绿色会员'); expect(widget.member.badgeColor).toBe(own ? 'rgb(55, 90, 127)' : 'rgb(36, 110, 73)');
            expect(widget.member.exp).toBe(own ? '0/200' : '50/200'); expect(widget.member.progressWidth).toBe(own ? '0%' : '25%');
            const wanted = changed && key === 101 ? ['integral', 'coupon'] : key === 101 ? ['integral', 'money', 'coupon', 'collect', 'visit'] : ['integral', 'money', 'coupon', 'code', 'collect', 'visit'];
            expect(widget.member.metrics.map((m: Row) => m.action)).toEqual(wanted);
            const metrics = Object.fromEntries(widget.member.metrics.map((m: Row) => [m.action, m.count])); expect(metrics.integral).toBe(own ? '0' : '50'); expect(metrics.coupon).toBe(own ? '2' : '0');
            if (wanted.includes('money')) expect(metrics.money).toBe(own ? '0.00' : '88.00');
          }
        } else if (widget.kind === 'newVip') {
          if (stage === 'homeFirst' && key === failedNewcomerKey) { expect(widget.error).toContain('此新人组件读取失败'); expect(widget.newcomer.coupons).toEqual([]); expect(widget.newcomer.products).toEqual([]); }
          else { expect(widget.error).toBe(''); expect(widget.newcomer.points).toBe('0');
            expect(widget.newcomer.coupons.map((c: Row) => c.id)).toEqual(viewer === 22 ? [] : guest ? ['82', '81'] : ['92', '91']);
            if (viewer !== 22) { expect(widget.newcomer.coupons.map((c: Row) => c.money)).toEqual(['9折', guest ? '¥0.00' : '¥0']); expect(widget.newcomer.coupons.map((c: Row) => c.title)).toEqual(['真实九折商品券', '真实零元金额券']); }
            expect(widget.newcomer.products).toEqual(viewer === 22 || changed && key === 103 ? [] : ['71']);
          }
        } else if (widget.kind === 'signIn') {
          if (key === 105) { expect(widget.sign.days.map((d: Row) => d.day)).toEqual(Array.from({ length: 7 }, (_, i) => day(f.monday + i * 86400)));
            expect(widget.sign.days.filter((d: Row) => d.today).map((d: Row) => d.day)).toEqual([day(f.shanghaiDay)]);
            expect(widget.sign.days.filter((d: Row) => d.signed).map((d: Row) => d.day)).toEqual(guest ? [] : own ? [day(f.monday)] : [day(f.shanghaiDay)]);
          } else { expect(widget.sign.reward).toContain('连续签到7天，额外获得0积分'); expect(widget.sign.reward).toContain('3经验'); }
        } else {
          expect(widget.rank.groups.map((group: Row) => group.key)).toEqual(key === 107 ? ['sales', 'collect', 'star'] : ['sales', 'star', 'collect']);
          for (const group of widget.rank.groups) expect(group.products).toEqual(({ sales: ['301', '302', '303'], star: ['302', '303', '301'], collect: ['303', '301', '302'] } as Row)[group.key]);
          if (key === 107) { if (changed) expect(widget.rank.title).toBe('更新后的真实榜单'); else expect(widget.rank.titleImage).toContain('/static/logo.png'); }
        }
      }
    }
    async function checkpoint(req: IncomingMessage, res: ServerResponse, stage: string) { return serial(async () => {
      const index = evidence.length; expect(stage).toBe(stages[index]); const data = JSON.parse((await bytes(req)).toString()), current = await f.snapshot(); expect(current).toEqual(expected);
      expect(data.width).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); expect(data.text).not.toMatch(/Internal Server Error|Failed to resolve|Cannot read properties|格式错误/u);
      const slice = traces.slice(evidence.at(-1)?.traces ?? 0), counts = widgetReads.map(path => slice.filter(row => !row.synthetic && row.path === path).length);
      expect(counts).toEqual(expectedDelta[stage]); expect(traces.filter(row => row.business_write)).toHaveLength(0);
      if (['stationClosed', 'closedRetry'].includes(stage)) { expect(data.widgets).toEqual([]); expect(data.community).toEqual([]); expect(data.rendererCount).toBe(0); expect(data.text).toContain('站点升级中，请稍候访问'); expect(data.schemaCache.some((row: Row) => row.id === '0')).toBe(false); }
      else if (stage === 'rankDestination') { expect(data.href).toContain('/pages/columnGoods/rank/index'); expect(data.text).toContain('商品排行榜'); expect(slice.some(row => row.synthetic && /^\/api\/product\/rank\//u.test(row.path))).toBe(true); }
      else if (stage === 'signDestination') { expect(data.href).toContain('/pages/user/sign'); expect(data.text).toContain('每日签到'); expect(slice.some(row => row.synthetic && row.path === '/api/sign/status')).toBe(true); }
      else checkWidgets(data, stage, index);
      if (stage === 'offlineHome') { expect(offlineFailed).toBe(true); expect(data.offlineNotice).toContain('当前显示离线缓存'); expect(slice.filter(row => row.injected === 'one-version-read-503-status410010')).toHaveLength(1); }
      if (stage === 'onlineRecovered' || stage === 'reopened') expect(data.offlineNotice).toBe('');
      if (stage === 'closedRetry') { expect(slice.filter(row => !row.synthetic && row.path === '/api/diy/diy_version/0')).toHaveLength(1); expect(slice.some(row => row.path === '/api/diy/get_diy/0')).toBe(false); }
      if (!['stationClosed', 'closedRetry'].includes(stage)) {
        const activeId = ['microInitial', 'schemaChanged'].includes(stage) ? '2' : '0';
        const cached = data.schemaCache.find((row: Row) => row.id === activeId); expect(cached).toBeDefined();
        const row = expected.system_dise.find(item => item.id === (activeId === '0' ? 1 : 2))!;
        expect(cached.key).toBe(`cinashop_diy_page_v1_${activeId}`); expect(cached.entry.version).toBe(row.version); expect(cached.entry.versionVerified).toBe(true);
        expect(cached.entry.data.title).toBe(row.title); expect(cached.entry.data.value).toEqual(JSON.parse(row.value));
        if (stage === 'microInitial') expect(data.schemaCache.some((item: Row) => item.id === '0')).toBe(true);
      }
      for (const cache of data.schemaCache) { expect(cache.serialized).not.toMatch(/零值会员11|另一会员22|synthetic|now_money|currentExp|level_list/u); }
      expect(storage()).toEqual(initialStorage); expect(external).not.toHaveBeenCalled(); evidence.push({ stage, ...data, failed_newcomer_key: failedNewcomerKey, traces: traces.length, widget_read_delta: Object.fromEntries(widgetReads.map((path, i) => [path, counts[i]])), database_sha: digest(current) });
      if (stage === 'finished') { expect(configs).toHaveLength(4); expect(controls.map(row => row.action)).toEqual(['schema', 'offline', 'close', 'open']); expect(newcomerFailed && offlineFailed).toBe(true);
        expect(traces.some(row => !row.synthetic && row.path === '/api/get_script' && row.status === 200)).toBe(true);
        await writeFile(prefix + 'evidence.json', JSON.stringify({ evidence, traces, configs, controls, failed_newcomer_key: failedNewcomerKey, tables: f.tables, sequences: f.sequences, initial_sha: digest(initial), final_sha: digest(current), initial_snapshot: initial, final_snapshot: current,
          storage: { initial: initialStorage, final: storage(), acceptance_put_delta: 0, acceptance_delete_delta: 0 }, providerCalls: 0, businessWrites: 0, static_paths: [...staticPaths].sort(),
          authority: 'Actual H5 DOM/createApp/JWT/owned PG16. Four DIY consumer families and level-info are real. Config uses actual AdminCrud.adminDiseSave fixture host or exact station control with opposite stale KV. All GET snapshots cover35tables/34sequences.',
          limitations: 'Synthetic routes/sessions/viewport/checkpoints and unrelated home/destination chrome only. No real login/production ACL/index/KV/R2 or MP/App-device claim. Root close clears current known home cache and withdraws UI; remaining earlier-frame micro cache is recorded without claiming global persistent-key purge. No video_list/detail/sign/claim/order/cart business writes.' }, null, 2) + '\n'); done(); }
      json(res, { checked: evidence.map(row => row.stage), finished: stage === 'finished', failed_newcomer_key: failedNewcomerKey, retry_selector: failedNewcomerKey ? `[data-component-key="${failedNewcomerKey}"] .diy-state-refresh` : null });
    }); }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DIY数据组件后台验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px;border:1px solid #ddd}pre{max-height:70px;overflow:auto}</style><h1>实际首页与微页面四类独立组件</h1>${Object.entries(routes).map(([key, route]) => `<button data-route="${key}">${route.label}</button>`).join('')}<button data-size>375像素内容区</button><button data-action="schema">更新schema配置（真实fixture Admin保存）</button><button data-action="offline">仅一次version503（真实读取后替换回执）</button><button data-action="close">站点关闭（仅fixture）</button><button data-action="open">站点开启（仅fixture）</button>${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际DIY数据组件页面"></iframe><script>
const frame=document.querySelector('iframe'),routes=${JSON.stringify(routes)},actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const route=routes[b.dataset.route];localStorage.setItem('uni_token',JSON.stringify({type:'string',data:route.uid===11?actor:route.uid===22?other:''}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:route.uid}));frame.src='/?diy_state_session='+route.uid+'-'+Date.now()+'#'+route.route;};
document.querySelector('[data-size]').onclick=()=>{const d=frame.contentDocument;frame.style.width=(375+frame.contentWindow.innerWidth-d.documentElement.clientWidth)+'px';};
for(const b of document.querySelectorAll('[data-action]'))b.onclick=async()=>{const response=await fetch('${control}/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.action})});document.getElementById('result').textContent=JSON.stringify(await response.json());};
const cacheEntry=key=>{const serialized=localStorage.getItem(key);let entry=JSON.parse(serialized);if(entry&&Object.keys(entry).length===2&&['object','string','number','boolean','undefined'].includes(entry.type)&&typeof entry.data===entry.type)entry=entry.data;if(typeof entry==='string')entry=JSON.parse(entry);return{key,id:key.replace('cinashop_diy_page_v1_',''),serialized,entry};};
const visible=e=>{if(!e)return false;for(let p=e;p;p=p.parentElement)if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return false;return true;},txt=e=>visible(e)?e.textContent.trim().replace(/\\s+/g,' '):'';
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{const d=frame.contentDocument,all=(s,p=d)=>[...p.querySelectorAll(s)].filter(visible),one=(s,p=d)=>all(s,p)[0],image=e=>one('img',e)?.src||e?.getAttribute('src')||'',data={href:frame.contentWindow.location.href,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:txt(d.body),offlineNotice:all('.diy-offline').map(txt).join(' '),rendererCount:all('.diy-renderer').length,community:all('.diy-community-post-title').map(txt),schemaCache:Object.keys(localStorage).filter(k=>k.startsWith('cinashop_diy_page_v1_')).sort().map(cacheEntry),widgets:all('.diy-state-widget').map(e=>({key:e.dataset.componentKey,kind:e.dataset.kind,style:e.dataset.style,text:txt(e),error:txt(one('.diy-state-error',e)),member:{name:txt(one('.diy-member-name',e)),badge:txt(one('.diy-member-badge',e)),badgeColor:one('.diy-member-badge',e)?getComputedStyle(one('.diy-member-badge',e)).color:'',exp:txt(one('.diy-member-experience',e)),progressWidth:one('.diy-member-progress-fill',e)?.style.width||'',metrics:all('.diy-member-action',e).map(m=>({action:m.dataset.action,count:txt(one('.diy-member-count',m))}))},newcomer:{points:txt(one('.diy-newcomer-points',e)),coupons:all('.diy-coupon',e).map(c=>({id:c.dataset.couponId,money:txt(one('.diy-coupon-money',c)),title:txt(one('.diy-coupon-title',c)),status:txt(one('.diy-coupon-status',c))})),products:all('.diy-newcomer-product',e).map(p=>p.dataset.productId)},sign:{days:all('.diy-sign-day',e).map(day=>({day:day.dataset.day,signed:day.classList.contains('signed'),today:day.classList.contains('today')})),reward:txt(one('.diy-sign-next-reward',e)),button:txt(one('.diy-sign-destination',e))},rank:{title:txt(one('.diy-state-title',e)),titleImage:one('.diy-state-title-image',e)?image(one('.diy-state-title-image',e)):'',groups:all('.diy-rank-group',e).map(g=>({key:g.dataset.rank,products:all('.diy-rank-product',g).map(p=>p.dataset.productId)}))}}))};const response=await fetch('${control}/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path === control + '/configure' && req.method === 'POST') return configure(req, res);
      if (path.startsWith(control + '/') && req.method === 'POST') return checkpoint(req, res, path.slice(control.length + 1));
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return synthetic(req, res, url, chrome[path], 'unrelated home/navigation chrome');
      if (/^\/api\/product\/rank\/[123]$/u.test(path)) { expect(evidence.at(-1)?.stage).toBe('return11'); return synthetic(req, res, url, [], 'rank destination only'); }
      if (path === '/api/sign/status' || path === '/api/user/info') { expect(evidence.at(-1)?.stage).toBe('returnAfterRank'); return synthetic(req, res, url, path.endsWith('status') ? { enabled: false, signedToday: false, integral: 0, continuousDays: 0 } : { integral: 0 }, 'sign destination only, no button acceptance'); }
      if (path.startsWith('/api/')) return api(req, res, url); if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) { staticPaths.add(path); return send(res, await readFile(target), 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' } as Row)[extname(target)] ?? 'application/octet-stream'); } } catch { /* Actual SPA fallback. */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(reason => { fail(reason instanceof Error ? reason : Error(String(reason))); if (!res.headersSent) send(res, String(reason), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40769, '127.0.0.1', yes); });
      const ready = { url: origin + control, stages, routes, actions, width: 375, tables: 35, sequences: 34, business_writes: 0, deliberate_visits: 0, R2_seed_puts: 1, logical_config_actions: 3, exact_config_receipts: 4,
        deadlines: { server_minutes: 8, test_minutes: 9, targeted_native_runner_minutes: 10, browser_mode_runner_minutes: 25 }, selectors: { widget: '.diy-state-widget[data-component-key]', singleRetryFromHomeFirst: 'retry_selector', singleRetryCandidates: ['[data-component-key="103"] .diy-state-refresh', '[data-component-key="104"] .diy-state-refresh'], memberRefresh: '[data-component-key="101"] .diy-state-refresh', rank: '[data-component-key="107"] .diy-state-more', sign: '[data-component-key="105"] .diy-sign-destination', rootRetry: '.diy-error button', offline: '.diy-offline button' } };
      await writeFile(prefix + 'ready.json', JSON.stringify(ready, null, 2) + '\n'); process.stdout.write('DIY_STATE_BROWSER_READY ' + JSON.stringify(ready) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent within owned eight-minute window')), 8 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 9 * 60_000);
