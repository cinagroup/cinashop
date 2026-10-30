const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const file=path.resolve(__dirname,'../src/api/diySeckillAuthor.ts'),common=path.resolve(__dirname,'../../common/diySeckillData.ts');
const product=(extra={})=>({id:901,product_id:201,activity_id:301,title:'真实秒杀商品',image:'/static/business.png',activity_image:'/images/frame.png',price:'6.25',ot_price:'99.9',stock:7,percent:30,...extra});
const slot=(id=101,extra={})=>({id,start_time:'08:00',end_time:'10:00',state:'疯抢中',stop:1792900800,status:1,...extra});
const index=(extra={})=>({seckillTime:[slot(),slot(102,{status:2,state:'即将开始'})],seckillTimeIndex:1,...extra});
const envelope=(data,extra={})=>({status:200,msg:'ok',data,...extra});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function setup(send){
 const calls=[],forbidden=[],fail=name=>{forbidden.push(name);throw Error('Anonymous seckill must not access '+name);},cache=new Map();
 function load(target){if(cache.has(target))return cache.get(target);assert.ok([file,common].includes(target),'Only API and pure shared validation may load: '+target);const exports={};cache.set(target,exports);const source=ts.transpileModule(fs.readFileSync(target,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require','fetch','window','localStorage','uni',source)(exports,id=>id==='../../../common/diySeckillData'?load(common):fail('application import '+id),async(url,init)=>{const call={url,init};calls.push(call);return send?send(call):response(envelope(url==='/api/seckill/index'?index():[product()]));},
 {location:{hostname:'localhost',search:'?preview=1&token=ADMIN'}},{getItem:()=>fail('Admin storage read'),setItem:()=>fail('Admin storage write')},{getStorageSync:()=>fail('journal'),setStorageSync:()=>fail('journal write'),navigateTo:()=>fail('navigation'),requestSubscribeMessage:()=>fail('SDK')});return exports;}
 return{...load(file),shared:load(common),calls,forbidden};
}
function actualSafeImage(){const file=path.resolve(__dirname,'../../uniapp-ts/src/utils/diy.ts'),raw=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,raw,ts.ScriptTarget.Latest,true),wanted=new Set(['asDiyRecord','safeDiyImageUrl','safeDiyColor']),chunks=[];for(const node of tree.statements)if(ts.isFunctionDeclaration(node)&&wanted.has(node.name?.text))chunks.push(node.getText(tree));assert.equal(chunks.length,3);const exports={};new Function('exports','API_BASE',ts.transpileModule(chunks.join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,'');return exports.safeDiyImageUrl;}

test('complete public row keeps three distinct IDs and safe parent image but drops unknown private metadata without mutation',()=>{
 const u=setup(),raw=[product({unknown:{image:'/api/assets/99'},system_form_id:77,people:999,quota:100,sales:300})],before=structuredClone(raw);assert.deepEqual(u.checkedDiySeckillPublicRows(raw,1),[{id:901,productId:201,activityId:301,title:'真实秒杀商品',image:'/static/business.png',activityImage:'/images/frame.png',price:'6.25',oldPrice:'99.90',stock:7,percent:30,people:0,count:0,integral:0,status:0}]);assert.deepEqual(raw,before);assert.deepEqual(u.calls,[]);
});
test('both image fields match the installed Uni public safety projection, never becoming a saved author slot',()=>{
 const u=setup(),safe=actualSafeImage();for(const image of['',' https://images.example/a.png ','http://images.example/a.png','/static/a.png','/api/assets/61?expires=1&signature=old','data:image/png;base64,AAA','data:image/svg+xml;base64,AAA','javascript:alert(1)','//evil.example/a','x'.repeat(4097)]){const raw=[product({image,activity_image:image})],before=structuredClone(raw),row=u.checkedDiySeckillPublicRows(raw,1)[0];assert.equal(row.image,safe(image));assert.equal(row.activityImage,safe(image));assert.deepEqual(raw,before);}
});
test('whole product lists reject malformed sparse duplicate and overlimit tails without filtering or partial results',()=>{
 const u=setup();for(const raw of[[product(),product({stock:-1,id:902})],[product(),product()],[product(),null],[product(),false],Array(1)]){const before=structuredClone(raw);assert.throws(()=>u.checkedDiySeckillPublicRows(raw,2));assert.deepEqual(raw,before);}assert.throws(()=>u.checkedDiySeckillPublicRows([product(),product({id:902})],1));for(const raw of[null,{},false,{list:[product()],count:1}])assert.throws(()=>u.checkedDiySeckillPublicRows(raw,1));assert.deepEqual(u.checkedDiySeckillPublicRows([],1),[]);
});
test('integer identity stock and percent boundaries are exact without coercion or foreign aliases',()=>{
 const u=setup();for(const key of['id','product_id','activity_id','stock'])for(const value of[undefined,null,false,'1',-1,.5,2147483648,NaN,Infinity,{}])assert.throws(()=>u.checkedDiySeckillPublicRows([product({[key]:value})],1));for(const key of['id','product_id'])assert.throws(()=>u.checkedDiySeckillPublicRows([product({[key]:0})],1));assert.equal(u.checkedDiySeckillPublicRows([product({activity_id:0,stock:0})],1)[0].activityId,0);for(const percent of[undefined,null,'30',-1,100.1,NaN,Infinity])assert.throws(()=>u.checkedDiySeckillPublicRows([product({percent})],1));for(const percent of[0,33.3,100])assert.equal(u.checkedDiySeckillPublicRows([product({percent})],1)[0].percent,percent);
});
test('sale and activity old prices preserve normalized independent zero fixed2 money',()=>{
 const u=setup();for(const[raw,want]of[[0,'0.00'],['0','0.00'],['0.01','0.01'],[8.5,'8.50'],['9999999999.99','9999999999.99']])for(const key of['price','ot_price'])assert.equal(u.checkedDiySeckillPublicRows([product({[key]:raw})],1)[0][key==='price'?'price':'oldPrice'],want);for(const raw of[undefined,null,false,'',' 3 ','00','1e2','.5','-1','1.001','10000000000',NaN,Infinity])for(const key of['price','ot_price'])assert.throws(()=>u.checkedDiySeckillPublicRows([product({[key]:raw})],1));
});
test('all name and business picture strings are validated including every full tail',()=>{
 const u=setup();for(const key of['title','image','activity_image'])for(const value of[undefined,null,7,{},'\u0000','bad\nline','\u007f'])assert.throws(()=>u.checkedDiySeckillPublicRows([product({[key]:value})],1));assert.throws(()=>u.checkedDiySeckillPublicRows([product({title:'x'.repeat(1025)})],1));for(const key of['image','activity_image'])assert.throws(()=>u.checkedDiySeckillPublicRows([product({[key]:'x'.repeat(8193)})],1));
});
test('complete index projection keeps server position and all1000 slots without an alternate picker or mutation',()=>{
 const u=setup(),raw=index(),before=structuredClone(raw);assert.deepEqual(u.checkedDiySeckillPublicIndex(raw),{slots:raw.seckillTime,index:1});assert.deepEqual(raw,before);const many=index({seckillTime:Array.from({length:1000},(_,i)=>slot(i+1)),seckillTimeIndex:999});assert.equal(u.checkedDiySeckillPublicIndex(many).slots.length,1000);assert.equal(u.checkedDiySeckillPublicIndex(many).index,999);assert.throws(()=>u.checkedDiySeckillPublicIndex({...many,seckillTime:[...many.seckillTime,slot(1001)]}));
});
test('malformed duplicate sparse tail slots or invalid server index reject the entire index before list I/O',async()=>{
 for(const raw of[index({seckillTime:[slot(),slot()]}),index({seckillTime:[slot(),null]}),index({seckillTime:Array(1)}),index({seckillTimeIndex:2}),index({seckillTimeIndex:-2}),index({seckillTimeIndex:'0'}),null,{},false]){const u=setup(()=>response(envelope(raw)));assert.throws(()=>u.checkedDiySeckillPublicIndex(raw));await assert.rejects(u.apiDiySeckillPreview(1));assert.equal(u.calls.length,1);}
});
test('every raw index field remains typed and bounded without fabricating dates or substituting a valid neighbour',()=>{
 const u=setup();for(const key of['id','status','stop'])for(const value of[undefined,null,false,'1',-1,.5,Infinity])assert.throws(()=>u.checkedDiySeckillPublicIndex(index({seckillTime:[slot(101,{[key]:value})],seckillTimeIndex:0})));assert.throws(()=>u.checkedDiySeckillPublicIndex(index({seckillTime:[slot(101,{status:3})],seckillTimeIndex:0})));for(const key of['start_time','end_time','state'])for(const value of[undefined,null,1,'bad\nline','x'.repeat(key==='state'?65:17)])assert.throws(()=>u.checkedDiySeckillPublicIndex(index({seckillTime:[slot(101,{[key]:value})],seckillTimeIndex:0})));
});
test('strict1..10 limit is rejected before index payload inspection or any I/O',async()=>{
 const u=setup();for(const count of[undefined,null,false,'3',0,-1,1.5,11,NaN,Infinity]){assert.throws(()=>u.checkedDiySeckillPublicRows([],count),/整数/);await assert.rejects(u.apiDiySeckillPreview(count),/整数/);}assert.deepEqual(u.calls,[]);
});
test('exactly two sequential anonymous GETs use only the server-selected slot and the same original AbortSignal',async()=>{
 const u=setup(),controller=new AbortController(),result=await u.apiDiySeckillPreview(3,controller.signal);assert.equal(result.products[0].id,901);assert.equal(result.slot.id,102);assert.deepEqual(u.calls,[{url:'/api/seckill/index',init:{method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal}},{url:'/api/seckill/list/102?page=1&limit=3&type=index',init:{method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal}}]);assert.deepEqual(u.forbidden,[]);
});
test('server minus1 produces an empty preview without selecting any active or upcoming substitute slot',async()=>{
 for(const seckillTime of[[slot()],[]]){const u=setup(()=>response(envelope({seckillTime,seckillTimeIndex:-1})));assert.deepEqual(await u.apiDiySeckillPreview(1),{products:[],slot:null});assert.equal(u.calls.length,1);assert.deepEqual(u.forbidden,[]);}
});
test('valid empty product list keeps its actual selected slot and never manufactures demo products on localhost preview',async()=>{
 const u=setup(call=>response(envelope(call.url==='/api/seckill/index'?index():[])));const result=await u.apiDiySeckillPreview(1);assert.deepEqual(result,{products:[],slot:slot(102,{status:2,state:'即将开始'})});assert.equal(u.calls.length,2);assert.equal(u.calls[0].init.signal,undefined);assert.deepEqual(u.forbidden,[]);
});
test('failed index or failed list never falls back to a different slot or returns partial material',async()=>{
 for(const phase of['index','list'])for(const bad of[()=>{throw Error('network failed');},()=>response(envelope(null),503),()=>response({status:'200',msg:'ok',data:[]}),()=>({ok:true,status:200,json:async()=>{throw Error('bad JSON');}})]){const u=setup(call=>call.url==='/api/seckill/index'&&phase==='list'?response(envelope(index())):bad());await assert.rejects(u.apiDiySeckillPreview(1));assert.equal(u.calls.length,phase==='index'?1:2);assert.deepEqual(u.forbidden,[]);}
});
test('malformed response envelopes and overlimit product tails do not become a successful preview',async()=>{
 for(const body of[null,false,[],{}, {status:200,data:index()},{status:200,msg:null,data:index()},{status:200,msg:'ok'},envelope(index(),{status:400000,msg:'business failed'})]){const u=setup(()=>response(body));await assert.rejects(u.apiDiySeckillPreview(1));assert.equal(u.calls.length,1);}const u=setup(call=>response(envelope(call.url==='/api/seckill/index'?index():[product(),product({id:902})])));await assert.rejects(u.apiDiySeckillPreview(1));assert.equal(u.calls.length,2);
});
test('already aborted request has no network and retains the exact cancellation reason',async()=>{const u=setup(),c=new AbortController(),reason=Error('owner changed');c.abort(reason);await assert.rejects(u.apiDiySeckillPreview(1,c.signal),error=>error===reason);assert.deepEqual(u.calls,[]);});
for(const phase of['index','list'])test(`ignored transport abort during${phase} cannot expose stale material or advance the next phase`,async()=>{
 const wait=deferred(),entered=deferred(),c=new AbortController(),reason=Error('context changed'),u=setup(call=>{if(call.url==='/api/seckill/index'&&phase==='list')return response(envelope(index()));entered.resolve();return wait.promise;}),job=u.apiDiySeckillPreview(1,c.signal),rejected=assert.rejects(job,error=>error===reason);await entered.promise;c.abort(reason);wait.resolve(response(envelope(phase==='index'?index():[product()])));await rejected;assert.equal(u.calls.length,phase==='index'?1:2);
});
for(const phase of['index','list'])test(`abort during${phase} JSON parsing blocks adoption even if native fetch ignored the signal`,async()=>{
 const wait=deferred(),entered=deferred(),c=new AbortController(),reason=Error('page changed'),u=setup(call=>call.url==='/api/seckill/index'&&phase==='list'?response(envelope(index())):{ok:true,status:200,json:()=>{entered.resolve();return wait.promise;}}),job=u.apiDiySeckillPreview(1,c.signal),rejected=assert.rejects(job,error=>error===reason);await entered.promise;c.abort(reason);wait.resolve(envelope(phase==='index'?index():[product()]));await rejected;assert.equal(u.calls.length,phase==='index'?1:2);
});
test('abort while validating the full index stops the list request after validation, without alternate-slot I/O',async()=>{
 const c=new AbortController(),reason=Error('raw index context changed'),raw=index();Object.defineProperty(raw.seckillTime[1],'stop',{enumerable:true,get(){c.abort(reason);return slot().stop;}});const u=setup(()=>response(envelope(raw)));await assert.rejects(u.apiDiySeckillPreview(1,c.signal),error=>error===reason);assert.equal(u.calls.length,1);
});
test('abort while validating a final product rejects the complete pending preview',async()=>{
 const c=new AbortController(),reason=Error('raw block changed'),row=product();Object.defineProperty(row,'percent',{enumerable:true,get(){c.abort(reason);return 30;}});const u=setup(call=>response(envelope(call.url==='/api/seckill/index'?index():[row])));await assert.rejects(u.apiDiySeckillPreview(1,c.signal),error=>error===reason);assert.equal(u.calls.length,2);assert.deepEqual(u.forbidden,[]);
});
