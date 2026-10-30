const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {runtime,tick,deferred,render}=require('./user-center-runtime.cjs');
const {make,choose,capability}=require('./customer-work-cashier-runtime.test.cjs');
const root=path.resolve(__dirname,'..'),base='/api/mobile/work/cashier/second-card';
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const sign=value=>({...value,consistency_key:digest({version:value.version,actor_uid:value.actor_uid,service_id:value.principal.service_id,scope_key:value.scope_key,data:value.data})});

test('actual cashier page uses independent capability while ordinary App context remains false',async()=>{
  const {r}=make({images:true});try{
    // A real mounted template reads both computed refs before the GET resolves.
    assert.equal(r.page.cashierCapabilities.ready.value,false);assert.equal(r.page.cashierCapabilities.imagesReady.value,false);
    await choose(r);assert.equal(r.page.manager.context.value.data.capabilities.cashier_second_card,false);
    assert.equal(r.page.cashierCapabilities.ready.value,true);assert.equal(r.page.cashierCapabilities.imagesReady.value,true);assert.ok(r.calls.some(c=>c.url===base+'/capabilities'));
    assert.ok(r.calls.some(c=>c.url==='/api/mobile/work/users'));assert.ok(r.calls.some(c=>c.url==='/api/mobile/work/users/21'));
    const ordinaryKey=r.page.manager.context.value.consistency_key;await r.page.prepare();assert.ok(r.page.operations.quote.value);assert.equal(r.page.manager.context.value.consistency_key,ordinaryKey);
  }finally{r.stop();}
});
test('an ordinary App true flag cannot grant a denied Cashier capability',async()=>{
  const {r}=make({capability:false},(call,server)=>{const answer=server.dispatch(call);if(call.url.endsWith('/context'))answer.data.data.capabilities.cashier_second_card=true;return answer;});
  try{await r.start();assert.equal(r.page.manager.context.value.data.capabilities.cashier_second_card,true);assert.equal(r.page.cashierCapabilities.ready.value,false);
    assert.equal(r.calls.some(c=>c.url===base+'/catalog'),false);await assert.rejects(r.page.catalog.users(),/权限/);assert.equal(r.auth.uid,11);
  }finally{r.stop();}
});
for(const [name,mutate]of [
  ['actor',v=>{v.actor_uid=12;}],['service',v=>{v.principal.service_id=2;}],['scope',v=>{v.scope_key='c'.repeat(64);}],
  ['digest',v=>{v.consistency_key='a'.repeat(64);}],['coherence',v=>{v.data.readiness.conditional.ready=false;v.data.readiness.conditional.reason='unavailable';}],
  ['lease',v=>{v.data.lease.expires_at=v.data.lease.issued_at+61;}],['extra',v=>{v.data.role='not-a-client-authority';}],
])test('actual capability parser refuses '+name+' without invalidating ordinary App context',async()=>{
  const {r}=make({},(call,server)=>{const answer=server.dispatch(call);if(call.url===base+'/capabilities'){mutate(answer.data);if(name!=='digest')answer.data=sign(answer.data);}return answer;});
  try{await r.start();assert.ok(r.page.manager.context.value);assert.equal(r.page.cashierCapabilities.state.value,null);assert.equal(r.page.cashierCapabilities.ready.value,false);
    assert.match(r.page.cashierCapabilities.error.value,/不匹配/);assert.equal(r.calls.some(c=>c.url===base+'/catalog'),false);assert.equal(r.auth.uid,11);
  }finally{r.stop();}
});
test('partial image readiness preserves base selection but prevents image preparation',async()=>{
  const {r}=make();try{await choose(r);assert.equal(r.page.cashierCapabilities.ready.value,true);assert.equal(r.page.cashierCapabilities.imagesReady.value,false);
    assert.throws(()=>r.page.cashierCapabilities.requireAuthority(true),/图片/);await r.page.prepare();assert.ok(r.page.operations.quote.value);
  }finally{r.stop();}
});
test('late capability after same-UID login replacement cannot authorize a new page session',async()=>{
  const late=deferred();let first=true;const {r}=make({},(call,server)=>call.url===base+'/capabilities'&&first?(first=false,late.promise):server.dispatch(call));
  try{await r.start();assert.equal(r.page.cashierCapabilities.state.value,null);r.auth.setLogin('other',12);r.auth.setLogin('fresh-token',11);await tick();
    const fresh=r.page.cashierCapabilities.state.value;assert.ok(fresh);late.resolve({httpStatus:403,status:410001,msg:'old session failure'});await tick();
    assert.equal(r.auth.token,'fresh-token');assert.equal(r.page.cashierCapabilities.state.value,fresh);assert.equal(r.page.manager.context.value.actor_uid,11);
  }finally{r.stop();}
});
test('hidden page discards delayed capability and private catalog state',async()=>{
  const late=deferred();const {r}=make({},(call,server)=>call.url===base+'/capabilities'?late.promise:server.dispatch(call));
  try{await r.start();r.hooks.onHide();late.resolve({data:capability()});await tick();assert.equal(r.page.cashierCapabilities.state.value,null);
    assert.equal(r.page.catalogList.value,null);assert.equal(r.calls.some(c=>c.url===base+'/catalog'),false);
  }finally{r.stop();}
});
test('capability loss leaves original UUID recovery available and blocks new authors',async()=>{
  const options={}, {r}=make(options);try{await choose(r);await r.page.prepare();const intent=r.page.operations.pending.value[0];assert.ok(intent);
    options.capability=false;await r.page.manager.load();assert.equal(r.page.cashierCapabilities.ready.value,false);assert.equal(r.auth.uid,11);
    const before=r.calls.filter(c=>c.method==='POST').length;await r.page.operations.restore(intent);assert.equal(r.calls.filter(c=>c.method==='POST').length,before);
    await r.page.operations.check(intent);assert.equal(r.page.operations.states.value[intent.request_key].checked,true);assert.equal(r.page.operations.canAbandon(intent),true);
  }finally{r.stop();}
});
test('capability transport accepts only exact GET with no query or idempotency key',async()=>{
  const {r}=make();try{const api=r.load(path.join(root,'src/api/customerWorkCashier.ts')),uri=base.slice(4)+'/capabilities',scope=api.createCustomerCashierRequests(()=>true);
    assert.equal(api.customerCashierEndpoint(uri,'GET'),true);assert.equal(api.customerCashierEndpoint(uri,'POST'),false);
    for(const bad of [uri+'?role=admin',uri+'/',uri+'/1'])assert.equal(api.customerCashierEndpoint(bad,'GET'),false);
    await assert.rejects(scope.request(uri,'GET',{scope_key:'a'.repeat(64)}),/查询参数/);assert.equal(r.calls.length,0);scope.abort();
  }finally{r.stop();}
});

