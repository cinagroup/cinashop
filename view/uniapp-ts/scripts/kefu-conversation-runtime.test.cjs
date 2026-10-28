const {test}=require('node:test'),assert=require('node:assert/strict');
const vue=require('vue');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
function history(owner=11,target=77){return{uid:target,nickname:'指定客服'+target,avatar:'https://images.example/kefu.png',online:1,serviceList:[{id:100,uid:target,to_uid:owner,msn:'本人历史 '+owner,add_time:1900000000,msn_type:1}]};}
async function start(options={}){const previousLocation=global.location;global.location={origin:'http://127.0.0.1:40123'};const mounted=[],unmounted=[],traces=[],sockets=[];const oldMounted=vue.onMounted,oldUnmounted=vue.onUnmounted;vue.onMounted=fn=>mounted.push(fn);vue.onUnmounted=fn=>unmounted.push(fn);let r;try{r=runtime({storage:options.storage,component:'pages/user/kefu.vue',authenticated:options.authenticated??true,send:c=>{traces.push({url:c.url,data:structuredClone(c.data),auth:c.header?.['Authori-zation']});const owner=c.header?.['Authori-zation']==='Bearer other'?22:11;return options.send?.(c,owner)??{data:history(owner,c.data?.to_uid||77)};}});}finally{vue.onMounted=oldMounted;vue.onUnmounted=oldUnmounted;}
 r.uni.connectSocket=opts=>{const hooks={},calls=[];const socket={hooks,calls,opts,closed:false,send:c=>{calls.push(c.data);c.success?.();},close:()=>{socket.closed=true;hooks.close?.();},onOpen:fn=>hooks.open=fn,onMessage:fn=>hooks.message=fn,onClose:fn=>hooks.close=fn,onError:fn=>hooks.error=fn};sockets.push(socket);return socket;};r.uni.previewImage=()=>{};const stop=r.stop;r.stop=()=>{try{stop();}finally{if(previousLocation===undefined)delete global.location;else global.location=previousLocation;}};await r.start(options.query??{to_uid:'77'});return{...r,state:r.checkout,traces,sockets,unmounted};}
