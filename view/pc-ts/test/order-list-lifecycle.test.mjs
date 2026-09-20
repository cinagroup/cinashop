import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const script='/src/pages/order/OrderList.lifecycle-test.ts';
export function orderListPlugin(root) {
  const id=root.replaceAll('\\','/').replace(/\/$/,'')+script;
  return {name:'actual-order-list',resolveId(value){if(value===script)return id;},async load(value){
    if(value!==id)return;
    const filename=root+'/src/pages/order/OrderList.vue';
    return compileScript(parse(await readFile(filename,'utf8'),{filename}).descriptor,{id:'actual-order-list'}).content.replace(/from (["'])element-plus\1/g,'from "/@test/order-detail-dialog"');
  }};
}
const renderer=createRenderer({createElement:()=>({children:[]}),createText:text=>({text}),createComment:text=>({text}),
  insert(node,parent){node.parent=parent;(parent.children??=[]).push(node);},remove(node){if(node.parent)node.parent.children=node.parent.children.filter(c=>c!==node);},
  parentNode:n=>n.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){}});
const flush=async()=>{for(let i=0;i<30;i++){await Promise.resolve();await nextTick();}};
const gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve};};
const row=(id,change={})=>({id,uid:11,orderId:`local_list_${id}`,paid:0,status:0,payPrice:'10.00',totalPrice:'10.00',totalNum:1,addTime:1000-id,cartInfo:[],pid:0,supplierAllocationStatus:0,shippingType:1,deliveryType:'',refundStatus:0,...change});
const rows=(page,limit=20)=>Array.from({length:page===1?limit:2},(_,i)=>row((page-1)*limit+i+1));
export function registerOrderListTests(getContext){
  async function mount(override=()=>undefined){
    const {server,api,response}=getContext(),calls=[];
    const dialog=(await server.ssrLoadModule('/@test/order-detail-dialog')).state;
    dialog.messages.length=0;dialog.closed=0;dialog.confirm=async()=>{};
    api.defaults.adapter=async config=>{calls.push(config);return response(config,await override(config)??{status:200,data:config.method==='post'?null:rows(config.params?.page??1)});};
    let view;const component=(await server.ssrLoadModule(script)).default;
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/order',component:{setup(props,ctx){view=component.setup(props,ctx);return()=>null;}}},{path:'/order/:orderId',component:{render:()=>null}}]});
    const app=renderer.createApp({render:()=>h(RouterView)});app.use(router);await router.push('/order');app.mount({children:[]});await flush();let closed=false;
    return{get view(){return view;},calls,router,dialog,close(){if(!closed){app.unmount();closed=true;}}};
  }
  it('shared deletion admission matches unpaid, cancelled, completed and refunded physical orders only',async()=>{
    const {canDeleteOrder,orderDeleteConfirmation}=await getContext().server.ssrLoadModule('/@fs/'+new URL('../../common/orderDeletion.ts',import.meta.url).pathname.replace(/^\/(?:([A-Z]:))/i,'$1'));
    const base={id:1,uid:11,order_id:'local_list_1',paid:0,status:0,pid:0,supplier_allocation_status:0,refund_status:0};
    for(const patch of [{},{status:-2},{paid:1,status:3},{paid:1,status:0,refund_status:2,pid:99},{paid:1,status:2,refund_status:2}])assert.equal(canDeleteOrder({...base,...patch}),true,JSON.stringify(patch));
    for(const patch of [{paid:1,status:0},{paid:1,status:1},{paid:1,status:2},{paid:1,status:4},{paid:1,status:5},{refund_status:1},{refund_status:4},{pid:-1},{pid:undefined},{supplier_allocation_status:1},{supplier_allocation_status:undefined},{paid:'1'},{uid:0},{id:0},{order_id:'x'.repeat(51)},{order_id:'../escape'},{is_del:1},{is_system_del:1},{paid:1,refund_status:2,status:NaN}])assert.equal(canDeleteOrder({...base,...patch}),false,JSON.stringify(patch));
    assert.match(orderDeleteConfirmation(base),/取消并删除未付款订单 local_list_1/);
    assert.match(orderDeleteConfirmation({...base,paid:1,status:3}),/不会发起退款.*售后退款记录仍会保留/);
  });
  it('PC deletion adapter validates order IDs before dispatch and requires a null success body',async()=>{
    const f=await mount();try{
      const {apiOrderDelete}=await getContext().server.ssrLoadModule('/src/api/order.ts');
      for(const id of ['',null,1,'../bad','x'.repeat(51)])await assert.rejects(apiOrderDelete(id));
      assert.equal(f.calls.filter(c=>c.method==='post').length,0);
      await apiOrderDelete('local_list_1');assert.equal(f.calls.at(-1).url,'/order/del');assert.deepEqual(JSON.parse(f.calls.at(-1).data),{order_id:'local_list_1'});
    }finally{f.close();}
  });
  it('PC delete confirmation preserves the order on cancel and names the precise consequence',async()=>{
    const f=await mount();let text;f.dialog.confirm=async content=>{text=content;throw 'cancel';};
    try{await f.view.remove(f.view.orders.value[0]);assert.match(text,/local_list_1.*释放库存、优惠券和抵扣积分/);assert.equal(f.view.orders.value.length,20);assert.equal(f.calls.length,1);assert.equal(f.view.busy.value,false);}finally{f.close();}
  });
  it('PC delete succeeds once and reloads page one without skipping shifted offset rows',async()=>{
    let removed=false;const f=await mount(c=>{if(c.method==='post'){removed=true;return{status:200,data:null};}const all=Array.from({length:22},(_,i)=>row(i+1)).filter(r=>!removed||r.id!==1);return{status:200,data:all.slice((c.params.page-1)*20,c.params.page*20)};});
    try{await f.view.loadMore();assert.equal(f.view.orders.value.length,22);await f.view.remove(f.view.orders.value[0]);assert.equal(f.view.list.page,1);assert.equal(f.view.orders.value.length,20);assert.equal(f.view.orders.value[0].id,2);await f.view.loadMore();assert.deepEqual(f.view.orders.value.map(r=>r.id),Array.from({length:21},(_,i)=>i+2));assert.equal(f.calls.filter(c=>c.method==='post').length,1);assert.deepEqual(f.dialog.messages,['订单已删除']);}finally{f.close();}
  });
  for(const ending of ['filter','identity','unmount'])it(`PC delete confirmation cannot follow ${ending}`,async()=>{
    const wait=gate(),f=await mount();f.dialog.confirm=()=>wait.promise;
    try{const old=f.view.orders.value[0],pending=f.view.remove(old);await f.view.remove(old);
      if(ending==='filter'){await f.view.switchTab('complete');await flush();}else if(ending==='identity')getContext().authUtils.setAuth('session-a',11);else f.close();
      wait.resolve();await pending;assert.equal(f.calls.filter(c=>c.method==='post').length,0);assert.equal(f.dialog.closed,1);
    }finally{wait.resolve();f.close();}
  });
  for(const ending of ['filter','identity','unmount'])it(`PC late delete response cannot alter ${ending} replacement`,async()=>{
    const wait=gate(),f=await mount(c=>c.method==='post'?wait.promise:undefined);
    try{const old=f.view.orders.value[0],pending=f.view.remove(old);await flush();await f.view.remove(old);await f.view.loadMore();assert.equal(f.calls.filter(c=>c.method==='post').length,1);
      if(ending==='filter'){await f.view.switchTab('complete');await flush();}else if(ending==='identity')getContext().authUtils.setAuth('other',22);else f.close();
      const count=f.calls.length;wait.resolve({status:200,data:null});await pending;assert.equal(f.calls.length,count);assert.deepEqual(f.dialog.messages,[]);
    }finally{wait.resolve({status:200,data:null});f.close();}
  });
  for(const response of [{status:400,msg:'退款处理中'},{status:200,data:{}},{status:200}])it(`PC uncertain/rejected deletion does not hide or retry: ${JSON.stringify(response)}`,async()=>{
    const f=await mount(c=>c.method==='post'?response:undefined);try{const old=f.view.orders.value[0];await f.view.remove(old);await f.view.remove(old);await f.view.loadMore();assert.equal(f.calls.filter(c=>c.method==='post').length,1);assert.equal(f.view.orders.value[0],old);assert.match(f.view.actionError.value,/尚未确认/);assert.deepEqual(f.dialog.messages,[]);await f.view.reload();assert.equal(f.view.actionError.value,'');}finally{f.close();}
  });
  it('PC successful deletion followed by failed refresh cannot leave stale actionable orders',async()=>{
    let deleted=false;const f=await mount(c=>{if(c.method==='post'){deleted=true;return{status:200,data:null};}return deleted?{status:400,msg:'刷新失败'}:undefined;});
    try{const old=f.view.orders.value[0];await f.view.remove(old);assert.equal(f.view.orders.value.length,0);assert.match(f.view.list.error,/刷新失败/);await f.view.remove(old);assert.equal(f.calls.filter(c=>c.method==='post').length,1);}finally{f.close();}
  });
  it('PC deletion refuses stale references and changed confirmation state',async()=>{
    const wait=gate(),f=await mount();f.dialog.confirm=()=>wait.promise;
    try{const old=f.view.orders.value[0];await f.view.remove({...old});assert.equal(f.view.deleting.value,false);const pending=f.view.remove(old);old.paid=1;old.status=3;wait.resolve();await pending;assert.equal(f.calls.filter(c=>c.method==='post').length,0);assert.match(f.view.actionError.value,/状态已变化/);}finally{wait.resolve();f.close();}
  });
  it('PC deletion does not offer a mutation for review, partial fulfillment, audit roots or active refunds',async()=>{
    const f=await mount(()=>({status:200,data:[row(1,{paid:1,status:2}),row(2,{paid:1,status:4}),row(3,{paid:1,status:5}),row(4,{pid:-1}),row(5,{supplierAllocationStatus:1}),row(6,{paid:1,status:3,refundStatus:1})]}));let confirmations=0;f.dialog.confirm=async()=>{confirmations++;};
    try{for(const order of f.view.orders.value)await f.view.remove(order);assert.equal(confirmations,0);assert.equal(f.calls.length,1);}finally{f.close();}
  });
  it('PC order list loads orders beyond the first 20 without losing the first page',async()=>{
    const f=await mount();try{assert.equal(f.view.orders.value.length,20);await f.view.loadMore();assert.equal(f.view.orders.value.length,22);assert.equal(f.calls.at(-1).params.page,2);}finally{f.close();}
  });
  it('PC order list refresh failure does not leave old account orders actionable',async()=>{
    let fail=false;const f=await mount(c=>fail?{status:400,msg:'列表读取失败'}:undefined);
    try{fail=true;await f.view.reload();assert.equal(f.view.orders.value.length,0);assert.match(f.view.list.error,/列表读取失败/);}finally{f.close();}
  });
  it('PC order list clears old orders synchronously on identity renewal',async()=>{
    const f=await mount();try{getContext().authUtils.setAuth('other',22);assert.equal(f.view.orders.value.length,0);}finally{f.close();}
  });
  it('PC order list retries page two exactly and suppresses concurrent load-more requests',async()=>{
    let fail=true;const waiting=gate(),f=await mount(c=>c.params?.page===2?(fail?{status:400,msg:'第二页故障'}:waiting.promise):undefined);
    try{await f.view.loadMore();assert.equal(f.view.list.page,1);assert.equal(f.view.orders.value.length,20);fail=false;
      const pending=f.view.loadMore();await f.view.loadMore();await flush();assert.deepEqual(f.calls.map(c=>c.params.page),[1,2,2]);
      waiting.resolve({status:200,data:rows(2)});await pending;assert.equal(f.view.list.page,2);assert.equal(f.view.list.hasMore,false);await f.view.loadMore();assert.equal(f.calls.length,3);
    }finally{waiting.resolve({status:400});f.close();}
  });
  it('PC order list provides all six filters and resets pagination per accepted route',async()=>{
    const f=await mount();try{for(const [index,name] of ['unpaid','pending','shipping','review','complete'].entries()){
      await f.view.switchTab(name);await flush();assert.equal(f.calls.at(-1).params.status,index);assert.equal(f.calls.at(-1).params.page,1);assert.equal(f.view.activeTab.value,name);
    }await f.view.switchTab('all');await flush();assert.equal(f.calls.at(-1).params.status,undefined);}finally{f.close();}
  });
  for(const ending of ['filter','identity','unmount'])it(`PC order list ignores late page after ${ending}`,async()=>{
    const waiting=gate(),f=await mount(c=>c.params?.page===2?waiting.promise:undefined);
    try{const pending=f.view.loadMore();await flush();
      if(ending==='filter'){await f.view.switchTab('complete');await flush();}
      else if(ending==='identity')getContext().authUtils.setAuth('other',22);else f.close();
      waiting.resolve({status:200,data:rows(2)});await pending;assert.equal(f.view.orders.value.length,ending==='filter'?20:0);
      assert.equal(f.view.orders.value.some(row=>row.id>20),false);
    }finally{waiting.resolve({status:400});f.close();}
  });
  for(const invalid of [[row(1,{uid:22})],[row(1),row(1)],[row(1,{payPrice:'oops'})],{}])it(`PC order list rejects invalid response ${JSON.stringify(invalid)}`,async()=>{
    const f=await mount(()=>({status:200,data:invalid}));try{assert.equal(f.view.orders.value.length,0);assert.ok(f.view.list.error);}finally{f.close();}
  });
  it('PC order list overlap requires full refresh rather than duplicate display',async()=>{
    let overlap=true;const f=await mount(c=>overlap&&c.params?.page===2?{status:200,data:[row(1)]}:undefined);
    try{await f.view.loadMore();assert.equal(f.view.orders.value.length,20);assert.equal(f.view.list.refreshRequired,true);const count=f.calls.length;
      await f.view.loadMore();assert.equal(f.calls.length,count);overlap=false;await f.view.reload();await f.view.loadMore();assert.equal(f.view.orders.value.length,22);
    }finally{f.close();}
  });
  it('PC order list rejects ambiguous route filters and recovers through a selected tab',async()=>{
    const f=await mount();try{const count=f.calls.length;await f.router.push('/order?status=0&status=1');await flush();assert.equal(f.calls.length,count);assert.equal(f.view.orders.value.length,0);assert.ok(f.view.list.error);
      await f.view.switchTab('review');await flush();assert.equal(f.calls.at(-1).params.status,3);
    }finally{f.close();}
  });
  it('PC order list receipt confirmation cannot follow a filter/account replacement',async()=>{
    const waiting=gate(),f=await mount(()=>({status:200,data:[row(1,{paid:1,status:1,deliveryType:'express'})]}));f.dialog.confirm=()=>waiting.promise;
    try{const pending=f.view.take(f.view.orders.value[0]);await f.view.take(f.view.orders.value[0]);await f.view.switchTab('complete');await flush();waiting.resolve();await pending;
      assert.equal(f.calls.filter(c=>c.method==='post').length,0);assert.equal(f.dialog.closed,1);
    }finally{waiting.resolve();f.close();}
  });
  it('PC order list unknown receipt write blocks repeats until explicit read',async()=>{
    const f=await mount(c=>c.method==='post'?{status:400,msg:'回执未知'}:{status:200,data:[row(1,{paid:1,status:1,deliveryType:'express'})]});
    try{await f.view.take(f.view.orders.value[0]);await f.view.take(f.view.orders.value[0]);assert.equal(f.calls.filter(c=>c.method==='post').length,1);assert.match(f.view.actionError.value,/尚未确认/);
      await f.view.reload();assert.equal(f.view.actionError.value,'');
    }finally{f.close();}
  });
  it('PC order list failed navigation allows a write-free retry of the loaded order',async()=>{
    const f=await mount();let blocked=true;const remove=f.router.beforeEach(to=>to.path.startsWith('/order/')&&blocked?false:undefined);
    try{const old=f.view.orders.value[0];await f.view.goDetail(old);assert.match(f.view.actionError.value,/未打开/);blocked=false;await f.view.goDetail(old);assert.equal(f.router.currentRoute.value.path,'/order/local_list_1');assert.equal(f.calls.filter(c=>c.method==='post').length,0);
    }finally{remove();f.close();}
  });
}
