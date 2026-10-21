import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemDise } from '@/models/schema';
import { diyCommerceFixture, DIY_COMMERCE_FAMILIES } from '../helpers/diyCommerceFixture';
import { sortedDiyState, stableDiyState, type DiyStateRow as Row, type DiyStateSnapshot } from '../helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned DIY commerce Browser SQL'); return wiring.container;
} }));
const digest = (value: unknown) => createHash('sha256').update(stableDiyState(value)).digest('hex');
const pgTimestamp = (value: Date) => value.toISOString().replace(/Z$/u, '').replace(/\.([0-9]*?)0+$/u, (_match, digits: string) => digits ? `.${digits}` : '');
async function bytes(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0;
  for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; expect(size).toBeLessThan(400_000); chunks.push(chunk); } return Buffer.concat(chunks);
}
type Plan = { stage: string; action: string; href?: string; detail?: RegExp; more?: string };

it('actual H5 commerce configuration, manual coupon receipts and canonical navigation survive lifecycle and station changes', async () => {
  const f = await diyCommerceFixture(), app = createApp(); wiring.container = f.container;
  const root = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5'), origin = 'http://127.0.0.1:40769';
  const control = '/__diy_commerce/' + randomUUID(), prefix = '/tmp/cinashop-diy-commerce-browser-';
  const routes = { home: { uid: 11, route: '/pages/index/index', label: '账号11实际首页' }, micro: { uid: 11, route: '/pages/diy/detail?id=2', label: '账号11实际微页面' },
    guest: { uid: 0, route: '/pages/index/index', label: '游客实际首页' }, other: { uid: 22, route: '/pages/index/index', label: '账号22实际首页' } };
  const plans: Plan[] = [
    { stage: 'homeFirst', action: '点账号11实际首页，等14个H5组件完成且307/308中恰一砍价错误；点375/checkpoint' },
    { stage: 'homeRetry', action: '只点homeFirst返回retry_selector；其他13块不刷新；点375/checkpoint' },
    { stage: 'promotionCategory', action: '点301的promotion-tab[data-tab=1]；只此实例变为分类商品601；点375/checkpoint' },
    { stage: 'promotionBrand', action: '点301的promotion-tab[data-tab=3]；真实品牌703范围；点375/checkpoint' },
    { stage: 'promotionLabel', action: '点301的promotion-tab[data-tab=4]；真实标签704范围；点375/checkpoint' },
    { stage: 'promotionActivities', action: '点301的promotion-tab[data-tab=2]；显示602/603/604/605，302仍601/611；点375/checkpoint' },
    { stage: 'seckillSlot', action: '只点303的commerce-slot[data-slot-id=502]；1702/零库存，304仍1701；点375/checkpoint' },
    { stage: 'claimAcknowledged', action: '明确点313中coupon901的coupon-claim；等成功及两实例均已领取；点375/checkpoint' },
    { stage: 'peerProtected', action: '不发业务动作，核实314同901按钮已禁用且无第二POST；点375/checkpoint' },
    { stage: 'claimUnknown', action: '明确点313中coupon905的coupon-claim；真实提交后仅回执HTTP503，两实例结果待核对；点375/checkpoint' },
    { stage: 'unknownPeerProtected', action: '不发业务动作，核实314同905禁用且仍一次POST；点375/checkpoint' },
    { stage: 'unknownRecovered', action: '只点313的coupon-reconcile只读核对；实际持券GET恢复两实例已领取，禁止重POST；点375/checkpoint' },
    { stage: 'microInitial', action: '点账号11实际微页面，等14块；点375/checkpoint' },
    { stage: 'schemaChanged', action: '点更新schema配置（实际Admin保存），再点账号11实际微页面；303新标题/布局、304仅名称、312空、314站点券样式；点375/checkpoint' },
    { stage: 'couponCentreDestination', action: '只点314的coupon-centre；实际注册领券中心，禁止在目的地领取；点375/checkpoint', href: '/pages/user/couponCenter', detail: /^\/api\/coupons$/u },
    { stage: 'returnAfterCentre', action: '点账号11实际首页；等14块；点375/checkpoint' },
    { stage: 'guestHome', action: '点游客实际首页；901/905均可领取，未继承11状态；点375/checkpoint' },
    { stage: 'guestClaimDestination', action: '只点313的901领取；实际登录页且不POST；点375/checkpoint', href: '/pages/auth/login' },
    { stage: 'account22', action: '点账号22实际首页；902已领取，901/905可领，未继承11日志；点375/checkpoint' },
    { stage: 'return11', action: '点账号11实际首页；901/905实际持券与恢复日志保留；点375/checkpoint' },
  ];
  for (const [name, product, href, detail] of [
    ['Seckill', 602, '/pages/activity/seckillDetail?id=1701', /^\/api\/seckill\/detail\/1701$/u],
    ['Combination', 603, '/pages/activity/detail?id=1801', /^\/api\/combination\/detail\/1801$/u],
    ['Bargain', 604, '/pages/activity/bargainDetail?id=1901&spid=11', /^\/api\/bargain\/detail\/1901$/u],
    ['Presale', 605, '/pages/activity/presaleDetail?id=605', /^\/api\/product\/detail\/605$/u],
  ] as const) plans.push(
    { stage: `promotion${name}Ready`, action: '只点301的活动tab[data-tab=2]，等4个真实活动目标；点375/checkpoint' },
    { stage: `promotion${name}Destination`, action: `真实点301的commerce-card[data-product-id=${product}]；只验注册目的地与canonical ID，禁止详情业务操作；点375/checkpoint`, href, detail },
    { stage: `returnAfter${name}`, action: '点账号11实际首页；等14块；点375/checkpoint' },
  );
  for (const [name, key, href, more] of [
    ['SeckillMore', 303, '/pages/activity/index?type=seckill', '/api/seckill/index'],
    ['CombinationMore', 305, '/pages/activity/index?type=combination', '/api/combination/list'],
    ['BargainMore', 307, '/pages/activity/index?type=bargain', '/api/bargain/list'],
    ['PointsMore', 311, '/pages/user/integral', '/api/store_integral/list'],
    ['PresaleMore', 309, '/pages/activity/presale', '/api/presale/list'],
  ] as const) plans.push(
    { stage: `${name}Destination`, action: `真实点${key}的commerce-more；仅验${href}注册目的地，禁止目的地购买；点375/checkpoint`, href, more },
    { stage: `returnAfter${name}`, action: '点账号11实际首页；等14块；点375/checkpoint' },
  );
  plans.push(
    { stage: 'stationClosed', action: '点站点关闭（仅fixture），再点账号11实际首页触发真实根schema检查；升级提示、14块撤下；点375/checkpoint' },
    { stage: 'closedRetry', action: '真实点根diy-error中的重新加载首页；仍关闭，无营销读取；点375/checkpoint' },
    { stage: 'reopened', action: '点站点开启（仅fixture），真实点根重新加载首页；等14块恢复；点375/checkpoint' },
    { stage: 'finished', action: '无业务操作；点375/checkpoint，生成完整证据后server自动结束' },
  );
  const stages = plans.map(row => row.stage), traces: Row[] = [], evidence: Row[] = [], configs: Row[] = [], controls: Row[] = [], claims: Row[] = [], staticPaths = new Set<string>();
  let failed = false, failedKey: string | undefined, changed = false;
  let done!: () => void, fail!: (error: Error) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned DIY commerce acceptance forbids provider I/O'));
  const send = (res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  const json = (res: ServerResponse, body: unknown, status = 200) => send(res, JSON.stringify(body), status, 'application/json');
  let pending = Promise.resolve(); function serial<T>(work: () => Promise<T>): Promise<T> { const next = pending.then(work); pending = next.then(() => {}, () => {}); return next; }
  const nextPlan = () => plans[evidence.length];
  try {
    expect(f.tables).toHaveLength(46); expect(f.sequences).toHaveLength(43);
    const repository = resolve(import.meta.dirname, '../../..'), sourceInputs = [
      'workers-ts/test/browser/diy-commerce.acceptance.ts', 'workers-ts/vitest.diy-commerce-browser.config.ts', 'workers-ts/test/helpers/diyCommerceFixture.ts',
      'workers-ts/src/controllers/api/v1/UserActivityController.ts', 'workers-ts/src/controllers/api/v1/ProductController.ts', 'workers-ts/src/services/activity/ActivityService.ts',
      'workers-ts/src/services/product/PublicProductActivityData.ts', 'workers-ts/src/services/product/RecommendationNavigationService.ts',
      'workers-ts/src/services/product/StoreProductService.ts', 'workers-ts/src/services/product/PublicCatalogService.ts', 'workers-ts/src/services/product/PublicProductCardData.ts',
      'workers-ts/src/services/product/PublicProductLabelData.ts',
      'view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue', 'view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue',
      'view/uniapp-ts/src/composables/useDiyCommerceWidget.ts', 'view/uniapp-ts/src/utils/diyCommerceConfig.ts', 'view/uniapp-ts/src/utils/diyCommerceData.ts',
      'view/uniapp-ts/src/utils/diyCouponClaim.ts', 'view/uniapp-ts/src/api/diyCommerce.ts', 'view/uniapp-ts/src/api/activity.ts', 'view/uniapp-ts/src/api/productRank.ts',
    ];
    const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceInputs.map(async path => [path, createHash('sha256').update(await readFile(resolve(repository, path))).digest('hex')])));
    const sourceBefore = await sourceHashes();
    // Additional initial owned fixture material; never a production/config UI
    // bridge. All later business requests execute through the real application.
    const blocks = structuredClone(f.blocks) as Row[];
    for (const block of blocks.filter(row => DIY_COMMERCE_FAMILIES.includes(row.name))) {
      const second = Number(block.timestamp) % 2 === 0;
      block.titleConfig = { tabVal: second ? 0 : 1 }; block.imgConfig = { url: '/static/logo.png' }; block.imgConfig2 = { url: '/static/logo.png' };
      block.imgColorConfig = { url: '/static/logo.png' }; block.imgBgConfig = { url: '/static/logo.png' };
      block.checkboxInfo = { type: second ? [2] : [0, 1, 2, 3] };
      if (block.name === 'promotionList') {
        block.styleConfig.tabVal = second ? 4 : 0; block.cartConfig.tabVal = 1;
        expect(block.tabConfig.list).toHaveLength(5);
      } else if (block.name === 'coupon') block.numberConfig.val = 5;
      else if (block.name === 'pointsMall') block.goodStyleConfig.tabVal = second ? 2 : 0;
      else block.goodStyleConfig.tabVal = second ? 3 : 0;
    }
    for (const id of [1, 2]) await f.db.update(systemDise).set({ value: JSON.stringify(blocks) }).where(eq(systemDise.id, id));
    const initial = await f.snapshot(); let expected = initial, currentBlocks = blocks;
    const storage = () => ({ objects: digest([...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: [...item.bytes] }))), puts: f.bucket.put.mock.calls.length,
      deletes: f.bucket.delete.mock.calls.length, queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
    const initialStorage = storage(); expect(initialStorage.puts).toBe(1); expect(initialStorage.deletes).toBe(0); expect(initialStorage.queue).toBe(0);
    const identity = (headers: Headers) => { const token = headers.get('Authori-zation') ?? headers.get('Authorization'); return token === `Bearer ${f.token}` ? 11 : token === `Bearer ${f.otherToken}` ? 22 : 0; };
    const headersOf = (req: IncomingMessage) => { const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]); return headers; };
    const snapshotReceipt = (before: DiyStateSnapshot, after: DiyStateSnapshot, unchanged: boolean) => ({ before: digest(before), after: digest(after), unchanged, tables: f.tables.length, sequences: f.sequences.length });
    function assertClaim(before: DiyStateSnapshot, after: DiyStateSnapshot, issueId: 901 | 905, receipt: Row, started: number, finished: number) {
      const want = structuredClone(before), issue = before.store_coupon_issue.find(row => row.id === issueId)!;
      const seq = want.__sequences.find(row => row.name === 'store_coupon_user_id_seq')!, id = seq.called ? Number(seq.last) + 1 : Number(seq.last);
      expect(receipt).toEqual({ couponUserId: id }); seq.last = String(id); seq.called = true;
      const added = after.store_coupon_user.filter(row => !before.store_coupon_user.some(old => old.id === row.id)); expect(added).toHaveLength(1);
      const actual = added[0], date = (value: unknown) => { expect(typeof value).toBe('string'); const n = Date.parse(String(value) + 'Z'); expect(Number.isFinite(n)).toBe(true); return n; };
      const start = date(actual.start_time), end = date(actual.end_time); expect(start).toBeGreaterThanOrEqual(started); expect(start).toBeLessThanOrEqual(finished); expect(end - start).toBe(7 * 86400_000);
      expect(actual.start_time).toBe(pgTimestamp(new Date(start))); expect(actual.end_time).toBe(pgTimestamp(new Date(end)));
      const coupon = { id, uid: 11, issue_coupon_id: issueId, coupon_title: issue.coupon_title, coupon_price: issue.coupon_price, use_min_price: issue.use_min_price,
        status: 0, start_time: actual.start_time, end_time: actual.end_time, use_time: null, type: issue.type, receive_time: Math.floor(start / 1000), receive_source: 'get', is_fail: 0 };
      want.store_coupon_issue = want.store_coupon_issue.map(row => row.id === issueId ? { ...row, remain_count: row.remain_count - 1 } : row);
      want.store_coupon_user.push(coupon); want.store_coupon_issue_user.push({ uid: 11, issue_coupon_id: issueId, add_time: Math.floor(start / 1000) });
      expect(after).toEqual(sortedDiyState(want)); claims.push({ actor: 11, issue: issueId, coupon, evidence: { uid: 11, issue_coupon_id: issueId, add_time: Math.floor(start / 1000) },
        observed_clock: { started, finished }, snapshot: snapshotReceipt(before, after, false), allowed: ['store_coupon_issue.remain_count -1', 'one store_coupon_user insert', 'one store_coupon_issue_user insert', 'store_coupon_user_id_seq +1'] });
    }
    const realPaths = new Set(['/api/diy/get_diy/0', '/api/diy/get_diy/2', '/api/diy/diy_version/0', '/api/diy/diy_version/2', '/api/diy/get_suspended',
      '/api/products', '/api/seckill/index', '/api/seckill/list/501', '/api/seckill/list/502', '/api/combination/list', '/api/pink', '/api/bargain/list', '/api/presale/list', '/api/store_integral/list',
      '/api/v2/coupons', '/api/community/config', '/api/community/list', '/api/get_script', '/api/coupon/receive']);
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) { return serial(async () => {
      const post = req.method === 'POST'; expect(req.method).toBe(post ? 'POST' : 'GET');
      expect(realPaths.has(url.pathname) || /^\/api\/assets\/\d+$/u.test(url.pathname)).toBe(true);
      expect(url.pathname).not.toMatch(/video_list|\/(?:detail|browse|share)\/|sign\/integral|bargain\/(?:start|help)|cart|order/u);
      const rawBody = await bytes(req); if (!post) expect(rawBody).toHaveLength(0);
      const headers = headersOf(req), viewer = identity(headers), started = Date.now();
      let issue: 901 | 905 | undefined;
      if (post) {
        expect(url.pathname).toBe('/api/coupon/receive'); expect(viewer).toBe(11);
        issue = nextPlan().stage === 'claimAcknowledged' ? 901 : nextPlan().stage === 'claimUnknown' ? 905 : undefined;
        expect(issue).toBeDefined(); expect(JSON.parse(rawBody.toString())).toEqual({ id: issue });
        expect(claims.some(row => row.issue === issue)).toBe(false);
      }
      const before = await f.snapshot(); expect(before).toEqual(expected); const waits: Promise<unknown>[] = [];
      const response = await app.fetch(new Request(url.href, { method: post ? 'POST' : 'GET', headers, ...(post ? { body: rawBody.toString() } : {}) }), f.env,
        { waitUntil: work => { waits.push(work); }, passThroughOnException() {} } as ExecutionContext); await Promise.all(waits);
      const raw = Buffer.from(await response.arrayBuffer()), payload = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
      expect([200, 206]).toContain(response.status); if (payload) expect([200, 410010]).toContain(payload.status);
      const after = await f.snapshot(); if (post) { expect(payload.status).toBe(200); assertClaim(before, after, issue!, payload.data, started, Date.now()); } else expect(after).toEqual(before);
      expect(storage()).toEqual(initialStorage); expected = after;
      const injected = !post && !failed && url.pathname === '/api/bargain/list'; if (injected) { expect(payload.status).toBe(200); failed = true; }
      const unknown = post && issue === 905;
      traces.push({ path: url.pathname, query: url.search, viewer, synthetic: false, method: post ? 'POST' : 'GET', issue: issue ?? null, business_write: post,
        status: payload?.status ?? response.status, browser_status: injected || unknown ? 503 : response.status, injected: injected ? 'one-bargain-read-503' : unknown ? 'committed-coupon-905-response-503' : null,
        material: payload?.data, snapshot: snapshotReceipt(before, after, !post) });
      if (injected) return json(res, { status: 503, msg: '本地验收：此砍价组件读取失败，请单独重试' }, 503);
      if (unknown) return json(res, { status: 503, msg: '本地验收：真实提交后回执丢失，请只读核对' }, 503);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
    }); }
    const chrome: Row = { '/api/site_config': { site_name: 'DIY商城真实组件验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: 'DIY商城组件', synopsis: '', img: '' },
      '/api/category': [], '/api/get_open_adv': { status: 0, time: 3, interval_time: 24, type: 'pic', value: [], video_link: '' }, '/api/v2/diy/color_change/color_change': {}, '/api/v2/diy/product_detail': {} };
    async function synthetic(req: IncomingMessage, res: ServerResponse, url: URL, value: unknown, scope: string, businessStatus = 200) { return serial(async () => {
      expect(req.method).toBe('GET'); expect(await bytes(req)).toHaveLength(0); const before = await f.snapshot(); expect(before).toEqual(expected); const after = await f.snapshot(); expect(after).toEqual(before); expect(storage()).toEqual(initialStorage);
      traces.push({ path: url.pathname, query: url.search, viewer: identity(headersOf(req)), synthetic: true, scope, method: 'GET', business_write: false, status: businessStatus,
        snapshot: snapshotReceipt(before, after, true) });
      json(res, { status: businessStatus, msg: businessStatus === 200 ? 'Synthetic unrelated navigation chrome only' : '导航验收：仅确认注册目的地，不验收详情或购买', data: value });
    }); }
    async function configure(req: IncomingMessage, res: ServerResponse) { return serial(async () => {
      const input = JSON.parse((await bytes(req)).toString()), action = input.action; expect(input).toEqual({ action }); expect(await f.snapshot()).toEqual(expected);
      if (action === 'schema') {
        expect(evidence.at(-1)?.stage).toBe('microInitial'); expect(configs).toHaveLength(0);
        const next = structuredClone(currentBlocks); const item = (key: number) => next.find(row => row.timestamp === key)!;
        item(303).titleTxtConfig.value = '更新后的真实秒杀'; item(303).goodStyleConfig.tabVal = 1;
        item(304).goodStyleConfig.tabVal = 3; item(304).checkboxInfo.type = [0]; item(312).numberConfig.val = 0; item(314).styleConfig.tabVal = 3;
        for (const id of [1, 2] as const) {
          const receipt = await f.saveSchema(id, next); expect(receipt.before).toEqual(expected); expect(receipt.response.status).toBe(200); expect(receipt.body.status).toBe(200);
          const update = receipt.body.data, want = structuredClone(receipt.before); expect(update.version).not.toBe('diy-commerce-1');
          want.system_dise = want.system_dise.map(row => row.id === id ? { ...row, value: JSON.stringify(next), version: update.version, update_time: update.update_time } : row);
          expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after;
          configs.push({ action: 'schema', id, controller: 'AdminCrud.adminDiseSave fixture-only host', version: update.version, before: digest(receipt.before), after: digest(receipt.after), allowed_fields: ['value', 'version', 'update_time'], sequence_delta: 0 });
        }
        changed = true; currentBlocks = next;
      } else {
        const closed = action === 'close'; expect(action).toBe(closed ? 'close' : 'open'); expect(evidence.at(-1)?.stage).toBe(closed ? 'returnAfterPresaleMore' : 'closedRetry');
        expect(configs).toHaveLength(closed ? 2 : 3); const receipt = await f.setConfig('station_open', closed ? '0' : '1'), want = structuredClone(receipt.before);
        expect(receipt.before).toEqual(expected); want.system_config = want.system_config.map(row => row.menu_name === 'station_open' && row.is_store === 0 ? { ...row, value: closed ? '0' : '1' } : row);
        expect(receipt.after).toEqual(sortedDiyState(want)); expected = receipt.after; f.cache.set('cfg_station_open', closed ? '1' : '0');
        configs.push({ action, key: 'station_open', value: closed ? '0' : '1', before: digest(receipt.before), after: digest(receipt.after), opposite_stale_KV: closed ? '1' : '0', sequence_delta: 0 });
      }
      expect(await f.snapshot()).toEqual(expected); expect(storage()).toEqual(initialStorage); controls.push({ action, after_stage: evidence.at(-1)?.stage }); json(res, { action, configurations: configs.length });
    }); }
    const widgetPaths = ['/api/products', '/api/seckill/index', '/api/seckill/list/501', '/api/seckill/list/502', '/api/combination/list', '/api/pink', '/api/bargain/list', '/api/presale/list', '/api/store_integral/list', '/api/v2/coupons'];
    const baseStage = (stage: string) => stage === 'homeFirst' || ['microInitial', 'schemaChanged', 'guestHome', 'account22', 'return11', 'reopened'].includes(stage) || stage.startsWith('returnAfter');
    const sourceFor = (kind: string) => ({ seckill: '/api/seckill/list/', combination: '/api/combination/list', bargain: '/api/bargain/list', presale: '/api/presale/list', pointsMall: '/api/store_integral/list' } as Row)[kind];
    const materialRows = (trace: Row) => Array.isArray(trace.material) ? trace.material : trace.material?.list ?? [];
    const staticMaterial = (widget: Row) => Object.fromEntries(Object.entries(widget).filter(([key]) => !['text', 'countdown', 'navigationLayout'].includes(key)));
    function checkWidgets(data: Row, stage: string, viewer: number) {
      expect(data.text).toContain('真实商城八类组件'); expect(data.community).toEqual(['实际社区预览']); expect(data.widgets).toHaveLength(14);
      expect(data.widgets.map((widget: Row) => [widget.key, widget.kind])).toEqual(DIY_COMMERCE_FAMILIES.slice(0, 7).flatMap((kind, i) => [[String(301 + i * 2), kind], [String(302 + i * 2), kind]]));
      expect(data.widgets.some((widget: Row) => widget.kind === 'liveBroadcast')).toBe(false); expect(traces.some(row => row.path === '/api/wechat/live')).toBe(false);
      if (stage === 'homeFirst') {
        const errors = data.widgets.filter((widget: Row) => widget.error); expect(errors).toHaveLength(1); expect(['307', '308']).toContain(errors[0].key); failedKey = errors[0].key;
        expect(errors[0].error).toContain('此砍价组件读取失败'); expect(errors[0].cards).toEqual([]);
      }
      if (stage === 'homeRetry') {
        expect(failedKey).toBeDefined(); const previous = evidence.find(row => row.stage === 'homeFirst')!;
        for (const widget of data.widgets.filter((row: Row) => row.key !== failedKey)) expect(staticMaterial(widget)).toEqual(staticMaterial(previous.widgets.find((row: Row) => row.key === widget.key)));
      }
      for (const widget of data.widgets) {
        const cfg = currentBlocks.find(row => String(row.timestamp) === widget.key)!;
        expect(widget.style).toBe(String(cfg.styleConfig.tabVal)); expect(widget.layout).toBe(String(cfg.goodStyleConfig.tabVal));
        expect(widget.panel.borderRadius).not.toBe('');
        if (stage !== 'homeFirst' || widget.key !== failedKey) expect(widget.error).toBe('');
        if (widget.error) continue;
        if (!['promotionList', 'coupon'].includes(widget.kind)) {
          expect(widget.more).toBe(cfg.rightBntConfig.value + ' ›');
          if (cfg.titleConfig.tabVal === 1) { expect(widget.title).toBe(cfg.titleTxtConfig.value); expect(widget.titleImage).toBe(''); }
          else { expect(widget.title).toBe(''); expect(widget.titleImage).toContain('/static/logo.png'); }
        }
        if (widget.kind === 'promotionList') {
          if (widget.key === '301' && ['promotionCategory', 'promotionBrand', 'promotionLabel', 'promotionActivities'].includes(stage)) {
            expect(widget.navigationLayout.activeHit).toBe(true);
            expect(widget.navigationLayout.headerBottom).toBeGreaterThan(0);
            expect(widget.navigationLayout.navTop).toBeGreaterThanOrEqual(widget.navigationLayout.headerBottom - 0.5);
          }
          expect(widget.tabs).toHaveLength(5);
          const selected = Number(widget.selectedTab), tab = cfg.tabConfig.list[selected]; expect(tab).toBeDefined();
          const wanted = selected === 0 ? ['601', '611'] : selected === 2 ? ['602', '603', '604', '605'] : ['601'];
          expect(widget.cards.map((row: Row) => row.id)).toEqual(wanted);
          if (selected !== 2) { expect(widget.cards[0]).toMatchObject({ name: '真实促销零价商品601', price: '¥0.00' }); expect(widget.cards[0].copy).toContain('真实商城标签'); }
          if (widget.key === '302') expect(widget.selectedTab).toBe('0');
        } else if (widget.kind === 'coupon') {
          expect(widget.coupons.map((row: Row) => row.id)).toEqual(['901', '902', '903', '904', '905']);
          expect(widget.coupons[0].money).toBe('¥0.00'); expect(widget.coupons[1].money).toBe('9折');
          for (const coupon of widget.coupons) {
            const owned = viewer === 22 ? coupon.id === '902' : viewer === 11 && ['901', '905'].includes(coupon.id) && claims.some(row => String(row.issue) === coupon.id);
            const uncertain = coupon.id === '905' && ['claimUnknown', 'unknownPeerProtected'].includes(stage);
            if (cfg.styleConfig.tabVal === 3) { expect(coupon.label).toBe(''); expect(widget.centre).toBe('立即领取'); }
            else { expect(coupon.label).toBe(uncertain ? '结果待核对' : owned ? '已领取' : '领取'); expect(coupon.disabled).toBe(uncertain || owned); }
          }
        } else {
          const zero = cfg.numberConfig.val === 0;
          const path = sourceFor(widget.kind), relevant = traces.filter(row => !row.synthetic && row.method === 'GET' && row.browser_status === 200 && row.viewer === viewer && row.path.startsWith(path)
            && (widget.kind !== 'seckill' || row.path.endsWith('/' + widget.selectedSlot)));
          const source = zero ? [] : materialRows(relevant.at(-1)!);
          expect(widget.cards.map((row: Row) => Number(row.id))).toEqual(source.map((row: Row) => row.id));
          for (const card of widget.cards) {
            const raw = source.find((row: Row) => String(row.id) === card.id)!;
            const showName = widget.kind === 'pointsMall' ? Number(widget.layout) !== 0 : cfg.checkboxInfo.type.includes(0);
            expect(card.name).toBe(showName ? widget.kind === 'presale' ? raw.store_name : raw.title : '');
            if (widget.kind !== 'pointsMall') {
              if (cfg.checkboxInfo.type.includes(2)) expect(card.price).toContain(Number(raw.price).toFixed(2)); else expect(card.price).toBe('');
              if (!cfg.checkboxInfo.type.includes(3)) expect(card.oldPrice).toBe('');
            } else { expect(card.points).toContain('0'); expect(card.points).toContain('1.50'); }
            if (widget.kind === 'combination' && Number(widget.layout) === 0 && cfg.checkboxInfo.type.includes(1)) expect(card.people).toContain('3人团');
            if (widget.kind === 'bargain' && card.people) expect(card.people).toContain(String(raw.people));
          }
          if (widget.kind === 'combination') expect(widget.pink).toContain('2人拼团成功');
        }
      }
      if (changed) {
        expect(data.widgets.find((row: Row) => row.key === '303').title).toBe('更新后的真实秒杀');
        expect(data.widgets.find((row: Row) => row.key === '304').cards.every((row: Row) => row.name && !row.price && !row.oldPrice)).toBe(true);
        expect(data.widgets.find((row: Row) => row.key === '312').cards).toEqual([]);
      }
    }
    async function checkpoint(req: IncomingMessage, res: ServerResponse, stage: string) { return serial(async () => {
      const plan = nextPlan(); expect(stage).toBe(plan.stage); const data = JSON.parse((await bytes(req)).toString()), current = await f.snapshot(); expect(current).toEqual(expected);
      expect(data.width).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); expect(data.text).not.toMatch(/Internal Server Error|Failed to resolve|Cannot read properties|商城.*无效/u);
      const slice = traces.slice(evidence.at(-1)?.traces ?? 0), counts = widgetPaths.map(path => slice.filter(row => !row.synthetic && row.method === 'GET' && row.path === path).length);
      const wanted = widgetPaths.map(() => 0);
      if (baseStage(stage)) [2, 2, 2, 0, 2, 2, 2, 2, changed ? 1 : 2, 2].forEach((count, i) => { wanted[i] = count; });
      else if (stage === 'homeRetry') wanted[6] = 1;
      else if (stage.startsWith('promotion') && (stage.endsWith('Ready') || ['promotionCategory', 'promotionBrand', 'promotionLabel', 'promotionActivities'].includes(stage))) wanted[0] = 1;
      else if (stage === 'seckillSlot') { wanted[1] = 1; wanted[3] = 1; }
      else if (stage === 'unknownRecovered') wanted[9] = 1;
      expect(counts).toEqual(wanted);
      const closed = ['stationClosed', 'closedRetry'].includes(stage), viewer = stage === 'guestHome' || stage === 'guestClaimDestination' ? 0 : stage === 'account22' ? 22 : 11;
      if (closed) { expect(data.widgets).toEqual([]); expect(data.rendererCount).toBe(0); expect(data.community).toEqual([]); expect(data.text).toContain('站点升级中，请稍候访问'); expect(data.schemaCache.some((row: Row) => row.id === '0')).toBe(false); }
      else if (plan.href) {
        const wantedUrl = new URL('http://localhost/' + plan.href.slice(1)), actualHash = new URL(data.href).hash.replace(/^#/, ''), actualUrl = new URL(actualHash, 'http://localhost');
        expect(actualUrl.pathname).toBe(wantedUrl.pathname); for (const [key, value] of wantedUrl.searchParams) expect(actualUrl.searchParams.get(key)).toBe(value);
        expect(data.widgets).toEqual([]);
        if (plan.detail || plan.more) expect(slice.some(row => row.synthetic && (plan.detail?.test(row.path) || row.path === plan.more))).toBe(true);
      } else checkWidgets(data, stage, viewer);
      if (stage === 'closedRetry') { expect(slice.filter(row => !row.synthetic && row.path === '/api/diy/diy_version/0')).toHaveLength(1); expect(slice.some(row => row.path === '/api/diy/get_diy/0')).toBe(false); }
      if (!closed) {
        const activeId = ['microInitial', 'schemaChanged', 'couponCentreDestination'].includes(stage) ? '2' : '0', cache = data.schemaCache.find((row: Row) => row.id === activeId), row = expected.system_dise.find(item => item.id === (activeId === '0' ? 1 : 2))!;
        expect(cache).toBeDefined(); expect(cache.entry.version).toBe(row.version); expect(cache.entry.versionVerified).toBe(true); expect(cache.entry.data.value).toEqual(JSON.parse(row.value));
      }
      for (const cache of data.schemaCache) expect(JSON.stringify(cache.entry)).not.toMatch(/couponUserId|receive_source|now_money|cart_num|synthetic/u);
      const claimSlice = slice.filter(row => row.method === 'POST'); expect(claimSlice).toHaveLength(['claimAcknowledged', 'claimUnknown'].includes(stage) ? 1 : 0);
      if (['claimUnknown', 'unknownPeerProtected'].includes(stage)) expect(data.journals.find((row: Row) => row.entry.actor === 11 && row.entry.issue === 905)?.entry.state).toBe('unknown');
      if (stage === 'unknownRecovered') { expect(data.journals.find((row: Row) => row.entry.actor === 11 && row.entry.issue === 905)?.entry.state).toBe('owned'); expect(slice.filter(row => !row.synthetic && row.path === '/api/v2/coupons')).toHaveLength(1); }
      expect(storage()).toEqual(initialStorage); expect(external).not.toHaveBeenCalled();
      evidence.push({ stage, ...data, traces: traces.length, failed_bargain_key: failedKey, database_sha: digest(current), widget_read_delta: Object.fromEntries(widgetPaths.map((path, i) => [path, counts[i]])) });
      if (stage === 'finished') {
        const sourceAfter = await sourceHashes(); expect(sourceAfter).toEqual(sourceBefore);
        expect(configs).toHaveLength(4); expect(controls.map(row => row.action)).toEqual(['schema', 'close', 'open']); expect(claims.map(row => row.issue)).toEqual([901, 905]);
        expect(traces.filter(row => row.business_write)).toHaveLength(2); expect(traces.some(row => !row.synthetic && row.path === '/api/get_script' && row.status === 200)).toBe(true);
        await writeFile(prefix + 'evidence.json', JSON.stringify({ evidence, traces, configs, controls, claims, tables: f.tables, sequences: f.sequences, initial_snapshot: initial, final_snapshot: current,
          initial_sha: digest(initial), final_sha: digest(current), storage: { initial: initialStorage, final: storage(), acceptance_put_delta: 0, acceptance_delete_delta: 0 }, providerCalls: 0,
          businessWrites: 2, claimPOSTsByActorIssue: { '11:901': 1, '11:905': 1 }, static_paths: [...staticPaths].sort(), sourceHashes: { before: sourceBefore, after: sourceAfter, unchanged: true },
          authority: 'Actual built H5 DOM/createApp/JWT/owned PG16. All seven H5 families, real pink, real coupon transactions, full row/sequence GET equality, exact claim receipts. Live intentionally absent in H5. Admin schema parser/version transaction runs in fixture host.',
          limitations: 'Initial fixture/auth/route/viewport/checkpoint controls are synthetic test setup. Destination GETs return explicitly synthetic refusal/empty chrome only: no claim of destination detail, SKU, purchase, analytics or provider acceptance. Account changes create fresh iframe sessions, not in-place auth proof. Marketing routes retain existing station policy; root close is proven through real DIY version/page guard. No production ACL/index/KV/R2, MP/App-device or global persistent-cache-purge claim.' }, null, 2) + '\n'); done();
      }
      json(res, { checked: evidence.map(row => row.stage), finished: stage === 'finished', failed_bargain_key: failedKey, retry_selector: failedKey ? `[data-component-key="${failedKey}"] .commerce-refresh` : null });
    }); }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DIY商城后台验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px;border:1px solid #ddd}pre{max-height:65px;overflow:auto}</style><h1>实际商城组件与领券验收</h1>${Object.entries(routes).map(([key, route]) => `<button data-route="${key}">${route.label}</button>`).join('')}<button data-size>375像素内容区</button><button data-action="schema">更新schema配置（真实fixture Admin保存）</button><button data-action="close">站点关闭（仅fixture）</button><button data-action="open">站点开启（仅fixture）</button>${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际DIY商城页面"></iframe><script>
const frame=document.querySelector('iframe'),routes=${JSON.stringify(routes)},actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};
for(const key of ['cinashop_diy_page_v1_0','cinashop_diy_page_v1_2','cinashop_diy_coupon_claim_v1_11_901','cinashop_diy_coupon_claim_v1_11_905'])localStorage.removeItem(key);
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const route=routes[b.dataset.route];localStorage.setItem('uni_token',JSON.stringify({type:'string',data:route.uid===11?actor:route.uid===22?other:''}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:route.uid}));frame.src='/?diy_commerce_session='+route.uid+'-'+Date.now()+'#'+route.route;};
document.querySelector('[data-size]').onclick=()=>{const d=frame.contentDocument;frame.style.width=(375+frame.contentWindow.innerWidth-d.documentElement.clientWidth)+'px';};
for(const b of document.querySelectorAll('[data-action]'))b.onclick=async()=>{const r=await fetch('${control}/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.action})});document.getElementById('result').textContent=JSON.stringify(await r.json());};
const visible=e=>{if(!e)return false;for(let p=e;p;p=p.parentElement)if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return false;return true;},txt=e=>visible(e)?e.textContent.trim().replace(/\\s+/g,' '):'';
const decode=key=>{const serialized=localStorage.getItem(key);let entry=JSON.parse(serialized);if(entry&&Object.keys(entry).length===2&&['object','string','number','boolean','undefined'].includes(entry.type)&&typeof entry.data===entry.type)entry=entry.data;if(typeof entry==='string')entry=JSON.parse(entry);return{key,id:key.replace('cinashop_diy_page_v1_',''),serialized,entry};};
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{const d=frame.contentDocument,all=(s,p=d)=>[...p.querySelectorAll(s)].filter(visible),one=(s,p=d)=>all(s,p)[0],image=e=>one('img',e)?.src||e?.getAttribute('src')||'',disabled=e=>!!e&&(e.disabled===true||e.hasAttribute('disabled')&&e.getAttribute('disabled')!=='false'||e.getAttribute('aria-disabled')==='true'||e.classList.contains('uni-button-disabled')),style=(e)=>e?{borderRadius:getComputedStyle(e).borderRadius,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundImage,fontSize:getComputedStyle(e).fontSize}:{},data={href:frame.contentWindow.location.href,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:txt(d.body),rendererCount:all('.diy-renderer').length,community:all('.diy-community-post-title').map(txt),schemaCache:Object.keys(localStorage).filter(k=>k.startsWith('cinashop_diy_page_v1_')).sort().map(key=>{const{serialized,...cache}=decode(key);return{...cache,serializedBytes:new TextEncoder().encode(serialized).length};}),journals:Object.keys(localStorage).filter(k=>k.startsWith('cinashop_diy_coupon_claim_v1_')).sort().map(decode),widgets:all('.diy-commerce').map(e=>({key:e.dataset.componentKey,kind:e.dataset.kind,style:e.dataset.style,layout:e.dataset.layout,text:txt(e),error:txt(one('.commerce-error',e)),title:txt(one('.commerce-section-title',e)),titleImage:one('.commerce-heading-image',e)?image(one('.commerce-heading-image',e)):'',panel:style(one('.commerce-panel',e)),heading:style(one('.commerce-heading',e)),more:txt(one('.commerce-more',e)),pink:txt(one('.commerce-pink',e)),countdown:txt(one('.commerce-countdown',e)),navigationLayout:e.dataset.kind==='promotionList'?(()=>{const nav=one('.promotion-nav',e),active=one('.promotion-tab.active',e),r=active.getBoundingClientRect(),hit=d.elementFromPoint(r.x+r.width/2,r.y+r.height/2),headers=all('uni-page-head,.uni-page-head',d);return{navTop:nav.getBoundingClientRect().top,headerBottom:Math.max(0,...headers.map(h=>h.getBoundingClientRect().bottom)),activeHit:!!hit&&(active===hit||active.contains(hit))};})():null,selectedTab:one('.promotion-tab.active',e)?.dataset.tab||'',selectedSlot:one('.commerce-slot.active',e)?.dataset.slotId||'',tabs:all('.promotion-tab',e).map(t=>({index:t.dataset.tab,text:txt(t),image:one('uni-image',t)?image(one('uni-image',t)):'',active:t.classList.contains('active')})),slots:all('.commerce-slot',e).map(s=>({id:s.dataset.slotId,text:txt(s),active:s.classList.contains('active')})),cards:all('.commerce-card',e).map(c=>({id:c.dataset.productId||c.dataset.cardId,name:txt(one('.commerce-title',c)),price:txt(one('.commerce-price',c)),oldPrice:txt(one('.commerce-old-price',c)),points:txt(one('.commerce-points-price',c)),people:txt(one('.commerce-bargain-count,.commerce-combination-count',c)),image:one('.commerce-image',c)?image(one('.commerce-image',c)):'',copy:txt(one('.commerce-copy',c))})),coupons:all('.commerce-coupon',e).map(c=>({id:c.dataset.couponId,money:txt(one('.coupon-money',c)),condition:txt(one('.coupon-condition',c)),label:txt(one('.coupon-claim',c)),disabled:disabled(one('.coupon-claim',c))})),centre:txt(one('.coupon-centre',e)),reconcile:txt(one('.coupon-reconcile',e)),claimNotice:txt(one('.coupon-notice',e))}))};const r=await fetch('${control}/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await r.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path === control + '/configure' && req.method === 'POST') return configure(req, res);
      if (path.startsWith(control + '/') && req.method === 'POST') return checkpoint(req, res, path.slice(control.length + 1));
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return synthetic(req, res, url, chrome[path], 'unrelated home/navigation chrome');
      const plan = nextPlan();
      if (req.method === 'GET' && plan?.href && (plan.detail?.test(path) || path === plan.more || plan.more && path === '/api/user/info'))
        return synthetic(req, res, url, path === '/api/coupons' ? [] : null, `registered destination only: ${plan.stage}; no detail/business material`, path === '/api/coupons' ? 200 : 400);
      if (path === '/api/products' && !['ids', 'cate_id', 'brand_id', 'store_label_id'].some(key => url.searchParams.has(key))) return synthetic(req, res, url, { list: [], count: 0 }, 'unrelated root ordinary recommendation chrome');
      if (path.startsWith('/api/')) return api(req, res, url); if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) { staticPaths.add(path); return send(res, await readFile(target), 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' } as Row)[extname(target)] ?? 'application/octet-stream'); } } catch { /* Actual SPA fallback. */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(reason => { fail(reason instanceof Error ? reason : Error(String(reason))); if (!res.headersSent) send(res, String(reason), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40769, '127.0.0.1', yes); });
      const ready = { url: origin + control, stages, routes, actions: plans.map(plan => ({ stage: plan.stage, action: plan.action, href: plan.href })), width: 375, tables: f.tables.length, sequences: f.sequences.length, sourceHashes: sourceBefore,
        business_writes: 2, deliberate_visits: 0, R2_seed_puts: 1, exact_config_receipts: 4, exact_claim_receipts: 2,
        deadlines: { server_minutes: 8, test_minutes: 9, targeted_native_runner_minutes: 10, browser_mode_runner_minutes: 25 },
        initial_fixture_preparation: 'shared native helper supplies real brand703/label704/product601 relations and five PHP-authored promotion tabs; Browser changes fourteen H5 config variants before its initial snapshot; no production DB',
        selectors: { widget: '.diy-commerce[data-component-key]', singleRetryFromHomeFirst: 'retry_selector', firstPromotion: '[data-component-key="301"]', couponSuccess: '[data-component-key="313"] [data-coupon-id="901"] .coupon-claim',
          couponUnknown: '[data-component-key="313"] [data-coupon-id="905"] .coupon-claim', reconcile: '[data-component-key="313"] .coupon-reconcile', rootRetry: '.diy-error button' } };
      await writeFile(prefix + 'ready.json', JSON.stringify(ready, null, 2) + '\n'); process.stdout.write('DIY_COMMERCE_BROWSER_READY ' + JSON.stringify(ready) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent within owned eight-minute window')), 8 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 9 * 60_000);
