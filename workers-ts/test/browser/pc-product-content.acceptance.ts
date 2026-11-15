/** Installed Browser drives the production PC bundle. Every business response
 * comes from the actual App/JWT and commissioned restricted PG16 LOGIN; the
 * control surface can only select its finite local entries or arm two faults. */
import { expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { memberRight, storeBrand, storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponUser,
  storeProduct, storeProductAttrValue, storeProductCategory, storeProductDescription, storeProductLog, storeVisit, systemAttachment, systemConfig, user } from '@/models/schema';
import { withBuyerInvoices } from '../helpers/buyerInvoices';
import { buyerReviewPng, buyerReviewR2 } from '../helpers/buyerReviewR2';

const resultFile = '/tmp/cinashop-pc-product-content-browser-result.json';
const cleanupFile = '/tmp/cinashop-pc-product-content-browser-cleanup.json';
const ids = { product: 70, recommended: [80, 81, 82, 83, 84, 85], asset: 990101, category: 950102, categoryParent: 950101,
  brand: 950104, brandParent: 950103, lostClaim: 960000, normalClaim: 960004, memberCoupon: 960003 };

it('accepts complete PC product content, applicable coupons, two exact grants and explicit lost-ack readback', async () => withBuyerInvoices(async s => {
  const r2 = buyerReviewR2(), objectName = 'attachments/admin/1/pc_product_content.png';
  Object.assign(s.env, { ASSETS_BUCKET: r2.bucket });
  r2.objects.set(objectName, { bytes: buyerReviewPng.slice(), contentType: 'image/png' });
  await s.f.db.insert(systemAttachment).values({ attId: ids.asset, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
    name: objectName, attDir: '/api/assets/' + ids.asset, sattDir: '/api/assets/' + ids.asset, attType: 'image/png', attSize: String(buyerReviewPng.length) });
  await s.f.db.update(user).set({ nickname: '商品内容验收客户', isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 11));
  for (const [menuName, value] of Object.entries({ member_card_status: '1', member_func_status: '1' })) {
    await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName, menuName)); await s.f.db.insert(systemConfig).values({ menuName, value });
  }
  const rights = await s.f.db.update(memberRight).set({ status: 1 }).where(eq(memberRight.rightType, 'coupon')).returning({ id: memberRight.id });
  if (!rights.length) await s.f.db.insert(memberRight).values({ id: 950201, rightType: 'coupon', status: 1, number: 1 });
  await s.f.db.insert(storeProductCategory).values([{ id: ids.categoryParent, cateName: '浏览器父类' }, { id: ids.category, pid: ids.categoryParent, cateName: '浏览器商品分类', level: 1 }]);
  await s.f.db.insert(storeBrand).values([{ id: ids.brandParent, brandName: '浏览器品牌父类' }, { id: ids.brand, pid: ids.brandParent, brandName: '浏览器商品品牌' }]);
  await s.f.db.update(storeProduct).set({ storeName: '浏览器商品内容主样本', cateId: String(ids.category), brandId: ids.brand,
    recommendList: ids.recommended.join(','), image: '/api/qa/image.svg' }).where(eq(storeProduct.id, ids.product));
  await s.f.db.insert(storeProductDescription).values({ productId: ids.product, type: 0,
    description: '<h3>浏览器商品图文详情</h3><p>这是正式商品正文，图片来自当前商品可发布的平台附件。</p><img src="/api/assets/' + ids.asset + '" alt="商品正文签名图片"><p>优惠以服务端领取和结算为准。</p>' });
  for (const [index, id] of ids.recommended.entries()) {
    await s.f.db.insert(storeProduct).values({ id, storeName: '浏览器优品推荐 ' + (index + 1), price: (20 + index) + '.00', stock: 8,
      isShow: 1, isVerify: 1, image: '/api/qa/recommend.png', sort: 100 - index, recommendList: id === ids.recommended[0] ? '70' : '' });
    await s.f.db.insert(storeProductAttrValue).values({ id: 950300 + index, productId: id, type: 0, unique: 'pcont' + String(index).padStart(3, '0'), suk: '标准款', stock: 8, price: (20 + index) + '.00', image: '/api/qa/recommend.png' });
  }
  // This owned schema has no customer coupon history. Declare the complete
  // fixture rather than depending on unrelated migration defaults.
  await s.f.db.delete(storeCouponProduct); await s.f.db.delete(storeCouponIssueUser); await s.f.db.delete(storeCouponUser); await s.f.db.delete(storeCouponIssue);
  const now = Date.now(), yesterday = new Date(now - 86400000), nextMonth = new Date(now + 30 * 86400000);
  for (let index = 0; index < 21; index++) {
    const scope = index % 4, id = 960000 + index;
    await s.f.db.insert(storeCouponIssue).values({ id, category: id === ids.memberCoupon ? 2 : 0, couponType: scope,
      couponTitle: id === ids.lostClaim ? '仅余一张的相对商品券' : id === ids.normalClaim ? '正常领取的相对商品券' : id === ids.memberCoupon ? '付费会员品牌专享券' : '浏览器适用优惠券 ' + (index + 1),
      type: index % 2 ? 2 : 1, couponPrice: index % 2 ? '85.00' : '5.00', useMinPrice: '20.00',
      productId: scope === 2 ? '70' : '0', category_id: scope === 1 ? String(ids.categoryParent) : '0', brandId: scope === 3 ? String(ids.brandParent) : '0',
      receiveType: 1, appType: 0, receiveLimit: 3, totalCount: 9, remainCount: id === ids.lostClaim ? 1 : 9,
      day: index % 2 ? 0 : 7, startTime: yesterday, endTime: nextMonth, useStartTime: yesterday, useEndTime: nextMonth, sort: 1000 - index });
  }
  await s.f.db.insert(storeCouponIssue).values([
    { id: 960100, couponTitle: '不适用其他商品券', couponType: 2, productId: '999999', receiveType: 1, appType: 0, day: 7, remainCount: 9 },
    { id: 960101, couponTitle: '不适用其他分类券', couponType: 1, category_id: '999999', receiveType: 1, appType: 0, day: 7, remainCount: 9 },
    { id: 960102, couponTitle: '不适用其他品牌券', couponType: 3, brandId: '999999', receiveType: 1, appType: 0, day: 7, remainCount: 9 },
    { id: 960103, couponTitle: '已停发券', couponType: 0, receiveType: 1, appType: 0, day: 7, remainCount: 9, status: 0 },
    { id: 960104, couponTitle: '非公开手动券', couponType: 0, receiveType: 3, appType: 0, day: 7, remainCount: 9 },
    { id: 960105, couponTitle: '已过期券', couponType: 0, receiveType: 1, appType: 0, day: 0, remainCount: 9, useEndTime: yesterday },
  ]);
  const baseline = await s.f.state(), initialIssues = await s.f.db.select().from(storeCouponIssue).orderBy(storeCouponIssue.id);
  const initialAttachments = await s.f.db.select().from(systemAttachment).orderBy(systemAttachment.attId);
  for (const table of [storeProductLog, storeVisit, storeCouponUser, storeCouponIssueUser]) expect(await s.f.db.select().from(table)).toEqual([]);
  const changedTables = new Set(['store_coupon_issue', 'store_coupon_user', 'store_coupon_issue_user', 'store_product_log', 'store_visit']);
  const changedSequences = new Set(['store_coupon_user_id_seq', 'store_product_log_id_seq', 'store_visit_id_seq']);
  const tableNames = (await s.f.exec("SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname")).map(row => String(row.name));
  const sequenceNames = (await s.f.exec("SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S' ORDER BY relname")).map(row => String(row.name));
  for (const name of [...tableNames, ...sequenceNames]) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  async function fullSnapshot() {
    const tables: Record<string, unknown> = {}, sequences: Record<string, unknown> = {};
    for (const name of tableNames) if (!changedTables.has(name)) tables[name] = await s.f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`);
    for (const name of sequenceNames) if (!changedSequences.has(name)) sequences[name] = await s.f.exec(`SELECT last_value,is_called FROM public."${name}"`);
    return { tables, sequences };
  }
  const initialFull = await fullSnapshot(), bearer = await s.token(), control = '/__pc_product_content/' + crypto.randomUUID();
  const progress = { anonymousDirectory: false, directoryQueries: [] as Array<{ productId: number; uid: number; page: number; total: number; count: number }>,
    moreFailed: false, moreRetried: false, claims: [] as Array<{ couponId: number; couponUserId: number; started: number; ended: number }>, lostClaimAck: false,
    manualReadback: false, contentRefreshes: 0, recommendationRefreshes: 0, recommendationNavigated: false, returnedToProduct: false,
    memberReasonSeen: false, scopeTypes: [] as number[], imageReads: 0, signedDescriptionSeen: false, sixRecommendationProjection: false };
  const flags = { failMore: false, loseClaim: false };
  const calls: Array<{ path: string; query: string; method: string; uid: number; status: number; deliveredStatus: number }> = [];
  const productVisits: Array<{ productId: number; uid: number }> = [];
  let chain = Promise.resolve(), finished = false, origin = '';
  const state = () => ({ progress, flags, calls, productVisits, finished, ids, identity: { applicationLogin: s.appRole, applicationPid: s.appPid, uid: 11 },
    expectedUI: { recommendationCards: 5, lostClaimTitle: '仅余一张的相对商品券', normalClaimTitle: '正常领取的相对商品券' },
    r2: { reads: r2.reads.length, writes: r2.writes.length, deletes: r2.deletes.length }, fullBusinessTables: tableNames.length, protectedSequences: sequenceNames.length - changedSequences.size });
  async function verify(full = false) {
    expect(await s.f.state(), 'all original order, product, cart, user, money and config rows').toEqual(baseline);
    expect(await s.f.db.select().from(systemAttachment).orderBy(systemAttachment.attId)).toEqual(initialAttachments);
    const issues = await s.f.db.select().from(storeCouponIssue).orderBy(storeCouponIssue.id);
    expect(issues).toEqual(initialIssues.map(row => ({ ...row, remainCount: row.remainCount - progress.claims.filter(claim => claim.couponId === row.id).length })));
    const owned = await s.f.db.select().from(storeCouponUser).orderBy(storeCouponUser.id), evidence = await s.f.db.select().from(storeCouponIssueUser).orderBy(storeCouponIssueUser.issueCouponId);
    expect(owned).toHaveLength(progress.claims.length); expect(evidence).toHaveLength(progress.claims.length);
    for (const claim of progress.claims) {
      const row = owned.find(item => item.id === claim.couponUserId)!, issue = initialIssues.find(item => item.id === claim.couponId)!;
      expect(row).toMatchObject({ uid: 11, issueCouponId: claim.couponId, couponTitle: issue.couponTitle, couponPrice: issue.couponPrice,
        useMinPrice: issue.useMinPrice, status: 0, type: issue.type, receiveSource: 'get', isFail: 0, useTime: null });
      expect(row.startTime).toBeInstanceOf(Date); expect(row.endTime!.getTime() - row.startTime!.getTime()).toBe(7 * 86400000);
      expect(row.receiveTime).toBeGreaterThanOrEqual(claim.started); expect(row.receiveTime).toBeLessThanOrEqual(claim.ended);
      const logs = evidence.filter(item => item.uid === 11 && item.issueCouponId === claim.couponId); expect(logs).toHaveLength(1);
      expect(logs[0]!.addTime).toBeGreaterThanOrEqual(claim.started); expect(logs[0]!.addTime).toBeLessThanOrEqual(claim.ended);
    }
    const logs = await s.f.db.select().from(storeProductLog).orderBy(storeProductLog.id), visits = await s.f.db.select().from(storeVisit).orderBy(storeVisit.id);
    expect(logs).toHaveLength(productVisits.length);
    const aggregates = new Map<string, { uid: number; productId: number; count: number; addTime: number }>();
    logs.forEach((row, index) => {
      expect(row).toMatchObject({ ...productVisits[index], type: 'visit', visitNum: 1, cartNum: 0, orderNum: 0, payNum: 0,
        payPrice: '0.00', costPrice: '0.00', payUid: 0, refundNum: 0, refundPrice: '0.00', collectNum: 0, deleteTime: null });
      expect(row.addTime).toBeGreaterThan(0); const key = `${row.uid}:${row.productId}`, before = aggregates.get(key);
      if (!before) aggregates.set(key, { uid: row.uid, productId: row.productId, count: 1, addTime: row.addTime });
      else if (before.addTime + 20 < row.addTime) aggregates.set(key, { ...before, count: before.count + 1, addTime: row.addTime });
    });
    expect(visits).toHaveLength(aggregates.size);
    for (const row of visits) expect({ ...row, id: undefined, type: row.type.trimEnd() }).toEqual({ ...aggregates.get(`${row.uid}:${row.productId}`), id: undefined,
      productType: 'product', cateId: row.productId, type: 'view', content: '' });
    for (const [name, maximum] of [['store_coupon_user_id_seq', owned.at(-1)?.id], ['store_product_log_id_seq', logs.at(-1)?.id], ['store_visit_id_seq', visits.at(-1)?.id]] as const) {
      if (maximum !== undefined) expect(await s.f.exec(`SELECT last_value::text AS last_value,is_called FROM public."${name}"`)).toEqual([{ last_value: String(maximum), is_called: true }]);
    }
    expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]); expect(r2.objects.size).toBe(1); expect(r2.objects.get(objectName)!.bytes).toEqual(buyerReviewPng);
    expect(r2.reads.every(key => key === objectName)).toBe(true);
    if (full) expect(await fullSnapshot(), 'every other business table and sequence').toEqual(initialFull);
  }
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  const send = (res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'private, no-store' }); res.end(body); };
  const root = resolve(import.meta.dirname, '../../../view/pc-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const products = new Set<number>([ids.product, ...ids.recommended]);
  const readPaths = new Set(['/api/cart/count', '/api/cart/list', '/api/pc/get_company_info', '/api/share', '/api/site_config', '/api/diy/diy_version/0', '/api/diy/get_suspended', '/api/get_script', '/api/navigation', '/api/v2/diy/color_change/color_change']);
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>PC商品正文优惠券真实链验收</title><style>body{margin:0;font:14px sans-serif;background:#edf0f4}nav{padding:6px;display:flex;gap:6px;flex-wrap:wrap}button{padding:6px}iframe{display:block;border:0;width:100%;height:calc(100vh - 90px)}pre{margin:0;font-size:11px;max-height:28px;overflow:auto}</style><nav>${['anonymous','list','login','failMore','loseClaim','state','finish'].map(name => '<button id="' + name + '">' + name + '</button>').join('')}</nav><pre id="snapshot">真实App/JWT/受限PG；只领取两张明确样本券。未知领取后先点推荐1、从推荐页返回主样本，再核对原领取。</pre><iframe id="app" title="PC正式商品详情"></iframe><script>const base=${JSON.stringify(control)};for(const name of ['anonymous','list','login'])document.getElementById(name).onclick=()=>document.getElementById('app').src=base+'/bootstrap?entry='+name;for(const name of ['failMore','loseClaim','state','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(base+'/'+name,{method:'POST'});document.getElementById('snapshot').textContent=await r.text();};</script>`);
    if (path === control + '/bootstrap') {
      expect(method).toBe('GET'); expect([...url.searchParams.keys()]).toEqual(['entry']); const entry = url.searchParams.get('entry'); expect(['anonymous', 'list', 'login']).toContain(entry);
      const token = entry === 'anonymous' ? '' : bearer, uid = entry === 'anonymous' ? 0 : 11;
      return send(res, '<!doctype html><meta charset="utf-8"><script>sessionStorage.setItem("pc_token",' + JSON.stringify(token) + ');sessionStorage.setItem("pc_uid","' + uid + '");location.replace("/goods/70");</script>');
    }
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); expect(url.search).toBe(''); const action = path.slice(control.length + 1); expect(['failMore', 'loseClaim', 'state', 'finish']).toContain(action);
      chain = chain.then(async () => {
        if (action === 'failMore') { expect(progress.moreFailed).toBe(false); flags.failMore = true; }
        if (action === 'loseClaim') { expect(progress.claims).toHaveLength(0); flags.loseClaim = true; }
        await verify(action === 'state' || action === 'finish');
        if (action === 'finish') {
          expect(progress).toMatchObject({ anonymousDirectory: true, moreFailed: true, moreRetried: true, lostClaimAck: true, manualReadback: true,
            memberReasonSeen: true, signedDescriptionSeen: true, sixRecommendationProjection: true, recommendationNavigated: true, returnedToProduct: true });
          expect(new Set(progress.directoryQueries.filter(row => row.productId === 70 && row.uid === 11 && row.total === 21).map(row => row.page))).toEqual(new Set([1, 2, 3]));
          expect(new Set(progress.scopeTypes)).toEqual(new Set([0, 1, 2, 3])); expect(progress.contentRefreshes).toBeGreaterThanOrEqual(1); expect(progress.imageReads).toBeGreaterThan(0);
          expect(progress.claims.map(row => row.couponId).sort()).toEqual([ids.lostClaim, ids.normalClaim]);
          expect(calls.filter(call => call.method === 'POST')).toHaveLength(2); expect(flags).toEqual({ failMore: false, loseClaim: false });
          finished = true; await writeFile(resultFile, JSON.stringify(state(), null, 2) + '\n');
        }
        send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) done();
      }); await chain; return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path === '/api/qa/image.svg') return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#f4e4d8"/><text x="20" y="100" font-size="22">本机商品样本</text></svg>', 200, 'image/svg+xml');
    if (path === '/api/qa/recommend.png') return send(res, Buffer.from(buyerReviewPng), 200, 'image/png');
    if (path.startsWith('/api/')) {
      const chunks: Buffer[] = []; let size = 0; for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; expect(size).toBeLessThanOrEqual(4096); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      chain = chain.then(async () => {
        const productMatch = /^\/api\/product\/detail\/([1-9]\d*)(?:\/0)?$/.exec(path), productId = productMatch ? Number(productMatch[1]) : 0;
        const directoryMatch = /^\/api\/product\/detail\/([1-9]\d*)\/coupons$/.exec(path), directoryId = directoryMatch ? Number(directoryMatch[1]) : 0;
        const contentMatch=/^\/api\/product\/detail_content\/([1-9]\d*)$/.exec(path),recommendMatch=/^\/api\/product\/detail\/recommend\/([1-9]\d*)$/.exec(path);
        const receipt = path === `/api/product/detail/70/coupons/${ids.lostClaim}/receipt`, content = !!contentMatch&&products.has(Number(contentMatch[1])), recommend = !!recommendMatch&&products.has(Number(recommendMatch[1]));
        const reviews = /^\/api\/product\/reviews\/([1-9]\d*)$/.exec(path), packages = /^\/api\/store_discounts\/list\/([1-9]\d*)$/.exec(path), asset = path === '/api/assets/' + ids.asset;
        const token = (headers.get('authori-zation') || headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim(), uid = token ? 11 : 0;
        if (token) expect(token).toBe(bearer);
        const claim = method === 'POST' && path === '/api/coupon/receive';
        if (method === 'GET') expect((products.has(productId) || products.has(directoryId) || receipt || content || recommend || asset || reviews && products.has(Number(reviews[1])) || packages && products.has(Number(packages[1])) || readPaths.has(path)), 'GET ' + path).toBeTruthy();
        else { expect(claim, 'Only two explicit self-claims may write').toBe(true); expect(url.search).toBe(''); expect(token).toBe(bearer); }
        let couponId = 0, started = 0;
        if (claim) {
          const input = JSON.parse(bytes.toString('utf8')); expect(Object.keys(input)).toEqual(['id']); couponId = Number(input.id);
          expect([ids.lostClaim, ids.normalClaim]).toContain(couponId); expect(progress.claims.some(row => row.couponId === couponId)).toBe(false); expect(progress.claims.length).toBeLessThan(2);
          if (couponId === ids.lostClaim) expect(flags.loseClaim).toBe(true); else expect(flags.loseClaim).toBe(false);
          started = Math.floor(Date.now() / 1000);
        }
        if (directoryId === 70 && flags.failMore && uid === 11 && url.searchParams.get('page') === '2') {
          flags.failMore = false; progress.moreFailed = true; calls.push({ path, query: url.search, method, uid, status: 503, deliveredStatus: 503 });
          await verify(); return send(res, JSON.stringify({ status: 503, msg: '本机样本：第二页暂不可用，请重试本页', data: null }), 503, 'application/json');
        }
        const response = await s.fetch(new Request(origin + req.url, { method, headers, ...(bytes.length ? { body: bytes } : {}) }));
        const data = Buffer.from(await response.arrayBuffer()), json = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(data.toString('utf8')) : null;
        if (productId || directoryId || receipt || content || recommend || asset || claim || reviews || packages) expect(json?.status ?? response.status, json?.msg).toBe(200);
        if (productId) {
          productVisits.push({ productId, uid }); expect(json.data.id).toBe(productId);
          if (productId === 70) {
            expect(json.data.description).toContain('浏览器商品图文详情'); expect(json.data.description).toMatch(/\/api\/assets\/990101\?expires=[1-9]\d*&amp;signature=[A-Za-z0-9_-]{43}/);
            expect(json.data.recommend.map((row: { id: number }) => row.id)).toEqual(ids.recommended); progress.signedDescriptionSeen = true; progress.sixRecommendationProjection = true;
            if (progress.recommendationNavigated) progress.returnedToProduct = true;
          } else { expect(productId).toBe(ids.recommended[0]); if (progress.lostClaimAck) progress.recommendationNavigated = true; }
        }
        if (directoryId) {
          const page = json.data; expect(page).toMatchObject({ version: 1, uid, productId: directoryId, limit: 10 });
          if (directoryId === 70) {
            expect(page.total).toBe(progress.claims.some(row => row.couponId === ids.lostClaim) ? 20 : 21);
            expect(page.items).toHaveLength(Math.min(10, Math.max(0, page.total - (page.page - 1) * 10)));
            for (const item of page.items) { expect(item.id).toBeGreaterThanOrEqual(960000); expect(item.id).toBeLessThan(960021); progress.scopeTypes.push(item.scopeType);
              if (item.id === ids.memberCoupon && uid === 11) { expect(item).toMatchObject({ isMember: true, claimable: false }); expect(item.claimReason).toContain('付费会员'); progress.memberReasonSeen = true; } }
            if (uid === 0) progress.anonymousDirectory = true;
            if (page.page === 2 && progress.moreFailed) progress.moreRetried = true;
          }
          progress.directoryQueries.push({ productId: directoryId, uid, page: page.page, total: page.total, count: page.items.length });
        }
        if (content) { if(Number(contentMatch![1])===70){expect(json.data.description).toContain('浏览器商品图文详情');progress.contentRefreshes++;}else expect(json.data.description).toBe(''); }
        if (recommend) { expect(json.data.map((row: { id: number }) => row.id)).toEqual(Number(recommendMatch![1])===70?ids.recommended:Number(recommendMatch![1])===80?[70]:[]);if(Number(recommendMatch![1])===70)progress.recommendationRefreshes++; }
        if (claim) { expect(json.data.couponUserId).toBeGreaterThan(0); progress.claims.push({ couponId, couponUserId: json.data.couponUserId, started, ended: Math.floor(Date.now() / 1000) }); }
        if (receipt) { expect(uid).toBe(11); expect(progress.lostClaimAck).toBe(true); expect(progress.recommendationNavigated && progress.returnedToProduct).toBe(true);
          expect(json.data).toMatchObject({ version: 1, uid: 11, productId: 70, couponId: ids.lostClaim, receivedCount: 1 }); expect(json.data.latestCouponUserId).toBe(progress.claims.find(row => row.couponId === ids.lostClaim)!.couponUserId); progress.manualReadback = true; }
        if (asset) { expect(token).toBe(''); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']); expect(data).toEqual(Buffer.from(buyerReviewPng)); progress.imageReads++; }
        await verify(); let outgoing = data, deliveredStatus = response.status;
        if (claim && flags.loseClaim) { flags.loseClaim = false; progress.lostClaimAck = true; deliveredStatus = 503; outgoing = Buffer.from(JSON.stringify({ status: 503, msg: '本机样本：优惠券已领取但回执丢失，请核对领取状态', data: null })); }
        calls.push({ path, query: url.search, method, uid, status: json?.status ?? response.status, deliveredStatus });
        const responseHeaders = Object.fromEntries(response.headers); delete responseHeaders['content-length']; res.writeHead(deliveredStatus, responseHeaders); res.end(outgoing);
      }); await chain; return;
    }
    expect(method).toBe('GET'); const target = resolve(root, '.' + path); expect(target === root || target.startsWith(root + sep)).toBe(true);
    const file = await stat(target).catch(() => null), selected = file?.isFile() ? target : resolve(root, 'index.html');
    send(res, await readFile(selected), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' } as Record<string, string>)[extname(selected)] ?? 'text/html; charset=utf-8');
  })().catch(error => { if (!res.headersSent) send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
  try {
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Owned PC listener missing'); origin = 'http://127.0.0.1:' + address.port;
    await verify(); process.stdout.write('PC_PRODUCT_CONTENT_BROWSER_READY ' + JSON.stringify({ pc: origin + control, ids, lostClaimTitle: '仅余一张的相对商品券', normalClaimTitle: '正常领取的相对商品券' }) + '\n');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { deadline = setTimeout(() => fail(Error('PC product content Browser finish missing')), 90 * 60000); await completion; }
    finally { if (deadline) clearTimeout(deadline); }
  } finally {
    flags.failMore = false; flags.loseClaim = false; server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes()));
    await writeFile(cleanupFile, JSON.stringify({ finished, ownedListeners: 0, faultsCleared: !flags.failMore && !flags.loseClaim }, null, 2) + '\n');
  }
}), 92 * 60000);
