const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/api/diyCombinationAuthor.ts');
const combination = (patch={})=>({id:7,product_id:103,title:'真实拼团活动',image:'/api/assets/8?expires=9999999999&signature='+'A'.repeat(43),price:'5',ot_price:'9.9',people:3,pink_count:12,stock:9,...patch});
const summary = (patch={})=>({pink_count:71,avatars:['http://images.example.com/avatar.png','/static/avatar-2.png'],...patch});
const envelope = (value=[combination()],patch={})=>({status:200,msg:'ok',data:value,...patch});
const response = (body = envelope(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(send = call => response(envelope(call.url==='/api/pink'?summary():[combination()]))) {
  const calls = [], forbidden = [], fail = name => { forbidden.push(name); throw Error('Anonymous combination preview must not access '+name); };
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
    if(name.endsWith('/categoryCatalog'))return{parseCategoryProducts:()=>assert.fail('No product catalogue in combination DTO')};
    if(name==='@/api/productRank')return{rankNavigation:()=>assert.fail('No product ranking in combination DTO')};
    assert.fail('Unreviewed public dependency '+name);
  });return {cards:data.checkedCommerceCards,pink:data.checkedCommercePink};
}


test('complete direct list returns normalized activity and distinct product identity with no unknown DTO authority',()=>{
 const u=setup(),raw=[combination({unknown:{image:'/api/assets/99'},token:'ADMIN',sales:'unused',status:3})],before=structuredClone(raw);
 assert.deepEqual(u.checkedDiyCombinationPublicRows(raw,1),[{id:7,productId:103,title:'真实拼团活动',image:raw[0].image,price:'5.00',oldPrice:'9.90',people:3,count:12,stock:9,percent:0,integral:0,status:0}]);assert.deepEqual(raw,before);assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});

test('actual installed Uni combination checker agrees on all normalized fields and independent card/header counts',()=>{
 const u=setup(),actual=publicChecker();for(const price of['0',0,'3.5','9999999999.99'])for(const count of[0,17,2147483647]){
  const raw=[combination({price,pink_count:count,store_name:'ignored',sales:'unused',integral:-1,percent:-1}),combination({id:8,product_id:205,title:'第二拼团',people:0,pink_count:0,stock:0})];assert.deepEqual(u.checkedDiyCombinationPublicRows(raw,2),actual.cards('combination',raw,2));assert.deepEqual(u.checkedDiyCombinationPink(summary({pink_count:count})),actual.pink(summary({pink_count:count})));
 }
});

test('whole product list rejects duplicate invalid and sparse tails without clipping filtering coercion or input mutation',()=>{
 const u=setup();for(const raw of[[combination(),combination({id:8,stock:-1})],[combination(),combination({title:'duplicate'})],[combination(),null],[combination(),false],Array(1)]){const before=structuredClone(raw);assert.throws(()=>u.checkedDiyCombinationPublicRows(raw,2),/格式错误|重复/);assert.deepEqual(raw,before);}assert.throws(()=>u.checkedDiyCombinationPublicRows([combination(),combination({id:8})],1),/列表/);
});

test('combination list is a direct array rather than a presale list/count or homeComb envelope',()=>{
 const u=setup();for(const raw of[undefined,null,false,{}, {list:[combination()],count:1},{name:'homeComb',list:[combination()]}, {data:[combination()]},'[]'])assert.throws(()=>u.checkedDiyCombinationPublicRows(raw,1),/列表/);assert.deepEqual(u.checkedDiyCombinationPublicRows([],10),[]);
});

test('activity product people card count and stock use the exact typed current public integer boundaries',()=>{
 const u=setup();for(const key of['id','product_id','people','pink_count','stock'])for(const value of[undefined,null,false,'2',-1,.5,2147483648,NaN,Infinity,{}])assert.throws(()=>u.checkedDiyCombinationPublicRows([combination({[key]:value})],1),/格式错误/);
 for(const key of['id','product_id'])assert.throws(()=>u.checkedDiyCombinationPublicRows([combination({[key]:0})],1));assert.equal(u.checkedDiyCombinationPublicRows([combination({people:0,pink_count:0,stock:0})],1)[0].count,0);
});

