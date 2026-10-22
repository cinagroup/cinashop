const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const root = path.resolve(__dirname, '..');
// The Page independently refreshes its public global footer; community validation
// must still prevent every other request, including private cart/account I/O.
function assertOnlyPublicFooterReads(calls) {
  for (const call of calls) {
    assert.ok(call.url === '/api/diy/diy_version/0' || call.url === '/api/navigation', `unexpected business I/O: ${call.url}`);
    assert.deepEqual(call.data, {});
  }
}
const post = (id=1, extra={}) => ({id,type:2,relationId:22,contentType:id%2?1:2,title:`内容${id}`,content:`正文${id}`,image:'',sliderImage:null,
  likeNum:3,isLike:0,commentNum:2,playNum:5,shareNum:4,status:1,is_verify:1,addTime:100,site_url:'https://shop.example.test',...extra});
const page = (start=1, length=10) => Array.from({length},(_,i)=>post(start+i));
const topic = {id:9,name:'话题九',isRecommend:1};
const person = (id=22,extra={}) => ({id,type:id===0?0:2,relation_id:id,author:`作者${id}`,author_image:'',desc:'介绍',is_follow:0,is_fans:0,
  community_num:3,fans_num:2,follow_num:0,friend_num:0,like_num:3,is_self:0,
  community:[{id:31,type:id===0?0:2,relation_id:id,content_type:1,title:'推荐图文',image:''}],...extra});