test('explicit to_uid loads only the selected conversation and opens its authenticated native socket',async()=>{const r=await start();try{assert.equal(r.state.serviceUid.value,77);assert.deepEqual(r.traces[0].data,{limit:50,to_uid:77});assert.equal(r.state.messages.value[0].msn,'本人历史 11');assert.match(r.sockets[0].opts.url,/to_uid=77$/);assert.deepEqual(r.sockets[0].opts.protocols,['cinashop','cinashop-auth.synthetic-local-token']);r.sockets[0].hooks.open();assert.equal(JSON.parse(r.sockets[0].calls[0]).data.to_uid,77);}finally{r.stop();}});
for(const id of ['',0,'0','01','-1','1e2','2147483648',['77']])test('invalid explicit target '+JSON.stringify(id)+' cannot fall back or create a socket',async()=>{const r=await start({query:{to_uid:id}});try{assert.equal(r.traces.length,0);assert.equal(r.sockets.length,0);assert.equal(r.state.targetValid.value,false);assert.ok(r.state.chatError.value);}finally{r.stop();}});
test('absent target retains automatic assignment while an unexpected explicit target response fails closed',async()=>{for(const explicit of [false,true]){const r=await start({query:explicit?{to_uid:'88'}:{},send:()=>({data:history(11,77)})});try{if(explicit){assert.equal(r.state.serviceUid.value,0);assert.equal(r.sockets.length,0);assert.match(r.state.chatError.value,/不完整/);}else{assert.equal(r.state.serviceUid.value,77);assert.equal(r.traces[0].data.to_uid,undefined);}}finally{r.stop();}}});
test('guest selected conversation makes no visitor bootstrap and offers explicit login',async()=>{const r=await start({authenticated:false});try{assert.equal(r.traces.length,0);assert.equal(r.sockets.length,0);assert.match(r.state.chatError.value,/登录/);r.state.loginConversation();assert.deepEqual(r.navigations,['/pages/auth/login']);}finally{r.stop();}});
for(const event of ['onHide','onUnload','logout','owner','renew'])test('held selected history after '+event+' cannot restore old messages or connect',async()=>{const held=deferred();let first=true;const r=await start({send:()=>first?(first=false,held.promise):undefined});try{if(event==='logout')r.auth.clear();else if(event==='owner')r.auth.setLogin('other',22);else if(event==='renew')r.auth.setLogin(r.auth.token,11);else r.hooks[event]();held.resolve({data:history()});await tick();if(event==='owner'){assert.equal(r.state.messages.value[0].msn,'本人历史 22');assert.equal(r.sockets.length,1);assert.equal(r.traces.at(-1).auth,'Bearer other');}else if(event==='renew'){assert.equal(r.state.messages.value[0].msn,'本人历史 11');assert.equal(r.sockets.length,1);}else{assert.equal(r.state.messages.value.length,0);assert.equal(r.sockets.length,0);}}finally{r.stop();}});
test('old socket frames and close callbacks cannot modify renewed conversation; hide closes and return rereads',async()=>{const r=await start();try{const old=r.sockets[0];old.hooks.open();r.auth.setLogin('other',22);await tick();assert.equal(old.closed,true);const fresh=r.sockets[1];old.hooks.message({data:JSON.stringify({type:'chat',data:{id:999,uid:77,to_uid:11,msn:'STALE'}})});old.hooks.close();assert.equal(r.state.messages.value.length,1);assert.equal(r.state.messages.value[0].msn,'本人历史 22');assert.equal(r.state.serviceUid.value,77);assert.equal(fresh.closed,false);r.hooks.onHide();assert.equal(fresh.closed,true);assert.equal(r.state.messages.value.length,0);r.hooks.onShow();await tick();assert.equal(r.sockets.length,3);}finally{r.stop();}});
test('foreign-owner history is rejected before private rows or socket are accepted',async()=>{const r=await start({send:()=>({data:history(99)})});try{assert.equal(r.state.messages.value.length,0);assert.equal(r.state.serviceUid.value,0);assert.equal(r.sockets.length,0);assert.match(r.state.chatError.value,/不完整/);}finally{r.stop();}});
test('late REST send completion after account replacement cannot append prior account message',async()=>{const held=deferred();const r=await start({send:c=>c.url.endsWith('/service/send')?held.promise:undefined});try{r.state.inputText.value='本人发送';const pending=r.state.send();await tick();r.auth.setLogin('other',22);await tick();held.resolve({data:{id:101,uid:11,to_uid:77,msn:'STALE-SEND',add_time:1900000001,msn_type:1}});await pending;assert.equal(r.state.messages.value.length,1);assert.equal(r.state.messages.value[0].msn,'本人历史 22');assert.equal(r.state.inputText.value,'');}finally{r.stop();}});

for(const boundary of ['persisted-owner','hide-then-persisted-owner'])test('late old authorization error after '+boundary+' cannot erase replacement storage or replay send',async()=>{
 const held=deferred();const r=await start({send:c=>c.url.endsWith('/service/send')?held.promise:undefined});
 try{r.state.inputText.value='本人发送';const sending=r.state.send();await tick();if(boundary.startsWith('hide'))r.hooks.onHide();r.storage.set('uni_token','other');r.storage.set('uni_uid',22);held.resolve({status:410001,msg:'old credential revoked',data:null});await sending;await tick();assert.equal(r.storage.get('uni_token'),'other');assert.equal(r.storage.get('uni_uid'),22);assert.equal(r.auth.uid,11);assert.equal(r.traces.filter(t=>t.url.endsWith('/service/send')).length,1);r.hooks.onHide();r.hooks.onShow();await tick();assert.equal(r.auth.uid,22);assert.equal(r.state.messages.value[0].msn,'本人历史 22');}finally{r.stop();}
});
test('hiding private image preview closes it and acknowledges an already manually closed native preview',async()=>{
 const r=await start();try{const calls=[];r.uni.previewImage=o=>calls.push(o);r.uni.closePreviewImage=o=>{assert.equal(typeof o.fail,'function');o.fail({errMsg:'closePreviewImage:fail not opened'});calls.push('closed');};r.state.messages.value.push({id:101,msn:'https://images.example/chat.png',addTime:1900000000,mine:false,msnType:3});r.state.previewImage('https://images.example/chat.png');assert.equal(calls.length,1);r.hooks.onHide();assert.equal(calls.at(-1),'closed');assert.equal(r.state.messages.value.length,0);}finally{r.stop();}
});

