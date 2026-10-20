/** Actual built H5 owner + friend UI, createApp/JWT, owned maintenance PG16.
 * Synthetic session/navigation chrome and DO budget only; no helper API bridge. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeBargainUser, storeBargainUserHelp, storeOrder } from '@/models/schema';
import { bargainShortSkuRuntimeFixture } from '../helpers/bargainShortSkuRuntime';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned friend SQL missing'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Owned friend Admin SQL missing');
    return { container: wiring.container, close: async () => {} }; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length;
    expect(size).toBeLessThan(64000); chunks.push(value); }
  return Buffer.concat(chunks);
}
it('real owner start, self help, exact QR invitation and friend button reach the same frozen bottom price', async () => {
  const f = await bargainShortSkuRuntimeFixture(), app = createApp();
  const root = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5');
  const origin = 'http://127.0.0.1:40751', control = '/__bargain_friend/' + randomUUID();
  const stages = ['owner-unjoined', 'owner-cut', 'friend-eligible', 'qr-generated',
    'friend-cleared', 'friend-recovered', 'friend-ready', 'owner-ready'];
  const evidence: Row[] = [], traces: Row[] = [];
  let participantId = 0, failure = false, finished = false;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned friend Browser forbids providers'));
  const env = { ...f.env, PUBLIC_H5_ORIGIN: 'https://shop.example.test',
    CONFIG_KV: new Proxy(f.env.CONFIG_KV, { get(target, key) {
      if (key === 'get') return (name: string) => ['cfg_routine_appId', 'cfg_routine_appsecret'].includes(name) ? Promise.resolve('') : target.get(name);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }),
    TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60000 }) }) } as any };
  wiring.container = f.container;
  try {
    expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    const setup = await app.request('/adminapi/activity/save', { method: 'POST',
      headers: { Authorization: 'Bearer ' + f.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...f.adminInput(), storeName: '朋友帮砍样本', title: '朋友帮砍样本' }) }, env);
    const saved = await setup.json<Row>(); expect(saved.status, saved.msg).toBe(200);
    const activityId = saved.data.id;
    const baseline = await f.snapshot(), sequences = await f.sequences();
    expect(Object.keys(baseline)).toHaveLength(283); expect(sequences).toHaveLength(229);
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const path = url.pathname, rawBody = await bytes(req);
        const start = req.method === 'POST' && path === '/api/bargain/start';
        const help = req.method === 'POST' && path === '/api/bargain/help';
        const referral = req.method === 'POST' && path === '/api/user/spread';
        const code = req.method === 'GET' && path === `/api/get_qrcode/2/${activityId}`;
        const read = req.method === 'GET' && (['/api/get_script', '/api/v2/diy/color_change/color_change',
          '/api/v2/diy/product_detail', '/api/cart/count', `/api/bargain/detail/${activityId}`].includes(path)
          || /^\/api\/share\/(?:scene\/[a-f0-9]{24}|code\/image\/[a-f0-9]{24}\/wechat)$/.test(path));
        expect(read || start || help || code || referral, req.method + ' ' + path).toBe(true);
        const before = await f.snapshot(), beforeSeq = await f.sequences();
        const headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const pending: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method: req.method, headers,
          ...(rawBody.length ? { body: rawBody.toString() } : {}) }), env,
          { waitUntil: value => { pending.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(pending);
        const raw = Buffer.from(await response.arrayBuffer()), contentType = response.headers.get('Content-Type') ?? '';
        const body = contentType.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
        expect(response.status, raw.toString().slice(0, 300)).toBe(200);
        if (referral) {
          expect(JSON.parse(rawBody.toString())).toEqual({ spread_uid: 11 });
          // The donor has buyer11 -> helper22 already. The real referral service
          // must reject the reverse edge without altering either user's history.
          expect(body).toMatchObject({ status: 400, msg: '推广关系不能形成循环' });
        } else if (body) expect(body.status, body.msg).toBe(200);
        if (start) { participantId = body.data.id; expect(participantId).toBeGreaterThan(100); }
        if (help) expect(JSON.parse(rawBody.toString())).toEqual({ bargain_user_id: participantId });
        if (code) expect(url.search).toBe('?bargain_user_id=' + participantId);
        const allowed = start ? ['store_bargain_user'] : help ? ['store_bargain_user', 'store_bargain_user_help'] : code ? ['cache'] : [];
        const allowedSeq = start ? ['store_bargain_user_id_seq'] : help ? ['store_bargain_user_help_id_seq'] : [];
        const after = await f.snapshot(), afterSeq = await f.sequences();
        if (code) {
          expect(before.cache).toEqual([]); expect(after.cache).toHaveLength(2);
          for (const entry of after.cache as Array<{ row: { key: string; result: string } }>) {
            expect(entry.row.key).toMatch(/^(?:lsc:|lshare:)[a-f0-9]+$/);
            expect(JSON.parse(entry.row.result).descriptor).toMatchObject({ type: 2, id: activityId, bargainUserId: participantId, bargainOwnerUid: 11 });
          }
        }
        for (const table of Object.keys(before)) if (!allowed.includes(table)) expect(after[table], table).toEqual(before[table]);
        for (const entry of beforeSeq) if (!allowedSeq.includes(entry.name)) expect(afterSeq.find(row => row.name === entry.name)).toEqual(entry);
        const inject = failure && path === `/api/bargain/detail/${activityId}` && url.searchParams.get('view') === 'help';
        traces.push({ method: req.method, path, query: url.search, status: inject ? 503 : response.status, business_status: body?.status,
          ...(body?.data?.help_only ? { participant_id: body.data.participant_id, state: body.data.help_state } : {}),
          allowed_tables: allowed, all_other_public_tables_sequences_unchanged: true });
        if (inject) return send(res, JSON.stringify({ status: 503, msg: '邀请读取失败，请重试', data: null }), 503, 'application/json');
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        if (stage === 'inject503') { expect(evidence.at(-1)?.stage).toBe('qr-generated'); failure = true; }
        else if (stage === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages);
          expect(traces.filter(row => row.path === '/api/bargain/start')).toHaveLength(1);
          expect(traces.filter(row => row.path === '/api/bargain/help')).toHaveLength(2);
          expect(traces.filter(row => row.path.startsWith('/api/get_qrcode/'))).toHaveLength(1);
          const [record] = await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId));
          expect(record).toMatchObject({ uid: 11, bargainId: activityId, status: 3, bargainPrice: '10.00', bargainPriceMin: '2.00', price: '8.00' });
          const helps = await f.db.select().from(storeBargainUserHelp).where(eq(storeBargainUserHelp.bargainUserId, participantId)).orderBy(storeBargainUserHelp.id);
          expect(helps.map(row => ({ uid: row.uid, type: row.type }))).toEqual([{ uid: 11, type: 1 }, { uid: 22, type: 0 }]);
          expect(await f.db.select().from(storeOrder).where(eq(storeOrder.uid, 11))).toEqual([]);
          const after = await f.snapshot(), afterSeq = await f.sequences();
          for (const table of Object.keys(baseline)) if (!['store_bargain_user', 'store_bargain_user_help', 'cache'].includes(table))
            expect(after[table], table).toEqual(baseline[table]);
          for (const entry of sequences) if (!['store_bargain_user_id_seq', 'store_bargain_user_help_id_seq'].includes(entry.name))
            expect(afterSeq.find(row => row.name === entry.name)).toEqual(entry);
          expect(external).not.toHaveBeenCalled(); finished = true;
          await writeFile('/tmp/cinashop-bargain-friend-help-browser-result.json', JSON.stringify({ evidence, traces, activityId, participantId,
            friend_ui_verified: true, helper_api_bridge: false, provider_calls: 0, order_creations: 0,
            authority: 'actual createApp/JWT injected owned maintenance SQL; synthetic sessions/chrome/DO budget; no production LOGIN claim' }, null, 2) + '\n');
        } else {
          expect(stage).toBe(stages[evidence.length]); expect(data.scroll_width).toBeLessThanOrEqual(data.width + 1);
          if (stage === 'owner-unjoined') expect(data.text).toContain('发起砍价');
          else if (stage === 'owner-cut') { expect(data.text).toContain('记录 #' + participantId); expect(data.text).toContain('砍价中'); }
          else if (stage === 'friend-cleared') { expect(data.text).toContain('邀请读取失败'); expect(data.help_disabled).toBe(null); failure = false; }
          else if (stage === 'owner-ready') { expect(data.text).toContain('当前价 ¥2.00'); expect(data.text).toContain('可购买'); }
          else {
            expect(data.text).toContain('朋友的砍价邀请'); expect(data.text).toContain('记录 #' + participantId);
            expect(data.purchase_count).toBe(0); expect(data.sku_count).toBe(0);
            expect(data.help_disabled).toBe(stage === 'friend-ready');
            if (stage === 'friend-ready') expect(data.text).toContain('已砍至底价');
            if (stage === 'qr-generated') { expect(data.qr_count).toBe(1); expect(data.text).toContain('预览二维码'); }
          }
          evidence.push({ stage, ...data });
        }
        json(res, { checked: evidence.map(row => row.stage), participantId, finished }); if (finished) done();
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>朋友帮砍页面验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:700px;border:1px solid #ddd}pre{max-height:50px;overflow:auto}</style><h1>实际 H5 朋友帮砍</h1><p>本地测试账号；操作实际页面；无朋友 API 桥接。</p><button id="owner">发起人页面</button><button id="friend">朋友邀请页面</button><button id="reload">重新加载页面</button>${[...stages, 'inject503', 'finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际H5页面"></iframe><script>
const frame=document.querySelector('iframe');let participant=0;
function session(token,uid){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}));}
document.getElementById('owner').onclick=()=>{session(${JSON.stringify(f.token)},11);frame.src='/__bargain_h5?actor=11#/pages/activity/bargainDetail?id=${activityId}'+(participant?'&bargainUserId='+participant:'');};
document.getElementById('friend').onclick=()=>{if(!participant)throw Error('Start required');session(${JSON.stringify(f.helperToken)},22);frame.src='/__bargain_h5?actor=22#/pages/activity/bargainDetail?id=${activityId}&bargainUserId='+participant+'&help=1&spid=11';};
document.getElementById('reload').onclick=()=>frame.contentWindow.location.reload();
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,h=[...d.querySelectorAll('uni-button,button')].find(x=>x.textContent.trim()==='帮好友砍一刀'),data={href:frame.contentWindow.location.href,text:d.body.textContent,help_disabled:h?h.hasAttribute('disabled')&&h.getAttribute('disabled')!=='false':null,purchase_count:d.querySelectorAll('.buy-btn').length,sku_count:d.querySelectorAll('.sku').length,qr_count:d.querySelectorAll('.legacy-share-code .qr').length,width:d.documentElement.clientWidth,scroll_width:d.documentElement.scrollWidth};const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await response.json();participant=result.participantId||participant;document.getElementById('result').textContent=JSON.stringify(result);};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (path === '/legacy/bargain-short-sku.png') return send(res, Buffer.from(f.png), 200, 'image/png');
      const chrome: Row = { '/api/site_config': { site_name: '本地帮砍验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地帮砍验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path));
      if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
        ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* SPA */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error)));
      if (!res.headersSent) send(res, 'Owned friend assertion failed: ' + String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('BARGAIN_FRIEND_HELP_BROWSER_READY ' + JSON.stringify({ url: origin + control }) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
      process.stdout.write('BARGAIN_FRIEND_HELP_BROWSER_RESULT ' + JSON.stringify({ stages, requests: traces.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
