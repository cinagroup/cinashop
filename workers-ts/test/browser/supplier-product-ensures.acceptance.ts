/** Actual production Supplier assurances author, App/JWT and owned restricted PG16.
 * All catalog edits and account switches belong to this local synthetic fixture. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import { storeProduct, storeProductRule } from '@/models/schema';
import { readDetailEnsures } from '@/services/product/ProductDetailDesignData';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { supplierProductEnsuresFixture } from '../helpers/supplierProductEnsures';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned assurances writer'); return wiring.container;
} }));
it('selects platform and own assurances, rereads and removes a retained disabled option, clears and checks detail consumer and catalog account ABA in IAB', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierProductEnsuresFixture(), app = createApp(), control = '/__supplier_product_ensures_fixture/' + randomUUID();
  const dialect = new PgDialect(), definition = getTableConfig(storeProductRule), columns = definition.columns.map(column => {
    const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
    return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
  });
  await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
  const snapshot = async (): Promise<Record<string, Array<{ row: Record<string, any> }>>> => ({ ...await f.snapshot(),
    [definition.name]: await f.exec(`SELECT to_jsonb(t) AS row FROM public."${definition.name}" t ORDER BY to_jsonb(t)::text`) });
  const baseline = await snapshot(), initialSequences = await f.sequences(), paths: any[] = [], held: Array<{ deliver: () => void; destroyed: () => boolean }> = [], releaseAttempts: any[] = [];
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  let origin = '', chain = Promise.resolve(), armHold = false, heldCount = 0, sessionChanges = 0, hidden = false, finished = false, outbound = 0, role: unknown; const consumerResults: any[] = [];
  let finish!: () => void, fail!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const product = (state: Record<string, Array<{ row: Record<string, any> }>>) => state.store_product.find(item => item.row.id === 80)!.row;
  const state = () => ({ finished, hidden, outbound, heldCount, sessionChanges, releaseAttempts, paths, role, consumerResults });
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (res.destroyed) return; res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Supplier保障PG16本机验收</title><h1>商品服务保障作者与回读</h1><p>仅本机合成商品；真实Supplier保存、平台与本店保障，原有品牌和计划保持。</p><button id="enter">进入商品编辑</button><button id="hide">停用已选平台保障</button><button id="hold">扣留下一保障目录</button><button id="other">切换只读合成账号</button><button id="restore">恢复管理合成账号</button><button id="release">释放已扣留目录</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
      const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
      function session(manager=true){localStorage.setItem('supplier-token',manager?tokens.manager:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:manager?21:22,supplier_id:7,supplier_name:'本机保障供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(manager?['supplier.product.view','supplier.product.manage']:['supplier.product.view']));}
      document.getElementById('enter').onclick=()=>{session();location.href='/products/80/edit';};
      for(const action of ['hide','hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(false);if(action==='restore')session();};</script>`);
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); await chain;
      if (path.endsWith('/hide')) {
        expect(hidden).toBe(false); expect(paths.filter(row => row.method === 'POST')).toHaveLength(1);
        const before = await snapshot(), sequences = await f.sequences();
        await f.exec('UPDATE public.store_product_ensure SET status=0 WHERE id=201');
        const expected = structuredClone(before); expected.store_product_ensure.find(item => item.row.id === 201)!.row.status = 0;
        expect(await snapshot()).toEqual(expected); expect(await f.sequences()).toEqual(sequences); hidden = true;
      }
      if (path.endsWith('/hold')) { expect(heldCount).toBe(0); armHold = true; }
      if (path.endsWith('/other')) { expect(held).toHaveLength(1); expect(sessionChanges).toBe(0); sessionChanges++; }
      if (path.endsWith('/restore')) { expect(sessionChanges).toBe(1); sessionChanges++; }
      if (path.endsWith('/release')) { expect(sessionChanges).toBe(2); expect(held).toHaveLength(1); while (held.length) { const item = held.shift()!; releaseAttempts.push({ socket_destroyed: item.destroyed() }); item.deliver(); } }
      if (path.endsWith('/finish')) {
        expect(hidden).toBe(true); expect(heldCount).toBe(1); expect(armHold).toBe(false); expect(held).toHaveLength(0); expect(sessionChanges).toBe(2); expect(releaseAttempts).toHaveLength(1); expect(outbound).toBe(0);
        const writes = paths.filter(row => row.method === 'POST'); expect(writes).toHaveLength(3);
        expect(writes.map(row => row.body.ensure_id)).toEqual([[201,202],[202],[]]);
        for (const row of writes) for (const key of ['ensure_selection', 'brand_id', 'brand_selection', 'brand_com', 'auto_on_time', 'auto_off_time', 'store_label_id', 'specs_id', 'specs', 'label_id']) expect(row.body).not.toHaveProperty(key);
        expect(paths.some(row => row.path === '/api/get_script' && row.status === 200)).toBe(true);
        const edits = paths.filter(row => row.method === 'GET' && row.path === '/supplierapi/product/product/80');
        expect(edits.some(row => JSON.stringify(row.ensures?.ensure_id) === '[201,202]' && row.ensures.ensure_selection.available === true)).toBe(true);
        expect(edits.some(row => JSON.stringify(row.ensures?.ensure_id) === '[201,202]' && JSON.stringify(row.ensures.ensure_selection.retained_ids) === '[201]' && row.ensures.ensure_selection.consistent === true && row.ensures.ensure_selection.available === false)).toBe(true);
        expect(edits.some(row => JSON.stringify(row.ensures?.ensure_id) === '[202]' && row.ensures.ensure_selection.available === true)).toBe(true);
        expect(edits.at(-1).ensures).toEqual({ensure_id:[],ensure_selection:{ensure_id:'',consistent:true,available:true,retained_ids:[],truncated:false}});
        expect(consumerResults.map(row => row.ids)).toEqual([[201,202],[202],[]]);
        expect(consumerResults[0].rows.map((row: any) => row.name)).toEqual(['平台七天保障','本店品质保障']);
        const after = await snapshot(), sequences = await f.sequences(); expect(product(after)).toMatchObject({ ensure_id:'',is_show:0,is_verify:0,brand_id:product(baseline).brand_id,brand_com:product(baseline).brand_com,auto_on_time:product(baseline).auto_on_time,auto_off_time:product(baseline).auto_off_time });
        for (const key of ['specs_id','specs','label_id','command_word','system_form_id']) expect(product(after)[key],key).toEqual(product(baseline)[key]);
        const allowed = new Set(['store_product', 'store_product_attr', 'store_product_attr_result', 'store_product_attr_value', 'store_product_relation', 'store_product_description', 'store_product_stock_record', 'store_cart', 'store_product_ensure']);
        for (const name of Object.keys(baseline)) if (!allowed.has(name)) expect(after[name], name).toEqual(baseline[name]);
        for (const name of allowed) if (name !== 'store_product_ensure') expect(after[name].filter(item => (name === 'store_product' ? item.row.id : item.row.product_id) !== 80), name).toEqual(baseline[name].filter(item => (name === 'store_product' ? item.row.id : item.row.product_id) !== 80));
        expect(after.store_product_relation.filter(item => item.row.product_id === 80 && ![1, 5].includes(item.row.type))).toEqual(baseline.store_product_relation.filter(item => item.row.product_id === 80 && ![1, 5].includes(item.row.type)));
        expect(after.store_product_relation.filter(item => item.row.product_id === 80 && item.row.type === 5)).toEqual([]);
        const ensures = structuredClone(baseline.store_product_ensure); ensures.find(item => item.row.id === 201)!.row.status = 0; expect(after.store_product_ensure).toEqual(ensures);
        const mutableSequences = new Set(['store_product_attr_id_seq', 'store_product_attr_result_id_seq', 'store_product_attr_value_id_seq', 'store_product_relation_id_seq', 'store_product_stock_record_id_seq']);
        expect(sequences.filter(item => !mutableSequences.has(item.name))).toEqual(initialSequences.filter(item => !mutableSequences.has(item.name)));
        finished = true; await writeFile('/tmp/cinashop-supplier-product-ensures-browser-result.json', JSON.stringify({ ...state(), baseline, final: after, initial_sequences: initialSequences, final_sequences: sequences }, null, 2) + '\n');
      }
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      expect(method === 'GET' || method === 'POST' && path === '/supplierapi/product/product/80', method + ' ' + path).toBe(true);
      expect(['/api/get_script', '/supplierapi/product/category/tree', '/supplierapi/product/product/get_rule', '/supplierapi/product/product_label', '/supplierapi/product/product/list', '/supplierapi/product/product/80', '/supplierapi/product/brand/cascader_list/2', '/supplierapi/product/all_ensure'].includes(path), method + ' ' + path).toBe(true);
      let release!: () => void; const previous = chain; chain = new Promise(done => { release = done; }); await previous;
      let bytes = Buffer.alloc(0), status = 200, headers: Record<string, string> = {}, hold = false;
      try {
        const before = await snapshot(), sequences = await f.sequences(); let input: Record<string, unknown> | undefined;
        if (method === 'POST') { const chunks: Buffer[] = []; let total = 0; for await (const part of req) { const chunk = Buffer.from(part); total += chunk.length; expect(total).toBeLessThan(1024 * 1024); chunks.push(chunk); } input = JSON.parse(Buffer.concat(chunks).toString()); }
        const response = await app.request(path + url.search, { method, headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }, env);
        bytes = Buffer.from(await response.arrayBuffer()); status = response.status; headers = Object.fromEntries(response.headers);
        const envelope = path.startsWith('/supplierapi/') ? JSON.parse(bytes.toString()) : undefined;
        paths.push({ path, method, status, envelope: envelope?.status, ...(input ? { body: input } : {}), ...(path.endsWith('/80') && method === 'GET' ? { ensures: { ensure_id: envelope?.data.ensure_id, ensure_selection: envelope?.data.ensure_selection } } : {}) });
        expect(status, method + ' ' + path).toBe(200); if (envelope) expect(envelope.status, method + ' ' + path).toBe(200);
        if (method === 'GET') { expect(await snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); if (path === '/supplierapi/product/all_ensure' && armHold) { armHold = false; heldCount++; hold = true; } }
        else { expect(envelope.data).toMatchObject({id:80,is_show:0,is_verify:0}); const current=product(await snapshot()); expect(current).toMatchObject({ensure_id:(input!.ensure_id as number[]).join(','),brand_id:product(baseline).brand_id,brand_com:product(baseline).brand_com,auto_on_time:product(baseline).auto_on_time,auto_off_time:product(baseline).auto_off_time});
          const [actual]=await f.db.select().from(storeProduct).where(eq(storeProduct.id,80)); if(!actual)throw Error('Missing actual persisted assurance product');
          const consumerBefore=await snapshot(),consumerSequences=await f.sequences(); const rows=await readDetailEnsures(wiring.container!.db,actual); expect(rows.map(row=>row.id)).toEqual(input!.ensure_id); expect(await snapshot()).toEqual(consumerBefore); expect(await f.sequences()).toEqual(consumerSequences); consumerResults.push({ids:rows.map(row=>row.id),rows}); }
      } finally { release(); }
      const deliver = () => { if (!res.destroyed) { res.writeHead(status, headers); res.end(bytes); } };
      if (hold) held.push({ deliver, destroyed: () => res.destroyed }); else deliver(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path === '/owned-media/schedule.png') return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="20" y="84">OWNED ENSURES</text></svg>', 200, 'image/svg+xml');
    const target = resolve(root, '.' + path), candidate = target.startsWith(root + sep) ? target : '';
    try { if (candidate && (await stat(candidate)).isFile()) return send(res, await readFile(candidate), 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(candidate)] ?? 'application/octet-stream'); } catch { /* SPA */ }
    send(res, await readFile(resolve(root, 'index.html')));
  })().catch(cause => { fail(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned assurances acceptance assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Owned assurances forbids backend provider fetch'); });
  try { await f.withWriter(async writer => {
    await f.exec(`GRANT SELECT ON public.store_product_rule,public.store_product_label,public.category TO "${writer.role}"`); wiring.container = writer.container;
    const [rights] = await writer.db.execute(sql`SELECT current_user AS role,has_table_privilege(current_user,'public.store_product_ensure','SELECT') AS ensure_select,has_column_privilege(current_user,'public.store_product_ensure','id','UPDATE') AS ensure_lock,has_column_privilege(current_user,'public.store_product_ensure','name','UPDATE') AS ensure_edit`); role = rights;
    expect(rights).toMatchObject({ ensure_select: true, ensure_lock: true, ensure_edit: false });
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned assurances origin'); origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_ENSURES_BROWSER_READY ' + JSON.stringify({ control: origin + control, editor: origin + '/products/80/edit', products: origin + '/products' }) + '\n');
    deadline = setTimeout(() => fail(Error('Supplier assurances Browser finish not received')), 15 * 60_000); await completion; process.stdout.write('SUPPLIER_ENSURES_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
  }); } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; held.length = 0; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 16 * 60_000);
