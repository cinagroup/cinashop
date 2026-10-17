/** Real App/JWT and independent PostgreSQL16 LOGIN. Checkout, collection,
 * balance debit, paid consumption and all refunds use the actual services. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {withTx,createDbFromConnectionString,createContainerFromDb} from '@/lib/di';
import {storeCart,storeOrder,storeOrderInvoice,storeOrderRefund,systemRole,user,userBill,capitalFlow,supplierTransactions} from '@/models/schema';
import {createToken} from '@/utils/jwt';
import {StoreOrderPayService} from '@/services/order/StoreOrderPayService';
import {StoreOrderCreateService} from '@/services/order/StoreOrderCreateService';
import {SupplierProactiveRefundService} from '@/services/supplier/SupplierProactiveRefundService';
import {readSupplierProactiveRefundSource} from '@/services/supplier/SupplierProactiveRefundSource';
import {parseSupplierProactiveRefundIntent,supplierProactiveRefundJson} from '@/services/supplier/SupplierProactiveRefundInput';
import {appendSupplierProactiveRefundOperation} from '@/services/supplier/SupplierProactiveRefundOperation';
import {requiredSupplierPermissions} from '@/services/supplier/SupplierPermissionService';
import {installSupplierProactiveRefund} from '@/migrations/supplierProactiveRefund';
import {runtimeBusinessPrivilegePlan} from '@/migrations/runtimeBusinessPrivilegePlan';
import {readSupplierProactiveMoneyEvidence,projectSupplierProactiveMoneyBaseline} from '@/services/supplier/SupplierProactiveMoneyEvidence';
import {verifyFinancialCompletedRefund} from '@/services/customer-work/CustomerWorkFinancialVerification';
import {readBoundManualRefundProof} from '@/services/supplier/SupplierManualRefundProof';
import {supplierProactiveRefundApplicationNumber} from '@/services/supplier/SupplierProactiveRefundIdentity';
import {makeSupplierProactiveMoneySource} from '@/services/supplier/SupplierProactiveMoneyEvidence';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {appendSupplierProactiveRefundDecision} from '@/services/supplier/SupplierProactiveRefundOperation';
import {supplierManualRefundFixture} from './helpers/supplierManualRefund';
import {supplierOrderEditActor,supplierOrderEditAppKey} from './helpers/supplierUnpaidOrderEdit';

const wiring=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:wiring.open}));
const app=createApp(),actor=()=>supplierOrderEditActor();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Supplier proactive order-ID coordination',()=>{
 let f:Awaited<ReturnType<typeof supplierManualRefundFixture>>;
 type Runtime=Parameters<Parameters<typeof f.withManualRuntime>[0]>[0];
 beforeEach(async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No external payment provider in owned proactive acceptance'));
  f=await supplierManualRefundFixture();wiring.open.mockImplementation(()=>f.container);
 },120000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{vi.restoreAllMocks();}},30000);
 async function paid(channel:'offline'|'yue'|'weixin'|'alipay'='offline',amount='18.75',freshCart=false) {
  const order=await (freshCart?f.withPaymentRuntime(async runtime=>{
   // Independent synthetic cart input; both orders still use real checkout,
   // offline selection, balance payment and paid-event consumption.
   const original=await f.db.select().from(storeCart).where(sql`${storeCart.id} IN (1,2)`).orderBy(storeCart.id);
   expect(original).toHaveLength(2);
   const carts=await f.db.insert(storeCart).values(original.map(row=>({...row,id:row.id+1000,isPay:0,status:1}))).returning({id:storeCart.id});
   const created=await StoreOrderCreateService.createWithRuntime(runtime.container,
    {CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'wx'+randomUUID().replaceAll('-','').slice(0,28)},
    {uid:11,key:randomUUID(),cartIds:carts.map(row=>row.id),addressId:11,userIp:'127.0.0.1',useIntegral:true,payType:'offline',from:'pc'});
   expect(await new StoreOrderPayService(runtime.container,f.paymentEnvironment).offlinePay(11,created.orderId,'pc')).toMatchObject({paid:false,pay_type:'offline'});
   const [actual]=await f.db.select().from(storeOrder).where(eq(storeOrder.orderId,created.orderId));
   if(!actual||actual.paid!==0||actual.supplierId!==7||actual.payType!=='offline')throw Error('Independent actual Supplier checkout absent');
   return actual;
  }):f.createOffline());
  await f.service.save(order.id,{...await f.body(order.id),pay_price:amount,gain_integral:'17'},actor());
  if(channel==='offline')await f.withPaymentRuntime(async(_runtime,payment)=>payment.pay(order.id,await f.paymentBody(order.id,payment),actor()));
  else await f.withPaidConsumer(async runtime=>{
   const pay=new StoreOrderPayService(runtime.container,f.paymentEnvironment);
   if(channel==='yue')expect(await pay.yuePay(11,order.orderId)).toEqual({paid:true});
   else expect(await pay.applyPayment({orderId:order.id,payType:channel,tradeNo:'owned-proactive-trade-'+order.id})).toMatchObject({outcome:'paid'});
  });
  await f.consumePaid(order.id);return order.id;
 }
 async function commissioned<T>(work:(runtime:Runtime,service:SupplierProactiveRefundService)=>Promise<T>) {
  return f.withManualRuntime(async runtime=>{
   await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:runtime.role}));
   await f.db.update(systemRole).set({rules:'supplier.order.manage'}).where(eq(systemRole.id,21));
   // This scenario composes the EXISTING app capital-flow append grants on a
   // fresh LOGIN; no frozen financial role profile or production ACL changes.
   const grants=runtimeBusinessPrivilegePlan('app').tables.capital_flow;
   for(const privilege of ['SELECT','INSERT'])expect(grants).toContain(privilege);
   await f.exec(`GRANT SELECT,INSERT ON public.capital_flow TO "${runtime.role}";GRANT USAGE ON SEQUENCE public.capital_flow_id_seq TO "${runtime.role}"`);
   wiring.open.mockImplementation(()=>runtime.container);
   return work(runtime,new SupplierProactiveRefundService(runtime.container,supplierOrderEditAppKey,f.paymentEnvironment));
  });
 }
 async function request(service:SupplierProactiveRefundService,id:number,amount='7.00') {
  const seed=await service.seed(id,actor());return{operation_id:randomUUID(),revision:seed.revision,refund_price:amount,
   ...(seed.settlement==='cash'&&amount!=='0.00'?{cash_returned:true as const}:{})};
 }
 const snapshot=async()=>({...await f.manualSnapshot(),flows:await f.db.select().from(capitalFlow).orderBy(capitalFlow.id),
  invoices:await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
  proactive:await f.exec('SELECT * FROM public.supplier_proactive_refund_operation_v1 ORDER BY operation_id'),
  decisions:await f.exec('SELECT * FROM public.supplier_proactive_refund_decision_v1 ORDER BY operation_id'),
  money_completions:await f.exec('SELECT * FROM public.supplier_refund_money_completion_v1 ORDER BY operation_id'),
  money_payments:await f.exec('SELECT * FROM public.supplier_refund_money_payment_v1 ORDER BY operation_id')});
 function onlyMoneyChanged(before:Awaited<ReturnType<typeof snapshot>>,after:Awaited<ReturnType<typeof snapshot>>) {
  const allowed=new Set(['store_order','store_order_status','user','user_bill','supplier_transactions','proactive','decisions','flows','money_completions']);
  for(const [table,rows] of Object.entries(before)) {
   if(allowed.has(table))continue;
   if(table==='consumer_tables') {
    const actual=after.consumer_tables;
    for(const [name,values]of Object.entries(rows as Record<string,unknown>))if(!allowed.has(name))expect(actual[name]).toEqual(values);
   } else expect((after as Record<string,unknown>)[table]).toEqual(rows);
  }
 }
 async function http(method:string,path:string,body?:unknown,actorId=21,raw?:string) {
  const a=supplierOrderEditActor(actorId),token=(await createToken(actorId,'supplier',a.authVersion,supplierOrderEditAppKey)).token;
  const response=await app.request('/supplierapi'+path,{method,headers:{Authorization:'Bearer '+token,'X-Supplier-Id':'8','Content-Type':'application/json'},
   ...(raw!==undefined?{body:raw}:body===undefined?{}:{body:JSON.stringify(body)})},f.paymentEnvironment);
  return{response,body:await response.json<{status:number;msg:string;data:unknown}>()};
 }

 it.each(['offline','yue'] as const)('executes real %s whole-goods7.00 through JWT and recovers one result without duplicate effects',async channel=>{
  const id=await paid(channel);await commissioned(async(runtime,service)=>{
   const account=(await f.db.select().from(user).where(eq(user.uid,11)))[0],before=await snapshot();
   const seed=await http('GET',`/order/refund/${id}`);
   expect(seed.body).toMatchObject({status:200,data:{order_id:id,refund_price:'18.75',quantity:3,kind:'goods'}});
   expect(seed.response.headers.get('cache-control')).toContain('private, no-store');expect(await snapshot()).toEqual(before);
   const body=await request(service,id),done=await http('PUT',`/order/refund/${id}`,body);
   expect(done.body).toMatchObject({status:200,data:{state:'committed',order_id:id,result:{order_id:id,amount:'7.00',kind:'goods',status:channel==='offline'?'CASH_SUCCESS':'BALANCE_SUCCESS'}}});
   expect(await runtime.order(id)).toMatchObject({payPrice:'18.75',refundPrice:'7.00',refundStatus:2,refundType:6});
   const refunds=await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id));
   expect(refunds).toHaveLength(1);expect(refunds[0]).toMatchObject({refundType:6,refundNum:3,refundPrice:'7.00',refundedPrice:'7.00'});
   expect(await runtime.receipt(refunds[0].id)).toMatchObject({disposition:'whole',sourceOrderId:id,selectedOrderId:id,remainingOrderId:null});
   const after=(await f.db.select().from(user).where(eq(user.uid,11)))[0];
   expect(BigInt(after.nowMoney.replace('.',''))-BigInt(account.nowMoney.replace('.',''))).toBe(channel==='yue'?700n:0n);
   const flows=await f.db.select().from(capitalFlow);
   if(channel==='offline')expect(flows).toMatchObject([{price:'-7.00',tradingType:2,payType:'offline',orderId:(await runtime.order(id)).orderId}]);
   else expect(flows).toEqual([]);
   const stable=await snapshot();
   expect((await http('PUT',`/order/refund/${id}`,body)).body).toEqual(done.body);
   expect((await http('GET',`/order/refund_operations/${body.operation_id}`)).body).toMatchObject({status:200,data:done.body.data});
   expect(await service.resolve(body.operation_id,id,actor())).toEqual(done.body.data);
   expect(await snapshot()).toEqual(stable);
  });
 },120000);
 it('settles the actual zero-priced checkout with cash confirmation omitted and no balance or platform cash movement',async()=>{
  const id=await paid('offline','0.00');await commissioned(async(runtime,service)=>{
   const before=(await f.db.select().from(user).where(eq(user.uid,11)))[0],body=await request(service,id,'0.00'),original=await runtime.order(id);
   expect(original).toMatchObject({useIntegral:'100.00',backIntegral:'0.00'});
   expect(Object.hasOwn(body,'cash_returned')).toBe(false);
   const done=await service.execute(id,body,actor());expect(done).toMatchObject({state:'committed',result:{amount:'0.00',status:'ZERO_SUCCESS'}});
   expect(await runtime.order(id)).toMatchObject({payPrice:'0.00',refundPrice:'0.00',refundStatus:2,backIntegral:'100.00'});
   const after=(await f.db.select().from(user).where(eq(user.uid,11)))[0];
   expect(after.nowMoney).toBe(before.nowMoney);expect(after.integral).toBe(before.integral+100);
   const bills=(await f.db.select().from(userBill)).filter(row=>row.type==='pay_product_integral_back');
   expect(bills).toMatchObject([{uid:11,number:'100.00',category:'integral',pm:1,status:1}]);
   expect(await f.db.select().from(capitalFlow)).toEqual([]);
   const stable=await snapshot();expect(await service.execute(id,body,actor())).toEqual(done);expect(await snapshot()).toEqual(stable);
  });
 },120000);
 it.each(['offline','yue','weixin','alipay'] as const)('persists a genuine %s type2 refusal without creating a refund, ledger, stock, point or supplier-settlement effect',async channel=>{
  const id=await paid(channel);await commissioned(async(runtime,service)=>{
   const {cash_returned:_cash,...body}=await request(service,id),before=await snapshot(),original=await runtime.order(id),
    beforeOrders=await f.db.select().from(storeOrder).orderBy(storeOrder.id);
   const result=await service.execute(id,{...body,type:2},actor());
   expect(result).toMatchObject({state:'committed',result:{refund_id:null,kind:'refuse',status:'REFUSED',amount:'7.00'}});
   const after=await snapshot();expect(await runtime.order(id)).toMatchObject({refundStatus:0,refundType:3,refundPrice:'0.00'});
   // Only the order state, operation and decision change.
   expect(await runtime.order(id)).toEqual({...original,refundStatus:0,refundType:3});
   expect(await f.db.select().from(storeOrder).orderBy(storeOrder.id)).toEqual(beforeOrders.map(row=>row.id===id?{...row,refundStatus:0,refundType:3}:row));
   expect({...after,store_order:[],proactive:[],decisions:[]}).toEqual({...before,store_order:[],proactive:[],decisions:[]});
   const stable=await snapshot();expect(await service.execute(id,{...body,type:2},actor())).toEqual(result);expect(await snapshot()).toEqual(stable);
   if(channel==='offline'||channel==='yue')expect(await service.execute(id,await request(service,id),actor())).toMatchObject({state:'committed',result:{kind:'goods'}});
   else{const stable=await snapshot();await expect(service.execute(id,await request(service,id),actor())).rejects.toMatchObject({httpStatus:503});expect(await snapshot()).toEqual(stable);}
  });
 },120000);
 it('preserves the complete original18.75 unissued invoice while executing the public7.00 goods concession',async()=>{
  const id=await paid();const [invoice]=await f.db.insert(storeOrderInvoice).values({orderId:id,uid:11,category:'order',isPay:1,isRefund:0,isInvoice:0,
   invoiceAmount:'18.75',name:'实际原票',remark:'全额原票保留',addTime:Math.floor(Date.now()/1000)}).returning();
  await commissioned(async(runtime,service)=>{
   const done=await service.execute(id,await request(service,id),actor());
   expect(await f.db.select().from(storeOrderInvoice)).toEqual([{...invoice,isRefund:1}]);
   const record=await runtime.receipt(done.result!.refund_id!);
   expect(JSON.parse(record!.invoiceAllocation)).toMatchObject({version:'refund-invoice-allocation-supplier-whole-v3',first_refunded:'7.00',unreturned_payment:'11.75',original:invoice});
  });
 },120000);
 it('rejects missing cash confirmation, bad money, unknown fields and decoded duplicate JSON with no SQL effects',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   const body=await request(service,id),before=await snapshot(),{cash_returned:_cash,...without}=body;
   const changes=[without,{...body,cash_returned:false},{...body,refund_price:'18.76'},{...body,refund_price:'0.00'},
    {...body,refund_price:'7.001'},{...body,supplier_id:8},{...body,type:2}];
   for(const change of changes)expect((await http('PUT',`/order/refund/${id}`,change)).body.status).not.toBe(200);
   const raw=JSON.stringify(body).replace('"refund_price":','"refund_price":"1.00","refund_\\u0070rice":');
   expect((await http('PUT',`/order/refund/${id}`,undefined,21,raw)).body.status).not.toBe(200);
   expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('binds the signed revision to the full actual order and rejects changed source before creating a goods claim',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   const body=await request(service,id);await f.db.update(storeOrder).set({remark:'真实来源已修改'}).where(eq(storeOrder.id,id));
   const before=await snapshot();await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('enforces tenant, view and manage JWT boundaries and keeps denied responses private',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   const body=await request(service,id),before=await snapshot();
   for(const actorId of [22,23,31,39]) {
    const denied=await http('PUT',`/order/refund/${id}`,body,actorId);
    expect(denied.body.status).not.toBe(200);expect(denied.response.headers.get('cache-control')).toContain('private, no-store');
   }
   expect((await http('GET',`/order/refund/${id}`,undefined,22)).body.status).toBe(200);
   expect((await http('GET',`/order/refund/${id}`,undefined,31)).body.status).not.toBe(200);
   expect((await http('GET',`/order/refund/${id}?supplier_id=8`)).body.status).not.toBe(200);expect(await snapshot()).toEqual(before);
   expect(requiredSupplierPermissions('PUT',`order/refund/${id}`)).toEqual(['supplier.order.manage']);
   for(const method of ['POST','DELETE'])expect(requiredSupplierPermissions(method,`order/refund/${id}`)).toBeNull();
   expect(requiredSupplierPermissions('GET','order/refund_operations/not-uuid')).toBeNull();
  });
 },120000);
 it('recovers a committed UUID after manage withdrawal and seals an absent UUID without replaying or granting authority',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   const body=await request(service,id),done=await service.execute(id,body,actor());
   await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
   const before=await snapshot();expect((await http('GET',`/order/refund_operations/${body.operation_id}`)).body).toMatchObject({status:200,data:done});
   expect(await service.execute(id,body,actor())).toEqual(done);expect(await snapshot()).toEqual(before);
   const absent=randomUUID();expect(await service.receipt(absent,actor())).toMatchObject({state:'unknown',order_id:null});expect(await snapshot()).toEqual(before);
   expect(await service.resolve(absent,id,actor())).toMatchObject({state:'not_applied',order_id:id});
   await expect(service.execute(id,{...body,operation_id:absent},actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.execute(id,{...body,operation_id:randomUUID()},actor())).rejects.toThrow('权限');
   expect(await service.receipt(body.operation_id,supplierOrderEditActor(22))).toMatchObject({state:'unknown'});
  });
 },120000);
 it('serializes independent original requests and never creates two whole-goods claims or cash flows',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   const second=createDbFromConnectionString(_runtime.connectionString,1,{searchPath:'public,pg_temp',applicationName:'supplier-proactive-peer'});
   try{
    const [primary]=await _runtime.db.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`),[peer]=await second.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);
    expect(primary.pid).not.toBe(peer.pid);
    const body=await request(service,id),before=await snapshot();
    // A physically separate session holds the original UUID. NOWAIT admission
    // must fail before a business write, rather than wait on a max1 pool.
    await withTx(createContainerFromDb(second),async tx=>{
     await tx.execute(sql`SELECT pg_advisory_xact_lock(731628,hashtext(${'supplier-proactive-refund:'+body.operation_id}))`);
     await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);
    });
    const competing=new SupplierProactiveRefundService(createContainerFromDb(second),supplierOrderEditAppKey,f.paymentEnvironment),other={...body,operation_id:randomUUID()};
    const results=await Promise.allSettled([service.execute(id,body,actor()),competing.execute(id,other,actor())]);
    const successes=results.filter(r=>r.status==='fulfilled');expect(successes).toHaveLength(1);
    for(const outcome of results)if(outcome.status==='rejected')expect(outcome.reason).toMatchObject({httpStatus:409});
    const done=successes[0].status==='fulfilled'?successes[0].value:null;expect(done?.state).toBe('committed');
    const original=done?.operation_id===body.operation_id?body:other;
    expect(await service.execute(id,original,actor())).toEqual(done);
    expect(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id))).toHaveLength(1);
    expect(await f.db.select().from(capitalFlow)).toHaveLength(1);
    const stable=await snapshot();await expect(service.execute(id,{...body,operation_id:randomUUID()},actor())).rejects.toThrow();expect(await snapshot()).toEqual(stable);
   }finally{await second.$client.end({timeout:5});}
  });
 },120000);
 it.each(['weixin','alipay'] as const)('rejects new %s payout admission before business DML while its durable callback path is unavailable',async channel=>{
  const id=await paid(channel);await commissioned(async(_runtime,service)=>{
   const body=await request(service,id),before=await snapshot();await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:503});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('rolls back real stock, points, refund and immutable operation when platform flow insertion loses its reviewed privilege',async()=>{
  const id=await paid();await commissioned(async(runtime,service)=>{
   const body=await request(service,id);await f.exec(`REVOKE INSERT ON public.capital_flow FROM "${runtime.role}"`);
   const before=await snapshot();await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:503});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('rejects an actual late cash-flow amount rewrite and rolls every goods, financial and immutable write back',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   await f.exec(`CREATE FUNCTION public.owned_proactive_flow_wrong() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.price:=-6.99; RETURN NEW; END $$;
    CREATE TRIGGER owned_proactive_flow_wrong BEFORE INSERT ON public.capital_flow FOR EACH ROW EXECUTE FUNCTION public.owned_proactive_flow_wrong()`);
   try{const before=await snapshot();await expect(service.execute(id,await request(service,id),actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);}
   finally{await f.exec('DROP TRIGGER owned_proactive_flow_wrong ON public.capital_flow;DROP FUNCTION public.owned_proactive_flow_wrong()');}
  });
 },120000);
 it('keeps raw complete PHP purchase facts unchanged while the real coordinator settles the full goods and only the requested cash',async()=>{
  const id=await f.paidPhp();await commissioned(async(runtime,service)=>{
   const before=await runtime.carts(id),done=await service.execute(id,await request(service,id),actor());
   expect(done).toMatchObject({state:'committed',result:{kind:'goods',amount:'7.00',status:'CASH_SUCCESS'}});
   expect((await runtime.carts(id)).map(row=>row.cartInfo)).toEqual(before.map(row=>row.cartInfo));
   expect((await f.db.select().from(userBill)).filter(row=>row.type==='pay_product_refund')).toEqual([]);
  });
 },120000);
 it('refuses to publish a committed result when only the original operation exists and its durable decision is absent',async()=>{
  const id=await paid();await commissioned(async(runtime,service)=>{
   const {cash_returned:_cash,...body}=await request(service,id),parsed=await parseSupplierProactiveRefundIntent(id,{...body,type:2},actor());
   await withTx(runtime.container,async tx=>{
    const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id)),source=await readSupplierProactiveRefundSource(tx,order);
    await appendSupplierProactiveRefundOperation(tx,{operationId:body.operation_id,orderId:id,actor:actor(),now:Math.floor(Date.now()/1000),
     intent:parsed.intent,requestHash:parsed.hash,source,result:{order_id:id,refund_id:null,amount:'7.00',kind:'refuse',status:'REFUSED'}});
   });
   const before=await snapshot();await expect(service.receipt(body.operation_id,actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.execute(id,{...body,type:2},actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.resolve(body.operation_id,id,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it.each(['offline','yue'] as const)('preserves completed %s goods and money across a public post-goods refusal and subsequent payouts',async channel=>{
  const id=await paid(channel);await commissioned(async(runtime,service)=>{
   const first=await service.execute(id,await request(service,id),actor());
   const seed=await service.seed(id,actor()),body={operation_id:randomUUID(),revision:seed.revision,refund_price:'5.00',type:2};
   const before=await snapshot(),done=await http('PUT',`/order/refund/${id}`,body);
   expect(done.body).toMatchObject({status:200,data:{state:'committed',result:{kind:'refuse',refund_id:null,amount:'5.00',status:'REFUSED'}}});
   const after=await snapshot(),expected=structuredClone(before) as typeof before&Record<string,unknown>;
   expected.store_order=(expected.store_order as Array<{row:Record<string,unknown>}>).map(entry=>({row:entry.row.id===id
    ?{...entry.row,refund_status:0,refund_type:3}:entry.row}));
   expected.proactive=after.proactive;expected.decisions=after.decisions;expect(after).toEqual(expected);
   expect(await runtime.order(id)).toMatchObject({refundPrice:'7.00',refundStatus:0,refundType:3});
   expect(await service.seed(id,actor())).toMatchObject({kind:'money',refunded:'7.00',refund_price:'11.75',quantity:0});
   expect((await http('PUT',`/order/refund/${id}`,body)).body).toEqual(done.body);
   expect(await service.receipt(body.operation_id,actor())).toEqual(done.body.data);expect(await snapshot()).toEqual(after);
   await service.execute(id,await request(service,id,'5.00'),actor());
   expect(await runtime.order(id)).toMatchObject({refundPrice:'12.00',refundStatus:2,refundType:6});
   const next=await service.seed(id,actor());
   expect(await service.execute(id,{operation_id:randomUUID(),revision:next.revision,refund_price:'3.00',type:2},actor()))
    .toMatchObject({result:{kind:'refuse',status:'REFUSED'}});
   const tail=await service.execute(id,await request(service,id,'6.75'),actor());expect(tail.result).toMatchObject({kind:'money',amount:'6.75'});
   expect(await runtime.order(id)).toMatchObject({refundPrice:'18.75',refundStatus:2,refundType:6});
   expect(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id)))
    .toMatchObject([{id:first.result!.refund_id,refundPrice:'7.00',refundedPrice:'7.00',refundType:6,refundNum:3}]);
   const final=await snapshot();onlyMoneyChanged(before,final);
   expect(await service.receipt(body.operation_id,actor())).toEqual(done.body.data);
   await expect(service.seed(id,actor())).rejects.toMatchObject({code:400});expect(await snapshot()).toEqual(final);
  });
 },120000);
 it('allows the genuine completed-refund remark route after refusal without freezing description into its financial basis',async()=>{
  const id=await paid('yue');await commissioned(async(runtime,service)=>{
   const first=await service.execute(id,await request(service,id),actor()),seed=await service.seed(id,actor());
   await service.execute(id,{operation_id:randomUUID(),revision:seed.revision,refund_price:'5.00',type:2},actor());
   await f.db.update(systemRole).set({rules:'supplier.order.manage,supplier.refund.manage'}).where(eq(systemRole.id,21));
   expect((await http('PUT','/refund/remark/'+first.result!.refund_id,{remark:'已与买家核对，继续补退余款'})).body.status).toBe(200);
   expect(await service.seed(id,actor())).toMatchObject({refunded:'7.00',refund_price:'11.75'});
   const money=await service.execute(id,await request(service,id,'5.00'),actor());
   expect((await http('PUT','/refund/remark/'+first.result!.refund_id,{remark:'第二次核对说明'})).body.status).toBe(200);
   expect(await service.receipt(money.operation_id,actor())).toEqual(money);
   await service.execute(id,await request(service,id,'6.75'),actor());
   expect(await runtime.order(id)).toMatchObject({refundPrice:'18.75',refundType:6,refundStatus:2});
   expect(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id)))
    .toMatchObject([{id:first.result!.refund_id,remark:'第二次核对说明',refundPrice:'7.00',refundedPrice:'7.00',refundNum:3}]);
  });
 },120000);
 it('binds repeated refusals to the same real basis and preserves original recovery after live manage withdrawal',async()=>{
  const id=await paid();await commissioned(async(runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const stale=await request(service,id,'5.00');
   const firstSeed=await service.seed(id,actor()),firstBody={operation_id:randomUUID(),revision:firstSeed.revision,refund_price:'5.00',type:2};
   const first=await service.execute(id,firstBody,actor()),nextSeed=await service.seed(id,actor());
   const second=await service.execute(id,{operation_id:randomUUID(),revision:nextSeed.revision,refund_price:'3.00',type:2},actor());
   expect(second.result).toMatchObject({kind:'refuse',status:'REFUSED'});
   expect(await runtime.order(id)).toMatchObject({refundPrice:'7.00',refundStatus:0,refundType:3});
   const before=await snapshot();await expect(service.execute(id,stale,actor())).rejects.toMatchObject({httpStatus:409});
   expect(await snapshot()).toEqual(before);
   const evidence=await withTx(runtime.container,async tx=>{
    const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id)),proof=await readSupplierProactiveMoneyEvidence(tx,order);
    expect(await projectSupplierProactiveMoneyBaseline(tx,proof.baseline,order,proof.firstRefund,proof.firstSplit))
     .toEqual({...order,refundPrice:'7.00',refundType:6,refundStatus:2});
    await expect(verifyFinancialCompletedRefund(tx,proof.firstRefund,readBoundManualRefundProof)).rejects.toMatchObject({code:400});
    await verifyFinancialCompletedRefund(tx,proof.firstRefund,readBoundManualRefundProof,proof.baseline);return proof;
   });
   await withTx(runtime.container,async tx=>{
    const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
    await expect(projectSupplierProactiveMoneyBaseline(tx,evidence.baseline,order,evidence.firstRefund,evidence.firstSplit)).rejects.toMatchObject({httpStatus:409});
    await expect(projectSupplierProactiveMoneyBaseline(tx,{} as typeof evidence.baseline,order,evidence.firstRefund,evidence.firstSplit)).rejects.toMatchObject({httpStatus:409});
   });
   await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
   expect(await service.receipt(first.operation_id,actor())).toEqual(first);expect(await service.execute(id,firstBody,actor())).toEqual(first);
   expect(await service.resolve(first.operation_id,id,actor())).toEqual(first);
   const withdrawn=await snapshot();await expect(service.execute(id,{...firstBody,operation_id:randomUUID()},actor())).rejects.toMatchObject({code:400011});
   expect(await snapshot()).toEqual(withdrawn);
  });
 },120000);
 it.each(['missing-decision','no-completed-anchor','later-basis-only','wrong-first-refund'] as const)(
  'rejects post-goods refusal evidence %s in a historical money source despite a valid later anchor',async damage=>{
   const id=await paid('yue');await commissioned(async(runtime,service)=>{
    await service.execute(id,await request(service,id),actor());
    const refuse=async()=>{const seed=await service.seed(id,actor());return service.execute(id,
     {operation_id:randomUUID(),revision:seed.revision,refund_price:'3.00',type:2},actor());};
    const seven=await refuse(),money=await service.execute(id,await request(service,id,'5.00'),actor());
    await refuse();await service.execute(id,await request(service,id,'6.75'),actor());
    if(damage==='missing-decision')await f.db.transaction(async tx=>{
     await tx.execute(sql`ALTER TABLE public.supplier_proactive_refund_decision_v1 DISABLE TRIGGER USER`);
     await tx.execute(sql`DELETE FROM public.supplier_proactive_refund_decision_v1 WHERE operation_id=${seven.operation_id}::uuid`);
     await tx.execute(sql`ALTER TABLE public.supplier_proactive_refund_decision_v1 ENABLE TRIGGER USER`);
    });else {
     const [stored]=await f.db.execute<{source:Record<string,any>}>(sql`SELECT source FROM public.supplier_proactive_refund_operation_v1 WHERE operation_id=${seven.operation_id}::uuid`);
     const source=structuredClone(stored.source);
     if(damage==='no-completed-anchor'){source.order.refundStatus=0;source.order.refundType=3;}
     if(damage==='later-basis-only')source.order.refundPrice='12.00';
     if(damage==='wrong-first-refund')source.refunds[0].id+=1000;
     const text=supplierProactiveRefundJson(source),hash=await outRequestHash(source);
     await f.db.transaction(async tx=>{
      await tx.execute(sql`ALTER TABLE public.supplier_proactive_refund_operation_v1 DISABLE TRIGGER USER`);
      await tx.execute(sql`UPDATE public.supplier_proactive_refund_operation_v1 SET source=${text}::jsonb,source_json=${text},source_hash=${hash} WHERE operation_id=${seven.operation_id}::uuid`);
      await tx.execute(sql`ALTER TABLE public.supplier_proactive_refund_operation_v1 ENABLE TRIGGER USER`);
     });
    }
    const before=await snapshot();
    await expect(service.receipt(money.operation_id,actor())).rejects.toMatchObject({httpStatus:409});
    await withTx(runtime.container,async tx=>{
     const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));await expect(readSupplierProactiveMoneyEvidence(tx,order)).rejects.toMatchObject({httpStatus:409});
    });expect(await snapshot()).toEqual(before);
   });
  },120000);
 it.each(['settled money','buyer points','SKU stock'] as const)('rolls back a post-goods refusal and its original operation when deferred SQL changes %s',async damage=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const seed=await service.seed(id,actor());
   const body={operation_id:randomUUID(),revision:seed.revision,refund_price:'5.00',type:2};
   const mutation=damage==='settled money'?'UPDATE public.store_order SET refund_price=refund_price+0.01 WHERE id=NEW.id':damage==='buyer points'?'UPDATE public.user SET integral=integral+1 WHERE uid=NEW.uid':'UPDATE public.store_product_attr_value SET stock=stock+1 WHERE product_id IN(SELECT product_id FROM public.store_order_cart_info WHERE oid=NEW.id)';
   await f.exec(`CREATE FUNCTION public.owned_refusal_deferred() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN ${mutation};RETURN NEW;END $$;
    REVOKE ALL ON FUNCTION public.owned_refusal_deferred() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER owned_refusal_deferred AFTER UPDATE ON public.store_order DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN(OLD.refund_type<>3 AND NEW.refund_type=3) EXECUTE FUNCTION public.owned_refusal_deferred()`);
   try{const before=await snapshot();await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:409});
    expect(await snapshot()).toEqual(before);expect(await service.receipt(body.operation_id,actor())).toMatchObject({state:'unknown'});
   }finally{await f.exec('DROP TRIGGER owned_refusal_deferred ON public.store_order;DROP FUNCTION public.owned_refusal_deferred()');}
  });
 },120000);
 it('serializes a post-goods refusal against a real independent money writer using the same original quote',async()=>{
  const id=await paid();await commissioned(async(runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const body=await request(service,id,'5.00');
   const {cash_returned:_cash,...refused}=body;
   const peer=createDbFromConnectionString(runtime.connectionString,1,{searchPath:'public,pg_temp',applicationName:'supplier-refusal-money-peer'});
   try{
    const [a]=await runtime.container.db.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`),[b]=await peer.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);expect(a.pid).not.toBe(b.pid);
    const other=new SupplierProactiveRefundService(createContainerFromDb(peer),supplierOrderEditAppKey,f.paymentEnvironment);
    const results=await Promise.allSettled([service.execute(id,{...refused,type:2},actor()),other.execute(id,{...body,operation_id:randomUUID()},actor())]);
    expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    const failed=results.find(row=>row.status==='rejected');expect(failed&&failed.status==='rejected'&&failed.reason).toMatchObject({httpStatus:409});
    const success=results.find(row=>row.status==='fulfilled');if(!success||success.status!=='fulfilled')throw Error('Actual winner absent');
    expect(await runtime.order(id)).toMatchObject(success.value.result!.kind==='refuse'
     ?{refundPrice:'7.00',refundStatus:0,refundType:3}:{refundPrice:'12.00',refundStatus:2,refundType:6});
    expect(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id))).toHaveLength(1);
   }finally{await peer.$client.end();}
  });
 },120000);
 it.each(['offline','yue'] as const)('executes real %s money-only remainder through JWT in two exact payouts without repeating goods effects',async channel=>{
  const id=await paid(channel);await f.db.insert(storeOrderInvoice).values({orderId:id,uid:11,category:'order',isPay:1,isRefund:0,isInvoice:0,
   invoiceAmount:'18.75',name:'补退原整票',addTime:Math.floor(Date.now()/1000)});
  await commissioned(async(runtime,service)=>{
   const first=await service.execute(id,await request(service,id),actor()),before=await snapshot(),account=(await f.db.select().from(user).where(eq(user.uid,11)))[0];
   expect(await service.seed(id,actor())).toMatchObject({kind:'money',quantity:0,refund_price:'11.75',paid:'18.75',refunded:'7.00'});
   const body=await request(service,id,'5.00'),response=await http('PUT',`/order/refund/${id}`,body);
   expect(response.body).toMatchObject({status:200,data:{state:'committed',result:{kind:'money',refund_id:first.result!.refund_id,amount:'5.00',status:channel==='offline'?'CASH_SUCCESS':'BALANCE_SUCCESS'}}});
   expect(response.response.headers.get('cache-control')).toContain('private, no-store');
   expect(await runtime.order(id)).toMatchObject({refundPrice:'12.00',refundStatus:2,refundType:6,payPrice:'18.75'});
   const stable=await snapshot();onlyMoneyChanged(before,stable);
   expect((await http('PUT',`/order/refund/${id}`,body)).body).toEqual(response.body);
   expect(await service.receipt(body.operation_id,actor())).toEqual(response.body.data);
   expect(await service.resolve(body.operation_id,id,actor())).toEqual(response.body.data);expect(await snapshot()).toEqual(stable);
   const tail=await request(service,id,'6.75'),done=await service.execute(id,tail,actor());expect(done.result).toMatchObject({kind:'money',amount:'6.75'});
   expect(await runtime.order(id)).toMatchObject({refundPrice:'18.75',refundStatus:2,refundType:6});
   const final=await snapshot();onlyMoneyChanged(before,final);
   expect(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id))).toHaveLength(1);
   const completions=await f.exec('SELECT amount::text,before_refunded::text,after_refunded::text FROM public.supplier_refund_money_completion_v1 AS completion ORDER BY completion.before_refunded');
   expect(completions).toMatchObject([{amount:'5.00',before_refunded:'7.00',after_refunded:'12.00'},{amount:'6.75',before_refunded:'12.00',after_refunded:'18.75'}]);
   const current=(await f.db.select().from(user).where(eq(user.uid,11)))[0];
   expect(BigInt(current.nowMoney.replace('.',''))-BigInt(account.nowMoney.replace('.',''))).toBe(channel==='yue'?1175n:0n);expect(current.integral).toBe(account.integral);
   const flows=await f.db.select().from(capitalFlow).orderBy(capitalFlow.id);
   expect(flows.map(row=>row.price)).toEqual(channel==='offline'?['-7.00','-5.00','-6.75']:[]);
   expect((await f.db.select().from(supplierTransactions)).filter(row=>row.type===2).map(row=>row.payPrice).sort()).toEqual(['5.00','6.75','7.00']);
   await expect(service.seed(id,actor())).rejects.toMatchObject({code:400});
   expect(await service.execute(id,body,actor())).toEqual(response.body.data);expect(await snapshot()).toEqual(final);
  });
 },120000);
 it('rejects money-only excess and stale history before payout and preserves a new actual UUID for the retry',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   await service.execute(id,await request(service,id),actor());
   const stale=await request(service,id,'4.00'),before=await snapshot();
   await expect(service.execute(id,{...stale,refund_price:'11.76'},actor())).rejects.toMatchObject({code:400});expect(await snapshot()).toEqual(before);
   await service.execute(id,await request(service,id,'5.00'),actor());const stable=await snapshot();
   await expect(service.execute(id,stale,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(stable);
   expect(await service.receipt(stale.operation_id,actor())).toMatchObject({state:'unknown'});
   expect(await service.execute(id,{...await request(service,id,'4.00'),operation_id:stale.operation_id},actor())).toMatchObject({state:'committed',result:{kind:'money'}});
  });
 },120000);
 it('recovers a money-only original UUID after manage withdrawal without authorizing a new payout',async()=>{
  const id=await paid('yue');await commissioned(async(_runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const body=await request(service,id,'5.00'),done=await service.execute(id,body,actor());
   await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));const before=await snapshot();
   expect(await service.execute(id,body,actor())).toEqual(done);expect(await service.receipt(body.operation_id,actor())).toEqual(done);
   expect(await service.resolve(body.operation_id,id,actor())).toEqual(done);
   await expect(service.execute(id,{...body,operation_id:randomUUID()},actor())).rejects.toMatchObject({code:400011});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it.each(['is_del','is_cancel'] as const)('never resets money-only budget when the original whole-goods refund becomes %s',async column=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   const done=await service.execute(id,await request(service,id),actor());await f.exec(`UPDATE public.store_order_refund SET ${column}=1 WHERE id=${done.result!.refund_id}`);
   const before=await snapshot();await expect(service.seed(id,actor())).rejects.toBeDefined();expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('rolls back a money-only payout when a real deferred writer changes its platform amount',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const body=await request(service,id,'5.00');
   await f.exec(`CREATE FUNCTION public.owned_money_flow_deferred() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN UPDATE public.capital_flow SET price=-4.99 WHERE id=NEW.id; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.owned_money_flow_deferred() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER owned_money_flow_deferred AFTER INSERT ON public.capital_flow DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.owned_money_flow_deferred()`);
   try{const before=await snapshot();await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);}
   finally{await f.exec('DROP TRIGGER owned_money_flow_deferred ON public.capital_flow;DROP FUNCTION public.owned_money_flow_deferred()');}
  });
 },120000);
 it('rejects money-only writes before payout when completion append loses its explicit privilege',async()=>{
  const id=await paid('yue');await commissioned(async(runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const body=await request(service,id,'5.00');
   await f.exec(`REVOKE INSERT ON public.supplier_refund_money_completion_v1 FROM "${runtime.role}"`);
   const before=await snapshot();await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:503});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('binds money-only first-goods comparison to the real transaction and retains the mature default amount assertion',async()=>{
  const id=await paid();await commissioned(async(runtime,service)=>{
   await service.execute(id,await request(service,id),actor());await service.execute(id,await request(service,id,'5.00'),actor());
   const evidence=await withTx(runtime.container,async tx=>{
    const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id)),actual=await readSupplierProactiveMoneyEvidence(tx,order);
    await expect(verifyFinancialCompletedRefund(tx,actual.firstRefund,readBoundManualRefundProof)).rejects.toBeDefined();
    await verifyFinancialCompletedRefund(tx,actual.firstRefund,readBoundManualRefundProof,actual.baseline);
    return actual;
   });
   await withTx(runtime.container,async tx=>{
    const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
    await expect(projectSupplierProactiveMoneyBaseline(tx,evidence.baseline,order,evidence.firstRefund,evidence.firstSplit)).rejects.toMatchObject({httpStatus:409});
    await expect(projectSupplierProactiveMoneyBaseline(tx,{} as typeof evidence.baseline,order,evidence.firstRefund,evidence.firstSplit)).rejects.toMatchObject({httpStatus:409});
   });
  });
 },120000);
 it('serializes independent money-only requests so two current quotes cannot both consume the same remainder',async()=>{
  const id=await paid();await commissioned(async(runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const first=await request(service,id,'6.00'),secondBody=await request(service,id,'6.00');
   const peer=createDbFromConnectionString(runtime.connectionString,1,{searchPath:'public,pg_temp',applicationName:'supplier-proactive-money-peer'});
   try{
    const [a]=await runtime.container.db.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`),[b]=await peer.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);expect(a.pid).not.toBe(b.pid);
    const other=new SupplierProactiveRefundService(createContainerFromDb(peer),supplierOrderEditAppKey,f.paymentEnvironment);
    const results=await Promise.allSettled([service.execute(id,first,actor()),other.execute(id,secondBody,actor())]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const failed=results.find(result=>result.status==='rejected');expect(failed&&failed.status==='rejected'&&failed.reason).toMatchObject({httpStatus:409});
    expect(await runtime.order(id)).toMatchObject({refundPrice:'13.00'});
    expect(await f.exec('SELECT operation_id FROM public.supplier_refund_money_completion_v1')).toHaveLength(1);
    expect(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id))).toHaveLength(1);
   }finally{await peer.$client.end();}
  });
 },120000);
 it('rejects money-only history when an extra bill reuses its full original business identity',async()=>{
  const id=await paid('yue');await commissioned(async(_runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const body=await request(service,id,'5.00');await service.execute(id,body,actor());
   await f.db.insert(userBill).values({uid:11,linkId:supplierProactiveRefundApplicationNumber(actor().id,body.operation_id),pm:1,
    category:'integral',type:'unexpected_extra_effect',number:'1.00',balance:'1.00',addTime:Math.floor(Date.now()/1000)});
   const before=await snapshot();await expect(service.receipt(body.operation_id,actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.seed(id,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('rolls back money-only writes when a deferred writer creates another supplier entitlement',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const body=await request(service,id,'5.00');
   await f.exec(`CREATE FUNCTION public.owned_money_entitlement_deferred() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN INSERT INTO public.supplier_flowing_water(supplier_id,uid,order_id,link_id,pm,number,type,pay_type,pay_price,total_price,pay_postage,status)
    VALUES(NEW.supplier_id,NEW.uid,'extra-money-'||NEW.id::text,NEW.link_id,0,1.00,2,NEW.pay_type,1.00,NEW.total_price,0.00,1);RETURN NEW;END $$;
    REVOKE ALL ON FUNCTION public.owned_money_entitlement_deferred() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER owned_money_entitlement_deferred AFTER INSERT ON public.supplier_transactions DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.owned_money_entitlement_deferred()`);
   try{const before=await snapshot();await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);}
   finally{await f.exec('DROP TRIGGER owned_money_entitlement_deferred ON public.supplier_transactions;DROP FUNCTION public.owned_money_entitlement_deferred()');}
  });
 },120000);
 it('never publishes a money-only operation and decision without its atomic completion',async()=>{
  const id=await paid();await commissioned(async(runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const body=await request(service,id,'5.00'),parsed=await parseSupplierProactiveRefundIntent(id,body,actor());
   await withTx(runtime.container,async tx=>{
    const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id)),source=await readSupplierProactiveRefundSource(tx,order),evidence=await readSupplierProactiveMoneyEvidence(tx,order),
     money=makeSupplierProactiveMoneySource(order,evidence,await outRequestHash(source)),now=Math.floor(Date.now()/1000);
    const operation=await appendSupplierProactiveRefundOperation(tx,{operationId:body.operation_id,orderId:id,actor:actor(),now,intent:parsed.intent,
     requestHash:parsed.hash,source:money,result:{order_id:id,refund_id:evidence.first.refund_id,amount:'5.00',kind:'money',status:'CASH_SUCCESS'}});
    await appendSupplierProactiveRefundDecision(tx,operation,{outcome:'local-settled',evidence:{refund_id:evidence.first.refund_id},now});
   });
   const before=await snapshot();await expect(service.receipt(body.operation_id,actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.resolve(body.operation_id,id,actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.execute(id,body,actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.seed(id,actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('credits a real money-only refund into an existing negative balance without changing other account fields',async()=>{
  const id=await paid('yue'),other=await paid('yue','18.75',true);await commissioned(async(_runtime,service)=>{
   // A genuine payout for another order belongs to the same buyer, without
   // contributing to this order's independently protected remaining budget.
   await service.execute(other,await request(service,other),actor());
   await service.execute(other,await request(service,other,'1.00'),actor());
   await service.execute(id,await request(service,id),actor());await f.db.update(user).set({nowMoney:'-10.00'}).where(eq(user.uid,11));
   const before=(await f.db.select().from(user).where(eq(user.uid,11)))[0],body=await request(service,id,'5.00');
   await service.execute(id,body,actor());expect((await f.db.select().from(user).where(eq(user.uid,11)))[0]).toEqual({...before,nowMoney:'-5.00'});
   const bills=(await f.db.select().from(userBill)).filter(row=>row.linkId===supplierProactiveRefundApplicationNumber(actor().id,body.operation_id));
   expect(bills).toMatchObject([{number:'5.00',balance:'-5.00',pm:1,status:1}]);
   expect(await service.seed(id,actor())).toMatchObject({kind:'money',refunded:'12.00',refund_price:'6.75'});
  });
 },120000);
 it.each(['bill','flow','supplier_transaction'] as const)('never seals a money-only original UUID as absent when an orphan %s exists for another actor',async kind=>{
  const id=await paid(kind==='bill'?'yue':'offline');await commissioned(async(runtime,service)=>{
   await service.execute(id,await request(service,id),actor());const quote=await request(service,id,'5.00'),uuid=randomUUID(),order=await runtime.order(id),
    number=supplierProactiveRefundApplicationNumber(actor().id,uuid),now=Math.floor(Date.now()/1000);
   if(kind==='bill')await f.db.insert(userBill).values({uid:order.uid,linkId:number,pm:1,category:'now_money',type:'pay_product_refund',
    eventKey:'supplier_proactive_money_refund',number:'5.00',balance:'5.00',addTime:now,status:1});
   else if(kind==='flow')await f.db.insert(capitalFlow).values({eventKey:'supplier.proactive-refund:'+uuid,flowId:number,orderId:order.orderId,
    storeId:order.storeId,uid:order.uid,price:'-5.00',tradingType:2,payType:'offline',addTime:now});
   else await f.db.insert(supplierTransactions).values({supplierId:order.supplierId,uid:order.uid,orderId:number,linkId:order.orderId,
    pm:0,type:2,payType:order.payType,payPrice:'5.00',totalPrice:order.totalPrice,payPostage:'0.00',tradeTime:now,addTime:now});
   const before=await snapshot();expect(await service.receipt(uuid,actor())).toMatchObject({state:'unknown'});
   await expect(service.resolve(uuid,id,actor())).rejects.toMatchObject({httpStatus:503});
   await expect(service.resolve(uuid,id,supplierOrderEditActor(22))).rejects.toMatchObject({httpStatus:503});
   await expect(service.seed(id,actor())).rejects.toMatchObject({httpStatus:409});
   await expect(service.execute(id,quote,actor())).rejects.toMatchObject({httpStatus:409});
   expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('checks the real flow again after deferred SQL writers and rolls the complete payout back on a changed amount',async()=>{
  const id=await paid();await commissioned(async(_runtime,service)=>{
   await f.exec(`CREATE FUNCTION public.owned_proactive_flow_deferred() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN UPDATE public.capital_flow SET price=-6.99 WHERE id=NEW.id; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.owned_proactive_flow_deferred() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER owned_proactive_flow_deferred AFTER INSERT ON public.capital_flow DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.owned_proactive_flow_deferred()`);
   try{const before=await snapshot();await expect(service.execute(id,await request(service,id),actor())).rejects.toMatchObject({httpStatus:409});expect(await snapshot()).toEqual(before);}
   finally{await f.exec('DROP TRIGGER owned_proactive_flow_deferred ON public.capital_flow;DROP FUNCTION public.owned_proactive_flow_deferred()');}
  });
 },120000);
});
