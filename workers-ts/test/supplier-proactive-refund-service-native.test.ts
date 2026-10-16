/** Real App/JWT and independent PostgreSQL16 LOGIN. Checkout, collection,
 * balance debit, paid consumption and all refunds use the actual services. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {withTx,createDbFromConnectionString,createContainerFromDb} from '@/lib/di';
import {storeOrder,storeOrderInvoice,storeOrderRefund,systemRole,user,userBill,capitalFlow} from '@/models/schema';
import {createToken} from '@/utils/jwt';
import {StoreOrderPayService} from '@/services/order/StoreOrderPayService';
import {SupplierProactiveRefundService} from '@/services/supplier/SupplierProactiveRefundService';
import {readSupplierProactiveRefundSource} from '@/services/supplier/SupplierProactiveRefundSource';
import {parseSupplierProactiveRefundIntent} from '@/services/supplier/SupplierProactiveRefundInput';
import {appendSupplierProactiveRefundOperation} from '@/services/supplier/SupplierProactiveRefundOperation';
import {requiredSupplierPermissions} from '@/services/supplier/SupplierPermissionService';
import {installSupplierProactiveRefund} from '@/migrations/supplierProactiveRefund';
import {runtimeBusinessPrivilegePlan} from '@/migrations/runtimeBusinessPrivilegePlan';
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
 async function paid(channel:'offline'|'yue'|'weixin'|'alipay'='offline',amount='18.75') {
  const order=await f.createOffline();
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
  decisions:await f.exec('SELECT * FROM public.supplier_proactive_refund_decision_v1 ORDER BY operation_id')});
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
