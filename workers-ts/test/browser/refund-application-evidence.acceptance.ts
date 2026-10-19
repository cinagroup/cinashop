/** Actual PC/UniApp upload and application -> buyer and Supplier readonly preview. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeOrderRefund } from '@/models/schema';
import { refundApplicationEvidenceWriterFixture } from '../helpers/refundApplicationEvidence';
import { grantCustomerRefundImageReader } from '../helpers/customerRefundRequestImages';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned evidence Browser boundary'); return wiring.container;
} }));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage, max: number) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const data = Buffer.from(chunk); length += data.length; expect(length).toBeLessThanOrEqual(max); chunks.push(data); }
  return Buffer.concat(chunks);
}
it.each(['pc', 'mobile'] as const)('joins real %s application images to exact buyer and Supplier readonly records', async kind => {
  const app = createApp(), control = '/__refund_evidence/' + randomUUID();
  const roots = { buyer: resolve(import.meta.dirname, '../../../view', kind === 'pc' ? 'pc-ts/dist' : 'uniapp-ts/dist/build/h5'), supplier: resolve(import.meta.dirname, '../../../view/supplier-ts/dist') };
  for (const root of Object.values(roots)) expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await refundApplicationEvidenceWriterFixture();
  const pngPath = '/tmp/cinashop-customer-refund-request-images-browser-' + kind + '.png';
  try { await writeFile(pngPath, f.png); } catch (error) { await f.close(); throw error; }
  const paths: Row[] = [], evidence: Row[] = []; let refundId = 0, finished = false, failAsset = false, failDetail = false, rejectedUploads = 0, fixtureProductThumbnails = 0;
  let resolveDone!: () => void, rejectDone!: (cause: Error) => void;
  const completion = new Promise<void>((yes, no) => { resolveDone = yes; rejectDone = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void; chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  const result = () => ({ kind, paths, evidence, refund_id: refundId, finished, provider_calls: 0, r2_puts: f.r2Writes.length, rejected_uploads: rejectedUploads, fixture_product_thumbnail_reads: fixtureProductThumbnails });
  const origins = { buyer: '', supplier: '' };
  function send(res: ServerResponse, data: string | Buffer, status = 200, type = 'text/html; charset=utf-8') { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(data); } }
  async function api(req: IncomingMessage, res: ServerResponse, url: URL, surface: 'buyer' | 'supplier') {
    return serial(async () => {
      const path = url.pathname, asset = /^\/api\/assets\/[1-9]\d*$/.test(path);
      const upload = surface === 'buyer' && req.method === 'POST' && path === '/api/upload/image';
      const apply = surface === 'buyer' && req.method === 'POST' && path === '/api/order/refund/apply/' + f.ids.publicOrderId;
      const customerRead = surface === 'buyer' && req.method === 'GET' && path === '/api/order/refund/detail/' + refundId;
      const allowedRead = req.method === 'GET' && (asset || path === '/api/get_script' || path === '/api/v2/diy/color_change/color_change'
        || surface === 'buyer' && path === '/api/order/detail/' + f.ids.publicOrderId || customerRead
        || surface === 'supplier' && ['/supplierapi/refund/list','/supplierapi/refund/reason','/supplierapi/refund/detail/' + refundId].includes(path));
      expect(allowedRead || upload || apply, 'Unexpected business request: ' + req.method + ' ' + path).toBe(true);
      const before = await f.snapshot(), seq = await f.sequences(), writes = f.r2Writes.length, headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const body = req.method === 'POST' ? await bytes(req, upload ? 10 * 1024 * 1024 + 8192 : 32768) : undefined;
      const work = async (container: Container) => {
        wiring.container = container;
        return app.fetch(new Request(origins[surface] + url.pathname + url.search, { method: req.method, headers, ...(body ? { body } : {}) }), f.env);
      };
      const response = surface === 'supplier' || asset || customerRead ? await f.withReader(async peer => {
        if (customerRead) await grantCustomerRefundImageReader(peer.role, f.exec);
        return work(peer.container);
      }) : await f.withBuyer(peer => work(peer.container));
      const raw = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
      const envelope = asset || path === '/api/get_script' ? null : JSON.parse(raw.toString()); if (envelope) expect(envelope.status, envelope.msg).toBe(200);
      const entry: Row = { surface, method: req.method, path, http: response.status, boundary: surface === 'supplier' || asset || customerRead ? 'independent_select_only_LOGIN' : 'owned_maintenance_buyer_SQL' };
      if (req.method === 'GET') { expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); expect(f.r2Writes.length).toBe(writes); entry.sql_sequences_r2_writes_unchanged = true; }
      if (upload) { expect(f.r2Writes.length).toBe(writes + 1); expect(envelope.data.url).toMatch(/^\/api\/assets\/[1-9]\d*$/); entry.asset = envelope.data.url; }
      if (apply) {
        const input = JSON.parse(body!.toString()), references = JSON.parse(input.refundImg); expect(references).toHaveLength(1);
        expect(references[0]).toMatch(/^\/api\/assets\/[1-9]\d*$/); expect(JSON.stringify(input)).not.toContain('signature');
        refundId = envelope.data.refundId; const [stored] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
        expect(stored.refundImg).toBe(input.refundImg); expect(stored.refundGoodsImg ?? '').toBe(''); entry.refund_id = refundId; entry.persisted_canonical_references = references;
      }
      if (path === '/supplierapi/refund/detail/' + refundId) { expect(envelope.data.id).toBe(refundId); expect(envelope.data.requestImages).toHaveLength(1); expect(envelope.data.returnImages).toEqual([]); expect(envelope.data.requestImagesError).toBe(''); entry.refund_id = refundId; }
      if (customerRead) {
        expect(url.search).toBe('?view=customer'); expect(envelope.data.id).toBe(refundId); expect(envelope.data.uid).toBe(11);
        expect(envelope.data.requestImages.map((image: Row) => image.url)).toEqual(paths.find(x => x.persisted_canonical_references)!.persisted_canonical_references);
        expect(envelope.data.requestImagesError).toBe(''); expect(envelope.data.returnImages).toEqual([]);
        expect(Object.hasOwn(envelope.data, 'refundImg')).toBe(false); entry.refund_id = refundId;
      }
      if (asset) { expect([...raw]).toEqual([...f.png]); expect(response.headers.get('content-type')).toContain('image/png'); entry.exact_png_bytes = true; }
      if (asset && failAsset) { failAsset = false; entry.injected_http = 503; paths.push(entry); return send(res, 'Owned image failure', 503, 'text/plain'); }
      if ((customerRead || surface === 'supplier' && path.startsWith('/supplierapi/refund/detail/')) && failDetail) { failDetail = false; entry.injected_http = 503; paths.push(entry); return send(res, 'Owned detail failure', 503, 'text/plain'); }
      paths.push(entry); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
    });
  }
  async function action(req: IncomingMessage, res: ServerResponse, url: URL, surface: 'buyer' | 'supplier') {
    return serial(async () => {
      const name = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req, 65536)).toString() || '{}');
      if (name === 'asset-failure') failAsset = true;
      else if (name === 'detail-failure') failDetail = true;
      else if (name === 'buyer-images') {
        expect(data.images.length).toBe(1); expect(data.images.every((x: Row) => x.complete && x.width > 0)).toBe(true); expect(data.text).toContain('申请凭证');
        const uploads = paths.filter(x => x.method === 'POST' && x.path === '/api/upload/image'); expect(uploads.length).toBeGreaterThanOrEqual(2);
        expect(new URL(data.images[0].src, origins.buyer).pathname).toBe(uploads.at(-1)!.asset);
        evidence.push({ stage: name, surface, images: data.images });
      }
      else if (name === 'buyer-submitted') { expect(refundId).toBeGreaterThan(0); expect(data.text).toContain('#' + refundId); expect(paths.filter(x => x.method === 'POST' && x.path.includes('/refund/apply/'))).toHaveLength(1); evidence.push({ stage: name, surface }); }
      else if (name === 'customer-preview' || name === 'customer-recovered') {
        expect(surface).toBe('buyer'); expect(data.text).toContain('申请凭证'); expect(data.images).toHaveLength(1);
        expect(data.images[0].complete && data.images[0].width > 0).toBe(true);
        expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
        evidence.push({ stage: name, surface, images: data.images, page_width: data.page_width });
      } else if (name === 'customer-broken') { expect(data.text).toContain('申请凭证 1 读取失败'); evidence.push({ stage: name, surface }); }
      else if (name === 'customer-cleared') {
        expect(surface).toBe('buyer');
        expect(paths.filter(row => row.path === '/api/order/refund/detail/' + refundId).at(-1)?.injected_http).toBe(503);
        expect(data.text).toContain(kind === 'mobile' ? '请求失败' : '503');
        expect(data.request_panels).toBe(0); expect(data.images).toEqual([]); evidence.push({ stage: name, surface });
      }
      else if (name === 'supplier-preview' || name === 'supplier-recovered') {
        expect(data.text).toContain('申请凭证'); expect(data.text).toContain('用户未上传退货凭证'); expect(data.images.length).toBe(1); expect(data.images[0].width).toBeGreaterThan(0);
        expect(data.write_buttons_enabled).toBe(0); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1); evidence.push({ stage: name, surface, images: data.images, page_width: data.page_width });
      } else if (name === 'supplier-broken') { expect(data.text).toContain('申请凭证 1 读取失败'); evidence.push({ stage: name, surface }); }
      else if (name === 'supplier-cleared') { expect(data.text).toContain('503'); expect(data.application_panels).toBe(0); expect(data.images).toEqual([]); evidence.push({ stage: name, surface }); }
      else if (name === 'finish') {
        for (const stage of ['buyer-images','buyer-submitted','customer-preview','customer-broken','customer-cleared','customer-recovered','supplier-preview','supplier-broken','supplier-cleared','supplier-recovered']) expect(evidence.some(row => row.stage === stage)).toBe(true);
        expect(paths.filter(x => x.method === 'POST' && x.path.includes('/refund/apply/'))).toHaveLength(1); expect(paths.filter(x => x.method === 'POST' && x.path === '/api/upload/image').length).toBeGreaterThanOrEqual(2);
        const uploads = paths.filter(x => x.method === 'POST' && x.path === '/api/upload/image');
        const application = paths.find(x => x.persisted_canonical_references)!;
        expect(application.persisted_canonical_references).toEqual([uploads.at(-1)!.asset]);
        expect(application.persisted_canonical_references).not.toContain(uploads[0].asset);
        expect(f.r2Writes.length).toBeGreaterThanOrEqual(2); expect(paths.some(x => x.exact_png_bytes && !x.injected_http)).toBe(true);
        finished = true; await writeFile('/tmp/cinashop-customer-refund-request-images-browser-' + kind + '-result.json', JSON.stringify({ ...result(), table_count: Object.keys(await f.snapshot()).length, sequence_count: (await f.sequences()).length }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(result()), 200, 'application/json'); if (finished) resolveDone();
    });
  }
  function shell(surface: 'buyer' | 'supplier') {
    const enter = surface === 'buyer' ? (kind === 'pc' ? `sessionStorage.setItem('pc_token',${JSON.stringify(f.tokens.buyer)});sessionStorage.setItem('pc_uid','11');frame.src='/refund/${f.ids.publicOrderId}';`
      : `localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.tokens.buyer)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.src='/#/pages/order/refundApply?orderId=${f.ids.publicOrderId}';`)
      : `localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.viewer)});localStorage.setItem('supplier-user',JSON.stringify({id:990,supplier_id:7,supplier_name:'申请凭证只读验收'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.refund.view']));frame.src='/refunds';`;
    const stages = surface === 'buyer' ? ['buyer-images','buyer-submitted','customer-preview','customer-broken','customer-cleared','customer-recovered'] : ['supplier-preview','supplier-broken','supplier-cleared','supplier-recovered'];
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${kind}退款申请凭证 ${surface}</title><style>body{font:14px sans-serif;margin:12px}button{margin:4px}pre{max-height:55px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:${kind === 'mobile' ? 390 : 1200}px;height:844px;border:1px solid #ccc}</style><h1>${surface === 'buyer' ? '买家退款申请凭证' : '商家申请凭证核对'}</h1><button id="enter">进入实际页面</button>${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<button data-stage="asset-failure">模拟图片失败</button><button data-stage="detail-failure">模拟详情失败</button><button data-stage="finish">完成本端验收</button><pre id="result"></pre><iframe title="实际${surface}生产页面"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{${enter}};for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const doc=frame.contentDocument,stage=button.dataset.stage;const customer=stage.startsWith('customer-'),root=doc.querySelector(customer?'.request-evidence':'${surface === 'buyer' ? '.application-evidence' : '.el-drawer'}');const data={text:stage==='buyer-submitted'||stage==='customer-cleared'?doc.body.textContent:root?.textContent??'',request_panels:doc.querySelectorAll('.request-evidence').length,images:[...(root?.querySelectorAll('img')??[])].map(x=>({complete:x.complete,width:x.naturalWidth,height:x.naturalHeight,src:x.currentSrc||x.src})),application_panels:doc.querySelectorAll('.application-evidence').length,write_buttons_enabled:[...doc.querySelectorAll('.drawer-actions button')].filter(x=>!x.disabled).length,page_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth};const response=await fetch('${control}/'+stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();document.getElementById('result').textContent=JSON.stringify({kind:value.kind,refund_id:value.refund_id,checked:value.evidence.map(x=>x.stage),finished:value.finished});};</script></html>`;
  }
  function host(surface: 'buyer' | 'supplier') { return createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origins[surface]).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origins[surface]), path = url.pathname;
    if (path === control && req.method === 'GET') return send(res, shell(surface));
    if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url, surface);
    // The unchanged checkout fixture stores this display-only product path.
    // Serve its owned PNG without synthesizing any order, refund or identity.
    if (surface === 'buyer' && req.method === 'GET' && path === '/api/qa/image.svg') {
      fixtureProductThumbnails++; return send(res, Buffer.from(f.png), 200, 'image/png');
    }
    const chrome: Record<string, unknown> = { '/api/site_config': { site_name: '本地申请凭证验收', site_logo: '', record_No: '', ico_path: '' }, '/api/share': { title: '本地申请凭证验收', synopsis: '', img: '' }, '/api/cart/count': { count: 0 }, '/api/cart/list': [], '/api/diy/get_suspended': { is_show: 0, button: [] } };
    if (surface === 'buyer' && req.method === 'GET' && Object.hasOwn(chrome, path)) return send(res, JSON.stringify({ status: 200, data: chrome[path], msg: 'Owned shell only; no synthesized order/refund/identity' }), 200, 'application/json');
    if (path.startsWith('/api/') || path.startsWith('/supplierapi/')) return api(req, res, url, surface);
    if (path === '/favicon.ico') return send(res, '', 204);
    const root = roots[surface], target = resolve(root, '.' + decodeURIComponent(path));
    if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
    try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200, ({ '.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2' } as Record<string,string>)[extname(target)] ?? 'application/octet-stream'); } catch { /* SPA route */ }
    send(res, await readFile(resolve(root, 'index.html')));
  })().catch(cause => { rejectDone(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned evidence assertion failed', 500); else res.destroy(); }); }); }
  const buyer = host('buyer'), supplier = host('supplier'); const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider dispatch in evidence acceptance'));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const [surface, server] of [['buyer',buyer],['supplier',supplier]] as const) { await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Owned evidence Browser port absent'); origins[surface] = 'http://127.0.0.1:' + address.port; }
    process.stdout.write('REFUND_APPLICATION_EVIDENCE_BROWSER_READY ' + JSON.stringify({ kind, buyer: origins.buyer + control, supplier: origins.supplier + control, png: pngPath, source_order: f.ids.publicOrderId }) + '\n');
    deadline = setTimeout(() => rejectDone(Error('Evidence Browser completion absent')), 20 * 60_000); await completion; expect(external).not.toHaveBeenCalled();
    process.stdout.write('REFUND_APPLICATION_EVIDENCE_BROWSER_RESULT ' + JSON.stringify({ kind, refund_id: refundId, paths: paths.length, stages: evidence.map(x => x.stage) }) + '\n');
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    for (const server of [buyer,supplier]) { server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); } await f.close(); }
}, 21 * 60_000);
