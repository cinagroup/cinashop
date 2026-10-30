const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/api/diyPresaleAuthor.ts');
const presale = (patch={})=>({id:7,store_name:'真实预售商品',image:'/api/assets/8?expires=9999999999&signature='+'A'.repeat(43),price:'5',ot_price:'9.9',sales:3,stock:9,presale_pay_status:2,...patch});
const data = (list=[presale()],count=list.length)=>({list,count});
const envelope = (value=data(),patch={})=>({status:200,msg:'ok',data:value,...patch});
const response = (body = envelope(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(send = () => response()) {
  const calls = [], forbidden = [], fail = name => { forbidden.push(name); throw Error('Anonymous presale preview must not access '+name); };
  const output = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, exports = {};
  new Function('exports','fetch','window','localStorage','uni','require',output)(exports,async(url,init)=>{const call={url,init};calls.push(call);return send(call);},
    {location:{hostname:'localhost',search:'?preview=1&token=ADMIN'}},
    {getItem:()=>fail('Admin storage read'),setItem:()=>fail('Admin storage write'),removeItem:()=>fail('Admin storage delete')},
    {getStorageSync:()=>fail('journal read'),setStorageSync:()=>fail('journal write'),navigateTo:()=>fail('navigation')},name=>fail('application import '+name));
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
    if(name.endsWith('/categoryCatalog'))return{parseCategoryProducts:()=>assert.fail('No product catalogue in presale DTO')};
    if(name==='@/api/productRank')return{rankNavigation:()=>assert.fail('No product ranking in presale DTO')};
    assert.fail('Unreviewed public dependency '+name);
  });return data.checkedCommerceCards;
}


test('complete list/count payload returns the exact public normalized presale product identity and excludes unrelated DTO material',()=>{
 const u=setup(),raw=data([presale({product_id:103,unknown:{image:'/api/assets/99'},token:'ADMIN'})]),before=structuredClone(raw);
 assert.deepEqual(u.checkedDiyPresalePublicRows(raw,1),[{id:7,productId:7,title:'真实预售商品',image:raw.list[0].image,price:'5.00',oldPrice:'9.90',people:0,count:3,stock:9,percent:0,integral:0,status:2}]);assert.deepEqual(raw,before);assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});

test('actual installed Uni presale checker matches every normalized field across statuses prices and deliberately different unrelated product_id',()=>{
 const u=setup(),actual=publicChecker();for(const status of[0,1,2,3])for(const price of['0',0,'3.5','9999999999.99']){
  const raw=data([presale({presale_pay_status:status,price,product_id:'not an activity ID',title:'must use store_name',people:'unused',integral:-1,percent:-1}),presale({id:8,store_name:'第二预售',sales:0,stock:0})],9);assert.deepEqual(u.checkedDiyPresalePublicRows(raw,2),actual('presale',raw,2));
 }
});

test('entire list rejects invalid duplicate and sparse tails without truncation filtering deduplication or mutation',()=>{
 const u=setup();for(const list of[[presale(),presale({id:8,stock:-1})],[presale(),presale({store_name:'duplicate'})],[presale(),null],[presale(),false],Array(1)]){const raw=data(list),before=structuredClone(raw);assert.throws(()=>u.checkedDiyPresalePublicRows(raw,2),/格式错误|重复/);assert.deepEqual(raw,before);}assert.throws(()=>u.checkedDiyPresalePublicRows(data([presale(),presale({id:8})]),1),/列表/);
});

test('list and count are required with the exact existing public object-envelope count boundary',()=>{
 const u=setup(),actual=publicChecker();for(const count of[undefined,null,false,'1',-1,.5,2147483648,NaN,Infinity,{}])assert.throws(()=>u.checkedDiyPresalePublicRows({list:[presale()],count},1),/数量格式错误/);
 for(const raw of[undefined,null,false,[],[presale()],{list:[presale()]},{count:1},{list:null,count:0},{list:{},count:0}])assert.throws(()=>u.checkedDiyPresalePublicRows(raw,1),/格式错误/);
 const raw=data([presale()],0);assert.deepEqual(u.checkedDiyPresalePublicRows(raw,1),actual('presale',raw,1),'Compatibility checker bounds count without inventing a new list/count consistency policy');assert.deepEqual(u.checkedDiyPresalePublicRows(data([],2147483647),10),[]);
});

test('product ID sales stock and status are typed current public integers without coercion',()=>{
 const u=setup();for(const key of['id','sales','stock','presale_pay_status'])for(const value of[undefined,null,false,'2',-1,.5,2147483648,NaN,Infinity,{}])assert.throws(()=>u.checkedDiyPresalePublicRows(data([presale({[key]:value})]),1),/格式错误/);
 assert.throws(()=>u.checkedDiyPresalePublicRows(data([presale({id:0})]),1));assert.throws(()=>u.checkedDiyPresalePublicRows(data([presale({presale_pay_status:4})]),1));assert.equal(u.checkedDiyPresalePublicRows(data([presale({sales:0,stock:0,presale_pay_status:0})]),1)[0].count,0);
});

test('both current and original price use exact public money normalization and reject malformed numeric spellings',()=>{
 const u=setup();for(const[raw,normalized]of[[0,'0.00'],['0','0.00'],[8.5,'8.50'],['0.01','0.01'],['9999999999.99','9999999999.99']]){const row=u.checkedDiyPresalePublicRows(data([presale({price:raw,ot_price:raw})]),1)[0];assert.equal(row.price,normalized);assert.equal(row.oldPrice,normalized);}
 for(const value of[undefined,null,false,'',' 5 ','00','1e2','.5','-1','-0.00','1.001','10000000000',NaN,Infinity])for(const key of['price','ot_price'])assert.throws(()=>u.checkedDiyPresalePublicRows(data([presale({[key]:value})]),1),/金额格式错误/);
});

