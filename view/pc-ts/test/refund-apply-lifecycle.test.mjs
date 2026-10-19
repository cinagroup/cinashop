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
      assert.deepEqual(JSON.parse(posts(f)[0].data),{cart_ids:[{cart_id:1,cart_num:2}],applyType:2,refundReason:'其他原因',refundExplain:''});
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

  const image = (id = 31) => ({ att_id: id, url: `/api/assets/${id}`, src: `/api/assets/${id}?expires=1700001000&signature=${'a'.repeat(43)}`, size: 68, type: 'image/png' });
  const fileInput = () => ({ target: { value: 'local.png', files: [new File([new Uint8Array([137,80,78,71])], 'local.png', { type: 'image/png' })] } });
  const selectFile = f => { f.view.beginApplicationImageSelection(); return fileInput(); };
  it('PC application images upload via actual multipart API and submit canonical references only', async () => {
    const f = await mount(c => c.url === '/upload/image' ? { status: 200, data: image() } : undefined);
    try {
      const event = selectFile(f); await f.view.uploadApplicationImage(event); assert.equal(event.target.value, '');
      const upload = f.calls.find(c => c.url === '/upload/image'); assert.ok(upload.data instanceof FormData); assert.ok(upload.data.get('file') instanceof File);
      assert.equal(upload.headers.get('Authori-zation'), 'Bearer session-a'); assert.equal(f.view.state.images[0].url, '/api/assets/31');
      fill(f); await f.view.submit(); const request = f.calls.find(c => c.url.includes('/refund/apply/'));
      assert.equal(JSON.parse(request.data).refundImg, '["/api/assets/31"]'); assert.ok(!request.data.includes('signature'));
    } finally { f.close(); }
  });
  it('PC application upload locks submit, refresh and overlapping selections then recovers', async () => {
    const wait = gate(), f = await mount(c => c.url === '/upload/image' ? wait.promise : undefined);
    try {
      fill(f); const pending = f.view.uploadApplicationImage(selectFile(f)); await flush();
      await f.view.uploadApplicationImage(selectFile(f)); await f.view.submit(); await f.view.load();
      assert.equal(f.calls.filter(c => c.url === '/upload/image').length, 1); assert.equal(f.calls.filter(c => c.url.includes('/refund/apply/')).length, 0); assert.equal(f.calls.length, 2);
      assert.equal(f.view.editable.value, false); wait.resolve({ status: 200, data: image() }); await pending; assert.equal(f.view.editable.value, true);
    } finally { wait.resolve({ status: 400 }); f.close(); }
  });
  for (const ending of ['route', 'auth', 'unmount']) it(`PC application late image cannot cross ${ending}`, async () => {
    const wait = gate(), f = await mount(c => c.url === '/upload/image' ? wait.promise : undefined), view = f.view;
    try {
      const pending = view.uploadApplicationImage(selectFile(f)); await flush();
      if (ending === 'route') await f.router.push('/refund/local_B');
      if (ending === 'auth') getContext().authUtils.setAuth('replacement', 22);
      if (ending === 'unmount') f.close();
      wait.resolve({ status: 200, data: image() }); await pending; assert.deepEqual(view.state.images, []); assert.equal(view.state.uploading, false);
    } finally { wait.resolve({ status: 400 }); if (ending !== 'unmount') f.close(); }
  });
  it('PC application image limit, duplicate, failed preview and removal preserve exact references', async () => {
    let id = 31; const f = await mount(c => c.url === '/upload/image' ? { status: 200, data: image(id) } : undefined);
    try {
      await f.view.uploadApplicationImage(selectFile(f)); await f.view.uploadApplicationImage(selectFile(f)); assert.equal(f.view.state.images.length, 1); assert.match(f.view.state.submitError, /已添加/);
      for (id of [32, 33]) await f.view.uploadApplicationImage(selectFile(f)); await f.view.uploadApplicationImage(selectFile(f));
      assert.equal(f.calls.filter(c => c.url === '/upload/image').length, 4); assert.equal(f.view.state.images.length, 3);
      f.view.imageFailed('/api/assets/31'); assert.deepEqual(f.view.failedImages.value, ['/api/assets/31']); f.view.removeApplicationImage(0);
      assert.deepEqual(f.view.failedImages.value, []); assert.deepEqual(f.view.state.images.map(x => x.url), ['/api/assets/32', '/api/assets/33']);
    } finally { f.close(); }
  });
  for (const malformed of [{ ...image(), att_id: '31' }, { ...image(), size: 0 }, { ...image(), src: 'javascript:alert(1)' }, { ...image(), url: '/api/assets/32' }]) it('PC application rejects malformed image upload receipt '+JSON.stringify(malformed), async () => {
    const f = await mount(c => c.url === '/upload/image' ? { status: 200, data: malformed } : undefined);
    try { await f.view.uploadApplicationImage(selectFile(f)); assert.deepEqual(f.view.state.images, []); assert.ok(f.view.state.submitError); assert.equal(f.view.state.uncertain, false); assert.equal(f.view.state.uploading, false); }
    finally { f.close(); }
  });

  for (const ending of ['route', 'auth', 'unmount']) it(`PC application picker result cannot move to a new context after ${ending}`, async () => {
    const f = await mount(), view = f.view, selected = selectFile(f);
    try {
      if (ending === 'route') { await f.router.push('/refund/local_B'); await flush(); }
      if (ending === 'auth') getContext().authUtils.setAuth('replacement', 22);
      if (ending === 'unmount') f.close();
      await view.uploadApplicationImage(selected); assert.equal(f.calls.filter(c => c.url === '/upload/image').length, 0); assert.deepEqual(view.state.images, []);
    } finally { if (ending !== 'unmount') f.close(); }
  });
  const quantityInput = (f, value, item = f.view.state.items[0]) => f.view.editQuantity(item, { target: { value } });
  const appliedBody = f => JSON.parse(f.calls.find(c => c.url.includes('/refund/apply/')).data);
  it('PC partial refund distinguishes purchased, previously claimed and selected quantities in the actual HTTP body', async () => {
    const f = await mount(c => c.method === 'post' ? undefined : { status: 200, data: detail('local_A', { cartInfo: [{ ...detail('local_A').cartInfo[0], cartNum: 5, refundNum: 2 }] }) });
    try {
      fill(f); const item = f.view.state.items[0]; assert.equal(item.quantity, 5); assert.equal(item.remainingQuantity, 3); assert.equal(f.view.state.quantities[1], '3');
      quantityInput(f, '1'); await f.view.submit(); assert.deepEqual(appliedBody(f), { cart_ids: [{ cart_id: 1, cart_num: 1 }], applyType: 1, refundReason: '其他原因', refundExplain: '' });
      assert.equal(Object.hasOwn(appliedBody(f), 'cartIds'), false); assert.equal(Object.hasOwn(appliedBody(f), 'cartSelections'), false);
    } finally { f.close(); }
  });
  it('PC partial refund defaults to the observed remainder without altering purchased quantity', async () => {
    const f = await mount(c => c.method === 'post' ? undefined : { status: 200, data: detail('local_A', { cartInfo: [{ ...detail('local_A').cartInfo[0], cartNum: 3, refundNum: 1 }] }) });
    try { fill(f); await f.view.submit(); assert.equal(appliedBody(f).cart_ids[0].cart_num, 2); assert.equal(f.view.state.items[0].quantity, 3); }
    finally { f.close(); }
  });
  it('PC partial refund freezes independent quantities for each selected line and excludes unselected lines', async () => {
    const rows = [detail('local_A').cartInfo[0], { ...detail('local_A').cartInfo[0], id: 2, cartNum: 4, refundNum: 1 }, { ...detail('local_A').cartInfo[0], id: 3 }];
    const f = await mount(c => c.method === 'post' ? undefined : { status: 200, data: detail('local_A', { cartInfo: rows }) });
    try {
      fill(f); f.view.selectedIds.value = [1, 2]; quantityInput(f, '1'); quantityInput(f, '2', f.view.state.items[1]); quantityInput(f, '1', f.view.state.items[2]);
      assert.equal(f.view.state.quantities[3], '2'); await f.view.submit(); assert.deepEqual(appliedBody(f).cart_ids, [{ cart_id: 1, cart_num: 1 }, { cart_id: 2, cart_num: 2 }]);
    } finally { f.close(); }
  });
  it('PC invalid quantity stays editable, blocks actual POST and permits an explicit correction', async () => {
    const f = await mount(); try {
      fill(f);
      for (const value of ['', '0', '-1', '1.5', '1e2', '01', '3', '9007199254740992']) {
        quantityInput(f, value); assert.equal(f.view.canSubmit.value, false); assert.equal(f.view.editable.value, true); await f.view.submit(); assert.equal(posts(f).length, 0); assert.match(f.view.state.submitError, /整数件数/);
      }
      quantityInput(f, '1'); assert.equal(f.view.canSubmit.value, true); await f.view.submit(); assert.equal(appliedBody(f).cart_ids[0].cart_num, 1);
    } finally { f.close(); }
  });
  it('PC missing or forged numeric quantity state cannot bypass the shared submission gate', async () => {
    const f = await mount(); try {
      fill(f); for (const value of [undefined, null, 1, {}, NaN, Infinity]) { f.view.state.quantities[1] = value; await f.view.submit(); assert.equal(posts(f).length, 0); }
    } finally { f.close(); }
  });
  it('PC quantity buttons respect both limits and cannot edit unselected or forged line objects', async () => {
    const f = await mount(); try {
      const item = f.view.state.items[0]; quantityInput(f, '1'); assert.equal(f.view.state.quantities[1], '2'); fill(f);
      f.view.adjustQuantity(item, 1); assert.equal(f.view.state.quantities[1], '2'); f.view.adjustQuantity(item, -1); f.view.adjustQuantity(item, -1); assert.equal(f.view.state.quantities[1], '1');
      quantityInput(f, '2', { ...item }); f.view.adjustQuantity({ ...item }, 1); f.view.adjustQuantity(item, 2); assert.equal(f.view.state.quantities[1], '1');
      f.view.adjustQuantity(item, 1); assert.equal(f.view.state.quantities[1], '2');
    } finally { f.close(); }
  });
  it('PC reload uses fresh remaining quantity and rejects a late event from the previous row object', async () => {
    let remaining = 2; const f = await mount(c => c.method === 'post' ? undefined : { status: 200, data: detail('local_A', { cartInfo: [{ ...detail('local_A').cartInfo[0], refundNum: 2 - remaining }] }) });
    try {
      fill(f); quantityInput(f, '1'); const oldItem = f.view.state.items[0]; remaining = 1; await f.view.load(); fill(f);
      assert.equal(f.view.state.quantities[1], '1'); quantityInput(f, '2', oldItem); assert.equal(f.view.state.quantities[1], '1'); await f.view.submit(); assert.equal(appliedBody(f).cart_ids[0].cart_num, 1);
    } finally { f.close(); }
  });
  it('PC account, route and unmount clear selected quantities and invalidate old controls', async () => {
    for (const ending of ['auth', 'route', 'unmount']) {
      const f = await mount(), view = f.view; try {
        fill(f); quantityInput(f, '1'); const item = view.state.items[0];
        if (ending === 'auth') getContext().authUtils.setAuth('replacement', 22);
        if (ending === 'route') { await f.router.push('/refund/local_B'); await flush(); }
        if (ending === 'unmount') f.close();
        assert.deepEqual(view.state.selectedIds, []); assert.deepEqual(view.state.quantities, ending === 'route' ? { 1: '2' } : {});
        view.editQuantity(item, { target: { value: '1' } }); assert.deepEqual(view.state.quantities, ending === 'route' ? { 1: '2' } : {}); assert.equal(posts(f).length, 0);
      } finally { if (ending !== 'unmount') f.close(); getContext().authUtils.setAuth('session-a', 11); }
    }
  });
  it('PC pending quantity request cannot be changed by controls or double submit and stays a frozen HTTP intent', async () => {
    const wait = gate(), f = await mount(c => c.method === 'post' ? wait.promise : undefined); try {
      fill(f); quantityInput(f, '1'); const item = f.view.state.items[0], pending = f.view.submit();
      quantityInput(f, '2'); f.view.adjustQuantity(item, 1); await f.view.submit(); assert.equal(f.view.state.quantities[1], '1');
      f.view.state.quantities[1] = '2'; await flush(); assert.equal(posts(f).length, 1); assert.equal(appliedBody(f).cart_ids[0].cart_num, 1);
      wait.resolve({ status: 200, data: { refundId: 91 } }); await pending;
    } finally { wait.resolve({ status: 400 }); f.close(); }
  });
  it('PC uncertain partial request cannot be replaced by a different quantity after refresh', async () => {
    const f = await mount(c => c.method === 'post' ? { status: 500, msg: 'lost' } : undefined); try {
      fill(f); quantityInput(f, '1'); await f.view.submit(); await f.view.load(); fill(f); quantityInput(f, '2'); await f.view.submit();
      assert.equal(f.view.state.uncertain, true); assert.equal(f.view.editable.value, false); assert.equal(posts(f).length, 1); assert.equal(appliedBody(f).cart_ids[0].cart_num, 1);
    } finally { f.close(); }
  });
  it('PC upload in progress cannot mutate the selected quantity before submission', async () => {
    const wait = gate(), f = await mount(c => c.url === '/upload/image' ? wait.promise : undefined); try {
      fill(f); quantityInput(f, '1'); const pending = f.view.uploadApplicationImage(selectFile(f)); quantityInput(f, '2'); f.view.adjustQuantity(f.view.state.items[0], 1); assert.equal(f.view.state.quantities[1], '1');
      wait.resolve({ status: 200, data: image() }); await pending; await f.view.submit(); assert.equal(appliedBody(f).cart_ids[0].cart_num, 1); assert.equal(appliedBody(f).refundImg, '["/api/assets/31"]');
    } finally { wait.resolve({ status: 400 }); f.close(); }
  });
  it('PC large safe purchased count uses bounded scalar controls and emits only the selected remainder', async () => {
    const f = await mount(c => c.method === 'post' ? undefined : { status: 200, data: detail('local_A', { cartInfo: [{ ...detail('local_A').cartInfo[0], cartNum: Number.MAX_SAFE_INTEGER, refundNum: Number.MAX_SAFE_INTEGER - 2 }] }) });
    try { fill(f); quantityInput(f, '1'); await f.view.submit(); assert.equal(f.view.state.items[0].remainingQuantity, 2); assert.equal(appliedBody(f).cart_ids[0].cart_num, 1); }
    finally { f.close(); }
  });
}
