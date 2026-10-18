/** Production Supplier/H5 bundles, actual App/JWT and one owned PG16 database.
 * Directory/catalog GETs are SQL read-only. Real detail GETs retain and strictly
 * account for the mature anonymous visit analytics, awaited via executionCtx. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import { storeProduct, storeProductRule, systemAttachmentCategory, systemRole, storeProductCategory, storeDiscounts } from '@/models/schema';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { supplierProductUnitsFixture, supplierUnitExpectedDirectory } from '../helpers/supplierProductUnits';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, moderator: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned unit Browser LOGIN'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.moderator) throw Error('Missing owned unit Browser reviewer'); return { container: wiring.moderator, close: async () => {} }; },
}));
type Row = Record<string, any>;
type StateRows = Record<string, Array<{ row: Row }>>;
type Held = { phase: 'route' | 'session'; index: number; deliver: () => void; destroyed: () => boolean };

it('selects directory units preserves drafts on failed empty and cancelled reads and publishes text through real Supplier saves Admin review H5 catalog and ordinary detail with scoped analytics', async () => {
  const supplierRoot = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'), catalogRoot = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5');
  expect((await stat(resolve(supplierRoot, 'index.html'))).isFile()).toBe(true); expect((await stat(resolve(catalogRoot, 'index.html'))).isFile()).toBe(true);
  const f = await supplierProductUnitsFixture(), app = createApp(), dialect = new PgDialect(), extras = [storeProductRule, systemAttachmentCategory, storeDiscounts];
  const control = '/__supplier_product_unit_fixture/' + randomUUID();
  for (const table of extras) {
    const definition = getTableConfig(table), columns = definition.columns.map(column => {
      const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
    }); await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
  }
  await f.db.update(storeProduct).set({ unitName: '历史自由单位' }).where(eq(storeProduct.id, 80));
  await f.db.insert(storeProductCategory).values({ id: 100, type: 0, relationId: 0, level: 0, pid: 0, path: '', cateName: '本机平台分类' });
  await f.db.update(systemRole).set({ rules: 'supplier.product.view,supplier.product.manage,supplier.attachment.view' }).where(eq(systemRole.id, 21));
  // SQL explicitly projects AS row. This annotation models that projection;
  // it adds no runtime schema validation or new snapshot evidence.
  const snapshot = async (): Promise<StateRows> => { const state = { ...await f.snapshot() }; for (const table of extras) { const name = getTableConfig(table).name; state[name] = await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`) as unknown as StateRows[string]; } return state; };
  const baseline = await snapshot(), initialSequences = await f.sequences(), product = (state: StateRows) => state.store_product.find(item => item.row.id === 80)!.row;
  const paths: Row[] = [], actions: Row[] = [], checkpoints: Row[] = [], held: Held[] = [], releaseAttempts: Row[] = [], catalogEvidence: Row[] = [], listEvidence: Row[] = [], detailEvidence: Row[] = [], unitEvidence: Row[] = [], invalidatedEvidence: Row[] = [], analyticsEvidence: Row[] = [];
  const savedStates: StateRows[] = [], classifiedStates: StateRows[] = [], approvedStates: StateRows[] = [];
  let supplierOrigin = '', catalogOrigin = '', chain = Promise.resolve(), finished = false, armHold = false, heldCount = 0, sessionChanges = 0, outbound = 0, saves = 0, approvals = 0, classifications = 0;
  let directoryMode: 'normal' | 'error' | 'empty' = 'normal', writer: Container, reader: Container;
  let analyticsRows = { store_product_log: baseline.store_product_log, store_visit: baseline.store_visit };
  let finish!: () => void, fail!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const roles: Row = {}, env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async (key: string) => ({ cfg_system_statistics: '', cfg_navigation_open: '0', cfg_product_category_level: '2', cfg_product_video_status: '0' } as Record<string, string>)[key] ?? null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const currentUnit = () => saves === 0 ? '历史自由单位' : saves === 1 ? '箱' : '件';
  const state = () => ({ finished, saves, approvals, classifications, directoryMode, heldCount, sessionChanges, checkpoints, unitEvidence, catalogEvidence, listEvidence, detailEvidence, invalidatedEvidence, analyticsEvidence, releaseAttempts, actions, paths, roles, outbound,
    tables: Object.keys(baseline).length, sequences: initialSequences.length, phone_viewport: { width: 390, height: 844, mechanism: 'same-origin iframe viewport; no CDP/device emulation' }, customer_checkout_in_browser: false, detail_get_analytics_writes_preserved: true });
  async function serial<T>(work: () => Promise<T>) { const before = chain; let release!: () => void; chain = new Promise<void>(done => { release = done; }); await before; try { return await work(); } finally { release(); } }
  function assertBusiness(actual: StateRows, reviewed: boolean, classified: boolean) {
    expect(product(actual)).toEqual({ ...product(baseline), unit_name: currentUnit(), is_show: reviewed ? 1 : 0, is_verify: reviewed ? 1 : 0, cate_id: classified ? '100' : '11', ...(approvals ? { auto_on_time: 0, refusal: '' } : {}) });
    const authored = new Set(['store_product', 'store_product_attr', 'store_product_attr_result', 'store_product_relation', 'system_log', 'store_product_log', 'store_visit']);
    for (const name of Object.keys(baseline)) if (!authored.has(name)) expect(actual[name], name).toEqual(baseline[name]);
    for (const name of ['store_product_log', 'store_visit'] as const) expect(actual[name], name).toEqual(analyticsRows[name]);
    expect(actual.store_product.filter(item => item.row.id !== 80)).toEqual(baseline.store_product.filter(item => item.row.id !== 80));
    for (const name of ['store_product_attr', 'store_product_attr_result', 'store_product_relation']) expect(actual[name].filter(item => item.row.product_id !== 80), name).toEqual(baseline[name].filter(item => item.row.product_id !== 80));
    const dimensions = (rows: StateRows) => rows.store_product_attr.filter(item => item.row.product_id === 80).map(item => { const { id, ...row } = item.row; return row; }).sort((a, b) => a.attr_name.localeCompare(b.attr_name));
    expect(dimensions(actual)).toEqual(dimensions(baseline));
    const original = baseline.store_product_attr_result.filter(item => item.row.product_id === 80), result = actual.store_product_attr_result.filter(item => item.row.product_id === 80);
    expect(original).toHaveLength(1); expect(result).toHaveLength(1); expect(result[0].row.type).toBe(original[0].row.type);
    const oldSnapshot = JSON.parse(original[0].row.result), newSnapshot = JSON.parse(result[0].row.result);
    expect(newSnapshot.attr).toEqual(oldSnapshot.attr); expect(newSnapshot.value).toEqual(oldSnapshot.value.map((entry: Row) => { const { id, ...row } = entry; return row; })); expect(result[0].row.change_time).toBeGreaterThanOrEqual(original[0].row.change_time);
    expect(actual.store_product_relation.filter(item => item.row.product_id === 80 && item.row.type !== 1)).toEqual(baseline.store_product_relation.filter(item => item.row.product_id === 80 && item.row.type !== 1));
    const categories = actual.store_product_relation.filter(item => item.row.product_id === 80 && item.row.type === 1); expect(categories).toHaveLength(1); expect(categories[0].row).toMatchObject({ product_id: 80, type: 1, relation_id: classified ? 100 : 11, relation_pid: 0, status: 0 });
    const oldIds = new Set(baseline.system_log.map(item => item.row.id)), fresh = actual.system_log.filter(item => !oldIds.has(item.row.id)); expect(actual.system_log.filter(item => oldIds.has(item.row.id))).toEqual(baseline.system_log);
    expect(fresh).toHaveLength(approvals + classifications); expect(fresh.every(item => item.row.admin_id === 101 && ['product_moderation', 'product'].includes(item.row.type))).toBe(true);
    expect(fresh.filter(item => item.row.type === 'product')).toHaveLength(classifications); expect(fresh.filter(item => item.row.type === 'product_moderation')).toHaveLength(approvals);
  }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  async function jsonBody(req: IncomingMessage): Promise<Row> { const chunks: Buffer[] = []; let total = 0; for await (const part of req) { const chunk = Buffer.from(part); total += chunk.length; expect(total).toBeLessThan(1024 * 1024); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString()); }
  async function dispatchApp(path: string, search: string, method: string, input: Row | undefined, authorization: string | undefined, surface: 'supplier' | 'catalog' | 'admin') {
    wiring.container = surface === 'supplier' ? writer : reader;
    const pending: Promise<unknown>[] = [], ctx: NonNullable<Parameters<typeof app.request>[3]> = { waitUntil: task => { pending.push(task); }, passThroughOnException() {}, props: {} };
    const response = await app.request(path + search, { method, headers: { ...(authorization ? { Authorization: authorization } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }, env, ctx);
    const bytes = Buffer.from(await response.arrayBuffer()), headers = Object.fromEntries(response.headers), envelope = path === '/api/get_script' ? undefined : JSON.parse(bytes.toString()); await Promise.all(pending);
    expect(response.status, method + ' ' + path).toBe(200); if (envelope) expect(envelope.status, envelope.msg).toBe(200);
    return { bytes, headers, envelope, entry: { path, search, method, status: response.status, surface, saves, approvals, classifications, wait_until_tasks: pending.length, ...(input ? { body: input } : {}) } as Row };
  }
  async function pendingVisibility(operation: 'before_platform_classification' | 'before_admin_review') { const before = await snapshot(), seq = await f.sequences(), result = await dispatchApp('/api/products', '?ids=80', 'GET', undefined, undefined, 'catalog'); expect(result.envelope.data.list).toEqual([]); expect(await snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); paths.push({ ...result.entry, operation, products: [], sql_read_only: true }); }
  function assertAnalytics(before: StateRows, after: StateRows) {
    for (const name of Object.keys(before)) if (!['store_product_log', 'store_visit'].includes(name)) expect(after[name], name).toEqual(before[name]);
    const oldLogIds = new Set(before.store_product_log.map(item => item.row.id)), fresh = after.store_product_log.filter(item => !oldLogIds.has(item.row.id)); expect(fresh).toHaveLength(1); expect(after.store_product_log.filter(item => oldLogIds.has(item.row.id))).toEqual(before.store_product_log);
    const log = fresh[0].row; expect(log).toEqual({ id: log.id, type: 'visit', product_id: 80, uid: 0, visit_num: 1, cart_num: 0, order_num: 0, pay_num: 0, pay_price: 0, cost_price: 0, pay_uid: 0, refund_num: 0, refund_price: 0, collect_num: 0, add_time: log.add_time, delete_time: null });
    expect(Number.isSafeInteger(log.add_time)).toBe(true); expect(Math.abs(log.add_time - Math.floor(Date.now() / 1000))).toBeLessThan(10); expect(after.store_visit).toHaveLength(1);
    const visit = after.store_visit[0].row, prior = before.store_visit[0]?.row; expect(visit.type.trimEnd()).toBe('view'); expect(visit).toMatchObject({ product_id: 80, uid: 0, product_type: 'product', cate_id: 80, content: '' });
    if (!prior) { expect(visit.count).toBe(1); expect(visit.add_time).toBe(log.add_time); }
    else if (prior.add_time + 20 < log.add_time) expect(visit).toEqual({ ...prior, count: prior.count + 1, cate_id: 80, add_time: log.add_time });
    else expect(visit).toEqual(prior);
    analyticsRows = { store_product_log: after.store_product_log, store_visit: after.store_visit }; analyticsEvidence.push({ saves, uid: 0, product_id: 80, legacy_cate_id: 80, log_id: log.id, visit_count: visit.count, business_unchanged: true });
  }
  const supplierReads = new Set(['/api/get_script', '/supplierapi/product/category/tree', '/supplierapi/product/product/get_rule', '/supplierapi/product/product_label', '/supplierapi/product/product/list', '/supplierapi/product/product/80', '/supplierapi/product/brand/cascader_list/2', '/supplierapi/product/all_ensure', '/supplierapi/product/all_specs', '/supplierapi/form/all_system_form', '/supplierapi/form/info/71', '/supplierapi/product/get_all_unit']);
  const catalogReads = new Set(['/api/store_discounts/list/80', '/api/get_script', '/api/category', '/api/products', '/api/product/detail/80', '/api/v2/diy/color_change/color_change', '/api/v2/diy/product_detail', '/api/diy/get_suspended']);
  async function api(req: IncomingMessage, res: ServerResponse, url: URL, surface: 'supplier' | 'catalog') {
    const path = url.pathname, method = req.method ?? 'GET'; expect(method === 'GET' || surface === 'supplier' && method === 'POST' && path === '/supplierapi/product/product/80').toBe(true); expect(surface === 'supplier' ? supplierReads.has(path) : catalogReads.has(path), surface + ' ' + method + ' ' + path).toBe(true);
    if (surface === 'catalog' && path === '/api/products') { expect(url.searchParams.getAll('cid')).toEqual(['100']); for (const key of ['sid', 'tid', 'ids']) expect(url.searchParams.has(key), key).toBe(false); }
    let delivery!: () => void;
    await serial(async () => {
      const before = await snapshot(), seq = await f.sequences(), input = method === 'POST' ? await jsonBody(req) : undefined, mode = directoryMode;
      const result = await dispatchApp(path, url.search, method, input, req.headers.authorization, surface);
      if (method === 'GET') {
        const after = await snapshot(), nextSequences = await f.sequences();
        if (path === '/api/product/detail/80') {
          expect(result.entry.wait_until_tasks).toBe(1); expect(approvals).toBe(saves); expect(saves).toBeGreaterThan(0); expect(result.envelope.data.unit_name).toBe(currentUnit()); expect(result.envelope.data.attr_value.map((row: Row) => ({ suk: row.suk, stock: row.stock }))).toEqual([{ suk: '红,S', stock: 3 }, { suk: '红,M', stock: 5 }, { suk: '蓝,S', stock: 7 }, { suk: '蓝,M', stock: 9 }]);
          assertAnalytics(before, after); const allowed = new Set(['store_product_log_id_seq', 'store_visit_id_seq']); expect(nextSequences.filter(row => !allowed.has(row.name))).toEqual(seq.filter(row => !allowed.has(row.name))); result.entry.analytics_write = true;
        } else { expect(after).toEqual(before); expect(nextSequences).toEqual(seq); result.entry.sql_read_only = true; }
        if (path === '/api/store_discounts/list/80') expect(result.envelope.data).toEqual([]);
        if (path === '/supplierapi/product/product/80') { expect(result.envelope.data.unit_name).toBe(currentUnit()); expect(result.envelope.data.attrs.map((row: Row) => row.id)).toEqual([8001, 8002, 8003, 8004]); expect(result.envelope.data.retired_attrs).toHaveLength(1); expect(result.envelope.data).not.toHaveProperty('custom_form'); expect(result.bytes.toString()).not.toContain('UNCHANGED-CUSTOMER-ANSWER'); }
        if (path === '/api/products') { const list = result.envelope.data.list; result.entry.products = list; if (approvals === saves && saves > 0 && classifications === saves) { expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ id: 80, unit_name: currentUnit(), stock: product(baseline).stock, sales: product(baseline).sales + product(baseline).ficti }); } else expect(list).toEqual([]); }
        if (path === '/supplierapi/product/get_all_unit') {
          expect(result.envelope.data).toEqual(supplierUnitExpectedDirectory); result.entry.directory_mode = mode;
          if (mode === 'error') { result.entry.injected_http_status = 503; delivery = () => send(res, JSON.stringify({ status: 503, msg: 'Owned unit directory transport fault', data: null }), 503, 'application/json'); }
          else if (mode === 'empty') { result.entry.injected_empty_directory = true; delivery = () => send(res, JSON.stringify({ status: 200, msg: 'ok', data: [] }), 200, 'application/json'); }
          else if (armHold) { armHold = false; heldCount++; const phase = heldCount === 1 ? 'route' : 'session'; held.push({ phase, index: paths.length + 1, deliver: () => { if (!res.destroyed) { res.writeHead(200, result.headers); res.end(result.bytes); } }, destroyed: () => res.destroyed }); delivery = () => {}; }
        }
      } else {
        expect(saves).toBeLessThan(2); expect(approvals).toBe(saves); expect(classifications).toBe(saves); expect(checkpoints.some(item => item.action === (saves === 0 ? 'before_save' : 'before_clear'))).toBe(true);
        expect(input!.unit_name).toBe(saves === 0 ? '箱' : ''); expect(input!.cate_id).toEqual([11]); expect(input!.attrs).toHaveLength(4);
        for (const key of ['recommend_image', 'system_form_id', 'custom_form', 'system_form_data', 'specs_id', 'specs', 'ensure_id', 'brand_id', 'brand_com', 'auto_on_time', 'auto_off_time', 'store_label_id', 'label_id']) expect(input).not.toHaveProperty(key);
        saves++; assertBusiness(await snapshot(), false, false); savedStates.push(await snapshot());
      }
      paths.push(result.entry); delivery ??= () => { if (!res.destroyed) { res.writeHead(200, result.headers); res.end(result.bytes); } };
    }); delivery();
  }
  function phoneHtml(kind: 'supplier' | 'catalog' | 'list' | 'detail') {
    const frameUrl = kind === 'supplier' ? supplierOrigin + '/products/80/edit' : catalogOrigin + (kind === 'catalog' ? '/#/pages/goods/cate' : kind === 'list' ? '/#/pages/goods/list?cid=100' : '/#/pages/goods/detail?id=80');
    const title = kind === 'supplier' ? 'Supplier单位390×844 iframe' : kind === 'catalog' ? 'H5分类投影390×844 iframe' : kind === 'list' ? 'H5商品列表单位390×844 iframe' : 'H5详情单位390×844 iframe';
    const probe = kind === 'supplier' ? `const picker=doc.querySelector('.unit-picker'),input=picker?.querySelector('input[aria-label="计量单位"]');const data={unit:input?.value,inputDisabled:!!input?.disabled,text:picker?.textContent||'',viewport:{width:win.innerWidth,height:win.innerHeight}};` : kind === 'catalog' ? `const card=[...doc.querySelectorAll('.product-card')].find(node=>node.textContent.includes('本机SKU批量商品'));const data={viewport:{width:win.innerWidth,height:win.innerHeight},card:!!card,sales:card?.querySelector('.sales')?.textContent?.trim()||'',documentWidth:doc.documentElement.scrollWidth};` : kind === 'list' ? `const card=[...doc.querySelectorAll('.goods-card')].find(node=>node.textContent.includes('本机SKU批量商品'));const data={viewport:{width:win.innerWidth,height:win.innerHeight},card:!!card,sales:card?.querySelector('.sales')?.textContent?.trim()||'',documentWidth:doc.documentElement.scrollWidth};` : `const data={viewport:{width:win.innerWidth,height:win.innerHeight},sales:doc.querySelector('.meta-row .product-sales')?.textContent?.trim()||'',stock:doc.querySelector('.meta-row .product-stock')?.textContent?.trim()||'',selected:doc.querySelector('.spec-entry .spec-value')?.textContent?.trim()||'',documentWidth:doc.documentElement.scrollWidth};`;
    const action = kind === 'supplier' ? 'unit_evidence' : kind + '_evidence';
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>实际iframe390×844视口，不调用CDP。</p><button id="probe">${kind === 'supplier' ? '核对单位草稿与目录状态' : '核对实际' + (kind === 'catalog' ? '分类销量（原行为）' : kind === 'list' ? '商品列表销量单位' : '详情销量与所选SKU库存单位')}</button>${kind === 'supplier' ? '<button id="invalidated">核对旧编辑页永久失效</button>' : ''}<a href="${supplierOrigin + control}">返回控制页</a><pre></pre><iframe title="${title}" src="${frameUrl}" style="width:390px;height:844px;border:1px solid #999;display:block"></iframe><script>async function submit(action,data){const response=await fetch(${JSON.stringify(control)}+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.querySelector('pre').textContent=await response.text();}document.getElementById('probe').onclick=()=>{const frame=document.querySelector('iframe'),win=frame.contentWindow,doc=frame.contentDocument;${probe}void submit(${JSON.stringify(action)},data);};${kind === 'supplier' ? `document.getElementById('invalidated').onclick=()=>{const doc=document.querySelector('iframe').contentDocument,buttons=[...doc.querySelectorAll('button')].filter(node=>node.textContent.includes('保存并提交审核'));void submit('invalidated_evidence',{saveButtons:buttons.length,allDisabled:buttons.length>0&&buttons.every(node=>node.disabled),identityAlert:doc.body.textContent.includes('登录身份或权限已改变')});};` : ''}</script>`;
  }
  async function controlAction(req: IncomingMessage, res: ServerResponse, url: URL, origin: string) {
    expect(req.method).toBe('POST'); expect(req.headers.origin).toBe(origin); const action = url.pathname.slice(control.length + 1);
    await serial(async () => {
      if (['error', 'empty', 'normal'].includes(action)) { expect(held).toHaveLength(0); directoryMode = action === 'normal' ? 'normal' : action as 'error' | 'empty'; }
      else if (action === 'unit_evidence') {
        const data = await jsonBody(req); expect(data.viewport).toEqual({ width: 390, height: 844 }); expect(data.inputDisabled).toBe(false);
        if (directoryMode === 'error' || directoryMode === 'empty') { expect(saves).toBe(0); expect(data.unit).toBe('历史自由单位'); expect(paths.some(row => row.path === '/supplierapi/product/get_all_unit' && row.directory_mode === directoryMode && row.sql_read_only)).toBe(true); expect(data.text).toContain(directoryMode === 'error' ? '单位目录读取失败' : '暂无可选单位'); if (!checkpoints.some(row => row.action === directoryMode + '_preserved')) checkpoints.push({ action: directoryMode + '_preserved', database_unchanged: true }); expect(await snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(initialSequences); }
        unitEvidence.push({ ...data, mode: directoryMode, saves });
      } else if (action === 'before_save' || action === 'before_clear') {
        expect(saves).toBe(action === 'before_save' ? 0 : 1); if (saves === 0) { expect(await snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(initialSequences); expect(checkpoints.map(row => row.action)).toEqual(['error_preserved', 'empty_preserved']); } else assertBusiness(await snapshot(), true, true);
        checkpoints.push({ action, saves, database_unchanged: true });
      } else if (action === 'classify') {
        expect(saves).toBe(classifications + 1); expect(approvals).toBe(classifications); expect(saves).toBeLessThanOrEqual(2); await pendingVisibility('before_platform_classification');
        const result = await dispatchApp('/adminapi/product/batch_process', '', 'POST', { type: 1, ids: [80], data: { cate_id: [100] } }, 'Bearer ' + f.adminToken, 'admin'); classifications++; paths.push({ ...result.entry, operation: 'actual_admin_platform_classification' }); assertBusiness(await snapshot(), false, true); classifiedStates.push(await snapshot());
      } else if (action === 'approve') {
        expect(saves).toBe(approvals + 1); expect(classifications).toBe(saves); await pendingVisibility('before_admin_review');
        const result = await dispatchApp('/adminapi/product/product/set_verify/80', '', 'POST', { is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }, 'Bearer ' + f.adminToken, 'admin'); approvals++; paths.push({ ...result.entry, operation: 'actual_admin_review' }); assertBusiness(await snapshot(), true, true); approvedStates.push(await snapshot());
      } else if (action === 'catalog_evidence' || action === 'list_evidence' || action === 'detail_evidence') {
        const data = await jsonBody(req); expect(saves).toBe(approvals); expect(classifications).toBe(saves); expect(saves === 1 || saves === 2).toBe(true); expect(data.viewport).toEqual({ width: 390, height: 844 }); expect(data.documentWidth).toBeLessThanOrEqual(391); expect(data.sales).toBe(action === 'catalog_evidence' ? `已售 ${product(baseline).sales + product(baseline).ficti}` : `已售 ${product(baseline).sales + product(baseline).ficti}${currentUnit()}`);
        if (action === 'catalog_evidence' || action === 'list_evidence') { expect(data.card).toBe(true); expect(paths.some(row => row.path === '/api/products' && row.surface === 'catalog' && row.approvals === saves && row.sql_read_only)).toBe(true); (action === 'catalog_evidence' ? catalogEvidence : listEvidence).push({ ...data, stage: saves }); }
        else { expect(data.selected).toBe('红,S'); expect(data.stock).toBe('库存 3' + currentUnit()); expect(analyticsEvidence.some(row => row.saves === saves)).toBe(true); detailEvidence.push({ ...data, stage: saves, expected_selected_sku: 'sbtred01', expected_sku_stock: 3 }); }
      } else if (action === 'hold') { expect(saves).toBe(2); expect(approvals).toBe(2); expect(heldCount).toBeLessThan(2); expect(held).toHaveLength(0); expect(armHold).toBe(false); directoryMode = 'normal'; armHold = true; }
      else if (action === 'other') { expect(heldCount).toBe(2); expect(held).toHaveLength(1); expect(sessionChanges).toBe(0); sessionChanges++; }
      else if (action === 'restore') { expect(sessionChanges).toBe(1); sessionChanges++; }
      else if (action === 'release') { expect(held).toHaveLength(1); const item = held.shift()!; if (item.phase === 'route') expect(paths.slice(item.index).some(row => row.path === '/supplierapi/product/product/list')).toBe(true); else expect(sessionChanges).toBe(2); const destroyed = item.destroyed(); expect(destroyed).toBe(true); releaseAttempts.push({ phase: item.phase, socket_destroyed: destroyed }); item.deliver(); }
      else if (action === 'invalidated_evidence') { const data = await jsonBody(req); expect(sessionChanges).toBe(2); expect(data.saveButtons).toBeGreaterThan(0); expect(data.allDisabled).toBe(true); expect(data.identityAlert).toBe(true); invalidatedEvidence.push(data); }
      else if (action === 'finish') {
        expect(saves).toBe(2); expect(approvals).toBe(2); expect(classifications).toBe(2); expect(checkpoints.map(row => row.action)).toEqual(['error_preserved', 'empty_preserved', 'before_save', 'before_clear']);
        for (const stage of [1, 2]) { expect(catalogEvidence.some(row => row.stage === stage)).toBe(true); expect(listEvidence.some(row => row.stage === stage)).toBe(true); expect(detailEvidence.some(row => row.stage === stage)).toBe(true); for (const operation of ['before_platform_classification', 'before_admin_review']) expect(paths.filter(row => row.operation === operation && row.saves === stage && row.approvals === stage - 1 && row.sql_read_only)).toHaveLength(1); }
        expect(invalidatedEvidence.length).toBeGreaterThan(0); expect(heldCount).toBe(2); expect(held).toHaveLength(0); expect(armHold).toBe(false); expect(sessionChanges).toBe(2); expect(outbound).toBe(0); expect(releaseAttempts).toEqual([{ phase: 'route', socket_destroyed: true }, { phase: 'session', socket_destroyed: true }]);
        expect(paths.filter(row => row.method === 'POST' && row.surface === 'supplier')).toHaveLength(2); expect(paths.filter(row => row.operation === 'actual_admin_review')).toHaveLength(2); expect(paths.filter(row => row.operation === 'actual_admin_platform_classification')).toHaveLength(2); expect(paths.some(row => row.path === '/api/get_script' && row.status === 200)).toBe(true);
        const final = await snapshot(); assertBusiness(final, true, true); const sequences = await f.sequences(), mutable = new Set(['store_product_attr_id_seq', 'store_product_attr_result_id_seq', 'store_product_relation_id_seq', 'system_log_id_seq', 'store_product_log_id_seq', 'store_visit_id_seq']); expect(sequences.filter(row => !mutable.has(row.name))).toEqual(initialSequences.filter(row => !mutable.has(row.name)));
        finished = true; await writeFile('/tmp/cinashop-supplier-product-unit-browser-result.json', JSON.stringify({ ...state(), baseline, final, initial_sequences: initialSequences, final_sequences: sequences, saved_states: savedStates, classified_states: classifiedStates, approved_states: approvedStates }, null, 2) + '\n');
      } else expect(action).toBe('status');
      actions.push({ action, saves, approvals, classifications }); send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish();
    });
  }
  function controlHtml() { return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Supplier计量单位真实PG16验收</title><h1>单位目录、普通作者、审核与公开消费</h1><p>两个生产bundle与实际App/JWT；详情访问统计保留，其他读取逐次零写；手机为实际390×844 iframe。</p>
    <button id="enter">登录并打开Supplier手机编辑</button><button id="error">目录返回503</button><button id="empty">目录返回空列表</button><button id="normal">恢复真实单位目录</button><button id="before_save">核对选箱草稿未保存</button><button id="before_clear">核对清空草稿未保存</button><button id="classify">实际Admin归入平台分类</button><button id="approve">实际Admin审核上架</button><button id="hold">扣留下一单位目录</button><button id="other">切换只读合成账号</button><button id="restore">恢复管理合成账号</button><button id="release">释放已扣留目录</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button>
    <p><a target="_blank" href="${supplierOrigin}/phone/supplier">Supplier单位手机iframe</a> · <a target="_blank" href="${catalogOrigin}/phone/catalog">H5分类单位手机iframe</a> · <a target="_blank" href="${catalogOrigin}/phone/list">H5商品列表单位手机iframe</a> · <a target="_blank" href="${catalogOrigin}/phone/detail">H5详情单位手机iframe</a> · <a target="_blank" href="${supplierOrigin}/products/80/edit">Supplier桌面页</a> · <a target="_blank" href="${catalogOrigin}/#/pages/goods/cate">H5分类桌面页</a></p>
    <ol><li>登录进入手机编辑，原输入为历史自由单位。控制页click目录503，iframe内click刷新单位目录，等错误后壳click核对单位草稿。再控制空列表，刷新并核对；两次输入仍历史自由单位。</li><li>恢复真实目录，刷新后目录可搜索。确认外店/停用不出现、重复箱仅一个、长名称禁用。选择箱，控制核对选箱草稿，实际保存。依次平台分类、审核，各等JSON；打开H5分类壳核对原销量文案及API单位投影、商品列表壳核对销量箱、详情壳核对销量箱和库存3箱，所选红,S。</li><li>重新打开Supplier编辑，清除平台分类100并勾选本店11（用可见分类标签）。清空计量单位文本input，控制核对清空草稿，保存。再分类+审核，再刷新三H5手机壳核对分类原销量行为、商品列表销量件与详情库存3件。</li><li>扣留下一单位目录，重新进入Supplier编辑，等请求heldCount1，返回列表，再释放，必须socket取消。再扣留并新开Supplier手机壳，heldCount2后控制切只读再恢复，释放；旧壳click核对旧编辑页永久失效。</li><li>读取状态，检查全部2save/2classify/2review/两阶段catalog/list/detail/目录故障与空保留/2cancel，再click完成。控制按钮用click并等待成功JSON。</li></ol><pre></pre><script>
    const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};function session(manager=true){localStorage.setItem('supplier-token',manager?tokens.manager:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:manager?21:22,supplier_id:7,supplier_name:'本机计量单位供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(manager?['supplier.product.view','supplier.product.manage','supplier.attachment.view']:['supplier.product.view']));}document.getElementById('enter').onclick=()=>{session();location.href='/phone/supplier';};for(const action of ['error','empty','normal','before_save','before_clear','classify','approve','hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(false);if(action==='restore')session();};</script>`; }
  function serverFor(surface: 'supplier' | 'catalog') {
    return createServer((req, res) => { void (async () => {
      const origin = surface === 'supplier' ? supplierOrigin : catalogOrigin; if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, controlHtml()); if (path.startsWith(control + '/')) return controlAction(req, res, url, origin);
      if (surface === 'supplier' && path === '/phone/supplier') return send(res, phoneHtml('supplier')); if (surface === 'catalog' && (path === '/phone/catalog' || path === '/phone/list' || path === '/phone/detail')) return send(res, phoneHtml(path.endsWith('detail') ? 'detail' : path.endsWith('list') ? 'list' : 'catalog'));
      if (path.startsWith('/supplierapi/') || path.startsWith('/api/')) return api(req, res, url, surface); if (path === '/favicon.ico') return send(res, '', 204);
      if (path.startsWith('/owned-media/')) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="12" y="84">OWNED UNIT IMAGE</text></svg>', 200, 'image/svg+xml');
      const root = surface === 'supplier' ? supplierRoot : catalogRoot, target = resolve(root, '.' + path), candidate = target.startsWith(root + sep) ? target : '';
      try { if (candidate && (await stat(candidate)).isFile()) return send(res, await readFile(candidate), 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' } as Record<string, string>)[extname(candidate)] ?? 'application/octet-stream'); } catch { /* actual SPA entry */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(cause => { fail(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned unit acceptance assertion failed', 500); else res.destroy(); }); });
  }
  const supplierServer = serverFor('supplier'), catalogServer = serverFor('catalog'), external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Owned unit fixture forbids backend provider fetch'); });
  try { await f.withWriter(async supplier => f.withDetailReader(async publicReader => f.withModerator(async moderator => {
    writer = supplier.container; reader = publicReader.container; wiring.moderator = moderator.container;
    await f.exec(`GRANT SELECT ON public.store_discounts,public.store_discounts_products TO "${publicReader.role}";
      GRANT SELECT ON public.store_product_rule,public.system_attachment_category,public.store_product_label TO "${supplier.role}";
      GRANT SELECT ON public.store_product_category TO "${moderator.role}"; GRANT UPDATE(id) ON public.store_product_category TO "${moderator.role}";
      GRANT UPDATE(cate_id) ON public.store_product TO "${moderator.role}"; GRANT INSERT,DELETE ON public.store_product_relation TO "${moderator.role}";
      GRANT USAGE,SELECT ON SEQUENCE public.store_product_relation_id_seq TO "${moderator.role}"`);
    for (const [owner, runtime] of [['supplier', supplier], ['public', publicReader], ['moderator', moderator]] as const) {
      const [rights] = await runtime.db.execute(sql`SELECT current_user AS role,current_user=session_user AS independent,
        has_column_privilege(current_user,'store_product','unit_name','UPDATE') AS unit_author,
        has_any_column_privilege(current_user,'store_product_log','INSERT') AS analytics_insert,
        has_any_column_privilege(current_user,'store_product_log','UPDATE') AS analytics_log_edit,
        has_table_privilege(current_user,'store_product_log','DELETE') AS analytics_log_delete,
        has_column_privilege(current_user,'store_visit','product_id','UPDATE') AS analytics_identity_edit,
        has_column_privilege(current_user,'store_visit','id','UPDATE') AS analytics_row_identity_edit,
        has_table_privilege(current_user,'store_visit','DELETE') AS analytics_visit_delete,
        has_column_privilege(current_user,'store_product_attr_value','price','UPDATE') AS sku_edit,
        has_table_privilege(current_user,'store_product_unit','INSERT,UPDATE,DELETE') AS directory_write,
        has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS orders_access,
        has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
      // Public detail retains only the ORM INSERT column list plus the mature
      // visit aggregate's UPDATE(count,cate_id,add_time); log edits/deletes,
      // visit identity changes and unrelated business writes stay ungranted.
      expect(rights).toMatchObject({ independent: true, directory_write: false, analytics_log_edit: false, analytics_log_delete: false, analytics_identity_edit: false, analytics_row_identity_edit: false, analytics_visit_delete: false, orders_access: false, answers_access: false }); expect(rights).toMatchObject(owner === 'supplier' ? { unit_author: true, analytics_insert: false, sku_edit: true } : owner === 'public' ? { unit_author: false, analytics_insert: true, sku_edit: false } : { unit_author: false, analytics_insert: false, sku_edit: true }); roles[owner] = rights;
    }
    await new Promise<void>(yes => supplierServer.listen(0, '127.0.0.1', yes)); let address = supplierServer.address(); if (!address || typeof address === 'string') throw Error('Missing Supplier unit origin'); supplierOrigin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>(yes => catalogServer.listen(0, '127.0.0.1', yes)); address = catalogServer.address(); if (!address || typeof address === 'string') throw Error('Missing H5 unit origin'); catalogOrigin = `http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_PRODUCT_UNIT_BROWSER_READY ' + JSON.stringify({ control: supplierOrigin + control, editor: supplierOrigin + '/products/80/edit', phone_supplier: supplierOrigin + '/phone/supplier', catalog: catalogOrigin + '/#/pages/goods/cate', phone_catalog: catalogOrigin + '/phone/catalog', list: catalogOrigin + '/#/pages/goods/list?cid=100', phone_list: catalogOrigin + '/phone/list', detail: catalogOrigin + '/#/pages/goods/detail?id=80', phone_detail: catalogOrigin + '/phone/detail', iframe_viewport: { width: 390, height: 844 }, analytics_note: 'Real anonymous detail visits write only two dedicated analytics tables; all other GET snapshots and sequences are unchanged.' }) + '\n');
    deadline = setTimeout(() => fail(Error('Supplier unit Browser finish not received')), 20 * 60_000); await completion; process.stdout.write('SUPPLIER_PRODUCT_UNIT_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
  }))); } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; wiring.moderator = undefined; held.length = 0; for (const server of [supplierServer, catalogServer]) { server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); } await f.close(); }
}, 21 * 60_000);
