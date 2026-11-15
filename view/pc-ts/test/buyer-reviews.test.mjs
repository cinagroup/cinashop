import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRenderer,h,nextTick,ref } from 'vue';
import { createRouter,createMemoryHistory,RouterView } from 'vue-router';
const fixture=createRequire(import.meta.url)('../../common/test/buyerReviewFixture.cjs');
const renderer=createRenderer({createElement:()=>({children:[]}),createText:text=>({text}),createComment:text=>({text}),insert(n,p){n.parent=p;(p.children??=[]).push(n);},remove(n){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);},parentNode:n=>n.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
const flush=async()=>{for(let i=0;i<35;i++){await Promise.resolve();await nextTick();}};
const gate=()=>{let resolve;return{promise:new Promise(r=>{resolve=r;}),resolve};};
export function registerBuyerReviewsTests(context){
  async function mount(override=()=>undefined,orderNo='review_order_A'){
    const {server,api,response}=context(),calls=[],done=[],confirmed=[],listeners=new Map(),prior=Object.getOwnPropertyDescriptor(globalThis,'document');
    const doc={visibilityState:'visible',addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
    api.defaults.adapter=async c=>{calls.push(c);const custom=await override(c);if(custom)return response(c,custom);
      if(c.url==='/upload/image')return response(c,{status:200,data:fixture.upload});
      if(c.method==='post'){const b=JSON.parse(c.data);done.push(b.cartInfoId);return response(c,{status:200,data:fixture.ack(b,done.length===2)});}
      return response(c,{status:200,data:fixture.page(done)});
    };
    const {useBuyerReviews}=await server.ssrLoadModule('/src/composables/useBuyerReviews.ts');let view;
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/order/:orderId',component:{setup(){view=useBuyerReviews(ref(orderNo),ack=>confirmed.push(ack));return()=>null;}}},{path:'/away',component:{render:()=>null}}]});
    const app=renderer.createApp({render:()=>h(RouterView)});app.use(router);await router.push('/order/'+orderNo);app.mount({children:[]});await flush();let closed=false;
    return {get view(){return view;},calls,confirmed,router,doc,listeners,close(){if(closed)return;closed=true;app.unmount();if(prior)Object.defineProperty(globalThis,'document',prior);else delete globalThis.document;}};
  }
  it('PC review opens read-only, keeps independent drafts and submits only selected non-gift line',async()=>{const f=await mount();try{
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/order/reviews/review_order_A');f.view.state.drafts[101].body.comment='第一件文字';f.view.state.drafts[102].body.comment='第二件不同文字';await f.view.submit();
    let writes=f.calls.filter(c=>c.method==='post');assert.equal(writes.length,1);assert.equal(JSON.parse(writes[0].data).cartInfoId,101);assert.equal(writes[0].url,'/reply/submit?view=buyer');assert.equal(f.view.state.drafts[102].body.comment,'第二件不同文字');
    f.view.select(103);await f.view.submit();assert.equal(f.calls.filter(c=>c.method==='post').length,1);f.view.select(102);await f.view.submit();assert.equal(f.view.state.page.status,3);assert.equal(f.confirmed[1].completed,true);
  }finally{f.close();}});
  it('PC image uses actual FormData transport and only stable references enter the review body',async()=>{const f=await mount();try{
    f.view.state.drafts[101].body.comment='带图评价';await f.view.upload([new File([new Uint8Array([137,80,78,71])],'local.png',{type:'image/png'})]);
    const upload=f.calls.find(c=>c.url==='/upload/image');assert.ok(upload.data instanceof FormData);assert.equal(upload.data.get('file').name,'local.png');assert.equal(f.view.state.drafts[101].images[0].url,'/api/assets/991');
    await f.view.submit();const b=JSON.parse(f.calls.find(c=>c.url.includes('reply/submit')).data);assert.deepEqual(b.pics,['/api/assets/991']);assert.doesNotMatch(JSON.stringify(b),/blob:|signature|preview/);
  }finally{f.close();}});
  it('PC lost acknowledgement blocks another POST until explicit SQL readback',async()=>{let saved=false;const f=await mount(c=>{if(c.method==='post'){saved=true;return{status:400,msg:'回执未确认'};}if(saved)return{status:200,data:fixture.page([101])};});try{
    f.view.state.drafts[101].body.comment='提交一次';await f.view.submit();await f.view.submit();assert.equal(f.view.state.uncertain,true);assert.equal(f.calls.filter(c=>c.method==='post').length,1);await f.view.load();assert.ok(f.view.state.page.lines[0].review);assert.equal(f.view.state.drafts[101],undefined);
  }finally{f.close();}});
  for(const ending of ['identity','route','unmount'])it('PC late private review read is discarded after '+ending,async()=>{const wait=gate(),f=await mount(()=>wait.promise);try{
    if(ending==='identity')context().authUtils.setAuth('new-owner',22);else if(ending==='route')await f.router.push('/away');else f.close();wait.resolve({status:200,data:fixture.page()});await flush();assert.equal(f.view.state.page,null);assert.deepEqual(Object.keys(f.view.state.drafts),[]);
  }finally{wait.resolve({status:400});f.close();}});
  it('PC hidden review drops drafts and returns with a read instead of posting',async()=>{const f=await mount();try{f.view.state.drafts[101].body.comment='私有草稿';f.doc.visibilityState='hidden';f.listeners.get('visibilitychange')();assert.equal(f.view.state.page,null);f.doc.visibilityState='visible';f.listeners.get('visibilitychange')();await flush();assert.equal(f.view.state.drafts[101].body.comment,'');assert.equal(f.calls.filter(c=>c.method==='post').length,0);}finally{f.close();}});
  it('PC malformed review response clears the former product and draft',async()=>{let bad=false;const f=await mount(()=>bad?{status:200,data:fixture.page([],{uid:22})}:undefined);try{bad=true;await f.view.load();assert.equal(f.view.state.page,null);assert.ok(f.view.state.error);}finally{f.close();}});
  const syncRevision='b'.repeat(64);
  const syncState=status=>({status,postId:['awaiting_review','published'].includes(status)?780:null,revision:status==='not_requested'?null:syncRevision});
  const syncPage=status=>{const page=fixture.page([101]);page.lines[0].review.communitySync=syncState(status);return page;};
  let communitySequence=0;
  function communityAuth(){const token='pc-community-case-'+(++communitySequence);context().authUtils.setAuth(token,11);return token;}
  it('PC community choice starts unchecked for every line and survives another line submission',async()=>{communityAuth();const f=await mount();try{
    assert.equal(f.view.state.drafts[101].body.syncToCommunity,false);assert.equal(f.view.state.drafts[102].body.syncToCommunity,false);
    f.view.state.drafts[101].body.comment='我选择同步';f.view.state.drafts[101].body.syncToCommunity=true;f.view.state.drafts[102].body.comment='其他商品草稿';
    await f.view.submit();assert.equal(JSON.parse(f.calls.find(c=>c.method==='post').data).syncToCommunity,true);assert.equal(f.view.state.drafts[102].body.syncToCommunity,false);
    await f.view.submit();assert.equal(JSON.parse(f.calls.filter(c=>c.method==='post')[1].data).syncToCommunity,false);
  }finally{f.close();}});
  it('PC review acknowledgement shows pending community status while the next product stays editable',async()=>{communityAuth();const done=[],f=await mount(c=>{if(c.method==='post'){const body=JSON.parse(c.data);done.push(body.cartInfoId);return{status:200,data:{...fixture.ack(body),communitySync:syncState('pending')}};}const page=fixture.page(done);if(done.length)page.lines[0].review.communitySync=syncState('pending');return{status:200,data:page};});try{f.view.state.drafts[101].body.comment='同步后显示状态';f.view.state.drafts[101].body.syncToCommunity=true;await f.view.submit();assert.equal(f.view.state.selected,102);assert.match(f.view.state.message,/评价已保存，社区同步暂未完成/);assert.equal(f.view.canEdit.value,true);assert.equal(f.calls.filter(c=>c.method==='post').length,1);}finally{f.close();}});
  it('PC pending community retry sends its own full identity tuple once and preserves another product draft',async()=>{communityAuth();let status='pending';const wait=gate(),f=await mount(async c=>{if(c.method==='post'){const body=JSON.parse(c.data);await wait.promise;status='awaiting_review';return{status:200,data:{...body,uid:11,communitySync:syncState(status)}};}return{status:200,data:syncPage(status)};});try{
    f.view.state.drafts[102].body.comment='另一件商品未提交';f.view.state.drafts[102].body.syncToCommunity=true;f.view.select(101);const operation=f.view.retryCommunity();await flush();await f.view.retryCommunity();assert.equal(f.view.state.syncing,true);assert.equal(f.view.canRetrySync.value,false);
    const writes=f.calls.filter(c=>c.method==='post');assert.equal(writes.length,1);assert.equal(writes[0].url,'/order/reviews/review_order_A/community-sync');assert.deepEqual(JSON.parse(writes[0].data),{version:1,orderId:91,orderNo:'review_order_A',cartInfoId:101,unique:'line_101',replyId:601,syncRevision});
    wait.resolve();await operation;assert.equal(f.view.state.page.lines[0].review.communitySync.status,'awaiting_review');assert.equal(f.view.state.drafts[102].body.comment,'另一件商品未提交');assert.equal(f.view.state.drafts[102].body.syncToCommunity,true);assert.equal(f.confirmed.length,0);assert.match(f.view.state.message,/等待审核/);
    await f.view.submit();assert.equal(f.calls.filter(c=>c.method==='post').length,1);
  }finally{wait.resolve();f.close();}});
  it('PC lost community acknowledgement blocks retries until explicit readback and never resubmits the review',async()=>{communityAuth();let status='pending';const f=await mount(c=>{if(c.method==='post'){status='published';return{status:400,msg:'回执丢失'};}return{status:200,data:syncPage(status)};});try{
    f.view.select(101);await f.view.retryCommunity();await f.view.retryCommunity();await f.view.submit();assert.equal(f.calls.filter(c=>c.method==='post').length,1);assert.equal(f.view.state.uncertain,true);assert.match(f.view.state.message,/社区同步结果未确认/);
    await f.view.load();assert.equal(f.view.state.page.lines[0].review.communitySync.status,'published');assert.equal(f.view.state.uncertain,false);assert.equal(f.view.canRetrySync.value,false);
  }finally{f.close();}});
  for(const [field,value] of Object.entries({version:2,uid:22,orderId:92,orderNo:'other_order',cartInfoId:102,unique:'foreign_line',replyId:602,syncRevision:'c'.repeat(64)}))it('PC mismatched community '+field+' acknowledgement requires manual readback',async()=>{communityAuth();const f=await mount(c=>c.method==='post'?{status:200,data:{...JSON.parse(c.data),uid:11,communitySync:syncState('published'),[field]:value}}:{status:200,data:syncPage('pending')});try{
    f.view.select(101);await f.view.retryCommunity();assert.equal(f.view.state.uncertain,true);assert.equal(f.view.state.page.lines[0].review.communitySync.status,'pending');await f.view.retryCommunity();assert.equal(f.calls.filter(c=>c.method==='post').length,1);await f.view.load();
  }finally{f.close();}});
  for(const ending of ['identity','route','hidden','unmount'])it('PC late community retry cannot repopulate private state after '+ending,async()=>{communityAuth();const wait=gate(),f=await mount(async c=>c.method==='post'?(await wait.promise,{status:200,data:{...JSON.parse(c.data),uid:11,communitySync:syncState('published')}}):{status:200,data:syncPage('pending')});try{
    f.view.select(101);const operation=f.view.retryCommunity();await flush();if(ending==='identity')context().authUtils.setAuth('new-community-owner',22);else if(ending==='route')await f.router.push('/away');else if(ending==='hidden'){f.doc.visibilityState='hidden';f.listeners.get('visibilitychange')();}else f.close();
    wait.resolve();await operation;await flush();assert.equal(f.view.state.page,null);assert.deepEqual(Object.keys(f.view.state.drafts),[]);assert.equal(f.confirmed.length,0);assert.equal(f.calls.filter(c=>c.method==='post').length,1);
  }finally{wait.resolve();f.close();}});
  it('PC stale same-token community callback does not unlock a renewed session before a new read',async()=>{const token=communityAuth();let status='pending';const wait=gate(),f=await mount(async c=>{if(c.method==='post'){await wait.promise;status='published';return{status:200,data:{...JSON.parse(c.data),uid:11,communitySync:syncState(status)}};}return{status:200,data:syncPage(status)};});try{
    f.view.select(101);const operation=f.view.retryCommunity();await flush();context().authUtils.setAuth(token,11);await f.view.load();assert.equal(f.view.state.uncertain,true);wait.resolve();await operation;assert.equal(f.view.state.uncertain,true);assert.equal(f.view.state.page.lines[0].review.communitySync.status,'pending');assert.equal(f.view.canRetrySync.value,false);await f.view.retryCommunity();assert.equal(f.calls.filter(c=>c.method==='post').length,1);await f.view.load();assert.equal(f.view.state.page.lines[0].review.communitySync.status,'published');
  }finally{wait.resolve();f.close();}});
  for(const status of ['not_requested','awaiting_review','published','unavailable'])it('PC '+status+' community record has no retry mutation',async()=>{communityAuth();const f=await mount(()=>({status:200,data:syncPage(status)}));try{f.view.select(101);assert.equal(f.view.canRetrySync.value,false);await f.view.retryCommunity();assert.equal(f.calls.filter(c=>c.method==='post').length,0);}finally{f.close();}});
}
