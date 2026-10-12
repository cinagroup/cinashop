import {afterAll,beforeAll,beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {asc,eq,sql} from 'drizzle-orm';
import {createContainerFromDb,withTx} from '../src/lib/di';
import {customerWorkWriteoffFixture} from './helpers/customerWorkWriteoffFixture';
import {validateFinanceFixtureUrl,ownsFinanceFixtureEndpoint} from './helpers/financePostgres';
import {storeOrder,storeOrderCartInfo,storeOrderStatus,storeOrderOutbox,storeOrderRefund,storeOrderRefundPayment,storeOrderInvoice,storeService,storeProduct,storeProductAttrValue,user,userBill,systemNotification,systemMessage,orderNotificationDelivery,wechatUser} from '../src/models/schema';
import {processOrderNotificationOutboxEvent} from '../src/services/order/OrderNotificationOutboxService';
import {storeOrderRefundSplit} from '../src/models/schema/order_refund_split';
import {manualRefundPaymentFacts} from '../src/services/order/CustomerManualRefund';
import {CustomerWorkFinancialService} from '../src/services/customer-work/CustomerWorkFinancialService';
import {authorizeCustomerWorkActor} from '../src/services/customer-work/CustomerWorkScope';
import {financialRevisions} from '../src/services/customer-work/CustomerWorkFinancialReadService';
import {CUSTOMER_FINANCIAL_VERSION,CUSTOMER_FINANCIAL_QUOTE_VERSION,type FinancialInput} from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import type {CustomerJson} from '../src/services/customer-work/CustomerWorkOperationRequest';

/** Genuine imported PHP payment facts, not a synthetic TS payment transaction.
 * PHP StoreOrderSuccessServices persists pay_time, then Pay's asynchronous
 * OrderStatusJob records its independent time(). No guessed delay window.
 * Original PHP carts stay unversioned and immutable. The native refund cases
 * use only their complete historical facts; newly materialized child rows are
 * actual TS refunds, and their source record preserves the untouched PHP data.
 */
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('imported PHP cash payment and original-cart refunds PostgreSQL16',{timeout:30000},()=>{
 let f:Awaited<ReturnType<typeof customerWorkWriteoffFixture>>,fetchGuard:ReturnType<typeof vi.spyOn>;
 beforeAll(async()=>{
  f=await customerWorkWriteoffFixture([systemNotification,systemMessage,orderNotificationDelivery,wechatUser]);
  const base=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??''),[origin]=await f.maintenanceDb.execute<{database:string;role:string;session:string;host:string;port:number;version:number;table_oid:string;owner:string}>(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num')::integer AS version,c.oid::text AS table_oid,r.rolname AS owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.system_config'::regclass`);
  if(origin?.role!=='finance_test'||origin.session!==origin.role||origin.owner!==origin.role||Math.floor(origin.version/10000)!==16||!ownsFinanceFixtureEndpoint(origin.database,'public',base.href,origin.host,origin.port))throw Error('Config scheduling requires the registered owned PG16 fixture table');
  const locks=await f.maintenanceDb.execute(sql`SELECT l.pid,l.mode,l.granted,a.backend_type,a.state FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.relation='public.system_config'::regclass ORDER BY l.pid,l.mode`),transactions=await f.maintenanceDb.execute(sql`SELECT pid,backend_type,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state IN('idle in transaction','idle in transaction (aborted)')`);
  console.log('CUSTOMER_CASH_REFUND_CONFIG_FIXTURE '+JSON.stringify({origin,locks,transactions}));if(transactions.length)throw Error('Owned fixture has an unreleased transaction before pricing cases');
  // Repeated reset writes may overlap autonomous maintenance. Isolate this
  // disposable table alone; production SHARE NOWAIT and business timing stay.
  await f.exec('ALTER TABLE public.system_config SET (autovacuum_enabled=false)');
  const [scheduled]=await f.maintenanceDb.execute<{oid:string;options:string[]}>(sql`SELECT oid::text AS oid,reloptions AS options FROM pg_class WHERE oid='public.system_config'::regclass`);if(scheduled.oid!==origin.table_oid||!scheduled.options.includes('autovacuum_enabled=false'))throw Error('Owned config scheduling did not retain its table identity');
  // This lean fixture creates table columns, not secondary ORM indexes. Restore
  // the exact published/model arbiter before testing actual SMS idempotence.
  const indexes=await f.maintenanceDb.execute(sql`SELECT 1 FROM pg_class WHERE oid=to_regclass('public.ond_event_channel_uq')`);if(!indexes.length)await f.exec('CREATE UNIQUE INDEX "ond_event_channel_uq" ON public.order_notification_delivery USING btree(event_key,channel)');
  const [arbiter]=await f.maintenanceDb.execute<{ready:boolean}>(sql`SELECT count(*)=1 AND bool_and(i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.pos)=ARRAY['event_key','channel']::text[]) AS ready FROM pg_index i WHERE i.indexrelid=to_regclass('public.ond_event_channel_uq') AND i.indrelid='public.order_notification_delivery'::regclass`);if(arbiter?.ready!==true)throw Error('Actual notification arbiter does not match the complete event/channel contract');
  await f.exec(`GRANT SELECT ON public.system_notification,public.system_message,public.order_notification_delivery,public.wechat_user TO "${f.role}";GRANT INSERT ON public.order_notification_delivery TO "${f.role}";GRANT USAGE ON SEQUENCE public.order_notification_delivery_id_seq TO "${f.role}"`);
 },180000);
 beforeEach(async()=>{await f.maintenanceDb.delete(orderNotificationDelivery);await f.maintenanceDb.delete(systemMessage);await f.reset();await f.maintenanceDb.delete(systemNotification);fetchGuard=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Imported cash must never dispatch a provider'));});
 afterEach(()=>{try{expect(fetchGuard).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}});
 afterAll(async()=>{await f?.close();},30000);
 const paidTime=1700000000;
 const order=async()=> (await f.db.select().from(storeOrder).where(eq(storeOrder.id,1)))[0];
 async function imported(buyer=11,payType:'cash'|'offline'='cash',delay=3600){
  await f.maintenanceDb.update(storeOrder).set({uid:buyer,payType,paid:1,payTime:paidTime,addTime:paidTime-3600}).where(eq(storeOrder.id,1));
  await f.maintenanceDb.update(storeOrderCartInfo).set({uid:buyer}).where(eq(storeOrderCartInfo.oid,1));
  await f.maintenanceDb.insert(storeOrderStatus).values({oid:1,changeType:'pay_success',changeMessage:'用户付款成功',changeTime:paidTime+delay});
  return order();
 }
 const facts=async()=>({
  orders:await f.db.select().from(storeOrder),carts:await f.db.select().from(storeOrderCartInfo),
  statuses:await f.db.select().from(storeOrderStatus),outbox:await f.db.select().from(storeOrderOutbox),
  accounts:await f.db.select().from(user).orderBy(asc(user.uid)),bills:await f.db.select().from(userBill).orderBy(asc(userBill.id)),
  manual:await f.db.execute(sql`SELECT * FROM public.customer_financial_manual_refund_v1`),
  refunds:await f.db.select().from(storeOrderRefund),payments:await f.db.select().from(storeOrderRefundPayment),
  invoices:await f.db.select().from(storeOrderInvoice),splits:await f.db.select().from(storeOrderRefundSplit),
  products:await f.db.select().from(storeProduct).orderBy(asc(storeProduct.id)),skus:await f.db.select().from(storeProductAttrValue).orderBy(asc(storeProductAttrValue.id)),
 });
 const service=()=>new CustomerWorkFinancialService(f.container,f.env);
 const context=(uid=101,key=crypto.randomUUID())=>({actor:f.actor(uid),request_key:key});
 async function input(payload:CustomerJson,id=1,uid=101):Promise<FinancialInput>{
  const actual=(await f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0],scope=await authorizeCustomerWorkActor(f.db,f.actor(uid)),state=await financialRevisions(f.db,actual);
  return{version:CUSTOMER_FINANCIAL_VERSION,scope_key:scope.scope_key,order_id:id,expected_order_revision:state.order_revision,expected_financial_revision:state.financial_revision,payload};
 }
 async function creation(id=1,quantity?:number,uid=101){
  const base=await input({},id,uid),cart=(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)))[0],items=quantity?[{cart_row_id:cart.id,cart_num:quantity}]:[],mode=quantity?'items' as const:'remaining' as const;
  const quoted=(await service().reader.quote(f.actor(uid),{version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:base.scope_key,order_id:id,expected_order_revision:base.expected_order_revision,expected_financial_revision:base.expected_financial_revision,mode,items})).data;
  return input({mode,items,quoted_price:quoted.quoted_price,refund_price:quoted.quoted_price,quote_fingerprint:quoted.quote_fingerprint,reason:'原PHP顾客确认退款'},id,uid);
 }
 async function refundLegacy(id=1,quantity?:number,uid=101){
  const createContext=context(uid),createBody=await creation(id,quantity,uid),created=await service().create(createContext,createBody);expect(created.receipt?.outcome).toBe('refund-created');
  const refundId=Number(created.receipt!.evidence.refund_id),actual=(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)))[0],review=(await service().reader.review(f.actor(uid),refundId,{refund_no:actual.orderId})).data;
  const body=await input({refund_id:refundId,refund_no:review.refund_no,expected_refund_revision:review.refund_revision,review_fingerprint:review.review_fingerprint,decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false,...(review.refund_price!=='0.00'?{cash_returned:true}:{})},refund_price:review.refund_price},id,uid),ctx=context(uid),done=await service().execute('refund_execute',ctx,body);
  expect(done.execution).toMatchObject({status:review.refund_price==='0.00'?'ZERO_SUCCESS':'CASH_SUCCESS',completed:true,verified:true});
  return{refundId,created,body,ctx,done};
 }
 async function executeExisting(refundId:number,id:number){
  const actual=(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)))[0],review=(await service().reader.review(f.actor(),refundId,{refund_no:actual.orderId})).data;
  const body=await input({refund_id:refundId,refund_no:review.refund_no,expected_refund_revision:review.refund_revision,review_fingerprint:review.review_fingerprint,decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false,cash_returned:true},refund_price:review.refund_price},id),ctx=context(),done=await service().execute('refund_execute',ctx,body);
  expect(done.execution).toMatchObject({status:'CASH_SUCCESS',completed:true,verified:true});return{ctx,body,done};
 }
 async function importedFinancial(buyer=11,payType:'cash'|'offline'='cash',price='5.00'){
  await imported(buyer,payType);const amount=price==='0.00'?'0.00':'15.00';
  await f.maintenanceDb.update(storeOrder).set({totalNum:3,totalPrice:amount,payPrice:amount,cost:'0.00',productType:0}).where(eq(storeOrder.id,1));
  const original={id:'original-php-cart',cart_num:3,product_id:70,product_attr_unique:'qared001',sum_price:price,truePrice:price,costPrice:'0.00',sum_true_price:amount,coupon_price:'0.00',integral_price:'0.00',first_order_price:'0.00',one_brokerage:'0.00',two_brokerage:'0.00',division_staff_brokerage:'0.00',division_agent_brokerage:'0.00',division_brokerage:'0.00',use_integral:0,integral:0,price_type:'',
   productInfo:{id:70,store_name:'真实导入PHP购买快照',image:'/api/qa/image.svg',product_type:0,give_integral:'0.00',attrInfo:{id:1,unique:'qared001',price,cost:'0.00',write_times:1,suk:'Red'}}};
  await f.maintenanceDb.update(storeOrderCartInfo).set({cartId:original.id,cartInfo:JSON.stringify(original),promotionsId:'',productType:0,cartNum:3,surplusNum:3,splitSurplusNum:3,writeTimes:3,writeSurplusTimes:3,isWriteoff:0}).where(eq(storeOrderCartInfo.id,1));
  return{order:await order(),original};
 }
 it.each([{buyer:11,payType:'cash' as const},{buyer:0,payType:'cash' as const},{buyer:11,payType:'offline' as const},{buyer:0,payType:'offline' as const}])('admits unique delayed PHP payment for buyer=$buyer method=$payType without modifying any fact',async({buyer,payType})=>{
  const original=await imported(buyer,payType),before=await facts(),actual=await manualRefundPaymentFacts(f.db,original);
  expect(actual).toMatchObject({root_id:1,buyer_uid:buyer,pay_type:payType,pay_time:paidTime,origin_hash:null,event:null,audits:[{change_type:'pay_success',change_message:'用户付款成功',change_time:paidTime+3600}]});
  expect(await facts()).toEqual(before);
  expect(before.accounts.some(row=>row.uid===0)).toBe(false);
 });
 it('accepts the exact PHP job even after a long queue delay, without a temporal heuristic',async()=>{
  const original=await imported(11,'cash',86400*400),before=await facts();
  expect((await manualRefundPaymentFacts(f.db,original)).audits[0].change_time).toBe(paidTime+86400*400);
  expect(await facts()).toEqual(before);
 });
 it('captures every canonical PHP queued job redelivery without interpreting it as another cash payment',async()=>{
  const original=await imported();await f.maintenanceDb.insert(storeOrderStatus).values({oid:1,changeType:'pay_success',changeMessage:'用户付款成功',changeTime:paidTime+86400});
  const before=await facts(),payment=await manualRefundPaymentFacts(f.db,original);expect(payment.audits).toHaveLength(2);expect(payment.audits.map(a=>a.change_time)).toEqual([paidTime+3600,paidTime+86400]);expect(await facts()).toEqual(before);
 });
 it.each(['absent','conflicting-duplicate','before-payment','other-root','wrong-message','wrong-type'] as const)('refuses incomplete or contradictory imported audit %s',async kind=>{
  const original=await imported();
  if(kind==='absent')await f.maintenanceDb.delete(storeOrderStatus).where(eq(storeOrderStatus.oid,1));
  if(kind==='conflicting-duplicate')await f.maintenanceDb.insert(storeOrderStatus).values({oid:1,changeType:'pay_success',changeMessage:'contradictory payment guess',changeTime:paidTime+86400});
  if(kind==='before-payment')await f.maintenanceDb.update(storeOrderStatus).set({changeTime:paidTime-1}).where(eq(storeOrderStatus.oid,1));
  if(kind==='other-root')await f.maintenanceDb.update(storeOrderStatus).set({oid:2}).where(eq(storeOrderStatus.oid,1));
  if(kind==='wrong-message')await f.maintenanceDb.update(storeOrderStatus).set({changeMessage:'manual fixture guess'}).where(eq(storeOrderStatus.oid,1));
  if(kind==='wrong-type')await f.maintenanceDb.update(storeOrderStatus).set({changeType:'pay_cash'}).where(eq(storeOrderStatus.oid,1));
  const before=await facts();await expect(manualRefundPaymentFacts(f.db,original)).rejects.toThrow();expect(await facts()).toEqual(before);
 });
 it.each(['customer_cashier_paid','cw_financial_confirm_offline'] as const)('never downgrades TS audit %s with missing paid event to legacy',async changeType=>{
  const original=await imported();await f.maintenanceDb.update(storeOrderStatus).set({changeType,changeTime:paidTime}).where(eq(storeOrderStatus.oid,1));
  const before=await facts();await expect(manualRefundPaymentFacts(f.db,original)).rejects.toThrow();expect(await facts()).toEqual(before);
 });
 it.each(['cashier','offline'] as const)('retains same-transaction TS %s timestamp admission',async method=>{
  if(method==='cashier'){
   const genuine=await f.cashier(0);expect((await manualRefundPaymentFacts(f.db,genuine.order)).event).not.toBeNull();
   await f.maintenanceDb.update(storeOrderStatus).set({changeTime:genuine.order.payTime+1}).where(eq(storeOrderStatus.changeType,'customer_cashier_paid'));
   const before=await facts();await expect(manualRefundPaymentFacts(f.db,genuine.order)).rejects.toThrow();expect(await facts()).toEqual(before);
  }else{
   // An imported record carrying a TS paid event is not admitted by PHP delay
   // rules. The full TS refund suite separately creates actual offline payment.
   const original=await imported(11,'offline');await f.maintenanceDb.insert(storeOrderOutbox).values({eventKey:'order.paid:1',aggregateType:'order',aggregateId:1,eventType:'order.paid',payload:{orderId:1,orderNo:original.orderId}});
   const before=await facts();await expect(manualRefundPaymentFacts(f.db,original)).rejects.toThrow();expect(await facts()).toEqual(before);
  }
 });
 it.each([{buyer:11,payType:'cash' as const},{buyer:0,payType:'cash' as const},{buyer:11,payType:'offline' as const},{buyer:0,payType:'offline' as const}])('refunds untouched original PHP carts for buyer=$buyer method=$payType through quote/application/actual manual settlement',async({buyer,payType})=>{
  const imported=await importedFinancial(buyer,payType),before=await facts(),done=await refundLegacy(),after=await facts();
  expect(done.done).toMatchObject({receipt:{outcome:'cash-settled',evidence:{uid:buyer,pay_type:payType,amount:'15.00'}},execution:{status:'CASH_SUCCESS',completed:true}});
  const source=JSON.parse(String(after.splits[0].sourceSnapshot)) as {carts:Array<{cartInfo:string}>};expect(source.carts[0].cartInfo).toBe(JSON.stringify(imported.original));expect(source.carts[0].cartInfo).not.toContain('checkout-line-finance-v1');
  expect(before.skus[0].price).toBe('10.00');expect(after.accounts).toEqual(before.accounts);expect(after.bills).toEqual(before.bills);expect(after.payments).toEqual([]);expect(after.outbox).toEqual(before.outbox);expect(after.skus[0].stock).toBe(before.skus[0].stock+3);
  expect((await service().status(f.actor(),done.ctx.request_key)).execution).toMatchObject({status:'CASH_SUCCESS',completed:true,verified:true});
 });
 it.each([11,0])('materializes all three actual PHP refund generations and invoice ownership for buyer=%s',async buyer=>{
  const imported=await importedFinancial(buyer,'cash');await f.maintenanceDb.insert(storeOrderInvoice).values({orderId:1,uid:buyer,category:'order',invoiceAmount:'15.00',isPay:1,isInvoice:0});
  const before=await facts(),saved:Array<Awaited<ReturnType<typeof refundLegacy>>>=[];let id=1;
  for(let n=0;n<3;n++){
   const done=await refundLegacy(id,n<2?1:undefined),split=(await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,done.refundId)))[0];saved.push(done);
   expect(done.done.receipt).toMatchObject({outcome:'cash-settled',evidence:{amount:'5.00'}});expect(split.paymentOrderId).toBe(1);
   if(n<2){id=split.remainingOrderId!;expect(id).toBeGreaterThan(1);const current=(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)))[0],raw=JSON.parse(current.cartInfo!);expect(raw.financial_version).toBe('refund-order-line-finance-v1');expect(raw.legacy_php_financial_source).toBe('original-php-purchase-facts-v1');}
  }
  const after=await facts();expect(after.manual).toHaveLength(3);expect(after.skus[0].stock).toBe(before.skus[0].stock+3);expect(after.accounts).toEqual(before.accounts);expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,1)))[0].cartInfo).toBe(JSON.stringify(imported.original));
  for(const done of saved)expect((await service().status(f.actor(),done.ctx.request_key)).execution).toMatchObject({status:'CASH_SUCCESS',completed:true,verified:true});
 },30000);
 it('refunds a complete original PHP cart with actual nullable promotions_id and no promotion ledger without changing either source',async()=>{
  const imported=await importedFinancial(0,'offline');await f.maintenanceDb.update(storeOrderCartInfo).set({promotionsId:null}).where(eq(storeOrderCartInfo.id,1));
  const before=await facts();expect(before.carts[0].promotionsId).toBeNull();expect(await f.db.execute(sql`SELECT id FROM public.store_order_promotions WHERE oid=1`)).toHaveLength(0);
  const done=await refundLegacy(),after=await facts();expect(done.done.execution).toMatchObject({status:'CASH_SUCCESS',completed:true,verified:true});
  expect(JSON.parse(after.splits[0].sourceSnapshot).carts[0]).toMatchObject({promotionsId:null,cartInfo:JSON.stringify(imported.original)});expect(after.carts.find(c=>c.id===1)?.promotionsId).toBeNull();
  expect(after.accounts).toEqual(before.accounts);expect(after.payments).toEqual([]);expect(after.skus[0].stock).toBe(before.skus[0].stock+3);
 });
 it('accepts a genuine TS cashier consumer completing in a later second through actual quote and settlement',async()=>{
  const genuine=await f.cashier(11,'7.00',2,1100),actual=await manualRefundPaymentFacts(f.db,genuine.order),consumer=actual.audits.find(a=>a.change_type==='pay_success');
  expect(consumer!.change_time).toBeGreaterThan(genuine.order.payTime);expect(actual.audits.find(a=>a.change_type==='customer_cashier_paid')!.change_time).toBe(genuine.order.payTime);
  expect(actual.event!.consumer_completion).toEqual({status:'COMPLETED',processed_time:consumer!.change_time,supplier_allocation:null});const done=await refundLegacy(genuine.order.id);
  expect((await service().status(f.actor(),done.ctx.request_key)).execution).toMatchObject({status:'CASH_SUCCESS',completed:true,verified:true});
 });
 it('refuses nullable original PHP promotion IDs when an actual promotion ledger contradicts the zero allocation',async()=>{
  await importedFinancial(0,'cash');await f.maintenanceDb.update(storeOrderCartInfo).set({promotionsId:null}).where(eq(storeOrderCartInfo.id,1));
  await f.maintenanceDb.execute(sql`INSERT INTO public.store_order_promotions(oid,uid,promotions_id,product_id,promotions_price,add_time) VALUES(1,0,1,70,'0.01',${paidTime})`);
  const before=await facts(),ledger=await f.db.execute(sql`SELECT * FROM public.store_order_promotions WHERE oid=1 ORDER BY id`);await expect(creation()).rejects.toThrow();expect(await facts()).toEqual(before);expect(await f.db.execute(sql`SELECT * FROM public.store_order_promotions WHERE oid=1 ORDER BY id`)).toEqual(ledger);
 });
 it.each(['message','before-payment','event-status','event-time','absent-consumer'] as const)('refuses contradictory TS consumer %s without modifying facts',async kind=>{
  const genuine=await f.cashier(11),paid=genuine.order;
  if(kind==='message')await f.maintenanceDb.update(storeOrderStatus).set({changeMessage:'用户付款成功'}).where(eq(storeOrderStatus.changeType,'pay_success'));
  if(kind==='before-payment')await f.maintenanceDb.update(storeOrderStatus).set({changeTime:paid.payTime-1}).where(eq(storeOrderStatus.changeType,'pay_success'));
  if(kind==='event-status')await f.maintenanceDb.update(storeOrderOutbox).set({status:'PENDING'}).where(eq(storeOrderOutbox.id,genuine.payment.outbox!.id));
  if(kind==='event-time')await f.maintenanceDb.update(storeOrderOutbox).set({processedTime:paid.payTime-1}).where(eq(storeOrderOutbox.id,genuine.payment.outbox!.id));
  if(kind==='absent-consumer')await f.maintenanceDb.delete(storeOrderStatus).where(eq(storeOrderStatus.changeType,'pay_success'));
  const before=await facts();await expect(manualRefundPaymentFacts(f.db,paid)).rejects.toThrow();expect(await facts()).toEqual(before);
 });
 it.each([11,0])('returns zero-value original PHP quantities without cash/provider/balance evidence for buyer=%s',async buyer=>{
  await importedFinancial(buyer,'cash','0.00');const before=await facts(),done=await refundLegacy(),after=await facts();expect(done.done.receipt?.outcome).toBe('zero-settled');expect(after.manual[0]).toMatchObject({buyer_uid:buyer,settlement:'zero',cash_returned:false});expect(after.accounts).toEqual(before.accounts);expect(after.bills).toEqual(before.bills);expect(after.payments).toEqual([]);expect(after.skus[0].stock).toBe(before.skus[0].stock+3);
 });
 it('allows another actual global customer to manage a genuine imported PHP payment',async()=>{
  await importedFinancial(0,'offline');await f.maintenanceDb.update(storeService).set({customer:1}).where(eq(storeService.uid,102));const done=await refundLegacy(1,undefined,102);expect(done.done.receipt).toMatchObject({actor_uid:102,outcome:'cash-settled',evidence:{uid:0,pay_type:'offline'}});
 });
 it('refunds a genuine PHP raw attr write_times=0 using its original max(0,1) rule without changing the source',async()=>{
  const imported=await importedFinancial(0,'cash'),original={...imported.original,productInfo:{...imported.original.productInfo,attrInfo:{...imported.original.productInfo.attrInfo,write_times:0}}};
  await f.maintenanceDb.update(storeOrderCartInfo).set({cartInfo:JSON.stringify(original)}).where(eq(storeOrderCartInfo.id,1));const before=await facts(),done=await refundLegacy(),after=await facts();
  expect(done.done.receipt?.outcome).toBe('cash-settled');expect(JSON.parse(after.splits[0].sourceSnapshot).carts[0].cartInfo).toBe(JSON.stringify(original));expect(after.skus[0].stock).toBe(before.skus[0].stock+3);expect(after.accounts).toEqual(before.accounts);expect(after.payments).toEqual([]);
 });
 it('preserves actual committed original UUID proof after a late canonical PHP status-job redelivery',async()=>{
  await importedFinancial(0,'cash');const done=await refundLegacy(),before=await facts();
  await f.maintenanceDb.insert(storeOrderStatus).values({oid:1,changeType:'pay_success',changeMessage:'用户付款成功',changeTime:paidTime+86400});
  const current=await service().status(f.actor(),done.ctx.request_key);expect(current.receipt).toEqual(done.done.receipt);expect(current.execution).toMatchObject({status:'CASH_SUCCESS',completed:true,verified:true});
  const after=await facts();expect(after.manual).toEqual(before.manual);expect(after.accounts).toEqual(before.accounts);expect(after.payments).toEqual([]);expect(after.skus).toEqual(before.skus);
 });
 it.each([{payType:'cash' as const,sms:false},{payType:'offline' as const,sms:true}])('keeps legacy guest $payType refusal, renewed physical holds and delayed accountless notices bound to the original UUID',async({payType,sms})=>{
  await importedFinancial(0,payType);await f.maintenanceDb.update(storeOrder).set({userPhone:'00000000000'}).where(eq(storeOrder.id,1));const first=await refundLegacy(1,1),firstSplit=(await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,first.refundId)))[0],id=firstSplit.remainingOrderId!,sourceOrder=(await f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
  const created=await service().create(context(),await creation(id,1));expect(created.receipt?.outcome).toBe('refund-created');const refusedId=Number(created.receipt!.evidence.refund_id),actual=(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refusedId)))[0],review=(await service().reader.review(f.actor(),refusedId,{refund_no:actual.orderId})).data;
  const refusalBody=await input({refund_id:refusedId,refund_no:actual.orderId,expected_refund_revision:review.refund_revision,review_fingerprint:review.review_fingerprint,decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false},reason:'游客实际拒绝后重新申请'},id),refusalContext=context(),refused=await service().execute('refund_refuse',refusalContext,refusalBody);expect(refused.receipt?.outcome).toBe('refused');
  expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)))[0].refundNum).toBe(0);
  const event=(await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,`order.refund.refused.notice:${refusedId}`)))[0];expect(event.payload).toEqual({orderId:id,orderNo:sourceOrder.orderId,refundId:refusedId,userId:0,payPrice:'10.00'});
  const retry=await service().create(context(),await creation(id,1));expect(retry.receipt?.outcome).toBe('refund-created');const retryId=Number(retry.receipt!.evidence.refund_id);expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)))[0].refundNum).toBe(1);
  await f.maintenanceDb.insert(systemNotification).values({mark:'send_order_refund_no_status',isSystem:1,isWechat:1,isRoutine:1,isSms:sms?1:0,smsId:'native-refusal-sms',systemTitle:'拒绝通知',systemText:'实际拒绝'});
  const restricted='public.cashier_second_card_cart_v1,public.cashier_second_card_origin_v1,public.cashier_second_card_payment_v1',role=`"${f.role}"`;
  const consume=async()=>{await f.exec(`REVOKE SELECT ON ${restricted} FROM ${role}`);try{await f.withPeer(async db=>{const [permissions]=await db.execute<{origin:boolean;payment:boolean;cart:boolean}>(sql`SELECT has_table_privilege(current_user,'public.cashier_second_card_origin_v1','SELECT') AS origin,has_table_privilege(current_user,'public.cashier_second_card_payment_v1','SELECT') AS payment,has_table_privilege(current_user,'public.cashier_second_card_cart_v1','SELECT') AS cart`);expect(permissions).toEqual({origin:false,payment:false,cart:false});expect(await withTx(createContainerFromDb(db),tx=>processOrderNotificationOutboxEvent(tx,event,Math.floor(Date.now()/1000)))).toBe('disabled');});}finally{await f.exec(`GRANT SELECT ON ${restricted} TO ${role}`);}};
  await consume();await executeExisting(retryId,id);expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0].payPrice).toBe('5.00');await consume();
  expect((await service().status(f.actor(),refusalContext.request_key)).receipt).toEqual(refused.receipt);expect((await service().execute('refund_refuse',refusalContext,refusalBody)).receipt).toEqual(refused.receipt);
  expect(await f.db.select().from(systemMessage)).toEqual([]);const deliveries=await f.db.select().from(orderNotificationDelivery);expect(deliveries).toHaveLength(sms?1:0);if(sms)expect(deliveries[0]).toMatchObject({userId:0,orderId:id,eventKey:event.eventKey,channel:'sms',target:'00000000000',status:'PENDING',templateCode:'native-refusal-sms',payload:{kind:'sms',params:{order_id:sourceOrder.orderId}}});expect((await facts()).accounts.some(a=>a.uid===0)).toBe(false);expect((await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,event.id)))[0].payload).toEqual(event.payload);
 });
 it('consumes a genuine TS cashier guest refusal on an independent LOGIN with no cashier-origin realm SELECT',async()=>{
  const source=await f.cashier(0),id=source.order.id,created=await service().create(context(),await creation(id,1)),refusedId=Number(created.receipt!.evidence.refund_id),actual=(await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refusedId)))[0],review=(await service().reader.review(f.actor(),refusedId,{refund_no:actual.orderId})).data;
  const body=await input({refund_id:refusedId,refund_no:actual.orderId,expected_refund_revision:review.refund_revision,review_fingerprint:review.review_fingerprint,decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false},reason:'真实TS游客拒绝'},id),ctx=context(),done=await service().execute('refund_refuse',ctx,body);expect(done.receipt?.outcome).toBe('refused');const event=(await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,`order.refund.refused.notice:${refusedId}`)))[0];expect(event.payload).toEqual({orderId:id,orderNo:source.order.orderId,refundId:refusedId,userId:0,payPrice:source.order.payPrice});
  const retry=await service().create(context(),await creation(id));expect(retry.receipt?.outcome).toBe('refund-created');expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)))[0].refundNum).toBe(2);
  const restricted='public.cashier_second_card_cart_v1,public.cashier_second_card_origin_v1,public.cashier_second_card_payment_v1',role=`"${f.role}"`;await f.exec(`REVOKE SELECT ON ${restricted} FROM ${role}`);
  try{await f.withPeer(async db=>{const [permissions]=await db.execute(sql`SELECT has_table_privilege(current_user,'public.cashier_second_card_origin_v1','SELECT') AS origin,has_table_privilege(current_user,'public.cashier_second_card_payment_v1','SELECT') AS payment,has_table_privilege(current_user,'public.cashier_second_card_cart_v1','SELECT') AS cart`);expect(permissions).toEqual({origin:false,payment:false,cart:false});expect(await withTx(createContainerFromDb(db),tx=>processOrderNotificationOutboxEvent(tx,event,Math.floor(Date.now()/1000)))).toBe('disabled');});}finally{await f.exec(`GRANT SELECT ON ${restricted} TO ${role}`);}
  const originalClaim=actual.cartInfo!,privateClaim=JSON.parse(originalClaim);privateClaim.quantityReservation.version='refund-quantity-reservation-v1';privateClaim.cartIds=privateClaim.cartIds.map(({sourceCartId:_source,...selection}:{sourceCartId:string})=>selection);privateClaim.quantityReservation.items=privateClaim.quantityReservation.items.map(({sourceCartId:_source,...item}:{sourceCartId:string})=>item);
  try{await f.maintenanceDb.update(storeOrderRefund).set({cartInfo:JSON.stringify(privateClaim)}).where(eq(storeOrderRefund.id,refusedId));const before=await facts();await f.withPeer(async db=>{await expect(withTx(createContainerFromDb(db),tx=>processOrderNotificationOutboxEvent(tx,event,Math.floor(Date.now()/1000)))).rejects.toThrow();});expect(await facts()).toEqual(before);}finally{await f.maintenanceDb.update(storeOrderRefund).set({cartInfo:originalClaim}).where(eq(storeOrderRefund.id,refusedId));}
  expect((await service().status(f.actor(),ctx.request_key)).receipt).toEqual(done.receipt);await executeExisting(Number(retry.receipt!.evidence.refund_id),id);expect(await f.db.select().from(systemMessage)).toEqual([]);expect(await f.db.select().from(orderNotificationDelivery)).toEqual([]);expect((await facts()).accounts.some(a=>a.uid===0)).toBe(false);
 });
 it.each(['changed-frozen','deleted-frozen','noncanonical-addition','ts-addition'] as const)('rejects historical proof recovery after %s rather than disguising payment contradiction',async kind=>{
  await importedFinancial(0,'cash');const done=await refundLegacy();
  if(kind==='changed-frozen')await f.maintenanceDb.update(storeOrderStatus).set({changeTime:paidTime+86400}).where(eq(storeOrderStatus.changeType,'pay_success'));
  if(kind==='deleted-frozen')await f.maintenanceDb.delete(storeOrderStatus).where(eq(storeOrderStatus.changeType,'pay_success'));
  if(kind==='noncanonical-addition')await f.maintenanceDb.insert(storeOrderStatus).values({oid:1,changeType:'pay_success',changeMessage:'contradictory job data',changeTime:paidTime+86400});
  if(kind==='ts-addition')await f.maintenanceDb.insert(storeOrderStatus).values({oid:1,changeType:'customer_cashier_paid',changeMessage:'mixed TS evidence',changeTime:paidTime});
  const before=await facts(),current=await service().status(f.actor(),done.ctx.request_key);expect(current.receipt).toEqual(done.done.receipt);expect(current.execution).toMatchObject({status:'UNKNOWN',completed:false,verified:false});expect(await facts()).toEqual(before);
 });
 it.each(['missing-price','wrong-total','wrong-quantity','wrong-sku','modern-metadata','modern-aliases'] as const)('refuses incomplete original PHP financial evidence %s before any reservation or proof',async kind=>{
  const imported=await importedFinancial(),raw:Record<string,unknown>={...imported.original};
  if(kind==='missing-price')delete raw.costPrice;if(kind==='wrong-total')raw.sum_true_price='14.99';if(kind==='wrong-quantity')raw.cart_num=2;if(kind==='wrong-sku')raw.productInfo={...imported.original.productInfo,attrInfo:{...imported.original.productInfo.attrInfo,unique:'different'}};if(kind==='modern-metadata')raw.promotion_quote_version='invalid';if(kind==='modern-aliases'){raw.product={id:70};raw.sku={id:1,write_times:1};}
  await f.maintenanceDb.update(storeOrderCartInfo).set({cartInfo:JSON.stringify(raw)}).where(eq(storeOrderCartInfo.id,1));const before=await facts();await expect(creation()).rejects.toThrow();expect(await facts()).toEqual(before);
 });
});
