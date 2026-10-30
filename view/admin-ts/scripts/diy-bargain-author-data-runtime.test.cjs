const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/api/diyBargainAuthor.ts');
const bargain = (patch={})=>({id:7,product_id:103,title:'真实砍价活动',image:'/api/assets/8?expires=9999999999&signature='+'A'.repeat(43),price:'5',ot_price:'99.9',people:3,sales:12,stock:9,...patch});
const envelope = (value=[bargain()],patch={})=>({status:200,msg:'ok',data:value,...patch});
const response = (body = envelope(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(send = () => response(envelope())) {
  const calls = [], forbidden = [], fail = name => { forbidden.push(name); throw Error('Anonymous bargain preview must not access '+name); };
  const output = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, exports = {};
  new Function('exports','fetch','window','localStorage','uni','require',output)(exports,async(url,init)=>{const call={url,init};calls.push(call);return send(call);},
    {location:{hostname:'localhost',search:'?preview=1&token=ADMIN'}},
    {getItem:()=>fail('Admin storage read'),setItem:()=>fail('Admin storage write'),removeItem:()=>fail('Admin storage delete')},
    {getStorageSync:()=>fail('journal read'),setStorageSync:()=>fail('journal write'),navigateTo:()=>fail('navigation'),requestSubscribeMessage:()=>fail('subscription SDK')},name=>fail('application import '+name));
  return {...exports,calls,forbidden};
}
/** Read the installed public functions without evaluating the app or replacing
 * their business logic. Unused unrelated module dependencies fail if called. */
function publicChecker() {
  const utilsFile=path.resolve(__dirname,'../../uniapp-ts/src/utils/diy.ts'),source=fs.readFileSync(utilsFile,'utf8'),tree=ts.createSourceFile(utilsFile,source,ts.ScriptTarget.Latest,true),wanted=new Set(['asDiyRecord','safeDiyImageUrl','safeDiyColor']),chunks=[];
  for(const node of tree.statements) if(ts.isFunctionDeclaration(node)&&wanted.has(node.name?.text))chunks.push(node.getText(tree));
  assert.equal(chunks.length,3);const helper={};new Function('exports','API_BASE',ts.transpileModule(chunks.join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(helper,'');
  const dataFile=path.resolve(__dirname,'../../uniapp-ts/src/utils/diyCommerceData.ts'),data={};new Function('exports','require',ts.transpileModule(fs.readFileSync(dataFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(data,name=>{
    if(name==='@/utils/diy')return helper;
    if(name.endsWith('/categoryCatalog'))return{parseCategoryProducts:()=>assert.fail('No product catalogue in bargain DTO')};
    if(name==='@/api/productRank')return{rankNavigation:()=>assert.fail('No product ranking in bargain DTO')};
    assert.fail('Unreviewed public dependency '+name);
  });return data.checkedCommerceCards;
}


test('full direct list returns activity identity base old price initiator people and sales count without unknown DTO authority',()=>{
 const u=setup(),raw=[bargain({unknown:{image:'/api/assets/99'},token:'ADMIN',min_price:'1',quota:99,status:3})],before=structuredClone(raw);assert.deepEqual(u.checkedDiyBargainPublicRows(raw,1),[{id:7,productId:103,title:'真实砍价活动',image:raw[0].image,price:'5.00',oldPrice:'99.90',people:3,count:12,stock:9,percent:0,integral:0,status:0}]);assert.deepEqual(raw,before);assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});
test('actual installed Uni bargain checker agrees across independent start price base old price people and sales',()=>{
 const u=setup(),actual=publicChecker();for(const price of['0',0,'3.5','9999999999.99'])for(const sales of[0,17,2147483647]){const raw=[bargain({price,sales,people:7,min_price:'0',quota:999}),bargain({id:8,product_id:205,title:'另一砍价',people:0,sales:0,stock:0,ot_price:'0'})];assert.deepEqual(u.checkedDiyBargainPublicRows(raw,2),actual('bargain',raw,2));}
});
test('entire list rejects duplicate invalid and sparse tails without clipping filtering coercion mutation or partial rows',()=>{
 const u=setup();for(const raw of[[bargain(),bargain({id:8,stock:-1})],[bargain(),bargain({title:'duplicate'})],[bargain(),null],[bargain(),false],Array(1)]){const before=structuredClone(raw);assert.throws(()=>u.checkedDiyBargainPublicRows(raw,2),/格式错误|重复/);assert.deepEqual(raw,before);}assert.throws(()=>u.checkedDiyBargainPublicRows([bargain(),bargain({id:8})],1),/列表/);
});
test('only the real direct array is accepted without invented list/count or summary envelopes',()=>{
 const u=setup();for(const raw of[undefined,null,false,{}, {list:[bargain()],count:1},{products:[bargain()],pink:{}},{data:[bargain()]},'[]'])assert.throws(()=>u.checkedDiyBargainPublicRows(raw,1),/列表/);assert.deepEqual(u.checkedDiyBargainPublicRows([],10),[]);
});
test('activity product people sales stock are the exact typed public integer boundaries and not minimum-price or help-quota aliases',()=>{
 const u=setup();for(const key of['id','product_id','people','sales','stock'])for(const value of[undefined,null,false,'2',-1,.5,2147483648,NaN,Infinity,{}])assert.throws(()=>u.checkedDiyBargainPublicRows([bargain({[key]:value})],1),/格式错误/);for(const key of['id','product_id'])assert.throws(()=>u.checkedDiyBargainPublicRows([bargain({[key]:0})],1));assert.equal(u.checkedDiyBargainPublicRows([bargain({people:0,sales:0,stock:0,min_price:999,quota:999})],1)[0].count,0);
});
test('current and base old prices use exact current public money normalization including independent zero values',()=>{
 const u=setup();for(const[raw,normalized]of[[0,'0.00'],['0','0.00'],[8.5,'8.50'],['0.01','0.01'],['9999999999.99','9999999999.99']]){const row=u.checkedDiyBargainPublicRows([bargain({price:raw,ot_price:raw})],1)[0];assert.equal(row.price,normalized);assert.equal(row.oldPrice,normalized);}for(const value of[undefined,null,false,'',' 5 ','00','1e2','.5','-1','-0.00','1.001','10000000000',NaN,Infinity])for(const key of['price','ot_price'])assert.throws(()=>u.checkedDiyBargainPublicRows([bargain({[key]:value})],1),/金额格式错误/);assert.equal(u.checkedDiyBargainPublicRows([bargain({ot_price:0})],1)[0].price,'5.00');
});
test('title and product image preserve strict current text boundaries without replacement fixtures',()=>{
 const u=setup();assert.equal(u.checkedDiyBargainPublicRows([bargain({title:''})],1)[0].title,'');assert.equal(u.checkedDiyBargainPublicRows([bargain({title:'砍'.repeat(1024)})],1)[0].title.length,1024);for(const title of[undefined,null,7,{},'砍'.repeat(1025),'控制\n字符','\u0000','\u007f'])assert.throws(()=>u.checkedDiyBargainPublicRows([bargain({title})],1),/文字格式错误/);for(const image of[undefined,null,7,{},'a'.repeat(8193),'控制\n字符'])assert.throws(()=>u.checkedDiyBargainPublicRows([bargain({image})],1),/文字格式错误/);
});
test('business image safety matches actual public H5 HTTP static raster-data and unsafe fallback without authorizing or saving pictures',()=>{
 const u=setup(),actual=publicChecker();for(const image of['',' https://images.example.com/x.png ','http://images.example.com/x.png','/static/images/a.png','/api/assets/13?expires=1&signature=old','data:image/png;base64,AAA','data:image/webp;base64,AAA','data:image/svg+xml;base64,AAA','javascript:alert(1)','//external.example/x','a'.repeat(4097)]){const raw=[bargain({image})],before=structuredClone(raw);assert.deepEqual(u.checkedDiyBargainPublicRows(raw,1),actual('bargain',raw,1));assert.deepEqual(raw,before);}
});
test('strict1..10 integer input fails before any payload inspection or network read',async()=>{
 const u=setup();for(const limit of[undefined,null,false,'3',0,-1,1.5,11,100,NaN,Infinity]){assert.throws(()=>u.checkedDiyBargainPublicRows([],limit),/整数/);await assert.rejects(u.apiDiyBargainPreview(limit),/整数/);}assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});
test('the isolated adapter makes precisely one anonymous GET with original AbortSignal despite localhost preview and Admin token bait',async()=>{
 const u=setup(),controller=new AbortController(),rows=await u.apiDiyBargainPreview(3,controller.signal);assert.equal(rows[0].id,7);assert.equal(rows[0].productId,103);assert.equal(u.calls.length,1);assert.deepEqual(u.calls[0],{url:'/api/bargain/list?page=1&limit=3',init:{method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal}});assert.strictEqual(u.calls[0].init.signal,controller.signal);assert.deepEqual(u.forbidden,[]);
});
test('optional signal and real empty list never create demonstration products selections summary reads or subscription activity',async()=>{
 const u=setup(()=>response(envelope([])));assert.deepEqual(await u.apiDiyBargainPreview(1),[]);assert.equal(u.calls.length,1);assert.equal(u.calls[0].url,'/api/bargain/list?page=1&limit=1');assert.equal(u.calls[0].init.signal,undefined);assert.deepEqual(u.forbidden,[]);
});
test('network HTTP business and malformed JSON failures remain explicit without partial records auth retries or alternate endpoints',async()=>{
 for(const send of[()=>{throw Error('owned network failure');},()=>response(envelope(),503),()=>response(envelope(null,{status:400,msg:'真实错误'})),()=>({ok:true,status:200,json:async()=>{throw Error('bad JSON');}})]){const u=setup(send);await assert.rejects(u.apiDiyBargainPreview(1));assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);}
});
test('all top-level success response fields are checked before exposing a direct list',async()=>{
 for(const body of[null,[],false,{}, {status:'200',msg:'ok',data:[bargain()]},{status:200,data:[bargain()]},{status:200,msg:null,data:[bargain()]},{status:200,msg:'ok'},envelope(null),envelope({list:[bargain()],count:1})]){const u=setup(()=>response(body));await assert.rejects(u.apiDiyBargainPreview(1),/格式错误/);assert.equal(u.calls.length,1);}
});
test('whole-list rejection can explicitly retry without POST start/help cart orders journals or SDK calls',async()=>{
 let invalid=true;const u=setup(()=>response(envelope(invalid?[bargain(),bargain({id:8,stock:-1})]:[bargain()])));await assert.rejects(u.apiDiyBargainPreview(2),/格式错误/);invalid=false;assert.equal((await u.apiDiyBargainPreview(2))[0].id,7);assert.equal(u.calls.length,2);assert.ok(u.calls.every(c=>c.init.method==='GET'&&c.url==='/api/bargain/list?page=1&limit=2'));assert.deepEqual(u.forbidden,[]);
});
test('already aborted request makes no I/O and preserves exact caller cancellation reason',async()=>{
 const u=setup(),controller=new AbortController(),reason=new Error('owned cancellation');controller.abort(reason);await assert.rejects(u.apiDiyBargainPreview(1,controller.signal),error=>error===reason);assert.deepEqual(u.calls,[]);
});
test('an ignored-abort late transport cannot expose old actor or raw-context material',async()=>{
 const wait=deferred(),u=setup(()=>wait.promise),controller=new AbortController(),reason=new Error('owner changed');const job=u.apiDiyBargainPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);controller.abort(reason);wait.resolve(response());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});
test('cancellation during JSON parsing prevents all list adoption even if native fetch ignored the signal',async()=>{
 const wait=deferred(),u=setup(()=>({ok:true,status:200,json:()=>wait.promise})),controller=new AbortController(),reason=new Error('page changed');const job=u.apiDiyBargainPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);await Promise.resolve();await Promise.resolve();controller.abort(reason);wait.resolve(envelope());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});
test('an abort triggered while validating a row also rejects the complete pending result',async()=>{
 const controller=new AbortController(),reason=new Error('raw config changed'),row=bargain();Object.defineProperty(row,'sales',{enumerable:true,get(){controller.abort(reason);return 12;}});const u=setup(()=>response(envelope([row])));await assert.rejects(u.apiDiyBargainPreview(1,controller.signal),error=>error===reason);assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});
