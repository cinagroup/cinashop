/** Actual built H5 + registered Worker + JWT + owned PG16. No business response
 * is synthesized. QA session, transport delivery and exact SQL empty-state
 * controls are separately recorded. Ordinary detail visit writes are measured. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { memberLevelRecommendationsBrowserFixture } from '../helpers/memberLevelRecommendationsBrowserFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned recommendation Browser DB required'); return wiring.container;
} }));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
const phases = ['guest', 'member-home', 'member-initial', 'page2-lost', 'page2-retried', 'page3-final', 'terminal-scroll', 'refresh',
  'ordinary-detail', 'ordinary-returned', 'seckill-detail', 'seckill-returned', 'late-read', 'owner22', 'empty', 'restored', 'desktop'];
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]))).flat().sort(); }
async function body(req: IncomingMessage) { let count = 0; const chunks: Buffer[] = []; for await (const item of req) { const bytes = Buffer.from(item); count += bytes.length; expect(count).toBeLessThanOrEqual(524288); chunks.push(bytes); } return Buffer.concat(chunks); }
function one(rows: Row[], key: string, value: unknown) { const found = rows.filter(row => row[key] === value); expect(found).toHaveLength(1); return found[0]!; }
function visitOracle(before: DiyStateSnapshot, after: DiyStateSnapshot, uid: number, id: number, start: number, end: number) {
  const expected = structuredClone(before);
  function serial(name: string) { const row = one(expected.__sequences, 'name', name); const next = Number(BigInt(row.last) + (row.called ? 1n : 0n)); row.last = String(next); row.called = true; return next; }
  const logId = serial('store_product_log_id_seq'), actualLog = one(after.store_product_log, 'id', logId), at = actualLog.add_time;
  expect(at).toBeGreaterThanOrEqual(Math.floor(start / 1000)); expect(at).toBeLessThanOrEqual(Math.floor(end / 1000));
  expected.store_product_log.push({ id: logId, type: 'visit', product_id: id, uid, visit_num: 1, cart_num: 0, order_num: 0, pay_num: 0,
    pay_price: 0, cost_price: 0, pay_uid: 0, refund_num: 0, refund_price: 0, collect_num: 0, add_time: at, delete_time: null });
  const existing = expected.store_visit.filter(row => row.uid === uid && row.product_id === id && row.product_type === 'product').sort((a, b) => b.id - a.id)[0];
  if (!existing) expected.store_visit.push({ id: serial('store_visit_id_seq'), product_id: id, product_type: 'product', cate_id: id, type: 'view'.padEnd(50, ' '), uid, count: 1, content: '', add_time: at });
  else if (existing.add_time + 20 < at) Object.assign(existing, { count: existing.count + 1, cate_id: id, add_time: at });
  expect(after).toEqual(sortedDiyState(expected)); return { kind: 'actual-ordinary-detail-visit', owner: uid, product_id: id, log_id: logId, at };
}
it('ordinary level recommendations original UI consumes actual paginated media/targets and measured detail visits', async () => {
  const f = await memberLevelRecommendationsBrowserFixture(), repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  const prefix = '/tmp/cinashop-member-level-recommendations-browser-', origin = 'http://127.0.0.1:40864', control = '/__member_level_recommendations/' + randomUUID();
  let server: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined, failure: unknown, failedDispatch: Row | null = null;
  const evidence: Row[] = [], traces: Row[] = [], controls: Row[] = [], staticPaths: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
  let expected = await f.snapshot(), uid = 0, queue = Promise.resolve(), pending = 0, queued = 0, nextLost = false, nextHeld = false;
  let held: { res: ServerResponse; raw: Buffer; status: number; headers: Record<string, string>; trace: number } | undefined;
  let finish!: () => void, fail!: (error: unknown) => void;
  const complete = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const stage = () => phases[evidence.length], idle = () => ({ pending, queued, held: held !== undefined, next_lost: nextLost, next_held: nextHeld });
  const remember = (value: DiyStateSnapshot) => { const sha = digest(value); snapshots[sha] ??= structuredClone(value); return sha; };
  const serial = (run: () => Promise<void>) => { queued++; const result = queue.then(run).finally(() => { queued--; }); queue = result.catch(() => {}); return result; };
  const json = (res: ServerResponse, value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const sources = async () => {
    const names = [...(await Promise.all(['workers-ts/src', 'workers-ts/test/helpers', 'view/uniapp-ts/src', 'view/uniapp-ts/scripts', 'view/common'].map(name => files(resolve(repository, name))))).flat(),
      ...['workers-ts/test/browser/member-level-recommendations.acceptance.ts', 'workers-ts/vitest.member-level-recommendations-browser.config.ts', 'workers-ts/test/member-level-recommendations-postgres.test.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/package.json', 'workers-ts/package-lock.json', 'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json'].map(name => resolve(repository, name))];
    return Promise.all([...new Set(names)].sort().map(async name => { const bytes = await readFile(name); return { path: name.slice(repository.length + 1), bytes: bytes.length, sha256: hash(bytes) }; }));
  };
  const builds = async () => Promise.all((await files(dist)).map(async name => { const bytes = await readFile(name); return { path: name.slice(repository.length + 1), bytes: bytes.length, sha256: hash(bytes) }; }));
  let sourceBefore: Awaited<ReturnType<typeof sources>> = [], buildBefore: Awaited<ReturnType<typeof builds>> = [];
  const baseline = structuredClone(expected), resourceBaseline = f.resources(); remember(f.setup.before); remember(baseline);
  async function persist() { await writeFile(prefix + 'in-progress.json', JSON.stringify({ status: 'in_progress', control, stage: stage(), phases, evidence, traces, controls, staticPaths,
    snapshots_by_sha256: snapshots, fixture_setup: f.setup, baseline, current: expected, resources: f.resources(), activity: idle(), failed_dispatch: failedDispatch }, null, 2) + '\n', { mode: 0o600 }); }
  try {
    wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Recommendation Browser prohibits external provider I/O'));
    const decoration = await readFile(resolve(repository, 'view/uniapp-ts/src/static/php-assets/images/recommend_zs.png'));
    expect(decoration.length).toBe(1619); expect(hash(decoration)).toBe('ea7291eb21857a4178478ff5c34a606bdd0240aabea8a1d8392e52733b859a5b');
    sourceBefore = await sources(); buildBefore = await builds(); expect(buildBefore.length).toBeGreaterThan(300);
    const app = createApp();
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      pending++; let delivery: { raw: Buffer; status: number; headers: Record<string, string>; trace: number; lost: boolean; hold: boolean } | undefined;
      try {
        expect(['GET', 'HEAD']).toContain(req.method); const requestBytes = await body(req); expect(requestBytes.length).toBe(0);
        await serial(async () => {
          const before = await f.snapshot(), beforeResources = f.resources(); expect(before).toEqual(expected); expect(beforeResources).toEqual(resourceBaseline);
          const authorization = String(req.headers['authori-zation'] ?? req.headers.authorization ?? ''), actor = [11, 22].find(id => authorization === 'Bearer ' + f.tokens.get(id)) ?? 0;
          if (authorization) expect(actor).toBeGreaterThan(0);
          const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && !['host', 'connection', 'content-length'].includes(key)) headers.set(key, value);
          const jobs: Promise<unknown>[] = [], started = Date.now(), beforeGets = f.bucket.get.mock.calls.length;
          failedDispatch = { index: traces.length, stage: stage(), method: req.method, path: url.pathname, query: url.search, started_at_ms: started,
            before_sha256: remember(before), request: { actual_user_uid: actor, authorization_sha256: hash(authorization), authorization, form_type: String(req.headers['form-type'] ?? ''), body_bytes: 0, body_sha256: hash(requestBytes), body_base64: '' } };
          const response = await app.fetch(new Request(origin + url.pathname + url.search, { method: req.method, headers }), f.env,
            { waitUntil: (job: Promise<unknown>) => jobs.push(job), passThroughOnException: () => {} } as never);
          const raw = Buffer.from(await response.arrayBuffer()); const settled = await Promise.allSettled(jobs); expect(settled.every(result => result.status === 'fulfilled')).toBe(true);
          const completed = Date.now(); expect(response.status, raw.toString()).toBe(200);
          let dto: Row | null = null; try { dto = JSON.parse(raw.toString()) as Row; } catch {}
          if (dto) expect(dto.status, raw.toString()).toBe(200);
          const after = await f.snapshot(); let classification: Row = { kind: 'actual-read' };
          const detail = /^\/api\/product\/detail\/([1-9]\d*)(?:\/0)?$/.exec(url.pathname);
          if (detail) { expect(Number(detail[1])).toBe(191022); expect(stage()).toBe('ordinary-detail'); expect(actor).toBe(11); classification = visitOracle(before, after, actor, Number(detail[1]), started, completed); expect(jobs.length).toBe(1); }
          else expect(after).toEqual(before);
          expect(f.resources()).toEqual(resourceBaseline);
          if (url.pathname === '/api/product/hot') {
            expect(url.searchParams.get('view')).toBe('member_level'); expect(url.searchParams.get('limit')).toBe('10'); expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'page', 'view']);
            expect(actor).toBe(uid); expect(actor).toBeGreaterThan(0); expect(response.headers.get('cache-control')).toBe('private, no-store');
            const page = Number(url.searchParams.get('page')), data = dto!.data as Row;
            expect(Object.keys(data).sort()).toEqual(['limit', 'list', 'owner_uid', 'page']); expect(data).toMatchObject({ owner_uid: actor, page, limit: 10 });
            const ids = before.store_product.filter(row => row.is_hot === 1 && f.productIds.includes(row.id)).sort((a, b) => b.sort - a.sort || b.id - a.id).slice((page - 1) * 10, page * 10).map(row => row.id);
            expect(data.list.map((row: Row) => row.id)).toEqual(ids);
            for (const row of data.list) { const product = one(before.store_product, 'id', row.id); expect(row).toMatchObject({ store_name: product.store_name, price: product.price === 12 ? '12.00' : '12.30', brand_name: '原版品牌', is_vip: 1, vip_price: '9.90', price_type: 'member', image_source: f.platformImage.url });
              expect(row.image).toMatch(/^\/api\/assets\/[1-9]\d*\?expires=\d+&signature=[A-Za-z0-9_-]+$/u); expect(row.activity_frame).toMatchObject({ id: 191001, name: '本机透明边框', image_source: f.frame.url });
              expect(row.activity_frame.image).toMatch(/^\/api\/assets\/[1-9]\d*\?expires=\d+&signature=[A-Za-z0-9_-]+$/u);
              expect(row.store_label).toHaveLength(1); expect(row.store_label[0]).toMatchObject({ id: 704, label_name: '本机标签' });
              expect(row.recommendation_target).toMatchObject(row.id === 602 ? { version: 1, product_id: 602, kind: 'seckill', id: 1701 } : { version: 1, product_id: row.id, kind: 'product', id: row.id, ends_at: null }); }
            classification = { kind: 'actual-owner-hot-page', owner: actor, page, ids };
          } else if (url.pathname.startsWith('/api/assets/')) {
            const attachment = one(before.system_attachment, 'att_id', Number(url.pathname.split('/').at(-1))), object = f.objects.get(attachment.name); expect(object).toBeDefined(); expect(hash(raw)).toBe(hash(object!.bytes));
            expect(f.bucket.get.mock.calls.length).toBe(beforeGets + 1); classification = { kind: 'actual-r2-image-read', attachment_id: attachment.att_id, object_key: attachment.name, bytes: raw.length, sha256: hash(raw) };
          } else if (url.pathname === '/api/get_script') { const config = before.system_config.filter(row => row.menu_name === 'system_statistics').at(-1); expect(raw.toString()).toBe(config ? JSON.parse(config.value) : ''); classification = { kind: 'configured-statistics-js', source: 'system_config/system_statistics', bytes: raw.length, sha256: hash(raw) }; }
          else if (url.pathname === '/api/user/level/detection') classification = { kind: 'actual-pregranted-level-detection', owner: actor, business_state_unchanged: true, physical_update_not_claimed_absent: true };
          const responseHeaders = Object.fromEntries(response.headers), index = traces.length;
          const isHot = url.pathname === '/api/product/hot', lost = nextLost && isHot && Number(url.searchParams.get('page')) === 2, hold = nextHeld && isHot;
          if (lost) { expect(stage()).toBe('page2-lost'); nextLost = false; }
          if (hold) { expect(stage()).toBe('late-read'); expect(actor).toBe(11); nextHeld = false; }
          traces.push({ ...failedDispatch, completed_at_ms: completed, after_sha256: remember(after), resources_before: beforeResources, resources_after: f.resources(), wait_until_jobs: jobs.length,
            wait_until_fulfilled: settled.length, worker_response: { http_status: response.status, headers: responseHeaders, body_bytes: raw.length, body_sha256: hash(raw), body_base64: raw.toString('base64'), json: dto },
            classification, delivery: lost ? 'truncated-real-200-prefix' : hold ? 'held-real-response' : 'normal' });
          expected = after; failedDispatch = null; await persist(); delivery = { raw, status: response.status, headers: responseHeaders, trace: index, lost, hold };
        });
      } finally { pending--; }
      if (!delivery) return; const item = delivery as { raw: Buffer; status: number; headers: Record<string, string>; trace: number; lost: boolean; hold: boolean };
      if (item.hold) { held = { res, raw: item.raw, status: item.status, headers: item.headers, trace: item.trace }; await persist(); return; }
      if (item.lost) { const bytes = item.raw.subarray(0, Math.max(1, Math.floor(item.raw.length / 2))); expect(bytes.length).toBeLessThan(item.raw.length);
        controls.push({ kind: 'qa-real-response-prefix-truncated', nonproof: true, stage: stage(), trace_index: item.trace, mode: 'real-worker-200-prefix',
          declared_bytes: item.raw.length, wire_bytes: bytes.length, wire_sha256: hash(bytes), wire_base64: Buffer.from(bytes).toString('base64'), worker_prefix: true });
        res.writeHead(item.status, { ...item.headers, 'Content-Length': String(item.raw.length), Connection: 'close' }); res.write(bytes); await new Promise<void>(yes => setTimeout(yes, 100)); res.destroy(); await persist(); return; }
      res.writeHead(item.status, item.headers); res.end(item.raw);
    }
    const hot = (owner: number) => traces.filter(trace => trace.classification.kind === 'actual-owner-hot-page' && trace.request.actual_user_uid === owner);
    async function capture(name: string, data: Row) {
      expect(name).toBe(stage()); expect(data.active_page_count).toBe(1); expect(data.raw_document_images_preserved).toBe(true); expect(data.errors).toEqual([]);
      expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth + 2); expect(data.captured_at_ms).toBeGreaterThan(0); expect(pending).toBe(0); expect(queued).toBeLessThanOrEqual(1);
      const current = await f.snapshot(); expect(current).toEqual(expected); expect(f.resources()).toEqual(resourceBaseline);
      if (name === 'guest') { expect(uid).toBe(0); expect(data.owner).toBe(0); expect(data.products).toEqual([]); expect(data.text).toContain('登录后查看会员等级'); expect(hot(0)).toEqual([]); }
      else if (name === 'member-home') { expect(uid).toBe(11); expect(data.href).toContain('/pages/index/index'); expect(data.text).toContain('会员等级'); expect(traces.some(trace => trace.path === '/api/diy/get_diy/0')).toBe(true); }
      else if (name === 'ordinary-detail') { expect(data.href).toContain('/pages/goods/detail?id=191022'); expect(data.text).toContain('原版推荐商品22'); expect(traces.filter(trace => trace.classification.kind === 'actual-ordinary-detail-visit')).toHaveLength(1); }
      else if (name === 'seckill-detail') { expect(data.href).toContain('/pages/activity/seckillDetail?id=1701'); expect(data.text).toContain('真实秒杀1701'); expect(traces.some(trace => trace.path.includes('/seckill/detail/1701'))).toBe(true); }
      else {
        expect(data.href).toContain('/pages/user/level'); expect(data.owner).toBe(uid); const owner = uid, latest = hot(owner).at(-1); expect(latest).toBeDefined();
        const currentIds = data.products.map((row: Row) => row.id); let count = 10;
        if (['page2-retried'].includes(name)) count = 20;
        if (['page3-final', 'terminal-scroll'].includes(name)) count = 23;
        if (name === 'empty' || name === 'late-read') count = 0;
        expect(currentIds).toHaveLength(count); expect(new Set(currentIds).size).toBe(count);
        if (name === 'page2-lost') { expect(data.text).toContain('重试商品推荐'); expect(hot(11).filter(trace => trace.classification.page === 2)).toHaveLength(1); expect(traces.some(trace => trace.delivery === 'truncated-real-200-prefix')).toBe(true); }
        else if (name === 'page2-retried') expect(hot(11).filter(trace => trace.classification.page === 2)).toHaveLength(2);
        else if (name === 'page3-final') expect(hot(11).filter(trace => trace.classification.page === 3)).toHaveLength(1);
        else if (name === 'terminal-scroll') { expect(hot(11).length).toBe(evidence.at(-1)!.hot_count_11); expect(data.text).toContain('没有更多推荐了'); }
        else if (name === 'late-read') { expect(held).toBeTruthy(); expect(data.text).toContain('正在加载商品推荐'); }
        else if (name === 'owner22') { expect(uid).toBe(22); expect(held).toBeUndefined(); expect(controls.some(item => item.kind === 'qa-old-owner-response-released')).toBe(true); }
        if (count) {
          const page = name === 'page2-lost' ? 1 : Math.ceil(count / 10), available = hot(owner).filter(trace => trace.delivery === 'normal' && trace.classification.page <= page);
          const matching = new Map<number, Row>(); for (const trace of available) for (const row of trace.worker_response.json.data.list) matching.set(row.id, row);
          expect(currentIds).toEqual(current.store_product.filter(row => f.productIds.includes(row.id) && row.is_hot === 1).sort((a, b) => b.sort - a.sort || b.id - a.id).slice(0, count).map(row => row.id));
          for (const row of data.products) { const source = matching.get(row.id); expect(source).toBeDefined(); expect(row.text).toContain(source!.store_name); expect(row.text).toContain('原版品牌'); expect(row.text).toContain('本机标签'); expect(row.text).toContain(source!.price); expect(row.text).toContain('9.90');
            expect(row.images.filter((image: Row) => image.className.includes('recommendation-image') || image.parentClassName.includes('recommendation-image'))).toHaveLength(1);
            for (const image of row.images) { expect(image.complete).toBe(true); expect(image.naturalWidth).toBeGreaterThan(0); const path = new URL(image.currentSrc || image.src).pathname + new URL(image.currentSrc || image.src).search;
              expect([source!.image, source!.activity_frame.image, ...source!.store_label.map((label: Row) => label.icon)]).toContain(path);
              expect(traces.some(trace => trace.classification.kind === 'actual-r2-image-read' && trace.path + trace.query === path)).toBe(true); }
          }
          expect(data.images.some((image: Row) => image.src.endsWith('/static/php-assets/images/recommend_zs.png') && image.complete && image.naturalWidth === 42)).toBe(true);
        }
        if (name === 'desktop') { expect(data.frameWidth).toBe(1000); expect(data.gridColumns).toBe(2); expect(current).toEqual(snapshots[evidence.at(-1)!.snapshot_sha256]); }
      }
      evidence.push({ name, snapshot_sha256: remember(current), resources: f.resources(), trace_count: traces.length, hot_count_11: hot(11).length,
        source_links: hot(uid).map(trace => trace.index), dom: data });
      expect(await sources()).toEqual(sourceBefore); expect(await builds()).toEqual(buildBefore); await persist(); if (evidence.length === phases.length) finish();
    }
    const shell = `<!doctype html><html><head><meta charset="utf-8"><title>会员等级推荐真实验收</title><link rel="icon" href="data:,"></head><body><h1>会员等级推荐真实验收</h1><p>真实H5、Worker/JWT与独立PG16。QA会话/200正文截断/旧响应延迟/空列表SQL控制单独记账；仅商品详情产生真实浏览记录，不测试支付或加购。</p>
<button id="guest">访客等级页</button><button id="home">会员11真实首页旧入口</button><button id="member">重开会员11等级页</button><button id="other">会员22等级页</button><button id="lost">截断下一页2真实200正文</button><button id="late">延迟会员11下一推荐读</button><button id="release">释放旧会员11真实响应</button><button id="empty">配置空推荐并打开22</button><button id="restore">恢复23商品并打开11</button><button id="wide">桌面宽度</button><button id="back">真实页面返回</button>
${phases.map(name => '<button data-phase="' + name + '">记录 ' + name + '</button>').join('')}<pre id="result">待验收</pre><iframe title="会员等级推荐实际H5" style="display:block;width:375px;height:1000px;border:1px solid #ddd"></iframe><script>
let frame=document.querySelector('iframe'),errors=[];const result=document.querySelector('#result'),control=${JSON.stringify(control)};
function wire(target){target.onload=event=>{const w=event.currentTarget?.contentWindow;if(!w)return;w.addEventListener('error',e=>errors.push(String(e.message)));w.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)))}}wire(frame);
async function qa(path){const response=await fetch(control+path,{method:'POST'}),data=await response.json();result.textContent=JSON.stringify(data);return data}
async function open(uid,route='/pages/user/level',hold=false){const data=await qa('/user?uid='+uid+(hold?'&hold=1':''));if(!data.accepted)return;
if(uid){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:data.token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}))}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid')}
errors=[];const old=frame,fresh=old.cloneNode(false);fresh.removeAttribute('src');frame=fresh;wire(fresh);old.replaceWith(fresh);fresh.src='/__h5#'+route;}
document.querySelector('#guest').onclick=()=>open(0);document.querySelector('#home').onclick=()=>open(11,'/pages/index/index');document.querySelector('#member').onclick=()=>open(11);document.querySelector('#other').onclick=()=>open(22);
document.querySelector('#lost').onclick=()=>qa('/lost');document.querySelector('#late').onclick=()=>open(11,'/pages/user/level',true);document.querySelector('#release').onclick=()=>qa('/release');
document.querySelector('#empty').onclick=async()=>{if((await qa('/empty?value=1')).accepted)await open(22)};document.querySelector('#restore').onclick=async()=>{if((await qa('/empty?value=0')).accepted)await open(11)};
document.querySelector('#wide').onclick=()=>frame.style.width='1000px';document.querySelector('#back').onclick=()=>frame.contentWindow.history.back();
for(const button of document.querySelectorAll('[data-phase]'))button.onclick=async()=>{button.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,rendered=n=>{if(!n||n.getBoundingClientRect().width<=0||n.getBoundingClientRect().height<=0)return false;for(let a=n;a&&a.nodeType===1;a=a.parentElement){const s=w.getComputedStyle(a);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse')return false}return true},shown=n=>{if(!rendered(n))return false;const r=n.getBoundingClientRect();return r.right>0&&r.left<w.innerWidth&&r.bottom>0&&r.top<w.innerHeight},pages=[...d.querySelectorAll('uni-page')].filter(shown),p=pages.at(-1)||d,
txt=n=>(n?.textContent||'').trim(),images=n=>[...n.querySelectorAll('img')].map(i=>({src:i.src,currentSrc:i.currentSrc,complete:i.complete,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,className:i.className,parentClassName:i.parentElement?.className||'',rendered:rendered(i),viewport_visible:shown(i)})),rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
const grid=p.querySelector('.recommendation-grid'),data={captured_at_ms:Date.now(),active_page_count:pages.length,raw_document_images_preserved:true,href:w.location.href,frameWidth:frame.clientWidth,viewportWidth:w.innerWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:p.innerText,errors:[...errors],owner:Number(p.querySelector('[data-level-owner]')?.getAttribute('data-level-owner')||0),page:Number(p.querySelector('[data-level-recommendation-page]')?.getAttribute('data-level-recommendation-page')||0),
products:[...p.querySelectorAll('[data-level-product-id]')].map(row=>({id:Number(row.getAttribute('data-level-product-id')),text:txt(row),label:row.getAttribute('aria-label'),rect:rect(row),images:images(row)})),gridColumns:grid?w.getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length:0,images:images(d),current_images:images(p),loading_texts:[...p.querySelectorAll('[role="status"]')].filter(rendered).map(txt).filter(t=>/正在|加载中/u.test(t)),buttons:[...p.querySelectorAll('button,uni-button')].map(txt)};
const response=await fetch(control+'/phase/'+button.dataset.phase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});result.textContent=await response.text()}catch(error){result.textContent=String(error)}finally{button.disabled=false}};open(0);
</script></body></html>`;
    server = createServer((req, res) => { void (async () => {
      expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe('127.0.0.1:40864'); const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith(control)) {
        expect(req.method).toBe('POST');
        if (url.pathname === control + '/user') {
          if (pending || queued) { json(res, { accepted: false, reason: 'business-resources-busy', activity: idle() }); return; }
          const actor = Number(url.searchParams.get('uid')); expect([0, 11, 22]).toContain(actor);
          if (url.searchParams.get('hold') === '1') { expect(stage()).toBe('late-read'); expect(actor).toBe(11); expect(held).toBeUndefined(); nextHeld = true; }
          uid = actor; controls.push({ kind: 'qa-user-session-new-document', nonproof: true, stage: stage(), owner: uid, snapshot_sha256: remember(await f.snapshot()), trace_count: traces.length, activity: idle() });
          await persist(); json(res, { accepted: true, token: f.tokens.get(uid) ?? '', activity: idle() }); return;
        }
        if (url.pathname === control + '/lost') {
          if (pending || queued) { json(res, { accepted: false, reason: 'business-resources-busy', activity: idle() }); return; }
          expect(stage()).toBe('page2-lost'); expect(uid).toBe(11); expect(nextLost).toBe(false); nextLost = true;
          controls.push({ kind: 'qa-next-page2-delivery-truncated', nonproof: true, stage: stage(), trace_count: traces.length }); await persist(); json(res, { accepted: true, activity: idle() }); return;
        }
        if (url.pathname === control + '/release') {
          if (pending || queued) { json(res, { accepted: false, reason: 'business-resources-busy', activity: idle() }); return; }
          expect(stage()).toBe('owner22'); expect(uid).toBe(22); expect(held).toBeDefined(); const prior = held!; held = undefined;
          controls.push({ kind: 'qa-old-owner-response-released', nonproof: true, stage: stage(), trace_index: prior.trace, socket_destroyed: prior.res.destroyed, snapshot_sha256: remember(await f.snapshot()) });
          if (!prior.res.destroyed) { prior.res.writeHead(prior.status, prior.headers); prior.res.end(prior.raw); } await persist(); json(res, { accepted: true, released: true, activity: idle() }); return;
        }
        if (url.pathname === control + '/empty') {
          if (pending || queued || held) { json(res, { accepted: false, reason: 'business-resources-busy', activity: idle() }); return; }
          const empty = url.searchParams.get('value') === '1'; expect(stage()).toBe(empty ? 'empty' : 'restored');
          await serial(async () => { expect(await f.snapshot()).toEqual(expected); const change = await f.setEmpty(empty), derived = structuredClone(change.before);
            for (const row of derived.store_product) if (f.productIds.includes(row.id)) row.is_hot = empty ? 0 : 1;
            expect(change.after).toEqual(sortedDiyState(derived)); expect(f.resources()).toEqual(resourceBaseline); expected = change.after;
            controls.push({ kind: 'qa-fixture-hot-visibility', nonproof: true, stage: stage(), empty, product_ids: f.productIds,
              before_sha256: remember(change.before), after_sha256: remember(change.after), resources: f.resources() }); await persist(); json(res, { accepted: true, activity: idle() }); }); return;
        }
        if (url.pathname.startsWith(control + '/phase/')) {
          const data = JSON.parse((await body(req)).toString()) as Row, name = url.pathname.slice((control + '/phase/').length);
          if (pending || queued || data.active_page_count !== 1 || name !== 'late-read' && (data.loading_texts.length || data.current_images.some((image: Row) => !image.complete || image.naturalWidth <= 0))) {
            json(res, { accepted: false, reason: 'pending-business-or-image', next: stage(), activity: idle() }); return;
          }
          await serial(async () => { if (pending) { json(res, { accepted: false, reason: 'pending-business', next: stage(), activity: idle() }); return; }
            await capture(name, data); json(res, { accepted: true, name, next: stage(), complete: evidence.length === phases.length, activity: idle() }); }); return;
        }
        throw Error('Unknown owned recommendations QA control');
      }
      if (url.pathname.startsWith('/api/')) { await api(req, res, url); return; }
      expect(req.method).toBe('GET'); if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(shell); return; }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const decoded = decodeURIComponent(url.pathname), target = decoded === '/__h5' ? resolve(dist, 'index.html') : resolve(dist, '.' + decoded); expect(target.startsWith(dist + sep)).toBe(true);
      let raw = await readFile(target); const transformed = target === resolve(dist, 'index.html'); if (transformed) raw = Buffer.from(raw.toString().replace('<head>', '<head><link rel="icon" href="data:,">'));
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
      staticPaths.push({ path: decoded, file: target.slice(repository.length + 1), bytes: raw.length, sha256: hash(raw), index_transform: transformed ? 'insert-data-favicon-after-head' : null });
      res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream' }); res.end(raw);
    })().catch(error => { failure ??= error; controls.push({ kind: 'server-error', stage: stage(), path: req.url, error: String(error) });
      void persist().then(() => fail(error), () => fail(error)); if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(error)); }); });
    server.on('upgrade', (_req, socket) => { const error = Error('Recommendation Browser forbids external sockets'); failure ??= error; fail(error); socket.destroy(); });
    timer = setTimeout(() => fail(Error('Member level recommendations Browser timed out')), 40 * 60000);
    await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(40864, '127.0.0.1', yes); });
    await writeFile(prefix + 'ready.json', JSON.stringify({ origin, control, prefix, phases, tables: f.tables, sequences: f.sequences, expected_business_posts: 0,
      source_count: sourceBefore.length, build_count: buildBefore.length, product_ids: f.productIds, expected_page_sizes: [10, 10, 3],
      boundary: 'Actual built H5/registered Worker/JWT/owned PG16/local R2. QA session switches replace iframe documents; same-instance owner guards are separately covered by runtime tests. Real legacy footer action proves alias navigation, not direct alias URL initialization. Truncated delivery retains the actual Worker HTTP200 headers/body prefix; no synthetic500. Ordinary detail waitUntil jobs are drained and exact visit/log/serial changes measured. Other reads conserve every table/sequence/resource. No purchase, cart, award or live login/provider claim.' }, null, 2) + '\n', { mode: 0o600 });
    console.log('MEMBER_LEVEL_RECOMMENDATIONS_BROWSER_READY ' + origin); await complete; await queue;
    expect(traces.filter(trace => trace.method === 'POST')).toEqual([]); expect(traces.filter(trace => trace.classification.kind === 'actual-ordinary-detail-visit')).toHaveLength(1);
    expect(traces.filter(trace => trace.delivery === 'truncated-real-200-prefix')).toHaveLength(1); expect(traces.filter(trace => trace.delivery === 'held-real-response')).toHaveLength(1);
    expect(held).toBeUndefined(); expect(nextLost).toBe(false); expect(nextHeld).toBe(false); expect(f.resources()).toEqual(resourceBaseline);
    expect(await sources()).toEqual(sourceBefore); expect(await builds()).toEqual(buildBefore);
    await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed', control, phases, evidence, traces, controls, staticPaths, snapshots_by_sha256: snapshots,
      fixture_setup: f.setup, baseline, final: await f.snapshot(), resources_before: resourceBaseline, resources_after: f.resources(), sourceBefore, sourceAfter: await sources(), buildBefore, buildAfter: await builds() }, null, 2) + '\n', { mode: 0o600 });
  } catch (error) { failure ??= error; await writeFile(prefix + 'failed.json', JSON.stringify({ status: 'failed', control, error: String(error), stack: error instanceof Error ? error.stack : null,
    traces, evidence, controls, staticPaths, snapshots_by_sha256: snapshots, failed_dispatch: failedDispatch }, null, 2) + '\n', { mode: 0o600 }); throw error; }
  finally { clearTimeout(timer); let cleanup: unknown, fixtureClosed = false;
    try { if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); } } catch (error) { cleanup = error; }
    try { await f.close(); fixtureClosed = true; } catch (error) { cleanup ??= error; }
    wiring.container = undefined; vi.restoreAllMocks(); await writeFile(prefix + 'cleanup.json', JSON.stringify({ control, server_closed: !server?.listening, fixture_closed: fixtureClosed,
      failure: failure ? String(failure) : null, cleanup_failure: cleanup ? String(cleanup) : null }) + '\n', { mode: 0o600 }); if (cleanup) throw cleanup;
  }
}, 42 * 60000);
