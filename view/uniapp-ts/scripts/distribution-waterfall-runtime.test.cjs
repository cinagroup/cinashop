const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const vue=require('vue');
const {tick}=require('./uni-store-runtime.cjs');
const source=path.join(__dirname,'../src/composables/useRecommendationWaterfall.ts');
function harness(count=10){
 const rows=vue.ref(Array.from({length:count},(_,index)=>({id:100+index}))),allowed=vue.ref(true);
 const auth=vue.reactive({uid:11,token:'owner-a',sessionVersion:1,isLoggedIn:true}),hooks={},queries=[],scopeMarker={},resizes=new Set();
 const uni={onWindowResize:fn=>resizes.add(fn),offWindowResize:fn=>resizes.delete(fn),createSelectorQuery(){
  const reads=[];let scope;
  const query={in(value){scope=value;return query;},selectAll(selector){return{fields(options,callback){assert.deepEqual(options,{rect:true,size:true,dataset:true});reads.push({selector,callback});}};},exec(done){assert.equal(scope,scopeMarker);queries.push({reads,done});}};
  return query;
 }};
 const exports={};
 new Function('require','exports','uni',ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
  if(id==='vue')return{...vue,getCurrentInstance:()=>({proxy:scopeMarker})};
  if(id==='@/stores/auth')return{useAuthStore:()=>auth};
  if(id==='@dcloudio/uni-app')return Object.fromEntries(['onShow','onHide','onUnload'].map(name=>[name,fn=>hooks[name]=fn]));
  throw Error('Unexpected layout dependency '+id);
 },exports,uni);
 const scope=vue.effectScope(),layout=scope.run(()=>exports.useRecommendationWaterfall(()=>rows.value,()=>allowed.value));
 const columns=()=>layout.columns.value.map(column=>column.map(entry=>entry.index));
 function respond(query,heights){
  const stacks=[],cards=[];
  layout.columns.value.forEach((column,side)=>{let bottom=50;
   for(const entry of column){const top=bottom+(bottom===50?0:10);bottom=top+(heights[entry.index]??100);cards.push({top,bottom,dataset:{levelProductIndex:entry.index,levelProductId:entry.item.id}});}
   stacks.push({top:50,bottom,dataset:{levelColumn:side}});
  });
  for(const read of query.reads)read.callback(read.selector==='.recommendation-column'?stacks:cards);
  query.done();
 }
 return{rows,allowed,auth,hooks,queries,layout,resizes,columns,respond,async start(){hooks.onShow();await tick();},async settle(heights=[]){let count=0;while(queries.length){assert.ok(++count<30,'finite selector work');respond(queries.shift(),heights);await tick();}},stop(){hooks.onUnload();scope.stop();}};
}
test('real scoped heights place the two PHP tail cards sequentially without dropping or guessing rows',async()=>{
 const r=harness();try{await r.start();assert.equal(r.layout.pending.value,true);assert.deepEqual(r.columns(),[[0,2,4,6,8],[1,3,5,7,9]]);
  await r.settle([120,200,120,200,120,200,120,200,150,80]);assert.deepEqual(r.columns(),[[0,2,4,6,8,9],[1,3,5,7]]);assert.equal(r.layout.pending.value,false);
  assert.deepEqual(r.layout.columns.value.flat().map(e=>e.index).sort((a,b)=>a-b),Array.from({length:10},(_,i)=>i));
 }finally{r.stop();}
});
test('three-to-seven items balance only the last card from actual prefix bottoms',async()=>{
 const r=harness(5);try{await r.start();await r.settle([200,50,200,50,75]);assert.deepEqual(r.columns(),[[0,2],[1,3,4]]);}finally{r.stop();}
});
test('append preserves all existing column membership and original logical indices',async()=>{
 const r=harness();try{await r.start();await r.settle([120,200,120,200,120,200,120,200,150,80]);const old=r.columns();
  r.rows.value=[...r.rows.value,...Array.from({length:10},(_,i)=>({id:110+i}))];await tick();await r.settle(Array(20).fill(100));
  assert.deepEqual(r.columns().map(c=>c.filter(i=>i<10)),old);assert.deepEqual(r.columns().flat().sort((a,b)=>a-b),Array.from({length:20},(_,i)=>i));
 }finally{r.stop();}
});
test('window resize remeasures the actual changed geometry rather than reusing old heights',async()=>{
 const r=harness(5);try{await r.start();await r.settle([200,50,200,50,75]);for(const fn of r.resizes)fn();await tick();await r.settle([50,200,50,200,75]);assert.deepEqual(r.columns(),[[0,2,4],[1,3]]);}finally{r.stop();}
});
test('incomplete native measurements retain every valid item and end pending work',async()=>{
 const r=harness();try{await r.start();const q=r.queries.shift();for(const read of q.reads)read.callback([]);q.done();await tick();assert.equal(r.layout.pending.value,false);assert.equal(r.columns().flat().length,10);}finally{r.stop();}
});
for(const event of ['owner','renew','hide','unload','storage','replace'])test('late native geometry cannot mutate a newer layout after '+event,async()=>{
 const r=harness();try{await r.start();const old=r.queries.shift();
  if(event==='owner'){r.auth.uid=22;r.auth.token='owner-b';r.auth.sessionVersion++;}
  if(event==='renew'){r.auth.token='renewed';r.auth.sessionVersion++;}
  if(event==='hide')r.hooks.onHide();
  if(event==='unload')r.hooks.onUnload();
  if(event==='storage')r.allowed.value=false;
  if(event==='replace')r.rows.value=[{id:900},{id:901}];
  await tick();const before=r.columns();const pending=r.layout.pending.value;r.respond(old,[500,10,500,10,500,10,500,10,500,10]);await tick();
  assert.deepEqual(r.columns(),before);assert.equal(r.layout.pending.value,pending);
 }finally{r.stop();}
});
test('empty feeds and disposal clear columns and remove only the owned resize listener',async()=>{
 const r=harness();try{await r.start();assert.equal(r.resizes.size,1);r.rows.value=[];await tick();assert.deepEqual(r.columns(),[[],[]]);assert.equal(r.layout.pending.value,false);r.hooks.onHide();assert.equal(r.resizes.size,0);r.hooks.onShow();await tick();assert.equal(r.resizes.size,1);}finally{r.stop();assert.equal(r.resizes.size,0);}
});

test('a hidden computed read cannot cache empty columns across show on the same instance',async()=>{
 const r=harness();try{await r.start();await r.settle();assert.equal(r.columns().flat().length,10);
  r.hooks.onHide();await tick();assert.deepEqual(r.columns(),[[],[]]);
  r.hooks.onShow();await tick();assert.equal(r.columns().flat().length,10);await r.settle();assert.equal(r.columns().flat().length,10);
 }finally{r.stop();}
});