test('an accepted capability snapshot survives its short arrival hint during ordinary form entry',async()=>{
  const {r}=make({},(call,server)=>{const answer=server.dispatch(call);if(call.url===base+'/capabilities'){answer.data.data.lease.expires_at=answer.data.data.lease.issued_at+2;answer.data=sign(answer.data);}return answer;});
  try{await choose(r);const before=r.page.selection.value;await new Promise(resolve=>setTimeout(resolve,2100));
    assert.equal(r.page.cashierCapabilities.ready.value,true);assert.equal(r.page.selection.value,before);assert.equal(r.page.contact.value.name,'实际姓名');
    assert.equal(r.calls.filter(c=>c.method==='POST').length,0);
  }finally{r.stop();}
});
test('domain loss during creation confirmation releases its own busy task and permits owner recovery without dispatch',async()=>{
  const {r}=make();try{await choose(r);await r.page.prepare();const intent=r.page.operations.pending.value[0];let modal;
    r.uni.showModal=value=>{modal=value;};const creation=r.page.operations.create();await tick();assert.ok(modal);assert.equal(r.page.operations.busy.value,true);
    r.page.cashierCapabilities.clear();modal.success({confirm:true});await creation;assert.equal(r.page.operations.busy.value,false);
    assert.equal(r.calls.some(c=>c.url===base+'/orders'),false);await r.page.operations.check(intent);
    assert.equal(r.page.operations.states.value[intent.request_key].checked,true);assert.equal(r.page.operations.canAbandon(intent),true);
  }finally{r.stop();}
});
test('an old confirmation finally cannot clear a new same-UID session recovery task busy state',async()=>{
  const late=deferred();let delay=false,savedCall;const {r,server}=make({},(call,s)=>delay&&call.method==='GET'&&call.url.includes('/creations/')?(savedCall=call,late.promise):s.dispatch(call));
  try{await choose(r);await r.page.prepare();const intent=r.page.operations.pending.value[0];let modal;r.uni.showModal=value=>{modal=value;};
    const old=r.page.operations.create();await tick();assert.ok(modal);r.auth.setLogin('other',12);r.auth.setLogin('fresh-token',11);await tick();
    delay=true;const fresh=r.page.operations.check(intent);await tick();assert.ok(savedCall);assert.equal(r.page.operations.busy.value,true);
    modal.success({confirm:true});await old;assert.equal(r.page.operations.busy.value,true);
    late.resolve(server.dispatch(savedCall));await fresh;assert.equal(r.page.operations.busy.value,false);assert.equal(r.auth.token,'fresh-token');
    assert.equal(r.calls.some(c=>c.url===base+'/orders'),false);
  }finally{r.stop();}
});