test('both product prices normalize exact public money and reject malformed numeric spellings',()=>{
 const u=setup();for(const[raw,normalized]of[[0,'0.00'],['0','0.00'],[8.5,'8.50'],['0.01','0.01'],['9999999999.99','9999999999.99']]){const row=u.checkedDiyCombinationPublicRows([combination({price:raw,ot_price:raw})],1)[0];assert.equal(row.price,normalized);assert.equal(row.oldPrice,normalized);}
 for(const value of[undefined,null,false,'',' 5 ','00','1e2','.5','-1','-0.00','1.001','10000000000',NaN,Infinity])for(const key of['price','ot_price'])assert.throws(()=>u.checkedDiyCombinationPublicRows([combination({[key]:value})],1),/金额格式错误/);
});

test('title and product image retain strict current text lengths and reject controls without fallback substitution',()=>{
 const u=setup();assert.equal(u.checkedDiyCombinationPublicRows([combination({title:''})],1)[0].title,'');assert.equal(u.checkedDiyCombinationPublicRows([combination({title:'团'.repeat(1024)})],1)[0].title.length,1024);
 for(const title of[undefined,null,7,{},'团'.repeat(1025),'控制\n字符','\u0000','\u007f'])assert.throws(()=>u.checkedDiyCombinationPublicRows([combination({title})],1),/文字格式错误/);
 for(const image of[undefined,null,7,{},'a'.repeat(8193),'控制\n字符'])assert.throws(()=>u.checkedDiyCombinationPublicRows([combination({image})],1),/文字格式错误/);
});

test('business image and summary avatar safety matches the actual public HTTP static raster-data and unsafe fallback projection',()=>{
 const u=setup(),actual=publicChecker();for(const image of['',' https://images.example.com/x.png ','http://images.example.com/x.png','/static/images/a.png','/api/assets/13?expires=1&signature=old','data:image/png;base64,AAA','data:image/webp;base64,AAA','data:image/svg+xml;base64,AAA','javascript:alert(1)','//external.example/x','a'.repeat(4097)]){const raw=[combination({image})],pink=summary({avatars:[image,image]}),before=structuredClone({raw,pink});assert.deepEqual(u.checkedDiyCombinationPublicRows(raw,1),actual.cards('combination',raw,1));assert.deepEqual(u.checkedDiyCombinationPink(pink),actual.pink(pink));assert.deepEqual({raw,pink},before);}
});

test('pink response preserves typed aggregate and all100 ordered duplicate safe avatars without imposing a new three-avatar cap',()=>{
 const u=setup(),actual=publicChecker(),raw=summary({pink_count:2147483647,avatars:Array.from({length:100},(_,i)=>'/static/avatar-'+i%3+'.png'),unknown:{url:'/api/assets/99'}}),before=structuredClone(raw);const result=u.checkedDiyCombinationPink(raw);assert.deepEqual(result,actual.pink(raw));assert.equal(result.avatars.length,100);assert.equal(result.avatars[0],result.avatars[3]);assert.deepEqual(raw,before);assert.deepEqual(u.checkedDiyCombinationPink({pink_count:0,avatars:[]}),{pink_count:0,avatars:[]});
});

test('pink integer and complete avatar-array shape reject unknown envelope and invalid or sparse tails atomically',()=>{
 const u=setup();for(const pink_count of[undefined,null,false,'1',-1,.5,2147483648,NaN,Infinity,{}])assert.throws(()=>u.checkedDiyCombinationPink(summary({pink_count})),/格式错误/);
 for(const raw of[undefined,null,false,[],{}, {pink_count:0}, {avatars:[]},summary({avatars:null}),summary({avatars:{}}),summary({avatars:Array(101).fill('/a.png')}),summary({avatars:['/good.png',7]}),summary({avatars:['/good.png',null]}),summary({avatars:['/good.png','bad\nimage']}),summary({avatars:Array(1)})]){const before=structuredClone(raw);assert.throws(()=>u.checkedDiyCombinationPink(raw),/格式错误/);assert.deepEqual(raw,before);}
});

