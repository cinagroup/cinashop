const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
function pure(name){const exports={};new Function('exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/utils',name+'.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(exports);return exports;}
const protocol=pure('legacyShare'),{ShareReferralIntent}=pure('shareReferral'),token='a'.repeat(24),image=`/api/share/code/image/${token}/routine?expires=1800000000&signature=${'s'.repeat(32)}`;
const dto={routineUrl:image,wechatUrl:image.replace('/routine?','/wechat?'),site_name:'测试商城',nickname:'当前会员'};
const poster={spread:[{pic:'/template-one.png'},{pic:'/template-two.png'}],avatar:'/avatar.png',nickname:dto.nickname,site_name:dto.site_name};
const session=(uid=11,version=1)=>({uid,version,token:uid?'actor-'+uid:''});
function store(){let value;return{get:()=>value,set:v=>{value=structuredClone(v);}};}

test('the published mini and H5 landing accept only one canonical opaque token',()=>{
  assert.equal(protocol.shareToken({q:token}),token);assert.equal(protocol.shareToken({scene:encodeURIComponent('q='+token)}),token);
  for(const options of [{q:token,scene:'q='+token},{q:token+'0'},{scene:encodeURIComponent(encodeURIComponent('q='+token))},{scene:'q='+token+'&spid=8'},{q:'../private'},{scene:'auth=3&code=123'}])assert.throws(()=>protocol.shareToken(options));
});
test('all ten scene types navigate to actual registered pages with strict identity and namespace',()=>{
  const paths={0:'/pages/goods/detail?id=7',1:'/pages/activity/seckillDetail?id=7',2:'/pages/activity/bargainDetail?bargain_id=7',3:'/pages/activity/detail?id=7',4:'/pages/activity/integralDetail?id=7',6:'/pages/activity/presaleDetail?id=7',7:'/pages/activity/newcomerDetail?id=7'};
  for(const [type,path] of Object.entries(paths))assert.equal(protocol.parseShareScene({type:Number(type),id:7,spid:8,path:path+'&spid=8'}).type,Number(type));
  assert.equal(protocol.parseShareScene({type:-1,id:0,spid:8,path:'/pages/index/index?spid=8'}).type,-1);
  for(const [type,namespace]of [[90,'member'],[91,'order']])for(const [viewer_scope,path]of [['customer','/pages/customer-work/scanning'],['staff','/pages/operator/writeoff?role=staff'],['delivery','/pages/delivery/scanning'],['owner',type===90?'/pages/user/memberCode':'/pages/order/detail?orderId=ORDER-11']])assert.equal(protocol.parseShareScene({type,id:11,spid:0,namespace,code:'1234',viewer_scope,path,...(type===91?{order_id:'ORDER-11'}:{})}).namespace,namespace);
  assert.throws(()=>protocol.parseShareScene({type:90,id:11,spid:8,namespace:'member',code:'1234',path:'/pages/customer-work/scanning?namespace=member-barcode&value=1234'}));
});
test('foreign origins, mismatched public IDs, duplicate queries and writeoff namespace swaps are rejected',()=>{
  for(const path of ['https://evil.example/pages/goods/detail?id=7','//evil.example/x','/pages/goods/detail?id=8','/pages/goods/detail?id=7&id=7','/pages/goods/detail?id=7&order_id=9'])assert.throws(()=>protocol.parseShareScene({type:0,id:7,spid:0,path}));
  assert.throws(()=>protocol.parseShareScene({type:91,id:9,spid:0,namespace:'order',code:'1234',path:'/pages/customer-work/scanning?namespace=member-barcode&value=1234'}));
  assert.equal(protocol.shareDestination(protocol.parseShareScene({type:0,id:7,spid:8,path:'/pages/goods/detail?id=7&spid=8'})),'/pages/goods/detail?id=7');
});
test('old DTOs accept controlled signed raster URLs and actual PNG/GIF data URIs without external QR servers',()=>{
  assert.deepEqual(protocol.parseLegacyShareCode(dto),dto);
  for(const data of ['data:image/png;base64,iVBORw0KGgo=','data:image/gif;base64,R0lGODlhAQABAAAAACw=','data:image/gif;base64,R0lGODdhAQABAAAAACw='])assert.equal(protocol.shareCodeImage(data),data);
  for(const data of ['https://api.qrserver.com/?data=private','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,R0lGODlhAQABAAAAACw=',image+'&signature=duplicate','//evil.example/code.png'])assert.throws(()=>protocol.shareCodeImage(data));
});
test('template/identity responses cannot silently replace real account metadata',()=>{
  assert.deepEqual(protocol.parseSpreadPosterData(poster),poster);
  assert.throws(()=>protocol.parseSpreadPosterData({...poster,spread:[{pic:'javascript:alert(1)'}]}));
  assert.throws(()=>protocol.parseSpreadPosterData({...poster,nickname:'bad\u0000name'}));
});
test('guest referral survives a page/reload and binds once after the first login',async()=>{
  const storage=store(),calls=[];let intent=new ShareReferralIntent(storage,async id=>calls.push(id));intent.update(session(0,0));intent.capture(token,8);await intent.consume();assert.equal(calls.length,0);
  intent=new ShareReferralIntent(storage,async id=>calls.push(id));intent.update(session());await intent.consume();await intent.consume();assert.deepEqual(calls,[8]);assert.equal(storage.get().owner,11);assert.equal(storage.get().sent,true);
});
test('unknown binding outcomes and account replacements never transfer or replay the original intent',async()=>{
  const storage=store(),gate=deferred(),calls=[];const intent=new ShareReferralIntent(storage,id=>{calls.push(id);return gate.promise;});intent.update(session());intent.capture(token,8);const pending=intent.consume();intent.update(session(22,2));gate.resolve();await pending;assert.equal(intent.notice,'');await intent.consume();assert.deepEqual(calls,[8]);
  const restored=new ShareReferralIntent(storage,async()=>{throw Error('must not retry');});restored.update(session(22,3));await restored.consume();assert.equal(restored.notice,'');
});
test('owned unsent referrals retire on logout and do not belong to a replacement login',async()=>{
  const storage=store(),calls=[],intent=new ShareReferralIntent(storage,async id=>calls.push(id));intent.update(session());intent.capture(token,8);intent.update(session(0,2));intent.update(session(22,3));await intent.consume();assert.deepEqual(calls,[]);
});
test('self referrals and corrupt persistence never make a binding request',async()=>{
  const storage=store(),calls=[],intent=new ShareReferralIntent(storage,async id=>calls.push(id));intent.update(session());intent.capture(token,11);await intent.consume();assert.deepEqual(calls,[]);assert.match(intent.notice,/本人/u);
  assert.throws(()=>new ShareReferralIntent({get:()=>({version:1,spid:8}),set(){}},async()=>{}));
});
test('storage must acknowledge an intent before any binding write can start',async()=>{
  const calls=[],intent=new ShareReferralIntent({get:()=>undefined,set(){}},async id=>calls.push(id));intent.update(session());assert.throws(()=>intent.capture(token,8),/保存未确认/u);assert.deepEqual(calls,[]);
});
function posterRuntime(override){return runtime({feature:'useSpreadPoster',send:call=>override?.(call)??{data:call.url.endsWith('/user/spread_info')?poster:dto}});}
test('actual promotion composable loads templates and real actor data, selection is bounded',async()=>{
  const r=posterRuntime();try{await r.start({});assert.equal(r.checkout.data.value.nickname,'当前会员');assert.equal(r.checkout.code.value,image);r.checkout.choose(1);assert.equal(r.checkout.selected.value,1);r.checkout.choose(2);assert.equal(r.checkout.selected.value,1);assert.equal(r.calls.filter(v=>v.url.includes('/get_qrcode/-1/11')).length,1);assert.equal(r.calls.filter(v=>v.url.includes('/api.qrserver')).length,0);}finally{r.stop();}
});
test('promotion hide, logout and replacement accounts clear all old media and discard late results',async()=>{
  for(const mode of ['hide','logout','replace']){const gate=deferred(),r=posterRuntime(()=>gate.promise);try{r.hooks.onShow();await tick();if(mode==='hide')r.hooks.onHide();else if(mode==='logout')r.auth.clear();else r.auth.setLogin('new-actor',22);gate.resolve({data:poster});await tick();assert.equal(r.checkout.data.value,null);assert.equal(r.checkout.code.value,'');assert.equal(r.checkout.loading.value,false);}finally{gate.resolve({data:poster});r.stop();}}
});
test('missing official mini codes and mismatched identities remain explicit and retryable',async()=>{
  let failed=true;const r=posterRuntime(call=>call.url.includes('/get_qrcode/')?{data:{...dto,routineUrl:failed?'':dto.routineUrl}}:undefined);try{await r.start({});assert.match(r.checkout.error.value,/小程序/u);assert.equal(r.checkout.data.value,null);failed=false;await r.checkout.load();assert.equal(r.checkout.data.value.nickname,poster.nickname);}finally{r.stop();}
  const mismatch=posterRuntime(call=>call.url.includes('/get_qrcode/')?{data:{...dto,nickname:'别的会员'}}:undefined);try{await mismatch.start({});assert.match(mismatch.checkout.error.value,/身份/u);assert.equal(mismatch.checkout.data.value,null);}finally{mismatch.stop();}
});
test('private member/order consumers send exact identity and never invoke a financial write',async()=>{
  for(const [type,id,orderId]of [[90,11,undefined],[91,44,'ORDER-44']]){const r=runtime({component:'components/LegacyShareCode.vue',props:{type,id,orderId},send:()=>({data:dto})});try{await r.checkout.generate();assert.equal(r.calls.length,1);assert.ok(r.calls[0].url.endsWith(`/get_qrcode/${type}/${id}`));assert.deepEqual(r.calls[0].data,orderId?{order_id:orderId}:{});assert.equal(r.checkout.code.value,image);r.hooks.onHide();assert.equal(r.checkout.code.value,'');}finally{r.stop();}}
});
test('signed image queries remain intact and mini base64 images decode into owned temporary files',async()=>{
  const r=posterRuntime();const writes=[],unlinks=[],images=[];r.uni.env={USER_DATA_PATH:'/owned-test'};r.uni.getFileSystemManager=()=>({writeFile:o=>{writes.push(o);o.success();},unlink:o=>unlinks.push(o.filePath)});r.uni.getImageInfo=o=>{images.push(o.src);o.success({path:o.src});};try{const module=r.load(path.join(__dirname,'../src/utils/shareImage.ts'));const file=await module.readableShareImage('data:image/png;base64,iVBORw0KGgo=');assert.equal(writes[0].encoding,'base64');assert.equal(writes[0].data,'iVBORw0KGgo=');assert.match(file.path,/^\/owned-test\/cinashop-share-/u);file.release();assert.deepEqual(unlinks,[file.path]);await module.readableShareImage(image);assert.ok(images.some(v=>v.endsWith(image)));}finally{r.stop();}
});
test('activity share descriptor distinguishes actual bargain query and six published detail pages',()=>{
  for(const [type,page,key]of [[1,'seckillDetail','id'],[2,'bargainDetail','bargain_id'],[3,'detail','id'],[4,'integralDetail','id'],[6,'presaleDetail','id'],[7,'newcomerDetail','id']])assert.deepEqual(protocol.activityShareDescriptor(`/pages/activity/${page}?${key}=7`),{type,id:7});
  assert.equal(protocol.activityShareDescriptor('/pages/activity/bargainDetail?id=7'),null);
});
test('actual poster failure, hide and actor replacement release every late native file once and disable old canvas save',async()=>{
  for(const mode of ['failure','hide','replace']){
    const props=require('vue').reactive({template:'/template.png',avatar:'/avatar.png',nickname:'会员',siteName:'商城',code:'data:image/png;base64,iVBORw0KGgo=',active:true,ownerUid:11,ownerVersion:1});
    const r=runtime({component:'components/SpreadPoster.vue',props,send:()=>({data:null})}),reads=[],unlinks=[],draws=[],saved=[];
    r.uni.env={USER_DATA_PATH:'/owned-poster'};r.uni.getFileSystemManager=()=>({writeFile:o=>o.success(),unlink:o=>unlinks.push(o.filePath)});
    r.uni.getImageInfo=o=>reads.push(o);r.uni.canvasToTempFilePath=o=>saved.push(o);
    r.uni.createCanvasContext=()=>({setFillStyle(){},fillRect(){},setFontSize(){},fillText(){},drawImage(...args){draws.push(args);},draw(_flag,done){done?.();}});
    try{const pending=r.checkout.draw();await tick();assert.equal(reads.length,3);
      if(mode==='failure'){reads.find(o=>o.src==='/template.png').fail();await pending;}
      else if(mode==='hide')props.active=false;else r.auth.setLogin('replacement',22);
      for(const read of reads)read.success({path:read.src});await pending;await tick();
      assert.equal(unlinks.filter(file=>file.startsWith('/owned-poster/cinashop-share-')).length,1);assert.equal(new Set(unlinks).size,unlinks.length);
      assert.equal(r.checkout.ready.value,false);r.checkout.save();assert.equal(saved.length,0);assert.equal(draws.length,0);
    }finally{r.stop();}
  }
});

test('private scenes reject raw code URLs, role swaps and unproved owner order destinations',()=>{
 const row={type:91,id:44,spid:0,namespace:'order',code:'001234567890',viewer_scope:'staff',path:'/pages/operator/writeoff?role=staff'};
 assert.equal(protocol.parseShareScene(row).viewer_scope,'staff');
 for(const invalid of [{...row,path:'/pages/operator/writeoff?role=staff&code=001234567890'},{...row,path:'/pages/customer-work/scanning?value=001234567890&namespace=order-code'},{...row,viewer_scope:'delivery'},{...row,viewer_scope:'owner',path:'/pages/order/detail?orderId=ORDER-44'},{...row,viewer_scope:'owner',order_id:'ORDER-45',path:'/pages/order/detail?orderId=ORDER-44'}])assert.throws(()=>protocol.parseShareScene(invalid));
});
test('private scan handoff is memory only, precise-target and session bound, one-use and expires after 30 seconds',()=>{
 const {ShareScanTransfer}=pure('shareScanTransfer');let now=1000;const intent=new ShareScanTransfer(()=>now),actor={uid:11,token:'actor',sessionVersion:1},scene={type:91,id:44,spid:0,namespace:'order',code:'001234567890',viewer_scope:'staff',path:'/pages/operator/writeoff?role=staff'};
 const take=()=>intent.take(scene.path,actor);
 intent.stage(scene,actor);assert.deepEqual(take(),{namespace:'order-code',value:scene.code});assert.equal(take(),null);
 for(const replacement of [{...actor,uid:22},{...actor,token:'replacement'},{...actor,sessionVersion:2}]){intent.stage(scene,actor);assert.equal(intent.take(scene.path,replacement),null);assert.equal(take(),null);}
 intent.stage(scene,actor);assert.equal(intent.take('/pages/customer-work/scanning',actor),null);assert.equal(take(),null);
 intent.stage(scene,actor);now+=30000;assert.equal(take(),null);
 assert.throws(()=>intent.stage({...scene,viewer_scope:'owner'},actor));assert.throws(()=>intent.stage(scene,{uid:0,token:'',sessionVersion:1}));
});
test('actual landing passes only static staff target and once runtime input; owner goes to own display',async()=>{
 for(const owner of [false,true]){
  const scene={type:90,id:11,spid:0,namespace:'member',code:'001234567',viewer_scope:owner?'owner':'staff',path:owner?'/pages/user/memberCode':'/pages/operator/writeoff?role=staff'};
  const r=runtime({component:'pages/share/landing.vue',send:()=>({data:scene})}),destinations=[];r.uni.navigateTo=o=>destinations.push(o.url);
  try{await r.start({q:token});r.checkout.open();assert.deepEqual(destinations,[scene.path]);assert.equal(destinations.some(v=>v.includes(scene.code)),false);const transfer=r.load(path.join(__dirname,'../src/utils/shareScanTransfer.ts')).shareScanTransfer;const hint=transfer.take(scene.path,r.auth);assert.deepEqual(hint,owner?null:{namespace:'member-barcode',value:scene.code});assert.equal(transfer.take(scene.path,r.auth),null);}finally{r.stop();}
 }
});

test('actual staff consumer rechecks operator profile before read lookup and sends no financial write',async()=>{
 let qualified=true;
 for(const allowed of [true,false]){qualified=allowed;const r=runtime({component:'pages/operator/writeoff.vue',send:call=>({data:call.url.endsWith('/store/operator/profile')?{can_writeoff:qualified,staff_stores:qualified?[{store_id:1,store_name:'门店'}]:[],delivery:null,delivery_identity_conflict:false}:{data:[]}})});
 try{const transfer=r.load(path.join(__dirname,'../src/utils/shareScanTransfer.ts')).shareScanTransfer;transfer.stage({type:90,id:11,spid:0,namespace:'member',code:'001234567',viewer_scope:'staff',path:'/pages/operator/writeoff?role=staff'},r.auth);await r.start({role:'staff'});assert.equal(r.calls[0].url.endsWith('/store/operator/profile'),true);assert.equal(r.calls.some(v=>v.url.endsWith('/member_lookup')),allowed);assert.equal(r.calls.some(v=>/\/(member_writeoff|writeoff)$/u.test(v.url)),false);assert.equal(r.navigations.some(v=>v.includes('001234567')),false);}finally{r.stop();}}
});
test('actual delivery consumer waits for qualified scope then prefills only once without automatic lookup or write',async()=>{
 const R=require('./delivery-workbench-runtime.cjs'),r=R.runtime({component:'pages/delivery/scanning.vue'});
 try{const transfer=r.load(path.join(__dirname,'../src/utils/shareScanTransfer.ts')).shareScanTransfer;transfer.stage({type:91,id:44,spid:0,namespace:'order',code:'001234567890',viewer_scope:'delivery',path:'/pages/delivery/scanning'},r.auth);await r.start({});assert.equal(r.page.code.value,'');assert.equal(r.calls.length,1);r.page.controller.chooseScope({detail:{value:0}});await R.tick();assert.equal(r.page.code.value,'001234567890');assert.equal(r.calls.some(v=>v.url.endsWith('/writeoff/info')||v.url.endsWith('/writeoff')),false);r.hooks.onHide();assert.equal(r.page.code.value,'');r.hooks.onShow();await R.tick();assert.equal(r.page.code.value,'');}finally{r.stop();}
});

test('actual customer receiver rechecks global read qualification before the explicit member namespace lookup',async()=>{
 const R=require('./user-center-runtime.cjs'),read=require('./customer-work-runtime.test.cjs');
 for(const allowed of [true,false]){const r=R.runtime({component:'pages/customer-work/scanning.vue',send:call=>{if(call.url.endsWith('/context')){const result=read.fixture(call);result.data.data.capabilities.writeoff_read=allowed;return result;}if(call.url.endsWith('/writeoff/lookup'))return{status:403,msg:'当前目标需重新核对'};return read.fixture(call);}});
 try{const transfer=r.load(path.join(__dirname,'../src/utils/shareScanTransfer.ts')).shareScanTransfer;transfer.stage({type:90,id:11,spid:0,namespace:'member',code:'001234567',viewer_scope:'customer',path:'/pages/customer-work/scanning'},r.auth);await r.start({});const lookups=r.calls.filter(c=>c.url.endsWith('/writeoff/lookup'));assert.equal(lookups.length,allowed?1:0);if(allowed){assert.equal(lookups[0].data.namespace,'member-barcode');assert.equal(lookups[0].data.value,'001234567');}assert.equal(r.calls.some(c=>c.url.endsWith('/execute')),false);assert.equal(r.navigations.some(v=>v.includes('001234567')),false);}finally{r.stop();}}
});
test('actual follow closes its dialog before raster preview and ignores a closed/reopened dialog late response',async()=>{
 for(const late of [false,true,'hide']){const gate=deferred(),r=runtime({component:'components/diy/DiyEditorialWidget.vue',props:{block:{name:'follow'}},send:()=>gate.promise}),previews=[];r.uni.getImageInfo=o=>o.success({path:o.src});r.uni.previewImage=o=>previews.push({path:o.current,dialogOpen:r.checkout.followCodeOpen.value});
 try{r.checkout.followCodeOpen.value=true;const request=r.checkout.previewFollowPoster();await tick();if(late){r.checkout.followCodeOpen.value=false;r.checkout.followCodeOpen.value=true;if(late==='hide')r.hooks.onHide();}gate.resolve({data:{path:'/api/wechat/follow/image/revision?expires=1800000000&signature=fixture'}});await request;assert.equal(previews.length,late?0:1);if(!late)assert.equal(previews[0].dialogOpen,false);}finally{gate.resolve({data:null});r.stop();}}
});

test('actual H5 same-document landing changes token, fences late private result and rejects duplicate query before new read',async()=>{
 const prior=global.window,handlers=new Map(),gate=deferred(),second='b'.repeat(24);global.window={location:{hash:'/pages/share/landing?q='+token,origin:'http://localhost'},addEventListener:(key,fn)=>handlers.set(key,fn),removeEventListener:(key,fn)=>{if(handlers.get(key)===fn)handlers.delete(key);}};
 let r;try{r=runtime({component:'pages/share/landing.vue',send:call=>call.url.endsWith(token)?gate.promise:{data:{type:0,id:7,spid:0,path:'/pages/goods/detail?id=7'}}});await r.start({q:token});assert.equal(r.checkout.loading.value,true);global.window.location.hash='/pages/share/landing?q='+second;handlers.get('hashchange')();await tick();assert.equal(r.checkout.scene.value.id,7);gate.resolve({data:{type:90,id:11,spid:0,namespace:'member',code:'001234567',viewer_scope:'staff',path:'/pages/operator/writeoff?role=staff'}});await tick();assert.equal(r.checkout.scene.value.type,0);const before=r.calls.length;global.window.location.hash='/pages/share/landing?q='+second+'&q='+token;handlers.get('hashchange')();await tick();assert.equal(r.calls.length,before);assert.equal(r.checkout.scene.value,null);assert.equal(r.checkout.token.value,'');r.stop();assert.equal(handlers.has('hashchange'),false);r=null;}finally{gate.resolve({data:null});r?.stop();if(prior===undefined)delete global.window;else global.window=prior;}
});


test('native promotion consumes signed API assets and absolute legacy media, never invents worker uploads',()=>{
 const asset='/api/assets/7?expires=1800000000&signature='+('s'.repeat(43)),data={...poster,spread:[{pic:asset}],avatar:asset},native=protocol.parseSpreadPosterData(data,'https://native.example');assert.equal(native.spread[0].pic,'https://native.example'+asset);assert.equal(native.avatar,'https://native.example'+asset);assert.throws(()=>protocol.parseSpreadPosterData(poster,'https://native.example'),/尚未映射/u);assert.throws(()=>protocol.parseSpreadPosterData({...data,avatar:'/api/assets/7'},'https://native.example'));assert.equal(protocol.parseSpreadPosterData(poster).avatar,'/avatar.png');const mapped=protocol.parseSpreadPosterData({...poster,spread:[{pic:'https://public.example/uploads/template.png'}],avatar:'https://public.example/uploads/avatar.png'},'https://native.example');assert.equal(mapped.avatar,'https://public.example/uploads/avatar.png');
});
test('actual share protocol works with both Web URL globals absent on native runtimes',()=>{
 const savedURL=global.URL,savedQuery=global.URLSearchParams;try{global.URL=undefined;global.URLSearchParams=undefined;assert.deepEqual(protocol.parseLegacyShareCode(dto),dto);assert.equal(protocol.shareCodeImage('https://api.example'+image,'https://api.example'),'https://api.example'+image);assert.equal(protocol.posterImage('https://public.example/uploads/template.png'),'https://public.example/uploads/template.png');assert.equal(protocol.shareDestination(protocol.parseShareScene({type:0,id:7,spid:8,path:'/pages/goods/detail?id=7&spid=8'})),'/pages/goods/detail?id=7');assert.equal(protocol.parseShareScene({type:90,id:11,spid:0,namespace:'member',code:'001234567',viewer_scope:'staff',path:'/pages/operator/writeoff?role=staff'}).viewer_scope,'staff');assert.deepEqual(protocol.activityShareDescriptor('/pages/activity/bargainDetail?bargain_id=7'),{type:2,id:7});for(const invalid of [image+'&signature=duplicate','https://api.example@evil.example'+image,'https://api.example/a/../'+image.slice(1)])assert.throws(()=>protocol.shareCodeImage(invalid,'https://api.example'));}finally{global.URL=savedURL;global.URLSearchParams=savedQuery;}
});
