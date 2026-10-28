const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const document=(content_preview='<p style="color:#966a32">完整分销说明<strong>商家规则</strong></p>',id=81)=>({id,type:2,content_preview});
const payload=(record=document())=>({version:1,member_explain:record});
const flatten=nodes=>nodes.flatMap(node=>[node,...flatten(node.children??[])]);
const signed=(expires=Math.floor(Date.now()/1000)+900)=>'/api/assets/2?expires='+expires+'&signature='+'a'.repeat(43);
async function create(options={}) {
  const traces=[],platform=options.platform??'H5',origin=platform==='H5'?'':'https://cinashop-api.cinagroup.workers.dev';
  const r=runtime({feature:'useAgentExplanation',platform,authenticated:options.authenticated??false,send:call=>{
    traces.push({url:call.url,method:call.method,data:structuredClone(call.data),auth:call.header['Authori-zation'],form:call.header['Form-type']});
    assert.equal(call.url,origin+'/api/agent/explanation');assert.equal(call.method,'GET');assert.deepEqual(call.data,{});
    return options.send?.(call)??{data:Object.hasOwn(options,'data')?options.data:payload()};
  }});
  await r.start();return{...r,traces};
}

test('guest reads the public type2 document using one GET without login or confirmation',async()=>{
  const r=await create();try{assert.equal(r.checkout.record.value.type,2);assert.equal(r.checkout.loaded.value,true);
    const nodes=flatten(r.checkout.nodes());assert.ok(nodes.some(n=>n.name==='strong'));assert.equal(nodes.find(n=>n.name==='p').attrs.style,'color:#966a32');
    assert.equal(r.traces.length,1);assert.equal(r.traces[0].auth,undefined);assert.deepEqual(r.navigations,[]);assert.deepEqual(r.modals,[]);
  }finally{r.stop();}
});
for(const platform of ['H5','MP-WEIXIN','APP-PLUS'])test(platform+' public reads preserve complete document and native media origin',async()=>{
  const preview=signed(),body='<p>说明<img src="'+preview.replaceAll('&','&amp;')+'"></p>';
  const r=await create({platform,data:payload(document(body))});try{
    const nodes=flatten(r.checkout.nodes()),image=nodes.find(n=>n.name==='img');
    assert.equal(image.attrs.src,(platform==='H5'?'':'https://cinashop-api.cinagroup.workers.dev')+preview);
    assert.equal(image.interactive,true);assert.equal(nodes.find(n=>n.name==='p').interactive,true);
    assert.equal(r.traces[0].form,{H5:'h5','MP-WEIXIN':'routine','APP-PLUS':'app'}[platform]);
  }finally{r.stop();}
});
test('missing record and configured empty body remain distinct and readable for guests',async()=>{
  for(const row of [null,document('')]){const r=await create({data:payload(row)});try{assert.equal(r.checkout.loaded.value,true);assert.equal(r.checkout.empty.value,row===null);assert.deepEqual(r.checkout.nodes(),[]);assert.equal(r.traces.length,1);}finally{r.stop();}}
});
test('signed historical int32 document identities are retained without a positivity gate',async()=>{
  for(const id of [-2147483648,-1,0,2147483647]){const r=await create({data:payload(document('<p>历史说明</p>',id))});try{assert.equal(r.checkout.record.value.id,id);}finally{r.stop();}}
});
for(const bad of [null,[],{},payload([]),{...payload(),version:2},{...payload(),extra:true},payload({...document(),type:1}),payload({...document(),id:2147483648}),payload({...document(),id:-2147483649}),payload({...document(),id:1.2}),payload({...document(),content_preview:null}),payload({...document(),content_preview:42}),payload({...document(),extra:1})])test('malformed public DTO becomes a recoverable read error: '+JSON.stringify(bad).slice(0,90),async()=>{
  const r=await create({data:bad});try{assert.equal(r.checkout.record.value,null);assert.equal(r.checkout.loaded.value,false);assert.ok(r.checkout.error.value);assert.deepEqual(r.checkout.nodes(),[]);assert.deepEqual(r.modals,[]);}finally{r.stop();}
});
test('full4MB UTF8 body is preserved, while oversize/token/media excess is rejected without truncation',async()=>{
  const body='<p>'+'x'.repeat(4_000_000-7)+'</p>',r=await create({data:payload(document(body))});try{assert.equal(Buffer.byteLength(r.checkout.record.value.content_preview),4_000_000);assert.equal(flatten(r.checkout.nodes()).find(n=>n.type==='text').text.length,4_000_000-7);}finally{r.stop();}
  for(const html of ['汉'.repeat(1_333_334),'<br>'.repeat(100_001),'<img src="/static/logo.png">'.repeat(10_001)]){const r=await create({data:payload(document(html))});try{assert.equal(r.checkout.record.value,null);assert.ok(r.checkout.error.value);}finally{r.stop();}}
});
test('untrusted HTML is sanitized and unsigned or unsafe image references become unavailable text',async()=>{
  const r=await create({data:payload(document('<script>bad()</script><style>bad</style><p onclick="bad()" style="color:#966a32;background:url(javascript:bad())">正文<img src="/api/assets/2"><img src="javascript:bad()"><a href="javascript:bad()">链接</a></p>'))});try{
    const nodes=flatten(r.checkout.nodes());assert.ok(!nodes.some(n=>['script','style'].includes(n.name)));
    assert.ok(!nodes.some(n=>n.attrs?.onclick||n.attrs?.href?.startsWith('javascript:')||n.attrs?.src?.startsWith('javascript:')));
    assert.equal(nodes.find(n=>n.name==='p').attrs.style,'color:#966a32');assert.ok(nodes.some(n=>n.type==='text'&&n.text==='图片暂不可用'));
  }finally{r.stop();}
});
for(const event of ['onHide','onUnload','owner','logout','renew'])test('held public response after '+event+' cannot replace the current document',async()=>{
  const late=deferred();let calls=0;const r=await create({authenticated:true,send:()=>++calls===1?late.promise:{data:payload(document('<p>新页面说明</p>'))}});try{
    if(event==='owner')r.auth.setLogin('other',22);else if(event==='logout')r.auth.clear();else if(event==='renew')r.auth.setLogin(r.auth.token,11);else r.hooks[event]();
    late.resolve({data:payload(document('<p>旧页面说明</p>'))});await tick();
    if(['owner','logout','renew'].includes(event)){assert.equal(r.checkout.record.value.content_preview,'<p>新页面说明</p>');assert.equal(r.traces.length,2);if(event==='logout')assert.equal(r.traces[1].auth,undefined);}
    else{assert.equal(r.checkout.record.value,null);assert.deepEqual(r.checkout.nodes(),[]);}
    assert.equal(r.checkout.loading.value,false);
  }finally{r.stop();}
});
test('persisted owner drift immediately fences existing interaction and read capabilities',async()=>{
  const r=await create({authenticated:true});try{const old=r.checkout.view();assert.equal(old.allowed(),true);r.storage.set('uni_token','other');r.storage.set('uni_uid',22);
    assert.equal(old.allowed(),false);old.open('/pages/user/agentExplanation');old.reload();await r.checkout.load();assert.deepEqual(r.checkout.nodes(),[]);assert.equal(r.traces.length,1);assert.deepEqual(r.navigations,[]);
  }finally{r.stop();}
});
test('manual retry clears old body while waiting and a failed retry never keeps stale content',async()=>{
  const late=deferred();let count=0;const r=await create({send:()=>++count===1?{data:payload()}:late.promise});try{
    const old=r.checkout.view(),pending=r.checkout.load();assert.equal(old.allowed(),false);assert.equal(r.checkout.record.value,null);
    late.resolve({transport:'offline'});await pending;assert.equal(r.checkout.record.value,null);assert.match(r.checkout.error.value,/offline/);assert.equal(r.traces.length,2);
  }finally{r.stop();}
});
test('hide and show reload the public document after an Admin update',async()=>{
  let count=0;const r=await create({send:()=>({data:payload(document('<p>版本'+(++count)+'</p>'))})});try{r.hooks.onHide();assert.equal(r.checkout.record.value,null);r.hooks.onShow();await tick();assert.equal(r.checkout.record.value.content_preview,'<p>版本2</p>');assert.equal(r.traces.length,2);}finally{r.stop();}
});
test('expired media closes old document interactions and only explicit reload renews its tickets',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date','setTimeout'],now});let count=0;
  const r=await create({send:()=>({data:payload(document('<p><img src="'+signed(Math.floor(now/1000)+(++count===1?30:930)).replaceAll('&','&amp;')+'"></p>'))})});try{
    const old=r.checkout.view();assert.equal(old.allowed(),true);t.mock.timers.setTime(now+31_000);assert.equal(old.allowed(),false);old.reload();old.open('/pages/user/agentExplanation');assert.equal(r.traces.length,1);assert.deepEqual(r.navigations,[]);
    t.mock.timers.tick(1);assert.equal(r.checkout.mediaExpired.value,true);assert.ok(flatten(r.checkout.nodes()).some(n=>n.text==='图片暂不可用'));
    await r.checkout.load();assert.equal(r.checkout.mediaExpired.value,false);assert.equal(r.traces.length,2);
  }finally{r.stop();}
});
test('public read deadline settles and remains manually retryable',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout']});const held=deferred(),r=await create({send:()=>held.promise});try{assert.equal(r.checkout.loading.value,true);t.mock.timers.tick(12_000);await tick();assert.equal(r.checkout.loading.value,false);assert.match(r.checkout.error.value,/超时/);assert.equal(r.checkout.record.value,null);}finally{r.stop();}
});
test('actual native image error and retry handlers are document-scoped and ignore late events',()=>{
  let active=true,reloads=0;const r=runtime({component:'components/agent/AgentExplanationImage.vue',authenticated:false,props:{src:'/static/document.png',allowed:()=>active},emit:name=>{if(name==='reload')reloads++;}});try{
    const s=r.checkout,events=s.image.value;events.loaded({detail:{width:81}});assert.equal(s.width.value,81);for(const event of [null,new Event('load'),{detail:{width:-1}},{detail:{width:Infinity}},{detail:{width:'99'}}])events.loaded(event);assert.equal(s.width.value,81);events.failed();assert.equal(s.failed.value,true);events.retry();assert.equal(reloads,1);
    active=false;events.loaded({detail:{width:999}});events.retry();assert.equal(s.width.value,81);assert.equal(reloads,1);
  }finally{r.stop();}
});
test('real finance entry resolves the PHP alias for signed-in users and guests',async()=>{
  for(const [authenticated,storage]of [[true,new Map()],[false,new Map()],[false,new Map([['uni_token',''],['uni_uid','']])]]){const r=runtime({component:'pages/user/finance.vue',authenticated,storage,send:()=>({data:[]})});try{await r.start();r.checkout.openAgentExplanation();assert.deepEqual(r.navigations,['/pages/user/agentExplanation']);r.hooks.onHide();r.checkout.openAgentExplanation();assert.equal(r.navigations.length,1);}finally{r.stop();}}
});
test('real templates compile, registered legacy destination is complete, and original PHP icon bytes are retained',()=>{
  const {parse,compileTemplate}=require('@vue/compiler-sfc');
  for(const file of ['src/pages/user/agentExplanation.vue','src/components/agent/AgentExplanationImage.vue','src/components/agent/AgentExplanationRichNode.vue','src/pages/user/finance.vue']){const name=path.join(__dirname,'..',file);assert.deepEqual(compileTemplate({source:parse(fs.readFileSync(name,'utf8')).descriptor.template.content,filename:name,id:file}).errors,[]);}
  const r=runtime({feature:'useAgentExplanation',authenticated:false});try{const nav=r.load(path.join(__dirname,'../src/config/navigation.ts'));assert.equal(nav.resolveRegisteredPageRoute('/pages/users/user_distribution_info/index'),'/pages/user/agentExplanation');assert.equal(nav.resolveRegisteredPageRoute('/pages/user/agentExplanation'),'/pages/user/agentExplanation');}finally{r.stop();}
  const root=path.join(__dirname,'../src/static/php-agent-explanation'),provenance=JSON.parse(fs.readFileSync(path.join(root,'provenance.json'),'utf8'));assert.equal(provenance.php_ref,'8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');assert.equal(provenance.assets.length,1);
  const b=fs.readFileSync(path.join(root,'spread_sm.png'));assert.equal(b.length,3597);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),'3da112701fb32a25f56568d0e10817a2de75a03591a52ac3a8566733e1a672a3');assert.equal(provenance.assets[0].sha256,crypto.createHash('sha256').update(b).digest('hex'));
});
