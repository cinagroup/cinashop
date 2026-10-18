/** Browser interaction is driven through Codex's connected browser. This host
 * serves the production bundle and actual App/JWT over one owned PG16 fixture. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import { systemAttachmentCategory } from '@/models/schema';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { supplierProductRuleInlineFixture } from '../helpers/supplierProductRuleInline';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned specification Browser LOGIN'); return wiring.container; },
}));
type Row = Record<string, any>;

it('keeps an unsaved product mounted through real inline specification create recovery and explicit confirmed application', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist');
  expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierProductRuleInlineFixture(), app = createApp(), control = '/__rule_inline/' + randomUUID();
  const dialect = new PgDialect();
  for (const table of [systemAttachmentCategory]) {
    const definition = getTableConfig(table), columns = definition.columns.map(column => {
      const initial = column.default, value = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${value}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
    });
    await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
  }
  const baseline = await f.snapshot(), initialSequences = await f.sequences();
  const authoredTables = new Set(['store_product_rule', 'system_log']);
  const paths: Row[] = [], evidence: Row[] = [];
  let origin = '', creates = 0, recoveries = 0, createdId = 0, outbound = 0, finished = false;
  let writer: Container, draft: unknown, chain = Promise.resolve();
  let complete!: () => void, reject!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { complete = yes; reject = no; });
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async (key: string) => ({ cfg_system_statistics: '', cfg_navigation_open: '0', cfg_product_video_status: '0' } as Record<string, string>)[key] ?? null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const state = () => ({ creates, recoveries, createdId, outbound, finished, paths, evidence, tables: Object.keys(baseline).length, sequences: initialSequences.length, product_writes: 0, customer_checkout_in_browser: false });
  async function serial<T>(work: () => Promise<T>) {
    const before = chain; let release!: () => void; chain = new Promise<void>(yes => { release = yes; });
    await before; try { return await work(); } finally { release(); }
  }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (res.destroyed) return; res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  async function body(req: IncomingMessage): Promise<Row> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; expect(size).toBeLessThan(1024 * 1024); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  async function unchangedProduct() {
    const current = await f.snapshot();
    for (const name of Object.keys(baseline)) if (!authoredTables.has(name)) expect(current[name], name).toEqual(baseline[name]);
    return current;
  }
  const reads = new Set(['/api/get_script', '/supplierapi/product/category/tree', '/supplierapi/product/product/get_rule', '/supplierapi/product/product_label',
    '/supplierapi/product/product/80', '/supplierapi/product/brand/cascader_list/2', '/supplierapi/product/all_ensure', '/supplierapi/product/all_specs',
    '/supplierapi/form/all_system_form', '/supplierapi/form/info/71', '/supplierapi/product/get_all_unit',
    '/supplierapi/product/product/shipping-template-options', '/supplierapi/setting/shipping_templates/city_list', '/supplierapi/setting/shipping_templates/list']);
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      const path = url.pathname, method = req.method ?? 'GET';
      const fullRead = path === '/supplierapi/product/product/rule';
      const detailRead = /^\/supplierapi\/product\/product\/rule\/(\d+)$/.test(path);
      const write = method === 'POST' && path === '/supplierapi/product/product/rule/0';
      expect(method === 'GET' && (reads.has(path) || fullRead || detailRead) || write, method + ' ' + path).toBe(true);
      const before = await f.snapshot(), seq = await f.sequences(), input = method === 'POST' ? await body(req) : undefined;
      wiring.container = writer;
      const headers = new Headers();
      for (const name of ['authorization']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      if (input) headers.set('Content-Type', 'application/json');
      const pending: Promise<unknown>[] = [];
      const response = await app.request(path + url.search, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) }, env,
        { waitUntil: task => { pending.push(task); }, passThroughOnException() {}, props: {} });
      const bytes = Buffer.from(await response.arrayBuffer()); await Promise.all(pending);
      const envelope = path === '/api/get_script' ? undefined : JSON.parse(bytes.toString());
      expect(response.status).toBe(200); if (envelope) expect(envelope.status, envelope.msg).toBe(200);
      const entry: Row = { path, method, status: response.status, creates, recoveries };
      if (method === 'GET') {
        expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); entry.sql_read_only = true;
        if (fullRead) {
          expect(envelope.data.revision).toMatch(/^[a-f0-9]{64}$/);
          if (creates && recoveries === 0 && !url.searchParams.has('page')) { recoveries++; entry.recovery_read = true; }
        }
      } else {
        expect(creates).toBe(0); creates++; createdId = envelope.data.id;
        expect(createdId).toBeGreaterThan(0); expect(envelope.data.revision).toMatch(/^[a-f0-9]{64}$/);
        expect(input).toMatchObject({ rule_name: '浏览器新建规格模板', expected_revision: expect.stringMatching(/^[a-f0-9]{64}$/),
          spec: [{ value: '颜色', detail: ['橙', '紫'] }, { value: '尺码', detail: ['S', 'M'] }] });
        entry.id = createdId; entry.simulated_lost_response_after_actual_commit = true;
        await unchangedProduct();
      }
      paths.push(entry);
      // The actual server commit above succeeds before the delivery
      // fault. Recovery rereads the full owner catalog, never a second create.
      if (entry.simulated_lost_response_after_actual_commit) { res.destroy(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    });
  }
  async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      const name = url.pathname.slice(control.length + 1);
      if (name === 'evidence') {
        const data = await body(req); expect(data.values.length).toBeGreaterThan(20);
        expect(data.values.some((row: Row) => row.value === '浏览器未保存商品')).toBe(true);
        expect(data.values.some((row: Row) => row.value === 'inline-draft-keyword')).toBe(true);
        if (!draft) draft = data.values; else expect(data.values).toEqual(draft);
        if (data.stage === 'cancel') { expect(creates).toBe(0); expect(data.selected).toContain('本店服装模板'); }
        else if (data.stage === 'recovered') { expect(creates).toBe(1); expect(recoveries).toBe(1); expect(data.selected).toContain('本店服装模板'); }
        else if (data.stage === 'selected') { expect(data.selected).toContain('浏览器新建规格模板'); }
        else throw Error('Unexpected Browser draft evidence stage');
        await unchangedProduct(); evidence.push(data);
      } else if (name === 'applied') {
        const data = await body(req); expect(data.keyword).toBe('inline-draft-keyword'); expect(data.name).toBe('浏览器未保存商品');
        expect(data.skus).toEqual(['橙,S','橙,M','紫,S','紫,M']); expect(data.prices).toEqual(['0.00','0.00','0.00','0.00']);
        await unchangedProduct(); evidence.push({stage:'applied',...data});
      } else if (name === 'desktop' || name === 'phone') {
        const data = await body(req); expect(data.width).toBe(name === 'phone' ? 390 : 1200); expect(data.height).toBe(844);
        expect(data.dialog.left).toBeGreaterThanOrEqual(0); expect(data.dialog.right).toBeLessThanOrEqual(data.width);
        expect(data.dialog.top).toBeGreaterThanOrEqual(0); expect(data.dialog.bottom).toBeLessThanOrEqual(844);
        expect(data.footerVisible).toBe(true); expect(data.unobscured).toBe(true); expect(data.formScrollable).toBeTypeOf('boolean'); evidence.push({ stage: name, ...data });
      } else if (name === 'finish') {
        expect(creates).toBe(1); expect(recoveries).toBe(1); expect(outbound).toBe(0);
        expect(evidence.map(row => row.stage)).toEqual(['desktop', 'cancel', 'recovered', 'selected', 'applied', 'phone']);
        expect(paths.filter(row => row.path === '/supplierapi/product/product/rule/0')).toHaveLength(1);
        const final = await unchangedProduct(), seq = await f.sequences();
        expect(seq.filter(row => !['store_product_rule_id_seq','system_log_id_seq'].includes(row.name))).toEqual(initialSequences.filter(row => !['store_product_rule_id_seq','system_log_id_seq'].includes(row.name)));
        finished = true;
        await writeFile('/tmp/cinashop-supplier-product-rule-inline-browser-result.json', JSON.stringify({ ...state(), baseline, final, initial_sequences: initialSequences, final_sequences: seq }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>商品内规格模板真实PG16验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:100px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}iframe{display:block;width:1200px;max-width:100%;height:844px;border:1px solid #bbb}</style>
      <h1>商品草稿与规格模板独立保存</h1><button id="enter">登录并加载商品</button><button id="desktop">核对桌面弹窗</button><button id="cancel">核对取消草稿</button><button id="recovered">核对创建恢复未套用</button><button id="selected">核对明确选择未套用</button><button id="applied">核对确认套用草稿</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机弹窗</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},token=${JSON.stringify(f.tokens.manager)},frame=document.querySelector('iframe');
      document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',token);localStorage.setItem('supplier-user',JSON.stringify({id:21,supplier_id:7,supplier_name:'本机规格供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.product.view','supplier.product.manage','supplier.attachment.view']));frame.src='/products/80/edit';};
      async function report(action,data={}){const response=await fetch(control+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=await response.text();}
      for(const stage of ['cancel','recovered','selected'])document.getElementById(stage).onclick=()=>{const doc=frame.contentDocument;report('evidence',{stage,values:[...doc.querySelectorAll('.product-form-page input,.product-form-page textarea')].filter(n=>!n.closest('.el-dialog')).map(n=>({tag:n.tagName,type:n.type,value:n.value,checked:n.checked})),selected:doc.querySelector('.rule-template-bar .el-select__selected-item.el-select__placeholder').textContent});};
      document.getElementById('applied').onclick=()=>{const doc=frame.contentDocument,rows=[...doc.querySelectorAll('.sku-table-wrap .el-table__body tbody tr')].slice(0,4);report('applied',{name:[...doc.querySelectorAll('.product-form-page .el-form-item')].find(n=>n.querySelector('.el-form-item__label')?.textContent==='商品名称').querySelector('input').value,keyword:[...doc.querySelectorAll('.product-form-page .el-form-item')].find(n=>n.textContent.includes('关键词')).querySelector('input').value,skus:rows.map(n=>n.querySelectorAll('td')[1].textContent.trim()),prices:rows.map(n=>n.querySelectorAll('td')[3].querySelector('input').value)});};
      document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};
      for(const mode of ['desktop','phone'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument,dialog=[...doc.querySelectorAll('.supplier-product-rule-dialog')].find(n=>n.getBoundingClientRect().height>0),r=dialog.getBoundingClientRect(),form=dialog.querySelector('.rule-form'),footer=dialog.querySelector('.el-dialog__footer').getBoundingClientRect(),targets=[dialog.querySelector('input'),...dialog.querySelectorAll('.el-dialog__footer button')],unobscured=targets.every(n=>{const b=n.getBoundingClientRect(),top=doc.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return top===n||n.contains(top);});report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,dialog:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},footerVisible:footer.bottom<=844,formScrollable:form.scrollHeight>form.clientHeight,unobscured});};
      for(const name of ['status','finish'])document.getElementById(name).onclick=()=>report(name);</script></html>`;
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname;
    if (path === control && req.method === 'GET') return send(res, shell());
    if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
    if (path.startsWith('/supplierapi/') || path.startsWith('/api/')) return api(req, res, url);
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path.startsWith('/owned-media/')) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/></svg>', 200, 'image/svg+xml');
    const target = resolve(root, '.' + path);
    try { if (target.startsWith(root + sep) && (await stat(target)).isFile()) return send(res, await readFile(target), 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' } as Record<string, string>)[extname(target)] ?? 'application/octet-stream'); } catch { /* production SPA */ }
    send(res, await readFile(resolve(root, 'index.html')));
  })().catch(cause => { reject(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned specification Browser assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Owned specification acceptance forbids backend provider fetch'); });
  try {
    await f.withWriter(async runtime => {
      await f.grantRuleWriter(runtime.role);
      await f.exec(`GRANT SELECT ON public.store_product_rule,public.system_attachment_category,public.store_product_label TO "${runtime.role}"`);
      writer = runtime.container;
      const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent`);
      expect(rights).toMatchObject({ independent: true });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing specification Browser origin');
      origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('SUPPLIER_PRODUCT_RULE_INLINE_BROWSER_READY ' + JSON.stringify({ control: origin + control, editor: origin + '/products/80/edit', viewport: '1200x844 desktop and 390x844 same-origin iframe' }) + '\n');
      deadline = setTimeout(() => reject(Error('Shipping Browser finish not received')), 20 * 60_000);
      await completion; process.stdout.write('SUPPLIER_PRODUCT_RULE_INLINE_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close();
  }
}, 21 * 60_000);
