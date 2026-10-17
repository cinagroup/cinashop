/** Actual production Supplier history UI + App/JWT + independent PG16 LOGIN.
 * Synthetic history and local image bytes never represent a bank payment. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemRole } from '@/models/schema';
import { supplierExtractReadFixture } from '../helpers/supplierExtractRead';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned withdrawal history LOGIN'); return wiring.container;
} }));
it('reads complete withdrawal history and account evidence while limiting all Supplier writes to descriptive notes through IAB', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierExtractReadFixture(), app = createApp(), control = '/__supplier_extract_fixture/' + randomUUID();
  const statisticsScript = 'globalThis.__ownedSupplierExtractStatistics = 1;';
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? statisticsScript : null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const baseline = await f.snapshot(), paths: any[] = [], notes: any[] = [], pages = new Set<number>(), selections = new Set<string>(), images = new Set<string>();
  const held: Array<() => void> = []; let armRead = false, armMark = false, armDrop = false, armImageFailure = false;
  let readHeld = 0, markHeld = 0, released = 0, dropped = 0, recoveryReads = 0, imageFailures = 0, readonlyGets = 0, viewerLogins = 0;
  let origin = '', finished = false, outbound = 0, withdrawn = false, denied = false, restored = false, scriptSeen = false;
  let chain = Promise.resolve(), deadline: ReturnType<typeof setTimeout> | undefined, finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const state = () => ({ finished, outbound, readonlyGets, readHeld, markHeld, released, dropped, recoveryReads, imageFailures,
    viewerLogins, withdrawn, denied, restored, scriptSeen, pages: [...pages].sort((a, b) => a - b), selections: [...selections], images: [...images], notes, paths });
  const canonical = (snapshot: Record<string, any[]>) => Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.map(row => JSON.stringify(row)).sort()]));
  function onlyNote(before: Record<string, any[]>, after: Record<string, any[]>, value: string) {
    const old = before.supplier_extract.find(row => row.row.id === 1), next = after.supplier_extract.find(row => row.row.id === 1);
    expect(old?.row.supplier_id).toBe(7); expect(next?.row.supplier_mark).toBe(value); const normalized = structuredClone(after);
    normalized.supplier_extract.find(row => row.row.id === 1)!.row.supplier_mark = old!.row.supplier_mark; expect(canonical(normalized)).toEqual(canonical(before));
  }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>提现记录 PG16 本机验收</title><h1>提现记录与描述备注联合验收</h1>
      <p>合成历史、7表SELECT独立LOGIN；写仅supplier_mark与权限id行锁资格。不得提交提现或真实银行付款。9月4日105条须读完6页；全账可提现735元不受日期筛选改变。</p>
      <p>9月1日审核通过、未转账仅申请2；申请3含微信收款图与登记凭证，申请4含拒绝原因。图片为本机合成PNG。仅申请1修改两次备注，最终“提现资料已人工核对”；第一次实际200回执由夹具替换为503，须手动GET核对。</p>
      <button id="login">管理账号进入提现记录</button><button id="holdread">扣留下一记录列表</button><button id="holdmark">扣留下一提现备注</button><button id="release">释放已扣留回复</button><button id="dropmark">丢失下一提现备注回执</button><button id="imagefail">下个图片请求返回404</button>
      <button id="viewer">切换只读会话</button><button id="manager">切回管理会话</button><button id="withdraw">撤销夹具备注权限</button><button id="restore">恢复夹具备注权限</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
      const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};function session(viewer){localStorage.setItem('supplier-token',viewer?tokens.viewer:tokens.reader);localStorage.setItem('supplier-user',JSON.stringify({id:viewer?22:21,supplier_id:7,supplier_name:'本机提现供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(viewer?['supplier.finance.view']:['supplier.finance.view','supplier.finance.manage']));}
      document.getElementById('login').onclick=()=>{session(false);location.href='/finance/extracts';};for(const name of ['holdread','holdmark','release','dropmark','imagefail','viewer','manager','withdraw','restore','status','finish'])document.getElementById(name).onclick=async()=>{const response=await fetch(control+'/'+name,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(response.ok&&(name==='viewer'||name==='manager'))session(name==='viewer');};</script></html>`);
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); await chain;
      if (path.endsWith('/holdread')) { expect(armRead).toBe(false); armRead = true; }
      if (path.endsWith('/holdmark')) { expect(armMark).toBe(false); armMark = true; }
      if (path.endsWith('/dropmark')) { expect(armDrop).toBe(false); armDrop = true; }
      if (path.endsWith('/imagefail')) { expect(armImageFailure).toBe(false); armImageFailure = true; }
      if (path.endsWith('/release')) { expect(held.length).toBeGreaterThan(0); while (held.length) { held.shift()!(); released++; } }
      if (path.endsWith('/viewer')) viewerLogins++;
      if (path.endsWith('/withdraw')) { await f.db.update(systemRole).set({ rules: 'supplier.finance.view' }).where(eq(systemRole.id, 21)); withdrawn = true; }
      if (path.endsWith('/restore')) { expect(denied).toBe(true); await f.db.update(systemRole).set({ rules: 'supplier.finance.view,supplier.finance.manage' }).where(eq(systemRole.id, 21)); withdrawn = false; restored = true; }
      if (path.endsWith('/finish')) {
        expect(armRead || armMark || armDrop || armImageFailure || withdrawn).toBe(false); expect(held).toHaveLength(0);
        expect(readHeld).toBe(1); expect(markHeld).toBe(1); expect(released).toBe(2); expect(dropped).toBe(1); expect(recoveryReads).toBeGreaterThanOrEqual(1);
        expect(viewerLogins).toBeGreaterThanOrEqual(2); expect(imageFailures).toBe(1); expect([...images].sort()).toEqual(['/owned-media/alipay.png', '/owned-media/voucher.png', '/owned-media/wechat.png']);
        expect([...pages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]); for (const name of ['day-approved-unpaid', 'paid-weixin', 'rejected', 'alipay']) expect(selections.has(name)).toBe(true);
        expect(denied && restored && scriptSeen).toBe(true); expect(notes).toHaveLength(2); expect(notes.at(-1).supplier_mark).toBe('提现资料已人工核对');
        expect(paths.filter(row => row.method === 'POST')).toHaveLength(3); expect(outbound).toBe(0); onlyNote(baseline, await f.snapshot(), '提现资料已人工核对'); finished = true;
        await writeFile('/tmp/cinashop-supplier-extract-browser-result.json', JSON.stringify(state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (/^\/owned-media\/(?:alipay|wechat|voucher)\.png$/.test(path)) {
      expect(method).toBe('GET'); if (armImageFailure) { armImageFailure = false; imageFailures++; return send(res, 'Owned image404', 404, 'text/plain'); }
      images.add(path); return send(res, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l8AAAAASUVORK5CYII=', 'base64'), 200, 'image/png');
    }
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      expect(['GET', 'POST']).toContain(method); let raw = ''; if (method === 'POST') { for await (const chunk of req) raw += chunk.toString(); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2048); }
      let release!: () => void; const previous = chain; chain = new Promise(done => { release = done; }); await previous;
      let body = '', status = 200, headers: Record<string, string> = {}, delay = false, drop = false;
      try {
        const before = await f.snapshot(), response = await app.request(path + url.search, { method, headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: raw } : {}) }, env);
        body = await response.text(); status = response.status; headers = Object.fromEntries(response.headers); const after = await f.snapshot();
        if (method === 'GET') { expect(after).toEqual(before); readonlyGets++; }
        if (path === '/api/get_script') { expect(status).toBe(200); expect(headers['content-type']).toBe('application/javascript; charset=utf-8'); expect(body).toBe(statisticsScript); scriptSeen = true; }
        else {
          expect(headers['cache-control']).toContain('private, no-store'); const value = JSON.parse(body), q = url.searchParams; paths.push({ path, query: Object.fromEntries(q), method, app_status: status, envelope: value.status });
          if (method === 'POST') {
            expect(path).toBe('/supplierapi/finance/supplier_extract/mark/1'); const input = JSON.parse(raw); expect(Object.keys(input).sort()).toEqual(['expected_revision', 'mark', 'selection']); expect(input.selection).toBe('history');
            if (withdrawn) { expect(value.status).toBe(400011); expect(after).toEqual(before); denied = true; }
            else {
              if (value.status !== 200) throw Error('Owned withdrawal note rejected: ' + JSON.stringify({ input, response: value }));
              expect(value.status).toBe(200); onlyNote(before, after, input.mark); expect(value.data).toMatchObject({ version: 'supplier-extract-mark-v1', supplier_id: 7, id: 1, supplier_mark: input.mark });
              if (notes.length === 1) expect(recoveryReads).toBeGreaterThanOrEqual(1);
              drop = armDrop; notes.push({ ...value.data, actual_app_status: status, actual_app_body_sha256: createHash('sha256').update(body).digest('hex'), injected_wire_status: drop ? 503 : status });
              if (drop) { armDrop = false; dropped++; }
            }
          } else {
            expect(value.status).toBe(200);
            if (path.endsWith('/list')) {
              expect(value.data).toMatchObject({ version: 'supplier-extract-v1', selection: 'history', supplier_id: 7, bounded: true }); expect(Object.keys(value.data)).toHaveLength(13);
              expect(value.data.statistics).toMatchObject({ withdrawable: '735.00', extract_min_price: '5.50', extract_max_price: '200.00' }); expect(Object.keys(value.data.statistics)).toHaveLength(6);
              expect(value.data.list.every((row: any) => row.supplier_id === 7 && Object.keys(row).length === 22 && !Object.hasOwn(row, 'mark'))).toBe(true); expect(q.has('supplier_id')).toBe(false);
              if (q.get('data') === '2026/09/04-2026/09/04' && !q.get('status') && !q.get('pay_status') && !q.get('extract_type')) {
                expect(value.data.count).toBe(105); pages.add(Number(q.get('page'))); expect(value.data.statistics).toMatchObject({ pending_review: '105.00', pending_transfer: '0.00', paid: '0.00' }); if (q.get('page') === '6') expect(value.data.list.at(-1).id).toBe(100);
              }
              if (q.get('data') === '2026/09/01-2026/09/01' && q.get('status') === '1' && q.get('pay_status') === '0') { expect(value.data).toMatchObject({ count: 1, list: [{ id: 2 }], statistics: { pending_review: '10.00', pending_transfer: '20.00', paid: '0.00' } }); selections.add('day-approved-unpaid'); }
              if (q.get('extract_type') === 'weixin' && q.get('pay_status') === '1') { expect(value.data).toMatchObject({ count: 1, list: [{ id: 3, admin_name: '历史经办人' }] }); selections.add('paid-weixin'); }
              if (q.get('status') === '-1') { expect(value.data).toMatchObject({ count: 1, list: [{ id: 4, fail_msg: '本机拒绝说明' }] }); selections.add('rejected'); }
              if (q.get('extract_type') === 'alipay') { expect(value.data).toMatchObject({ count: 1, list: [{ id: 2, admin_name: '本机财务经办人' }] }); selections.add('alipay'); }
              if (armRead) { armRead = false; readHeld++; delay = true; }
            } else {
              expect(path).toBe('/supplierapi/finance/supplier_extract/mark/1'); expect(Object.keys(value.data)).toHaveLength(6); expect(value.data).toMatchObject({ version: 'supplier-extract-mark-v1', supplier_id: 7, id: 1, bounded: true });
              if (dropped && notes.length === 1) recoveryReads++;
              if (armMark) { armMark = false; markHeld++; delay = true; }
            }
          }
        }
      } finally { release(); }
      if (drop) return send(res, JSON.stringify({ status: 503, msg: 'Owned fixture discarded committed acknowledgement', data: null }), 503, 'application/json');
      const deliver = () => { if (!res.destroyed) { res.writeHead(status, headers); res.end(body); } }; if (delay) held.push(deliver); else deliver(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    const filename = resolve(root, '.' + path), candidate = filename.startsWith(root + sep) ? filename : '';
    try { if (candidate && (await stat(candidate)).isFile()) return send(res, await readFile(candidate), 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(candidate)] ?? 'application/octet-stream'); } catch { /* SPA route */ }
    return send(res, await readFile(resolve(root, 'index.html')));
  })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned acceptance assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Withdrawal history Browser forbids backend outbound fetch'); });
  try {
    await f.withWriter(async runtime => {
      wiring.container = runtime.container; await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address();
      if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('SUPPLIER_EXTRACT_BROWSER_READY ' + JSON.stringify({ control: origin + control, history: origin + '/finance/extracts' }) + '\n');
      deadline = setTimeout(() => fail(Error('Supplier extract Browser finish not received')), 18 * 60_000); await completion;
      process.stdout.write('SUPPLIER_EXTRACT_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; while (held.length) held.shift()!(); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 19 * 60_000);
