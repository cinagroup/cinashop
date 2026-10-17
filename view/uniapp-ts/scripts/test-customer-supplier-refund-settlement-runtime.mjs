import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{runtime,tick,deferred,render}=require('./user-center-runtime.cjs');
const read=require('./customer-work-runtime.test.cjs'),vue=require('vue'),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const panelPath='components/customerWork/CustomerSupplierRefundSettlementPanel.vue';
const settlementRoute=call=>/\/financial\/orders\/[1-9]\d*\/supplier-refund-settlement$/.test(call.url);
const target=(id=1)=>({order_id:id,order_no:'ORDER_'+id,uid:21,supplier_id:7,store_id:0});
const summary=(id=1,stage=1)=>({version:'supplier-refund-settlement-v1',state:'verified',...target(id),refund_id:id,refund_no:'REFUND_'+id,pay_type:'offline',paid:'18.75',goods_refunded:'7.00',money_refunded:['0.00','5.00','11.75'][stage],refunded:['7.00','12.00','18.75'][stage],available:['11.75','6.75','0.00'][stage],money_payouts:stage});
function make({page='orderDetail',answer,stage=1}={}){
 const model={stage,role:true};
 function send(call){
  if(settlementRoute(call))return answer?answer(call,model):{data:read.financialEnvelope(summary(Number(call.url.split('/').at(-2)),model.stage))};
  if(call.url.endsWith('/context')&&!model.role)return{httpStatus:403,status:403,msg:'真实读取资格已撤回'};
  const route=new URL(call.url,'http://localhost').pathname;
  const id=Number(route.match(/(?:orders\/ORDER_|refunds\/REFUND_|financial\/(?:orders|refunds)\/)(\d+)/)?.[1]??1);
  if(route.includes('/financial/orders/'))return{data:read.financialEnvelope({...read.financialOrder(id,false),...target(id),pay_type:'offline',refund_settlement:'cash',pay_price:'18.75',refunded_price:summary(id,model.stage).refunded})};
  if(route.includes('/financial/refunds/'))return{data:read.financialEnvelope({...read.financialReview(id,false),...target(id),pay_type:'offline',refund_settlement:'cash',refund_price:'7.00',refunded_price:'7.00',refund_type:6})};
  if(route.endsWith('/fulfillment'))return{httpStatus:503,status:503,msg:'本夹具没有发货目标'};
  const result=read.fixture(call),data=result.data?.data;
  if(route.endsWith('/remark'))Object.assign(data.remark_target,{id,order_id:'ORDER_'+id});
  else if(/\/orders\/ORDER_\d+$/.test(route))Object.assign(data,{id,order_id:'ORDER_'+id,uid:21,supplier_id:7,store_id:0,pay_type:'offline',paid:1,pay_price:'18.75'});
  else if(/\/refunds\/REFUND_\d+$/.test(route))Object.assign(data,{id,order_id:'REFUND_'+id,store_order_id:id,store_order_sn:'ORDER_'+id,refund_price:'7.00',refunded_price:'7.00',refund_type:6});
  return result;
 }
 const r=runtime({component:'pages/customer-work/'+page+'.vue',send});
 return{r,model,start:()=>r.start(page==='orderDetail'?{orderId:'ORDER_1'}:{refundOrderId:'REFUND_1'})};
}
async function panel(r,disabled=false){
 await render(r,panelPath);
 const component=r.load(path.join(root,'src',panelPath)).default;
 const app=vue.createSSRApp(component,{operations:r.page.settlement,target:r.page.settlementTarget.value,disabled});
 return require('@vue/server-renderer').renderToString(app);
}
for(const page of ['orderDetail','refundDetail'])test(page+': explicit read displays 7 → 12 → 18.75 without changing the original application or enabling writes',async()=>{
 const {r,model,start}=make({page,stage:0});
 try{
  await start();assert.equal(r.page.manager.error.value,'');assert.ok(r.page.settlementTarget.value);
  assert.equal(r.calls.some(settlementRoute),false);assert.match(await panel(r),/尚未核验累计退款/);
  const pending=JSON.stringify(r.page.financial.pending.value);
  for(let stage=0;stage<3;stage++){
   model.stage=stage;await r.page.settlement.load(r.page.settlementTarget.value);
   assert.deepEqual(JSON.parse(JSON.stringify(r.page.settlement.summary.value)),summary(1,stage));
   const html=await panel(r);for(const label of ['订单实付','首笔商品退款','后续补退款','累计已退','剩余可退金额','补退次数'])assert.ok(html.includes(label));
   assert.ok(html.includes('¥'+summary(1,stage).refunded));assert.ok(html.includes('¥'+summary(1,stage).available));
   assert.equal(JSON.stringify(r.page.financial.pending.value),pending);
   assert.equal((r.page.financial.order.value??r.page.financial.review.value).data.readiness.writes,false);
   if(page==='refundDetail'){assert.equal(r.page.refund.value.refund_price,'7.00');assert.equal(r.page.refund.value.refunded_price,'7.00');}
  }
  const calls=r.calls.filter(settlementRoute);assert.equal(calls.length,3);
  for(const call of calls){assert.equal(call.method,'GET');assert.equal(call.header['Authori-zation'],'Bearer synthetic-local-token');assert.equal(call.header['Idempotency-Key'],undefined);assert.deepEqual(call.data,{order_no:'ORDER_1',scope_key:'a'.repeat(64)});}
  assert.equal(r.calls.some(c=>c.method!=='GET'),false);
 }finally{r.stop();}
});
test('the request allowlist admits only canonical bounded GET settlement targets',async()=>{
 const {r}=make();try{
  const api=r.load(path.join(root,'src/api/customerWorkFinancial.ts'));
  for(const id of ['1','2147483647'])assert.equal(api.customerFinancialRequestEndpoint('/mobile/work/financial/orders/'+id+'/supplier-refund-settlement','GET'),true);
  for(const path of ['/mobile/work/financial/orders/0/supplier-refund-settlement','/mobile/work/financial/orders/01/supplier-refund-settlement','/mobile/work/financial/orders/2147483648/supplier-refund-settlement','/mobile/work/financial/orders/1/supplier-refund-settlement/','/mobile/work/financial/orders/1/supplier-refund-settlement?order_no=OTHER','/mobile/work/financial/refunds/1/supplier-refund-settlement','/mobile/work/financial/orders/%31/supplier-refund-settlement'])assert.equal(api.customerFinancialRequestEndpoint(path,'GET'),false,path);
  const request=api.createCustomerFinancialRequests(()=>true);
  await assert.rejects(request.request('/mobile/work/financial/orders/1/supplier-refund-settlement','POST',{},'11111111-1111-4111-8111-111111111111'),/地址/);
  assert.equal(r.calls.length,0);request.abort();
 }finally{r.stop();}
});
for(const code of [409,503])test('HTTP '+code+' clears prior summary and keeps the original detail, with an explicit unverified state',async()=>{
 let failed=false;const {r,start}=make({page:'refundDetail',answer:()=>failed?{httpStatus:code,status:code,msg:'凭据或读取配置尚未完整就绪'}:{data:read.financialEnvelope(summary())}});
 try{
  await start();await r.page.settlement.load(r.page.settlementTarget.value);assert.ok(r.page.settlement.summary.value);
  failed=true;await r.page.settlement.load(r.page.settlementTarget.value);
  assert.equal(r.page.settlement.summary.value,null);assert.equal(r.page.settlement.busy.value,false);assert.equal(r.page.refund.value.refund_price,'7.00');assert.ok(r.page.manager.context.value);
  const html=await panel(r);assert.match(html,/尚未完整核验/);assert.equal(html.includes('¥0.00'),false);assert.equal(html.includes('已核验本次快照'),false);
  failed=false;await r.page.settlement.load(r.page.settlementTarget.value);assert.equal(r.page.settlement.summary.value.refunded,'12.00');assert.equal(r.page.settlement.error.value,'');
 }finally{r.stop();}
});
for(const field of ['actor','service','scope','consistency','order_id','order_no','uid','supplier_id','store_id','refund_id','refund_no','goods_refunded','pay_type','extra'])test('mismatched '+field+' erases current authority and never publishes an apparently verified summary',async()=>{
 const {r,start}=make({page:'refundDetail',answer:()=>{
  const value=read.financialEnvelope(summary());
  if(field==='actor')value.actor_uid=12;else if(field==='service')value.principal.service_id=2;else if(field==='scope')value.scope_key='c'.repeat(64);else if(field==='consistency')value.consistency_key='d'.repeat(64);else if(field==='pay_type')value.data.pay_type='yue';else if(field==='extra')value.data.operation_id='11111111-1111-4111-8111-111111111111';else value.data[field]=typeof value.data[field]==='number'?value.data[field]+1:field==='goods_refunded'?'8.00':'OTHER';
  return{data:value};
 }});
 try{await start();await r.page.settlement.load(r.page.settlementTarget.value);assert.equal(r.page.settlement.summary.value,null);assert.equal(r.page.manager.context.value,null);assert.equal(r.page.refund.value,null);assert.match(r.page.manager.error.value,/不匹配/);assert.equal(r.calls.some(c=>c.method!=='GET'),false);}finally{r.stop();}
});
test('actual403 invalidates current Customer scope and all domain/refund data',async()=>{
 const {r,start}=make({page:'refundDetail',answer:()=>({httpStatus:403,status:403,msg:'读取权限已撤回'})});
 try{await start();await r.page.settlement.load(r.page.settlementTarget.value);assert.equal(r.page.manager.context.value,null);assert.equal(r.page.financial.review.value,null);assert.equal(r.page.refund.value,null);assert.equal(r.page.settlement.summary.value,null);assert.match(r.page.manager.error.value,/权限已变化/);}finally{r.stop();}
});
for(const late of ['success','403'])test('A → B → A fences late '+late+' even when uid and token remain identical',async()=>{
 const hold=deferred();let first=true;
 const {r,start}=make({page:'refundDetail',answer:call=>{if(first){first=false;return hold.promise;}return{data:read.financialEnvelope(summary(Number(call.url.split('/').at(-2)),2))};}});
 try{
  await start();const version=r.auth.sessionVersion,old=r.page.settlement.load(r.page.settlementTarget.value);await tick();
  r.hooks.onLoad({refundOrderId:'REFUND_2'});await r.page.manager.load();assert.equal(r.page.refund.value.order_id,'REFUND_2');assert.equal(r.page.settlement.summary.value,null);
  await r.page.settlement.load(r.page.settlementTarget.value);assert.equal(r.page.settlement.summary.value.order_id,2);
  r.hooks.onLoad({refundOrderId:'REFUND_1'});await r.page.manager.load();await r.page.settlement.load(r.page.settlementTarget.value);
  hold.resolve(late==='403'?{httpStatus:403,status:403,msg:'旧资格撤销'}:{data:read.financialEnvelope(summary(1,0))});await old;await tick();
  assert.equal(r.auth.sessionVersion,version);assert.equal(r.page.manager.error.value,'');assert.equal(r.page.refund.value.order_id,'REFUND_1');assert.equal(r.page.settlement.summary.value.refunded,'18.75');assert.equal(r.page.settlement.error.value,'');assert.ok(r.aborts.length);
 }finally{r.stop();}
});
for(const event of ['hide','unload','same-login'])test(event+' clears summary and prevents a late success from repopulating it',async()=>{
 const hold=deferred();const {r,start}=make({answer:()=>hold.promise});
 try{
  await start();const old=r.page.settlement.load(r.page.settlementTarget.value);await tick();assert.equal(r.page.settlement.busy.value,true);
  if(event==='same-login')r.auth.setLogin('synthetic-local-token',11);else r.hooks[event==='hide'?'onHide':'onUnload']();
  hold.resolve({data:read.financialEnvelope(summary())});await old;await tick();assert.equal(r.page.settlement.summary.value,null);assert.equal(r.page.settlement.busy.value,false);assert.equal(r.page.settlement.error.value,'');assert.ok(r.aborts.length);
 }finally{r.stop();}
});
