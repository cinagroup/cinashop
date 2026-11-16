/** Installed Browser -> unchanged shipped H5 adapters -> actual App/JWT and
 * commissioned PG16 LOGIN. Controls provide only synthetic login/remount,
 * one lost successful grant delivery, DOM observations and native cleanup of
 * the two local unpaid orders. Cleanup is explicitly not a product UI claim. */
import { expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeCouponIssue, storeCouponIssueUser, storeCouponUser, storeProduct, storeProductAttrValue, systemAttachment, user } from '@/models/schema';
import { withBuyerInvoices } from '../helpers/buyerInvoices';
import { buyerReviewPng, buyerReviewR2 } from '../helpers/buyerReviewR2';

type Row = Record<string, any>;
type Snapshot = { tables: Record<string, Row[]>; sequences: Record<string, Row> };
const prefix = '/tmp/cinashop-uni-coupon-buy-browser-';
const ids = { product: 70, lost: 961000, historical: 961001, olderOwned: 961100, spentOwned: 961101, asset: 991101 };
const phases = ['unclaimed-drawer', 'lost-grant', 'remounted-pending', 'owner-b', 'owner-a-return', 'recovered-checkout', 'mobile-checkout', 'desktop-checkout', 'first-created', 'historical-checkout', 'second-created'];
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = (value: unknown) => hash(JSON.stringify(stable(value)));
function one(rows: Row[], key: string, value: unknown): Row { const matches = rows.filter(row => row[key] === value); expect(matches).toHaveLength(1); return matches[0]!; }
async function files(directory: string): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(row => row.isDirectory() ? files(resolve(directory, row.name)) : [resolve(directory, row.name)]))).flat().sort();
}
async function body(req: IncomingMessage) {
  const parts: Buffer[] = []; let count = 0;
  for await (const part of req) { const bytes = Buffer.from(part); count += bytes.length; expect(count).toBeLessThanOrEqual(65536); parts.push(bytes); }
  return Buffer.concat(parts);
}

