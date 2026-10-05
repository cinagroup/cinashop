const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ts = require('typescript'), vue = require('vue'), sfc = require('@vue/compiler-sfc');
const adminRoot = path.resolve(__dirname, '../src'), commonRoot = path.resolve(__dirname, '../../common');
const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64), id = n => `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value)), tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function loader(gateway = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts'; if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports); let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.vue')) source = sfc.compileScript(sfc.parse(source, { filename:file }).descriptor, { id:'detail-design-runtime' }).content;
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
  const actual = loader(), model = actual.load(path.join(commonRoot, 'productDetailDesignController.ts')), shared = actual.load(path.join(commonRoot, 'productDetailDesign.ts'));
  let actor = { id:11,identity:'11:sessionA:view/manage',stored:'sessionA',view:true,manage:true }, sequence = 1;
  const records = { read:[],write:[],receipt:[],confirm:[] };
  const snapshot = (changes = {}) => ({ revision,value:shared.cloneProductDetailDesign(),configured:true,editable:true,issues:[],...changes });
  const receipt = async input => ({ operation:'update',id:9,operationId:input.operationId,payloadHash:await model.detailDesignFingerprint(input) });
  const memory = { getItem:key => storage.has(key) ? storage.get(key) : null,setItem:(key,value) => storage.set(key,value),removeItem:key => storage.delete(key) };
  const ports = {
    read:async signal => { records.read.push(signal); return snapshot(); },
    write:async (input,signal) => { records.write.push({ input:clone(input),signal }); return receipt(input); },
    receipt:async (operationId,signal) => { records.receipt.push({ operationId,signal }); throw notFound(); },
    confirm:async message => { records.confirm.push(message); },storage:memory,uuid:() => id(sequence++),...overrides,
  };
  const c = new model.ProductDetailDesignController(() => actor,ports,value => vue.reactive(value));
  return { c,model,shared,ports,records,storage,snapshot,receipt,actual,setActor:value => { actor = { ...actor,...value }; } };
}
const notFound = () => ({ isAxiosError:true,response:{ status:404,data:{ status:404,msg:'not found' } } });
function proof(status,pending,changes = {}) { return { isAxiosError:true,response:{ status,data:{ status,msg:'explicit rejection',data:{ code:status === 409 ? 'PRODUCT_DETAIL_DESIGN_STALE_VERSION' : 'PRODUCT_DETAIL_DESIGN_REJECTED',operation:'update',operationId:pending.input.operationId,payloadHash:pending.fingerprint,...changes } } } }; }

test('shared real defaults contain nineteen keys with community on and counts 3 3 12 3, without GET writes', async () => {
  const r = harness({ read:async () => r.snapshot({ configured:false,issues:['product_detail_missing'] }) }); await r.c.activate();
  assert.equal(Object.keys(r.c.state.draft).length,19); assert.equal(r.c.state.draft.showCommunity,1);
  assert.deepEqual(['replyNum','matchNum','recommendNum','communityNum'].map(key => r.c.state.draft[key]),[3,3,12,3]); assert.equal(r.records.write.length,0); assert.equal(r.c.dirty,false); r.c.dispose();
});
test('strict nineteen-field write accepts seeded historic isOpen and empty navigation while bounding editable values', () => {
  const r = harness(), value = r.shared.cloneProductDetailDesign(); value.isOpen = [3,4,5,1,2,0]; value.navList = [];
  assert.deepEqual(r.model.normalizeDetailDesignWrite({ operationId:id(1),revision,value }).value,value);
  for (const patch of [{ replyNum:0 },{ replyNum:11 },{ matchNum:1.5 },{ recommendNum:25 },{ communityNum:'3' },{ showCart:true },{ showService:[0,'1'] },{ isOpen:[0,6] },{ isOpen:[0,0] },{ showPrice:[2] },{ menuList:[0,1,2,3] },{ navList:[5] },{ extra:1 }]) assert.throws(() => r.model.normalizeDetailDesignWrite({ operationId:id(1),revision,value:{ ...value,...patch } }));
  assert.throws(() => r.model.normalizeDetailDesignWrite({ operationId:'bad',revision,value })); assert.throws(() => r.model.normalizeDetailDesignWrite({ operationId:id(1),revision:'bad',value })); assert.throws(() => r.model.normalizeDetailDesignWrite({ operationId:id(1),revision,value,extra:1 })); r.c.dispose();
});
test('snapshots allow existing damaged null records but reject editable null defaults and raw extensions', () => {
  const r = harness(); assert.doesNotThrow(() => r.model.parseDetailDesignSnapshot(r.snapshot({ value:null,configured:true,editable:false,issues:['product_detail_value_invalid'] })));
  for (const patch of [{ value:null },{ configured:false,value:{ ...r.shared.cloneProductDetailDesign(),showCommunity:0 } },{ extra:'SQL' },{ issues:['bad\nissue'] },{ issues:Array(21).fill('issue') },{ value:{ ...r.shared.cloneProductDetailDesign(),secret:1 } }]) assert.throws(() => r.model.parseDetailDesignSnapshot(r.snapshot(patch))); r.c.dispose();
});
test('draft and read snapshots own their arrays without mutating shared defaults or incoming data', async () => {
  const r = harness(), source = r.snapshot(); r.ports.read = async () => source; await r.c.activate(); r.c.toggleSelection('navList',0,false);
  assert.deepEqual(source.value.navList,[0,1,2,3,4]); assert.deepEqual(r.c.state.snapshot.value.navList,[0,1,2,3,4]); assert.deepEqual(r.shared.PRODUCT_DETAIL_DESIGN_DEFAULT.navList,[0,1,2,3,4]); source.value.navList.pop(); assert.equal(r.c.state.snapshot.value.navList.length,5); assert.equal(r.c.dirty,true); r.c.dispose();
});
test('actual API uses exact read save receipt paths, full nineteen values and AbortSignals', async () => {
  const r = harness(), input = { operationId:id(1),revision,value:r.shared.cloneProductDetailDesign() }, result = await r.receipt(input), calls = [], gateway = {
    get:async (url,options) => { calls.push({ method:'GET',url,options }); return { data:url.includes('/receipt/') ? result : r.snapshot() }; },
    post:async (url,body,options) => { calls.push({ method:'POST',url,body:clone(body),options }); return { data:result }; },
  };
  const api = loader(gateway).load(path.join(adminRoot,'api/productDetailDesign.ts')), signal = new AbortController().signal;
  await api.apiProductDetailDesign(signal); await api.apiSaveProductDetailDesign(input,signal); await api.apiProductDetailDesignReceipt(input.operationId,signal);
  assert.deepEqual(calls.map(row => row.url),['/config/product-detail-design','/config/product-detail-design/save',`/config/product-detail-design/receipt/${input.operationId}`]); assert.deepEqual(calls[1].body,input); assert.ok(calls.every(row => row.options.signal === signal)); await assert.rejects(api.apiProductDetailDesignReceipt('../foreign')); r.c.dispose();
});
test('digest matches fixed shared full-nineteen canonical and preserves selection order rather than sorting', async () => {
  const r = harness(), input = { operationId:id(1),revision,value:r.shared.cloneProductDetailDesign() }; input.value.isOpen = [3,4,5,1,2,0];
  const hash = await r.model.detailDesignFingerprint(input), expected = crypto.createHash('sha256').update(JSON.stringify(r.shared.productDetailDesignPayload(revision,input.value))).digest('hex'); assert.equal(hash,expected);
  assert.notEqual(await r.model.detailDesignFingerprint({ ...input,value:{ ...input.value,isOpen:[0,1,2,3,4,5] } }),hash); assert.equal(await r.model.detailDesignFingerprint({ ...input,operationId:id(2) }),hash);
  const pending = { version:1,actor:11,input,fingerprint:hash }; assert.deepEqual(clone(await r.model.parseDetailDesignPending(JSON.stringify(pending),11)),pending); await assert.rejects(r.model.parseDetailDesignPending(JSON.stringify(pending),22)); pending.input.value.showCart = 0; await assert.rejects(r.model.parseDetailDesignPending(JSON.stringify(pending),11)); r.c.dispose();
});
test('single checkbox changes preserve seeded isOpen3 4 5 and original ordering without exposing edit access', async () => {
  const r = harness(); r.ports.read = async () => r.snapshot({ value:{ ...r.shared.cloneProductDetailDesign(),isOpen:[3,4,5,1,2,0],showPrice:[1,0] } }); await r.c.activate();
  r.c.toggleSelection('isOpen',0,false); assert.deepEqual(clone(r.c.state.draft.isOpen),[3,4,5,1,2]); r.c.toggleSelection('isOpen',0,true); assert.deepEqual(clone(r.c.state.draft.isOpen),[3,4,5,1,2,0]); r.c.toggleSelection('isOpen',3,false); assert.deepEqual(clone(r.c.state.draft.isOpen),[3,4,5,1,2,0]); assert.deepEqual(clone(r.c.state.draft.showPrice),[1,0]); r.c.dispose();
});
test('all eighteen editor fields update, navigation may be empty, footer remains at most three items', async () => {
  const r = harness(); await r.c.activate();
  for (const key of ['openShare','pictureConfig','swiperDot','showSvip','showRank','showReply','showMatch','showRecommend','showCart','showCommunity']) r.c.setFlag(key,1-r.c.state.draft[key]);
  for (const [key,max] of [['replyNum',10],['matchNum',10],['recommendNum',24],['communityNum',10]]) { r.c.setCount(key,max); assert.equal(r.c.state.draft[key],max); }
  for (const item of [0,1,2,3,4]) r.c.toggleSelection('navList',item,false); assert.deepEqual(clone(r.c.state.draft.navList),[]);
  r.c.toggleSelection('showService',0,false); r.c.toggleSelection('isOpen',0,false); r.c.toggleSelection('menuList',4,true); assert.deepEqual(clone(r.c.state.draft.menuList),[0,1,2]); r.c.toggleSelection('menuList',1,false); r.c.toggleSelection('menuList',4,true); assert.deepEqual(clone(r.c.state.draft.menuList),[0,2,4]); assert.equal(r.c.dirty,true); assert.equal(r.shared.isProductDetailDesignValue(clone(r.c.state.draft)),true); r.c.dispose();
});
test('out-of-range blank fractional and foreign editor values leave the draft intact', async () => {
  const r = harness(); await r.c.activate(); const before = clone(r.c.state.draft);
  for (const value of [null,0,11,1.1,'4',NaN]) r.c.setCount('replyNum',value); r.c.setFlag('showCart','0'); r.c.setFlag('showPrice',0); r.c.toggleSelection('navList',7,true); r.c.toggleSelection('showService',0,1); assert.deepEqual(clone(r.c.state.draft),before); r.c.dispose();
});
test('readonly membership display and historical ordinals cannot be altered by saving a tampered draft', async () => {
  for (const field of ['showPrice','isOpen']) { const r = harness(); await r.c.activate(); if (field === 'showPrice') r.c.state.draft.showPrice = []; else r.c.state.draft.isOpen.push(3); await r.c.save(); assert.equal(r.records.write.length,0); assert.equal(r.storage.size,0); assert.match(r.c.state.notice,/只读/); r.c.dispose(); }
});
test('cancelled confirmation never persists or submits any of the full-nineteen changes', async () => {
  const r = harness({ confirm:async () => { throw 'cancel'; } }); await r.c.activate(); r.c.setFlag('showCart',0); await r.c.save(); assert.equal(r.records.write.length,0); assert.equal(r.storage.size,0); assert.equal(r.c.state.confirming,false); assert.equal(r.c.state.draft.showCart,0); r.c.dispose();
});
test('matched successful full write clears its journal and reloads current authoritative settings', async () => {
  const r = harness(); await r.c.activate(); r.c.setFlag('showCart',0); const wanted = clone(r.c.state.draft); r.ports.read = async () => r.snapshot({ revision:nextRevision,value:wanted }); await r.c.save();
  assert.equal(r.records.write.length,1); assert.deepEqual(r.records.write[0].input.value,wanted); assert.equal(Object.keys(r.records.write[0].input.value).length,19); assert.equal(r.c.state.pending,null); assert.equal(r.c.state.success,true); assert.equal(r.storage.size,0); assert.equal(r.c.dirty,false); r.c.dispose();
});
test('unknown write retains a deeply frozen nineteen-field intent even when the mutable draft changes', async () => {
  const r = harness({ write:async () => { throw Error('timeout'); } }); await r.c.activate(); r.c.setFlag('showCart',0); await r.c.save(); const old = clone(r.c.state.pending);
  assert.ok(Object.isFrozen(r.c.state.pending)); assert.ok(Object.isFrozen(r.c.state.pending.input.value.navList)); r.c.state.draft.navList.pop(); r.c.state.draft.showCart = 1; r.c.setCount('replyNum',8); await r.c.save(); assert.deepEqual(clone(r.c.state.pending),old); assert.equal(r.c.editorDisabled,true); r.c.dispose();
});
test('refresh restores only the original actor pending request without automatic write or changed readonly fields', async () => {
  const r = harness({ write:async () => { throw Error('unknown'); } }); await r.c.activate(); r.c.setFlag('showCart',0); await r.c.save(); const pending = clone(r.c.state.pending); r.c.dispose();
  const fresh = harness({},r.storage); fresh.ports.read = async () => fresh.snapshot({ value:{ ...fresh.shared.cloneProductDetailDesign(),showPrice:[],isOpen:[5,4,3,0] } }); await fresh.c.activate(); assert.deepEqual(clone(fresh.c.state.pending),pending); assert.deepEqual(clone(fresh.c.state.draft),pending.input.value); assert.equal(fresh.records.write.length,0); assert.equal(fresh.c.editorDisabled,true); fresh.c.dispose();
});
test('only actual receipt404 enables explicit same UUID revision and all nineteen values retry', async () => {
  const r = harness({ write:async () => { throw Error('unknown'); } }); await r.c.activate(); r.c.setCount('replyNum',7); await r.c.save(); const pending = clone(r.c.state.pending); await r.c.retryOriginal(); assert.equal(r.records.confirm.length,1);
  await r.c.readReceipt(); assert.equal(r.c.state.retryReady,true); let retried; r.ports.write = async input => { retried = clone(input); return r.receipt(input); }; await r.c.retryOriginal(); assert.deepEqual(retried,pending.input); assert.equal(r.records.confirm.length,2); assert.equal(r.c.state.pending,null); r.c.dispose();
});
test('business404 network failure and foreign receipt never unlock an unknown operation', async () => {
  for (const variant of ['business404','timeout','foreign-id','foreign-hash','extra']) {
    const r = harness({ write:async () => { throw Error('unknown'); } }); await r.c.activate(); await r.c.save(); const pending = clone(r.c.state.pending);
    r.ports.receipt = async () => { if (variant === 'business404') throw { isAxiosError:true,response:{ status:200,data:{ status:404 } } }; if (variant === 'timeout') throw Error('timeout'); const receipt = await r.receipt(pending.input); if (variant === 'foreign-id') receipt.operationId = id(999); if (variant === 'foreign-hash') receipt.payloadHash = 'f'.repeat(64); if (variant === 'extra') receipt.raw = 'extra'; return receipt; };
    await r.c.readReceipt(); assert.deepEqual(clone(r.c.state.pending),pending,variant); assert.equal(r.c.state.retryReady,false,variant); assert.equal(r.c.editorDisabled,true,variant); r.c.dispose();
  }
});
test('view-only actor can recover a matched receipt and clear only the actor-owned journal', async () => {
  const r = harness({ write:async () => { throw Error('unknown'); } }); await r.c.activate(); await r.c.save(); const pending = clone(r.c.state.pending); r.c.dispose();
  const fresh = harness({},r.storage); fresh.setActor({ manage:false }); fresh.ports.receipt = async () => fresh.receipt(pending.input); await fresh.c.activate(); await fresh.c.readReceipt(); assert.equal(fresh.c.state.pending,null); assert.equal(fresh.storage.size,0); assert.equal(fresh.records.write.length,0); assert.equal(fresh.c.editorDisabled,true); fresh.c.dispose();
});
test('matched actual400 and409 keep original rejected nineteen fields until explicit fresh reread and new confirmation', async () => {
  for (const status of [400,409]) {
    const r = harness(); r.ports.read = async () => r.snapshot({ value:{ ...r.shared.cloneProductDetailDesign(),isOpen:[3,4,5,1,2,0],showPrice:[1,0] } }); await r.c.activate(); r.c.setFlag('showCart',0); r.c.toggleSelection('isOpen',0,false); r.ports.write = async () => { throw proof(status,r.c.state.pending); }; await r.c.save(); const original = clone(r.c.state.rejected);
    assert.equal(r.c.state.pending,null); assert.equal(r.c.state.needsReread,true); await r.c.save(); assert.equal(r.records.confirm.length,1);
    r.ports.read = async () => r.snapshot({ revision:nextRevision,value:{ ...r.shared.cloneProductDetailDesign(),showPrice:[],isOpen:[5,4,3,0] } }); await r.c.reread(); assert.equal(r.c.state.draft.showCart,0); assert.deepEqual(clone(r.c.state.draft.showPrice),[]); assert.deepEqual(clone(r.c.state.draft.isOpen),[5,4,3,1,2]); assert.deepEqual(clone(r.c.state.rejected),original); assert.deepEqual(clone(r.c.state.syncedReadonly),['会员展示项 showPrice','历史保留项 isOpen 3/4/5']);
    let input; r.ports.write = async value => { input = clone(value); return r.receipt(value); }; await r.c.save(); assert.notEqual(input.operationId,original.input.operationId); assert.equal(input.revision,nextRevision); assert.equal(input.value.showCart,0); assert.equal(r.records.confirm.length,2); r.c.dispose();
  }
});
test('rejected draft survives refresh with all nineteen values but fresh version reread is required', async () => {
  const r = harness(); await r.c.activate(); r.c.setCount('communityNum',10); r.ports.write = async () => { throw proof(409,r.c.state.pending); }; await r.c.save(); const old = clone(r.c.state.rejected); r.c.dispose();
  const fresh = harness({},r.storage); await fresh.c.activate(); assert.equal(fresh.c.state.needsReread,true); assert.deepEqual(clone(fresh.c.state.rejected),old); assert.equal(fresh.c.state.draft.communityNum,10); await fresh.c.save(); assert.equal(fresh.records.write.length,0); await fresh.c.reread(); fresh.ports.uuid = () => id(20); await fresh.c.save(); assert.equal(fresh.records.write[0].input.operationId,id(20)); fresh.c.dispose();
});
test('reread without readonly changes retains original seeded selection order and every editable draft field', async () => {
  const r = harness(); r.ports.read = async () => r.snapshot({ value:{ ...r.shared.cloneProductDetailDesign(),isOpen:[3,4,5,1,2,0] } }); await r.c.activate(); r.c.toggleSelection('isOpen',1,false); r.c.toggleSelection('isOpen',1,true); r.c.setCount('recommendNum',24); const wanted = clone(r.c.state.draft); await r.c.reread(); assert.deepEqual(clone(r.c.state.draft),wanted); assert.deepEqual(clone(r.c.state.syncedReadonly),[]); r.c.dispose();
});
test('bare400 bare409 mismatched actual status code operation UUID and hash retain unknown intent', async () => {
  for (const variant of ['bare400','bare409','body409','operationId','operation','payloadHash','code']) {
    const r = harness(); await r.c.activate(); r.ports.write = async () => { if (variant.startsWith('bare')) throw { isAxiosError:true,response:{ status:Number(variant.slice(4)),data:{ status:Number(variant.slice(4)) } } }; const reason = proof(409,r.c.state.pending); if (variant === 'body409') reason.response.status = 200; else reason.response.data.data[variant] = 'foreign'; throw reason; }; await r.c.save(); assert.ok(r.c.state.pending,variant); assert.equal(r.c.state.rejected,null,variant); r.c.dispose();
  }
});
test('view-only absent permission duplicate identity damaged snapshots block editor changes and submissions', async () => {
  for (const variant of ['view-only','no-view','duplicate','identity','invalid']) {
    const r = harness(); if (variant === 'view-only') r.setActor({ manage:false }); if (variant === 'no-view') r.setActor({ view:false,manage:false }); if (['duplicate','identity','invalid'].includes(variant)) r.ports.read = async () => r.snapshot({ configured:variant === 'invalid',value:null,editable:false,issues:[variant === 'duplicate' ? 'product_detail_duplicate' : variant === 'identity' ? 'product_detail_identity_invalid' : 'product_detail_value_invalid'] });
    await r.c.activate(); const before = clone(r.c.state.draft); r.c.setFlag('showCart',0); r.c.toggleSelection('navList',0,false); r.c.setCount('replyNum',10); await r.c.save(); assert.deepEqual(clone(r.c.state.draft),before,variant); assert.equal(r.records.write.length,0,variant); assert.equal(r.c.editorDisabled,true,variant); if (variant === 'no-view') assert.equal(r.records.read.length,0); r.c.dispose();
  }
});
test('failed reread keeps editable draft and cannot save until a successful explicit read', async () => {
  const r = harness(); await r.c.activate(); r.c.setCount('matchNum',9); r.ports.read = async () => { throw Error('unavailable'); }; await r.c.reread(); assert.equal(r.c.state.draft.matchNum,9); assert.equal(r.c.state.ready,false); await r.c.save(); assert.equal(r.records.write.length,0); r.ports.read = async () => r.snapshot({ revision:nextRevision }); await r.c.reread(); await r.c.save(); assert.equal(r.records.write[0].input.revision,nextRevision); assert.equal(r.records.write[0].input.value.matchNum,9); r.c.dispose();
});
test('storage denial corrupt and tampered journals prevent unrecorded writes or clearing old intent', async () => {
  const r = harness(); await r.c.activate(); r.ports.storage.setItem = () => { throw Error('denied'); }; await r.c.save(); assert.equal(r.records.write.length,0); r.c.dispose();
  const bad = harness({},new Map([['admin_product_detail_design_pending:11','{"version":1,"actor":22}']])); await bad.c.activate(); assert.ok(bad.c.state.recoveryError); await bad.c.save(); assert.equal(bad.records.write.length,0); assert.equal(bad.storage.size,1); bad.c.dispose();
  const tampered = harness({ write:async () => { throw Error('unknown'); } }); await tampered.c.activate(); await tampered.c.save(); tampered.storage.set(tampered.model.detailDesignPendingKey(11),'tampered'); await tampered.c.readReceipt(); assert.ok(tampered.c.state.recoveryError); assert.equal(tampered.records.receipt.length,0); assert.ok(tampered.c.state.pending); tampered.c.dispose();
});
test('actor stored session view revocation and disposal abort and fence late reads', async () => {
  for (const variant of ['actor','stored','view','dispose']) {
    const r = harness(), gate = deferred(); let signal; r.ports.read = async value => { signal = value; return gate.promise; }; const task = r.c.activate(); await tick(); if (variant === 'actor') r.setActor({ id:22,identity:'22:new' }); if (variant === 'stored') r.setActor({ stored:'new' }); if (variant === 'view') r.setActor({ view:false }); if (variant === 'dispose') r.c.dispose(); else r.c.invalidate(); assert.equal(signal.aborted,true); gate.resolve(r.snapshot({ value:{ ...r.shared.cloneProductDetailDesign(),replyNum:10 } })); await task; assert.equal(r.c.state.snapshot,null); assert.equal(r.c.state.draft.replyNum,3); r.c.dispose();
  }
});
test('late confirmation write and receipt cannot update a replacement actor or delete original actor storage', { timeout:10000 }, async () => {
  for (const channel of ['confirm','write','receipt']) {
    const r = harness(), gate = deferred(), started = deferred(); let task, signal, input; await r.c.activate();
    if (channel === 'confirm') { r.ports.confirm = () => { started.resolve(); return gate.promise; }; task = r.c.save(); }
    else if (channel === 'write') { r.ports.write = (value,requestSignal) => { input = clone(value); signal = requestSignal; started.resolve(); return gate.promise; }; task = r.c.save(); }
    else { r.ports.write = async () => { throw Error('unknown'); }; await r.c.save(); input = clone(r.c.state.pending.input); r.ports.receipt = (_value,requestSignal) => { signal = requestSignal; started.resolve(); return gate.promise; }; task = r.c.readReceipt(); }
    await started.promise; r.setActor({ id:22,identity:'22:new',stored:'new',view:false,manage:false }); r.c.invalidate(); if (signal) assert.equal(signal.aborted,true); gate.resolve(channel === 'confirm' ? undefined : await r.receipt(input)); await task; assert.equal(r.c.state.pending,null); assert.equal(r.c.state.success,false); assert.equal(r.storage.has(r.model.detailDesignPendingKey(22)),false); assert.equal(r.storage.has(r.model.detailDesignPendingKey(11)),channel !== 'confirm'); r.c.dispose();
  }
});
test('manage permission revoked during confirmation prevents posting without waiting for UI invalidation', { timeout:10000 }, async () => {
  const r = harness(), gate = deferred(), started = deferred(); await r.c.activate(); r.ports.confirm = () => { started.resolve(); return gate.promise; }; const task = r.c.save(); await started.promise; r.setActor({ manage:false }); gate.resolve(); await task; assert.equal(r.records.write.length,0); assert.equal(r.storage.size,0); r.c.dispose();
});
test('actual live preview renders nine modules, gated elements and real configured counts for every content panel', async () => {
  const file = path.join(adminRoot,'pages/setting/ProductDetailDesignPreview.vue'), actual = loader(), component = actual.load(file).default, shared = actual.load(path.join(commonRoot,'productDetailDesign.ts'));
  const descriptor = sfc.parse(fs.readFileSync(file,'utf8'),{ filename:file }).descriptor, script = sfc.compileScript(descriptor,{ id:'detail-preview-ssr' }); component.render = new Function('Vue',require('@vue/compiler-dom').compile(descriptor.template.content,{ mode:'function',prefixIdentifiers:true,bindingMetadata:script.bindings }).code)(vue);
  const render = value => require('@vue/server-renderer').renderToString(vue.createSSRApp(component,{ value,active:0 })), defaults = await render(shared.cloneProductDetailDesign());
  for (const module of [0,1,2,3,4,8,5,6,7]) assert.ok(defaults.includes(`data-testid="detail-preview-module-${module}"`));
  const value = { ...shared.cloneProductDetailDesign(),replyNum:10,matchNum:9,recommendNum:24,communityNum:8,openShare:0,swiperDot:0,pictureConfig:1,isOpen:[3,4,5],showService:[2],showCart:0,menuList:[3,4] }, changed = await render(value);
  for (const [kind,count] of [['review',10],['match',9],['recommend',24],['community',8]]) assert.equal((changed.match(new RegExp(`data-preview-${kind}="`,'g')) ?? []).length,count,kind);
  for (const id of ['preview-share','preview-swiper-dots','preview-original-price','preview-sales','preview-stock','preview-add-cart','preview-service-0','preview-service-1','preview-service-3']) assert.equal(changed.includes(`data-testid="${id}"`),false,id);
  assert.ok(changed.includes('preview-buy')); assert.ok(changed.includes('adaptive')); assert.ok(changed.includes('recommend-cards scrolling')); assert.ok(changed.includes('data-preview-footer="3"')); assert.ok(changed.includes('data-preview-footer="4"')); assert.equal(changed.includes('data-preview-footer="0"'),false);
  const hidden = await render({ ...shared.cloneProductDetailDesign(),showSvip:0,showRank:0,showReply:0,showMatch:0,showRecommend:0,showCommunity:0,showService:[] }); for (const label of ['会员信息已隐藏','排行榜已隐藏','商品评价已隐藏','搭配购已隐藏','优品推荐已隐藏','种草秀已隐藏','服务与商品参数已隐藏']) assert.ok(hidden.includes(label));
});
test('actual page templates compile with eighteen controls, readonly nineteenth, exact alias and actor lifecycle fences', () => {
  for (const name of ['ProductDetailDesign.vue','ProductDetailDesignPreview.vue']) { const file = path.join(adminRoot,'pages/setting',name), parsed = sfc.parse(fs.readFileSync(file,'utf8'),{ filename:file }); assert.deepEqual(parsed.errors,[]); const script = sfc.compileScript(parsed.descriptor,{ id:'detail-design-sfc-check' }); assert.deepEqual(sfc.compileTemplate({ source:parsed.descriptor.template.content,filename:file,id:'detail-design-sfc-check',compilerOptions:{ bindingMetadata:script.bindings } }).errors,[]); }
  const page = fs.readFileSync(path.join(adminRoot,'pages/setting/ProductDetailDesign.vue'),'utf8'); assert.match(page,/detail-readonly-showPrice/); assert.match(page,/product_detail_design\.view/); assert.match(page,/product_detail_design\.manage/); assert.match(page,/detail-rejected-intent/); assert.match(page,/admin-session-changed/); assert.match(page,/onBeforeUnmount/); assert.match(page,/ElMessageBox\.close\(\)/);
  const route = fs.readFileSync(path.join(adminRoot,'router/index.ts'),'utf8'), menu = fs.readFileSync(path.join(adminRoot,'layouts/AdminLayout.vue'),'utf8'); assert.ok(route.includes('alias: "/admin/setting/pages/product_detail"')); assert.match(menu,/canMenu\('\/setting\/product-detail-design'\)/);
});