const matches = (r,re) => r.calls.filter(call=>re.test(call.url));
function answer(call) {
  if(call.url.endsWith('/config'))return {data:{community_status:1,community_comment_status:1,community_comment_add:1}};
  if(call.url.endsWith('/topic'))return {data:[topic]};
  if(call.url.endsWith('/recommend_list'))return {data:[person()]};
  if(call.url.endsWith('/follow'))return {data:[{relation_id:0,author:'平台',author_image:'',is_new:1}]};
  if(call.url.includes('/user_info/'))return {data:person(Number(call.url.split('/').at(-1)),{is_follow:1})};
  if(call.url.includes('/set_interest/'))return {data:{status:1,is_follow:1,is_fans:0}};
  if(/\/(detail|state)\//.test(call.url))return {data:post(Number(call.url.split('/').at(-1)))};
  if(call.url.endsWith('/comment/list'))return {data:{list:[],count:0,post_comment_num:2}};
  if(call.url.endsWith('/list'))return {data:page((call.data.page-1)*10+1,call.data.page===3?1:10)};
  return {data:[]};
}
const home = send => runtime({feature:'useCommunityHomeFeed',send:send??answer});
const main = (send=answer,authenticated=true) => runtime({component:'pages/discover/index.vue',authenticated,send});
const availability = r => r.load(path.join(root,'src/utils/communityAvailability.ts')).communityAvailability();
function featured(r) {
  const scope=vue.effectScope();const items=vue.ref(page());const e=r.checkout;
  const viewer=scope.run(()=>r.load(path.join(root,'src/composables/useCommunityFeatured.ts')).useCommunityFeatured(items,()=>true,e,async()=>{}));
  return {viewer,items,scope};
}

test('main feed defaults to discover, sends page ten with explicit public scope and no protected social helpers',{timeout:30_000},async()=>{
  const r=home();try{await r.checkout.load();assert.equal(r.checkout.tab.value,'discover');assert.deepEqual(matches(r,/\/community\/list$/).map(c=>c.data),[{page:1,limit:10,is_follow:0}]);assert.equal(r.checkout.posts.value.length,10);assert.deepEqual(r.checkout.topics.value,[topic]);assert.equal(matches(r,/follow|recommend/).length,0);}finally{r.stop();}
});
test('main feed appends ten ten one and stops without probing a fourth page',{timeout:30_000},async()=>{
  const r=home();try{await r.checkout.load();await r.checkout.loadMore();await r.checkout.loadMore();await r.checkout.loadMore();assert.equal(r.checkout.posts.value.length,21);assert.equal(r.checkout.page.value,3);assert.equal(r.checkout.finished.value,true);assert.deepEqual(matches(r,/\/list$/).map(c=>c.data.page),[1,2,3]);}finally{r.stop();}
});
test('a full final page needs an empty next page; duplicate rows do not change raw-length termination',{timeout:30_000},async()=>{
  const r=home(call=>call.url.endsWith('/list')?{data:call.data.page<3?page():[]}:answer(call));
  try{await r.checkout.load();await r.checkout.loadMore();assert.equal(r.checkout.posts.value.length,10);assert.equal(r.checkout.page.value,2);assert.equal(r.checkout.finished.value,false);await r.checkout.loadMore();assert.equal(r.checkout.finished.value,true);assert.equal(r.checkout.page.value,3);}finally{r.stop();}
});
test('failed page two retries exactly page two while preserving committed page one',{timeout:30_000},async()=>{
  let failed=false;const r=home(call=>call.url.endsWith('/list')&&call.data.page===2&&!failed?(failed=true,{httpStatus:503,status:503,msg:'第二页失败'}):answer(call));
  try{await r.checkout.load();await r.checkout.loadMore();assert.equal(r.checkout.page.value,1);assert.equal(r.checkout.posts.value.length,10);assert.match(r.checkout.error.value,/第二页失败/);await r.checkout.loadMore();assert.equal(r.checkout.page.value,2);assert.deepEqual(matches(r,/\/list$/).map(c=>c.data.page),[1,2,2]);}finally{r.stop();}
});
test('pending pagination cannot dispatch a duplicate, and an invalid tail commits none of its page',{timeout:30_000},async()=>{
  const pending=deferred();let hold=false;const r=home(call=>hold&&call.url.endsWith('/list')?pending.promise:answer(call));
  try{await r.checkout.load();hold=true;const first=r.checkout.loadMore();await tick();await r.checkout.loadMore();assert.equal(matches(r,/\/list$/).length,2);pending.resolve({data:[post(11),post(12,{likeNum:-1})]});await first;assert.equal(r.checkout.page.value,1);assert.deepEqual(r.checkout.posts.value.map(p=>p.id),page().map(p=>p.id));assert.match(r.checkout.error.value,/格式/);}finally{pending.resolve({data:[]});r.stop();}
});
test('the explicit 1001-page client boundary accepts its full last page and never requests 1002',{timeout:30_000},async()=>{
  const r=home(call=>call.url.endsWith('/list')?{data:page((call.data.page-1)*10+1)}:answer(call));
  try{await r.checkout.load();for(let i=1;i<1001;i++)await r.checkout.loadMore();await r.checkout.loadMore();assert.equal(r.checkout.page.value,1001);assert.equal(r.checkout.posts.value.length,10010);assert.equal(r.checkout.finished.value,true);assert.equal(r.checkout.capped.value,true);assert.equal(matches(r,/\/list$/).at(-1).data.page,1001);assert.equal(matches(r,/\/list$/).length,1001);}finally{r.stop();}
});
test('inline topics filter the same list and refresh clears selected topic plus page without navigation',{timeout:30_000},async()=>{
  const r=home();try{await r.checkout.load();await r.checkout.selectTopic(9);assert.equal(r.checkout.selectedTopicId.value,9);assert.deepEqual(matches(r,/\/list$/).at(-1).data,{page:1,limit:10,is_follow:0,topic_id:9});await r.checkout.loadMore();await r.checkout.refresh();assert.equal(r.checkout.selectedTopicId.value,null);assert.equal(r.checkout.page.value,1);assert.deepEqual(matches(r,/\/list$/).at(-1).data,{page:1,limit:10,is_follow:0});assert.deepEqual(r.navigations,[]);}finally{r.stop();}
});
test('unknown topic selections are inert and a newer topic wins both old success and finally',{timeout:30_000},async()=>{
  const pending=deferred();let hold=false;const r=home(call=>hold&&call.url.endsWith('/list')&&!call.data.topic_id?pending.promise:answer(call));
  try{await r.checkout.load();await r.checkout.selectTopic(999);assert.equal(matches(r,/\/list$/).length,1);hold=true;const old=r.checkout.load();await tick();await r.checkout.loadTopics();await r.checkout.selectTopic(9);pending.resolve({data:[post(999)]});await old;assert.equal(r.checkout.posts.value[0].id,1);assert.equal(r.checkout.selectedTopicId.value,9);assert.equal(r.checkout.loading.value,false);assert.equal(r.checkout.page.value,1);}finally{pending.resolve({data:[]});r.stop();}
});
test('guest following shows no protected list or social request, while discovery remains public',{timeout:30_000},async()=>{
  const r=runtime({feature:'useCommunityHomeFeed',authenticated:false,send:answer});try{await r.checkout.changeTab('following');assert.equal(matches(r,/\/list$|follow|recommend/).length,0);assert.equal(r.checkout.finished.value,true);await r.checkout.changeTab('discover');assert.equal(matches(r,/\/list$/).length,1);assert.deepEqual(r.navigations,[]);}finally{r.stop();}
});
test('following requests its exact scope plus real platform highlights and bounded typed recommendation previews',{timeout:30_000},async()=>{
  const r=home();try{await r.checkout.changeTab('following');assert.deepEqual(matches(r,/\/list$/)[0].data,{page:1,limit:10,is_follow:1});assert.equal(r.checkout.highlights.value[0].relation_id,0);assert.deepEqual(r.checkout.recommendations.value[0].community,person().community);assert.equal(matches(r,/recommend_list$/)[0].data.limit,20);assert.equal(r.checkout.followingError.value,'');}finally{r.stop();}
});
test('an invalid recommendation target or oversize preview list never partially renders author data',{timeout:30_000},async()=>{
  for(const bad of [person(22,{community:[{...person().community[0],relation_id:0}]}),person(22,{community:Array(4).fill(person().community[0])}),person(22,{type:1})]){
    const r=home(call=>call.url.endsWith('/recommend_list')?{data:[person(0),bad]}:answer(call));try{await r.checkout.changeTab('following');assert.deepEqual(r.checkout.recommendations.value,[]);assert.match(r.checkout.followingError.value,/格式/);assert.equal(r.checkout.highlights.value.length,1);}finally{r.stop();}
  }
});
test('successful explicit follow refreshes following membership with desired state one only',{timeout:30_000},async()=>{
  const r=home();try{await r.checkout.changeTab('following');await r.checkout.follow(r.checkout.recommendations.value[0]);assert.deepEqual(matches(r,/set_interest/).map(c=>c.data),[{status:1}]);assert.deepEqual(matches(r,/\/list$/).map(c=>c.data.page),[1,1]);assert.equal(r.checkout.followUnknown.value,false);assert.match(r.checkout.followMessage.value,/已关注/);}finally{r.stop();}
});
test('a follow refresh cannot paint its success message into a later tab generation',{timeout:30_000},async()=>{
  const pending=deferred();let lists=0;const r=home(call=>call.url.endsWith('/list')&&++lists===2?pending.promise:answer(call));
  try{await r.checkout.changeTab('following');assert.equal(r.checkout.recommendations.value.length,1);const work=r.checkout.follow(r.checkout.recommendations.value[0]);await tick();assert.equal(matches(r,/set_interest/).length,1);assert.equal(lists,2);await r.checkout.changeTab('discover');pending.resolve({data:[post(99)]});await work;assert.equal(r.checkout.tab.value,'discover');assert.equal(r.checkout.followMessage.value,'');assert.equal(r.checkout.posts.value[0].id,1);}finally{pending.resolve({data:[]});r.stop();}
});
test('lost follow receipt survives tabs and same-owner composable replacement until explicit exact profile read',{timeout:30_000},async()=>{
  const r=home(call=>call.url.includes('/set_interest/')?{httpStatus:503,status:503}:answer(call));let scope;
  try{await r.checkout.changeTab('following');await r.checkout.follow(r.checkout.recommendations.value[0]);assert.equal(r.checkout.followUnknown.value,true);await r.checkout.changeTab('discover');await r.checkout.changeTab('following');await r.checkout.follow(r.checkout.recommendations.value[0]);assert.equal(matches(r,/set_interest/).length,1);
    r.checkout.dispose();scope=vue.effectScope();const other=scope.run(()=>r.load(path.join(root,'src/composables/useCommunityHomeFeed.ts')).useCommunityHomeFeed());assert.equal(other.followUnknown.value,true);assert.equal(matches(r,/user_info/).length,0);await other.reconcileFollow();assert.equal(other.followUnknown.value,false);assert.equal(matches(r,/user_info\/22$/).length,1);assert.equal(matches(r,/set_interest/).length,1);
  }finally{scope?.stop();r.stop();}
});
test('a real closure is certain but a 503 carrying closure code leaves the follow fenced',{timeout:30_000},async()=>{
  for(const httpStatus of [200,503]){const r=home(call=>call.url.includes('/set_interest/')?{httpStatus,status:410010,msg:'社区暂未开放'}:answer(call));
    try{await r.checkout.changeTab('following');await r.checkout.follow(r.checkout.recommendations.value[0]);assert.equal(r.checkout.followUnknown.value,httpStatus===503);assert.equal(availability(r).closed.value,httpStatus===200);assert.equal(r.auth.isLoggedIn,true);}finally{r.stop();}}
});
for(const boundary of ['hide','unload','owner'])test(`main late list after ${boundary} cannot restore prior personal rows or loading`,{timeout:30_000},async()=>{
  const pending=deferred();let wait=false;const r=home(call=>wait&&call.url.endsWith('/list')?(r.auth.uid===11?pending.promise:{data:[]}):answer(call));
  try{await r.checkout.load();wait=true;const old=r.checkout.refresh();await tick();if(boundary==='owner')r.auth.setLogin('other',33);else r.hooks[boundary==='hide'?'onHide':'onUnload']();pending.resolve({data:[post(999)]});await old;await tick();assert.deepEqual(r.checkout.posts.value,[]);if(boundary!=='owner')assert.equal(r.checkout.loading.value,false);}finally{pending.resolve({data:[]});r.stop();}
});
test('mixed featured activates one deliberate visit and last-item append never reactivates it',{timeout:30_000},async()=>{
  const r=main();try{await r.start({});await r.checkout.changeFeedTab('featured');assert.equal(matches(r,/\/detail\//).length,1);assert.equal(r.checkout.featured.active.value.contentType,1);await r.checkout.featured.activate(9);assert.equal(matches(r,/\/detail\//).length,2);assert.equal(r.checkout.posts.value.length,20);assert.equal(r.checkout.featured.active.value.contentType,2);assert.equal(r.checkout.featured.requestedId.value,10);await r.checkout.home.loadMore();assert.equal(matches(r,/\/detail\//).length,2);}finally{r.stop();}
});
test('featured next at an unappended boundary fulfills that exact user intent once after the read succeeds',{timeout:30_000},async()=>{
  const r=runtime({feature:'useCommunityEngagement',send:answer});const items=vue.ref([post(1)]);let pages=0;const scope=vue.effectScope();
  const viewer=scope.run(()=>r.load(path.join(root,'src/composables/useCommunityFeatured.ts')).useCommunityFeatured(items,()=>true,r.checkout,async()=>{if(++pages===2)items.value.push(post(2));}));
  try{await viewer.activate(0);assert.equal(items.value.length,1);await viewer.step(1);assert.equal(viewer.requestedId.value,2);assert.equal(matches(r,/\/detail\//).length,2);assert.equal(pages,3);}finally{scope.stop();r.stop();}
});
test('a stale next-page read cannot activate a row after owner or selection changes',{timeout:30_000},async()=>{
  const pending=deferred();const r=runtime({feature:'useCommunityEngagement',send:answer}),items=vue.ref([post(1)]);let pages=0;const scope=vue.effectScope();
  const viewer=scope.run(()=>r.load(path.join(root,'src/composables/useCommunityFeatured.ts')).useCommunityFeatured(items,()=>true,r.checkout,async()=>{if(++pages>1){await pending.promise;items.value.push(post(2));}}));
  try{await viewer.activate(0);const next=viewer.step(1);await tick();viewer.invalidate(true);pending.resolve();await next;assert.equal(viewer.requestedId.value,0);assert.equal(matches(r,/\/detail\//).length,1);}finally{pending.resolve();scope.stop();r.stop();}
});
test('featured recovery of the twenty-first selection shows independent state and does not invent page membership or visit',{timeout:30_000},async()=>{
  const r=main();try{await r.start({feed:'featured'});await r.checkout.featured.activate(9);await r.checkout.featured.activate(19);await r.checkout.featured.activate(20);assert.equal(r.checkout.featured.active.value.id,21);const visits=matches(r,/\/detail\//).length;
    availability(r).close();assert.equal(r.checkout.featured.active.value,null);await r.checkout.recoverCommunity();assert.equal(r.checkout.home.page.value,1);assert.equal(r.checkout.posts.value.length,10);assert.equal(r.checkout.featured.active.value.id,21);assert.equal(r.checkout.featured.detached.value,true);assert.deepEqual(r.checkout.featured.items.value.map(p=>p.id),[21]);assert.equal(matches(r,/\/detail\//).length,visits);assert.equal(matches(r,/\/state\/21$/).length,1);await r.checkout.featured.step(1);assert.equal(r.checkout.featured.active.value.id,1);assert.equal(matches(r,/\/detail\//).length,visits+1);
  }finally{r.stop();}
});
test('hidden featured restores with state and no automatic visit, including a lost first visit',{timeout:30_000},async()=>{
  let failed=true;const r=main(call=>call.url.includes('/detail/')&&failed?(failed=false,{httpStatus:503,status:503}):answer(call));
  try{await r.start({feed:'featured'});assert.equal(matches(r,/\/detail\//).length,1);assert.match(r.checkout.featured.error.value,/未确认/);await r.checkout.featured.activate(0);assert.equal(matches(r,/\/detail\//).length,1);r.hooks.onHide();r.hooks.onShow();await tick();assert.equal(r.checkout.featured.active.value.id,1);assert.equal(matches(r,/\/detail\//).length,1);assert.equal(matches(r,/\/state\/1$/).length,1);}finally{r.stop();}
});
test('swiper touch activates while programmatic current and appended items emit no visit',{timeout:30_000},async()=>{
  const calls=[];const viewer={detached:vue.ref(false),activate:index=>calls.push(index)};
  const r=runtime({component:'components/community/CommunityFeaturedViewer.vue',props:{posts:page(),canMore:true,viewer,engagement:{}},send:answer});
  try{r.checkout.swipe({detail:{current:1,source:''}});r.checkout.swipe({detail:{current:2}});assert.deepEqual(calls,[]);r.checkout.swipe({detail:{current:3,source:'touch'}});assert.deepEqual(calls,[3]);viewer.detached.value=true;r.checkout.swipe({detail:{current:0,source:'touch'}});assert.deepEqual(calls,[3]);}finally{r.stop();}
});
test('recommended image preview fetches complete detail and video preview navigates the real canonical video entry',{timeout:30_000},async()=>{
  const r=main();try{await r.start({});await r.checkout.changeFeedTab('following');r.checkout.openRecommendation(person().community[0]);await tick();assert.equal(r.checkout.detail.value.id,31);assert.equal(r.checkout.detail.value.content,'正文31');r.checkout.closeDetail();r.checkout.openRecommendation({...person().community[0],id:32,content_type:2});assert.equal(r.navigations.at(-1),'/pages/discover/discoverVideo/index?id=32');assert.equal(matches(r,/\/detail\//).length,1);}finally{r.stop();}
});
test('page reach-bottom and pull refresh call real paging and reset inline filter without leaving tab',{timeout:30_000},async()=>{
  const r=main();let stops=0;r.uni.stopPullDownRefresh=()=>stops++;
  try{await r.start({});await r.checkout.home.selectTopic(9);r.hooks.onReachBottom();await tick();assert.equal(r.checkout.home.page.value,2);r.hooks.onPullDownRefresh();await tick();assert.equal(stops,1);assert.equal(r.checkout.home.page.value,1);assert.equal(r.checkout.home.selectedTopicId.value,null);assert.equal(r.checkout.home.tab.value,'discover');}finally{r.stop();}
});
test('App featured uses only a local canonical page with no remote URL, token or preliminary visit',{timeout:30_000},async()=>{
  const prior=global.plus;global.plus={};const r=main();try{await r.start({});const before=r.calls.length;await r.checkout.changeFeedTab('featured');assert.equal(r.navigations.at(-1),'/pages/discover/workspace?feed=featured');assert.equal(r.calls.length,before);assert.equal(r.checkout.home.tab.value,'discover');}finally{if(prior===undefined)delete global.plus;else global.plus=prior;r.stop();}
});
test('canonical featured validates before community business I/O and conflicts never load config or consume referrals',{timeout:30_000},async()=>{
  for(const query of [{feed:'other'},{feed:'featured',id:'31'},{feed:'featured',author_id:'0'},{feed:'featured',publish:'1'},{feed:['featured']},{feed:'featured',topic_id:'9'}]){
    const r=main();try{await r.start(query);assertOnlyPublicFooterReads(r.calls);assert.match(r.checkout.routeError.value,/无效|冲突/);}finally{r.stop();}
  }
});
test('registered old main drops credentials and switches the actual tab without business requests',{timeout:30_000},async()=>{
  const r=runtime({component:'pages/discoverIndex/index.vue',send:()=>{throw Error('legacy bridge must stay pure');}});
  try{await r.start({token:'discarded',uid:'22',spid:'22'});assert.deepEqual(r.navigations,['/pages/discover/index']);assert.deepEqual(r.calls,[]);r.hooks.onUnload();r.checkout.open();assert.equal(r.navigations.length,1);}finally{r.stop();}
});
test('old main rejects duplicated or invented tab protocols before local navigation and any HTTP',{timeout:30_000},async()=>{
  for(const input of [{tab:'2'},{token:['one','two']},{feed:'featured'}]){const r=runtime({component:'pages/discoverIndex/index.vue',send:answer});try{await r.start(input);assert.deepEqual(r.calls,[]);assert.deepEqual(r.navigations,[]);assert.match(r.checkout.error.value,/无效|重复/);}finally{r.stop();}}
});
test('unknown engagement remains locked across three tabs; exact state clears it without a detail visit',{timeout:30_000},async()=>{
  const r=main(call=>call.url.includes('/like/')?{httpStatus:503,status:503}:answer(call));try{await r.start({});await r.checkout.engagement.toggleLike(r.checkout.posts.value[0]);assert.equal(r.checkout.engagement.unknown(1),true);await r.checkout.changeFeedTab('following');await r.checkout.changeFeedTab('discover');await r.checkout.engagement.toggleLike(r.checkout.posts.value[0]);assert.equal(matches(r,/\/like\//).length,1);await r.checkout.engagement.reconcile(1);assert.equal(r.checkout.engagement.unknown(1),false);assert.equal(matches(r,/\/detail\//).length,0);assert.equal(matches(r,/\/state\/1$/).length,1);}finally{r.stop();}
});
