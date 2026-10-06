const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const sfc = require('@vue/compiler-sfc');
const adminRoot = path.resolve(__dirname, '../src');
const commonRoot = path.resolve(__dirname, '../../common');
const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64);
const id = n => `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function loader(gateway = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts'; if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports); let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.vue')) source = sfc.compileScript(sfc.parse(source, { filename:file }).descriptor, { id:'category-style-runtime' }).content;
    const output = ts.transpileModule(source, { compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, esModuleInterop:true } }).outputText;
    new Function('require', 'exports', output)(name => {
      if (name === 'vue') return vue;
      if (name === '@/utils/request') return { __esModule:true, default:gateway, getData:async result => (await result).data };
      if (name.startsWith('@/')) return load(path.join(adminRoot, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return require(name);
    }, exports); return exports;
  }
  return { load };
}
function harness(overrides = {}, storage = new Map()) {
  const actual = loader(), model = actual.load(path.join(commonRoot, 'productCategoryStyleController.ts'));
  let actor = { id:11, identity:'11:sessionA:view/manage', stored:'sessionA', view:true, manage:true }, sequence = 1;
  const records = { read:[], write:[], receipt:[], confirm:[] };
  const snapshot = (changes = {}) => ({ revision, value:{ level:2,index:1 }, configured:true, editable:true, issues:[], ...changes });
  const receipt = async input => ({ operation:'update', id:9, operationId:input.operationId, payloadHash:await model.categoryStyleFingerprint(input) });
  const memory = { getItem:key => storage.has(key) ? storage.get(key) : null, setItem:(key,value) => storage.set(key,value), removeItem:key => storage.delete(key) };
  const ports = {
    read:async signal => { records.read.push(signal); return snapshot(); },
    write:async (input,signal) => { records.write.push({ input:clone(input),signal }); return receipt(input); },
    receipt:async (operationId,signal) => { records.receipt.push({ operationId,signal }); throw notFound(); },
    confirm:async message => { records.confirm.push(message); }, storage:memory, uuid:() => id(sequence++), ...overrides,
  };
  const c = new model.ProductCategoryStyleController(() => actor, ports, value => vue.reactive(value));
  return { c, model, ports, records, storage, snapshot, receipt, actual, setActor:value => { actor = { ...actor,...value }; } };
}
const notFound = () => ({ isAxiosError:true, response:{ status:404, data:{ status:404,msg:'not found' } } });
function proof(status, pending, changes = {}) { return { isAxiosError:true, response:{ status, data:{ status,msg:'explicit rejection', data:{ code:status === 409 ? 'PRODUCT_CATEGORY_STYLE_STALE_VERSION' : 'PRODUCT_CATEGORY_STYLE_REJECTED', operation:'update', operationId:pending.input.operationId, payloadHash:pending.fingerprint, ...changes } } } }; }

test('strict write supports all ten legacy ordinals and excludes unrelated configuration or arbitrary category IDs', () => {
  const r = harness(), values = [];
  for (const level of [2,3]) for (let index = 0; index < (level === 2 ? 6 : 4); index++) { const input = { operationId:id(1),revision,level,index }; values.push(r.model.normalizeCategoryStyleWrite(input)); }
  assert.equal(values.length, 10);
  for (const changes of [{ level:1 },{ level:'2' },{ index:'1' },{ index:-1 },{ index:6 },{ level:3,index:4 },{ index:1.5 },{ operationId:'foreign' },{ revision:'x'.repeat(64) },{ product_category_level:1 }]) assert.throws(() => r.model.normalizeCategoryStyleWrite({ operationId:id(1),revision,level:2,index:1,...changes }));
  r.c.dispose();
});
test('strict snapshots distinguish the original unconfigured 2/1 default from damaged readonly records', () => {
  const r = harness(); assert.deepEqual(r.model.parseCategoryStyleSnapshot(r.snapshot({ configured:false,issues:['category_style_missing'] })), r.snapshot({ configured:false,issues:['category_style_missing'] }));
  assert.doesNotThrow(() => r.model.parseCategoryStyleSnapshot(r.snapshot({ value:null,configured:false,editable:false,issues:['category_style_value_invalid'] })));
  for (const changes of [{ configured:false,value:{ level:2,index:0 } },{ value:null },{ value:{ level:2,index:1,extra:1 } },{ issues:['invalid\nissue'] },{ issues:Array(21).fill('issue') },{ extra:'raw SQL' },{ revision:'bad' }]) assert.throws(() => r.model.parseCategoryStyleSnapshot(r.snapshot(changes)));
  r.c.dispose();
});
test('actual API calls use exactly the read save and receipt contract and forward abort signals', async () => {
  const r = harness(), input = { operationId:id(1),revision,level:3,index:2 }, result = await r.receipt(input), calls = [], gateway = {
    get:async (url,options) => { calls.push({ method:'GET',url,options }); return { data:url.includes('/receipt/') ? result : r.snapshot() }; },
    post:async (url,body,options) => { calls.push({ method:'POST',url,body:clone(body),options }); return { data:result }; },
  };
  const api = loader(gateway).load(path.join(adminRoot, 'api/productCategoryStyle.ts')), signal = new AbortController().signal;
  await api.apiProductCategoryStyle(signal); await api.apiSaveProductCategoryStyle(input,signal); await api.apiProductCategoryStyleReceipt(input.operationId,signal);
  assert.deepEqual(calls.map(row => row.url), ['/config/product-category-style','/config/product-category-style/save',`/config/product-category-style/receipt/${input.operationId}`]);
  assert.deepEqual(calls[1].body,input); assert.ok(calls.every(row => row.options.signal === signal)); await assert.rejects(api.apiProductCategoryStyleReceipt('../foreign')); r.c.dispose();
});
test('fingerprint uses the shared canonical operation revision level index and journal rejects actor or content tampering', async () => {
  const r = harness(), input = { operationId:id(1),revision,level:2,index:4 }, fingerprint = await r.model.categoryStyleFingerprint(input);
  const expected = require('node:crypto').createHash('sha256').update(JSON.stringify({ operation:'update',revision,level:2,index:4 })).digest('hex'); assert.equal(fingerprint,expected);
  const pending = { version:1,actor:11,input,fingerprint }; assert.deepEqual(await r.model.parseCategoryStylePending(JSON.stringify(pending),11),pending);
  for (const changed of [{ actor:22 },{ fingerprint:'f'.repeat(64) },{ input:{ ...input,index:3 } },{ extra:1 }]) await assert.rejects(r.model.parseCategoryStylePending(JSON.stringify({ ...pending,...changed }),11));
  r.c.dispose();
});
test('level switch resets ordinal zero and cancelled confirmation never stores or posts', async () => {
  const r = harness(); await r.c.activate(); assert.deepEqual(clone(r.c.state.selected),{ level:2,index:1 }); r.c.select(5); r.c.setLevel(3); assert.deepEqual(clone(r.c.state.selected),{ level:3,index:0 }); r.c.select(2); r.c.setLevel(3); assert.equal(r.c.state.selected.index,2);
  r.ports.confirm = async () => { throw 'cancel'; }; await r.c.save(); assert.equal(r.records.write.length,0); assert.equal(r.storage.size,0); r.c.dispose();
});
test('matched successful write is confirmed once and reloads current authoritative configuration', async () => {
  const r = harness(); await r.c.activate(); r.c.select(4); r.ports.read = async () => r.snapshot({ value:{ level:2,index:4 },revision:nextRevision }); await r.c.save();
  assert.equal(r.records.write.length,1); assert.equal(r.records.confirm.length,1); assert.equal(r.c.state.pending,null); assert.equal(r.c.state.snapshot.revision,nextRevision); assert.equal(r.c.state.success,true); assert.equal(r.storage.size,0); r.c.dispose();
});
test('unknown write remains immutable and reload restores the original actor request without automatic submission', async () => {
  const r = harness(); await r.c.activate(); r.c.select(3); r.ports.write = async input => { r.records.write.push({ input:clone(input) }); throw Error('response lost'); }; await r.c.save();
  const pending = clone(r.c.state.pending); r.c.select(0); r.c.setLevel(3); await r.c.save(); assert.deepEqual(clone(r.c.state.pending),pending); assert.equal(r.records.write.length,1); r.c.dispose();
  const fresh = harness({},r.storage); await fresh.c.activate(); assert.deepEqual(clone(fresh.c.state.pending),pending); assert.equal(fresh.records.write.length,0); assert.equal(fresh.records.receipt.length,0); assert.equal(fresh.c.editorDisabled,true); fresh.c.dispose();
});
test('real receipt404 allows only an explicitly confirmed identical operation revision and layout retry', async () => {
  const r = harness(); await r.c.activate(); r.c.select(5); r.ports.write = async input => { r.records.write.push({ input:clone(input) }); throw Error('unknown'); }; await r.c.save(); const original = clone(r.c.state.pending.input);
  await r.c.retryOriginal(); assert.equal(r.records.write.length,1); await r.c.readReceipt(); assert.equal(r.c.state.retryReady,true); assert.equal(r.records.write.length,1);
  await r.c.retryOriginal(); assert.equal(r.records.write.length,2); assert.deepEqual(r.records.write[1].input,original); assert.equal(r.c.state.pending.input.operationId,original.operationId); r.c.dispose();
});
test('HTTP200 business404 timeout and foreign receipt never permit a new write or unlock the old one', async () => {
  for (const channel of ['body404','timeout','foreign-id','foreign-hash','extra']) {
    const r = harness(); await r.c.activate(); r.ports.write = async () => { throw Error('unknown'); }; await r.c.save(); const original = clone(r.c.state.pending);
    r.ports.receipt = async () => { if (channel === 'body404') throw { isAxiosError:true,response:{ status:200,data:{ status:404 } } }; if (channel === 'timeout') throw Error('timeout'); const value = await r.receipt(original.input); if (channel === 'foreign-id') value.operationId = id(999); if (channel === 'foreign-hash') value.payloadHash = 'f'.repeat(64); if (channel === 'extra') value.raw = 'not allowed'; return value; };
    await r.c.readReceipt(); assert.deepEqual(clone(r.c.state.pending),original,channel); assert.equal(r.c.state.retryReady,false,channel); assert.equal(r.c.editorDisabled,true,channel); r.c.dispose();
  }
});
test('correct recovered receipt clears its own journal and rereads the current saved value', async () => {
  const r = harness(); await r.c.activate(); r.c.setLevel(3); r.c.select(2); r.ports.write = async () => { throw Error('unknown'); }; await r.c.save(); const pending = clone(r.c.state.pending);
  r.ports.receipt = async () => r.receipt(pending.input); r.ports.read = async () => r.snapshot({ value:{ level:3,index:2 },revision:nextRevision }); await r.c.readReceipt();
  assert.equal(r.c.state.pending,null); assert.equal(r.c.state.success,true); assert.deepEqual(clone(r.c.state.selected),{ level:3,index:2 }); assert.equal(r.storage.size,0); r.c.dispose();
});
test('only matched actual400 and409 release the original request while retaining layout through explicit version reread', async () => {
  for (const status of [400,409]) {
    const r = harness(); await r.c.activate(); r.c.setLevel(3); r.c.select(3); r.ports.write = async input => { r.records.write.push({ input:clone(input) }); throw proof(status,r.c.state.pending); }; await r.c.save();
    const old = clone(r.c.state.rejected); assert.equal(r.c.state.pending,null); assert.equal(r.c.state.needsReread,true); assert.deepEqual(clone(r.c.state.selected),{ level:3,index:3 }); await r.c.save(); assert.equal(r.records.write.length,1);
    r.ports.read = async () => r.snapshot({ revision:nextRevision }); await r.c.reread(); assert.deepEqual(clone(r.c.state.selected),{ level:3,index:3 }); assert.equal(r.c.state.needsReread,false);
    r.ports.write = async input => { r.records.write.push({ input:clone(input) }); return r.receipt(input); }; await r.c.save(); assert.notEqual(r.records.write[1].input.operationId,old.input.operationId); assert.equal(r.records.write[1].input.revision,nextRevision); r.c.dispose();
  }
});
test('rejected draft restores across refresh but requires reading the current version before another UUID', async () => {
  const r = harness(); await r.c.activate(); r.c.select(5); r.ports.write = async () => { throw proof(409,r.c.state.pending); }; await r.c.save(); r.c.dispose();
  const fresh = harness({},r.storage); await fresh.c.activate(); assert.equal(fresh.c.state.needsReread,true); assert.deepEqual(clone(fresh.c.state.selected),{ level:2,index:5 }); await fresh.c.save(); assert.equal(fresh.records.write.length,0); await fresh.c.reread(); assert.equal(fresh.c.state.needsReread,false); fresh.c.dispose();
});
test('bare400 bare409 wrong actualHTTP UUID operation hash and code retain unknown writes', async () => {
  for (const variant of ['bare400','bare409','body409','operationId','operation','payloadHash','code']) {
    const r = harness(); await r.c.activate(); r.ports.write = async () => { if (variant.startsWith('bare')) throw { isAxiosError:true,response:{ status:Number(variant.slice(4)),data:{ status:Number(variant.slice(4)) } } }; const reason = proof(409,r.c.state.pending); if (variant === 'body409') reason.response.status = 200; else reason.response.data.data[variant] = 'foreign'; throw reason; };
    await r.c.save(); assert.ok(r.c.state.pending,variant); assert.equal(r.c.state.rejected,null,variant); assert.equal(r.c.editorDisabled,true,variant); r.c.dispose();
  }
});
test('readonly view permission and damaged duplicate or invalid snapshots cannot select or submit', async () => {
  for (const channel of ['view-only','duplicate','invalid','no-view']) {
    const r = harness(); if (channel === 'view-only') r.setActor({ manage:false }); if (channel === 'no-view') r.setActor({ view:false,manage:false });
    if (['duplicate','invalid'].includes(channel)) r.ports.read = async () => r.snapshot({ value:null,configured:false,editable:false,issues:[channel === 'duplicate' ? 'category_style_duplicate' : 'category_style_value_invalid'] });
    await r.c.activate(); const before = clone(r.c.state.selected); r.c.select(5); r.c.setLevel(3); await r.c.save(); assert.deepEqual(clone(r.c.state.selected),before,channel); assert.equal(r.records.write.length,0,channel); assert.equal(r.c.editorDisabled,true,channel); if (channel === 'no-view') assert.equal(r.records.read.length,0); r.c.dispose();
  }
});
test('failed reread preserves both level and ordinal and prevents saving until a successful explicit read', async () => {
  const r = harness(); await r.c.activate(); r.c.setLevel(3); r.c.select(2); r.ports.read = async () => { throw Error('read unavailable'); }; await r.c.reread(); assert.deepEqual(clone(r.c.state.selected),{ level:3,index:2 }); assert.equal(r.c.state.ready,false); await r.c.save(); assert.equal(r.records.write.length,0);
  r.ports.read = async () => r.snapshot({ revision:nextRevision }); await r.c.reread(); await r.c.save(); assert.equal(r.records.write[0].input.revision,nextRevision); assert.equal(r.records.write[0].input.level,3); assert.equal(r.records.write[0].input.index,2); r.c.dispose();
});
test('storage denial tampered persisted intent and foreign actor journals do not allow unrecorded mutations', async () => {
  const r = harness(); await r.c.activate(); r.ports.storage.setItem = () => { throw Error('storage denied'); }; await r.c.save(); assert.equal(r.records.write.length,0); r.c.dispose();
  const malformed = harness({},new Map([['admin_product_category_style_pending:11','{"version":1,"actor":22}']])); await malformed.c.activate(); assert.ok(malformed.c.state.recoveryError); assert.equal(malformed.c.editorDisabled,true); await malformed.c.save(); assert.equal(malformed.records.write.length,0); assert.equal(malformed.storage.size,1); malformed.c.dispose();
  const tampered = harness(); await tampered.c.activate(); tampered.ports.write = async () => { throw Error('unknown'); }; await tampered.c.save(); const key = tampered.model.categoryStylePendingKey(11); tampered.storage.set(key,'tampered'); await tampered.c.readReceipt(); await tampered.c.retryOriginal(); assert.equal(tampered.c.state.pending.input.operationId,id(1)); assert.ok(tampered.c.state.recoveryError); tampered.c.dispose();
});
test('actor switch stored session change permission revocation and dispose fence late loads', async () => {
  for (const kind of ['actor','stored','view','dispose']) {
    const r = harness(), gate = deferred(); let signal; r.ports.read = async value => { signal = value; return gate.promise; }; const task = r.c.activate(); await tick();
    if (kind === 'actor') r.setActor({ id:22,identity:'22:new-session' }); if (kind === 'stored') r.setActor({ stored:'foreign-session' }); if (kind === 'view') r.setActor({ view:false,manage:false }); if (kind === 'dispose') r.c.dispose(); else r.c.invalidate();
    assert.equal(signal.aborted,true,kind); gate.resolve(r.snapshot({ value:{ level:3,index:3 } })); await task; assert.equal(r.c.state.snapshot,null,kind); assert.deepEqual(clone(r.c.state.selected),{ level:2,index:1 },kind); r.c.dispose();
  }
});
test('late confirmation write and receipt cannot mutate a replacement account or remove the original actor journal', { timeout:10000 }, async () => {
  for (const channel of ['confirm','write','receipt']) {
    const r = harness(), gate = deferred(), started = deferred(); let task, signal, input; await r.c.activate();
    if (channel === 'confirm') { r.ports.confirm = () => { started.resolve(); return gate.promise; }; task = r.c.save(); }
    else if (channel === 'write') { r.ports.write = (value,requestSignal) => { input = clone(value); signal = requestSignal; started.resolve(); return gate.promise; }; task = r.c.save(); }
    else { r.ports.write = async () => { throw Error('unknown'); }; await r.c.save(); input = clone(r.c.state.pending.input); r.ports.receipt = (_value,requestSignal) => { signal = requestSignal; started.resolve(); return gate.promise; }; task = r.c.readReceipt(); }
    await started.promise; r.setActor({ id:22,identity:'22:new-session',stored:'new-session',view:false,manage:false }); r.c.invalidate(); if (signal) assert.equal(signal.aborted,true,channel); gate.resolve(channel === 'confirm' ? undefined : await r.receipt(input)); await task;
    assert.equal(r.c.state.pending,null,channel); assert.equal(r.c.state.success,false,channel); assert.equal(r.storage.has(r.model.categoryStylePendingKey(22)),false,channel); if (channel !== 'confirm') assert.equal(r.storage.has(r.model.categoryStylePendingKey(11)),true,channel); else assert.equal(r.records.write.length,0); r.c.dispose();
  }
});
test('permission loss during confirmation blocks the mutation even before reactive lifecycle invalidation', { timeout:10000 }, async () => {
  const r = harness(), gate = deferred(), started = deferred(); await r.c.activate(); r.ports.confirm = () => { started.resolve(); return gate.promise; }; const task = r.c.save(); await started.promise; r.setActor({ manage:false }); gate.resolve(); await task; assert.equal(r.records.write.length,0); assert.equal(r.storage.size,0); r.c.dispose();
});
test('all ten actual preview SFC renders retain directory large small navigation and shopping distinctions', async () => {
  const file = path.join(adminRoot, 'pages/setting/ProductCategoryStylePreview.vue'), actual = loader(), component = actual.load(file).default;
  const descriptor = sfc.parse(fs.readFileSync(file,'utf8'), { filename:file }).descriptor, script = sfc.compileScript(descriptor, { id:'category-preview-ssr' });
  component.render = new Function('Vue',require('@vue/compiler-dom').compile(descriptor.template.content,{ mode:'function',prefixIdentifiers:true,bindingMetadata:script.bindings }).code)(vue);
  const cases = [[2,0,1,false],[2,1,3,false],[2,2,2,true],[2,3,2,false],[2,4,3,true],[2,5,4,false],[3,0,1,false],[3,1,2,false],[3,2,2,true],[3,3,4,false]], hashes = new Set();
  for (const [level,index,template,compact] of cases) {
    const html = await require('@vue/server-renderer').renderToString(vue.createSSRApp(component,{ value:{ level,index } }));
    assert.ok(html.includes(`data-layout="${level}/${index}"`)); assert.ok(html.includes(`template-${template}`)); assert.equal(html.includes('compact-products'),compact); assert.equal(html.includes('shopping-bar'),template === 2 || template === 3); assert.equal(html.includes('category-grid'),template === 1); assert.equal(html.includes('pagination'),template === 4); assert.equal(html.includes('top-categories'),template === 2);
    if (template === 4) assert.ok(html.includes(level === 3 ? '三级分类筛选' : '二级分类筛选')); hashes.add(require('node:crypto').createHash('sha256').update(html).digest('hex'));
  }
  assert.equal(hashes.size,10);
});
test('actual page compiles with explicit non-autoplay carousel permissions session fences and exact legacy route', () => {
  for (const name of ['ProductCategoryStyle.vue','ProductCategoryStylePreview.vue']) { const file = path.join(adminRoot,'pages/setting',name), parsed = sfc.parse(fs.readFileSync(file,'utf8'),{ filename:file }); assert.deepEqual(parsed.errors,[]); const script = sfc.compileScript(parsed.descriptor,{ id:'category-sfc-check' }); assert.deepEqual(sfc.compileTemplate({ source:parsed.descriptor.template.content,filename:file,id:'category-sfc-check',compilerOptions:{ bindingMetadata:script.bindings } }).errors,[]); }
  const page = fs.readFileSync(path.join(adminRoot,'pages/setting/ProductCategoryStyle.vue'),'utf8'); assert.match(page, /:autoplay="false"/); assert.match(page, /data-style-index/); assert.match(page, /product_category_style\.view/); assert.match(page, /product_category_style\.manage/); assert.match(page, /admin-session-changed/); assert.match(page, /ElMessageBox\.close\(\)/);
  const route = fs.readFileSync(path.join(adminRoot,'router/index.ts'),'utf8'), menu = fs.readFileSync(path.join(adminRoot,'layouts/AdminLayout.vue'),'utf8'); assert.ok(route.includes('alias: "/admin/setting/pages/product_category"')); assert.match(menu,/canMenu\('\/setting\/product-category-style'\)/);
});
