const test=require('node:test'),assert=require('node:assert/strict');
const {createRuntime,all,text,tick,invoke,deferred}=require('./helpers/profile-runtime.cjs');
function scenario(name,run){test(name,{concurrency:false},async t=>{const r=await createRuntime();t.after(()=>r.finish());await run(r);});}
const mutations=r=>r.events.calls.filter(c=>c.url==='/system/profile/commit');
scenario('actual PHP alias mounts the real cacheHandlers SFC and shows safe current-account data',async r=>{await r.go('/admin/system/user');assert.equal(r.router.currentRoute.value.name,'systemUser');assert.equal(r.events.errors.length,0);assert.equal(r.events.warnings.length,0);assert.match(text(r.tree),/个人中心/);assert.match(text(r.tree),/profile-11/);assert.equal(mutations(r).length,0);});
scenario('name changes only on confirmed commit and safe info re-read',async r=>{await r.click('修改姓名');await r.input(0,'新姓名');await r.click('保存');assert.equal(mutations(r).length,1);assert.deepEqual(mutations(r)[0].data.payload,{real_name:'新姓名'});assert.match(text(r.tree),/新姓名/);assert.equal(r.sessionStorage.map.size,0);assert.equal(JSON.parse(r.localStorage.getItem('admin_session')).userInfo.real_name,'新姓名');});
scenario('old detached submit and setters cannot write into a reopened dialog',async r=>{await r.click('修改姓名');const save=r.buttons('保存')[0].props.onClick,input=r.inputs()[0].props.onInput;await r.click('取消');await r.click('修改姓名');await invoke(input,{target:{value:'stale'}});await invoke(save);assert.equal(mutations(r).length,0);assert.equal(r.inputs()[0].props.value,'原姓名');});
scenario('route ABA retires real native callbacks while Vue reuses the same Profile component',async r=>{await r.click('修改姓名');await r.input(0,'stale');const old=r.buttons('保存')[0].props.onClick;await r.go('/admin/system/user?tab=two');await r.go('/system/profile');await invoke(old);assert.equal(mutations(r).length,0);assert.equal(r.buttons('保存').length,0);});
scenario('cross-tab actor/token ABA clears private state and cannot revive the old native submit',async r=>{await r.click('修改密码');await r.input(0,'old-secret');await r.input(1,'new-secret-password');await r.input(2,'new-secret-password');const old=r.buttons('保存')[0].props.onClick;r.sync(12,'token-B','storage');await tick();assert.equal(r.buttons('保存').length,0);assert.doesNotMatch(text(r.tree),/profile-11|old-secret|new-secret-password/);r.sync(11,'token-A','storage');await tick();await invoke(old);assert.equal(mutations(r).length,0);});
scenario('successful same-token login retires old callbacks, while failed login does not forge success',async r=>{await r.click('修改姓名');const old=r.buttons('保存')[0].props.onClick;const auth=r.store._s.get('admin-auth');await auth.login('same','secret');await tick();await invoke(old);assert.equal(mutations(r).length,0);assert.equal(r.buttons('保存').length,0);});
scenario('password validation does not send partial secrets and successful mutation returns to login',async r=>{await r.click('修改密码');await r.input(0,'old');await r.input(1,'short');await r.input(2,'short');await r.click('保存');assert.equal(mutations(r).length,0);await r.input(1,'new-secret-password');await r.input(2,'new-secret-password');await r.click('保存');assert.equal(mutations(r).length,1);assert.equal(r.router.currentRoute.value.path,'/login');assert.equal(r.localStorage.getItem('admin_token'),null);assert.equal(r.sessionStorage.map.size,0);});
scenario('real file input only uploads a selected supported file and saves the stable server-owned reference',async r=>{await r.click('更换头像');const file={type:'image/png',size:12};await invoke(r.inputs()[0].props.onChange,{target:{files:[file]}});await r.click('保存');assert.equal(mutations(r).length,1);assert.match(mutations(r)[0].data.payload.head_pic,/^\/admin-profile-avatar\//);assert.equal(r.events.calls.filter(c=>c.kind==='fetch').length,1);});
scenario('unknown commit keeps only UUID/owner/kind, blocks replay and can seal absence without persisting secrets',async base=>{await base.finish();const r=await createRuntime({transport:async(config)=>{if(config.url==='/system/profile/commit')throw Error('private-network-error');}});try{await r.click('修改密码');await r.input(0,'old-secret');await r.input(1,'new-secret-password');await r.input(2,'new-secret-password');await r.click('保存');assert.equal(mutations(r).length,1);const raw=[...r.sessionStorage.map.values()][0],row=JSON.parse(raw);assert.deepEqual(Object.keys(row).sort(),['actor_id','operation','operation_id']);assert.doesNotMatch(raw,/old-secret|new-secret|hash|code|pwd/);assert(r.inputs().every(n=>n.props.value===''));await r.click('保存');assert.equal(mutations(r).length,1);await r.click('取消');await r.click('查询保存结果');assert.match(text(r.tree),/尚无持久回执/);await r.click('封存未完成操作');assert.equal(r.sessionStorage.map.size,0);assert.match(text(r.tree),/原操作已封存/);}finally{await r.finish();}});
scenario('an unmounted actual page cannot send a captured native submit',async r=>{await r.click('修改姓名');const old=r.buttons('保存')[0].props.onClick;r.show.value=false;await tick();await invoke(old);assert.equal(mutations(r).length,0);});
scenario('phone challenge verifies exact iframe origin/source/key, then queue acknowledgment and OTP save',async r=>{
 await r.click('修改手机号');await r.input(0,'13900139000');await r.click('获取验证码');const frame=all(r.tree,n=>n.tag==='iframe')[0];assert(frame);frame.contentWindow=require('vue').markRaw({});
 const post=async(source,origin='https://profile.test')=>{const event=new Event('message');Object.assign(event,{source,origin,data:{type:'cinashop:admin-profile-challenge',key:'11111111-1111-4111-8111-111111111111'}});r.window.dispatchEvent(event);await tick();};
 await post({});await post(frame.contentWindow,'https://evil.invalid');assert.equal(r.events.calls.filter(c=>c.url==='/system/profile/sms').length,0);
 await post(frame.contentWindow);assert.equal(r.events.calls.filter(c=>c.url==='/system/profile/challenge/status').length,1);assert.equal(r.events.calls.filter(c=>c.url==='/system/profile/sms').length,1);assert.match(text(r.tree),/任务已提交/);assert.match(text(r.tree),/60秒后可重试/);
 await r.input(1,'123456');await r.click('保存');assert.deepEqual(mutations(r)[0].data.payload,{phone:'13900139000',code:'123456'});assert.match(text(r.tree),/13900139000/);assert.equal(all(r.tree,n=>n.tag==='iframe').length,0);
});
scenario('phone edits invalidate old challenge frames and detached send callbacks',async r=>{
 await r.click('修改手机号');await r.input(0,'13900139000');const send=r.buttons('获取验证码')[0].props.onClick;await r.click('获取验证码');const frame=all(r.tree,n=>n.tag==='iframe')[0];frame.contentWindow=require('vue').markRaw({});await r.input(0,'13700137000');assert.equal(all(r.tree,n=>n.tag==='iframe').length,0);
 const event=new Event('message');Object.assign(event,{origin:'https://profile.test',source:frame.contentWindow,data:{type:'cinashop:admin-profile-challenge',key:'11111111-1111-4111-8111-111111111111'}});r.window.dispatchEvent(event);await tick();assert.equal(r.events.calls.filter(c=>c.url==='/system/profile/sms').length,0);
 await r.click('取消');await r.click('修改手机号');await invoke(send);assert.equal(r.events.calls.filter(c=>c.url==='/system/profile/challenge').length,1);
});
test('a rejected queue acknowledgment never starts a successful-send countdown',{concurrency:false},async()=>{
 const r=await createRuntime({transport:async config=>config.url==='/system/profile/sms'?{status:400,msg:'短信配置缺失',data:null}:undefined});try{
  await r.click('修改手机号');await r.input(0,'13900139000');await r.click('获取验证码');const frame=all(r.tree,n=>n.tag==='iframe')[0];frame.contentWindow=require('vue').markRaw({});const e=new Event('message');Object.assign(e,{origin:'https://profile.test',source:frame.contentWindow,data:{type:'cinashop:admin-profile-challenge',key:'11111111-1111-4111-8111-111111111111'}});r.window.dispatchEvent(e);await tick();assert.doesNotMatch(text(r.tree),/任务已提交|秒后可重试/);assert.match(text(r.tree),/短信配置缺失/);assert.equal(r.buttons('获取验证码').length,1);
 }finally{await r.finish();}
});
test('an unrecognized owner receipt state never releases the pending mutation',{concurrency:false},async()=>{
 const r=await createRuntime({transport:async(config,data)=>{
  if(config.url==='/system/profile/commit')throw Error('fixture unknown transport');
  if(config.url.startsWith('/system/profile/receipt/'))return {status:200,msg:'ok',data:{operation_id:config.url.split('/').at(-1),actor_id:11,operation:'name',state:'unexpected'}};
 }});try{await r.click('修改姓名');await r.input(0,'unknown state');await r.click('保存');await r.click('取消');await r.click('查询保存结果');assert.equal(r.sessionStorage.map.size,1);assert.equal(r.buttons('查询保存结果').length,1);assert.equal(r.buttons('修改姓名')[0].props.disabled,true);}finally{await r.finish();}
});
test('late recovery refresh cannot announce success inside a new route/dialog context',{concurrency:false},async()=>{
 const gate=deferred();let reads=0;
 const r=await createRuntime({transport:async(config)=>{
  if(config.url==='/system/profile/commit')throw Error('fixture unknown transport');
  if(config.url.startsWith('/system/profile/receipt/'))return {status:200,msg:'ok',data:{operation_id:config.url.split('/').at(-1),actor_id:11,operation:'name',state:'committed'}};
  if(config.url==='/setting/info'&&++reads===2)return gate.promise;
 }});try{
  await r.click('修改姓名');await r.input(0,'first context');await r.click('保存');await r.click('取消');const query=invoke(r.buttons('查询保存结果')[0].props.onClick);await tick();
  await r.go('/system/profile?context=new');await r.click('修改姓名');await r.input(0,'new context');gate.resolve({status:200,msg:'ok',data:{...r.info}});await query;
  assert.equal(r.inputs()[0].props.value,'new context');assert.doesNotMatch(text(r.tree),/原操作已保存/);
 }finally{gate.resolve({status:200,msg:'ok',data:{...r.info}});await r.finish();}
});
test('a retired private-avatar error body cannot clear a freshly renewed same-token session',{concurrency:false},async()=>{
 const body=deferred(),r=await createRuntime({fetchTransport:async()=>({ok:true,status:200,headers:new Headers({'Content-Type':'application/json'}),json:()=>body.promise})});
 try{const controller=new AbortController(),api=r.load('@/api/profile'),old=api.apiProfileAvatar('11111111-1111-4111-8111-111111111111',controller.signal);await tick();controller.abort();await r.store._s.get('admin-auth').login('same','fixture');body.resolve({status:410001,msg:'retired expiry'});await assert.rejects(old,/请求已取消/);assert.equal(r.localStorage.getItem('admin_token'),'token-A');}
 finally{body.resolve({status:410001,msg:'retired expiry'});await r.finish();}
});

test('a committed owner receipt never hides a failed profile refresh behind a success notice',{concurrency:false},async()=>{
 let reads=0;const r=await createRuntime({transport:async(config)=>{
  if(config.url==='/system/profile/commit')throw Error('fixture unknown transport');
  if(config.url.startsWith('/system/profile/receipt/'))return {status:200,msg:'ok',data:{operation_id:config.url.split('/').at(-1),actor_id:11,operation:'name',state:'committed'}};
  if(config.url==='/setting/info'&&++reads===2)return {status:503,msg:'fixture profile refresh unavailable',data:null};
 }});try{await r.click('修改姓名');await r.input(0,'saved name');await r.click('保存');await r.click('取消');await r.click('查询保存结果');assert.match(text(r.tree),/fixture profile refresh unavailable/);assert.doesNotMatch(text(r.tree),/资料已重新读取/);assert.equal(r.sessionStorage.map.size,0);}finally{await r.finish();}
});
