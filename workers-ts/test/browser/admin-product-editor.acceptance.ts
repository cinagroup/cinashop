/** Explicit opt-in Browser-plugin host. Actual editor save/detail/receipt/draft
 * routes use the App, JWT authority and a newly owned disposable PostgreSQL16
 * database. The navigation shell and bounded metadata candidates are synthetic.
 * This host launches no browser and claims no unobserved rendered assertions. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { legacyCache, storeProduct, storeProductAttrValue, storeProductCategory, storeBrand, storeProductLabel, storeProductEnsure,
  userLabel, storeCouponIssue, systemForm, shippingTemplates, systemAdmin, systemRole, systemConfig, systemAttachment, systemAttachmentCategory } from '@/models/schema';
import { PRODUCT_EDITOR_OPERATION_SQL, assertProductEditorOperationReady } from '@/migrations/adminProductEditorOperation';
import { PRODUCT_VIDEO_UPLOAD_SQL, assertProductVideoUploadReady } from '@/migrations/adminProductVideoUpload';
import { ADMIN_LEGACY_PRODUCT_FIELDS } from '@/services/admin/AdminLegacyProductInput';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from '../helpers/financePostgres';
import { legacySaveSchema } from '../helpers/adminLegacyProductSave';
import { OwnedFixedLengthStream } from '../helpers/adminProductVideoUpload';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned editor fixture'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned editor fixture'); return { container: wiring.container, close: async () => {} }; } }));
function send(response: ServerResponse, value: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(value);
}
const json = (response: ServerResponse, value: unknown, status = 200) => send(response, JSON.stringify(value), status, 'application/json; charset=utf-8');
async function bytesOf(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > maximum) throw Error('Owned editor request too large'); parts.push(part); }
  return Buffer.concat(parts);
}
const bodyOf = async (request: IncomingMessage) => new TextDecoder().decode(await bytesOf(request, 1040 * 1024));
it('serves real full-editor SQL for installed Browser acceptance until the explicit finish control', async () => {
  const root = resolve(import.meta.dirname, '../../../view/admin-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const videoPath = process.env.TEST_PRODUCT_EDITOR_VIDEO_PATH, videoUpload = process.env.TEST_PRODUCT_EDITOR_VIDEO_UPLOAD === '1';
  if (videoUpload) expect(videoPath, 'Upload mode requires a local MP4').toBeTruthy();
  let video: Buffer | undefined;
  if (videoPath) {
    expect(isAbsolute(videoPath)).toBe(true);
    const metadata = await stat(videoPath); expect(metadata.isFile()).toBe(true);
    expect(metadata.size).toBeLessThanOrEqual((videoUpload ? 8 * 1024 : 256) * 1024); video = await readFile(videoPath);
    expect(video.length).toBeGreaterThan(12); expect(video.length).toBeLessThanOrEqual((videoUpload ? 8 * 1024 : 256) * 1024);
    expect(video.subarray(4, 8).toString()).toBe('ftyp');
  }
  const f = await financePostgres([...Object.values(legacySaveSchema), legacyCache, systemAttachmentCategory], { namespace: 'public' });
  const appKey = randomUUID(), password = randomUUID(), control = `/__product_editor_fixture/${randomUUID()}`;
  const cleanupMessages: Array<{ action: string; uploadId: string; delay_seconds?: number }> = [];
  const app = createApp(), env = { APP_KEY: appKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ORDER_QUEUE: {
    sendBatch: async () => {}, send: async (value: unknown, options?: { delaySeconds?: number }) => {
      const message = value as { action: string; uploadId: string };
      expect(Object.keys(message).sort()).toEqual(['action', 'uploadId']); expect(message.action).toBe('cleanupProductVideoUpload');
      expect(message.uploadId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      cleanupMessages.push({ ...message, delay_seconds: options?.delaySeconds });
    },
  } } as unknown as Env;
  // Optional locally generated clip. Metadata/signature/controller/HTTP remain
  // real; the provider boundary is an explicit in-memory R2 stand-in.
  const assetRequests: Array<{ id: number; range: string | null; status: number; bytes: number }> = [];
  const videoKey = 'attachments/admin/1/2026/10/browser-owned.mp4';
  const objects = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  const providerCalls: Array<{ action: 'put' | 'get' | 'delete'; key: string; bytes: number }> = [];
  const checkKey = (key: string) => expect(videoUpload
    ? /^attachments\/(?:admin\/1\/[0-9]{4}\/[0-9]{2}\/[a-f0-9-]{36}\.mp4|tmp\/admin\/1\/[a-f0-9-]{36}\/(?:[1-9]\d?|100)\.part)$/.test(key)
    : key === videoKey).toBe(true);
  if (video) {
    if (!videoUpload) objects.set(videoKey, { bytes: new Uint8Array(video), httpMetadata: { contentType: 'video/mp4' } });
    env.ASSETS_BUCKET = { get: async (key: string, options?: { range?: Headers }) => {
      checkKey(key); const stored = objects.get(key); providerCalls.push({ action: 'get', key, bytes: stored?.bytes.length ?? 0 });
      if (!stored) return null; const bytes = stored.bytes; const range = options?.range?.get('Range');
      let start = 0, end = bytes.length - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || !match[1] && !match[2]) return null;
        if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= bytes.length || end < start) return null;
      }
      return { key, size: bytes.length, body: new Response(bytes.subarray(start, end + 1)).body!, httpEtag: '"owned-generated-clip"',
        httpMetadata: stored.httpMetadata, customMetadata: stored.customMetadata,
        ...(range ? { range: { offset: start, length: end - start + 1 } } : {}),
        writeHttpMetadata(headers: Headers) { headers.set('Content-Type', stored.httpMetadata?.contentType ?? 'application/octet-stream'); } };
    }, put: async (key: string, body: Uint8Array | ReadableStream<Uint8Array>, options?: R2PutOptions) => {
      checkKey(key); expect(videoUpload).toBe(true);
      const bytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(await new Response(body).arrayBuffer());
      if (key.startsWith('attachments/admin/1/')) expect(Buffer.from(bytes).equals(video!)).toBe(true);
      objects.set(key, { bytes, httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined, customMetadata: options?.customMetadata });
      providerCalls.push({ action: 'put', key, bytes: bytes.length }); return { key, size: bytes.length };
    }, delete: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) {
      checkKey(key); providerCalls.push({ action: 'delete', key, bytes: objects.get(key)?.bytes.length ?? 0 }); objects.delete(key);
    } } } as unknown as R2Bucket;
  }
  const paths: Array<{ path: string; method: string; status: number; operation_id?: string; request_bytes?: number; response_bytes?: number }> = [];
  const saves: Array<{ operation_id: string; requested_id: number; source_id?: number; fields: string[]; state: string; result: unknown }> = [];
  const copySources = new Map<number,string>();
  const sourceState = async (id: number) => JSON.stringify({product:await f.db.select().from(storeProduct).where(eq(storeProduct.id,id)),
    skus:await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,id))});
  const committedCreates = new Set<number>(), recovered = new Set<string>(); let dropNext = false, droppedOperation = '', droppedId = 0, dropped = 0, unexpected = 0, outbound = 0;
  let dropNextVideo = false, droppedVideoId = '', droppedVideoResponses = 0;
  const recoveredVideos = new Set<string>();
  const unexpectedPaths: string[] = []; let origin = '', finished = false, fail!: (error: Error) => void, finish!: () => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const token1 = (await createToken(1, 'admin', md5(password), appKey)).token, token2 = (await createToken(2, 'admin', md5(password), appKey)).token;
  const permissions = ['product.view', 'product.manage', 'attachment.view', 'attachment.manage'];
  const roleRules = 'product.manage,attachment.view,attachment.manage';
  const session = (id: number) => ({ userInfo: { id, account: `本机商品验收${id}`, head_pic: '', real_name: '本地合成数据', level: 1, roles: '1' }, menus: [{ id: 1, pid: 0, path: '/product', name: '商品管理', icon: '', sort: 1, type: 1, children: [] }], uniqueAuth: permissions });
  const formSnapshot = [{ id: 'synthetic-message', timestamp: 1, name: 'texts', titleConfig: { value: '合成留言' }, titleShow: { val: true }, value: '' }];
  const candidates = { categories: [{ id: 11, name: '生活' }, { id: 12, name: '家居' }], brands: [{ id: 21, name: '本机品牌一' }, { id: 22, name: '本机品牌二' }], product_labels: [{ id: 31, name: '合成商品标签' }], user_labels: [{ id: 71, name: '合成购买者标签' }], gift_coupons: [{ id: 81, name: '合成赠券' }], system_forms: [{ id: 91, name: '合成留言表单' }], shipping_templates: [{ id: 101, name: '合成运费模板' }], ensures: [{ id: 41, name: '合成保障' }], parameter_templates: [], sku_rule_templates: [{ id: 61, name: '合成颜色', dimensions: [{ value: '颜色', detail: ['红', '蓝'] }] }] };
  const uploadRows = async () => videoUpload ? [...await f.db.execute(sql`SELECT upload_id,actor_id,state,confirmed,attachment_id,object_key,
    intent->>'total_chunks' AS total_chunks,intent->>'total_size' AS total_size FROM public.admin_product_video_upload_v1 ORDER BY upload_id`)] : [];
  const state = async () => ({ fixture: 'owned PG16, actual editor App/JWT/SQL; shell/candidates synthetic',
    ...(video ? { video_fixture: videoUpload ? 'actual App/JWT/PG16 upload, attachment metadata, signatures and Range controller; in-memory R2 bytes, recording-only Queue and Node FixedLengthStream stand-ins'
      : 'locally generated MP4; synthetic R2 bytes', asset_requests: assetRequests } : {}),
    ...(videoUpload ? { video_uploads: await uploadRows(), video_attachments: await f.db.select({ id: systemAttachment.attId, key: systemAttachment.name,
      url: systemAttachment.attDir, size: systemAttachment.attSize }).from(systemAttachment).where(eq(systemAttachment.fileType, 2)),
      provider_calls: providerCalls, provider_objects: [...objects].map(([key, value]) => ({ key, bytes: value.bytes.length })), queue_messages: cleanupMessages,
      dropped_video_responses: droppedVideoResponses, dropped_video_upload_id: droppedVideoId || null, recovered_video_uploads: [...recoveredVideos], armed_drop_next_video: dropNextVideo } : {}),
    products: (await f.db.select({ id: storeProduct.id, name: storeProduct.storeName, categories: storeProduct.cateId, brands: storeProduct.brandCom, labels: storeProduct.labelId, video: storeProduct.videoLink }).from(storeProduct)).sort((a, b) => a.id - b.id), skus: (await f.db.select({ product_id: storeProductAttrValue.productId, unique: storeProductAttrValue.unique, stock: storeProductAttrValue.stock }).from(storeProductAttrValue)).sort((a, b) => a.product_id - b.product_id), save_requests: saves.length, saves, dropped_responses: dropped, dropped_operation: droppedOperation || null, recovered_operations: [...recovered], armed_drop_next: dropNext, route_requests: paths, unexpected_requests: unexpected, unexpected_paths: unexpectedPaths, outbound_requests: outbound, finished });
  const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const controlPage = async () => `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>完整商品编辑器 PG16 联合验收</title><style>body{font:16px/1.7 sans-serif;max-width:1000px;margin:32px auto;padding:0 16px}button{margin:6px;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:16px}</style><h1>完整商品编辑器 PG16 联合验收</h1><p>真实 Admin App、JWT、完整保存/详情/操作回执/草稿 SQL；数据库仅本机新建，候选资料、登录壳与图片为合成夹具，页头通知流在本夹具中停用。未连接生产；此页状态不替代实际界面检查。</p><p>图片地址：<code>/uploads/product-editor-fixture.svg</code>。可选择分类11与12、品牌21与22，填写SKU售价及库存；参数模板候选为空；本夹具不测试依赖模板的参数编辑。留言模板91为合成候选。</p><button id="login1">使用账号1进入新建商品</button><button id="login2">使用账号2进入新建商品</button><button id="logout">清除测试登录</button><p><button data-action="status">刷新SQL状态</button><button data-action="drop-next">下次保存提交后丢弃响应</button>${videoUpload ? '<button data-action="drop-next-video">下次视频提交后丢弃响应</button>' : ''}<button data-action="role-off">撤销商品权限</button><button data-action="role-on">恢复商品权限</button><button data-action="finish">完成验收并关闭服务器</button></p><pre id="state">${escapeHtml(JSON.stringify(await state(), null, 2))}</pre><script>const login=(token,session)=>{localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify(session));location.href='/product/create';};document.getElementById('login1').onclick=()=>login(${JSON.stringify(token1)},${JSON.stringify(session(1))});document.getElementById('login2').onclick=()=>login(${JSON.stringify(token2)},${JSON.stringify(session(2))});document.getElementById('logout').onclick=()=>{localStorage.removeItem('admin_token');localStorage.removeItem('admin_session');document.getElementById('state').textContent='已清除测试登录';};document.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const response=await fetch(${JSON.stringify(control)}+'/'+button.dataset.action,{method:'POST'});document.getElementById('state').textContent=await response.text();}finally{button.disabled=false;}});</script></html>`;
  const server = createServer((request, response) => { void (async () => {
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(origin).host) return send(response, 'Loopback host required', 403, 'text/plain');
    const url = new URL(request.url || '/', origin), path = url.pathname, method = request.method || 'GET';
    if (method === 'GET' && path === control) return send(response, await controlPage());
    if (path.startsWith(control + '/')) {
      const action = path.slice(control.length + 1);
      if (method !== 'POST' || request.headers.origin !== origin || url.search || !['status', 'drop-next', ...(videoUpload ? ['drop-next-video'] : []), 'role-off', 'role-on', 'finish'].includes(action) || (await bodyOf(request)) !== '') return send(response, 'Invalid fixed fixture action', 403, 'text/plain');
      if (action === 'drop-next') { expect(dropNext).toBe(false); dropNext = true; }
      if (action === 'drop-next-video') { expect(dropNextVideo).toBe(false); expect(droppedVideoResponses).toBe(0); dropNextVideo = true; }
      if (action === 'role-off' || action === 'role-on') await f.db.update(systemRole).set({ rules: action === 'role-on' ? roleRules : 'attachment.view,attachment.manage' }).where(eq(systemRole.id, 1));
      if (action === 'finish') {
        expect(saves.length).toBeGreaterThan(0); expect(dropped).toBe(1); expect(recovered.has(droppedOperation)).toBe(true);
        expect(saves.filter(value => value.operation_id === droppedOperation)).toHaveLength(1);
        expect((await f.db.select().from(storeProduct)).length).toBe(committedCreates.size);
        expect((await f.db.select().from(storeProduct)).some(row => row.id === droppedId)).toBe(true);
        expect(saves.every(value => JSON.stringify(value.fields) === JSON.stringify([...ADMIN_LEGACY_PRODUCT_FIELDS].sort()))).toBe(true);
        const copies = saves.filter(value => value.source_id && value.state === 'committed');
        expect(copies).toHaveLength(1);
        const copied = copies[0]!, copiedId = (copied.result as {id:number}).id;
        expect(copiedId).not.toBe(copied.source_id);
        const [sourceProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id,copied.source_id!));
        const [copyProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id,copiedId));
        const [sourceSku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,copied.source_id!));
        const [copySku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,copiedId));
        expect(copySku.unique).not.toBe(sourceSku.unique);
        expect(copySku).toMatchObject({price:sourceSku.price,stock:sourceSku.stock,sales:0});
        expect(copyProduct).toMatchObject({customForm:sourceProduct.customForm,type:sourceProduct.type,relationId:sourceProduct.relationId,sales:0});
        if (videoUpload) {
          expect(committedCreates.size).toBe(2); expect(copied.operation_id).toBe(droppedOperation);
          const rows = await uploadRows(); expect(rows).toHaveLength(1);
          const row = rows[0]!; expect(row).toMatchObject({ actor_id: 1, state: 'committed', confirmed: [1, 2], total_chunks: '2', total_size: String(video!.length) });
          const attachmentId = Number(row.attachment_id), canonical = `/api/assets/${attachmentId}`;
          expect(Number.isSafeInteger(attachmentId) && attachmentId > 0).toBe(true);
          const attachments = await f.db.select().from(systemAttachment).where(eq(systemAttachment.fileType, 2)); expect(attachments).toHaveLength(1);
          expect(attachments[0]).toMatchObject({ attId: attachmentId, type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: 8,
            name: row.object_key, attDir: canonical });
          expect(attachments[0]!.attType.trim()).toBe('video/mp4'); expect(attachments[0]!.attSize.trim()).toBe(String(video!.length));
          expect(Buffer.from(objects.get(String(row.object_key))!.bytes).equals(video!)).toBe(true);
          expect(providerCalls.filter(call => call.action === 'put' && call.key === row.object_key)).toHaveLength(1);
          expect(providerCalls.filter(call => call.action === 'put' && call.key.startsWith('attachments/tmp/admin/1/')).map(call => call.bytes)).toEqual([3 * 1024 * 1024, video!.length - 3 * 1024 * 1024]);
          expect(droppedVideoResponses).toBe(1); expect(droppedVideoId).toBe(row.upload_id); expect(recoveredVideos.has(droppedVideoId)).toBe(true);
          expect(paths.filter(call => call.method === 'POST' && call.path === `/adminapi/file/video_uploads/${row.upload_id}/complete`)).toHaveLength(1);
          expect(cleanupMessages.length).toBeGreaterThan(0); expect(cleanupMessages.every(message => message.uploadId === row.upload_id)).toBe(true);
          expect(sourceProduct).toMatchObject({ videoOpen: 1, videoLink: canonical }); expect(copyProduct).toMatchObject({ videoOpen: 1, videoLink: canonical });
          expect(assetRequests.some(request => request.id === attachmentId && request.range && request.status === 206 && request.bytes > 0)).toBe(true);
        } else if (video) {
          expect(sourceProduct).toMatchObject({ videoOpen: 1, videoLink: '/api/assets/301' });
          expect(copyProduct).toMatchObject({ videoOpen: 1, videoLink: '/api/assets/301' });
          expect(assetRequests.some(row => row.status === 206 && row.bytes > 0)).toBe(true);
        }
        for (const [id, snapshot] of copySources) expect(await sourceState(id)).toBe(snapshot);
        expect(unexpected).toBe(0); expect(outbound).toBe(0); finished = true;
      }
      json(response, await state()); if (finished) finish(); return;
    }
    // The unrelated header notification stream is deliberately unavailable in this editor-only fixture.
    if (method === 'GET' && path === '/adminapi/product/stock/notifications/socket') return json(response, { status: 503, msg: 'Synthetic shell: notification stream not under test', data: null }, 503);
    // Explicit shell/candidate stand-ins only. Every product mutation and its
    // follow-up detail, receipt and draft still crosses the actual App below.
    if (method === 'GET' && path === '/api/get_script') return send(response, '// Synthetic fixture has no analytics script.', 200, 'text/javascript');
    const candidate = method === 'GET' ? path === '/adminapi/product/editor/options' ? candidates
      : path === '/adminapi/file/category' && !(videoUpload && url.searchParams.get('file_type') === '2') ? { list: [] }
      : path === '/adminapi/file/file' && !(videoUpload && url.searchParams.get('file_type') === '2') ? { list: [{ att_id: 1, canonical_url: '/uploads/product-editor-fixture.svg', att_dir: '/uploads/product-editor-fixture.svg', satt_dir: '', att_size: '1 KiB', raw_size: 1024, att_type: 'image/svg+xml', pid: 0, time: '2026-10-15 00:00:00', real_name: '本机商品图片.svg', type: 1, file_type: 1, relation_id: 0, module_type: 1 }], count: 1 }
      : path === '/adminapi/unit' ? { list: [{ id: 1, name: '件' }], count: 1 }
      : path === '/adminapi/product/category/cascader_list/1' ? [{ value: 11, label: '生活', pid: 0, children: [{ value: 12, label: '家居', pid: 11 }] }]
      : path === '/adminapi/product/brand/cascader_list/2' ? [{ value: 21, label: '本机品牌一', pid: 0 }, { value: 22, label: '本机品牌二', pid: 0 }]
      : path === '/api/admin/erp/config' ? { open_erp: false }
      : path === '/adminapi/form/info/91' ? { info: { id: 91, name: '合成留言表单', value: formSnapshot, status: 1, is_del: 0 } }
      : path === '/adminapi/new_push' ? { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now() / 1000) }
      : path === '/api/site_config' ? { site_name: '本机完整商品验收', site_logo: '/logo.png', login_logo: '/logo.png', admin_login_slide: [] }
      : undefined : undefined;
    if (candidate !== undefined) return json(response, { status: 200, msg: 'Synthetic shell/candidate fixture only', data: candidate });
    if (path === '/uploads/product-editor-fixture.svg' && method === 'GET') return send(response, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#e7f1ed"/><circle cx="150" cy="130" r="70" fill="#538a73"/><text x="150" y="245" text-anchor="middle" font-size="24" fill="#244b3b">LOCAL PRODUCT</text></svg>', 200, 'image/svg+xml');
    if (path.startsWith('/adminapi/') || path.startsWith('/api/')) {
      if (video && method === 'GET' && (videoUpload ? /^\/api\/assets\/[1-9]\d*$/.test(path) : path === '/api/assets/301')) {
        const headers = new Headers(); for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
        const result = await app.fetch(new Request(origin + request.url, { headers }), env);
        const bytes = Buffer.from(await result.arrayBuffer());
        assetRequests.push({ id: Number(path.split('/').at(-1)), range: headers.get('Range'), status: result.status, bytes: bytes.length });
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(bytes); return;
      }
      const uploadMatch = videoUpload ? /^\/adminapi\/file\/video_uploads\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:\/(complete|cancel|preview|parts\/(?:[1-9]\d?|100)))?$/.exec(path) : null;
      const uploadAction = uploadMatch?.[2] ?? '', uploadPart = !!uploadMatch && method === 'PUT' && uploadAction.startsWith('parts/');
      const allowedUpload = !!uploadMatch && (method === 'GET' && ['', 'preview'].includes(uploadAction)
        || method === 'POST' && ['', 'complete', 'cancel'].includes(uploadAction) || uploadPart);
      const allowed = allowedUpload
        || videoUpload && method === 'GET' && ['/adminapi/file/category', '/adminapi/file/file'].includes(path) && url.searchParams.get('file_type') === '2'
        || method === 'GET' && /^\/adminapi\/product\/editor\/(?:(?:detail|copy)\/[1-9]\d*|operations\/[a-f0-9-]{36})$/.test(path)
        || method === 'POST' && /^\/adminapi\/product\/editor\/(?:save\/(?:0|[1-9]\d*)|copy\/[1-9]\d*|operations\/[a-f0-9-]{36}\/resolve)$/.test(path)
        || ['GET', 'POST', 'DELETE'].includes(method) && path === '/adminapi/product/cache'
        || method === 'POST' && /^\/adminapi\/product\/generate_attr\/(?:0|[1-9]\d*)\/1$/.test(path);
      if (!allowed) { unexpected++; unexpectedPaths.push(method + ' ' + path); process.stdout.write('PRODUCT_EDITOR_UNEXPECTED ' + method + ' ' + path + '\n'); return json(response, { status: 404, msg: 'Not part of the explicit editor fixture', data: null }, 404); }
      const headers = new Headers(); for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
      const sourceId = method === 'POST' && /\/copy\/[1-9]\d*$/.test(path) ? Number(path.split('/').at(-1)) : undefined;
      if (sourceId && !copySources.has(sourceId)) copySources.set(sourceId,await sourceState(sourceId));
      // Raw PUT bytes never cross a UTF-8 conversion. Modern JSON is bounded
      // separately from the existing full-editor request allowance.
      const rawBody = await bytesOf(request, uploadPart ? 5 * 1024 * 1024 : uploadMatch ? 16 * 1024 : 1040 * 1024);
      const body = uploadPart ? '' : new TextDecoder().decode(rawBody), requestBody = uploadPart ? new Uint8Array(rawBody).buffer : body;
      const result = await app.fetch(new Request(origin + request.url, { method, headers, ...(rawBody.length ? { body: requestBody } : {}) }), env);
      const text = await result.text(), envelope = JSON.parse(text);
      paths.push({ path, method, status: Number(envelope.status), request_bytes: rawBody.length, response_bytes: Buffer.byteLength(text) });
      if (uploadMatch && method === 'POST' && uploadAction === 'complete' && envelope.status === 200 && envelope.data?.state === 'committed') {
        expect(envelope.data.upload_id).toBe(uploadMatch[1]);
        if (dropNextVideo) {
          dropNextVideo = false; droppedVideoResponses++; droppedVideoId = uploadMatch[1];
          json(response, { status: 502, msg: 'Synthetic gateway lost the committed video receipt', data: null }, 502); return;
        }
      }
      if (uploadMatch && method === 'GET' && !uploadAction && envelope.data?.state === 'committed' && uploadMatch[1] === droppedVideoId) {
        expect(envelope.data.upload_id).toBe(droppedVideoId); recoveredVideos.add(droppedVideoId);
      }
      if (/\/save\//.test(path) || sourceId) {
        const input = JSON.parse(body), data = envelope.data;
        saves.push({ operation_id: input.operation_id, requested_id: sourceId ? 0 : Number(path.split('/').at(-1)), ...(sourceId ? {source_id:sourceId} : {}), fields: Object.keys(input.product).sort(), state: data?.state || `rejected:${envelope.status}`, result: data?.result || null });
        paths.at(-1)!.operation_id = input.operation_id;
        if (data?.state === 'committed' && data.result?.created === true) committedCreates.add(data.result.id);
        if (dropNext && envelope.status === 200 && data?.state === 'committed') { dropNext = false; dropped++; droppedOperation = input.operation_id; droppedId = data.result.id; json(response, { status: 502, msg: 'Synthetic gateway lost the committed receipt', data: null }, 502); return; }
      }
      if (path.includes('/operations/') && envelope.data?.state === 'committed') recovered.add(envelope.data.operation_id);
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(text); return;
    }
    const copyEntry = ['/product/create','/admin/product/add_product'].includes(path)
      && url.searchParams.size === 1 && /^[1-9]\d*$/.test(url.searchParams.get('copy') || '');
    if (method !== 'GET' || url.search && !copyEntry) return send(response, 'Static GET only', 404, 'text/plain');
    let file = resolve(root, '.' + decodeURIComponent(path)); if (file !== root && !file.startsWith(root + sep)) return send(response, 'Invalid static path', 403, 'text/plain');
    if (file === root || !extname(file)) file = resolve(root, 'index.html');
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    try { send(response, await readFile(file), 200, types[extname(file)] || 'application/octet-stream'); } catch { send(response, 'Static artifact not found', 404, 'text/plain'); }
  })().catch(error => { const message = error instanceof Error ? error.message : String(error); process.stdout.write(`PRODUCT_EDITOR_BROWSER_BRIDGE_ERROR ${message}\n`); if (!response.headersSent) json(response, { status: 500, msg: message }, 500); else response.end(); fail(error instanceof Error ? error : Error(message)); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('External I/O forbidden in editor Browser fixture'); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.exec(PRODUCT_EDITOR_OPERATION_SQL); await f.db.transaction(tx => assertProductEditorOperationReady(tx));
    if (videoUpload) {
      // Node has no Cloudflare FixedLengthStream. Only this explicit provider
      // boundary is replaced; App/JWT, authority, SQL and controllers are real.
      vi.stubGlobal('FixedLengthStream', OwnedFixedLengthStream);
      await f.exec(PRODUCT_VIDEO_UPLOAD_SQL); await f.db.transaction(tx => assertProductVideoUploadReady(tx));
    }
    await f.db.insert(systemRole).values({ id: 1, roleName: 'Owned editor fixture', rules: roleRules });
    await f.db.insert(systemAdmin).values([1, 2].map(id => ({ id, account: `owned-product-editor-${id}`, pwd: password, roles: '1', level: 1 })));
    await f.db.insert(systemConfig).values([{ menuName: 'store_stock', value: '2' }, { menuName: 'erp_open', value: '0' }]);
    if (video && !videoUpload) await f.db.insert(systemAttachment).values({ attId: 301, type: 1, relationId: 0, moduleType: 1, fileType: 2,
      imageType: 8, name: videoKey, attDir: '/api/assets/301', attType: 'video/mp4', attSize: String(video.length) });
    await f.db.insert(storeProductCategory).values([{ id: 11, cateName: '生活' }, { id: 12, pid: 11, path: '11', level: 1, cateName: '家居' }]);
    await f.db.insert(storeBrand).values([{ id: 21, brandName: '本机品牌一' }, { id: 22, brandName: '本机品牌二' }]);
    await f.db.insert(storeProductLabel).values({ id: 31, labelName: '合成商品标签' }); await f.db.insert(storeProductEnsure).values({ id: 41, name: '合成保障' });
    await f.db.insert(userLabel).values({ id: 71, name: '合成购买者标签' }); await f.db.insert(storeCouponIssue).values({ id: 81, title: '合成赠券' });
    await f.db.insert(systemForm).values({ id: 91, name: '合成留言表单', status: 1, value: JSON.stringify(formSnapshot) });
    await f.db.insert(shippingTemplates).values({ id: 101, name: '合成运费模板' });
    wiring.container = createContainerFromDb(f.db);
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing editor Browser loopback port'); origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write(`PRODUCT_EDITOR_BROWSER_READY ${JSON.stringify({ control: origin + control, editor: origin + '/product/create', actual: ['App', 'JWT', 'detail', 'save', 'operations', 'draft', 'PostgreSQL16', ...(videoUpload ? ['video upload', 'attachment metadata', 'asset signatures', 'Range controller'] : [])],
      synthetic: ['shell', 'metadata candidates', 'picture', ...(video ? ['in-memory R2 bytes'] : []), ...(videoUpload ? ['recording-only Queue', 'Node FixedLengthStream'] : [])],
      video_upload: videoUpload, ...(video ? { video_bytes: video.length } : {}), fixtureOnly: true })}\n`);
    deadline = setTimeout(() => fail(Error('Explicit editor Browser finish was not received within 18 minutes')), 18 * 60_000);
    await completion; expect(finished).toBe(true); process.stdout.write(`PRODUCT_EDITOR_BROWSER_RESULT ${JSON.stringify(await state())}\n`);
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); if (videoUpload) vi.unstubAllGlobals(); wiring.container = undefined;
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close();
  }
}, 19 * 60_000);
