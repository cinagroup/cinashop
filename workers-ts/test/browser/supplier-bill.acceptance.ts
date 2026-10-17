/** Installed IAB + production Vue + actual App/JWT + independent SELECT-only
 * PG16 LOGIN. Ledger rows are synthetic READ inputs, never payment evidence. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemRole } from '@/models/schema';
import { supplierBillReadFixture } from '../helpers/supplierBillRead';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned Supplier bill SELECT-only LOGIN'); return wiring.container;
} }));

it('reads actual Supplier bill periods and all105 details through IAB with read-only permissions and stale-response isolation', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist');
  expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierBillReadFixture(), control = '/__supplier_bill_fixture/' + randomUUID();
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const app = createApp(), paths: Array<{ path: string; query: Record<string, string>; method: string; status: number; envelope?: number; principal: string }> = [];
  let origin = '', finished = false, outbound = 0, readonlyGets = 0, denied = false, restored = false;
  let groupHeld = 0, groupReleased = 0, armHold = false, roleWithdrawn = false, accountChanges = 0;
  let apiChain = Promise.resolve(), deadline: ReturnType<typeof setTimeout> | undefined;
  const held: Array<() => void> = [];
  const detailPages = new Set<number>(), periodTypes = new Set<string>(), selectedStatuses = new Set<string>();
  const keywordSearches = new Set<string>(), seenPeriods = new Set<string>();
  let explicitDate = false, closedDetails = false, scriptSeen = false;
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const baseline = await f.snapshot();
  const state = () => ({ finished, outbound, readonlyGets, denied, restored, roleWithdrawn,
    groupHeld, groupReleased, accountChanges, detailPages: [...detailPages].sort((a, b) => a - b),
    periodTypes: [...periodTypes].sort(), selectedStatuses: [...selectedStatuses].sort(), keywordSearches: [...keywordSearches],
    seenPeriods: [...seenPeriods], explicitDate, closedDetails, scriptSeen, paths });
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403, 'text/plain');
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商账单只读 PG16 验收</title><h1>供应商周期账单联合验收</h1>
      <p>本机合成流水只用于读取验证，不是支付执行凭据。当前账号只持finance.view；页面不应出现提现、导出或保存操作。</p>
      <p>9月4日105条明细需走完第6页并搜索MANY-0。9月1日创建、9月2日结算的退款供已结算日期核对；周键须有2021-00与2020-53。可扣留下一账单HTTP回复，其他请求仍照常执行。</p>
      <button id="login">只读账号进入周期账单</button><button id="hold">扣留下一账单回复</button><button id="release">释放已扣留回复</button>
      <button id="withdraw">撤销夹具财务查看权</button><button id="restore">恢复夹具财务查看权</button>
      <button id="other">切换到供应商乙会话</button><button id="reader">切回供应商甲会话</button>
      <button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>
      const tokens=${JSON.stringify(f.tokens)},control=${JSON.stringify(control)};
      function session(other){localStorage.setItem('supplier-token',other?tokens.other:tokens.reader);localStorage.setItem('supplier-user',JSON.stringify({id:other?31:21,supplier_id:other?8:7,supplier_name:other?'本机账单供应商乙':'本机账单供应商甲'}));localStorage.setItem('supplier-permissions','["supplier.finance.view"]');}
      document.getElementById('login').onclick=()=>{session(false);location.href='/finance/bills';};
      for(const name of ['hold','release','withdraw','restore','status','finish','other','reader'])document.getElementById(name).onclick=async()=>{
        const r=await fetch(control+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();
        if(r.ok&&(name==='other'||name==='reader'))session(name==='other');};</script></html>`);
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); await apiChain;
      if (path.endsWith('/hold')) { expect(armHold).toBe(false); armHold = true; }
      if (path.endsWith('/release')) { expect(held.length).toBeGreaterThan(0); while (held.length) { held.shift()!(); groupReleased++; } }
      if (path.endsWith('/withdraw')) { await f.db.update(systemRole).set({ rules: 'supplier.order.view' }).where(eq(systemRole.id, 21)); roleWithdrawn = true; }
      if (path.endsWith('/restore')) { expect(denied).toBe(true); await f.db.update(systemRole).set({ rules: 'supplier.finance.view' }).where(eq(systemRole.id, 21)); roleWithdrawn = false; restored = true; }
      if (path.endsWith('/other') || path.endsWith('/reader')) accountChanges++;
      if (path.endsWith('/finish')) {
        expect(denied && restored && scriptSeen && closedDetails && explicitDate).toBe(true);
        expect(roleWithdrawn || armHold).toBe(false); expect(held).toHaveLength(0);
        expect(groupHeld).toBeGreaterThanOrEqual(2); expect(groupReleased).toBe(groupHeld); expect(accountChanges).toBeGreaterThanOrEqual(2);
        expect([...periodTypes].sort()).toEqual(['day', 'month', 'week']); expect(selectedStatuses.has('1')).toBe(true);
        expect([...detailPages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]); expect(keywordSearches.has('MANY-0')).toBe(true);
        expect(seenPeriods.has('2021-00') && seenPeriods.has('2020-53') && seenPeriods.has('2026-09-02')).toBe(true);
        expect(paths.every(row => row.method === 'GET')).toBe(true); expect(readonlyGets).toBeGreaterThan(15); expect(outbound).toBe(0);
        expect(await f.snapshot()).toEqual(baseline); finished = true;
        await writeFile('/tmp/cinashop-supplier-bill-browser-result.json', JSON.stringify(state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      expect(method).toBe('GET');
      const principal = req.headers.authorization === 'Bearer ' + f.tokens.reader ? 'reader' : req.headers.authorization === 'Bearer ' + f.tokens.other ? 'other' : 'anonymous';
      let release!: () => void; const previous = apiChain; apiChain = new Promise(done => { release = done; }); await previous;
      let body = '', status = 200, headers: Record<string, string> = {};
      let delay = false;
      try {
        const before = await f.snapshot();
        const response = await app.request(path + url.search, { method, headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) } }, env);
        body = await response.text(); status = response.status; headers = Object.fromEntries(response.headers);
        expect(await f.snapshot()).toEqual(before); readonlyGets++;
        if (path === '/api/get_script') { expect(status).toBe(200); scriptSeen = true; paths.push({ path, query: Object.fromEntries(url.searchParams), method, status, principal }); }
        else {
          expect(headers['cache-control']).toContain('private, no-store');
          const value = JSON.parse(body) as { status: number; data?: any };
          paths.push({ path, query: Object.fromEntries(url.searchParams), method, status, envelope: value.status, principal });
          if (roleWithdrawn) { expect(value.status).toBe(400011); denied = true; }
          else {
            expect(principal).toBe('reader'); expect(value.status).toBe(200);
            expect(value.data).toMatchObject({ version: 'supplier-bill-v1', selection: 'period', supplier_id: 7, bounded: true });
            const q = url.searchParams; expect(q.get('selection')).toBe('period'); expect(q.has('supplier_id') || q.has('ids')).toBe(false);
            if (path.endsWith('/fund_record')) {
              periodTypes.add(q.get('timeType')!); selectedStatuses.add(q.get('status') ?? '');
              if (q.get('data')) explicitDate = true;
              for (const row of value.data.list) seenPeriods.add(row.period);
              if (q.get('status') === '1') expect(value.data.list).toMatchObject([{ period: '2026-09-02', entry_num: '-3.00' }]);
              if (armHold) { armHold = false; groupHeld++; delay = true; }
            } else {
              expect(path.endsWith('/fund_record_info')).toBe(true);
              if (q.get('period') === '2026-09-04' && !q.get('keyword')) {
                detailPages.add(Number(q.get('page'))); expect(value.data.count).toBe(105);
                expect(value.data.list).toHaveLength(Number(q.get('page')) === 6 ? 5 : 20);
                if (q.get('page') === '6') expect(value.data.list.at(-1).order_id).toBe('MANY-0');
              }
              if (q.get('keyword')) { keywordSearches.add(q.get('keyword')!); expect(value.data).toMatchObject({ count: 1, list: [{ order_id: 'MANY-0' }] }); }
              expect(value.data.list.every((row: any) => row.supplier_id === 7 && !Object.hasOwn(row, 'supplierId'))).toBe(true); closedDetails = true;
            }
          }
        }
      } finally { release(); }
      const deliver = () => { if (!res.destroyed) { res.writeHead(status, headers); res.end(body); } };
      if (delay) held.push(deliver); else deliver(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    const filename = resolve(root, '.' + path), candidate = filename.startsWith(root + sep) ? filename : '';
    try { if (candidate && (await stat(candidate)).isFile()) return send(res, await readFile(candidate), 200,
      ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(candidate)] ?? 'application/octet-stream'); } catch { /* SPA path */ }
    return send(res, await readFile(resolve(root, 'index.html')));
  })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned acceptance assertion failed', 500, 'text/plain'); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Supplier bill acceptance forbids outbound fetch'); });
  try {
    await f.withReader(async runtime => {
      wiring.container = runtime.container;
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address');
      origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('SUPPLIER_BILL_BROWSER_READY ' + JSON.stringify({ control: origin + control, bills: origin + '/finance/bills' }) + '\n');
      deadline = setTimeout(() => fail(Error('Supplier bill Browser finish not received')), 18 * 60_000);
      await completion; process.stdout.write('SUPPLIER_BILL_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    while (held.length) held.shift()!(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close();
  }
}, 19 * 60_000);
