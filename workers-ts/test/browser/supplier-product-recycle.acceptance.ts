/** Opt-in Browser host: genuine App/JWT/owned PG16, no production or provider. */
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { createToken, md5 } from '@/utils/jwt';
import { supplierProductRecycleFixture, supplierRecyclePassword, supplierRecycleSnapshot } from '../helpers/supplierProductRecycle';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned Supplier recycle Browser fixture'); return wiring.container; } }));
it('joins the installed Browser to actual Supplier recycle restore and permanent deletion until explicit finish', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierProductRecycleFixture(), baseline = await supplierRecycleSnapshot(f.db);
  const appKey = randomUUID(), control = '/__supplier_recycle_fixture/' + randomUUID();
  const token = (await createToken(21, 'supplier', md5(supplierRecyclePassword), appKey)).token;
  const reader = (await createToken(22, 'supplier', md5(supplierRecyclePassword), appKey)).token;
  const env = { APP_KEY: appKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? '' : null,
      put: async () => {}, delete: async () => {} } } as unknown as Env;
  const app = createApp(), paths: Array<{ method: string; path: string; status: number; query: string }> = [];
  let drop = true, dropped = false, recovered = false, finished = false, outbound = 0, origin = '';
  const send = (res: import('node:http').ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  };
  const state = async () => ({ products: [...await f.db.execute(sql`SELECT id,type,relation_id,is_del,is_show,is_verify FROM public.store_product ORDER BY id`)],
    sku_rows_81: [...await f.db.execute(sql`SELECT id,type,is_retired FROM public.store_product_attr_value WHERE product_id=81 ORDER BY id`)],
    paths, dropped, recovered, outbound, finished });
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商回收站 PG16 验收</title><h1>供应商回收站 PG16 联合验收</h1><p>真实 App、JWT、PostgreSQL；本地合成账户与数据，无外部提供商。</p><button id="login">进入商品管理</button><button id="reader">进入只读回收站</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>function login(token,id,permissions,path){localStorage.setItem('supplier-token',token);localStorage.setItem('supplier-user',JSON.stringify({id,supplier_id:20,supplier_name:'本机合成供应商',account:'owned-recycle'}));localStorage.setItem('supplier-permissions',JSON.stringify(permissions));location.href=path;}document.getElementById('login').onclick=()=>login(${JSON.stringify(token)},21,['supplier.product.view','supplier.product.manage'],'/products');document.getElementById('reader').onclick=()=>login(${JSON.stringify(reader)},22,['supplier.product.view'],'/products/recycle');for(const name of ['status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script></html>`);
    if (path === control + '/status' || path === control + '/finish') {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
      if (path.endsWith('/finish')) {
        const after = await supplierRecycleSnapshot(f.db), facts = await state();
        expect(facts.products.find(p => p.id === 80)).toMatchObject({ type: 2, relation_id: 20, is_del: 1, is_show: 0, is_verify: 1 });
        expect(facts.products.some(p => p.id === 81)).toBe(false); expect(facts.sku_rows_81).toEqual([{ id: 303, type: 3, is_retired: 1 }]);
        for (const table of ['store_order','store_order_cart_info','store_product_virtual',
          'store_product_stock_record','system_attachment','store_bargain','store_seckill','store_combination','store_integral','store_discounts_products','user_bill']) expect(after[table], table).toEqual(baseline[table]);
        const oldLogs = baseline.store_product_sku_retirement_log!;
        const logs = after.store_product_sku_retirement_log! as Array<{ row: Record<string, unknown> }>;
        expect(logs.filter(item => item.row.action !== 'permanent_delete')).toEqual(oldLogs);
        expect(logs.filter(item => item.row.action === 'permanent_delete').map(item => ({ product: item.row.product_id, sku: item.row.sku_id })).sort((a,b) => Number(a.sku)-Number(b.sku)))
          .toEqual([{ product: 81, sku: 301 }, { product: 81, sku: 302 }]);
        expect(paths.some(p => p.path === '/api/get_script' && p.status === 200)).toBe(true);
        expect(dropped).toBe(true); expect(recovered).toBe(true); expect(outbound).toBe(0);
        expect(paths.filter(p => p.method === 'DELETE' && p.path.endsWith('/thorough/81'))).toHaveLength(1);
        expect(paths.filter(p => p.method === 'DELETE' && p.path.endsWith('/80'))).toHaveLength(3);
        finished = true;
      }
      send(res, JSON.stringify(await state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; expect(length).toBeLessThanOrEqual(2048); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks), headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const result = await app.fetch(new Request(origin + req.url, { method, headers, ...(bytes.length ? { body: new Uint8Array(bytes).buffer } : {}) }), env);
      const text = await result.text(); paths.push({ path, method, status: result.status, query: url.search });
      if (path === '/api/get_script') {
        expect(result.status).toBe(200); expect(result.headers.get('content-type')).toContain('application/javascript');
        expect(text).toBe(''); res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(text); return;
      }
      const body = JSON.parse(text);
      if (method === 'DELETE' && path.endsWith('/thorough/81') && body.status === 200 && drop) { drop = false; dropped = true; return send(res, JSON.stringify({ status: 502, msg: 'Owned committed acknowledgement deliberately discarded', data: null }), 502, 'application/json'); }
      if (dropped && method === 'GET' && url.searchParams.get('id') === '81' && url.searchParams.get('is_del') === 'all' && body.status === 200 && body.data?.count === 0) recovered = true;
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(text); return;
    }
    const target = path.startsWith('/assets/') ? resolve(root, '.' + path) : resolve(root, 'index.html');
    expect(target === resolve(root, 'index.html') || target.startsWith(root + sep)).toBe(true);
    send(res, await readFile(target), 200, ({ '.js': 'application/javascript', '.css': 'text/css' } as Record<string, string>)[extname(target)] ?? 'text/html; charset=utf-8');
  })().catch(error => { send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('No outbound traffic in owned recycle Browser acceptance'); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    wiring.container = f.container;
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_RECYCLE_BROWSER_READY ' + JSON.stringify({ control: origin + control, products: origin + '/products', recycle: origin + '/products/recycle' }) + '\n');
    deadline = setTimeout(() => fail(Error('Supplier recycle Browser finish not received')), 15 * 60_000);
    await completion; process.stdout.write('SUPPLIER_RECYCLE_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await f.close();
  }
}, 16 * 60_000);
