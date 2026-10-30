const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/api/diyPointsAuthor.ts');
const point = (patch = {}) => ({ id: 7, product_id: 103, title: '真实积分活动', image: '/api/assets/8?expires=9999999999&signature='+'A'.repeat(43), integral: 120, price: '5', stock: 9, sales: 3, brand_name: '品牌', ...patch });
const envelope = (value = [point()], patch = {}) => ({ status: 200, msg: 'ok', data: value, ...patch });
const response = (body = envelope(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(send = () => response()) {
  const calls = [], forbidden = [], fail = name => { forbidden.push(name); throw Error('Anonymous integral preview must not access '+name); };
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
    if(name.endsWith('/categoryCatalog'))return{parseCategoryProducts:()=>assert.fail('No product catalogue in points DTO')};
    if(name==='@/api/productRank')return{rankNavigation:()=>assert.fail('No product ranking in points DTO')};
    assert.fail('Unreviewed public dependency '+name);
  });return data.checkedCommerceCards;
}

test('direct public array maps exact current normalized CommerceCard shape while keeping activity and base product identities distinct',()=>{
  const u=setup(),raw=[point({productList:[{image:'/private.png'}],token:'ADMIN',unknown:{image:'/api/assets/99'}})],before=structuredClone(raw);
  assert.deepEqual(u.checkedDiyPointsPublicRows(raw,1),[{id:7,productId:103,title:'真实积分活动',image:raw[0].image,price:'5.00',oldPrice:'0.00',people:0,count:0,stock:9,percent:0,integral:120,status:0}]);
  assert.deepEqual(raw,before);assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});

test('actual installed public points checker matches every normalized field including ignored non-points material',()=>{
  const u=setup(),actual=publicChecker();
  for(const price of ['0',0,'3.5','9999999999.99']){
    const raw=[point({price,ot_price:'bad',people:'unused',percent:-1,status:'unused',integral:0,stock:0}),point({id:8,product_id:7,title:'第二活动',integral:2147483647})];
    assert.deepEqual(u.checkedDiyPointsPublicRows(raw,2),actual('pointsMall',raw,2));
  }
});

test('full-array validation rejects malformed duplicate and sparse tails without filtering truncation or mutation',()=>{
  const u=setup();for(const raw of [[point(),point({id:8,integral:-1})],[point(),point({title:'duplicate'})],[point(),null],[point(),false],Array(1)]){const before=structuredClone(raw);assert.throws(()=>u.checkedDiyPointsPublicRows(raw,2),/格式错误|重复/);assert.deepEqual(raw,before);}
  assert.throws(()=>u.checkedDiyPointsPublicRows([point(),point({id:8})],1),/列表/);
});

test('activity ID base product ID integral and stock require int32 numbers without coercion',()=>{
  const u=setup();for(const key of ['id','product_id','stock','integral'])for(const value of [undefined,null,false,'7',-1,.5,2147483648,NaN,Infinity,{}])assert.throws(()=>u.checkedDiyPointsPublicRows([point({[key]:value})],1),/格式错误/);
  for(const key of ['id','product_id'])assert.throws(()=>u.checkedDiyPointsPublicRows([point({[key]:0})],1));
  assert.equal(u.checkedDiyPointsPublicRows([point({integral:0,stock:0})],1)[0].integral,0);
});

test('money is the existing strict public two-decimal contract and never float-guesses malformed spellings',()=>{
  const u=setup();for(const[raw,normalized]of[[0,'0.00'],['0','0.00'],[8.5,'8.50'],['0.01','0.01'],['9999999999.99','9999999999.99']])assert.equal(u.checkedDiyPointsPublicRows([point({price:raw})],1)[0].price,normalized);
  for(const price of[undefined,null,false,'',' 5 ','00','1e2','.5','-1','-0.00','1.001','10000000000',NaN,Infinity])assert.throws(()=>u.checkedDiyPointsPublicRows([point({price})],1),/金额格式错误/);
});

test('title and image text use current public bounds and control-character rejection',()=>{
  const u=setup();assert.equal(u.checkedDiyPointsPublicRows([point({title:''})],1)[0].title,'');assert.equal(u.checkedDiyPointsPublicRows([point({title:'积'.repeat(1024)})],1)[0].title.length,1024);
  for(const title of[undefined,null,7,{},'积'.repeat(1025),'控制\n字符','\u0000','\u007f'])assert.throws(()=>u.checkedDiyPointsPublicRows([point({title})],1),/文字格式错误/);
  for(const image of[undefined,null,7,{},'a'.repeat(8193),'控制\n字符'])assert.throws(()=>u.checkedDiyPointsPublicRows([point({image})],1),/文字格式错误/);
});

test('business image URL projection is the actual public H5 contract including HTTP upgrade static raster data and unsafe empty fallback',()=>{
  const u=setup(),actual=publicChecker();for(const image of['',' https://images.example.com/x.png ','http://images.example.com/x.png','/static/images/a.png','/api/assets/13?expires=1&signature=old','data:image/png;base64,AAA','data:image/webp;base64,AAA','data:image/svg+xml;base64,AAA','javascript:alert(1)','//external.example/x','a'.repeat(4097)]){
    const raw=[point({image})],before=structuredClone(raw);assert.deepEqual(u.checkedDiyPointsPublicRows(raw,1),actual('pointsMall',raw,1));assert.deepEqual(raw,before);
  }
});

