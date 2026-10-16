/** Explicit installed-Browser acceptance against genuine App/JWT/owned PG16. */
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { createToken, md5 } from '@/utils/jwt';
import { supplierProductCopyFixture, supplierProductCopyAppKey, supplierProductCopyPassword } from '../helpers/supplierProductCopy';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned Supplier copy Browser fixture'); return wiring.container;
} }));
it('joins the installed Browser to actual Supplier copy and recovers one committed create after permission withdrawal', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierProductCopyFixture();
  const baseline = await f.snapshot(), control = '/__supplier_copy_fixture/' + randomUUID();
  const token = (await createToken(21, 'supplier', md5(supplierProductCopyPassword), supplierProductCopyAppKey)).token;
  const env = { APP_KEY: supplierProductCopyAppKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const app = createApp(), paths: Array<{ method: string; path: string; status: number; envelope?: number; query?: string }> = [];
  let drop = true, dropped = false, recovered = false, cardSeed = false, withdrawn = false, finished = false, outbound = 0, origin = '', createdId = 0, operationId = '';
  const send = (res: import('node:http').ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  };
  const state = async () => ({ products: [...await f.db.execute(sql`SELECT id,product_type,type,relation_id,store_name,is_del,is_show,is_verify FROM public.store_product ORDER BY id`)],
    receipts: [...await f.db.execute(sql`SELECT operation_id::text,actor_id,supplier_id,source_id,state,result FROM public.supplier_product_copy_operation_v1 ORDER BY operation_id`)],
    paths, dropped, recovered, cardSeed, withdrawn, finished, outbound, createdId, operationId });
  let finish!: () => void, fail!: (error: Error) => void; const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商商品复制 PG16 验收</title><h1>供应商商品复制 PG16 联合验收</h1><p>真实 App、JWT、PostgreSQL；本机合成数据。</p><button id="card">进入回收站复制商品</button><button id="login">进入商品管理</button><button id="withdraw">撤销本地夹具管理权限并核对回执</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>function login(path){localStorage.setItem('supplier-token',${JSON.stringify(token)});localStorage.setItem('supplier-user',JSON.stringify({id:21,supplier_id:20,supplier_name:'本机合成供应商',account:'owned-copy'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.product.view','supplier.product.manage']));location.href=path;}document.getElementById('login').onclick=()=>login('/products');document.getElementById('card').onclick=()=>login('/products/recycle');document.getElementById('withdraw').onclick=async()=>{const r=await fetch(${JSON.stringify(control + '/withdraw')},{method:'POST'});if(r.ok){localStorage.setItem('supplier-permissions','["supplier.product.view"]');location.href='/products/copy-result';}};for(const name of ['status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script></html>`);
    if ([control + '/status', control + '/finish', control + '/withdraw'].includes(path)) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
      if (path.endsWith('/withdraw')) {
        expect(dropped).toBe(true); await f.db.execute(sql`UPDATE public.system_role SET rules='supplier.product.view' WHERE id=21 AND type=4 AND relation_id=20`); withdrawn = true;
      }
      if (path.endsWith('/finish')) {
        const after = await f.snapshot(), facts = await state();
        for (const [table, rows] of Object.entries(baseline)) if (table !== 'system_role')
          for (const row of rows as unknown[]) expect((after as Record<string, unknown[]>)[table], table).toContainEqual(row);
        const roles = (baseline.system_role as Array<{ row: Record<string, unknown> }>).map(item => ({ row: {
          ...item.row, ...(item.row.id === 21 ? { rules: 'supplier.product.view' } : {}),
        } }));
        expect(after.system_role).toHaveLength(roles.length); expect(after.system_role).toEqual(expect.arrayContaining(roles));
        expect(facts.products.filter(p => p.id === createdId)).toEqual([expect.objectContaining({ product_type: 0, type: 2, relation_id: 20, store_name: '浏览器复制新商品', is_del: 0, is_show: 0, is_verify: 0 })]);
        expect(facts.products.length).toBe((baseline.store_product as unknown[]).length + 1);
        expect(facts.receipts).toEqual([{ operation_id: operationId, actor_id: 21, supplier_id: 20, source_id: 80, state: 'committed', result: { id: createdId, is_show: 0, is_verify: 0 } }]);
        expect(paths.filter(p => p.method === 'POST' && p.path === '/supplierapi/product/product/copy/80')).toHaveLength(1);
        expect(paths.filter(p => p.method === 'GET' && p.path === `/supplierapi/product/product/copy_operations/${operationId}`)).toHaveLength(1);
        expect(paths.some(p => p.path === '/api/get_script' && p.status === 200)).toBe(true);
        expect(dropped && recovered && cardSeed && withdrawn).toBe(true); expect(outbound).toBe(0); finished = true;
        await writeFile('/tmp/cinashop-supplier-copy-browser-result.json', JSON.stringify(await state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(await state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; expect(length).toBeLessThanOrEqual(256 * 1024); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks), headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const response = await app.fetch(new Request(origin + req.url, { method, headers, ...(bytes.length ? { body: new Uint8Array(bytes).buffer } : {}) }), env);
      const text = await response.text();
      if (path === '/api/get_script') { paths.push({ path, method, status: response.status }); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/javascript'); expect(text).toBe(''); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return; }
      const body = JSON.parse(text); paths.push({ path, method, status: response.status, envelope: body.status, query: url.search });
      if (method === 'GET' && path === '/supplierapi/product/product/copy/81' && body.status === 200) {
        for (const sku of body.data.product.attrs) { expect(sku.stock).toBe(0); expect(sku.disk_info).toBe(''); expect(sku.id).toBeUndefined(); expect(sku.unique).toBeUndefined(); } cardSeed = true;
      }
      if (method === 'POST' && path === '/supplierapi/product/product/copy/80' && body.status === 200 && drop) {
        expect(body.data.state).toBe('committed'); createdId = body.data.result.id; operationId = body.data.operation_id; drop = false; dropped = true;
        return send(res, JSON.stringify({ status: 502, msg: 'Owned committed acknowledgement deliberately discarded', data: null }), 502, 'application/json');
      }
      if (withdrawn && method === 'GET' && path === `/supplierapi/product/product/copy_operations/${operationId}` && body.status === 200 && body.data.state === 'committed') recovered = true;
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return;
    }
    if (path.startsWith('/uploads/')) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9edf3"/><text x="18" y="88" font-size="20">OWNED COPY</text></svg>', 200, 'image/svg+xml');
    const target = path.startsWith('/assets/') ? resolve(root, '.' + path) : resolve(root, 'index.html');
    expect(target === resolve(root, 'index.html') || target.startsWith(root + sep)).toBe(true);
    send(res, await readFile(target), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(target)] ?? 'text/html; charset=utf-8');
  })().catch(error => { send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('No outbound provider traffic in owned copy Browser acceptance'); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    wiring.container = f.container;
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_COPY_BROWSER_READY ' + JSON.stringify({ control: origin + control, products: origin + '/products', copy: origin + '/products/new?copy=80' }) + '\n');
    deadline = setTimeout(() => fail(Error('Supplier copy Browser finish not received')), 15 * 60_000);
    await completion; process.stdout.write('SUPPLIER_COPY_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await f.close();
  }
}, 16 * 60_000);
