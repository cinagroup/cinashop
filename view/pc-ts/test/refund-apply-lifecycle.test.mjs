import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const script='/src/pages/order/RefundApply.lifecycle-test.ts';
export function refundApplyPlugin(root) {
  const id=root.replaceAll('\\','/').replace(/\/$/,'')+script;
  return {name:'actual-refund-apply',resolveId(value){if(value===script)return id;},async load(value){
    if(value!==id)return;const filename=root+'/src/pages/order/RefundApply.vue';
    return compileScript(parse(await readFile(filename,'utf8'),{filename}).descriptor,{id:'actual-refund-apply'}).content.replace(/from (["'])element-plus\1/g,'from "/@test/order-detail-dialog"');
  }};
}
const renderer=createRenderer({createElement:()=>({children:[]}),createText:text=>({text}),createComment:text=>({text}),
  insert(node,parent){node.parent=parent;(parent.children??=[]).push(node);},remove(node){if(node.parent)node.parent.children=node.parent.children.filter(c=>c!==node);},
  parentNode:n=>n.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
const flush=async()=>{for(let i=0;i<30;i++){await Promise.resolve();await nextTick();}};
const gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve};};
const detail=(id,change={})=>({id:100,uid:11,orderId:id,paid:1,payPrice:'10.00',status:0,productType:0,pid:0,supplierAllocationStatus:0,refundStatus:0,
  cartInfo:[{id:1,oid:100,cartId:'500',cartNum:2,refundNum:0,isSupportRefund:1,writeTimes:0,writeSurplusTimes:0,cartInfo:{product:{storeName:'本地商品'},sku:{price:'5.00',suk:'红色'}}}],...change});
export function registerRefundApplyTests(getContext){
  async function mount(override=()=>undefined){
    const {server,api,response}=getContext(),calls=[];let view;
    api.defaults.adapter=async config=>{calls.push(config);return response(config,await override(config)??{status:200,data:config.method==='post'?{refundId:91}:detail(config.url.split('/').at(-1))});};
    const component=(await server.ssrLoadModule(script)).default;
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/refund/:orderId',component:{setup(props,ctx){view=component.setup(props,ctx);return()=>null;}}},{path:'/order/:orderId',component:{render:()=>null}},{path:'/order',component:{render:()=>null}}]});
    const app=renderer.createApp({render:()=>h(RouterView)});app.use(router);await router.push('/refund/local_A');app.mount({children:[]});await flush();
    return{get view(){return view;},calls,router,close(){app.unmount();}};
  }
  it('PC refund clears the previous form and order after identity renewal',async()=>{
    const f=await mount();try{f.view.form.refundReason='其他原因';getContext().authUtils.setAuth('other',22);
      assert.equal(f.view.order.value,null);assert.equal(f.view.form.refundReason,'');
    }finally{f.close();}
  });
  it('PC refund same component route change cannot submit the former order form',async()=>{
    const f=await mount();try{f.view.form.refundReason='其他原因';await f.router.push('/refund/local_B');await flush();
      assert.equal(f.view.order.value.order_id,'local_B');assert.equal(f.view.form.refundReason,'');
    }finally{f.close();}
  });
  it('PC refund repeated submit dispatches only one application',async()=>{
    const waiting=gate(),f=await mount(c=>c.method==='post'?waiting.promise:undefined);
    try{f.view.form.refundReason='其他原因';f.view.selectedIds.value=[1];
      const first=f.view.submit(),second=f.view.submit();await flush();assert.equal(f.calls.filter(c=>c.method==='post').length,1);
      waiting.resolve({status:200,data:{refundId:91}});await Promise.all([first,second]);
    }finally{waiting.resolve({status:400});f.close();}
  });
  const fill=f=>{f.view.selectedIds.value=[1];f.view.form.refundReason='  其他原因  ';};
  const posts=f=>f.calls.filter(c=>c.method==='post');
  for(const [name,change] of Object.entries({foreign:{uid:22},wrongOrder:{orderId:'other'},invalidAmount:{payPrice:'NaN'},missingLines:{cartInfo:[]},
    foreignLine:{cartInfo:[{...detail('local_A').cartInfo[0],oid:200}]},duplicateLines:{cartInfo:[...detail('local_A').cartInfo,...detail('local_A').cartInfo]}})){
    it(`PC refund rejects ${name} response before editing`,async()=>{
      const f=await mount(()=>({status:200,data:detail('local_A',change)}));try{fill(f);await f.view.submit();
        assert.equal(f.view.order.value,null);assert.ok(f.view.state.loadError);assert.equal(posts(f).length,0);
      }finally{f.close();}
    });
  }
  for(const change of [{paid:0},{pid:-1},{supplierAllocationStatus:1},{status:-2},{productType:1}]){
    it(`PC refund blocks ineligible order ${JSON.stringify(change)}`,async()=>{
      const f=await mount(()=>({status:200,data:detail('local_A',change)}));try{fill(f);await f.view.submit();
        assert.ok(f.view.refundBlockedReason.value);assert.equal(posts(f).length,0);
      }finally{f.close();}
    });
  }
  it('PC refund validates current selections, apply type and text limits without POST',async()=>{
    const f=await mount();try{
      for(const ids of [[],[1,1],[999]]){fill(f);f.view.selectedIds.value=ids;await f.view.submit();}
      fill(f);f.view.form.applyType=4;await f.view.submit();f.view.form.applyType=1;
      for(const reason of ['', 'x'.repeat(256)]){f.view.form.refundReason=reason;await f.view.submit();}
      fill(f);f.view.form.refundExplain='x'.repeat(256);await f.view.submit();assert.equal(posts(f).length,0);
    }finally{f.close();}
  });
  it('PC refund snapshots body and preserves receipt when order navigation fails',async()=>{
    const waiting=gate(),f=await mount(c=>c.method==='post'?waiting.promise:undefined);
    try{fill(f);f.view.form.applyType=2;const pending=f.view.submit();f.view.selectedIds.value.push(999);f.view.form.refundReason='changed';await flush();
      assert.deepEqual(JSON.parse(posts(f)[0].data),{cartIds:[1],applyType:2,refundReason:'其他原因',refundExplain:''});
      waiting.resolve({status:200,data:{refundId:91}});await pending;assert.equal(f.view.state.refundId,91);assert.equal(f.router.currentRoute.value.path,'/refund/local_A');
      f.router.beforeEach(()=>false);await f.view.goOrder();assert.match(f.view.navigationError.value,/不会重复/);await f.view.goOrder();
      await f.view.load();fill(f);await f.view.submit();assert.equal(f.view.state.refundId,91);assert.equal(posts(f).length,1);
    }finally{waiting.resolve({status:400});f.close();}
  });
  for(const reply of [{status:500,msg:'unknown'},{status:200,data:{id:91}},{status:200,data:{refundId:-1}}]){
    it(`PC refund does not resend an uncertain application after refreshing ${JSON.stringify(reply)}`,async()=>{
      const f=await mount(c=>c.method==='post'?reply:undefined);try{fill(f);await f.view.submit();assert.equal(f.view.state.uncertain,true);
        await f.view.load();fill(f);await f.view.submit();assert.equal(posts(f).length,1);
      }finally{f.close();}
    });
  }
  it('PC refund transport failure stays uncertain, while explicit rejection permits retry',async()=>{
    for(const transport of [true,false]){
      const f=await mount(c=>{if(c.method==='post'){if(transport)throw Error('lost response');return{status:400,msg:'明确拒绝'};}});
      try{fill(f);await f.view.submit();assert.equal(f.view.state.uncertain,transport);await f.view.submit();assert.equal(posts(f).length,transport?1:2);}finally{f.close();}
    }
  });
  it('PC refund late success cannot survive an order route change or auth renewal',async()=>{
    for(const ending of ['route','auth','unmount']){
      const waiting=gate(),f=await mount(c=>c.method==='post'?waiting.promise:undefined);const view=f.view;
      try{fill(f);const pending=view.submit();await flush();if(ending==='route'){await f.router.push('/refund/local_B');await flush();}
        else if(ending==='auth')getContext().authUtils.setAuth('replacement',22);else f.close();
        waiting.resolve({status:200,data:{refundId:91}});await pending;assert.equal(view.state.refundId,0);assert.equal(posts(f).length,1);
        if(ending!=='route')assert.equal(view.order.value,null);
      }finally{waiting.resolve({status:400});if(ending!=='unmount')f.close();getContext().authUtils.setAuth('synthetic-local-token',11);}
    }
  });
}
