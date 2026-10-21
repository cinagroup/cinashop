const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
const post = (id=31, extra={}) => ({id,type:2,relationId:22,contentType:1,title:`帖子${id}`,content:'当前内容',image:'',sliderImage:null,
  likeNum:7,isLike:0,commentNum:4,playNum:8,shareNum:9,status:1,is_verify:1,addTime:100,site_url:'https://shop.example.test',...extra});
const setup = send => runtime({feature:'useCommunityEngagement',send:send??(call=>({data:post(Number(call.url.split('/').at(-1)))}))});
const count = (r,part) => r.calls.filter(call=>call.url.includes(part)).length;
const api = r => r.load(path.join(root,'src/api/community.ts'));
const utilities = r => r.load(path.join(root,'src/utils/communityShare.ts'));

test('post engagement sends explicit desired states and applies only authoritative returned counters',async()=>{
  let state=0;const r=setup(call=>call.url.includes('/like/')?{data:{status:state=call.data.status,likeNum:state?83:71}}:{data:post()});
  try{const e=r.checkout;e.adopt([post()],e.nextTicket());await e.toggleLike(post());assert.equal(e.view(post()).isLike,1);assert.equal(e.view(post()).likeNum,83);
    await e.toggleLike(post());assert.deepEqual(r.calls.filter(c=>c.url.includes('/like/')).map(c=>c.data),[{status:1},{status:0}]);assert.equal(e.view(post()).likeNum,71);assert.equal(count(r,'/detail/'),0);
  }finally{r.stop();}
});
test('a pending post write blocks duplicate and different-post writes without repainting another post',async()=>{
  const pending=deferred();const r=setup(()=>pending.promise);
  try{const e=r.checkout;const work=e.toggleLike(post());await tick();await e.toggleLike(post());await e.toggleLike(post(32));assert.equal(count(r,'/like/'),1);
    pending.resolve({data:{status:1,likeNum:42}});await work;assert.equal(e.view(post()).likeNum,42);assert.equal(e.view(post(32)).likeNum,7);
  }finally{pending.resolve({data:{status:1,likeNum:42}});r.stop();}
});
test('unknown like receipts survive composable destruction without an automatic state read or replay',async()=>{
  for(const result of [{transport:'offline'},{httpStatus:503,status:503},{data:{status:0,likeNum:8}}]){
    const r=setup(call=>call.url.includes('/like/')?result:{data:post(31,{isLike:1,likeNum:8})});let scope;
    try{const e=r.checkout;await e.toggleLike(post());assert.equal(e.unknown(31),true);e.dispose();scope=vue.effectScope();const other=scope.run(()=>r.load(path.join(root,'src/composables/useCommunityEngagement.ts')).useCommunityEngagement());
      assert.equal(other.unknown(31),true);assert.equal(count(r,'/state/'),0);await other.toggleLike(post());assert.equal(count(r,'/like/'),1);
      await other.reconcile(31);assert.equal(other.unknown(31),false);assert.equal(other.view(post()).isLike,1);assert.equal(count(r,'/state/'),1);assert.equal(count(r,'/detail/'),0);
    }finally{scope?.stop();r.stop();}
  }
});
test('late acknowledgements across hide, unload and same-UID replacement cannot clear a newer operation',async()=>{
  for(const boundary of ['hide','unload','owner','version']){
    const first=deferred(),second=deferred();let calls=0;const r=setup(()=>++calls===1?first.promise:second.promise);let scope;
    try{const e=r.checkout;const old=e.toggleLike(post());await tick();
      if(boundary==='hide'||boundary==='unload'){r.hooks[boundary==='hide'?'onHide':'onUnload']();first.resolve({data:{status:1,likeNum:99}});await old;
        scope=vue.effectScope();const fresh=scope.run(()=>r.load(path.join(root,'src/composables/useCommunityEngagement.ts')).useCommunityEngagement());assert.equal(fresh.unknown(31),true);assert.equal(fresh.view(post()).likeNum,7);
      }else{r.auth.setLogin(boundary==='owner'?'other-token':'synthetic-local-token',11);const fresh=e.toggleLike(post());await tick();first.resolve({data:{status:1,likeNum:99}});await old;assert.equal(e.busy.value,true);assert.equal(e.unknown(31),false);second.resolve({data:{status:1,likeNum:18}});await fresh;assert.equal(e.view(post()).likeNum,18);}
    }finally{first.resolve({data:{status:1,likeNum:99}});second.resolve({data:{status:1,likeNum:18}});scope?.stop();r.stop();}
  }
});
test('an older state read cannot clear an unresolved marker when its exact post receipt is malformed',async()=>{
  let reads=0;const r=setup(call=>call.url.includes('/like/')?{transport:'lost'}:{data:post(++reads===1?32:31,{isLike:1})});
  try{await r.checkout.toggleLike(post());await r.checkout.reconcile(31);assert.equal(r.checkout.unknown(31),true);await r.checkout.toggleLike(post());assert.equal(count(r,'/like/'),1);
    await r.checkout.reconcile(31);assert.equal(r.checkout.unknown(31),false);assert.equal(count(r,'/detail/'),0);
  }finally{r.stop();}
});
test('certain rejection keeps displayed counters and permits a new explicit action while invalid success stays unknown',async()=>{
  const r=setup(()=>({httpStatus:400,status:400,msg:'不可点赞'}));
  try{await r.checkout.toggleLike(post());assert.equal(r.checkout.unknown(31),false);assert.equal(r.checkout.view(post()).likeNum,7);assert.equal(r.checkout.errors.value[31],'不可点赞');await r.checkout.toggleLike(post());assert.equal(count(r,'/like/'),2);
    for(const value of [-1,2147483648,NaN]){const x=setup(()=>({data:{status:1,likeNum:value}}));try{await x.checkout.toggleLike(post());assert.equal(x.checkout.unknown(31),true);}finally{x.stop();}}
  }finally{r.stop();}
});
test('late feed counters cannot overwrite a completed write and a newer read can replace its projection',async()=>{
  const pending=deferred();const r=setup(()=>pending.promise);
  try{const e=r.checkout;e.adopt([post()],e.nextTicket());const old=e.nextTicket();const work=e.toggleLike(post());await tick();pending.resolve({data:{status:1,likeNum:99}});await work;
    assert.equal(e.adopt([post(31,{likeNum:2,isLike:0})],old)[0].likeNum,99);assert.equal(e.view(post()).isLike,1);
    assert.equal(e.adopt([post(31,{likeNum:123,isLike:0})],e.nextTicket())[0].likeNum,123);
  }finally{pending.resolve({data:{status:1,likeNum:99}});r.stop();}
});
test('private previews, malformed rows and absent login cannot send engagement writes',async()=>{
  const r=setup(()=>({data:{status:1,likeNum:8}}));
  try{await r.checkout.toggleLike(post(31,{status:0}));await r.checkout.toggleLike(post(31,{is_verify:0}));await r.checkout.toggleLike(post(2147483648));await r.checkout.toggleLike(post(31,{likeNum:-1}));assert.equal(count(r,'/like/'),0);
    r.auth.clear();await r.checkout.toggleLike(post());assert.equal(count(r,'/like/'),0);assert.ok(r.navigations.includes('/pages/auth/login'));
  }finally{r.stop();}
});
test('copy shares read fresh state, use a bounded canonical URL and count once only after native clipboard success',async()=>{
  const order=[],r=setup(call=>{order.push(call.url);return{data:call.url.includes('/share/')?{shareNum:10}:post()};});let copied;
  try{r.uni.setClipboardData=options=>{copied=options;options.success();options.success();};const e=r.checkout;await e.openShare(post());await e.copyShare();await tick();
    assert.equal(copied.data,'https://shop.example.test/#/pages/discover/workspace?id=31&spid=11');assert.deepEqual(order,['/api/community/state/31','/api/community/share/31']);assert.equal(e.view(post()).shareNum,10);assert.match(e.notices.value[31],/链接已复制/);
  }finally{r.stop();}
});
test('clipboard failure and a failed freshness read never count a share intent',async()=>{
  const r=setup(()=>({data:post()}));
  try{r.uni.setClipboardData=options=>options.fail();await r.checkout.openShare(post());await r.checkout.copyShare();assert.equal(count(r,'/share/'),0);assert.equal(r.checkout.busy.value,false);
    const x=setup(()=>({httpStatus:503,status:503}));try{x.uni.setClipboardData=()=>{throw Error('must not copy stale metadata');};await x.checkout.openShare(post());await x.checkout.copyShare();assert.equal(count(x,'/share/'),0);assert.equal(x.checkout.shareReady.value,false);}finally{x.stop();}
  }finally{r.stop();}
});
test('late clipboard callbacks after close, hide or account change never send a share GET',async()=>{
  for(const boundary of ['close','hide','owner']){const r=setup(()=>({data:post()}));let options;
    try{r.uni.setClipboardData=input=>{options=input;};await r.checkout.openShare(post());const work=r.checkout.copyShare();await tick();
      if(boundary==='close')r.checkout.closeShare();else if(boundary==='hide')r.hooks.onHide();else r.auth.setLogin('replacement',22);
      options.success();await work;assert.equal(count(r,'/share/'),0);assert.equal(r.checkout.busy.value,false);
    }finally{options?.success();r.stop();}
  }
});
test('a committed-lost share is not replayed after reopening its panel; only manual state reconciliation unlocks a new intent',async()=>{
  let shares=0;const r=setup(call=>call.url.includes('/share/')?(++shares===1?{httpStatus:503,status:503}:{data:{shareNum:11}}):{data:post(31,{shareNum:10})});
  try{r.uni.setClipboardData=input=>input.success();const e=r.checkout;await e.openShare(post());await e.copyShare();assert.equal(e.unknown(31),true);e.closeShare();await e.openShare(post());await e.copyShare();assert.equal(shares,1);assert.equal(e.unknown(31),true);
    await e.reconcile(31);assert.equal(e.unknown(31),false);await e.copyShare();assert.equal(shares,2);assert.equal(count(r,'/detail/'),0);
  }finally{r.stop();}
});
test('App sharing verifies the actual native adapter capability and distinguishes provider success from materials',async()=>{
  for(const mode of ['unsupported','absent','provider-fail','native-fail','success']){const native=[],r=setup(call=>({data:call.url.includes('/share/')?{shareNum:10}:post()}));
    try{if(mode!=='unsupported'){r.uni.getProvider=options=>mode==='provider-fail'?options.fail():options.success({provider:mode==='absent'?['other']:['weixin']});r.uni.share=options=>{native.push(options);if(mode==='success')options.success();else options.fail();};}
      await r.checkout.openShare(post());await r.checkout.appShare('WXSceneTimeline');assert.equal(count(r,'/share/'),mode==='success'?1:0);assert.equal(native.length,['native-fail','success'].includes(mode)?1:0);
      if(mode==='success'){assert.equal(native[0].scene,'WXSceneTimeline');assert.equal(native[0].provider,'weixin');assert.equal(native[0].href,'https://shop.example.test/#/pages/discover/workspace?id=31&spid=11');assert.match(r.checkout.notices.value[31],/服务已返回成功/);}
    }finally{r.stop();}
  }
});
test('late native provider and share acknowledgements cannot invoke another account or record a stale post',async()=>{
  for(const step of ['provider','native']){let provider,share;const r=setup(()=>({data:post()}));
    try{r.uni.getProvider=input=>{provider=input;};r.uni.share=input=>{share=input;};await r.checkout.openShare(post());const work=r.checkout.appShare('WXSceneSession');await tick();
      if(step==='native'){provider.success({provider:['weixin']});await tick();assert.ok(share);}r.auth.setLogin('new-account',22);
      if(step==='provider')provider.success({provider:['weixin']});else share.success();await work;assert.equal(count(r,'/share/'),0);if(step==='provider')assert.equal(share,undefined);
    }finally{provider?.fail();share?.fail();r.stop();}
  }
});
test('small-program message and timeline materials bind fixed post identity, referral and explicit share intent',async()=>{
  const r=setup(call=>({data:call.url.includes('/share/')?{shareNum:10}:post()}));
  try{const e=r.checkout;await e.openShare(post());const message=e.miniMessage({from:'button',target:{dataset:{postId:31}}});assert.deepEqual(message,{title:'帖子31',path:'/pages/discover/workspace?id=31&spid=11',imageUrl:''});
    assert.deepEqual(e.miniMessage({from:'button',target:{dataset:{postId:32}}}),{});await tick();const timeline=e.miniTimeline();assert.deepEqual(timeline,{title:'帖子31',query:'post_id=31&post_type=1&spid=11',imageUrl:''});await tick();assert.equal(count(r,'/share/'),2);assert.equal(count(r,'/detail/'),0);
    assert.deepEqual(utilities(r).communityInbound('/pages/discover/discoverTopic/index',{post_id:'31',post_type:'1',spid:'11'}),{id:31,contentType:1,spid:11});
  }finally{r.stop();}
});
test('small-program repeated taps and unknown receipts cannot record a second share without explicit reconciliation',async()=>{
  const pending=deferred();const r=setup(call=>call.url.includes('/share/')?pending.promise:{data:post()});
  try{await r.checkout.openShare(post());assert.ok(r.checkout.miniMessage({from:'button',target:{dataset:{postId:'31'}}}).path);assert.deepEqual(r.checkout.miniTimeline(),{});await tick();assert.equal(count(r,'/share/'),1);pending.resolve({httpStatus:503,status:503});await tick();assert.equal(r.checkout.unknown(31),true);assert.deepEqual(r.checkout.miniTimeline(),{});assert.equal(count(r,'/share/'),1);
  }finally{pending.resolve({httpStatus:503,status:503});r.stop();}
});
test('canonical community links reject duplicate, malformed, unbounded, conflicting and credential-bearing identities',()=>{
  const r=setup();try{const u=utilities(r);assert.equal(u.communitySharePath(31,2,11),'/pages/discover/discoverVideo/index?id=31&spid=11');assert.equal(u.communitySharePath(2147483648,1,0),'');assert.equal(u.communityShareUrl('/pages/discover/workspace?id=31','https://u:p@evil.test'),'');
    for(const raw of ['id=31&id=32','id=31&spid=1&spid=2','id=%','__proto__=a&__proto__=b'])assert.throws(()=>u.communityQuery(raw));
    for(const query of [{id:'0'},{id:'01'},{id:'2147483648'},{id:['31','32']},{id:'31',spid:'2147483648'},{id:'31',author_id:'11'},{post_id:'31',post_type:'9'},{post_id:'31',post_type:'1',id:'32'}])assert.throws(()=>u.communityInbound('/pages/discover/workspace',query));
    assert.deepEqual(u.communityEmbeddedVideo(encodeURIComponent('https://untrusted.test/pages/discover/discoverVideo/index?id=31&spid=11&token=discard')),{id:'31',relation_id:undefined,content_type:undefined,spid:'11'});assert.equal(u.communityEmbeddedVideo('/pages/discover/discoverVideo/index?id=31&id=32'),null);
    assert.equal(u.communityInbound('/pages/goods/detail',{id:'31',spid:'11'}),null);
  }finally{r.stop();}
});
test('actual registered legacy detail page opens a bounded local post and rejects malformed identity before any business I/O',async()=>{
  for(const input of [{id:'31',spid:'11'},{id:'31',spid:'0'},{id:'0'},{id:'31',spid:['11','22']},{id:'31',author_id:'11'},{}]){
    const r=runtime({component:'pages/discover/discoverDetails/index.vue',send:()=>({data:{}})});
    try{await r.start(input);if(input.id==='31'&&['0','11'].includes(input.spid))assert.deepEqual(r.navigations,[`/pages/discover/workspace?id=31${input.spid==='11'?'&spid=11':''}`]);else assert.deepEqual(r.navigations,[]);assert.equal(r.calls.length,0);}finally{r.stop();}
  }
});
test('community referral intent is consumed once by its first coherent account and never forwarded after a switch',async()=>{
  const pending=deferred();const r=setup(()=>pending.promise);
  try{const referrals=r.load(path.join(root,'src/composables/useShareReferral.ts')).useShareReferral();const input={path:'pages/discover/workspace',query:{id:'31',spid:'22'}};referrals.captureInbound(input);referrals.captureInbound(input);await tick();assert.equal(r.calls.length,1);assert.equal(r.calls[0].data.spread_uid,22);
    r.auth.setLogin('other',33);pending.resolve({data:{}});await tick();referrals.captureInbound(input);await tick();assert.equal(r.calls.length,1);
  }finally{pending.resolve({data:{}});r.stop();}
});
test('main feed clears rendered personal state at account boundary and rejects the old rejection catch',async()=>{
  const pending=deferred();let old=false;
  const r=runtime({feature:'useCommunityHomeFeed',send:call=>call.url.includes('/follow')?{data:[{relation_id:old?22:11,author:'本人旧关注'}]}:call.url.endsWith('/topic')?{data:[]}:old?pending.promise:{data:[post()]}});
  try{await r.checkout.load();assert.equal(r.checkout.highlights.value[0].relation_id,11);old=true;const first=r.checkout.load();await tick();r.auth.setLogin('new-owner',22);assert.deepEqual(r.checkout.highlights.value,[]);assert.deepEqual(r.checkout.posts.value,[]);
    pending.resolve({httpStatus:503,status:503,msg:'old failure'});await first;await tick();assert.notEqual(r.checkout.highlights.value[0]?.relation_id,11);assert.deepEqual(r.checkout.posts.value,[]);
  }finally{pending.resolve({data:[]});r.stop();}
});
test('same-owner older main-list failures and hidden responses cannot replace a newer feed',async()=>{
  const pending=deferred();let lists=0;const r=runtime({feature:'useCommunityHomeFeed',send:call=>call.url.endsWith('/list')?(++lists===1?pending.promise:{data:[post(32)]}):{data:[]}});
  try{const old=r.checkout.load();await tick();await r.checkout.load();assert.equal(r.checkout.posts.value[0].id,32);pending.resolve({httpStatus:503,status:503,msg:'old'});await old;assert.equal(r.checkout.posts.value[0].id,32);assert.equal(r.checkout.error.value,'');
    r.hooks.onHide();assert.deepEqual(r.checkout.posts.value,[]);await r.checkout.load();assert.equal(lists,2);
  }finally{pending.resolve({data:[]});r.stop();}
});
test('post preview like is idempotent across same desired-state replays',async()=>{
  const previous=global.window;global.window={location:{hostname:'localhost',search:'?preview=1',href:'http://localhost/#/pages/discover/index'}};let r;
  try{r=setup();const a=api(r);const before=await a.apiCommunityDetail(9001);const once=await a.apiCommunityLike(9001,1);const again=await a.apiCommunityLike(9001,1);assert.equal(once.likeNum,before.likeNum+1);assert.deepEqual(again,once);await a.apiCommunityLike(9001,0);const zero=await a.apiCommunityLike(9001,0);assert.equal(zero.likeNum,before.likeNum);
  }finally{r?.stop();if(previous===undefined)delete global.window;else global.window=previous;}
});
test('each native adapter terminal is one-shot and a late failure cannot clear an already pending share receipt',async()=>{
  for(const mode of ['clipboard','app']){const pending=deferred();let clipboard,provider,native,nativeCalls=0;const r=setup(call=>call.url.includes('/share/')?pending.promise:{data:post()});
    try{r.uni.setClipboardData=input=>{clipboard=input;};r.uni.getProvider=input=>{provider=input;};r.uni.share=input=>{native=input;nativeCalls++;};await r.checkout.openShare(post());
      const work=mode==='clipboard'?r.checkout.copyShare():r.checkout.appShare('WXSceneSession');await tick();
      if(mode==='clipboard'){clipboard.success();clipboard.fail();clipboard.success();}else{provider.success({provider:['weixin']});provider.success({provider:['weixin']});provider.fail();assert.equal(nativeCalls,1);native.success();native.fail();native.success();}
      await tick();assert.equal(count(r,'/share/'),1);assert.equal(r.checkout.busy.value,true);await r.checkout.copyShare();assert.equal(count(r,'/share/'),1);
      pending.resolve({httpStatus:503,status:503});await work;assert.equal(r.checkout.unknown(31),true);if(mode==='clipboard')clipboard.fail();else native.fail();assert.equal(r.checkout.unknown(31),true);
    }finally{pending.resolve({httpStatus:503,status:503});r.stop();}
  }
});
test('actual main page records one visit per open and uses read-only state for media and interactive refreshes',async()=>{
  let visits=0,liked=0;const r=runtime({component:'pages/discover/index.vue',send:call=>({data:call.url.includes('/detail/')?post(31,{playNum:8+(++visits),isLike:liked})
    :call.url.includes('/state/')?post(31,{playNum:8+visits,isLike:liked})
      :call.url.includes('/like/')?{status:liked=call.data.status,likeNum:liked?8:7}:call.url.endsWith('/list')?[post()]:[]})});
  try{await r.start();await r.checkout.openDetail(post());assert.equal(visits,1);await r.checkout.openDetail(post());assert.equal(visits,1);
    await r.checkout.engagement.toggleLike(r.checkout.detail.value);assert.equal(r.checkout.detail.value.isLike,1);assert.equal(r.checkout.posts.value[0].likeNum,8);
    await r.checkout.reloadVideo();await r.checkout.engagement.reconcile(31);assert.equal(visits,1);assert.equal(count(r,'/state/'),2);
    r.checkout.closeDetail();await r.checkout.openDetail(post());assert.equal(visits,2);assert.equal(r.checkout.detail.value.playNum,10);
  }finally{r.stop();}
});
test('actual main detail reads are fenced across a new post, owner change, hide and unload',async()=>{
  for(const boundary of ['post','owner','hide','unload']){const old=deferred();const r=runtime({component:'pages/discover/index.vue',send:call=>call.url.endsWith('/detail/31')?old.promise:{data:call.url.endsWith('/detail/32')?post(32):[]}});
    try{await r.start();const work=r.checkout.openDetail(post());await tick();if(boundary==='post')await r.checkout.openDetail(post(32));else if(boundary==='owner')r.auth.setLogin('replacement',22);else r.hooks[boundary==='hide'?'onHide':'onUnload']();old.resolve({data:post()});await work;
      assert.equal(r.checkout.detail.value?.id,boundary==='post'?32:undefined);if(boundary!=='post')assert.equal(r.checkout.detailOpen.value,false);
    }finally{old.resolve({data:post()});r.stop();}
  }
});
test('a no-id video visits only its first displayed item and loading later pages does not add exposures',async()=>{
  let visits=0;const r=setup(call=>({data:call.url.includes('/detail/')?(visits++,post(31,{contentType:2,playNum:9})):call.url.endsWith('/list')?Array.from({length:10},(_,i)=>post(31+i,{contentType:2})):[]}));let scope;
  try{scope=vue.effectScope();const feed=scope.run(()=>r.load(path.join(root,'src/composables/useCommunityDeepLink.ts')).useCommunityDeepLink('video',undefined,r.checkout));await feed.initialize({});assert.equal(visits,1);assert.equal(feed.activeVideo.value.playNum,9);await feed.loadMore();assert.equal(visits,1);assert.equal(count(r,'/state/'),0);
    feed.dispose();
  }finally{scope?.stop();r.stop();}
});
test('actual topic/search/video page roots redirect timeline post markers before loading their unrelated feed',async()=>{
  for(const page of ['discoverTopic/index','discoverSearch/index','discoverVideo/index','discoverVideo/app']){const r=runtime({component:`pages/discover/${page}.vue`,send:()=>({data:[]})});
    try{await r.start({post_id:'31',post_type:'2',spid:'11'});assert.equal(r.navigations[0],'/pages/discover/discoverVideo/index?id=31&spid=11');assert.equal(r.checkout.ready.value,false);assert.equal(r.calls.length,0);assert.deepEqual(r.hooks.onShareAppMessage({from:'menu'}),{});assert.deepEqual(r.hooks.onShareTimeline(),{});
    }finally{r.stop();}
  }
});
test('raw H5 duplicate identity is rejected before referral capture and the actual legacy bridge navigation',async()=>{
  const previous=global.window;const r=setup(()=>({data:{}}));global.window={location:{hostname:'shop.example.test',href:'https://shop.example.test/#/pages/discover/discoverDetails/index?id=31&id=32&spid=22',hash:'#/pages/discover/discoverDetails/index?id=31&id=32&spid=22'}};
  try{const referrals=r.load(path.join(root,'src/composables/useShareReferral.ts')).useShareReferral();referrals.captureInbound({path:'pages/discover/discoverDetails/index',query:{id:'32',spid:'22'}});await tick();assert.equal(r.calls.length,0);assert.match(referrals.notice.value,/重复/);
    const bridge=runtime({component:'pages/discover/discoverDetails/index.vue',send:()=>({data:{}})});try{await bridge.start({id:'32',spid:'22'});assert.deepEqual(bridge.navigations,[]);assert.equal(bridge.calls.length,0);}finally{bridge.stop();}
  }finally{r.stop();if(previous===undefined)delete global.window;else global.window=previous;}
});