test('strict1..10 integer input fails before payload inspection or either network read',async()=>{
 const u=setup();for(const limit of[undefined,null,false,'3',0,-1,1.5,11,100,NaN,Infinity]){assert.throws(()=>u.checkedDiyCombinationPublicRows([],limit),/整数/);await assert.rejects(u.apiDiyCombinationPreview(limit),/整数/);}assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});

test('actual isolated API validates first read then sends exact anonymous list and pink GETs with the original signal',async()=>{
 const first=deferred(),u=setup(call=>call.url==='/api/pink'?response(envelope(summary())):first.promise),controller=new AbortController(),job=u.apiDiyCombinationPreview(3,controller.signal);assert.deepEqual(u.calls.map(c=>c.url),['/api/combination/list?page=1&limit=3']);first.resolve(response());const result=await job;assert.equal(result.products[0].id,7);assert.equal(result.products[0].productId,103);assert.equal(result.pink.pink_count,71);assert.deepEqual(u.calls.map(c=>c.url),['/api/combination/list?page=1&limit=3','/api/pink']);
 for(const{init}of u.calls){assert.deepEqual(Object.keys(init).sort(),['cache','credentials','headers','method','signal']);assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.deepEqual(init.headers,{Accept:'application/json'});assert.strictEqual(init.signal,controller.signal);assert.equal(Object.hasOwn(init,'body'),false);}assert.deepEqual(u.forbidden,[]);
});

test('a fully invalid first product tail never reads pink and never exposes a partial product result',async()=>{
 const u=setup(()=>response(envelope([combination(),combination({id:8,stock:'bad'})])));await assert.rejects(u.apiDiyCombinationPreview(2),/格式错误/);assert.deepEqual(u.calls.map(c=>c.url),['/api/combination/list?page=1&limit=2']);assert.deepEqual(u.forbidden,[]);
});

test('first network HTTP business and malformed JSON failures are explicit and forbid follow-up pink',async()=>{
 for(const send of[()=>{throw Error('owned network failure');},()=>response(envelope(),503),()=>response(envelope(null,{status:400,msg:'真实错误'})),()=>({ok:true,status:200,json:async()=>{throw Error('bad JSON');}})]){const u=setup(send);await assert.rejects(u.apiDiyCombinationPreview(1));assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);}
});

test('second network HTTP business JSON or malformed summary never returns first-read products as a partial success',async()=>{
 for(const send of[()=>{throw Error('pink network failure');},()=>response(envelope(summary()),503),()=>response(envelope(null,{status:400,msg:'真实摘要错误'})),()=>({ok:true,status:200,json:async()=>{throw Error('bad JSON');}}),()=>response(envelope(summary({avatars:['/a.png',7]})))]){const u=setup(call=>call.url==='/api/pink'?send():response());await assert.rejects(u.apiDiyCombinationPreview(1));assert.equal(u.calls.length,2);assert.deepEqual(u.forbidden,[]);}
});

test('all response envelope fields stay required independently for first and second reads',async()=>{
 for(const stage of['list','pink'])for(const body of[null,[],false,{}, {status:'200',msg:'ok',data:[]},{status:200,data:[]},{status:200,msg:null,data:[]},{status:200,msg:'ok'}]){const u=setup(call=>response((call.url==='/api/pink')===(stage==='pink')?body:envelope()));await assert.rejects(u.apiDiyCombinationPreview(1),/格式错误/);assert.equal(u.calls.length,stage==='list'?1:2);}
});

