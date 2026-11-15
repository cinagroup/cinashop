/** Installed Browser acceptance: real production PC/H5, App/UserJWT and the
 * commissioned PG16 application LOGIN. Control buttons only seed local browser
 * storage or arm finite faults; product interactions use the rendered app. */
import { expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { community, communityRelevance, communityUser, storeProductReply, storeProductReplyComment,
  storeProductLog, storeVisit, systemAttachment, systemConfig, systemUserLevel, user, userRelation } from '@/models/schema';
import { withBuyerInvoices } from '../helpers/buyerInvoices';
import { buyerReviewPng, buyerReviewR2 } from '../helpers/buyerReviewR2';

type Surface = 'pc' | 'uni';
const surfaces = ['pc', 'uni'] as const;
const resultFile = '/tmp/cinashop-public-product-reviews-browser-result.json';
const cleanupFile = '/tmp/cinashop-public-product-reviews-browser-cleanup.json';
const ids = { pc: { product: 70, review: 930001, root: 940021, child: 940121, asset: 990001 },
  uni: { product: 71, review: 931001, root: 941021, child: 941121, asset: 990002 } };
const newText = (surface: Surface) => surface + ' 浏览器新增回复';

it('accepts complete public review buckets, bounded paging and private interaction with explicit lost-ack readback', async () => withBuyerInvoices(async s => {
  const r2 = buyerReviewR2(); Object.assign(s.env, { ASSETS_BUCKET: r2.bucket });
  await s.f.db.update(user).set({ nickname: '浏览器评价客户', avatar: '/api/qa/image.png', level: 930, isEverLevel: 1 }).where(eq(user.uid, 11));
  await s.f.db.insert(systemUserLevel).values({ id: 930, name: '本机金牌', isShow: 1 });
  // PHP stores JSON scalars in these rows. The actual serializer must decode them.
  for (const [menuName, scalar] of Object.entries({ site_name: '浏览器平台', site_logo_square: '/api/qa/image.png', member_func_status: '1', member_card_status: '1' })) {
    await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName, menuName));
    await s.f.db.insert(systemConfig).values({ menuName, value: JSON.stringify(scalar) });
  }
  for (const surface of surfaces) {
    const id = ids[surface], objectName = `attachments/user/11/${surface}_public_review.png`;
    await s.f.db.insert(systemAttachment).values({ attId: id.asset, type: 3, moduleType: 3, relationId: 11, fileType: 1,
      imageType: 8, name: objectName, attDir: '/api/assets/' + id.asset, sattDir: '/api/assets/' + id.asset,
      attType: 'image/png', attSize: String(buyerReviewPng.length) });
    r2.objects.set(objectName, { bytes: buyerReviewPng.slice(), contentType: 'image/png' });
    await s.f.db.insert(storeProductReply).values(Array.from({ length: 21 }, (_, index) => {
      const bucket = Math.floor(index / 7), score = bucket === 0 ? 5 : bucket === 1 ? 4 : 2;
      return { id: id.review + index, productId: id.product, uid: 11, nickname: '浏览器评价客户', avatar: '/api/qa/image.png',
        comment: `${surface} ${index === 0 ? '置顶图文评价' : ['好评', '中评', '差评'][bucket] + ' ' + (index + 1)}`,
        sku: '蓝色 · 标准款', unique: surface + '_public_' + index, type: 0, relationId: 0, top: index === 0 ? 1 : 0,
        productScore: score, serviceScore: 5, deliveryScore: 5, logisticsScore: 5, replyScore: bucket === 0 ? 3 : bucket === 1 ? 2 : 1,
        addTime: 1794604000 + index, pics: JSON.stringify(index === 0 ? ['/api/assets/' + id.asset] : []),
        isReply: index === 0 ? 1 : 0, merchantReply: index === 0 ? '感谢你的真实评价' : '',
        merchantReplyContent: index === 0 ? '感谢你的真实评价' : '', merchantReplyTime: index === 0 ? 1794605000 : 0,
        viewsNum: 8, praise: 0 };
    }));
    const roots = Array.from({ length: 21 }, (_, index) => ({ id: id.root - 20 + index, replyId: id.review, uid: 11,
      nickname: '浏览器评价客户', avatar: '/api/qa/image.png', content: `${surface} 根回复 ${index + 1}`, addTime: 1794606000 + index }));
    await s.f.db.insert(storeProductReplyComment).values(roots);
    await s.f.db.insert(storeProductReplyComment).values(roots.map((row, index) => ({ id: id.child - 20 + index,
      replyId: id.review, pid: row.id, uid: 0, type: 0, relationId: 0, content: `${surface} 平台直属回复 ${index + 1}`, addTime: 1794607000 + index })));
  }
  await s.f.exec("SELECT setval('public.store_product_reply_comment_id_seq',(SELECT max(id) FROM public.store_product_reply_comment),true)");
  const baseline = await s.f.state(), initialReviews = await s.f.db.select().from(storeProductReply).orderBy(storeProductReply.id),
    initialComments = await s.f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id),
    initialAttachments = await s.f.db.select().from(systemAttachment).orderBy(systemAttachment.attId);
  for (const table of [community, communityRelevance, communityUser, userRelation, storeProductLog, storeVisit]) expect(await s.f.db.select().from(table)).toEqual([]);
  const bearer = await s.token(), control = '/__public_product_reviews/' + crypto.randomUUID();
  const makeProgress = () => ({ listQueries: [] as Array<{ type: number; page: number; total: number; count: number }>, moreFailed: false,
    moreRetried: false, visits: 0, reads: 0, rootPages: [] as number[], commentRequests: 0, commentId: 0, lostCommentAck: false,
    manualReadback: false, manualRefresh: false, reviewLikes: 0, rootLikes: 0, childLikes: 0, imageReads: 0,
    anonymousDirectory: false, legacyListOpened: false });
  const progress = { pc: makeProgress(), uni: makeProgress() };
  const flags = { pc: { failMore: false, loseComment: false, readOnly: false }, uni: { failMore: false, loseComment: false, readOnly: false } };
  const calls: Array<{ surface: Surface; path: string; query: string; method: string; status: number; deliveredStatus: number }> = [];
  const productVisits: Array<{ productId: number; uid: number }> = [];
  let chain = Promise.resolve(), finished = false;
  const state = () => ({ progress, flags, calls, finished, ids, identity: { applicationLogin: s.appRole, applicationPid: s.appPid, uid: 11 },
    r2: { reads: r2.reads.length, writes: r2.writes.length, deletes: r2.deletes.length } });
  async function verify() {
    expect(await s.f.state(), 'orders, money, products, users and configuration remain unchanged').toEqual(baseline);
    expect(await s.f.db.select().from(systemAttachment).orderBy(systemAttachment.attId)).toEqual(initialAttachments);
    for (const table of [community, communityRelevance, communityUser]) expect(await s.f.db.select().from(table)).toEqual([]);
    const reviews = await s.f.db.select().from(storeProductReply).orderBy(storeProductReply.id), comments = await s.f.db.select().from(storeProductReplyComment).orderBy(storeProductReplyComment.id),
      relations = await s.f.db.select().from(userRelation).orderBy(userRelation.id);
    expect(reviews).toHaveLength(initialReviews.length); expect(comments).toHaveLength(initialComments.length + progress.pc.commentRequests + progress.uni.commentRequests);
    for (const old of initialReviews) {
      const surface = surfaces.find(key => ids[key].review === old.id), current = reviews.find(row => row.id === old.id)!;
      expect(current).toEqual({ ...old, viewsNum: old.viewsNum + (surface ? progress[surface].visits : 0), praise: surface ? progress[surface].reviewLikes : old.praise });
    }
    for (const old of initialComments) {
      const surface = surfaces.find(key => ids[key].root === old.id || ids[key].child === old.id), current = comments.find(row => row.id === old.id)!;
      expect(current).toEqual({ ...old, praise: surface ? old.id === ids[surface].root ? progress[surface].rootLikes : progress[surface].childLikes : old.praise });
    }
    for (const surface of surfaces) {
      const p = progress[surface], id = ids[surface], added = comments.filter(row => row.replyId === id.review && !initialComments.some(old => old.id === row.id));
      expect(added).toHaveLength(p.commentRequests);
      if (added[0]) { expect(added[0]).toMatchObject({ id: p.commentId, type: 0, relationId: 0, replyId: id.review, pid: 0, uid: 11,
        nickname: '浏览器评价客户', avatar: '/api/qa/image.png', content: newText(surface), praise: 0, isDel: 0, updateTime: 0 }); expect(added[0].addTime).toBeGreaterThan(0); }
    }
    const expectedRelations = surfaces.flatMap(surface => {
      const p = progress[surface], id = ids[surface]; return [
        ...(p.reviewLikes ? [{ uid: 11, relationId: id.review, type: 'like', category: 'reply' }] : []),
        ...(p.rootLikes ? [{ uid: 11, relationId: id.root, type: 'like', category: 'comment' }] : []),
        ...(p.childLikes ? [{ uid: 11, relationId: id.child, type: 'like', category: 'comment' }] : []),
      ];
    });
    expect(relations).toHaveLength(expectedRelations.length);
    expect(relations.map(({ uid, relationId, type, category }) => ({ uid, relationId, type, category })).sort((a, b) => a.relationId - b.relationId))
      .toEqual(expectedRelations.sort((a, b) => a.relationId - b.relationId));
    for (const row of relations) expect(row.addTime).toBeGreaterThan(0);
    const logs = await s.f.db.select().from(storeProductLog), visits = await s.f.db.select().from(storeVisit);
    expect(logs).toHaveLength(productVisits.length);
    expect(logs.map(({ productId, uid, type, visitNum }) => ({ productId, uid, type, visitNum })).sort((a, b) => a.uid - b.uid))
      .toEqual(productVisits.map(row => ({ ...row, type: 'visit', visitNum: 1 })).sort((a, b) => a.uid - b.uid));
    const visitKeys = [...new Set(productVisits.map(row => `${row.uid}:${row.productId}`))]; expect(visits).toHaveLength(visitKeys.length);
    for (const row of visits) { expect(visitKeys).toContain(`${row.uid}:${row.productId}`); expect({ ...row, type: row.type.trimEnd() }).toMatchObject({ productType: 'product', cateId: row.productId, type: 'view', content: '' });
      expect(row.count).toBeGreaterThanOrEqual(1); expect(row.count).toBeLessThanOrEqual(productVisits.filter(item => item.uid === row.uid && item.productId === row.productId).length); }
    expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]); expect(r2.objects.size).toBe(2); for (const value of r2.objects.values()) expect(value.bytes).toEqual(buyerReviewPng);
  }
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  const send = (res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'private, no-store' }); res.end(body); };
  const servers: Array<ReturnType<typeof createServer>> = [], origins: Record<string, string> = {};
  const readPaths = new Set(['/api/cart/count', '/api/cart/list', '/api/pc/get_company_info', '/api/share', '/api/site_config', '/api/diy/diy_version/0', '/api/diy/get_suspended', '/api/get_script', '/api/navigation', '/api/v2/diy/color_change/color_change']);
  try {
    for (const surface of surfaces) {
      const root = resolve(import.meta.dirname, surface === 'pc' ? '../../../view/pc-ts/dist' : '../../../view/uniapp-ts/dist/build/h5');
      expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
      const server = createServer((req, res) => { void (async () => {
        const origin = origins[surface]; if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
        const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET', p = progress[surface], id = ids[surface], flag = flags[surface];
        if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>公开商品评价真实链验收 ${surface}</title><style>body{margin:0;font:14px sans-serif;background:#edf0f4}nav{padding:6px;display:flex;gap:6px;flex-wrap:wrap}button{padding:6px}iframe{display:block;border:0;width:100%;height:calc(100vh - 112px)}pre{margin:0;font-size:11px;max-height:28px;overflow:auto}</style><nav>${['list','legacyList','detail','anonymous','malformed','failMore','loseComment','readOnly','state','finish'].map(name => '<button id="' + name + '">' + name + '</button>').join('')}</nav><pre id="snapshot">真实 App/JWT/受限 SQL；仅本机样本。新增回复必须填写：${newText(surface)}</pre><iframe id="app" title="${surface} 正式公开商品评价页面"></iframe><script>const base=${JSON.stringify(control)};for(const name of ['list','legacyList','detail','anonymous','malformed'])document.getElementById(name).onclick=()=>{document.getElementById('app').src=base+'/bootstrap?entry='+name;};for(const name of ['failMore','loseComment','readOnly','state','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(base+'/'+name,{method:'POST'});document.getElementById('snapshot').textContent=await r.text();};</script>`);
        if (path === control + '/bootstrap') {
          expect(method).toBe('GET'); expect([...url.searchParams.keys()]).toEqual(['entry']); const entry = url.searchParams.get('entry');
          expect(['list','legacyList','detail','anonymous','malformed']).toContain(entry);
          if (entry === 'legacyList' && surface === 'uni') p.legacyListOpened = true;
          const target = entry === 'detail' ? surface === 'pc' ? '/reviews/' + id.review : '/#/pages/goods/commentDetail?id=' + id.review
            : entry === 'malformed' ? surface === 'pc' ? '/reviews/' + id.review + '?id=1&id=1' : '/#/pages/goods/commentDetail?id=' + id.review + '&id=' + id.review
            : surface === 'pc' ? '/goods/' + id.product : entry === 'legacyList' ? '/#/pages/goods/goods_comment_list/index?product_id=' + id.product : '/#/pages/goods/commentList?productId=' + id.product;
          const token = entry === 'anonymous' ? '' : bearer, uid = entry === 'anonymous' ? 0 : 11;
          const storage = surface === 'pc' ? `sessionStorage.setItem('pc_token',${JSON.stringify(token)});sessionStorage.setItem('pc_uid','${uid}');`
            : `localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:${uid}}));`;
          return send(res, '<!doctype html><meta charset="utf-8"><script>' + storage + 'location.replace(' + JSON.stringify(target) + ');</script>');
        }
        if (path.startsWith(control + '/')) {
          expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); const action = path.slice(control.length + 1); expect(['failMore','loseComment','readOnly','state','finish']).toContain(action);
          chain = chain.then(async () => {
            if (action === 'failMore') { expect(p.moreFailed).toBe(false); flag.failMore = true; }
            if (action === 'loseComment') { expect(surface).toBe('uni'); expect(p.commentRequests).toBe(0); flag.loseComment = true; }
            if (action === 'readOnly') { expect(p.visits).toBe(1); flag.readOnly = true; }
            await verify();
            if (action === 'finish') {
              for (const key of surfaces) { const item = progress[key];
                expect(new Set(item.listQueries.map(row => row.type))).toEqual(new Set([0,1,2,3]));
                expect(new Set(item.listQueries.filter(row => row.type === 0).map(row => row.page))).toEqual(new Set([1,2,3]));
                expect(item).toMatchObject({ anonymousDirectory: true, moreFailed: true, moreRetried: true, visits: 1, commentRequests: 1, manualRefresh: true, reviewLikes: 1, rootLikes: 1, childLikes: 1 });
                expect(item.rootPages).toContain(2); expect(item.imageReads).toBeGreaterThan(0); expect(item.reads).toBeGreaterThanOrEqual(4);
                expect(flags[key]).toEqual({ failMore: false, loseComment: false, readOnly: false });
                expect(calls.filter(call => call.surface === key && call.method === 'POST' && call.path.endsWith('/comment'))).toHaveLength(1);
                expect(calls.filter(call => call.surface === key && call.method === 'POST' && call.path.endsWith('/visit'))).toHaveLength(1);
              }
              expect(progress.pc.lostCommentAck).toBe(false); expect(progress.uni.lostCommentAck).toBe(true); expect(progress.uni.manualReadback).toBe(true); expect(progress.uni.legacyListOpened).toBe(true);
              finished = true; await writeFile(resultFile, JSON.stringify(state(), null, 2) + '\n');
            }
            send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) done();
          }); await chain; return;
        }
        if (path === '/favicon.ico') return send(res, '', 204);
        if (path === '/api/qa/image.svg') return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#eee"/><text x="10" y="43" font-size="13">本机样本</text></svg>', 200, 'image/svg+xml');
        if (path === '/api/qa/image.png') return send(res, Buffer.from(buyerReviewPng), 200, 'image/png');
        if (path.startsWith('/api/')) {
          const chunks: Buffer[] = []; let size = 0; for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; expect(size).toBeLessThanOrEqual(4096); chunks.push(chunk); }
          const bytes = Buffer.concat(chunks), headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
          chain = chain.then(async () => {
            const prefix = '/api/product/review/' + id.review, list = path === '/api/product/reviews/' + id.product, detail = path === prefix,
              comments = path === prefix + '/comments', visit = path === prefix + '/visit', comment = path === prefix + '/comment',
              praise = path === prefix + '/praise' || path === prefix + '/comments/' + id.root + '/praise' || path === prefix + '/comments/' + id.child + '/praise',
              product = path === '/api/product/detail/' + id.product || path === '/api/product/detail/' + id.product + '/0',
              asset = path === '/api/assets/' + id.asset;
            if (method === 'GET') expect(list || detail || comments || product || asset || path === '/api/store_discounts/list/' + id.product || readPaths.has(path), 'GET ' + path).toBe(true);
            else { expect(method).toBe('POST'); expect(visit || comment || praise, 'POST ' + path).toBe(true); expect(url.search).toBe(''); }
            const token = (headers.get('authori-zation') || headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
            const uid = token ? 11 : 0; if (token) expect(token).toBe(bearer);
            if (method === 'POST') {
              expect(token).toBe(bearer); const input = JSON.parse(bytes.toString('utf8'));
              if (visit) { expect(input).toEqual({ version: 1 }); expect(p.visits).toBe(0); }
              if (comment) { expect(input).toEqual({ version: 1, content: newText(surface) }); expect(p.commentRequests).toBe(0); if (surface === 'uni') expect(flag.loseComment).toBe(true); }
              if (praise) { expect(input).toEqual({ version: 1, praised: true }); const count = path === prefix + '/praise' ? p.reviewLikes : path.includes('/' + id.root + '/') ? p.rootLikes : p.childLikes; expect(count).toBe(0); }
            }
            if (list && flag.failMore && url.searchParams.get('type') === '0' && url.searchParams.get('page') === '2') {
              flag.failMore = false; p.moreFailed = true; calls.push({ surface, path, query: url.search, method, status: 503, deliveredStatus: 503 });
              await verify(); return send(res, JSON.stringify({ status: 503, msg: '本机样本：第二页暂不可用，请重试本页', data: null }), 503, 'application/json');
            }
            const response = await s.fetch(new Request(origin + req.url, { method, headers, ...(bytes.length ? { body: bytes } : {}) }));
            const data = Buffer.from(await response.arrayBuffer()), json = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(data.toString('utf8')) : null;
            if (list || detail || comments || visit || comment || praise || product || asset) expect(json?.status ?? response.status, json?.msg).toBe(200);
            if (product) productVisits.push({ productId: id.product, uid });
            if (list) {
              const page = json.data; expect(page.stats).toMatchObject({ total: 21, good_count: 7, in_count: 7, poor_count: 7 });
              expect(page).toMatchObject({ version: 1, uid, productId: id.product, limit: 10 }); expect(page.total).toBe(page.type ? 7 : 21);
              expect(page.items).toHaveLength(Math.min(10, Math.max(0, page.total - (page.page - 1) * 10)));
              expect(page.items.every((item: { level_name: string; vip_status: number }) => item.level_name === '本机金牌' && item.vip_status === 1)).toBe(true);
              p.listQueries.push({ type: page.type, page: page.page, total: page.total, count: page.items.length });
              if (page.type === 0 && page.page === 2 && p.moreFailed) p.moreRetried = true; if (uid === 0) p.anonymousDirectory = true;
            }
            if (visit) p.visits++;
            if (detail) { p.reads++; if (flag.readOnly) { flag.readOnly = false; p.manualRefresh = true; } if (p.lostCommentAck) p.manualReadback = true; }
            if (detail || visit) { expect(json.data.detail.reply).toMatchObject({ id: id.review, views_num: 8 + p.visits }); expect(json.data.detail.user).toMatchObject({ level_name: '本机金牌', vip_status: 1 }); }
            if (comments) {
              expect(json.data).toMatchObject({ total: 21 + p.commentRequests, replyId: id.review, uid: 11, limit: 20 }); p.rootPages.push(json.data.page);
              for (const item of json.data.items) if (item.children) expect(item.children.user).toMatchObject({ uid: 0, nickname: '浏览器平台', avatar: '/api/qa/image.png' });
            }
            if (comment) { p.commentRequests++; p.commentId = json.data.commentId; expect(json.data).toMatchObject({ version: 1, uid: 11, replyId: id.review }); }
            if (praise) { if (path === prefix + '/praise') p.reviewLikes++; else if (path.includes('/' + id.root + '/')) p.rootLikes++; else p.childLikes++;
              expect(json.data).toMatchObject({ version: 1, uid: 11, replyId: id.review, isPraise: true, praise: 1 }); }
            if (asset) { expect(token).toBe(''); expect(data).toEqual(Buffer.from(buyerReviewPng)); p.imageReads++; }
            await verify(); let outgoing = data, code = response.status;
            if (comment && flag.loseComment) { flag.loseComment = false; p.lostCommentAck = true; code = 503; outgoing = Buffer.from(JSON.stringify({ status: 503, msg: '本机样本：回复已保存但回执丢失，请刷新核对', data: null })); }
            calls.push({ surface, path, query: url.search, method, status: json?.status ?? response.status, deliveredStatus: code });
            const resultHeaders = Object.fromEntries(response.headers); delete resultHeaders['content-length']; res.writeHead(code, resultHeaders); res.end(outgoing);
          }); await chain; return;
        }
        expect(method).toBe('GET'); const target = resolve(root, '.' + path); expect(target === root || target.startsWith(root + sep)).toBe(true);
        const file = await stat(target).catch(() => null), selected = file?.isFile() ? target : resolve(root, 'index.html');
        send(res, await readFile(selected), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf' } as Record<string, string>)[extname(selected)] ?? 'text/html; charset=utf-8');
      })().catch(error => { if (!res.headersSent) send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
      servers.push(server); await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned listener'); origins[surface] = 'http://127.0.0.1:' + address.port;
    }
    await verify(); process.stdout.write('PUBLIC_PRODUCT_REVIEWS_BROWSER_READY ' + JSON.stringify({ pc: origins.pc + control, uni: origins.uni + control, ids }) + '\n');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { deadline = setTimeout(() => fail(Error('Public product reviews Browser finish missing')), 90 * 60000); await completion; }
    finally { if (deadline) clearTimeout(deadline); }
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
    for (const surface of surfaces) flags[surface] = { failMore: false, loseComment: false, readOnly: false };
    await writeFile(cleanupFile, JSON.stringify({ finished, ownedListeners: 0,
      faultsCleared: Object.values(flags).every(flag => Object.values(flag).every(value => value === false)) }, null, 2) + '\n');
  }
}), 92 * 60000);
