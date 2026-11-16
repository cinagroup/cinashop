/** Browser-operated formal H5, actual App/JWT and commissioned PG16 LOGIN.
 * Shell controls synthetic actor/viewport fixtures and delay already-produced
 * HTTP responses. Product SKU, quantity and retry interactions belong to CUA. */
import { expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { storeCart, storeCouponIssue, storeCouponIssueUser, storeCouponUser, storeProduct, storeProductAttrValue, systemAttachment, systemConfig, user } from '@/models/schema';
import { decodePublicProductEstimate } from '../../../view/common/publicProductEstimate';
import { withBuyerInvoices } from '../helpers/buyerInvoices';
import { buyerReviewPng, buyerReviewR2 } from '../helpers/buyerReviewR2';

type Row = Record<string, any>;
type Snapshot = { tables: Record<string, Row[]>; sequences: Record<string, Row> };
const prefix = '/tmp/cinashop-public-product-estimate-browser-';
const ids = { product: 70, red: 1, blue: 962010, issue: 962000, lower: 962001, ownedA: 962100, ownedB: 962101, asset: 991102 };
const phases = ['a-red-mobile', 'a-blue-multiple', 'sku-race-red', 'owner-b', 'guest', 'owner-a-desktop', 'error-blue', 'retry-blue', 'actor-race-b'];
const titles = { 11: 'A原发行85.99券', 22: 'B原发行85.99券', 0: '单件可领取85.99券' };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = (value: unknown) => hash(JSON.stringify(stable(value)));
async function files(directory: string): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory() ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort();
}
async function body(req: IncomingMessage) {
  const parts: Buffer[] = []; let count = 0;
  for await (const part of req) { const bytes = Buffer.from(part); count += bytes.length; expect(count).toBeLessThanOrEqual(65536); parts.push(bytes); }
  return Buffer.concat(parts);
}