test('root must be the actual direct array rather than Admin camelCase product list or fabricated envelope',()=>{
  const u=setup();for(const raw of[undefined,null,false,{},'[]',{list:[point()],count:1},{data:[point()]},[{id:7,productId:103,storeName:'Admin',image:'/a.png',integral:120,price:5,stock:9}]])assert.throws(()=>u.checkedDiyPointsPublicRows(raw,1),/格式错误/);
  assert.deepEqual(u.checkedDiyPointsPublicRows([],10),[]);
});

test('strict1..10 limit rejects invalid input before I/O or payload inspection',async()=>{
  const u=setup();for(const limit of[undefined,null,false,'3',0,-1,1.5,11,100,NaN,Infinity]){assert.throws(()=>u.checkedDiyPointsPublicRows([],limit),/整数/);await assert.rejects(u.apiDiyPointsPreview(limit),/整数/);}assert.deepEqual(u.calls,[]);assert.deepEqual(u.forbidden,[]);
});

test('actual guest adapter sends exactly one fixed GET signal Accept-only omit/no-store despite localhost preview=1',async()=>{
  const u=setup(),controller=new AbortController(),rows=await u.apiDiyPointsPreview(3,controller.signal);assert.equal(rows[0].id,7);assert.equal(u.calls.length,1);const{url,init}=u.calls[0];
  assert.equal(url,'/api/store_integral/list?page=1&limit=3');assert.deepEqual(Object.keys(init).sort(),['cache','credentials','headers','method','signal']);assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.deepEqual(init.headers,{Accept:'application/json'});assert.strictEqual(init.signal,controller.signal);assert.equal(Object.hasOwn(init,'body'),false);assert.deepEqual(u.forbidden,[]);
});

test('optional signal and empty live feed do not create fixtures credentials selectedIDs filters or writes',async()=>{
  const u=setup(()=>response(envelope([])));assert.deepEqual(await u.apiDiyPointsPreview(10),[]);assert.equal(u.calls[0].url,'/api/store_integral/list?page=1&limit=10');assert.equal(u.calls[0].init.signal,undefined);assert.deepEqual(u.forbidden,[]);
});

test('network HTTP business and malformed JSON failures remain explicit without demo recovery',async()=>{
  for(const send of[()=>{throw Error('owned network failure');},()=>response(envelope(),503),()=>response(envelope(null,{status:400,msg:'真实错误'})),()=>({ok:true,status:200,json:async()=>{throw Error('bad JSON');}})]){const u=setup(send);await assert.rejects(u.apiDiyPointsPreview(1));assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);}
});

test('all HTTP-success envelope fields remain required before public rows are exposed',async()=>{
  for(const body of[null,[],false,{}, {status:'200',msg:'ok',data:[point()]},{status:200,data:[point()]},{status:200,msg:null,data:[point()]},{status:200,msg:'ok'},envelope(null)]){const u=setup(()=>response(body));await assert.rejects(u.apiDiyPointsPreview(1),/格式错误/);assert.equal(u.calls.length,1);}
});

test('whole-array failed response can explicitly retry without POST exchange controller storage or partial material',async()=>{
  let invalid=true;const u=setup(()=>response(envelope(invalid?[point(),point({id:8,stock:-1})]:[point()])));await assert.rejects(u.apiDiyPointsPreview(2),/格式错误/);invalid=false;assert.equal((await u.apiDiyPointsPreview(2))[0].id,7);assert.equal(u.calls.length,2);assert.ok(u.calls.every(call=>call.init.method==='GET'&&call.url==='/api/store_integral/list?page=1&limit=2'));assert.deepEqual(u.forbidden,[]);
});

test('pre-cancelled signal forbids transport and retains exact cancellation reason',async()=>{
  const u=setup(),controller=new AbortController(),reason=new Error('owned cancellation');controller.abort(reason);await assert.rejects(u.apiDiyPointsPreview(1,controller.signal),error=>error===reason);assert.deepEqual(u.calls,[]);
});

test('late ignored-abort transport receipt cannot expose rows from an old context',async()=>{
  const wait=deferred(),u=setup(()=>wait.promise),controller=new AbortController(),reason=new Error('owner changed');const job=u.apiDiyPointsPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);controller.abort(reason);wait.resolve(response());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});

test('cancellation while parsing response JSON also blocks row adoption and any second transport',async()=>{
  const wait=deferred(),u=setup(()=>({ok:true,status:200,json:()=>wait.promise})),controller=new AbortController(),reason=new Error('page changed');const job=u.apiDiyPointsPreview(1,controller.signal),rejected=assert.rejects(job,error=>error===reason);await Promise.resolve();await Promise.resolve();controller.abort(reason);wait.resolve(envelope());await rejected;assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);
});
