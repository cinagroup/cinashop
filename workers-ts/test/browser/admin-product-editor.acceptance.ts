/** Explicit opt-in Browser-plugin host. Actual editor save/detail/receipt/draft
 * routes use the App, JWT authority and a newly owned disposable PostgreSQL16
 * database. The navigation shell and bounded metadata candidates are synthetic.
 * This host launches no browser and claims no unobserved rendered assertions. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { legacyCache, storeProduct, storeProductAttrValue, storeProductCategory, storeBrand, storeProductLabel, storeProductEnsure,
  userLabel, storeCouponIssue, systemForm, shippingTemplates, systemAdmin, systemRole, systemConfig } from '@/models/schema';
import { PRODUCT_EDITOR_OPERATION_SQL, assertProductEditorOperationReady } from '@/migrations/adminProductEditorOperation';
import { ADMIN_LEGACY_PRODUCT_FIELDS } from '@/services/admin/AdminLegacyProductInput';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from '../helpers/financePostgres';
import { legacySaveSchema } from '../helpers/adminLegacyProductSave';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned editor fixture'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned editor fixture'); return { container: wiring.container, close: async () => {} }; } }));
function send(response: ServerResponse, value: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(value);
}
const json = (response: ServerResponse, value: unknown, status = 200) => send(response, JSON.stringify(value), status, 'application/json; charset=utf-8');
async function bodyOf(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > 1040 * 1024) throw Error('Owned editor request too large'); parts.push(part); }
  return Buffer.concat(parts).toString('utf8');
}
it('serves real full-editor SQL for installed Browser acceptance until the explicit finish control', async () => {
  const root = resolve(import.meta.dirname, '../../../view/admin-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await financePostgres([...Object.values(legacySaveSchema), legacyCache], { namespace: 'public' });
  const appKey = randomUUID(), password = randomUUID(), control = `/__product_editor_fixture/${randomUUID()}`;
  const app = createApp(), env = { APP_KEY: appKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ORDER_QUEUE: { sendBatch: async () => {} } } as unknown as Env;
  const paths: Array<{ path: string; method: string; status: number; operation_id?: string }> = [];
  const saves: Array<{ operation_id: string; requested_id: number; fields: string[]; state: string; result: unknown }> = [];
  const committedCreates = new Set<number>(), recovered = new Set<string>(); let dropNext = false, droppedOperation = '', droppedId = 0, dropped = 0, unexpected = 0, outbound = 0;
  const unexpectedPaths: string[] = []; let origin = '', finished = false, fail!: (error: Error) => void, finish!: () => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const token1 = (await createToken(1, 'admin', md5(password), appKey)).token, token2 = (await createToken(2, 'admin', md5(password), appKey)).token;
  const permissions = ['product.view', 'product.manage'];
  const session = (id: number) => ({ userInfo: { id, account: `本机商品验收${id}`, head_pic: '', real_name: '本地合成数据', level: 1, roles: '1' }, menus: [{ id: 1, pid: 0, path: '/product', name: '商品管理', icon: '', sort: 1, type: 1, children: [] }], uniqueAuth: permissions });
  const formSnapshot = [{ id: 'synthetic-message', timestamp: 1, name: 'texts', titleConfig: { value: '合成留言' }, titleShow: { val: true }, value: '' }];
  const candidates = { categories: [{ id: 11, name: '生活' }, { id: 12, name: '家居' }], brands: [{ id: 21, name: '本机品牌一' }, { id: 22, name: '本机品牌二' }], product_labels: [{ id: 31, name: '合成商品标签' }], user_labels: [{ id: 71, name: '合成购买者标签' }], gift_coupons: [{ id: 81, name: '合成赠券' }], system_forms: [{ id: 91, name: '合成留言表单' }], shipping_templates: [{ id: 101, name: '合成运费模板' }], ensures: [{ id: 41, name: '合成保障' }], parameter_templates: [], sku_rule_templates: [{ id: 61, name: '合成颜色', dimensions: [{ value: '颜色', detail: ['红', '蓝'] }] }] };
  const state = async () => ({ fixture: 'owned PG16, actual editor App/JWT/SQL; shell/candidates synthetic', products: (await f.db.select({ id: storeProduct.id, name: storeProduct.storeName, categories: storeProduct.cateId, brands: storeProduct.brandCom, labels: storeProduct.labelId }).from(storeProduct)).sort((a, b) => a.id - b.id), skus: (await f.db.select({ product_id: storeProductAttrValue.productId, unique: storeProductAttrValue.unique, stock: storeProductAttrValue.stock }).from(storeProductAttrValue)).sort((a, b) => a.product_id - b.product_id), save_requests: saves.length, saves, dropped_responses: dropped, dropped_operation: droppedOperation || null, recovered_operations: [...recovered], armed_drop_next: dropNext, route_requests: paths, unexpected_requests: unexpected, unexpected_paths: unexpectedPaths, outbound_requests: outbound, finished });
  const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const controlPage = async () => `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>完整商品编辑器 PG16 联合验收</title><style>body{font:16px/1.7 sans-serif;max-width:1000px;margin:32px auto;padding:0 16px}button{margin:6px;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:16px}</style><h1>完整商品编辑器 PG16 联合验收</h1><p>真实 Admin App、JWT、完整保存/详情/操作回执/草稿 SQL；数据库仅本机新建，候选资料、登录壳与图片为合成夹具，页头通知流在本夹具中停用。未连接生产；此页状态不替代实际界面检查。</p><p>图片地址：<code>/uploads/product-editor-fixture.svg</code>。可选择分类11与12、品牌21与22，填写SKU售价及库存；参数模板候选为空；本夹具不测试依赖模板的参数编辑。留言模板91为合成候选。</p><button id="login1">使用账号1进入新建商品</button><button id="login2">使用账号2进入新建商品</button><button id="logout">清除测试登录</button><p><button data-action="status">刷新SQL状态</button><button data-action="drop-next">下次保存提交后丢弃响应</button><button data-action="role-off">撤销商品权限</button><button data-action="role-on">恢复商品权限</button><button data-action="finish">完成验收并关闭服务器</button></p><pre id="state">${escapeHtml(JSON.stringify(await state(), null, 2))}</pre><script>const login=(token,session)=>{localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify(session));location.href='/product/create';};document.getElementById('login1').onclick=()=>login(${JSON.stringify(token1)},${JSON.stringify(session(1))});document.getElementById('login2').onclick=()=>login(${JSON.stringify(token2)},${JSON.stringify(session(2))});document.getElementById('logout').onclick=()=>{localStorage.removeItem('admin_token');localStorage.removeItem('admin_session');document.getElementById('state').textContent='已清除测试登录';};document.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const response=await fetch(${JSON.stringify(control)}+'/'+button.dataset.action,{method:'POST'});document.getElementById('state').textContent=await response.text();}finally{button.disabled=false;}});</script></html>`;
  const server = createServer((request, response) => { void (async () => {
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(origin).host) return send(response, 'Loopback host required', 403, 'text/plain');
    const url = new URL(request.url || '/', origin), path = url.pathname, method = request.method || 'GET';
    if (method === 'GET' && path === control) return send(response, await controlPage());
    if (path.startsWith(control + '/')) {
      const action = path.slice(control.length + 1);
      if (method !== 'POST' || request.headers.origin !== origin || url.search || !['status', 'drop-next', 'role-off', 'role-on', 'finish'].includes(action) || (await bodyOf(request)) !== '') return send(response, 'Invalid fixed fixture action', 403, 'text/plain');
      if (action === 'drop-next') { expect(dropNext).toBe(false); dropNext = true; }
      if (action === 'role-off' || action === 'role-on') await f.db.update(systemRole).set({ rules: action === 'role-on' ? 'product.manage' : '' }).where(eq(systemRole.id, 1));
      if (action === 'finish') {
        expect(saves.length).toBeGreaterThan(0); expect(dropped).toBe(1); expect(recovered.has(droppedOperation)).toBe(true);
        expect(saves.filter(value => value.operation_id === droppedOperation)).toHaveLength(1);
        expect((await f.db.select().from(storeProduct)).length).toBe(committedCreates.size);
        expect((await f.db.select().from(storeProduct)).some(row => row.id === droppedId)).toBe(true);
        expect(saves.every(value => JSON.stringify(value.fields) === JSON.stringify([...ADMIN_LEGACY_PRODUCT_FIELDS].sort()))).toBe(true);
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
      : path === '/adminapi/file/category' ? { list: [] }
      : path === '/adminapi/file/file' ? { list: [{ att_id: 1, canonical_url: '/uploads/product-editor-fixture.svg', att_dir: '/uploads/product-editor-fixture.svg', satt_dir: '', att_size: '1 KiB', raw_size: 1024, att_type: 'image/svg+xml', pid: 0, time: '2026-10-15 00:00:00', real_name: '本机商品图片.svg', type: 1, file_type: 1, relation_id: 0, module_type: 1 }], count: 1 }
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
      const allowed = method === 'GET' && /^\/adminapi\/product\/editor\/(?:detail\/[1-9]\d*|operations\/[a-f0-9-]{36})$/.test(path)
        || method === 'POST' && /^\/adminapi\/product\/editor\/(?:save\/(?:0|[1-9]\d*)|operations\/[a-f0-9-]{36}\/resolve)$/.test(path)
        || ['GET', 'POST', 'DELETE'].includes(method) && path === '/adminapi/product/cache'
        || method === 'POST' && /^\/adminapi\/product\/generate_attr\/(?:0|[1-9]\d*)\/1$/.test(path);
      if (!allowed) { unexpected++; unexpectedPaths.push(method + ' ' + path); process.stdout.write('PRODUCT_EDITOR_UNEXPECTED ' + method + ' ' + path + '\n'); return json(response, { status: 404, msg: 'Not part of the explicit editor fixture', data: null }, 404); }
      const headers = new Headers(); for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
      const body = await bodyOf(request), result = await app.fetch(new Request(origin + request.url, { method, headers, ...(body ? { body } : {}) }), env);
      const text = await result.text(), envelope = JSON.parse(text); paths.push({ path, method, status: Number(envelope.status) });
      if (/\/save\//.test(path)) {
        const input = JSON.parse(body), data = envelope.data;
        saves.push({ operation_id: input.operation_id, requested_id: Number(path.split('/').at(-1)), fields: Object.keys(input.product).sort(), state: data?.state || `rejected:${envelope.status}`, result: data?.result || null });
        paths.at(-1)!.operation_id = input.operation_id;
        if (data?.state === 'committed' && data.result?.created === true) committedCreates.add(data.result.id);
        if (dropNext && envelope.status === 200 && data?.state === 'committed') { dropNext = false; dropped++; droppedOperation = input.operation_id; droppedId = data.result.id; json(response, { status: 502, msg: 'Synthetic gateway lost the committed receipt', data: null }, 502); return; }
      }
      if (path.includes('/operations/') && envelope.data?.state === 'committed') recovered.add(envelope.data.operation_id);
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(text); return;
    }
    if (method !== 'GET' || url.search) return send(response, 'Static GET only', 404, 'text/plain');
    let file = resolve(root, '.' + decodeURIComponent(path)); if (file !== root && !file.startsWith(root + sep)) return send(response, 'Invalid static path', 403, 'text/plain');
    if (file === root || !extname(file)) file = resolve(root, 'index.html');
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    try { send(response, await readFile(file), 200, types[extname(file)] || 'application/octet-stream'); } catch { send(response, 'Static artifact not found', 404, 'text/plain'); }
  })().catch(error => { const message = error instanceof Error ? error.message : String(error); process.stdout.write(`PRODUCT_EDITOR_BROWSER_BRIDGE_ERROR ${message}\n`); if (!response.headersSent) json(response, { status: 500, msg: message }, 500); else response.end(); fail(error instanceof Error ? error : Error(message)); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('External I/O forbidden in editor Browser fixture'); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.exec(PRODUCT_EDITOR_OPERATION_SQL); await f.db.transaction(tx => assertProductEditorOperationReady(tx));
    await f.db.insert(systemRole).values({ id: 1, roleName: 'Owned editor fixture', rules: 'product.manage' });
    await f.db.insert(systemAdmin).values([1, 2].map(id => ({ id, account: `owned-product-editor-${id}`, pwd: password, roles: '1', level: 1 })));
    await f.db.insert(systemConfig).values([{ menuName: 'store_stock', value: '2' }, { menuName: 'erp_open', value: '0' }]);
    await f.db.insert(storeProductCategory).values([{ id: 11, cateName: '生活' }, { id: 12, pid: 11, path: '11', level: 1, cateName: '家居' }]);
    await f.db.insert(storeBrand).values([{ id: 21, brandName: '本机品牌一' }, { id: 22, brandName: '本机品牌二' }]);
    await f.db.insert(storeProductLabel).values({ id: 31, labelName: '合成商品标签' }); await f.db.insert(storeProductEnsure).values({ id: 41, name: '合成保障' });
    await f.db.insert(userLabel).values({ id: 71, name: '合成购买者标签' }); await f.db.insert(storeCouponIssue).values({ id: 81, title: '合成赠券' });
    await f.db.insert(systemForm).values({ id: 91, name: '合成留言表单', status: 1, value: JSON.stringify(formSnapshot) });
    await f.db.insert(shippingTemplates).values({ id: 101, name: '合成运费模板' });
    wiring.container = createContainerFromDb(f.db);
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing editor Browser loopback port'); origin = `http://127.0.0.1:${address.port}`;
    process.stdout.write(`PRODUCT_EDITOR_BROWSER_READY ${JSON.stringify({ control: origin + control, editor: origin + '/product/create', actual: ['App', 'JWT', 'detail', 'save', 'operations', 'draft', 'PostgreSQL16'], synthetic: ['shell', 'metadata candidates', 'picture'], fixtureOnly: true })}\n`);
    deadline = setTimeout(() => fail(Error('Explicit editor Browser finish was not received within 18 minutes')), 18 * 60_000);
    await completion; expect(finished).toBe(true); process.stdout.write(`PRODUCT_EDITOR_BROWSER_RESULT ${JSON.stringify(await state())}\n`);
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close();
  }
}, 19 * 60_000);