test('anonymous sharing preserves copy and native materials without calling the authenticated share counter',async()=>{
 const r=setup(()=>({data:post()}));let copied,native;
 try{r.auth.clear();r.uni.setClipboardData=input=>{copied=input.data;input.success();};r.uni.getProvider=input=>input.success({provider:['weixin']});r.uni.share=input=>{native=input;input.success();};
  await r.checkout.openShare(post());await r.checkout.copyShare();assert.equal(copied,'https://shop.example.test/#/pages/discover/workspace?id=31');assert.match(r.checkout.notices.value[31],/未登录/);
  const materials=r.checkout.miniMessage({from:'button',target:{dataset:{postId:31}}});assert.equal(materials.path,'/pages/discover/workspace?id=31');await tick();await r.checkout.appShare('WXSceneSession');assert.equal(native.href,copied);assert.equal(count(r,'/share/'),0);assert.equal(r.navigations.length,0);
  assert.deepEqual(utilities(r).communityEmbeddedVideo('/pages/discover/discoverVideo/index?id=31&spid=0'),{id:'31',relation_id:undefined,content_type:undefined,spid:'0'});
 }finally{r.stop();}
});
test('community native share links and embedded routes work without browser URL globals',()=>{
 const r=setup(),oldURL=global.URL,oldQuery=global.URLSearchParams;
 try{const u=utilities(r);global.URL=undefined;global.URLSearchParams=undefined;
  assert.equal(u.communityShareUrl('/pages/discover/workspace?id=31&spid=11','https://shop.example.test'),'https://shop.example.test/#/pages/discover/workspace?id=31&spid=11');
  for(const origin of ['http://shop.example.test','https://a..test','https://user:pass@shop.test','https://shop.test:443','https://shop.test/path','https://SHOP.test'])assert.equal(u.communityShareUrl('/pages/discover/workspace?id=31',origin),'');
  assert.deepEqual(u.communityEmbeddedVideo('/pages/discover/discoverVideo/index?id=31&spid=0'),{id:'31',relation_id:undefined,content_type:undefined,spid:'0'});
 }finally{global.URL=oldURL;global.URLSearchParams=oldQuery;r.stop();}
});
