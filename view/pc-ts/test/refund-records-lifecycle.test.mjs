import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const script = mode => `/src/pages/order/Refund${mode === 'list' ? 'List' : 'Detail'}.records-test.ts`;
export function refundRecordsPlugin(root) {
  const prefix = root.replaceAll('\\', '/').replace(/\/$/, '');
  return { name: 'actual-refund-records', resolveId(value) { if ([script('list'), script('detail')].includes(value)) return prefix + value; },
    async load(value) { const mode = ['list', 'detail'].find(mode => value === prefix + script(mode)); if (!mode) return;
      const filename = root + script(mode).replace('.records-test.ts', '.vue');
      return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'refund-records' }).content
        .replace(/from (["'])element-plus\1/g, 'from "/@test/order-detail-dialog"');
    } };
}
const renderer = createRenderer({createElement:()=>({children:[]}),createText:text=>({text}),createComment:text=>({text}),
  insert(n,p){n.parent=p;(p.children??=[]).push(n);},remove(n){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);},
  parentNode:n=>n.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
const flush = async () => { for(let i=0;i<30;i++){await Promise.resolve();await nextTick();} };
const gate = () => { let resolve; return {promise:new Promise(r=>resolve=r),resolve}; };
const record=(id=25,changes={})=>({id,uid:11,refundNo:`refund_${id}`,orderId:`order_${id}`,storeOrderId:id,applyType:2,refundType:0,isCancel:0,
  refundNum:1,refundPrice:'5.00',refundedPrice:'0.00',refundReason:'本地退款原因',addTime:1700000000,refundedTime:0,...changes});
const detail=(id=25,changes={})=>({version:1,...record(id),refundExplain:'',refuseReason:'',refundExpress:'',refundExpressName:'',refundPhone:'',refundGoodsExplain:'',
  itemsError:'',returnContact:null,items:[{id,cartId:2000+id,name:'本地退款商品',sku:'红色',image:'',quantity:1}],...changes});
const page=(query,items=[],nextCursor=null)=>({version:1,filter:query.filter,q:query.q,limit:query.limit,items,nextCursor});
export function registerRefundRecordsTests(getContext) {
  async function mount(mode='detail',override=()=>undefined,path=mode==='detail'?'/user/refunds/25':'/user/refunds') {
    const {server,api,response}=getContext(),calls=[];let view;
    const dialog=(await server.ssrLoadModule('/@test/order-detail-dialog')).state;dialog.confirm=async()=>{};
    api.defaults.adapter=async c=>{calls.push(c);return response(c,await override(c)??{status:200,data:mode==='detail'?detail(Number(c.url.split('/').at(-1))):page(c.params)});};
    const component=(await server.ssrLoadModule(script(mode))).default;
    const router=createRouter({history:createMemoryHistory(),routes:[{path:mode==='detail'?'/user/refunds/:id':'/user/refunds',component:{setup(p,c){view=component.setup(p,c);return()=>null;}}},
      {path:'/away',component:{render:()=>null}},{path:'/order/:orderId',component:{render:()=>null}}]});
    const app=renderer.createApp({render:()=>h(RouterView)});app.use(router);await router.push(path);app.mount({children:[]});await flush();let closed=false;
    return{get view(){return view;},calls,dialog,router,posts:()=>calls.filter(c=>c.method==='post'),close(){if(!closed){closed=true;app.unmount();}}};
  }
  it('PC refund history fails explicitly and retries its exact cursor',async()=>{
    let fail=true;const rows=Array.from({length:20},(_,i)=>record(45-i));
    const f=await mount('list',c=>c.params.cursor?(fail?{status:500,msg:'append offline'}:{status:200,data:page(c.params,[record(25)])}):{status:200,data:page(c.params,rows,'c25')});
    try{assert.equal(f.view.list.value.length,20);await f.view.load(true);assert.equal(f.view.state.cursor,'c25');assert.match(f.view.state.error,/offline/);
      await f.view.goDetail(f.view.list.value[0]);assert.equal(f.router.currentRoute.value.path,'/user/refunds');fail=false;await f.view.load(true);
      assert.equal(f.view.list.value.length,21);assert.deepEqual(f.calls.map(c=>c.params.cursor),[undefined,'c25','c25']);
    }finally{f.close();}
  });
  it('PC refund history repeats identical search as read-only refresh',async()=>{
    const f=await mount('list');try{await f.view.applySearch();assert.equal(f.calls.length,2);assert.equal(f.view.navigationError.value,'');}finally{f.close();}
  });
  it('PC refund history ignores an old filter response after changing filter',async()=>{
    const wait=gate(),f=await mount('list',c=>c.params.filter==='all'?wait.promise:{status:200,data:page(c.params,[record(25,{refundType:6})])});
    try{await f.view.setFilter('completed');await flush();wait.resolve({status:200,data:page({filter:'all',q:'',limit:20},[record(30)])});await flush();
      assert.equal(f.view.state.filter,'completed');assert.deepEqual(f.view.list.value.map(r=>r.id),[25]);
    }finally{wait.resolve({status:400});f.close();}
  });
  for(const change of [{uid:22},{id:26},{refundPrice:'NaN'},{items:[]}]) {
    it(`PC refund detail rejects invalid payload ${JSON.stringify(change)}`,async()=>{
      const f=await mount('detail',()=>({status:200,data:detail(25,change)}));try{assert.equal(f.view.detail.value,null);assert.ok(f.view.state.error);}finally{f.close();}
    });
  }
  for(const ending of ['auth','route','unmount']) {
    it(`PC refund detail late read cannot survive ${ending}`,async()=>{
      const wait=gate(),f=await mount('detail',()=>wait.promise),view=f.view;
      try{if(ending==='auth')getContext().authUtils.setAuth('new',22);else if(ending==='route')await f.router.push('/away');else f.close();
        wait.resolve({status:200,data:detail()});await flush();assert.equal(view.detail.value,null);
      }finally{wait.resolve({status:400});f.close();}
    });
  }
  it('PC refund cancellation captures the original identity before confirmation',async()=>{
    const f=await mount(),wait=gate();f.dialog.confirm=()=>wait.promise;
    try{const first=f.view.cancel();await f.view.cancel();getContext().authUtils.setAuth('new',22);wait.resolve();await first;assert.equal(f.posts().length,0);assert.equal(f.view.detail.value,null);}finally{f.close();}
  });
  it('PC refund cancellation success rereads isCancel and cannot repeat',async()=>{
    let cancelled=false;const f=await mount('detail',c=>{if(c.method==='post'){cancelled=true;return{status:200,data:null};}return{status:200,data:detail(25,{isCancel:cancelled?1:0})};});
    try{await f.view.cancel();assert.equal(f.view.detail.value.isCancel,1);await f.view.cancel();assert.equal(f.posts().length,1);assert.equal(f.view.canCancel.value,false);}finally{f.close();}
  });
  for(const reply of [{status:500,msg:'offline'},{status:200,data:{ok:true}}]) {
    it(`PC refund cancellation unknown cannot be unlocked by an unchanged read ${JSON.stringify(reply)}`,async()=>{
      const f=await mount('detail',c=>c.method==='post'?reply:undefined);try{await f.view.cancel();assert.equal(f.view.state.cancelOutcome,'unknown');
        await f.view.load();await f.view.cancel();assert.equal(f.posts().length,1);assert.equal(f.view.canCancel.value,false);
      }finally{f.close();}
    });
  }
  it('PC refund cancellation explicit decline can be confirmed again',async()=>{
    const f=await mount('detail',c=>c.method==='post'?{status:400,msg:'明确拒绝'}:undefined);
    try{await f.view.cancel();await f.view.cancel();assert.equal(f.posts().length,2);assert.equal(f.view.canCancel.value,true);}finally{f.close();}
  });
  it('PC refund cancellation cancelled modal never posts',async()=>{
    const f=await mount();f.dialog.confirm=async()=>{throw 'cancel';};try{await f.view.cancel();assert.equal(f.posts().length,0);assert.equal(f.view.canCancel.value,true);}finally{f.close();}
  });
  const returning = changes => detail(25,{refundType:4,returnImages:[],returnImagesError:'',...changes});
  const carriers = [{id:1,name:'本地快递甲',code:'local-a'}];
  const fillReturn = f => Object.assign(f.view.state.shipment.form,{carrierId:1,tracking:' LOCAL-25 ',phone:'000000',explain:'备注',acknowledged:true});
  async function mountReturn(override=()=>undefined) {
    return mount('detail',c=>override(c)??{status:200,data:c.url==='/logistics'?carriers:returning()});
  }
  it('PC return validates carrier, tracking and acknowledgement before dispatch',async()=>{
    const f=await mountReturn();try{await f.view.submitReturn();assert.equal(f.posts().length,0);fillReturn(f);
      f.view.state.shipment.form.tracking='';await f.view.submitReturn();assert.equal(f.posts().length,0);
      f.view.state.shipment.form.tracking='ok';f.view.state.shipment.form.acknowledged=false;await f.view.submitReturn();assert.equal(f.posts().length,0);
    }finally{f.close();}
  });
  it('PC return freezes payload, blocks duplicate/cancel and verifies exact server fields',async()=>{
    const wait=gate();let body;
    const f=await mountReturn(c=>{if(c.method==='post'){body=JSON.parse(c.data);return wait.promise;}if(body&&c.url!=='/logistics')return{status:200,data:returning({refundType:5,refundExpress:body.refund_express,refundExpressName:body.refund_express_name,refundPhone:body.refund_phone,refundGoodsExplain:body.refund_explain})};});
    try{fillReturn(f);const first=f.view.submitReturn();await flush();f.view.state.shipment.form.tracking='changed';await f.view.submitReturn();await f.view.cancel();
      assert.equal(f.posts().length,1);assert.equal(body.refund_express,'LOCAL-25');wait.resolve({status:200,data:null});await first;
      assert.equal(f.view.state.shipment.outcome,'success');assert.equal(f.view.canReturn.value,false);
    }finally{wait.resolve({status:400});f.close();}
  });
  for(const changed of [{},{refundType:5,refundExpress:'DIFFERENT'},{refundType:5,refundExpress:'LOCAL-25',refundExpressName:'本地快递甲',refundPhone:'000000',refundGoodsExplain:'备注',returnImagesError:'unavailable'}]) {
    it(`PC return unknown remains locked on unconfirmed read ${JSON.stringify(changed)}`,async()=>{
      let sent=false;const f=await mountReturn(c=>{if(c.method==='post'){sent=true;return{status:500,msg:'lost'};}if(sent&&c.url!=='/logistics')return{status:200,data:returning(changed)};});
      try{fillReturn(f);await f.view.submitReturn();
        await f.view.load();await f.view.submitReturn();await f.view.cancel();assert.equal(f.posts().length,1);assert.equal(f.view.state.shipment.outcome,'unknown');assert.equal(f.view.canCancel.value,false);
      }finally{f.close();}
    });
  }
  it('PC return explicit rejection retains form for deliberate retry',async()=>{
    const f=await mountReturn(c=>c.method==='post'?{status:400,msg:'明确拒绝'}:undefined);
    try{fillReturn(f);await f.view.submitReturn();assert.equal(f.view.state.shipment.form.explain,'备注');assert.equal(f.view.canReturn.value,true);assert.equal(f.view.state.shipment.pending,null);}finally{f.close();}
  });
  for(const ending of ['auth','route','unmount']) {
    it(`PC return late response cannot survive ${ending}`,async()=>{
      const wait=gate(),f=await mountReturn(c=>c.method==='post'?wait.promise:undefined),view=f.view;
      try{fillReturn(f);const pending=view.submitReturn();await flush();if(ending==='auth')getContext().authUtils.setAuth('new',22);else if(ending==='route')await f.router.push('/away');else f.close();
        wait.resolve({status:200,data:null});await pending;assert.equal(view.detail.value,null);assert.equal(view.state.shipment.pending,null);assert.equal(view.state.shipment.form.tracking,'');
      }finally{wait.resolve({status:400});f.close();}
    });
  }
  it('PC return validates upload receipt, bounds three images and stores no signatures in the submit body',async()=>{
    let id=0,body;const f=await mountReturn(c=>{if(c.url==='/upload/image'){id++;return{status:200,data:{att_id:id,url:`/api/assets/${id}`,src:`/api/assets/${id}?expires=1999999999&signature=${'a'.repeat(43)}`,type:'image/png',size:12}};}
      if(c.method==='post'){body=JSON.parse(c.data);return{status:400,msg:'test rejection'};}});
    try{fillReturn(f);for(let i=0;i<4;i++)await f.view.uploadReturnImage(new File(['test'],'test.png',{type:'image/png'}));
      assert.equal(id,3);assert.equal(f.view.state.shipment.form.images.length,3);await f.view.submitReturn();assert.deepEqual(body.refund_img,['/api/assets/1','/api/assets/2','/api/assets/3']);
      f.view.removeReturnImage(0);assert.equal(f.view.state.shipment.form.images.length,2);
    }finally{f.close();}
  });
  it('PC return carrier failure is retryable and malformed upload cannot populate evidence',async()=>{
    let fail=true;const f=await mountReturn(c=>c.url==='/logistics'&&fail?{status:500,msg:'carrier offline'}:c.url==='/upload/image'?{status:200,data:{url:'javascript:bad',src:'javascript:bad'}}:undefined);
    try{assert.equal(f.view.canReturn.value,false);assert.match(f.view.state.shipment.carriersError,/offline/);fail=false;await f.view.load();assert.equal(f.view.canReturn.value,true);
      await f.view.uploadReturnImage(new File(['test'],'test.png',{type:'image/png'}));assert.equal(f.view.state.shipment.form.images.length,0);assert.ok(f.view.state.operationError);
    }finally{f.close();}
  });
}
