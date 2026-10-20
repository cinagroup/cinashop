/** Actual PC build + createApp/JWT + owned maintenance PG16.
 * Only session/navigation chrome is synthetic; every bargain action uses the UI. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeBargainUser, storeBargainUserHelp } from '@/models/schema';
import { bargainShortSkuRuntimeFixture } from '../helpers/bargainShortSkuRuntime';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned PC SQL missing'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Owned Admin SQL missing');
    return { container: wiring.container, close: async () => {} }; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length;
    expect(size).toBeLessThan(64000); chunks.push(value); }
  return Buffer.concat(chunks);
}
it('PC start, self help, guest invitation and real friend help keep exact owner progress', async () => {
  const f = await bargainShortSkuRuntimeFixture(), app = createApp();
  const root = resolve(import.meta.dirname, '../../../view/pc-ts/dist');
  const origin = 'http://127.0.0.1:40751', control = '/__pc_bargain/' + randomUUID();
  const stages = ['owner-unjoined', 'owner-started', 'owner-cut', 'guest-invite', 'friend-eligible',
    'friend-cleared', 'friend-recovered', 'friend-ready', 'owner-ready', 'friend-own'];
  const evidence: Row[] = [], traces: Row[] = [];
  let participantId = 0, failure = false, finished = false;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) {
    const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous;
    try { return await work(); } finally { release(); }
  }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned PC browser forbids providers'));
  wiring.container = f.container;
  try {
    expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    const setup = await app.request('/adminapi/activity/save', { method: 'POST',
      headers: { Authorization: 'Bearer ' + f.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...f.adminInput(), storeName: 'PC 朋友帮砍样本', title: 'PC 朋友帮砍样本' }) }, f.env);
    const saved = await setup.json<Row>(); expect(saved.status, saved.msg).toBe(200);
    const activityId = saved.data.id, baseline = await f.snapshot(), sequences = await f.sequences();
    expect(Object.keys(baseline)).toHaveLength(283); expect(sequences).toHaveLength(229);
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const path = url.pathname, rawBody = await bytes(req);
        const start = req.method === 'POST' && path === '/api/bargain/start';
        const help = req.method === 'POST' && path === '/api/bargain/help';
        const read = req.method === 'GET' && ['/api/get_script', '/api/cart/count', '/api/cart/list', `/api/bargain/detail/${activityId}`].includes(path);
        expect(read || start || help, req.method + ' ' + path).toBe(true);
        const before = await f.snapshot(), beforeSeq = await f.sequences(), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const pending: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method: req.method, headers,
          ...(rawBody.length ? { body: rawBody.toString() } : {}) }), f.env,
          { waitUntil: value => { pending.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(pending);
        const raw = Buffer.from(await response.arrayBuffer());
        const body = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
        expect(response.status, raw.toString().slice(0, 300)).toBe(200);
        if (body) expect(body.status, body.msg).toBe(200);
        if (start) { participantId = body.data.id; expect(participantId).toBeGreaterThan(100); }
        if (help) expect(JSON.parse(rawBody.toString())).toEqual({ bargain_user_id: participantId });
        const allowed = start ? ['store_bargain_user'] : help ? ['store_bargain_user', 'store_bargain_user_help'] : [];
        const allowedSeq = start ? ['store_bargain_user_id_seq'] : help ? ['store_bargain_user_help_id_seq'] : [];
        const after = await f.snapshot(), afterSeq = await f.sequences();
        for (const table of Object.keys(before)) if (!allowed.includes(table)) expect(after[table], table).toEqual(before[table]);
        for (const entry of beforeSeq) if (!allowedSeq.includes(entry.name)) expect(afterSeq.find(row => row.name === entry.name)).toEqual(entry);
        const inject = failure && path === `/api/bargain/detail/${activityId}` && url.searchParams.get('view') === 'help';
        traces.push({ method: req.method, path, query: url.search, status: inject ? 503 : response.status,
          ...(body?.data?.help_only ? { participant_id: body.data.participant_id, state: body.data.help_state } : {}),
          allowed_tables: allowed, all_other_public_tables_sequences_unchanged: true });
        if (inject) return send(res, JSON.stringify({ status: 503, msg: '邀请读取失败，请重试', data: null }), 503, 'application/json');
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        if (stage === 'inject503') { expect(evidence.at(-1)?.stage).toBe('friend-eligible'); failure = true; }
        else if (stage === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages);
          expect(traces.filter(row => row.path === '/api/bargain/start')).toHaveLength(1);
          expect(traces.filter(row => row.path === '/api/bargain/help')).toHaveLength(2);
          const [record] = await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId));
          expect(record).toMatchObject({ uid: 11, bargainId: activityId, status: 3,
            bargainPrice: '10.00', bargainPriceMin: '2.00', price: '8.00' });
          const helps = await f.db.select().from(storeBargainUserHelp).where(eq(storeBargainUserHelp.bargainUserId, participantId)).orderBy(storeBargainUserHelp.id);
          expect(helps.map(row => ({ uid: row.uid, type: row.type }))).toEqual([{ uid: 11, type: 1 }, { uid: 22, type: 0 }]);
          const after = await f.snapshot(), afterSeq = await f.sequences();
          for (const table of Object.keys(baseline)) if (!['store_bargain_user', 'store_bargain_user_help'].includes(table))
            expect(after[table], table).toEqual(baseline[table]);
          for (const entry of sequences) if (!['store_bargain_user_id_seq', 'store_bargain_user_help_id_seq'].includes(entry.name))
            expect(afterSeq.find(row => row.name === entry.name)).toEqual(entry);
          expect(external).not.toHaveBeenCalled(); finished = true;
          await writeFile('/tmp/cinashop-pc-bargain-invitations-browser-result.json', JSON.stringify({
            evidence, traces, activityId, participantId, provider_calls: 0, order_creations: 0,
            authority: 'actual createApp/JWT + owned maintenance SQL; synthetic session/navigation chrome; no production LOGIN claim',
          }, null, 2) + '\n');
        } else {
          expect(stage).toBe(stages[evidence.length]); expect(data.scroll_width).toBeLessThanOrEqual(data.width + 1);
          expect(new URL(data.href).pathname).toBe(`/bargain/${activityId}`);
          if (stage === 'owner-unjoined' || stage === 'friend-own') {
            expect(data.text).toContain('发起砍价'); expect(data.invitation).toBe(null);
            expect(new URL(data.href).search).toBe('');
          } else if (stage === 'guest-invite') {
            expect(data.text).toContain('登录查看砍价邀请'); expect(data.help_disabled).toBe(null);
            expect(data.invitation).toBe(null); expect(data.sku_count).toBe(0);
          } else if (stage === 'friend-cleared') {
            expect(data.text).toContain('Request failed with status code 503');
            expect(data.help_disabled).toBe(null); expect(data.invitation).toBe(null); failure = false;
          } else {
            expect(data.text).toContain('参与记录 #' + participantId);
            expect(data.invitation).toBe(`${origin}/bargain/${activityId}?bargainUserId=${participantId}&help=1`);
            if (stage.startsWith('friend-')) {
              expect(data.text).toContain('朋友的砍价邀请'); expect(data.purchase_count).toBe(0); expect(data.sku_count).toBe(0);
              expect(data.help_disabled).toBe(stage === 'friend-ready');
              if (stage === 'friend-ready') expect(data.text).toContain('当前价 ¥2.00');
            } else if (stage === 'owner-cut') {
              expect(data.self_disabled).toBe(true); expect(data.text).toContain('你已帮这条记录砍过价');
            } else if (stage === 'owner-ready') expect(data.text).toContain('参与当前价 ¥2.00');
          }
          evidence.push({ stage, ...data });
        }
        json(res, { checked: evidence.map(row => row.stage), participantId, finished }); if (finished) done();
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>PC 砍价邀请验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1100px;height:850px;border:1px solid #ddd}pre{max-height:50px;overflow:auto}</style>
<h1>实际 PC 砍价页面</h1><button id="owner">发起人页面</button><button id="friend">朋友邀请页面</button><button id="guest">访客邀请页面</button><button id="mobile">窄屏</button>
${[...stages, 'inject503', 'finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际PC页面"></iframe><script>
const frame=document.querySelector('iframe');let participant=0,invitation='';
function session(token,uid){if(token){sessionStorage.setItem('pc_token',token);sessionStorage.setItem('pc_uid',String(uid));}else{sessionStorage.removeItem('pc_token');sessionStorage.removeItem('pc_uid');}}
document.getElementById('owner').onclick=()=>{session(${JSON.stringify(f.token)},11);frame.src='/bargain/${activityId}'+(participant?'?bargainUserId='+participant:'');};
document.getElementById('friend').onclick=()=>{if(!invitation)throw Error('Invitation required');session(${JSON.stringify(f.helperToken)},22);frame.src=invitation;};
document.getElementById('guest').onclick=()=>{if(!invitation)throw Error('Invitation required');session('',0);frame.src=invitation;};
document.getElementById('mobile').onclick=()=>frame.style.width='430px';
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,buttons=[...d.querySelectorAll('button')],h=buttons.find(x=>x.textContent.trim()==='帮好友砍一刀'),s=buttons.find(x=>x.textContent.trim()==='帮自己砍一刀'),
data={href:frame.contentWindow.location.href,text:d.body.textContent,help_disabled:h?h.disabled:null,self_disabled:s?s.disabled:null,invitation:d.querySelector('#bargain-invitation')?.value??null,purchase_count:buttons.filter(x=>x.textContent.trim()==='用本条参与购买').length,sku_count:d.querySelectorAll('.sku').length,width:d.documentElement.clientWidth,scroll_width:d.documentElement.scrollWidth};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await response.json();participant=result.participantId||participant;if(data.invitation)invitation=data.invitation;document.getElementById('result').textContent=JSON.stringify(result);};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (['/legacy/bargain-short-sku.png', '/logo.png', '/api/qa/image.svg'].includes(path)) return send(res, Buffer.from(f.png), 200, 'image/png');
      const chrome: Row = {
        '/api/site_config': { site_name: '本地 PC 砍价验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地 PC 砍价验收', synopsis: '', img: '' },
        '/api/diy/get_suspended': { is_show: 0, button: [] },
      };
      if (req.method === 'GET' && Object.hasOwn(chrome, path))
        return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path));
      if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
        ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* SPA */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error)));
      if (!res.headersSent) send(res, 'Owned PC assertion failed: ' + String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('PC_BARGAIN_INVITATIONS_BROWSER_READY ' + JSON.stringify({ url: origin + control }) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
      process.stdout.write('PC_BARGAIN_INVITATIONS_BROWSER_RESULT ' + JSON.stringify({ stages, requests: traces.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
