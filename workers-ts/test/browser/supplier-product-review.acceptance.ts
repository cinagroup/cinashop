/** Genuine production Vue controls + App/JWT + independent owned PG16 roles. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { supplierProductReplyFixture } from '../helpers/supplierProductReply';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned review LOGIN'); return wiring.container;
} }));
it('drills down from products, replies and edits one original review, isolates another product and cancels session ABA through IAB', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierProductReplyFixture(), app = createApp(), control = '/__supplier_review_fixture/' + randomUUID();
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const baseline: Record<string, any[]> = await f.snapshot(), initialSequence = await f.sequence(), paths: any[] = [], roleProofs: any[] = [], releaseAttempts: any[] = [];
  const containers: Record<string, Container> = {}, held: Array<{ deliver: () => void; destroyed: () => boolean }> = [];
  let origin = '', finished = false, outbound = 0, armHold = false, heldCount = 0, sessionChanges = 0, viewer = false, chain = Promise.resolve();
  let finish!: () => void, fail!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; }), sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const state = () => ({ finished, outbound, heldCount, sessionChanges, viewer, paths, roleProofs, releaseAttempts });
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (res.destroyed) return; res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  function verifyOnlyReplies(after: Record<string, any[]>) {
    for (const [table, rows] of Object.entries(baseline)) {
      if (table === 'store_product_reply') expect(after[table]).toEqual(rows.map(item => ({ row: { ...item.row, ...(item.row.id === 601 ? { is_reply: 1 } : {}) } })));
      else if (table !== 'store_product_reply_comment') expect(after[table], table).toEqual(rows);
    }
    const oldComments = baseline.store_product_reply_comment, comments = after.store_product_reply_comment;
    expect(comments.filter(item => item.row.id !== 1000)).toEqual(oldComments);
    expect(comments).toHaveLength(oldComments.length + 1);
    const created = comments.find(item => item.row.id === 1000)?.row;
    expect(created).toEqual({ id: 1000, type: 2, relation_id: 7, reply_id: 601, pid: 0, uid: 0, nickname: '', avatar: '',
      content: '浏览器商品A修订回复', praise: 0, is_del: 0, add_time: expect.any(Number), update_time: expect.any(Number) });
    expect(created.add_time).toBeGreaterThan(0); expect(created.update_time).toBeGreaterThanOrEqual(created.add_time);
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>商品评价 PG16 本机验收</title><h1>商品评价钻取与回复</h1><p>仅本机合成商品与评价，真实 App/JWT 与独立受限 PostgreSQL 16。</p><button id="enter">进入商品管理</button><button id="hold">扣留下一评价读取</button><button id="other">切换另一合成账号</button><button id="restore">恢复原合成账号</button><button id="release">释放已扣留回复</button><button id="viewer">切换只读合成账号</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
      const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
      function session(viewer=false){localStorage.setItem('supplier-token',viewer?tokens.viewer:tokens.reader);localStorage.setItem('supplier-user',JSON.stringify({id:viewer?22:21,supplier_id:7,supplier_name:'本机商品评价供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(viewer?['supplier.product.view']:['supplier.product.view','supplier.product.manage']));}
      document.getElementById('enter').onclick=()=>{session();location.href='/products';};
      for(const action of ['hold','other','restore','release','viewer','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other'||action==='viewer')session(true);if(action==='restore')session();};</script>`);
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); await chain;
      if (path.endsWith('/hold')) { expect(paths.filter(row => row.method === 'PUT')).toHaveLength(2); expect(heldCount).toBe(0); armHold = true; }
      if (path.endsWith('/other')) { expect(held).toHaveLength(1); expect(sessionChanges).toBe(0); sessionChanges++; }
      if (path.endsWith('/restore')) { expect(sessionChanges).toBe(1); sessionChanges++; }
      if (path.endsWith('/release')) { expect(sessionChanges).toBe(2); expect(held).toHaveLength(1); while (held.length) { const item = held.shift()!; releaseAttempts.push({ socket_destroyed: item.destroyed() }); item.deliver(); } }
      if (path.endsWith('/viewer')) { expect(sessionChanges).toBe(2); expect(releaseAttempts).toHaveLength(1); viewer = true; }
      if (path.endsWith('/finish')) {
        expect(viewer).toBe(true); expect(heldCount).toBe(1); expect(armHold).toBe(false); expect(held).toHaveLength(0); expect(outbound).toBe(0);
        const puts = paths.filter(row => row.method === 'PUT'); expect(puts).toHaveLength(2); expect(puts.map(row => row.body)).toEqual([
          { content: '浏览器商品A回复', expected_product_id: 80 }, { content: '浏览器商品A修订回复', expected_product_id: 80 }]);
        expect(puts.every(row => row.path === '/supplierapi/product/reply/set_reply/601' && row.envelope === 200)).toBe(true);
        expect(paths.some(row => row.path === '/supplierapi/product/product/list' && row.envelope === 200)).toBe(true);
        expect(paths.some(row => row.query?.includes('product_id=80') && row.query?.includes('is_reply=0'))).toBe(true);
        expect(paths.some(row => row.query?.includes('product_id=81') && row.actor === 22 && row.envelope === 200)).toBe(true);
        expect(paths.some(row => row.path === '/api/get_script' && row.status === 200)).toBe(true);
        const after = await f.snapshot(); verifyOnlyReplies(after); expect(await f.sequence()).toEqual([{ last_value: '1000', is_called: true }]); finished = true;
        await writeFile('/tmp/cinashop-supplier-product-review-browser-result.json', JSON.stringify({ ...state(), baseline, final: after, initial_sequence: initialSequence, final_sequence: await f.sequence(), final_snapshot_sha256: sha(JSON.stringify(after)) }, null, 2) + '\n');
      }
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      expect(method === 'GET' || method === 'PUT').toBe(true);
      expect(path === '/api/get_script' || ['/supplierapi/product/product/list', '/supplierapi/product/reply', '/supplierapi/product/reply/set_reply/601'].includes(path)).toBe(true);
      let release!: () => void; const previous = chain; chain = new Promise(done => { release = done; }); await previous;
      let bytes = Buffer.alloc(0), status = 200, headers: Record<string, string> = {}, hold = false;
      try {
        const before = await f.snapshot(), seq = await f.sequence(), chunks: Buffer[] = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; expect(length).toBeLessThanOrEqual(8192); chunks.push(Buffer.from(chunk)); }
        const requestBody = Buffer.concat(chunks), actor = req.headers.authorization === 'Bearer ' + f.tokens.viewer ? 22 : 21;
        wiring.container = method === 'PUT' ? containers.writer : containers.reader;
        const response = await app.request(path + url.search, { method, headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'PUT' ? { body: requestBody.toString() } : {}) }, env);
        bytes = Buffer.from(await response.arrayBuffer()); status = response.status; headers = Object.fromEntries(response.headers);
        const envelope = path === '/api/get_script' ? undefined : JSON.parse(bytes.toString());
        const observed = { path, method, actor, query: url.search, status, envelope: envelope?.status, body: method === 'PUT' ? JSON.parse(requestBody.toString()) : undefined, response: envelope?.data };
        paths.push(observed); expect(status).toBe(200); if (envelope) expect(envelope.status).toBe(200);
        if (method === 'GET') { expect(await f.snapshot()).toEqual(before); expect(await f.sequence()).toEqual(seq); }
        if (path === '/supplierapi/product/reply') {
          expect(envelope.data.list.every((row: any) => [80, 81].includes(row.product_id))).toBe(true);
          const product = url.searchParams.get('product_id'); if (product) expect(envelope.data.list.every((row: any) => row.product_id === Number(product))).toBe(true);
          if (armHold) { armHold = false; heldCount++; hold = true; }
        }
      } finally { release(); }
      const deliver = () => { if (!res.destroyed) { res.writeHead(status, headers); res.end(bytes); } };
      if (hold) held.push({ deliver, destroyed: () => res.destroyed }); else deliver(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (/^\/owned-media\/(?:product80|product81|review601)\.png$/.test(path)) return send(res,
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="20" y="85" font-size="20">OWNED REVIEW</text></svg>', 200, 'image/svg+xml');
    const target = resolve(root, '.' + path), candidate = target.startsWith(root + sep) ? target : '';
    try { if (candidate && (await stat(candidate)).isFile()) return send(res, await readFile(candidate), 200,
      ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(candidate)] ?? 'application/octet-stream'); } catch { /* SPA */ }
    send(res, await readFile(resolve(root, 'index.html')));
  })().catch(cause => { fail(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned review acceptance assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Review acceptance forbids backend provider fetch'); });
  try { await f.withReader(async reader => f.withWriter(async writer => {
    Object.assign(containers, { reader: reader.container, writer: writer.container });
    for (const [profile, runtime] of [['reader', reader], ['writer', writer]] as const) {
      const [proof] = await runtime.db.execute(sql`SELECT current_user AS role,(SELECT count(*)::int FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND has_table_privilege(current_user,c.oid,'SELECT')) AS readable`);
      expect(proof.readable).toBe(7); roleProofs.push({ profile, ...proof });
    }
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned review origin'); origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_REVIEW_BROWSER_READY ' + JSON.stringify({ control: origin + control, products: origin + '/products', reviews: origin + '/product-reviews' }) + '\n');
    deadline = setTimeout(() => fail(Error('Supplier review Browser finish not received')), 15 * 60_000); await completion;
    process.stdout.write('SUPPLIER_REVIEW_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
  })); } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; held.length = 0; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 16 * 60_000);
