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
}