test('optional signal and an empty real product list still read true pink summary without fixtures or invented cards',async()=>{
 const u=setup(call=>response(envelope(call.url==='/api/pink'?summary({pink_count:0,avatars:[]}):[])));assert.deepEqual(await u.apiDiyCombinationPreview(10),{products:[],pink:{pink_count:0,avatars:[]}});assert.equal(u.calls[0].url,'/api/combination/list?page=1&limit=10');assert.equal(u.calls[1].url,'/api/pink');assert.ok(u.calls.every(c=>c.init.signal===undefined));assert.deepEqual(u.forbidden,[]);
});

test('an explicit retry rereads both endpoints after failed pink without cached partial rows or any write',async()=>{
 let invalid=true;const u=setup(call=>response(envelope(call.url==='/api/pink'?summary({avatars:invalid?[null]:[]}):[combination()])));await assert.rejects(u.apiDiyCombinationPreview(1));invalid=false;const result=await u.apiDiyCombinationPreview(1);assert.equal(result.products.length,1);assert.deepEqual(result.pink.avatars,[]);assert.deepEqual(u.calls.map(c=>c.url),['/api/combination/list?page=1&limit=1','/api/pink','/api/combination/list?page=1&limit=1','/api/pink']);assert.ok(u.calls.every(c=>c.init.method==='GET'));assert.deepEqual(u.forbidden,[]);
});

test('pre-cancelled signal forbids every request and preserves exact cancellation reason',async()=>{
 const u=setup(),controller=new AbortController(),reason=new Error('owned cancellation');controller.abort(reason);await assert.rejects(u.apiDiyCombinationPreview(1,controller.signal),error=>error===reason);assert.deepEqual(u.calls,[]);
});

test('ignored-abort late first transport response cannot read second endpoint or expose old products',async()=>{
 const wait=deferred(),u=setup(()=>wait.promise),controller=new AbortController(),reason=new Error('owner changed'),job=u.apiDiyCombinationPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);controller.abort(reason);wait.resolve(response());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});

test('abort while parsing first JSON blocks list adoption and every follow-up I/O',async()=>{
 const wait=deferred(),u=setup(()=>({ok:true,status:200,json:()=>wait.promise})),controller=new AbortController(),reason=new Error('page changed'),job=u.apiDiyCombinationPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);await Promise.resolve();await Promise.resolve();controller.abort(reason);wait.resolve(envelope());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});

test('abort during first validated payload evaluation is checked before pink transport begins',async()=>{
 const controller=new AbortController(),reason=new Error('between actual requests'),row=combination();Object.defineProperty(row,'stock',{enumerable:true,get(){controller.abort(reason);return 9;}});const u=setup(()=>response(envelope([row])));await assert.rejects(u.apiDiyCombinationPreview(1,controller.signal),error=>error===reason);assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});

test('ignored-abort late pink transport cannot expose complete old-context preview',async()=>{
 const wait=deferred(),u=setup(call=>call.url==='/api/pink'?wait.promise:response()),controller=new AbortController(),reason=new Error('late summary'),job=u.apiDiyCombinationPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);for(let i=0;i<8&&u.calls.length<2;i++)await Promise.resolve();assert.equal(u.calls.length,2);controller.abort(reason);wait.resolve(response(envelope(summary())));await rejected;assert.deepEqual(u.forbidden,[]);
});

test('abort during second JSON parsing prevents publication of both already-read products and pink',async()=>{
 const wait=deferred(),u=setup(call=>call.url==='/api/pink'?{ok:true,status:200,json:()=>wait.promise}:response()),controller=new AbortController(),reason=new Error('late JSON'),job=u.apiDiyCombinationPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);for(let i=0;i<12&&u.calls.length<2;i++)await Promise.resolve();assert.equal(u.calls.length,2);await Promise.resolve();controller.abort(reason);wait.resolve(envelope(summary()));await rejected;assert.deepEqual(u.forbidden,[]);
});