for(const event of ['onHide','owner'])test('late stored visitor failure after '+event+' cannot clear replacement visitor storage or start another bootstrap',async()=>{
 const held=deferred(),storage=new Map([['cinashop_kefu_visitor_token','old-visitor']]);const r=await start({query:{},storage,authenticated:false,send:c=>c.url.includes('/kefuapi/tourist/user')?held.promise:undefined});
 try{if(event==='owner')r.auth.setLogin('other',22);else r.hooks.onHide();storage.set('cinashop_kefu_visitor_token','new-visitor');held.resolve({status:410001,msg:'old visitor expired',data:null});await tick();assert.equal(r.traces.filter(t=>t.url.includes('/kefuapi/tourist/user')).length,1);assert.equal(storage.get('cinashop_kefu_visitor_token'),'new-visitor');if(event==='owner')assert.equal(r.state.messages.value[0].msn,'本人历史 22');else assert.equal(r.state.messages.value.length,0);}finally{r.stop();}
});
test('existing refund type7 history remains readable in the selected conversation',async()=>{
 const r=await start({send:()=>{const data=history();data.serviceList[0].msn_type=7;return{data};}});try{assert.equal(r.state.chatError.value,'');assert.equal(r.state.messages.value[0].msnType,7);assert.equal(r.sockets.length,1);}finally{r.stop();}
});

// Real SFC/Vue/request logic; native transports are finite in-memory controls.
for (const channel of ['socket', 'rest', 'socket-failure']) for (const kind of ['text', 'image']) {
 test('selected '+kind+' uses one '+channel+' path without a second persistence transport', async () => {
  const r=await start({send:c=>c.url.endsWith('/service/send')?{data:{id:101,uid:11,to_uid:77,msn:c.data.msn,add_time:1900000001,msn_type:c.data.msn_type}}:undefined});
  const uploads=[];
  try {
   r.uni.chooseImage=o=>o.success({tempFilePaths:['/synthetic/chat.jpg'],tempFiles:[{size:16}]});
   r.uni.uploadFile=o=>{uploads.push(o);o.success({data:JSON.stringify({status:200,data:{url:'/api/assets/99'}})});};
   const socket=r.sockets[0];
   if(channel!=='rest')socket.hooks.open();
   if(channel==='socket-failure')socket.send=o=>{socket.calls.push(o.data);o.fail?.({errMsg:'controlled socket send failure'});};
   if(kind==='text'){r.state.inputText.value='单次发送';await r.state.send();}
   else await r.state.chooseAndSendImage();
   await tick();
   const writes=r.traces.filter(t=>t.url.endsWith('/service/send'));
   const frames=socket.calls.map(s=>JSON.parse(s)).filter(f=>f.type==='chat');
   assert.equal(writes.length,channel==='rest'?1:0);
   assert.equal(frames.length,channel==='rest'?0:1);
   const data=channel==='rest'?writes[0].data:frames[0].data;
   assert.equal(data.to_uid,77);assert.equal(data.msn_type,kind==='image'?3:1);
   assert.equal(data.msn,kind==='image'?'/api/assets/99':'单次发送');
   assert.equal(uploads.length,kind==='image'?1:0);
   if(uploads.length)assert.equal(uploads[0].header['Authori-zation'],'Bearer synthetic-local-token');
   if(channel==='socket-failure')assert.equal(r.state.messages.value.length,1);
   if(channel==='rest')assert.equal(r.state.messages.value.length,2);
  } finally {r.stop();}
 });
}
