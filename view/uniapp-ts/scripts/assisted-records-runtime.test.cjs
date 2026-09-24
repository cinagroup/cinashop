const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
const loginResult = (id=1, extra={}) => ({ token: 'local-admin-'+id, expires_time: Math.floor(Date.now()/1000)+3600,
  user_info: { id, account: 'admin-'+id, real_name: '本地管理员' }, unique_auth: ['order.assisted'], ...extra });
const row = (id=1, extra={}) => ({ id, order_id:'order_'+id, pid:0, uid:11, paid:0, pay_price:'12.34', total_num:2,
  add_time:1700000000-id, _status:{_title:'待付款'}, ...extra });
const listPage = rows => ({list:rows,has_more:rows.length===20,
  next_cursor:rows.length===20?`${rows.at(-1).add_time}:${rows.at(-1).id}`:null});
async function setup(send=call=>({data:call.url==='/api/admin/login'?loginResult():listPage([row()])}), component=false) {
  const r=runtime({ feature:'useAssistedRecords', ...(component?{component:'pages/behalf/record/index.vue'}:{}), send });
  await r.start({uid:'999',paid:'1',admin_id:'999'}); return r;
}
async function login(r){r.checkout.account.value=' admin ';r.checkout.password.value='local-only';await r.checkout.login();await tick();}
test('no Admin read before separate login; actual request never sends the shopper token or requested actor',async()=>{
  const r=await setup(call=>{
    assert.equal(call.header['Authori-zation'],undefined);
    if(call.url==='/api/admin/login'){assert.equal(call.header.Authorization,undefined);assert.deepEqual(call.data,{account:'admin',pwd:'local-only'});return {data:loginResult()};}
    assert.equal(call.header.Authorization,'Bearer local-admin-1');
    assert.deepEqual(call.data,{paging:'cursor',cursor:'',limit:20,keyword:''}); return {data:listPage([row()])};
  });
  assert.equal(r.calls.length,0);await login(r);assert.equal(r.checkout.items.value.length,1);
  assert.equal(r.auth.token,'synthetic-local-token');assert.equal(r.checkout.password.value,'');
  assert.deepEqual([...r.storage.keys()].sort(),['uni_token','uni_uid']);r.stop();
});
test('real page setup renders data through the composable, without replacing Vue or Pinia',async()=>{
  const r=await setup(undefined,true);await login(r);assert.equal(r.checkout.items.value[0].amount,'12.34');
  assert.equal('buyer' in r.checkout.items.value[0],false);r.stop();
});
test('Admin expiry clears only Admin, leaves shopper and shopper navigation unchanged',async()=>{
  const r=await setup(call=>call.url==='/api/admin/login'?{data:loginResult()}:{status:410001,msg:'管理登录失效'});
  await login(r);assert.equal(r.checkout.session.authenticated,false);assert.equal(r.auth.uid,11);assert.equal(r.auth.token,'synthetic-local-token');
  assert.deepEqual(r.navigations,[]);assert.deepEqual(r.checkout.items.value,[]);r.stop();
});
test('Work/noAuth expiry does not sign out the shopper; ordinary shopper expiry still does',async()=>{
  const r=await setup(()=>({status:410001,msg:'expired'}));
  const {http}=r.load(path.join(root,'src/utils/request.ts'));
  await assert.rejects(http.get('work/groupInfo',{}, {noAuth:true,headers:{Authorization:'Bearer context-local'}}));
  assert.equal(r.auth.uid,11);assert.deepEqual(r.navigations,[]);
  await assert.rejects(http.get('user'));assert.equal(r.auth.uid,0);assert.deepEqual(r.navigations,['/pages/auth/login']);r.stop();
});
test('server denial or no assisted permission never substitutes a shopper identity',async()=>{
  const r=await setup(()=>({data:loginResult(1,{unique_auth:['order.view']})}));await login(r);
  assert.equal(r.checkout.canRead.value,false);assert.equal(r.calls.length,1);assert.equal(r.auth.uid,11);r.stop();
});
test('a live permission denial preserves login but exposes no records',async()=>{
  const r=await setup(call=>call.url==='/api/admin/login'?{data:loginResult()}:{status:400,httpStatus:403,msg:'权限已撤销'});
  await login(r);assert.equal(r.checkout.session.id,1);assert.match(r.checkout.error.value,/权限已撤销/);assert.deepEqual(r.checkout.items.value,[]);
  assert.equal(r.auth.uid,11);r.stop();
});
test('locally expired Admin session is cleared before any record request',async()=>{
  const r=await setup();await login(r);const calls=r.calls.length;r.checkout.session.expiresAt=1;await r.checkout.load();
  assert.equal(r.checkout.session.authenticated,false);assert.equal(r.calls.length,calls);assert.equal(r.auth.uid,11);r.stop();
});
test('Admin expires without another request and immediately removes visible order rows',async()=>{
  const r=await setup();try{
    await login(r);assert.equal(r.checkout.items.value.length,1);
    const version=r.checkout.session.version,calls=r.calls.length;
    r.checkout.session.expiresAt=Date.now()+80;r.checkout.session.ensureFresh();
    await new Promise(resolve=>setTimeout(resolve,160));
    assert.equal(r.checkout.session.token,'');assert.ok(r.checkout.session.version>version);
    assert.deepEqual(r.checkout.items.value,[]);assert.equal(r.checkout.canRead.value,false);
    assert.equal(r.calls.length,calls);assert.equal(r.auth.token,'synthetic-local-token');
  }finally{r.stop();}
});
test('onShow after a throttled clock expiry clears Admin and records before any new read',async()=>{
  const r=await setup();try{
    await login(r);const calls=r.calls.length;
    r.checkout.session.expiresAt=Date.now()-1;
    r.hooks.onShow();
    assert.equal(r.checkout.session.token,'');assert.deepEqual(r.checkout.items.value,[]);
    assert.equal(r.calls.length,calls);
  }finally{r.stop();}
});
test('a canceled old expiry callback cannot clear a replacement Admin, even with the same token',async()=>{
  const r=await setup(),originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,timers=[];
  try{
    globalThis.setTimeout=(fn,delay)=>{const handle={fn,delay,unref(){}};timers.push(handle);return handle;};
    globalThis.clearTimeout=handle=>{handle.cleared=true;};
    const session=r.checkout.session,first={id:1,label:'合成管理员',token:'same-token',expiresAt:Date.now()+1000,permissions:['order.assisted']};
    session.install(first);const stale=timers.at(-1),version=session.version;
    session.install({...first,expiresAt:Date.now()+3600000});
    assert.equal(stale.cleared,true);assert.ok(session.version>version);
    stale.fn();assert.equal(session.token,'same-token');assert.equal(session.authenticated,true);
    assert.equal(session.expiresAt>first.expiresAt,true);session.clear();
  }finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;r.stop();}
});
test('paging retries the failed page and keeps the applied query until a fresh search',async()=>{
  let fail=true;
  const first=Array.from({length:20},(_,i)=>row(i+1)), next=listPage(first).next_cursor;
  const r=await setup(call=>call.url==='/api/admin/login'?{data:loginResult()}:call.data.cursor===''
    ?{data:listPage(first)}:fail?(fail=false,{transport:'offline'}):{data:listPage([row(21)])});
  await login(r);r.checkout.keyword.value='not submitted';await r.checkout.load(true);
  assert.equal(r.checkout.filtersDirty.value,true);assert.equal(r.calls.length,2);
  r.checkout.keyword.value='';await r.checkout.load(true);assert.equal(r.checkout.nextCursor.value,next);
  await r.checkout.load(true);assert.equal(r.checkout.items.value.length,21);assert.equal(r.checkout.hasMore.value,false);
  assert.deepEqual(r.calls.filter(c=>c.url.endsWith('/list')).map(c=>[c.data.cursor,c.data.keyword]),[['',''],[next,''],[next,'']]);r.stop();
});
test('a cursor page that overlaps its predecessor is rejected',async()=>{
  const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():call.data.cursor===''?listPage(Array.from({length:20},(_,i)=>row(i+1))):listPage([row(1)])}));
  await login(r);await r.checkout.load(true);assert.equal(r.checkout.items.value.length,20);assert.match(r.checkout.error.value,/已变化/);r.stop();
});
test('a full final page obeys server has_more instead of guessing from row count',async()=>{
  const rows=Array.from({length:20},(_,i)=>row(i+1));
  const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():{list:rows,has_more:false,next_cursor:null}}));
  await login(r);assert.equal(r.checkout.items.value.length,20);assert.equal(r.checkout.hasMore.value,false);
  await r.checkout.load(true);assert.equal(r.calls.filter(call=>call.url.endsWith('/list')).length,1);r.stop();
});
test('filter submit resets page and URL-supplied paid/actor values cannot authorize reads',async()=>{
  const r=await setup();await login(r);r.checkout.keyword.value=' order_ ';r.checkout.status.value='0';await r.checkout.load();
  assert.deepEqual(r.calls.at(-1).data,{paging:'cursor',cursor:'',limit:20,keyword:'order_',status:0});r.stop();
});
test('payment query is read-only, displayed-order scoped, and trusts only the server boolean',async()=>{
  const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():call.url.endsWith('/status')?{order_id:'order_1',status:true,time:0}:listPage([row()])}));
  await login(r);await r.checkout.checkPayment('unknown');assert.equal(r.calls.length,2);
  await r.checkout.checkPayment('order_1');assert.match(r.checkout.paymentNote.value,/服务器已确认付款/);
  assert.deepEqual(r.calls.at(-1),{url:'/api/admin/order/pay/status',data:{order_id:'order_1'}});
  assert.equal(r.checkout.items.value[0].paid,false);r.stop();
});
test('payment status for an alias target is rejected instead of attributed to the displayed order',async()=>{
  const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():call.url.endsWith('/status')
    ?{order_id:'other_order',status:true}:listPage([row()])}));
  await login(r);await r.checkout.checkPayment('order_1');
  assert.match(r.checkout.paymentNote.value,/订单状态已变化，请刷新列表/);
  assert.doesNotMatch(r.checkout.paymentNote.value,/服务器已确认付款/);
  assert.equal(r.checkout.items.value[0].paid,false);
  assert.deepEqual(r.calls.at(-1),{url:'/api/admin/order/pay/status',data:{order_id:'order_1'}});
  r.stop();
});
test('bad payment response is not rendered as success and no payment write endpoint is invoked',async()=>{
  const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():call.url.endsWith('/status')?{order_id:'order_1',status:'true'}:listPage([row()])}));
  await login(r);await r.checkout.checkPayment('order_1');assert.match(r.checkout.paymentNote.value,/响应无效/);
  assert.ok(r.calls.every(call=>!/^\/api\/admin\/order\/(pay\/\d|create)/.test(call.url)));r.stop();
});
test('only root order records navigate to the dedicated scoped detail page',async()=>{
  const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():listPage([row(1),row(2,{pid:91}),row(3,{pid:-1}),row(4,{pid:undefined})])}),true);
  await login(r);
  assert.deepEqual(r.checkout.items.value.map(item=>item.root),[true,false,true,false]);
  r.checkout.goDetail('order_2');r.checkout.goDetail('order_4');r.checkout.goDetail('../order_1');assert.deepEqual(r.navigations,[]);
  r.checkout.goDetail('order_1');r.checkout.goDetail('order_3');
  assert.deepEqual(r.navigations,['/pages/behalf/order_detail/index?orderId=order_1','/pages/behalf/order_detail/index?orderId=order_3']);
  r.hooks.onHide();r.checkout.goDetail('order_1');assert.equal(r.navigations.length,2);r.stop();
});
test('hide/unload immediately clears order PII and ignores late reads; show reloads',async()=>{
  const waiting=deferred();let queries=0;
  const r=await setup(call=>call.url==='/api/admin/login'?{data:loginResult()}:++queries===1?waiting.promise:{data:listPage([row(2)])});
  const pending=login(r);await tick();r.hooks.onHide();waiting.resolve({data:listPage([row()])});await pending;
  assert.deepEqual(r.checkout.items.value,[]);r.hooks.onShow();await tick();assert.equal(r.checkout.items.value[0].id,2);r.stop();
});
test('logout drops PII and a delayed expired response cannot clear a newer Admin login',async()=>{
  const waiting=deferred();let count=0;
  const r=await setup(call=>call.url==='/api/admin/login'?{data:loginResult(++count)}:count===1?waiting.promise:{data:listPage([row(2)])});
  const pending=login(r);await tick();r.checkout.logout();await login(r);waiting.resolve({status:410001,msg:'old expired'});await pending;
  assert.equal(r.checkout.session.id,2);assert.equal(r.checkout.items.value[0].id,2);assert.equal(r.auth.uid,11);r.stop();
});
test('a stale login completion cannot release the busy lock belonging to a newer login',async()=>{
  const first=deferred(),second=deferred();let count=0;
  const r=await setup(call=>call.url==='/api/admin/login'?(++count===1?first.promise:second.promise):{data:listPage([])});
  const a=login(r);await tick();r.checkout.logout();const b=login(r);await tick();
  first.resolve({data:loginResult(1)});await a;assert.equal(r.checkout.loginBusy.value,true);
  second.resolve({data:loginResult(2)});await b;assert.equal(r.checkout.session.id,2);r.stop();
});
test('leaving during login cannot adopt a late privileged session',async()=>{
  const waiting=deferred(),r=await setup(()=>waiting.promise),pending=login(r);await tick();r.hooks.onHide();
  waiting.resolve({data:loginResult()});await pending;assert.equal(r.checkout.session.authenticated,false);assert.equal(r.checkout.password.value,'');r.stop();
});
for(const invalid of [{paid:'1'}, {pay_price:'NaN'}, {id:0}, {order_id:'../x'}, {total_num:-1}, {_status:null}]) {
  test('rejects malformed order field '+Object.keys(invalid)[0],async()=>{
    const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():listPage([row(1,invalid)])}));await login(r);
    assert.equal(r.checkout.items.value.length,0);assert.ok(r.checkout.error.value);r.stop();
  });
}
for(const invalid of [
  {list:[row()],has_more:true,next_cursor:'1699999999:1'},
  {list:[row()],has_more:false,next_cursor:'1699999999:1'},
  {list:[row(2),row(1)],has_more:false,next_cursor:null},
]) {
  test('rejects an inconsistent cursor response',async()=>{
    const r=await setup(call=>({data:call.url==='/api/admin/login'?loginResult():invalid}));await login(r);
    assert.equal(r.checkout.items.value.length,0);assert.ok(r.checkout.error.value);r.stop();
  });
}
test('malformed or already-expired login responses never install a session',async()=>{
  for(const extra of [{token:'bad token'}, {expires_time:1}, {unique_auth:null}, {user_info:{id:0,account:'bad'}}]){
    const r=await setup(()=>({data:loginResult(1,extra)}));await login(r);assert.equal(r.checkout.session.authenticated,false);assert.ok(r.checkout.loginError.value);r.stop();
  }
});
test('the original shopper home remains first and the real legacy record route is registered',()=>{
  const manifest=JSON.parse(readFileSync(path.join(root,'src/pages.json'),'utf8'));
  assert.equal(manifest.pages[0].path,'pages/index/index');assert.ok(manifest.pages.some(p=>p.path==='pages/behalf/record/index'));
});
