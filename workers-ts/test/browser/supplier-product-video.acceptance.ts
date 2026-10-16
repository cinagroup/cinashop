/** Opt-in local Browser host. Actual App/JWT/PG16; R2, Queue and native stream
 * are explicitly owned stand-ins. This test asserts SQL/HTTP facts only. */
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemRole, systemSupplier, systemAttachment, systemAttachmentCategory, storeProductCategory, storeProduct, storeProductRule } from '@/models/schema';
import { installSupplierVideoUpload } from '@/migrations/supplierProductVideoUpload';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from '../helpers/financePostgres';
import { legacySaveSchema } from '../helpers/adminLegacyProductSave';
import { OwnedFixedLengthStream } from '../helpers/adminProductVideoUpload';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned Supplier video Browser fixture'); return wiring.container; } }));
it('joins the installed Browser to actual Supplier video upload and product save until explicit finish', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const videoPath = process.env.TEST_SUPPLIER_VIDEO_PATH; expect(videoPath && isAbsolute(videoPath)).toBeTruthy();
  const video = await readFile(videoPath!); expect(video.length).toBeGreaterThan(3 * 1024 * 1024); expect(video.length).toBeLessThan(8 * 1024 * 1024);
  expect(video.subarray(4, 8).toString()).toBe('ftyp');
  const f = await financePostgres([...Object.values(legacySaveSchema), systemAttachmentCategory, storeProductRule], { namespace: 'public' });
  const appKey = randomUUID(), password = randomUUID(), control = '/__supplier_video_fixture/' + randomUUID();
  const permission = ['supplier.product.view', 'supplier.product.manage', 'supplier.attachment.view', 'supplier.attachment.manage'];
  const token = (await createToken(1, 'supplier', md5(password), appKey)).token;
  const queue: unknown[] = [], objects = new Map<string, { bytes: Uint8Array; metadata?: R2HTTPMetadata }>();
  const paths: Array<{ method: string; path: string; status: number }> = [], ranges: Array<{ range: string | null; status: number }> = [];
  let outbound = 0, drop = true, dropped = '', recovered = false, saves = 0, origin = '', finished = false;
  const env = { APP_KEY: appKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    ORDER_QUEUE: { send: async (message: unknown) => { queue.push(message); } },
    ASSETS_BUCKET: {
      put: async (key: string, body: Uint8Array | ReadableStream<Uint8Array>, options?: R2PutOptions) => {
        const bytes = body instanceof Uint8Array ? body.slice() : new Uint8Array(await new Response(body).arrayBuffer());
        objects.set(key, { bytes, metadata: options?.httpMetadata as R2HTTPMetadata | undefined }); return { key, size: bytes.length };
      },
      get: async (key: string, options?: { range?: Headers }) => {
        const stored = objects.get(key); if (!stored) return null;
        const range = options?.range?.get('Range'), match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
        const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), stored.bytes.length - 1) : stored.bytes.length - 1;
        if (range && !match || start > end) return null;
        return { key, size: stored.bytes.length, body: new Response(stored.bytes.slice(start, end + 1)).body!, httpEtag: '"owned-supplier-video"',
          ...(range ? { range: { offset: start, length: end - start + 1 } } : {}),
          writeHttpMetadata(headers: Headers) { headers.set('Content-Type', stored.metadata?.contentType ?? 'application/octet-stream'); } };
      }, delete: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
    },
  } as unknown as Env;
  const app = createApp();
  const send = (res: import('node:http').ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  };
  const state = async () => ({ uploads: [...await f.db.execute(sql`SELECT upload_id,actor_id,supplier_id,state,confirmed,attachment_id FROM public.supplier_product_video_upload_v1 ORDER BY upload_id`)],
    attachments: await f.db.select({ id: systemAttachment.attId, type: systemAttachment.type, supplier: systemAttachment.relationId, url: systemAttachment.attDir, key: systemAttachment.name }).from(systemAttachment),
    products: await f.db.select({ id: storeProduct.id, video: storeProduct.videoLink }).from(storeProduct), paths, ranges, queue_count: queue.length, dropped, recovered, saves, outbound, finished });
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  let productId = 0;
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商视频 PG16 验收</title><h1>供应商视频 PG16 联合验收</h1><p>真实 App、JWT、PostgreSQL。R2、Queue、Node stream 为本地替身。</p><button id="login">进入真实商品编辑器</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>document.getElementById('login').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(token)});localStorage.setItem('supplier-user',JSON.stringify({id:1,supplier_id:7,supplier_name:'本机合成供应商',account:'owned-supplier-video'}));localStorage.setItem('supplier-permissions',${JSON.stringify(JSON.stringify(permission))});location.href='/products/${productId}/edit';};for(const name of ['status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script></html>`);
    if (path === control + '/status' || path === control + '/finish') {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
      if (path.endsWith('/finish')) {
        const facts = await state(); expect(facts.uploads).toHaveLength(1); expect(facts.attachments).toHaveLength(1);
        const upload = facts.uploads[0]!; expect(upload).toMatchObject({ actor_id: 1, supplier_id: 7, state: 'committed', confirmed: [1, 2] });
        expect(recovered).toBe(true); expect(dropped).toBe(upload.upload_id); expect(saves).toBeGreaterThan(0); expect(outbound).toBe(0);
        const asset = facts.attachments[0]!; expect(asset).toMatchObject({ type: 4, supplier: 7, url: `/api/assets/${asset.id}` });
        expect(facts.products).toEqual([{ id: productId, video: asset.url }]);
        expect(Buffer.from(objects.get(asset.key)!.bytes).equals(video)).toBe(true);
        expect(paths.filter(p => p.method === 'POST' && p.path.endsWith('/complete'))).toHaveLength(1);
        expect(ranges.some(item => item.status === 206 && item.range)).toBe(true); finished = true;
      }
      send(res, JSON.stringify(await state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path === '/fixture-image.svg') return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#acf"/></svg>', 200, 'image/svg+xml');
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path.startsWith('/supplierapi/') || path.startsWith('/api/')) {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; expect(length).toBeLessThanOrEqual(6 * 1024 * 1024); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks), headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const result = await app.fetch(new Request(origin + req.url, { method, headers, ...(bytes.length ? { body: new Uint8Array(bytes).buffer } : {}) }), env);
      paths.push({ path, method, status: result.status });
      if (path.startsWith('/api/assets/')) { ranges.push({ range: headers.get('Range'), status: result.status }); res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return; }
      const text = await result.text(), body = JSON.parse(text);
      if (method === 'POST' && path.endsWith('/complete') && body.status === 200 && drop) { drop = false; dropped = String(body.data.upload_id); return send(res, JSON.stringify({ status: 502, msg: 'Owned committed response deliberately discarded', data: null }), 502, 'application/json'); }
      if (method === 'GET' && path === '/supplierapi/file/video_uploads/' + dropped && body.data?.state === 'committed') recovered = true;
      if (method === 'POST' && path === '/supplierapi/product/product/' + productId && body.status === 200) saves++;
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(text); return;
    }
    const target = path.startsWith('/assets/') ? resolve(root, '.' + path) : resolve(root, 'index.html');
    expect(target === resolve(root, 'index.html') || target.startsWith(root + sep)).toBe(true);
    send(res, await readFile(target), 200, ({ '.js': 'application/javascript', '.css': 'text/css' } as Record<string, string>)[extname(target)] ?? 'text/html; charset=utf-8');
  })().catch(error => { send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('No outbound traffic in owned Supplier Browser acceptance'); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream);
    await f.exec('ALTER TABLE public.store_product_description ADD UNIQUE(product_id,type)');
    await f.db.transaction(tx => installSupplierVideoUpload(tx));
    await f.db.insert(systemSupplier).values({ id: 7, adminId: 99, supplierName: 'Owned local Supplier', isShow: 1 });
    await f.db.insert(systemAdmin).values({ id: 1, account: 'owned-supplier-video', pwd: password, roles: '1', adminType: 4, relationId: 7 });
    await f.db.insert(systemRole).values({ id: 1, type: 4, relationId: 7, rules: 'supplier.product.manage,supplier.attachment.manage' });
    await f.db.insert(storeProductCategory).values({ id: 11, type: 2, relationId: 7, cateName: '本机分类' });
    wiring.container = createContainerFromDb(f.db);
    const initial = await new SupplierProductManagementService(wiring.container, env).saveProduct(7, 0, { product_type: 0, store_name: '本机供应商视频验收商品',
      cate_id: [11], slider_image: ['/fixture-image.svg'], spec_type: 0, attrs: [{ suk: '默认', image: '/fixture-image.svg', price: '10.00', settle_price: '8.00', stock: 7 }], description: '<p>本机合成描述</p>', is_postage: 1 });
    productId = initial.id;
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_VIDEO_BROWSER_READY ' + JSON.stringify({ control: origin + control, editor: origin + `/products/${productId}/edit`, video_path: videoPath, video_bytes: video.length }) + '\n');
    deadline = setTimeout(() => fail(Error('Supplier Browser finish not received')), 18 * 60_000);
    await completion; process.stdout.write('SUPPLIER_VIDEO_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); vi.unstubAllGlobals(); wiring.container = undefined;
    server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await f.close();
  }
}, 19 * 60_000);