it('buys both unclaimed and previously received coupons through the actual product/checkout UI and recovers one original grant', async () => withBuyerInvoices(async s => {
  expect(process.env.TEST_UNI_COUPON_BUY_BROWSER).toBe('1');
  const repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  expect((await stat(resolve(dist, 'index.html'))).isFile()).toBe(true);
  const r2 = buyerReviewR2(), imageName = 'attachments/admin/1/uni_coupon_buy.png';
  r2.objects.set(imageName, { bytes: buyerReviewPng.slice(), contentType: 'image/png' }); Object.assign(s.env, { ASSETS_BUCKET: r2.bucket });
  await s.f.db.insert(systemAttachment).values({ attId: ids.asset, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
    name: imageName, attDir: '/api/assets/' + ids.asset, sattDir: '/api/assets/' + ids.asset, attType: 'image/png', attSize: String(buyerReviewPng.length) });
  await s.f.db.update(user).set({ nickname: '领券购买验收A', isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 11));
  await s.f.db.update(user).set({ nickname: '领券购买验收B', isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 22));
  const image = '/api/assets/' + ids.asset;
  await s.f.db.update(storeProduct).set({ storeName: '原购物车领券购买商品', image, sliderImage: JSON.stringify([image]) }).where(eq(storeProduct.id, 70));
  await s.f.db.update(storeProductAttrValue).set({ image }).where(eq(storeProductAttrValue.id, 1));
  await s.f.db.update(storeCouponIssue).set({ status: 0 });
  const now = Date.now(), start = new Date(now - 86400000), end = new Date(now + 30 * 86400000);
  const template = { category: 0, couponType: 2, type: 1, couponPrice: '2.00', useMinPrice: '0.00', productId: '70', day: 7,
    status: 1, receiveType: 1, appType: 0, receiveLimit: 1, totalCount: 10, remainCount: 10, rule: '<p>此券仅用于原商品，最终优惠以结算报价为准。</p>' };
  await s.f.db.insert(storeCouponIssue).values([{ ...template, id: ids.lost, couponTitle: '领取回执丢失恢复券', sort: 100 },
    { ...template, id: ids.historical, couponTitle: '已领原商品购买券', sort: 90 }]);
  for (const [id, status] of [[ids.olderOwned, 0], [ids.spentOwned, 1]]) await s.f.db.insert(storeCouponUser).values({ id, uid: 11,
    issueCouponId: ids.historical, couponTitle: '已领原商品购买券', couponPrice: '2.00', useMinPrice: '0.00', type: 1, status,
    startTime: start, endTime: end, receiveTime: Math.floor(now / 1000), receiveSource: 'get' });
  await s.f.db.insert(storeCouponIssueUser).values({ uid: 11, issueCouponId: ids.historical, addTime: Math.floor(now / 1000) });
  await s.f.exec("SELECT setval('public.store_cart_id_seq',(SELECT greatest(coalesce(max(id),1),1) FROM public.store_cart),true)");
  const names = await s.f.exec("SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S') ORDER BY relname");
  const tableNames = names.filter(row => row.kind === 'r').map(row => String(row.name)), sequenceNames = names.filter(row => row.kind === 'S').map(row => String(row.name));
  for (const name of [...tableNames, ...sequenceNames]) expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
  expect(tableNames.length).toBeGreaterThan(280); expect(sequenceNames.length).toBeGreaterThan(220);
  const tableSql = tableNames.map(name => `SELECT '${name}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${name}" t`).join(' UNION ALL ');
  const sequenceSql = sequenceNames.map(name => `SELECT '${name}' AS name,last_value::text AS last_value,is_called FROM public."${name}"`).join(' UNION ALL ');
  async function snapshot(): Promise<Snapshot> { const tables = await s.f.exec(tableSql), sequences = await s.f.exec(sequenceSql); return {
    tables: Object.fromEntries(tables.map(row => [row.name, row.rows])), sequences: Object.fromEntries(sequences.map(row => [row.name, { last_value: row.last_value, is_called: row.is_called }])) }; }
  function changedOnly(before: Snapshot, after: Snapshot, tables: string[] = [], sequences = tables.map(name => name + '_id_seq')) {
    const changedTables = tableNames.filter(name => digest(before.tables[name]) !== digest(after.tables[name]));
    const changedSequences = sequenceNames.filter(name => digest(before.sequences[name]) !== digest(after.sequences[name]));
    expect(changedTables.every(name => tables.includes(name)), 'Unexpected business table change: ' + changedTables).toBe(true);
    expect(changedSequences.every(name => sequences.includes(name)), 'Unexpected sequence change: ' + changedSequences).toBe(true);
    return { changedTables, changedSequences };
  }
  const manifest = async (paths: string[]) => Promise.all(paths.sort().map(async path => ({ path: path.slice(repository.length + 1), sha256: hash(await readFile(path)) })));
  const sourcePaths = [...(await Promise.all(['workers-ts/src', 'workers-ts/test/helpers', 'view/uniapp-ts/src', 'view/common'].map(path => files(resolve(repository, path))))).flat(),
    ...['workers-ts/test/browser/uni-coupon-buy.acceptance.ts', 'workers-ts/vitest.uni-coupon-buy-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs',
      'workers-ts/test/local-finance-postgres-runner.test.ts', 'workers-ts/test/uni-coupon-buy-native.test.ts', 'view/uniapp-ts/package.json'].map(path => resolve(repository, path))];
  const sourceBefore = await manifest(sourcePaths), buildPaths = await files(dist), buildBefore = await manifest(buildPaths);
  const tokens = new Map([[11, await s.token(11)], [22, await s.token(22)]]), control = '/__uni_coupon_buy/' + randomUUID();
  const traces: Row[] = [], evidence: Row[] = [], controls: Row[] = [], failedResponses: Row[] = [], snapshots: Record<string, Snapshot> = {}, staticPaths: Row[] = [], kv: Row[] = [];
  // Only local order-number allocation is adapted. Business pricing, grants,
  // stock/points/coupon claims and cancellation remain the actual service.
  const allocations: string[] = [];
  Object.assign(s.env, { SEQUENCE: { idFromName: () => 'owned-uni-coupon-buy-browser', get: () => ({ fetch: async () => {
    const value = 'uni_coupon_buy_browser_' + (allocations.length + 1); allocations.push(value); return new Response(value);
  } }) } });
  const originalKv = s.env.CONFIG_KV;
  s.env.CONFIG_KV = { get: originalKv.get.bind(originalKv), delete: originalKv.delete.bind(originalKv), put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
    kv.push({ stage: phases[evidence.length], key, ttl: options?.expirationTtl, sha256: hash(value) }); return originalKv.put(key, value, options);
  } } as KVNamespace;
  const remember = (value: Snapshot) => { const key = digest(value); snapshots[key] ??= structuredClone(value); return key; };
  let expected = await snapshot(); const baseline = structuredClone(expected); remember(expected);
  let origin = '', uid = 11, pending = 0, queue = Promise.resolve(), fault = true, finished = false, failure: unknown;
  let done!: () => void, fail!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  const stage = () => phases[evidence.length];
  const send = (res: ServerResponse, value: string | Buffer, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'private, no-store' }); res.end(value); };
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value));
  async function serial(work: () => Promise<void>) { const next = queue.then(work); queue = next.catch(() => {}); return next; }
  async function persist(status = 'in_progress') {
    await writeFile(prefix + (status === 'passed' ? 'result.json' : 'in-progress.json'), JSON.stringify({ status, origin, control, phases, nextPhase: stage(), ids,
      fixtureIdentity: { appRole: s.appRole, appPid: s.appPid }, fullTables: tableNames, fullSequences: sequenceNames, sourceBefore, buildBefore,
      traces, evidence, controls, failedResponses, staticPaths, kv, allocations, snapshots_by_sha256: snapshots, baseline, final: expected, pending, finished,
      resources: { reads: r2.reads, writes: r2.writes, deletes: r2.deletes }, failure: failure ? String(failure) : null }, null, 2) + '\n', { mode: 0o600 });
  }
  const quoteRequests = new Map<string, Row>();
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    pending++;
    try { const bytes = await body(req); await serial(async () => {
      const before = await snapshot(); expect(before).toEqual(expected);
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && key !== 'host') headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const authorization = headers.get('authori-zation') ?? headers.get('authorization') ?? '', actor = [...tokens].find(([, token]) => authorization === 'Bearer ' + token)?.[0];
      const method = req.method ?? 'GET', path = url.pathname, write = !['GET', 'HEAD'].includes(method), input = write ? JSON.parse(bytes.toString()) : null;
      if (write) { expect(actor).toBe(11); expect(uid).toBe(11); expect(method).toBe('POST'); expect(headers.get('form-type')).toBe('h5');
        expect(path === '/api/cart/add' || path === '/api/coupon/receive' || path === '/api/order/confirm' || /^\/api\/order\/(computed|create)\/[a-zA-Z0-9_-]+$/u.test(path)).toBe(true); }
      const kvStart = kv.length;
      const response = await s.fetch(new Request(url, { method, headers, ...(write ? { body: bytes } : {}) }));
      const raw = Buffer.from(await response.arrayBuffer()), dto = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw.toString()) : null;
      const after = await snapshot();
      if (response.status !== 200) {
        failedResponses.push({ stage: stage(), method, path, query: url.search, owner: actor ?? 0,
          httpStatus: response.status, status: dto?.status, bodySha256: hash(raw), bodyPreview: raw.toString('utf8').slice(0, 512),
          before: remember(before), after: remember(after) });
        await persist();
      }
      expect(response.status, method + ' ' + path + url.search).toBe(200);
      let classification: Row;
      if (/^\/api\/product\/detail\/70(?:\/0)?$/u.test(path)) {
        expect(dto?.status, dto?.msg).toBe(200); classification = { kind: 'necessary-product-visit', ...changedOnly(before, after, ['store_product_log', 'store_visit']) };
      } else if (path === '/api/cart/add') {
        expect(dto?.status, dto?.msg).toBe(200); expect(input).toEqual({ productId: 70, unique: 'qared001', cartNum: 1, new: 1 });
        const prior = traces.filter(row => row.classification.kind === 'original-cart'); expect(prior.length).toBeLessThan(2);
        const id = dto.data.id, row = one(after.tables.store_cart!, 'id', id); expect(before.tables.store_cart!.some(row => row.id === id)).toBe(false);
        expect(row).toMatchObject({ uid: 11, product_id: 70, product_attr_unique: 'qared001', cart_num: 1, is_new: 1, is_pay: 0 });
        expect(after.tables.store_cart).toHaveLength(before.tables.store_cart!.length + 1);
        classification = { kind: 'original-cart', cartId: id, ...changedOnly(before, after, ['store_cart']) };
      } else if (path === '/api/coupon/receive') {
        expect(stage()).toBe('lost-grant'); expect(input).toEqual({ id: ids.lost }); expect(dto?.status, dto?.msg).toBe(200);
        expect(traces.filter(row => row.classification.kind === 'sole-grant')).toHaveLength(0);
        const owned = one(after.tables.store_coupon_user!, 'id', dto.data.couponUserId); expect(owned).toMatchObject({ uid: 11, issue_coupon_id: ids.lost, status: 0 });
        expect(after.tables.store_coupon_user).toHaveLength(before.tables.store_coupon_user!.length + 1);
        expect(after.tables.store_coupon_issue_user).toHaveLength(before.tables.store_coupon_issue_user!.length + 1);
        expect(one(after.tables.store_coupon_issue!, 'id', ids.lost).remain_count).toBe(one(before.tables.store_coupon_issue!, 'id', ids.lost).remain_count - 1);
        classification = { kind: 'sole-grant', ownedId: owned.id, ...changedOnly(before, after, ['store_coupon_user', 'store_coupon_issue_user', 'store_coupon_issue'], ['store_coupon_user_id_seq']) };
      } else if (path === '/api/order/confirm' || path.startsWith('/api/order/computed/')) {
        expect(dto?.status, dto?.msg).toBe(200); changedOnly(before, after);
        const key = dto.data.orderKey, writes = kv.slice(kvStart); expect(writes).toHaveLength(path === '/api/order/confirm' ? 2 : 1); expect(writes.every(row => row.ttl === 1800)).toBe(true);
        quoteRequests.set(key, { ...input, cartIds: path === '/api/order/confirm' ? input.cartIds : quoteRequests.get(key)?.cartIds, quoteToken: dto.data.quoteToken, response: dto.data });
        classification = { kind: 'sql-readonly-real-quote', key, couponId: input.couponId, useIntegral: input.useIntegral, kvPuts: writes.length };
      } else if (path.startsWith('/api/order/create/')) {
        expect(dto?.status, dto?.msg).toBe(200); const key = path.split('/').at(-1)!, quote = quoteRequests.get(key); expect(quote).toBeDefined();
        expect(input).not.toHaveProperty('payType'); expect(input).not.toHaveProperty('pay_type'); expect(input.cartIds).toEqual(quote!.cartIds); expect(input.quoteToken).toBe(quote!.quoteToken);
        expect(input.couponId).toBe(quote!.couponId); expect(input.useIntegral).toBe(quote!.useIntegral); expect(input.couponId).toBeGreaterThan(0);
        const prior = traces.filter(row => row.classification.kind === 'unpaid-order'); expect(prior.length).toBeLessThan(2);
        expect(input.couponId).toBe(prior.length ? ids.olderOwned : traces.find(row => row.classification.kind === 'sole-grant')!.classification.ownedId);
        const order = one(after.tables.store_order!, 'order_id', dto.data.orderId); expect(order.uid).toBe(11); expect(order.paid).toBe(0); expect(Number(order.pay_price)).toBeGreaterThan(0);
        expect(Number(order.coupon_price)).toBe(2); expect(order.coupon_id).toBe(input.couponId); expect(one(after.tables.store_coupon_user!, 'id', input.couponId).status).toBe(3);
        expect(one(after.tables.store_cart!, 'id', input.cartIds[0]).is_pay).toBe(1);
        expect(Number(one(after.tables.user!, 'uid', 11).integral)).toBe(Number(one(before.tables.user!, 'uid', 11).integral) - Number(order.use_integral));
        if (!prior.length) { expect(input.useIntegral).toBe(true); expect(Number(order.use_integral)).toBe(100); }
        const allowed = ['store_order', 'store_order_cart_info', 'store_order_status', 'store_order_purchase_origin', 'store_order_purchase_physical_origin', 'store_product', 'store_product_attr_value', 'store_cart', 'store_coupon_user', 'user', 'user_bill'];
        classification = { kind: 'unpaid-order', key, orderId: order.order_id, orderDbId: order.id, couponId: order.coupon_id, usedIntegral: Number(order.use_integral), cartId: input.cartIds[0], ...changedOnly(before, after, allowed) };
      } else {
        changedOnly(before, after); classification = { kind: 'actual-readonly-GET' };
        if (path.endsWith('/receipt')) { expect(dto?.status, dto?.msg).toBe(200); expect(path).toBe('/api/product/detail/70/coupons/' + ids.lost + '/receipt'); expect(dto.data.receivedCount).toBe(1); classification = { kind: 'original-receipt', ownedId: dto.data.latestCouponUserId }; }
        if (path === '/api/coupons/order/0') { expect(dto?.status, dto?.msg).toBe(200); expect(url.searchParams.get('new')).toBe('1');
          expect(dto.data.every((row: Row) => typeof row.cid === 'number')).toBe(true); classification = { kind: 'actual-new1-picker', rows: dto.data.map((row: Row) => ({ id: row.id, issueId: row.cid })) }; }
      }
      expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]);
      let deliveredStatus = response.status, outgoing = raw, deliveryFault = false;
      if (classification.kind === 'sole-grant' && fault) { fault = false; deliveryFault = true; deliveredStatus = 503; outgoing = Buffer.from(JSON.stringify({ status: 500, msg: '原领取响应交付中断，请核对', data: null })); }
      traces.push({ stage: stage(), method, path, query: url.search, owner: actor ?? 0, request: input, classification, before: remember(before), after: remember(after),
        actual: { httpStatus: response.status, status: dto?.status, sha256: hash(raw), ...(classification.kind === 'sql-readonly-real-quote' ? { rawJson: raw.toString('utf8') } : {}) }, delivered: { httpStatus: deliveredStatus, fault: deliveryFault, sha256: hash(outgoing) } });
      expected = after; await persist(); send(res, outgoing, deliveredStatus, response.headers.get('content-type') ?? 'application/json');
    }); } finally { pending--; }
  }
  async function capture(name: string, data: Row) {
    expect(name).toBe(stage()); expect(data.errors).toEqual([]); expect(data.overlay).toBe(false); expect(data.clientWidth).toBe(data.scrollWidth); expect(data.text.length).toBeGreaterThan(20);
    if (name === 'unclaimed-drawer') { expect(data.text).toContain('领券并购买'); expect(data.text).toContain('使用此券购买'); }
    if (['lost-grant', 'remounted-pending', 'owner-a-return'].includes(name)) { expect(data.buyPhase).toBe('claim-unknown'); expect(data.buyCart).toBe(traces.find(row => row.classification.kind === 'original-cart')!.classification.cartId); }
    if (name === 'owner-b') { expect(data.buyPhase).toBe(''); expect(data.text).not.toContain('原领券购买：'); }
    if (name.includes('checkout')) { expect(data.href).toContain('/pages/order/confirm?mode=buy&cartId='); expect(data.href).toContain('couponBuy='); expect(data.submitDisabled).toBe(false); expect(data.activeCoupon).toContain(name === 'historical-checkout' ? '已领原商品购买券' : '领取回执丢失恢复券'); expect(data.text).toContain('-¥2.00'); }
    if (name === 'recovered-checkout') expect(data.text).toContain('100积分');
    if (name === 'mobile-checkout') expect(data.frameWidth).toBe(375);
    if (name === 'desktop-checkout') expect(data.frameWidth).toBe(1280);
    if (name.endsWith('created')) { expect(data.href).toContain('/pages/order/detail?orderId='); expect(data.text).toContain('待支付'); expect(data.savedBuy).toBeNull(); expect(data.savedOrdinary).toBeNull(); expect(data.savedOrder).toBeNull(); }
    expect(await snapshot()).toEqual(expected); evidence.push({ name, ...data, snapshot: remember(expected), traceIndices: traces.flatMap((row, index) => row.stage === name ? [index] : []) }); await persist();
  }
  const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>原购物车领券购买验收</title><link rel="icon" href="data:,"><style>body{margin:0;font:13px sans-serif;background:#edf0f4}nav{display:flex;flex-wrap:wrap;gap:4px;padding:5px}button{padding:5px}iframe{display:block;border:0;width:375px;height:calc(100vh - 140px);background:white}pre{height:45px;overflow:auto;margin:0;white-space:pre-wrap}</style></head><body><nav>${['beginA','remountA','ownerB','returnA','productA','mobile','desktop','finish'].map(name => '<button id="'+name+'">'+name+'</button>').join('')}${phases.map(name => '<button data-phase="'+name+'">记录 '+name+'</button>').join('')}</nav><pre id="result">正式H5、实际App/JWT/受限PG16；一个已成功领取响应的单次交付故障。finish仅清理两笔本地未支付订单，取消行为不计作产品UI验收。</pre><iframe title="正式H5领券购买"></iframe><script>
const ctl=${JSON.stringify(control)},result=document.querySelector('#result');let frame=document.querySelector('iframe'),errors=[];
document.querySelector('nav').addEventListener('mousedown',e=>{if(e.target.closest('button'))e.preventDefault()});
async function post(action,data){const r=await fetch(ctl+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});if(!r.ok)throw Error(await r.text());return r.json()}
function wire(n){n.onload=e=>{const w=e.currentTarget.contentWindow;w.addEventListener('error',e=>errors.push(String(e.message)));w.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)))}}wire(frame);
async function session(owner){const d=await post('session',{uid:owner});localStorage.setItem('uni_token',JSON.stringify({type:'string',data:d.token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:owner}));errors=[];const old=frame,n=old.cloneNode(false);frame=n;wire(n);old.replaceWith(n);n.src='/__h5#/pages/goods/detail?id=70'}
for(const [name,owner]of[['beginA',11],['remountA',11],['ownerB',22],['returnA',11],['productA',11]])document.getElementById(name).onclick=()=>session(owner).catch(e=>result.textContent=String(e));
document.getElementById('mobile').onclick=()=>frame.style.width='375px';document.getElementById('desktop').onclick=()=>frame.style.width='1280px';document.getElementById('finish').onclick=async()=>{try{result.textContent=JSON.stringify(await post('finish'))}catch(e){result.textContent=String(e)}};
for(const button of document.querySelectorAll('[data-phase]'))button.onclick=async()=>{button.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,shown=n=>{if(!n||n.getBoundingClientRect().width<=0||n.getBoundingClientRect().height<=0)return false;for(let p=n;p&&p.nodeType===1;p=p.parentElement){const s=w.getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden')return false}return true},page=[...d.querySelectorAll('uni-page')].filter(shown).at(-1)||d.body,buy=[...page.querySelectorAll('[data-coupon-buy-phase]')].filter(shown).at(-1),submit=[...page.querySelectorAll('.submit-btn')].filter(shown).at(-1),saved=key=>{const x=localStorage.getItem(key);return x?JSON.parse(x).data??null:null},data={capturedAt:Date.now(),href:w.location.href,text:page.innerText,images:[...page.querySelectorAll('uni-image,img')].filter(shown).flatMap(n=>[n.getAttribute('src')||'',...[n,...n.querySelectorAll('*')].map(c=>w.getComputedStyle(c).backgroundImage)]).flatMap(v=>v.startsWith('url(')?[v.slice(4,-1).replace(/^['"]|['"]$/g,'')]:v&&v!=='none'?[v]:[]),buyPhase:buy?.getAttribute('data-coupon-buy-phase')||'',buyCart:Number(buy?.getAttribute('data-coupon-buy-cart')||0),submitDisabled:!submit||submit.disabled||submit.getAttribute('disabled')==='true',activeCoupon:[...page.querySelectorAll('.coupon-card.active')].filter(shown).map(n=>n.innerText).join(' '),frameWidth:frame.clientWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,errors:[...errors],overlay:!!d.querySelector('vite-error-overlay'),savedBuy:saved('cinashop_product_coupon_buy_v1_11'),savedOrdinary:saved('cinashop_category_purchase_v1_11'),savedOrder:saved('cinashop_checkout_pending_v1_11')};result.textContent=JSON.stringify(await post('capture/'+button.dataset.phase,data))}catch(e){result.textContent=String(e)}finally{button.disabled=false}};
</script></body></html>`;
  const server = createServer((req, res) => { void (async () => {
    expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe(new URL(origin).host);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, shell, 200, 'text/html; charset=utf-8');
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); const action = path.slice(control.length + 1), input = JSON.parse((await body(req)).toString());
      return serial(async () => {
        if (action.startsWith('capture/')) { if (pending) return json(res, { accepted: false, reason: 'business requests pending', next: stage() }); await capture(action.slice(8), input); return json(res, { accepted: true, next: stage() }); }
        expect(pending).toBe(0); expect(await snapshot()).toEqual(expected);
        if (action === 'session') { const allowed: Record<string, number> = { 'unclaimed-drawer': 11, 'remounted-pending': 11, 'owner-b': 22, 'owner-a-return': 11, 'historical-checkout': 11 };
          expect(input).toEqual({ uid: allowed[stage() ?? ''] }); uid = input.uid; controls.push({ kind: 'qa-synthetic-login-remount', stage: stage(), uid }); json(res, { token: tokens.get(uid) }); }
        else if (action === 'finish') {
          expect(evidence).toHaveLength(phases.length); expect(fault).toBe(false); expect(failedResponses).toEqual([]);
          expect(traces.filter(row => row.classification.kind === 'original-cart')).toHaveLength(2); expect(traces.filter(row => row.classification.kind === 'sole-grant')).toHaveLength(1);
          expect(traces.filter(row => row.classification.kind === 'original-receipt')).toHaveLength(1); const orders = traces.filter(row => row.classification.kind === 'unpaid-order'); expect(orders).toHaveLength(2);
          // Local native teardown uses the actual authenticated cancel endpoint.
          // The formal mobile UI currently has no cancellation action.
          for (const row of orders) {
            const before = await snapshot(), canceled = await s.request('/api/order/cancel', { order_id: row.classification.orderId }); expect(canceled.status, canceled.msg).toBe(200);
            const after = await snapshot(); const changes = changedOnly(before, after, ['store_order', 'store_order_status', 'store_order_purchase_cancellation', 'store_product', 'store_product_attr_value', 'store_cart', 'store_coupon_user', 'user', 'user_bill']);
            controls.push({ kind: 'actual-native-unpaid-cancel-cleanup', orderId: row.classification.orderId, before: remember(before), after: remember(after), ...changes }); expected = after;
            const duplicate = await s.request('/api/order/cancel', { order_id: row.classification.orderId }); expect(duplicate.status).not.toBe(200); expect(await snapshot()).toEqual(expected);
          }
          expect(Number(one(expected.tables.user!, 'uid', 11).integral)).toBe(Number(one(baseline.tables.user!, 'uid', 11).integral));
          expect(one(expected.tables.store_product!, 'id', 70).stock).toBe(one(baseline.tables.store_product!, 'id', 70).stock);
          expect(one(expected.tables.store_product_attr_value!, 'id', 1).stock).toBe(one(baseline.tables.store_product_attr_value!, 'id', 1).stock);
          expect(one(expected.tables.store_coupon_user!, 'id', ids.olderOwned).status).toBe(0); expect(one(expected.tables.store_coupon_user!, 'id', ids.spentOwned)).toEqual(one(baseline.tables.store_coupon_user!, 'id', ids.spentOwned));
          expect(allocations).toHaveLength(2);
          for (const row of orders) {
            const made = row.classification;
            expect(one(expected.tables.store_coupon_user!, 'id', made.couponId)).toMatchObject({ uid: 11, status: 0, use_time: null });
            expect(one(expected.tables.store_cart!, 'id', made.cartId)).toMatchObject({ uid: 11, is_new: 1, is_pay: 0 });
            const bills = expected.tables.user_bill!.filter(bill => bill.uid === 11 && String(bill.link_id) === String(made.orderDbId) && bill.category === 'integral');
            if (made.usedIntegral > 0) {
              expect(bills).toHaveLength(2);
              expect(bills.find(bill => bill.event_key === 'order_integral_deduction')).toMatchObject({ pm: 0, number: made.usedIntegral });
              expect(bills.find(bill => bill.event_key === 'order_cancel_integral_back')).toMatchObject({ pm: 1, number: made.usedIntegral });
            } else expect(bills).toEqual([]);
          }
          expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]); expect(await manifest(sourcePaths)).toEqual(sourceBefore); expect(await manifest(buildPaths)).toEqual(buildBefore);
          finished = true; await persist('passed'); json(res, { accepted: true, finished, nativeCleanup: 2, tables: tableNames.length, sequences: sequenceNames.length }); done();
        } else throw Error('Unknown owned coupon buy QA action'); await persist();
      });
    }
    if (path.startsWith('/api/')) return api(req, res, url);
    expect(method).toBe('GET'); if (path === '/favicon.ico') return send(res, '', 204, 'text/plain');
    const target = path === '/__h5' ? resolve(dist, 'index.html') : resolve(dist, '.' + decodeURIComponent(path)); expect(target.startsWith(dist + sep)).toBe(true); expect((await stat(target)).isFile()).toBe(true);
    const raw = await readFile(target); staticPaths.push({ path, sha256: hash(raw) }); send(res, raw, 200, ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' } as Record<string, string>)[extname(target)] ?? 'application/octet-stream');
  })().catch(error => { failure ??= error; void persist().then(() => fail(error), () => fail(error)); if (!res.headersSent) send(res, String(error), 500, 'text/plain'); else res.end(); }); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local coupon buy listener'); origin = 'http://127.0.0.1:' + address.port;
    await writeFile(prefix + 'ready.json', JSON.stringify({ origin, url: origin + control, control, prefix, phases, ids, tables: tableNames.length, sequences: sequenceNames.length }, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('UNI_COUPON_BUY_BROWSER_READY ' + JSON.stringify({ url: origin + control, phases, ids }) + '\n'); deadline = setTimeout(() => fail(Error('Coupon buy Browser finish missing')), 90 * 60000); await completion; await queue;
    expect(await snapshot()).toEqual(expected);
  } catch (error) { failure ??= error; await persist('failed'); throw error; }
  finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes()));
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ finished, ownedListeners: 0, pending, failure: failure ? String(failure) : null }, null, 2) + '\n', { mode: 0o600 }); }
}), 92 * 60000);