test('store_name and image use strict current text lengths and control-character rejection',()=>{
 const u=setup();assert.equal(u.checkedDiyPresalePublicRows(data([presale({store_name:''})]),1)[0].title,'');assert.equal(u.checkedDiyPresalePublicRows(data([presale({store_name:'售'.repeat(1024)})]),1)[0].title.length,1024);
 for(const store_name of[undefined,null,7,{},'售'.repeat(1025),'控制\n字符','\u0000','\u007f'])assert.throws(()=>u.checkedDiyPresalePublicRows(data([presale({store_name})]),1),/文字格式错误/);
 for(const image of[undefined,null,7,{},'a'.repeat(8193),'控制\n字符'])assert.throws(()=>u.checkedDiyPresalePublicRows(data([presale({image})]),1),/文字格式错误/);
});

test('safe business-image normalization matches actual public H5 HTTP static raster-data and unsafe fallback contracts',()=>{
 const u=setup(),actual=publicChecker();for(const image of['',' https://images.example.com/x.png ','http://images.example.com/x.png','/static/images/a.png','/api/assets/13?expires=1&signature=old','data:image/png;base64,AAA','data:image/webp;base64,AAA','data:image/svg+xml;base64,AAA','javascript:alert(1)','//external.example/x','a'.repeat(4097)]){const raw=data([presale({image})]),before=structuredClone(raw);assert.deepEqual(u.checkedDiyPresalePublicRows(raw,1),actual('presale',raw,1));assert.deepEqual(raw,before);}
});

test('strict1..10 preview limit rejects all bad input before network or payload inspection',async()=>{
 const u=setup();for(const limit of[undefined,null,false,'3',0,-1,1.5,11,100,NaN,Infinity]){assert.throws(()=>u.checkedDiyPresalePublicRows(data(),limit),/整数/);await assert.rejects(u.apiDiyPresalePreview(limit),/整数/);}assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});

test('actual isolated API sends one precise anonymous time_type0 GET despite localhost preview=1 and Admin token bait',async()=>{
 const u=setup(),controller=new AbortController(),rows=await u.apiDiyPresalePreview(3,controller.signal);assert.equal(rows[0].id,7);assert.equal(u.calls.length,1);const{url,init}=u.calls[0];assert.equal(url,'/api/presale/list?page=1&limit=3&time_type=0');assert.deepEqual(Object.keys(init).sort(),['cache','credentials','headers','method','signal']);assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.deepEqual(init.headers,{Accept:'application/json'});assert.strictEqual(init.signal,controller.signal);assert.equal(Object.hasOwn(init,'body'),false);assert.deepEqual(u.forbidden,[]);
});

test('optional signal empty real list and count never create fixtures selected IDs filters or interaction controller work',async()=>{
 const u=setup(()=>response(envelope(data([],0))));assert.deepEqual(await u.apiDiyPresalePreview(10),[]);assert.equal(u.calls[0].url,'/api/presale/list?page=1&limit=10&time_type=0');assert.equal(u.calls[0].init.signal,undefined);assert.deepEqual(u.forbidden,[]);
});

test('network HTTP business and malformed JSON failures stay explicit without fake rows or Admin retries',async()=>{
 for(const send of[()=>{throw Error('owned network failure');},()=>response(envelope(),503),()=>response(envelope(null,{status:400,msg:'真实错误'})),()=>({ok:true,status:200,json:async()=>{throw Error('bad JSON');}})]){const u=setup(send);await assert.rejects(u.apiDiyPresalePreview(1));assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);}
});

test('all top-level response fields remain required before a successful HTTP envelope may expose list/count',async()=>{
 for(const body of[null,[],false,{}, {status:'200',msg:'ok',data:data()},{status:200,data:data()},{status:200,msg:null,data:data()},{status:200,msg:'ok'},envelope(null),envelope([presale()])]){const u=setup(()=>response(body));await assert.rejects(u.apiDiyPresalePreview(1),/格式错误/);assert.equal(u.calls.length,1);}
});

test('whole-list failure can explicitly retry without POST SKU cart order membership or storage writes',async()=>{
 let invalid=true;const u=setup(()=>response(envelope(data(invalid?[presale(),presale({id:8,stock:-1})]:[presale()]))));await assert.rejects(u.apiDiyPresalePreview(2),/格式错误/);invalid=false;assert.equal((await u.apiDiyPresalePreview(2))[0].id,7);assert.equal(u.calls.length,2);assert.ok(u.calls.every(call=>call.init.method==='GET'&&call.url==='/api/presale/list?page=1&limit=2&time_type=0'));assert.deepEqual(u.forbidden,[]);
});

test('pre-cancelled signal forbids every request and preserves exact cancellation reason',async()=>{
 const u=setup(),controller=new AbortController(),reason=new Error('owned cancellation');controller.abort(reason);await assert.rejects(u.apiDiyPresalePreview(1,controller.signal),error=>error===reason);assert.deepEqual(u.calls,[]);
});

test('ignored-abort late transport response cannot expose old-context presale material',async()=>{
 const wait=deferred(),u=setup(()=>wait.promise),controller=new AbortController(),reason=new Error('owner changed');const job=u.apiDiyPresalePreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);controller.abort(reason);wait.resolve(response());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});

test('abort while parsing JSON blocks list adoption and any follow-up transport work',async()=>{
 const wait=deferred(),u=setup(()=>({ok:true,status:200,json:()=>wait.promise})),controller=new AbortController(),reason=new Error('page changed');const job=u.apiDiyPresalePreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);await Promise.resolve();await Promise.resolve();controller.abort(reason);wait.resolve(envelope());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});