async function renderedHome(r){
  for(const file of ['components/ThemePage.vue','components/customerWork/CustomerWorkRecoveryPanel.vue','components/customerWork/CustomerWorkShell.vue'])await render(r,file);
  return render(r,'pages/customer-work/index.vue',r.page);
}
for(const state of ['denied','unavailable','qualification-revoked'])test('home recovery navigation survives '+state+' and reopens original owner recovery',async()=>{
  const prepared=make();let original,server;
  try{await choose(prepared.r);await prepared.r.page.prepare();original=JSON.parse(JSON.stringify(prepared.r.page.operations.pending.value[0]));server=prepared.server;}finally{prepared.r.stop();}
  const read=require('./customer-work-runtime.test.cjs');
  const send=call=>{
    if(state==='qualification-revoked'&&call.url.endsWith('/context'))return{httpStatus:403,status:403,msg:'当前用户没有手机订单管理权限'};
    if(call.url===base+'/capabilities')return state==='unavailable'?{httpStatus:503,status:503,msg:'独立收银运行绑定暂不可用'}:{data:capability({capability:false})};
    if(call.url.endsWith('/overview'))return read.fixture(call);
    return server.dispatch(call);
  };
  const home=runtime({component:'pages/customer-work/index.vue',send});
  try{await home.start();assert.equal(home.auth.uid,11);assert.equal(home.page.cashierCapabilities.ready.value,false);
    if(state==='qualification-revoked')assert.equal(home.page.manager.context.value,null);
    const html=await renderedHome(home);assert.ok(html.includes('核对原收银编号'));assert.equal(html.includes('进入次卡现金收银'),false);
    home.page.openCashierRecovery();assert.equal(home.navigations.at(-1),'/pages/customer-work/cashier');
    home.hooks.onHide();const before=home.navigations.length;home.page.openCashierRecovery();assert.equal(home.navigations.length,before);
    assert.equal((await renderedHome(home)).includes('核对原收银编号'),false);
  }finally{home.stop();}
  const recovered=runtime({component:'pages/customer-work/cashier.vue',send});
  try{recovered.uni.setStorageSync('customer_cashier_pending_v1',[original]);await recovered.start();
    assert.equal(recovered.auth.uid,11);assert.equal(recovered.page.operations.pending.value[0].request_key,original.request_key);
    assert.equal(recovered.page.canNew.value,false);const before=recovered.calls.filter(c=>c.method==='POST').length;
    await recovered.page.operations.check(original);assert.equal(recovered.page.operations.states.value[original.request_key].checked,true);
    await recovered.page.prepare();assert.equal(recovered.calls.filter(c=>c.method==='POST').length,before);
    recovered.auth.setLogin('different-owner',12);assert.equal(recovered.page.operations.pending.value.length,0);
    assert.equal(recovered.uni.getStorageSync('customer_cashier_pending_v1')[0].request_key,original.request_key);
  }finally{recovered.stop();}
});
test('logged-out home never exposes or dispatches recovery navigation',async()=>{
  const r=runtime({component:'pages/customer-work/index.vue',anonymous:true,send:()=>{throw Error('anonymous request');}});
  try{await r.start();assert.equal((await renderedHome(r)).includes('核对原收银编号'),false);r.page.openCashierRecovery();assert.equal(r.navigations.length,0);assert.equal(r.calls.length,0);}finally{r.stop();}
});

test('home renders the dedicated Cashier entry while ordinary App reports false',async()=>{
  const financial=require('./customer-work-cashier-runtime.test.cjs').backend(),read=require('./customer-work-runtime.test.cjs');
  const r=runtime({component:'pages/customer-work/index.vue',send:call=>call.url.endsWith('/overview')?read.fixture(call):financial.dispatch(call)});
  try{await r.start();assert.equal(r.page.manager.context.value.data.capabilities.cashier_second_card,false);assert.equal(r.page.cashierCapabilities.ready.value,true);
    assert.ok((await renderedHome(r)).includes('进入次卡现金收银'));r.page.manager.go('cashier');assert.equal(r.navigations.at(-1),'/pages/customer-work/cashier');
  }finally{r.stop();}
});
