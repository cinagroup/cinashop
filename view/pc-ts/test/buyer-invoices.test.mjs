import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const fixture = createRequire(import.meta.url)('../../common/test/buyerInvoiceFixture.cjs');
const prefix = '/src/pages/user/';
export function buyerInvoicesPlugin(root) {
  root = root.replace(/\/$/, '');
  const scripts = new Map(['InvoiceList', 'InvoiceOrder'].map(name => [root + prefix + name + '.lifecycle-test.ts', name]));
  return { name: 'actual-buyer-invoices', resolveId(id) { if (id.startsWith(prefix) && id.endsWith('.lifecycle-test.ts')) return root + id; },
    async load(id) {
      if (id === '/@test/buyer-invoice-dialog') return 'export const state={confirm:async()=>{}};export const ElMessageBox={confirm:(...args)=>state.confirm(...args)};';
      if (!scripts.has(id)) return; const filename = root + prefix + scripts.get(id) + '.vue';
      return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'actual-buyer-invoices' }).content;
    },
    transform(code, id) { if (id === root + '/src/composables/useBuyerInvoices.ts') return code.replace(/from (['"])element-plus\1/g, 'from "/@test/buyer-invoice-dialog"'); },
  };
}
const renderer = createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }), insert(n,p) { n.parent=p; (p.children??=[]).push(n); }, remove(n) { if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n); }, parentNode:n=>n.parent,nextSibling:()=>null,patchProp(){},setText(){},setElementText(){} });
const flush = async () => { for(let i=0;i<35;i++){await Promise.resolve();await nextTick();} };
const gate = () => { let resolve; return { promise:new Promise(r=>{resolve=r;}),resolve }; };
export function registerBuyerInvoicesTests(context) {
  async function mount(override=()=>undefined, orderPage=false, path=orderPage?'/user/invoice/order?orderId=invoice_order_A':'/user/invoice') {
    const {server,api,response}=context(),calls=[],dialog=(await server.ssrLoadModule('/@test/buyer-invoice-dialog')).state;dialog.confirm=async()=>{};
    api.defaults.adapter=async c=>{calls.push(c); const custom=await override(c);if(custom)return response(c,custom);
      if(c.method!=='get'){const action=c.url.includes('make_up')?'apply':c.url.includes('/del/')?'delete':c.url.includes('set_default')?'default':'save';return response(c,{status:200,data:{version:1,uid:11,action,id:action==='apply'?81:71}});}
      assert.equal(c.params.view,'buyer');const q={kind:c.url==='/invoice'?'titles':'records',cursor:c.params.cursor??null,limit:c.params.limit??20};
      return response(c,{status:200,data:c.url.includes('invoice_detail')?fixture.order({orderNo:c.url.split('/').at(-1)}):fixture.page(q)});
    };
    let view;const component=(await server.ssrLoadModule(prefix+(orderPage?'InvoiceOrder':'InvoiceList')+'.lifecycle-test.ts')).default;
    const router=createRouter({history:createMemoryHistory(),routes:[{path:orderPage?'/user/invoice/order':'/user/invoice',component:{setup(p,c){view=component.setup(p,c).flow;return()=>null;}}},{path:'/away',component:{render:()=>null}},{path:orderPage?'/user/invoice':'/user/invoice/order',component:{render:()=>null}}]});
    const app=renderer.createApp({render:()=>h(RouterView)});app.use(router);await router.push(path);app.mount({children:[]});await flush();let closed=false;
    return {get view(){return view;},calls,dialog,router,close(){if(!closed){app.unmount();closed=true;}}};
  }
  it('PC actual invoice hub switches records/titles and submits required personal fields through the audited API',async()=>{const f=await mount();try{
    assert.equal(f.view.records[0].orderNo,'invoice_order_A');await f.view.selectKind('titles');f.view.edit(f.view.titles[0]);assert.equal(f.view.state.draft.drawerPhone,'13800000000');await f.view.save();
    const post=f.calls.find(c=>c.method==='post');assert.equal(post.url,'/invoice/save?view=buyer');assert.equal(JSON.parse(post.data).revision,fixture.revision);assert.equal(f.view.state.draft,null);assert.equal(f.view.state.message,'抬头已保存');
  }finally{f.close();}});
  it('PC existing order application binds exact public number, PK and both revisions',async()=>{const f=await mount(()=>undefined,true);try{await f.view.apply(f.view.titles[0]);const post=f.calls.find(c=>c.method==='post');assert.equal(post.url,'/order/make_up_invoice?view=buyer');assert.deepEqual(JSON.parse(post.data),{orderId:91,orderNo:'invoice_order_A',revision:fixture.revision,titleId:71,titleRevision:fixture.revision});}finally{f.close();}});
  for(const ending of ['identity','route','unmount'])it('PC invoice late response cannot retain private data after '+ending,async()=>{const wait=gate(),f=await mount(c=>c.method==='get'?wait.promise:undefined,true);try{
    if(ending==='identity')context().authUtils.setAuth('different',22);else if(ending==='route')await f.router.push('/away');else f.close();wait.resolve({status:200,data:fixture.order()});await flush();assert.equal(f.view.state.order,null);assert.equal(f.view.state.page,null);assert.equal(f.view.state.draft,null);
  }finally{wait.resolve({status:400});f.close();}});
  it('PC delayed delete dialog cannot mutate a replacement page generation',async()=>{const f=await mount();const wait=gate();try{await f.view.selectKind('titles');f.dialog.confirm=()=>wait.promise;const old=f.view.titles[0],pending=f.view.remove(old);await f.view.load();wait.resolve();await pending;assert.equal(f.calls.filter(c=>c.method==='delete').length,0);}finally{wait.resolve();f.close();}});
  it('PC unknown save result makes one POST followed by read-only reconciliation',async()=>{const f=await mount(c=>c.method==='post'?{status:400,msg:'owned unknown result'}:undefined);try{await f.view.selectKind('titles');f.view.edit(f.view.titles[0]);await f.view.save();assert.equal(f.calls.filter(c=>c.method==='post').length,1);assert.match(f.view.state.message,/重新读取当前资料/);assert.equal(f.view.state.draft,null);}finally{f.close();}});
  for(const raw of ['orderId=a&orderId=b','orderId=../bad','orderId=a&uid=22',''])it('PC rejects invoice route without request '+raw,async()=>{const f=await mount(()=>undefined,true,'/user/invoice/order?'+raw);try{assert.equal(f.calls.length,0);assert.ok(f.view.state.error);}finally{f.close();}});
  it('PC readback error and foreign data clear previously displayed invoice records',async()=>{let invalid=false;const f=await mount(()=>invalid?{status:200,data:fixture.page({kind:'records',cursor:null,limit:20},{uid:22})}:undefined);try{assert.equal(f.view.records.length,1);invalid=true;await f.view.load();assert.equal(f.view.records.length,0);assert.equal(f.view.state.page,null);assert.ok(f.view.state.error);}finally{f.close();}});
}