it('shows actual quantity-one estimates and fences SKU/account races without granting, reserving or quoting a checkout', async () => withBuyerInvoices(async s => {
  expect(process.env.TEST_PUBLIC_PRODUCT_ESTIMATE_BROWSER).toBe('1'); expect(s.f.format).toBe('pg16');
  const [identity] = await s.appContainer.db.execute(sql`SELECT current_user AS role,session_user AS session`);
  expect(identity).toEqual({ role: s.appRole, session: s.appRole });
  const [role] = await s.f.exec(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname='${s.appRole}'`);
  expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false });
  const repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  expect((await stat(resolve(dist, 'index.html'))).isFile()).toBe(true);
  for (const [menuName, value] of Object.entries({ member_func_status: '0', member_card_status: '0', svip_price_status: '0', newcomer_status: '0',
    first_order_status: '0', newcomer_limit_status: '0', newcomer_limit_time: '0', integral_ratio_status: '0', store_func_status: '1' })) {
    const updated = await s.f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0))).returning({ id: systemConfig.id });
    if (!updated.length) await s.f.db.insert(systemConfig).values({ menuName, value, isStore: 0 });
  }
  await s.f.db.delete(storeCart);
  await s.f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null, isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0, level: 0, levelStatus: 0, isFirstOrder: 0 });
  await s.f.db.update(user).set({ nickname: '单件预估验收A' }).where(eq(user.uid, 11));
  await s.f.db.update(user).set({ nickname: '单件预估验收B' }).where(eq(user.uid, 22));
  const r2 = buyerReviewR2(), imageName = 'attachments/admin/1/public_product_estimate.png';
  r2.objects.set(imageName, { bytes: buyerReviewPng.slice(), contentType: 'image/png' }); Object.assign(s.env, { ASSETS_BUCKET: r2.bucket });
  const image = '/api/assets/' + ids.asset;
  await s.f.db.insert(systemAttachment).values({ attId: ids.asset, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
    name: imageName, attDir: image, sattDir: image, attType: 'image/png', attSize: String(buyerReviewPng.length) });
  await s.f.db.update(storeProduct).set({ storeName: '单件预估实际双规格商品', type: 0, relationId: 0, pid: 0, productType: 0, price: '19.99', vipPrice: '10.00',
    stock: 16, isShow: 1, isDel: 0, isVerify: 1, isVip: 1, isVipProduct: 0, isPresaleProduct: 0, image, sliderImage: JSON.stringify([image]),
    freight: 1, tempId: 0, cateId: '', brandId: 0, giveIntegral: '0.00', isSub: 0 }).where(eq(storeProduct.id, 70));
  await s.f.db.update(storeProductAttrValue).set({ productId: 70, type: 0, unique: 'qared001', suk: '红色,大号', price: '19.99', vipPrice: '10.00', otPrice: '25.00',
    stock: 8, productType: 0, isRetired: 0, image }).where(eq(storeProductAttrValue.id, ids.red));
  await s.f.db.insert(storeProductAttrValue).values({ id: ids.blue, productId: 70, type: 0, unique: 'qablue01', suk: '蓝色,大号',
    price: '29.99', vipPrice: '20.00', otPrice: '35.00', stock: 8, productType: 0, isRetired: 0, image });
  await s.f.db.update(storeCouponIssue).set({ status: 0 });
  await s.f.db.update(storeCouponUser).set({ status: 1 });
  const now = Date.now(), start = new Date(now - 86400000), end = new Date(now + 30 * 86400000);
  const issue = { category: 1, couponType: 0, type: 2, couponPrice: '85.99', useMinPrice: '0.00', day: 7,
    status: 1, receiveType: 1, appType: 0, receiveLimit: 1, totalCount: 10, remainCount: 10 };
  await s.f.db.insert(storeCouponIssue).values([{ ...issue, id: ids.issue, title: titles[0], couponTitle: titles[0], sort: 0 },
    { ...issue, id: ids.lower, couponPrice: '95.00', title: '目录95折低省额券', couponTitle: '目录95折低省额券', sort: 100 }]);
  for (const [id, uid] of [[ids.ownedA, 11], [ids.ownedB, 22]]) {
    await s.f.db.insert(storeCouponUser).values({ id, uid, issueCouponId: ids.issue, couponTitle: titles[uid as 11 | 22], couponPrice: '85.99',
      useMinPrice: '0.00', type: 2, status: 0, startTime: start, endTime: end, receiveTime: Math.floor(now / 1000), receiveSource: 'get' });
    await s.f.db.insert(storeCouponIssueUser).values({ uid, issueCouponId: ids.issue, addTime: Math.floor(now / 1000) });
  }
  const names = await s.f.exec("SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S') ORDER BY relname");
  const tableNames = names.filter(row => row.kind === 'r').map(row => String(row.name)), sequenceNames = names.filter(row => row.kind === 'S').map(row => String(row.name));
  for (const name of [...tableNames, ...sequenceNames]) expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
  expect(tableNames).toHaveLength(283); expect(sequenceNames.length).toBeGreaterThan(220);
  const tableSql = tableNames.map(name => `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${name}" t`).join(' UNION ALL ');
  const sequenceSql = sequenceNames.map(name => `SELECT '${name}' AS name,last_value::text AS last_value,is_called FROM public."${name}"`).join(' UNION ALL ');
  async function snapshot(): Promise<Snapshot> { const tables = await s.f.exec(tableSql), sequences = await s.f.exec(sequenceSql); return {
    tables: Object.fromEntries(tables.map(row => [row.name, row.rows])), sequences: Object.fromEntries(sequences.map(row => [row.name, { last_value: row.last_value, is_called: row.is_called }])) }; }
  function changedOnly(before: Snapshot, after: Snapshot, allowedTables: string[] = [], allowedSequences: string[] = []) {
    const changedTables = tableNames.filter(name => digest(before.tables[name]) !== digest(after.tables[name]));
    const changedSequences = sequenceNames.filter(name => digest(before.sequences[name]) !== digest(after.sequences[name]));
    expect(changedTables.every(name => allowedTables.includes(name)), 'Unexpected table changes: ' + changedTables).toBe(true);
    expect(changedSequences.every(name => allowedSequences.includes(name)), 'Unexpected sequence changes: ' + changedSequences).toBe(true);
    return { changedTables, changedSequences };
  }
  const manifest = async (paths: string[]) => Promise.all(paths.sort().map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) })));
  const sourcePaths = [...(await Promise.all(['workers-ts/src', 'workers-ts/test/helpers', 'view/uniapp-ts/src', 'view/common'].map(path => files(resolve(repository, path))))).flat(),
    ...['workers-ts/test/browser/public-product-estimate.acceptance.ts', 'workers-ts/vitest.public-product-estimate-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs',
      'workers-ts/test/local-finance-postgres-runner.test.ts', 'workers-ts/test/public-product-estimate-native.test.ts', 'workers-ts/package.json', 'view/uniapp-ts/package.json'].map(path => resolve(repository, path))];
  const sourceBefore = await manifest(sourcePaths), buildPaths = await files(dist), buildBefore = await manifest(buildPaths);
  const tokens = new Map([[11, await s.token(11)], [22, await s.token(22)]]), control = '/__public_product_estimate/' + randomUUID();
  const traces: Row[] = [], evidence: Row[] = [], controls: Row[] = [], staticPaths: Row[] = [], writes: Row[] = [], kv: Row[] = [], snapshots: Record<string, Snapshot> = {};
  const originalKv = s.env.CONFIG_KV;
  const forbidden = (operation: string, key?: string): never => { writes.push({ operation, key }); throw Error('Advisory Browser forbids ' + operation); };
  let activeRead: null | { path: string; query: string; advisory: boolean } = null;
  // The legacy detail chain really fills config caches. Preserve and classify
  // those original writes; the new advisory request alone is hard read-only.
  Object.assign(s.env, { CONFIG_KV: { get: originalKv.get.bind(originalKv),
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      kv.push({ operation: 'put', key, sha256: hash(value), ttl: options?.expirationTtl, ...activeRead });
      if (!activeRead || activeRead.advisory) return forbidden('kv.put', key); return originalKv.put(key, value, options);
    }, delete: async (key: string) => { kv.push({ operation: 'delete', key, ...activeRead });
      if (!activeRead || activeRead.advisory) return forbidden('kv.delete', key); return originalKv.delete(key); } },
    SEQUENCE: { idFromName: () => forbidden('sequence.idFromName'), get: () => forbidden('sequence.get') },
    ORDER_QUEUE: { send: async () => forbidden('queue.send'), sendBatch: async () => forbidden('queue.sendBatch') } });
  const remember = (value: Snapshot) => { const key = digest(value); snapshots[key] ??= structuredClone(value); return key; };
  let expected = await snapshot(); const baseline = structuredClone(expected); remember(expected);
  let origin = '', uid = 11, pending = 0, queue = Promise.resolve(), finished = false, failure: unknown;
  let arm: null | { owner: number; sku: string; kind: string } = null;
  let held: null | { res: ServerResponse; status: number; headers: Record<string, string>; raw: Buffer; trace: Row } = null;
  let done!: () => void, fail!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  const stage = () => phases[evidence.length];
  const send = (res: ServerResponse, value: string | Buffer, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'private, no-store' }); res.end(value); };
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value));
  function forward(res: ServerResponse, status: number, headers: Record<string, string>, raw: Buffer) { if (!res.destroyed) { res.writeHead(status, headers); res.end(raw); } }
  async function serial(work: () => Promise<void>) { const next = queue.then(work); queue = next.catch(() => {}); return next; }
  async function persist(status = 'in_progress') {
    await writeFile(prefix + (status === 'passed' || status === 'failed' ? 'result.json' : 'in-progress.json'), JSON.stringify({ status, origin, control, phases, nextPhase: stage(), ids,
      fixtureIdentity: { appRole: s.appRole, appPid: s.appPid }, fullTables: tableNames, fullSequences: sequenceNames, sourceBefore, buildBefore,
      traces, evidence, controls, staticPaths, writes, kv, snapshots_by_sha256: snapshots, baseline, final: expected, pending, finished,
      resources: { reads: r2.reads, writes: r2.writes, deletes: r2.deletes }, failure: failure ? String(failure) : null }, null, 2) + '\n', { mode: 0o600 });
  }
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    pending++;
    try { await body(req); await serial(async () => {
      const before = await snapshot(); expect(before).toEqual(expected); expect(req.method).toBe('GET');
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && key !== 'host') headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const authorization = headers.get('authori-zation') ?? headers.get('authorization') ?? '', owner = [...tokens].find(([, token]) => authorization === 'Bearer ' + token)?.[0] ?? 0;
      expect(authorization === '' || owner > 0).toBe(true);
      const kvStart = kv.length; activeRead = { path: url.pathname, query: url.search, advisory: url.pathname === '/api/product/detail/activity/70' && url.searchParams.has('view') };
      let response: Response; try { response = await s.fetch(new Request(url, { method: 'GET', headers })); } finally { activeRead = null; }
      const raw = Buffer.from(await response.arrayBuffer()), dto = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw.toString()) : null;
      const after = await snapshot(), responseHeaders = Object.fromEntries(response.headers);
      let classification: Row;
      if (url.pathname === '/api/product/detail/activity/70' && url.searchParams.has('view')) {
        expect([...url.searchParams.keys()].sort()).toEqual(['unique', 'view']); expect(url.searchParams.get('view')).toBe('uni_product_estimate_v1');
        expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(kv.slice(kvStart)).toEqual([]); classification = { kind: 'advisory-zero-write', ...changedOnly(before, after), kvWrites: 0, sku: url.searchParams.get('unique') };
        if (dto?.status === 200) {
          const value = decodePublicProductEstimate(dto.data, { ownerUid: owner, productId: 70, skuUnique: classification.sku });
          const blue = value.skuUnique === 'qablue01'; expect(['qared001', 'qablue01']).toContain(value.skuUnique);
          expect(value.firstOrderEligible).toBe(false); expect(value.computed.promotions).toEqual([]);
          expect(value.computed.deduction).toEqual({ sum_price: blue ? '29.99' : '19.99', vip_price: '0.00', promotions_price: '0.00', first_order_price: '0.00', coupon_price: blue ? '4.50' : '3.00', pay_price: blue ? '25.49' : '16.99' });
          expect(value.computed.coupon).toMatchObject({ source: owner ? 'owned' : 'issue', issueId: ids.issue,
            ownedId: owner === 11 ? ids.ownedA : owner === 22 ? ids.ownedB : null, requiresClaim: owner === 0,
            isMember: false, title: titles[owner as 0 | 11 | 22], benefitType: 2, benefitValue: '85.99', minimum: '0.00', savings: blue ? '4.50' : '3.00' });
        } else { expect(stage()).toBe('error-blue'); expect(classification.sku).toBe('qablue01'); expect(dto?.data).toBeNull(); classification.expectedFailure = true; }
      } else if (/^\/api\/product\/detail\/70(?:\/0)?$/u.test(url.pathname)) {
        expect(dto?.status, dto?.msg).toBe(200); classification = { kind: 'necessary-product-visit', ...changedOnly(before, after, ['store_product_log', 'store_visit'], ['store_product_log_id_seq', 'store_visit_id_seq']) };
      } else { expect(response.status).toBe(200); classification = { kind: 'actual-readonly-GET', ...changedOnly(before, after) }; }
      expect(writes).toEqual([]); expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]);
      const trace: Row = { stage: stage(), method: 'GET', path: url.pathname, query: url.search, owner, classification,
        before: remember(before), after: remember(after), legacyCacheEvents: kv.slice(kvStart), actual: { httpStatus: response.status, status: dto?.status, headers: responseHeaders, sha256: hash(raw),
          ...(classification.kind === 'advisory-zero-write' ? { rawJson: raw.toString('utf8') } : {}) }, delivered: { held: false, released: false, sha256: hash(raw) } };
      traces.push(trace); expected = after;
      if (arm && classification.kind === 'advisory-zero-write' && owner === arm.owner && classification.sku === arm.sku) {
        expect(held).toBeNull(); expect(dto?.status).toBe(200); trace.delivered = { held: true, released: false, kind: arm.kind, sha256: hash(raw) };
        held = { res, raw, status: response.status, headers: responseHeaders, trace }; arm = null;
      } else forward(res, response.status, responseHeaders, raw);
      await persist();
    }); } finally { pending--; }
  }
  async function capture(name: string, data: Row) {
    expect(name).toBe(stage()); expect(data.errors).toEqual([]); expect(data.overlay).toBe(false); expect(data.clientWidth).toBe(data.scrollWidth);
    expect(data.href).toContain('/pages/goods/detail?id=70'); expect(data.maskCount).toBe(0);
    if (name === 'error-blue') { expect(data.state).toBe('error'); expect(data.panelOwner).toBe(''); expect(data.panelSku).toBe(''); expect(data.total).toBe('');
      expect(data.panelText).toContain('重新读取预估'); expect(data.panelText).not.toContain('¥0.00');
      expect(traces.some(row => row.stage === name && row.classification.expectedFailure)).toBe(true);
    } else {
      const owner = ['owner-b', 'actor-race-b'].includes(name) ? 22 : name === 'guest' ? 0 : 11;
      const blue = ['a-blue-multiple', 'retry-blue'].includes(name), sku = blue ? 'qablue01' : 'qared001';
      expect(data.state).toBe('ready'); expect(data.panelOwner).toBe(String(owner)); expect(data.panelProduct).toBe('70'); expect(data.panelSku).toBe(sku);
      expect(data.total).toContain(blue ? '25.49' : '16.99'); expect(data.panelText).toContain('单件预估到手'); expect(data.panelText).toContain('1 件');
      expect(data.panelText).toContain(titles[owner as 0 | 11 | 22]); expect(data.panelText).toContain(owner ? '已领取' : '需领取后使用');
      expect(data.panelText).toContain(blue ? '4.50' : '3.00'); expect(data.panelText).toContain(blue ? '29.99' : '19.99');
      expect(data.panelText).toContain('未含运费和积分抵扣'); expect(data.panelText).toContain('结算时重新确认');
      expect(data.basePrice).toContain(blue ? '29.99' : '19.99');
      if (owner !== 11) expect(data.panelText).not.toContain(titles[11]); if (owner !== 22) expect(data.panelText).not.toContain(titles[22]);
      if (name === 'a-blue-multiple') expect(data.panelText).toMatch(/当前已选 [2-9]\d* 件；以下仅为 1 件预估/u);
      if (name === 'a-red-mobile' || name === 'a-blue-multiple') expect(data.frameWidth).toBe(375);
      if (name === 'owner-a-desktop') expect(data.frameWidth).toBe(1280);
      if (name === 'sku-race-red' || name === 'actor-race-b') {
        const delayedIndex = traces.findIndex(row => row.delivered.kind === (name === 'sku-race-red' ? 'sku-blue' : 'actor-a-red'));
        expect(delayedIndex).toBeGreaterThanOrEqual(0); const delayed = traces[delayedIndex]!;
        expect(delayed.delivered.released).toBe(true); expect(delayed.delivered.sha256).toBe(delayed.actual.sha256);
        expect(traces.slice(delayedIndex + 1).some(row => row.classification.kind === 'advisory-zero-write' && row.owner === owner && row.classification.sku === sku && row.actual.status === 200)).toBe(true);
      }
    }
    expect(await snapshot()).toEqual(expected); evidence.push({ name, ...data, snapshot: remember(expected), traceIndices: traces.flatMap((row, index) => row.stage === name ? [index] : []) }); await persist();
  }
  const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>单件预估 Browser 验收</title><link rel="icon" href="data:,"><style>body{margin:0;font:13px sans-serif;background:#edf0f4}nav{display:flex;flex-wrap:wrap;gap:4px;padding:5px}button{padding:5px}iframe{display:block;border:0;width:375px;height:calc(100vh - 170px);background:white}pre{height:65px;overflow:auto;margin:0;white-space:pre-wrap}</style></head><body><nav>${['beginA','remountA','ownerB','guest','returnA','switchB','mobile','desktop','armBlue','armAred','release','invalidateBlue','repairBlue','finish'].map(name => '<button id="'+name+'">'+name+'</button>').join('')}${phases.map(name => '<button data-phase="'+name+'">记录 '+name+'</button>').join('')}</nav><pre id="result">正式H5/真实App/JWT/受限PG16。SKU、数量、重试请在iframe内手工操作。armBlue/armAred只延迟实际API响应；release交付原字节。详情访问日志单列，预估零写。</pre><iframe title="正式H5单件预估"></iframe><script>
const ctl=${JSON.stringify(control)},result=document.querySelector('#result');let frame=document.querySelector('iframe'),errors=[];
document.querySelector('nav').addEventListener('mousedown',e=>{if(e.target.closest('button'))e.preventDefault()});
async function post(action,data){const r=await fetch(ctl+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});if(!r.ok)throw Error(await r.text());return r.json()}
function wire(n){n.onload=e=>{const w=e.currentTarget.contentWindow;w.addEventListener('error',e=>errors.push(String(e.message)));w.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)))}}wire(frame);
async function session(owner,remount=true){const d=await post('session',{uid:owner,remount});if(owner){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:d.token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:owner}))}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid')}if(remount){errors=[];const old=frame,n=old.cloneNode(false);frame=n;wire(n);old.replaceWith(n);n.src='/__h5#/pages/goods/detail?id=70'}else{frame.contentWindow.dispatchEvent(new StorageEvent('storage',{key:'uni_token',storageArea:localStorage,url:location.href}))}result.textContent=JSON.stringify({syntheticOwner:owner,remount})}
for(const [name,owner]of[['beginA',11],['remountA',11],['ownerB',22],['guest',0],['returnA',11]])document.getElementById(name).onclick=()=>session(owner).catch(e=>result.textContent=String(e));
document.getElementById('switchB').onclick=()=>session(22,false).catch(e=>result.textContent=String(e));
document.getElementById('mobile').onclick=()=>frame.style.width='375px';document.getElementById('desktop').onclick=()=>frame.style.width='1280px';
for(const name of ['armBlue','armAred','release','invalidateBlue','repairBlue','finish'])document.getElementById(name).onclick=async()=>{try{result.textContent=JSON.stringify(await post(name))}catch(e){result.textContent=String(e)}};
for(const button of document.querySelectorAll('[data-phase]'))button.onclick=async()=>{button.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,shown=n=>{if(!n||n.getBoundingClientRect().width<=0||n.getBoundingClientRect().height<=0)return false;for(let p=n;p&&p.nodeType===1;p=p.parentElement){const s=w.getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')return false}return true},page=[...d.querySelectorAll('uni-page')].filter(shown).at(-1)||d.body,panel=[...page.querySelectorAll('[data-product-estimate-state]')].filter(shown).at(-1),attr=k=>panel?.getAttribute('data-product-estimate-'+k)||'',data={capturedAt:Date.now(),href:w.location.href,text:page.innerText,panelText:panel?.innerText||'',state:attr('state'),panelOwner:attr('owner'),panelProduct:attr('product'),panelSku:attr('sku'),total:panel?.querySelector('.estimate-total')?.innerText||'',basePrice:[...page.querySelectorAll('.price')].filter(shown).map(n=>n.innerText).join(' '),maskCount:[...page.querySelectorAll('.mask')].filter(shown).length,frameWidth:frame.clientWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,errors:[...errors],overlay:!!d.querySelector('vite-error-overlay')};result.textContent=JSON.stringify(await post('capture/'+button.dataset.phase,data))}catch(e){result.textContent=String(e)}finally{button.disabled=false}};
</script></body></html>`;
  const server = createServer((req, res) => { void (async () => {
    expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe(new URL(origin).host);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, shell, 200, 'text/html; charset=utf-8');
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); const action = path.slice(control.length + 1), input = JSON.parse((await body(req)).toString());
      return serial(async () => {
        if (pending) return json(res, { accepted: false, reason: 'actual business requests pending; retry shell control', next: stage() });
        expect(await snapshot()).toEqual(expected);
        if (action.startsWith('capture/')) { await capture(action.slice(8), input); return json(res, { accepted: true, next: stage() }); }
        if (action === 'session') {
          const allowed: Record<string, number> = { 'a-red-mobile': 11, 'owner-b': 22, guest: 0, 'owner-a-desktop': 11, 'actor-race-b': 22 };
          expect(input.uid).toBe(allowed[stage() ?? '']); expect(typeof input.remount).toBe('boolean');
          if (!input.remount) { expect(stage()).toBe('actor-race-b'); expect(held?.trace.delivered.kind).toBe('actor-a-red'); }
          else expect(held).toBeNull();
          uid = input.uid; controls.push({ kind: 'qa-synthetic-actor', stage: stage(), uid, remount: input.remount }); json(res, { token: tokens.get(uid) ?? '' });
        } else if (action === 'armBlue' || action === 'armAred') {
          expect(stage()).toBe(action === 'armBlue' ? 'sku-race-red' : 'actor-race-b'); expect(arm).toBeNull(); expect(held).toBeNull(); expect(uid).toBe(11);
          arm = { owner: 11, sku: action === 'armBlue' ? 'qablue01' : 'qared001', kind: action === 'armBlue' ? 'sku-blue' : 'actor-a-red' };
          controls.push({ kind: 'arm-actual-response', stage: stage(), owner: arm.owner, sku: arm.sku, responseKind: arm.kind }); json(res, { armed: arm });
        } else if (action === 'release') {
          expect(held).not.toBeNull(); const value = held!; held = null; value.trace.delivered.released = true;
          value.trace.delivered.clientAborted = value.res.destroyed; value.trace.delivered.releasedAt = Date.now();
          forward(value.res, value.status, value.headers, value.raw); controls.push({ kind: 'release-original-response', stage: stage(), sha256: hash(value.raw), clientAborted: value.res.destroyed }); json(res, { released: true, sha256: hash(value.raw), next: stage() });
        } else if (action === 'invalidateBlue' || action === 'repairBlue') {
          expect(stage()).toBe(action === 'invalidateBlue' ? 'error-blue' : 'retry-blue'); expect(held).toBeNull(); const before = await snapshot();
          await s.f.db.update(storeProductAttrValue).set({ price: action === 'invalidateBlue' ? '-0.01' : '29.99' }).where(eq(storeProductAttrValue.id, ids.blue));
          const after = await snapshot(); const changes = changedOnly(before, after, ['store_product_attr_value']); expect(changes.changedTables).toEqual(['store_product_attr_value']);
          controls.push({ kind: 'owner-only-sql-price-fixture', stage: stage(), action, before: remember(before), after: remember(after), ...changes }); expected = after; json(res, { accepted: true, action });
        } else if (action === 'finish') {
          expect(evidence).toHaveLength(phases.length); expect(held).toBeNull(); expect(arm).toBeNull(); expect(writes).toEqual([]); expect(kv.filter(row => row.advisory)).toEqual([]);
          const advisory = traces.filter(row => row.classification.kind === 'advisory-zero-write'); expect(advisory.length).toBeGreaterThanOrEqual(11);
          expect(advisory.every(row => row.before === row.after && row.classification.changedTables.length === 0 && row.classification.changedSequences.length === 0)).toBe(true);
          expect(advisory.filter(row => row.delivered.held)).toHaveLength(2); expect(advisory.filter(row => row.classification.expectedFailure).length).toBeGreaterThanOrEqual(1);
          expect(traces.some(row => row.classification.kind === 'necessary-product-visit')).toBe(true);
          changedOnly(baseline, expected, ['store_product_log', 'store_visit'], ['store_product_log_id_seq', 'store_visit_id_seq']);
          expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]); expect(await manifest(sourcePaths)).toEqual(sourceBefore); expect(await files(dist)).toEqual(buildPaths); expect(await manifest(buildPaths)).toEqual(buildBefore);
          finished = true; await persist('passed'); json(res, { accepted: true, finished, tables: tableNames.length, sequences: sequenceNames.length, advisory: advisory.length, allAdvisoryZeroWrite: true, legacyCacheWrites: kv.length, pageVisitLogsSeparatelyClassified: true }); done();
        } else throw Error('Unknown owned estimate QA action'); await persist();
      });
    }
    if (path.startsWith('/api/')) return api(req, res, url);
    expect(method).toBe('GET'); if (path === '/favicon.ico') return send(res, '', 204, 'text/plain');
    const target = path === '/__h5' ? resolve(dist, 'index.html') : resolve(dist, '.' + decodeURIComponent(path)); expect(target.startsWith(dist + sep)).toBe(true); expect((await stat(target)).isFile()).toBe(true);
    const raw = await readFile(target); staticPaths.push({ path, sha256: hash(raw) }); send(res, raw, 200, ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' } as Record<string, string>)[extname(target)] ?? 'application/octet-stream');
  })().catch(error => { failure ??= error; void persist().then(() => fail(error), () => fail(error)); if (!res.headersSent) send(res, String(error), 500, 'text/plain'); else res.end(); }); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local estimate listener'); origin = 'http://127.0.0.1:' + address.port;
    await writeFile(prefix + 'ready.json', JSON.stringify({ origin, url: origin + control, control, prefix, phases, ids, tables: tableNames.length, sequences: sequenceNames.length }, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('PUBLIC_PRODUCT_ESTIMATE_BROWSER_READY ' + JSON.stringify({ url: origin + control, phases, ids }) + '\n'); deadline = setTimeout(() => fail(Error('Estimate Browser finish missing')), 90 * 60000); await completion; await queue;
    expect(await snapshot()).toEqual(expected);
  } catch (error) { failure ??= error; await persist('failed'); throw error; }
  finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes()));
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ finished, ownedListeners: 0, pending, failure: failure ? String(failure) : null }, null, 2) + '\n', { mode: 0o600 }); }
}), 92 * 60000);
