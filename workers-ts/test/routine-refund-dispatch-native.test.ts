/** Real PG16 five-LOGIN commissioning, generated independent RSA/AES and
 * production Financial/App consumers. Provider, Queue and KV transports are
 * local; no production merchant, historical adoption or deployment is claimed. */
import { createCipheriv, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import * as Di from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, storeOrderRefundSplit,
  storeProduct, systemConfig, user, wechatUser } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { inspectAdminWechatAppOperation } from '@/migrations/adminWechatAppOperation';
import { inspectNativeAppPaymentAuthority } from '@/migrations/nativeAppPaymentAuthority';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineRefundAccountPolicy, type RoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { CustomerWorkFinancialService } from '@/services/customer-work/CustomerWorkFinancialService';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { StoreOrderRefundService, finalizeStoreOrderRefund } from '@/services/order/StoreOrderRefundService';
import { authorizeCustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '@/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_QUOTE_VERSION, CUSTOMER_FINANCIAL_VERSION,
  type FinancialContext, type FinancialInput } from '@/services/customer-work/CustomerWorkFinancialProtocol';
import type { CustomerJson } from '@/services/customer-work/CustomerWorkOperationRequest';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP='wx_refund_original', MERCHANT='1900000001', REF='refund_original_materials', ACCOUNT='refund_original_account';
const CURRENT_APP='wx_refund_unrelated', CURRENT_MERCHANT='1900000002', SERIAL='A1B2C3D4', PLATFORM='PUB_REFUND_ORIGINAL';
const AES='r'.repeat(32), PAYER='refund_provider_payer_not_buyer_binding',BUYER_BINDING='refund_buyer_unrelated_current_binding';
const ORIGIN='https://refund-fixture.example';
type Fixture=Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Keys=ReturnType<typeof paymentQueryKeys>;
type Signed={body:string;headers:Record<string,string>};
type DispatchRow={dispatch_id:string;refund_id:number;out_refund_no:string;payload:{actor:{kind:string;actorUid?:number;requestKey?:string};
 request:{outTradeNo:string;transactionId:string;outRefundNo:string;refundAmount:number;totalAmount:number;reason:string};
 approval:{appId:string;merchantId:string};original:{evidenceId:string};notifyUrl:string};signature:string};

function envelope(keys:Keys,payload:unknown,kind:'transaction'|'refund',eventId=randomUUID(),
 materials={apiV3Key:AES,platformPublicKeyId:PLATFORM}):Signed {
  const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated=kind;
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(materials.apiV3Key),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const eventType=kind==='refund'?'REFUND.'+(payload as {refund_status:string}).refund_status:'TRANSACTION.SUCCESS';
  const body=JSON.stringify({id:eventId,event_type:eventType,resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',
    original_type:kind,ciphertext,nonce,associated_data:associated}});
  const timestamp=String(Math.floor(Date.now()/1000));
  return{body,headers:{'content-type':'application/json','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,
    'wechatpay-serial':materials.platformPublicKeyId,'wechatpay-signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}};
}
function signedResponse(keys:Keys,value:unknown,status=200):Response {
  const body=JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000)),nonce='refund-response-'+randomUUID();
  return new Response(body,{status,headers:{'Content-Type':'application/json','Wechatpay-Timestamp':timestamp,
    'Wechatpay-Nonce':nonce,'Wechatpay-Serial':PLATFORM,
    'Wechatpay-Signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}});
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('original Routine refund dispatch through actual Financial and provider verification',()=>{
  let f:Fixture,keys:Keys,currentKeys:Keys,service:CustomerWorkFinancialService,peers:RuntimeGiftPeerDeclarations;
  let policyRevision=0,registry='',policy:RoutineRefundAccountPolicy,lastPolicyState:'active'|'revoked'='active';
  let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>;
  let connections:MockInstance<typeof Di.createDbFromConnectionString>;
  const logs:unknown[]=[];
  const noSecrets=(value:unknown)=>{
    const text=JSON.stringify(value);
    for(const secret of[PAYER,BUYER_BINDING,AES,f.env.APP_KEY,'BEGIN PRIVATE KEY'])expect(text).not.toContain(secret);
  };
  const context=(request_key=randomUUID()):FinancialContext=>({actor:f.actor(),request_key});
  const order=async(id:number)=>(await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
  const refund=async(id:number)=>(await f.maintenanceDb.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,id)))[0];
  const payment=async(id:number)=>(await f.maintenanceDb.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,id)))[0];
  const dispatch=async(id:number)=>{
    const rows=await f.maintenanceDb.execute<DispatchRow>(sql`SELECT * FROM public.routine_refund_dispatch WHERE refund_id=${id}`);
    expect(rows).toHaveLength(1);return rows[0];
  };
  const immutable=async(id:number)=>{
    const d=await dispatch(id);
    return{dispatch:Array.from(await f.maintenanceDb.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS xmin
      FROM public.routine_refund_dispatch t WHERE refund_id=${id}`)),
      results:Array.from(await f.maintenanceDb.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS xmin
      FROM public.routine_refund_provider_evidence t WHERE dispatch_id=${d.dispatch_id} ORDER BY evidence_id`))};
  };
  const input=async(payload:CustomerJson,id:number):Promise<FinancialInput>=>{
    const actual=await order(id),scope=await authorizeCustomerWorkActor(f.financialRuntime.db,f.actor()),state=await financialRevisions(f.financialRuntime.db,actual);
    return{version:CUSTOMER_FINANCIAL_VERSION,scope_key:scope.scope_key,order_id:id,
      expected_order_revision:state.order_revision,expected_financial_revision:state.financial_revision,payload};
  };
  const appendPolicy=async(state:'active'|'revoked'='active')=>{
    const receipt=await appendRoutineRefundAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),
      expectedRevision:policyRevision,data:{...policy,state}});
    policyRevision=receipt.revision;lastPolicyState=state;return receipt;
  };
  const clearCurrent=()=>f.maintenanceDb.update(systemConfig).set({value:'""'}).where(inArray(systemConfig.menuName,
    ['routine_appId','wechat_appid','pay_weixin_mchid','pay_weixin_serial_no']));
  const post=async(path:string,signed:Signed)=>{
    const h=new Hono<{Bindings:Env;Variables:AppVariables}>(),pending:Promise<unknown>[]=[];
    h.use('*',async(c,next)=>{c.set('container',createContainerFromDb(f.appRuntime.db));await next();});
    h.onError(errorHandler);h.route('/api',v1Routes);
    const response=await h.request('/api'+path,{method:'POST',headers:signed.headers,body:signed.body},f.env,
      {waitUntil:(promise:Promise<unknown>)=>pending.push(promise),props:{},passThroughOnException:()=>{throw Error('Unexpected provider fallback');}});
    await Promise.all(pending);
    const body=await response.text();noSecrets(body);return{status:response.status,body};
  };
  const originalPaid=async()=>{
    // A real assisted producer creates the unpaid row; production verified
    // payment capture/default App consumer owns the paid transition and source.
    await f.maintenanceDb.update(storeProduct).set({productType:0}).where(eq(storeProduct.id,70));
    const created=await f.unpaid(11,'5.00',2),before=f.messages.length,transactionId='original_tx_'+randomUUID().replaceAll('-','');
    const signed=envelope(keys,{appid:APP,mchid:MERCHANT,out_trade_no:created.order.orderId,transaction_id:transactionId,
      trade_state:'SUCCESS',trade_type:'JSAPI',payer:{openid:PAYER},success_time:new Date().toISOString(),
      amount:{total:1000,currency:'CNY'}},'transaction');
    const response=await post('/pay/notify/routine-account/'+ACCOUNT,signed);expect(response.status).toBe(200);
    const message=f.messages.slice(before).find(isPaymentCallbackMessage);expect(message).toBeDefined();
    expect(Object.keys(message!).sort()).toEqual(['action','eventId','replayKey']);
    const callbacks=new PaymentCallbackEventService(createContainerFromDb(f.appRuntime.db),f.env);
    expect(await callbacks.processMessage(message!)).toBe('completed');
    const actual=await order(created.order.id);expect(actual).toMatchObject({paid:1,payType:'weixin',tradeNo:transactionId,payPrice:'10.00'});
    const originals=await f.maintenanceDb.execute<{row:unknown}>(sql`SELECT to_jsonb(t) AS row FROM public.routine_original_payment_evidence t
      WHERE order_no=${actual.orderId}`);
    expect(originals).toHaveLength(1);
    expect(parseRoutineOriginalEvidence(f.env,originals[0].row)).toMatchObject({payload:{binding:{state:'bound',local:{domain:'store_order',orderId:actual.id,buyerUid:11}},
      observation:{facts:{appId:APP,merchantId:MERCHANT,payerId:PAYER,tradeType:'JSAPI',tradeState:'SUCCESS'}}}});
    const uses=await f.maintenanceDb.execute(sql`SELECT u.use_id FROM public.routine_payment_account_use u
      JOIN public.routine_original_payment_evidence e ON e.evidence_id=u.evidence_id WHERE e.order_no=${actual.orderId}`);
    expect(uses).toHaveLength(1);
    const outboxes=await f.maintenanceDb.execute<{id:number;event_key:string}>(sql`SELECT id,event_key FROM public.store_order_outbox
      WHERE aggregate_id=${actual.id} AND event_type='order.paid'`);
    expect(outboxes).toHaveLength(1);await f.consume({id:outboxes[0].id,eventKey:outboxes[0].event_key});
    return actual;
  };
  const createRefund=async()=>{
    const root=await originalPaid(),items=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id));
    expect(items).toHaveLength(1);
    const selected=[{cart_row_id:items[0].id,cart_num:1}],base=await input({},root.id);
    const quote=(await service.reader.quote(f.actor(),{version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:base.scope_key,
      order_id:root.id,expected_order_revision:base.expected_order_revision,expected_financial_revision:base.expected_financial_revision,
      mode:'items',items:selected})).data;
    expect(quote.quoted_price).toBe('5.00');
    const created=await service.create(context(),await input({mode:'items',items:selected,quoted_price:quote.quoted_price,
      refund_price:quote.quoted_price,quote_fingerprint:quote.quote_fingerprint,reason:'真实原账号退款，保留完整首次受理原因'},root.id));
    expect(created.receipt?.outcome).toBe('refund-created');
    const id=Number(created.receipt!.evidence.refund_id),actual=await refund(id),review=(await service.reader.review(f.actor(),id,{refund_no:actual.orderId})).data;
    const body=await input({refund_id:id,refund_no:review.refund_no,expected_refund_revision:review.refund_revision,
      review_fingerprint:review.review_fingerprint,decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false},
      refund_price:review.refund_price},root.id);
    return{id,root,body,ctx:context()};
  };
  const providerBody=(d:DispatchRow,status='PROCESSING')=>({mchid:MERCHANT,out_trade_no:d.payload.request.outTradeNo,
    transaction_id:d.payload.request.transactionId,out_refund_no:d.out_refund_no,refund_id:'provider_'+d.out_refund_no,
    status,success_time:status==='SUCCESS'?new Date().toISOString():undefined,
    amount:{refund:d.payload.request.refundAmount,total:d.payload.request.totalAmount,currency:'CNY'}});
  const assertArchivedRequest=async(url:RequestInfo|URL,init:RequestInit|undefined,id:number)=>{
    expect(typeof url).toBe('string');expect(init).toBeDefined();
    const u=new URL(String(url)),headers=new Headers(init!.headers),auth=headers.get('Authorization')??'';
    const fields=Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/gu)].map(match=>[match[1],match[2]]));
    expect(fields.mchid).toBe(MERCHANT);expect(fields.serial_no).toBe(SERIAL);
    const bytes=Buffer.from(`${init!.method}\n${u.pathname}${u.search}\n${fields.timestamp}\n${fields.nonce_str}\n${typeof init!.body==='string'?init!.body:''}\n`);
    expect(verify('RSA-SHA256',bytes,keys.publicKey,Buffer.from(fields.signature,'base64'))).toBe(true);
    expect(verify('RSA-SHA256',bytes,currentKeys.publicKey,Buffer.from(fields.signature,'base64'))).toBe(false);
    expect(u.origin).toBe('https://api.mch.weixin.qq.com');
    await f.withMaintenancePeer(async peer=>withTx(createContainerFromDb(peer),async tx=>{
      const d=await dispatch(id);
      expect(await tx.execute(sql`SELECT id FROM public.store_order WHERE order_id=${d.payload.request.outTradeNo} FOR UPDATE NOWAIT`)).toHaveLength(1);
      expect(await tx.execute(sql`SELECT id FROM public.store_order_refund WHERE id=${id} FOR UPDATE NOWAIT`)).toHaveLength(1);
      const[row]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
        WHERE usename IN(${f.appRuntime.role},${f.financialRuntime.role}) AND state='idle in transaction'`);
      expect(row.n).toBe(0);
    }));
    return await dispatch(id);
  };
  const callback=async(d:DispatchRow,eventId=randomUUID())=>{
    const response=providerBody(d,'SUCCESS'),{status,...rest}=response;
    return envelope(keys,{...rest,refund_status:status},'refund',eventId);
  };

  beforeAll(async()=>{
    keys=paymentQueryKeys();currentKeys=paymentQueryKeys();
    // Deny unplanned provider I/O during all commissioning and setup.
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unstubbed external provider transport'));
    for(const name of['log','warn','error'] as const)vi.spyOn(console,name).mockImplementation((...args:unknown[])=>{logs.push(args);});
    f=await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    const commissioned=await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,
      {routineRefund:{routineRefund:true},manualRefund:f.manual,originalPaymentReaders:f.readers},f.peers,f.appReaders);
    peers=commissioned.peers;
    // All full peers/readers remain explicit. Omission must not silently grant
    // a legacy installer permission to disregard their existing source ACLs.
    await expect(runAdminWechatAppUpgrade(f.maintenanceDb,f.target)).rejects.toThrow('exact existing runtime profiles');
    const nativeTarget={...f.target,local:[...(f.target.local??[])],...(f.target.caseLock?{caseLock:{
      owner:f.target.caseLock.owner,runtimeRoles:[...f.target.caseLock.runtimeRoles]}}:{})},
      nativePeers=structuredClone(peers),nativeReader={...f.appReaders};
    const installation=runAdminWechatAppUpgrade(f.maintenanceDb,nativeTarget,nativePeers,nativeReader);
    nativeTarget.database='late_changed';nativeTarget.local?.splice(0);nativePeers.target.database='late_changed';
    if(!nativePeers.financial?.manualRefund)throw Error('Complete Financial manual addon declaration required');
    nativePeers.financial.manualRefund.promotionOwner='late_changed';
    Reflect.set(nativeReader,'cashierOrigin',false);
    expect(await installation).toMatchObject({applied:true});
    expect(await inspectAdminWechatAppOperation(f.maintenanceDb,f.target)).toBe(true);
    expect(await inspectNativeAppPaymentAuthority(f.maintenanceDb,f.target)).toBe(true);
    const nativeCatalog=async()=>Array.from(await f.maintenanceDb.execute(sql`SELECT c.oid::text,c.relname,c.relowner::text,c.relacl::text
      FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
       AND (c.relname LIKE 'native_app_payment_%' OR c.relname LIKE 'admin_wechat_app_operation%') ORDER BY c.oid`));
    const catalogBefore=await nativeCatalog(),businessBefore=await f.facts();
    expect(await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,peers,f.appReaders)).toMatchObject({applied:false});
    expect(await nativeCatalog()).toEqual(catalogBefore);expect(await f.facts()).toEqual(businessBefore);
    expect(await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db,f.target,f.manual,f.readers,{routineRefund:true}))
      .toMatchObject({ready:true,realLogin:true});
    const pids=await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(role=>role.verify()));
    expect(new Set(pids).size).toBe(5);
    registry=JSON.stringify({format:1,credentials:[{ref:REF,version:1,appId:APP,merchantId:MERCHANT,serialNo:SERIAL,apiV3Key:AES,
      privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:PLATFORM}]});
    Object.assign(f.env,{ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:registry,ROUTINE_REFUND_NOTIFY_ORIGIN:ORIGIN,
      WECHAT_MCH_PRIVATE_KEY:currentKeys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:currentKeys.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID:'PUB_CURRENT_UNRELATED',WECHAT_API_V3_KEY:'b'.repeat(32)});
    await f.maintenanceDb.insert(user).values({uid:22,account:'owned-original-payer',pwd:'owned-payer-password',status:1,nowMoney:'23.00'}).onConflictDoNothing();
    await f.maintenanceDb.insert(wechatUser).values([{uid:22,userType:'routine',openid:PAYER},
      {uid:11,userType:'routine',openid:BUYER_BINDING}]);
    const values={routine_appId:CURRENT_APP,wechat_appid:CURRENT_APP,pay_weixin_mchid:CURRENT_MERCHANT,
      pay_weixin_serial_no:'B1B2B3B4',pay_weixin_open:1,site_url:'https://current-unrelated.example'};
    await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
    await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
    const now=Math.floor(Date.now()/1000),commitment=routinePaymentCredentialCommitment(f.env,REF,1);
    await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',
      data:{accountId:ACCOUNT,state:'active',...commitment,credentialRef:REF,credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+3600}});
    policy={accountId:ACCOUNT,state:'active',...commitment,credentialRef:REF,credentialVersion:1,
      purposes:['refund_request','refund_query','refund_notify'],validFrom:now-60,validUntil:now+3600};
    await appendPolicy();service=new CustomerWorkFinancialService(f.container,f.env);
    // Observe the unchanged real factory; do not replace its connection, SQL,
    // verifier or role proof. The three success cases must reach the separate
    // App RC/RO branch even when current merchant configuration is B or empty.
    connections=vi.spyOn(Di,'createDbFromConnectionString');
  },180000);
  beforeEach(async()=>{
    network.mockReset().mockRejectedValue(Error('Unstubbed external provider transport'));
    connections.mockClear();
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;
    if(lastPolicyState==='revoked')await appendPolicy();
  });
  afterEach(()=>{
    const proofConnections=connections.mock.calls.filter(call=>call[2]?.applicationName==='cinashop_routine_refund_verify');
    expect(proofConnections.length).toBeGreaterThan(0);
    for(const call of proofConnections){
      // Keep even an assertion failure from printing the owned LOGIN password.
      expect(call[0]===f.appRuntime.connectionString).toBe(true);expect(call[1]).toBe(1);
      expect(call[2]).toEqual({searchPath:'public,pg_temp',applicationName:'cinashop_routine_refund_verify'});
    }
    noSecrets(logs);noSecrets(f.messages);
  });
  afterAll(async()=>{
    try{
      if(f){for(const[role,kind]of[[f.appRuntime,'app'],[f.adminRuntime,'admin']] as const)
        expect(await auditRuntimeBusinessPrivileges(role.db,kind,f.target,undefined,peers,kind==='app'?f.appReaders:undefined)).toMatchObject({ready:true,failures:[]});}
    }finally{try{await f?.close();}finally{vi.restoreAllMocks();}}
  },30000);

  it('pins a live Financial receipt and original A POST, queries A SUCCESS, materializes the split and reads durable status after revocation',async()=>{
    const savedBindings=await f.maintenanceDb.select().from(wechatUser),[payerBefore]=await f.maintenanceDb.select().from(user).where(eq(user.uid,22));
    const c=await createRefund();
    network.mockImplementation(async(url,init)=>{
      const d=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({out_refund_no:'CNSR'+c.id,transaction_id:c.root.tradeNo,
        notify_url:ORIGIN+'/api/pay/notify/routine-refund/'+d.dispatch_id,amount:{refund:500,total:1000,currency:'CNY'}});
      return signedResponse(keys,providerBody(d));
    });
    const admitted=await service.execute('refund_execute',c.ctx,c.body);
    expect(admitted).toMatchObject({receipt:{actor_uid:101,outcome:'provider-admitted',evidence:{refund_id:c.id,provider:'wechat'}},
      execution:{status:'PROCESSING',completed:false,can_resume:true}});
    const d=await dispatch(c.id);expect(d.payload.actor).toMatchObject({kind:'financial',actorUid:101,requestKey:c.ctx.request_key});
    expect(d.payload.approval).toMatchObject({appId:APP,merchantId:MERCHANT});
    const firstDispatch=(await immutable(c.id)).dispatch;
    network.mockImplementation(async(url,init)=>{
      const d=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');
      // The real GET has left SQL. A concurrent maintenance revocation cannot
      // erase the subsequently authenticated result of that authorized call.
      await appendPolicy('revoked');return signedResponse(keys,providerBody(d,'SUCCESS'));
    });
    const completed=await service.execute('refund_execute',c.ctx,c.body);
    expect(completed).toMatchObject({receipt:admitted.receipt,execution:{status:'SUCCESS',completed:true,verified:true}});
    expect(network).toHaveBeenCalledTimes(2);expect((await immutable(c.id)).dispatch).toEqual(firstDispatch);
    expect(await refund(c.id)).toMatchObject({refundType:6,refundedPrice:'5.00'});
    const [split]=await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,c.id));
    expect(split).toMatchObject({sourceOrderId:c.root.id,paymentOrderId:c.root.id,disposition:'split'});
    expect(split.selectedOrderId).not.toBe(c.root.id);expect(split.remainingOrderId).toBeGreaterThan(0);
    expect(await order(c.root.id)).toMatchObject({pid:-1,payPrice:'10.00',tradeNo:c.root.tradeNo,uid:11});
    expect(await order(split.remainingOrderId!)).toMatchObject({pid:c.root.id,payPrice:'5.00',uid:11});
    const stable=await immutable(c.id),business=await f.facts(),calls=network.mock.calls.length;
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=undefined;
    await clearCurrent();
    expect(await service.status(f.actor(),c.ctx.request_key)).toMatchObject({receipt:admitted.receipt,execution:{status:'SUCCESS',completed:true,verified:true}});
    expect(await service.execute('refund_execute',c.ctx,c.body)).toMatchObject({receipt:admitted.receipt,execution:{status:'SUCCESS',completed:true}});
    expect(network).toHaveBeenCalledTimes(calls);expect(await immutable(c.id)).toEqual(stable);expect(await f.facts()).toEqual(business);
    expect(await f.maintenanceDb.select().from(wechatUser)).toEqual(savedBindings);
    expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0]).toEqual(payerBefore);
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;await appendPolicy();
    noSecrets(completed);
  },90000);

  it('admits a fresh refund with cleared current config and accepts genuine dedicated callback replay without changing first evidence xmin',async()=>{
    await clearCurrent();
    const c=await createRefund();
    network.mockImplementation(async(url,init)=>{
      const d=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('POST');return signedResponse(keys,providerBody(d));
    });
    const admitted=await service.execute('refund_execute',c.ctx,c.body);expect(admitted.receipt?.outcome).toBe('provider-admitted');
    const d=await dispatch(c.id),signed=await callback(d);
    expect((await post('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(204);
    expect(await service.status(f.actor(),c.ctx.request_key)).toMatchObject({receipt:admitted.receipt,execution:{status:'SUCCESS',completed:true,verified:true}});
    const first=await immutable(c.id),business=await f.facts();expect(first.results).toHaveLength(2);
    // Ensure this replay has a different volatile verification time, while
    // retaining the same signed provider event/body and stable business facts.
    await new Promise(resolve=>setTimeout(resolve,1100));
    expect((await post('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(204);
    expect(await immutable(c.id)).toEqual(first);expect(await f.facts()).toEqual(business);expect(network).toHaveBeenCalledOnce();
    const invalid={...signed,headers:{...signed.headers,'wechatpay-serial':'PUB_CURRENT_UNRELATED'}};
    expect((await post('/pay/notify/routine-refund/'+d.dispatch_id,invalid)).status).toBe(400);
    expect(await immutable(c.id)).toEqual(first);expect(await f.facts()).toEqual(business);
  },90000);

  it('keeps a lost POST UNKNOWN, refuses unsigned 404 and retries only after signed cross-second NOT_FOUND on the same CNSR',async()=>{
    await clearCurrent();
    const c=await createRefund();let posts=0,queries=0;
    network.mockImplementation(async(url,init)=>{
      await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('POST');posts++;throw Error('Owned transport lost after POST was sent');
    });
    const uncertain=await service.execute('refund_execute',c.ctx,c.body);
    expect(uncertain).toMatchObject({receipt:{outcome:'provider-admitted'},execution:{status:'UNKNOWN',completed:false,can_resume:true}});
    const d=await dispatch(c.id),first=(await immutable(c.id)).dispatch;
    expect(await payment(c.id)).toMatchObject({outRefundNo:d.out_refund_no,attemptCount:1,providerStatus:'UNKNOWN'});
    expect((await immutable(c.id)).results).toHaveLength(0);
    network.mockImplementation(async(url,init)=>{
      await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');queries++;
      return new Response(JSON.stringify({code:'RESOURCE_NOT_EXISTS',message:'No unverified response can authorize resend'}),{status:404});
    });
    expect(await service.execute('refund_execute',c.ctx,c.body)).toMatchObject({receipt:uncertain.receipt,execution:{status:'UNKNOWN',completed:false}});
    expect(posts).toBe(1);expect((await immutable(c.id)).results).toHaveLength(0);
    network.mockImplementation(async(url,init)=>{
      const current=await assertArchivedRequest(url,init,c.id);
      if(init?.method==='GET'){
        queries++;
        // Real provider latency crosses the SQL claim second. The same-lease
        // verified NOT_FOUND must still support one explicit CNSR retry.
        await new Promise(resolve=>setTimeout(resolve,1100));
        return signedResponse(keys,{code:'RESOURCE_NOT_EXISTS',message:'Owned signed no such refund'},404);
      }
      expect(init?.method).toBe('POST');posts++;
      expect(JSON.parse(String(init?.body)).out_refund_no).toBe(d.out_refund_no);
      return signedResponse(keys,providerBody(current));
    });
    const recovered=await service.execute('refund_execute',c.ctx,c.body);
    expect(recovered).toMatchObject({receipt:uncertain.receipt,execution:{status:'PROCESSING',completed:false,can_resume:true}});
    expect(posts).toBe(2);expect(queries).toBe(2);expect(await payment(c.id)).toMatchObject({attemptCount:2,outRefundNo:d.out_refund_no,providerStatus:'PROCESSING'});
    expect((await immutable(c.id)).dispatch).toEqual(first);
    const signed=await callback(d);
    expect((await post('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(204);
    expect(await service.status(f.actor(),c.ctx.request_key)).toMatchObject({receipt:uncertain.receipt,execution:{status:'SUCCESS',completed:true,verified:true}});
    noSecrets(recovered);
  },90000);

  it('refuses the same physical Routine root after a real RSA/AES APP SUCCESS, without lending NativeApp SELECT to Financial',async()=>{
    await clearCurrent();const c=await createRefund(),nativeApp='wx_native_refund_conflict';
    // Isolated maintenance config is solely the NativeApp verifier's current
    // public cohort. It neither fabricates a provider fact nor assigns history.
    const values={wechat_app_appid:nativeApp,pay_weixin_mchid:CURRENT_MERCHANT,
      pay_weixin_serial_no:'B1B2B3B4',site_url:'https://current-unrelated.example'};
    await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
    await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
    const eventId=randomUUID(),transaction='native_conflict_'+randomUUID().replaceAll('-','');
    const signed=envelope(currentKeys,{appid:nativeApp,mchid:CURRENT_MERCHANT,out_trade_no:c.root.orderId,
      transaction_id:transaction,trade_state:'SUCCESS',trade_type:'APP',success_time:new Date().toISOString(),
      amount:{total:1000,currency:'CNY'}},'transaction',eventId,
      {apiV3Key:'b'.repeat(32),platformPublicKeyId:'PUB_CURRENT_UNRELATED'});
    const pay=new WechatPayService(createContainerFromDb(f.appRuntime.db),f.env);
    const invalid={...signed.headers,'wechatpay-signature':'invalid'};
    await expect(pay.verifyAndParseNotify(invalid,signed.body,'app')).rejects.toThrow();
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.native_app_payment_evidence WHERE order_no=${c.root.orderId}`)).toHaveLength(0);
    expect(await pay.verifyAndParseNotify(signed.headers,signed.body,'app')).toMatchObject({appId:nativeApp,
      merchantId:CURRENT_MERCHANT,outTradeNo:c.root.orderId,transactionId:transaction,tradeState:'SUCCESS'});
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id,kind,payload->>'tradeState' AS state,payload->>'tradeType' AS type
      FROM public.native_app_payment_evidence WHERE order_no=${c.root.orderId}`))
      .toEqual([{evidence_id:'callback:'+eventId,kind:'callback',state:'SUCCESS',type:'APP'}]);
    await expect(f.financialRuntime.db.execute(sql`SELECT * FROM public.native_app_payment_evidence LIMIT 0`)).rejects.toMatchObject({cause:{code:'42501'}});
    // Public configuration and provider facts changed after the initial
    // review. Read the real actor's current review/revisions again so this
    // attempt reaches the NativeApp conflict rather than stale-review refusal.
    const current=await refund(c.id),review=(await service.reader.review(f.actor(),c.id,{refund_no:current.orderId})).data;
    expect(review).toMatchObject({refund_id:c.id,order_id:c.root.id,refund_price:'5.00',refund_type:0});
    const body=await input({refund_id:c.id,refund_no:review.refund_no,expected_refund_revision:review.refund_revision,
      review_fingerprint:review.review_fingerprint,decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false},
      refund_price:review.refund_price},c.root.id);
    const before=await f.facts();
    await expect(service.execute('refund_execute',c.ctx,body)).rejects.toMatchObject({code:503});
    expect(await f.facts()).toEqual(before);expect(await payment(c.id)).toBeUndefined();
    expect(await f.maintenanceDb.execute(sql`SELECT dispatch_id FROM public.routine_refund_dispatch WHERE refund_id=${c.id}`)).toHaveLength(0);
    expect(await order(c.root.id)).toMatchObject({paid:1,payType:'weixin',tradeNo:c.root.tradeNo,uid:11});
    expect(network).not.toHaveBeenCalled();
  },90000);

  it('rejects forged success and unproven mutable SUCCESS, and rolls genuine callback evidence back with a failed projection update',async()=>{
    await clearCurrent();const c=await createRefund();
    network.mockImplementation(async(url,init)=>{const d=await assertArchivedRequest(url,init,c.id);
      expect(init?.method).toBe('POST');return signedResponse(keys,providerBody(d));});
    const admitted=await service.execute('refund_execute',c.ctx,c.body),d=await dispatch(c.id);
    expect(admitted.execution?.status).toBe('PROCESSING');
    const local=new StoreOrderRefundService(createContainerFromDb(f.appRuntime.db),f.env);
    const first=await immutable(c.id),business=await f.facts(),before=await payment(c.id);
    await expect(local.handleRoutineRefundNotification(d.dispatch_id,{status:'SUCCESS',providerRefundId:before.providerRefundId,
      successTime:Math.floor(Date.now()/1000)})).rejects.toMatchObject({code:400,message:'原账号退款结果缺少渠道验签凭据'});
    expect(await immutable(c.id)).toEqual(first);expect(await payment(c.id)).toEqual(before);expect(await f.facts()).toEqual(business);
    // Deliberately forged mutable projection is an adversarial setup, never
    // treated as a real provider fact or used to assert money conservation.
    await f.maintenanceDb.update(storeOrderRefundPayment).set({providerStatus:'SUCCESS',successTime:Math.floor(Date.now()/1000)})
      .where(eq(storeOrderRefundPayment.refundId,c.id));
    expect(await service.status(f.actor(),c.ctx.request_key)).toMatchObject({execution:{status:'UNKNOWN',verified:false,completed:false,can_resume:false}});
    await expect(finalizeStoreOrderRefund(createContainerFromDb(f.appRuntime.db),c.id,undefined,undefined,f.env)).rejects.toMatchObject({code:503});
    expect(await f.facts()).toEqual(business);
    await f.maintenanceDb.update(storeOrderRefundPayment).set({providerStatus:before.providerStatus,successTime:before.successTime,
      providerRefundId:before.providerRefundId}).where(eq(storeOrderRefundPayment.refundId,c.id));
    const signed=await callback(d),paymentBefore=await payment(c.id),appPid=await f.appRuntime.verify();
    // The session lock is an isolated test-only reachability witness: unlike
    // transactional evidence, it survives RAISE/ROLLBACK and proves that the
    // failure occurred at the actual late UPDATE. It is always released below.
    await f.exec(`CREATE FUNCTION public.phase30_refund_projection_fail() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
      SET search_path=pg_catalog AS $body$ BEGIN PERFORM pg_catalog.pg_advisory_lock(731718,${c.id});
      RAISE EXCEPTION 'owned late projection failure'; END $body$`);
    await f.exec('REVOKE ALL ON FUNCTION public.phase30_refund_projection_fail() FROM PUBLIC');
    await f.exec(`CREATE TRIGGER phase30_refund_projection_fail BEFORE UPDATE ON public.store_order_refund_payment
      FOR EACH ROW WHEN (NEW.provider_status='SUCCESS') EXECUTE FUNCTION public.phase30_refund_projection_fail()`);
    try{
      expect((await post('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(400);
      const[reached]=await f.maintenanceDb.execute<{yes:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
        WHERE locktype='advisory' AND pid=${appPid} AND classid=731718::oid AND objid=${c.id}::oid
         AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS yes`);
      expect(reached.yes).toBe(true);
      expect(await immutable(c.id)).toEqual(first);expect(await payment(c.id)).toEqual(paymentBefore);expect(await f.facts()).toEqual(business);
    }finally{
      try{await f.appRuntime.db.execute(sql`SELECT pg_catalog.pg_advisory_unlock(731718,${c.id})`);}
      finally{
        await f.exec('DROP TRIGGER IF EXISTS phase30_refund_projection_fail ON public.store_order_refund_payment');
        await f.exec('DROP FUNCTION IF EXISTS public.phase30_refund_projection_fail()');
      }
    }
    expect((await post('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(204);
    expect((await immutable(c.id)).results).toHaveLength(2);
    expect(await service.status(f.actor(),c.ctx.request_key)).toMatchObject({execution:{status:'SUCCESS',verified:true,completed:true}});
    expect(network).toHaveBeenCalledOnce();
  },90000);

  it('deduplicates genuine PROCESSING facts across leases and restores UNKNOWN without accepting known-positive NOT_FOUND as resend authority',async()=>{
    await clearCurrent();const c=await createRefund();let posts=0,queries=0;
    network.mockImplementation(async(url,init)=>{
      const d=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('POST');posts++;
      return signedResponse(keys,providerBody(d));
    });
    const admitted=await service.execute('refund_execute',c.ctx,c.body),d=await dispatch(c.id);
    expect(admitted).toMatchObject({receipt:{outcome:'provider-admitted'},execution:{status:'PROCESSING',completed:false}});
    expect((await immutable(c.id)).results).toHaveLength(1);
    network.mockImplementation(async(url,init)=>{
      const current=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');queries++;
      return signedResponse(keys,providerBody(current));
    });
    expect(await service.execute('refund_execute',c.ctx,c.body)).toMatchObject({receipt:admitted.receipt,
      execution:{status:'PROCESSING',completed:false}});
    const first=await immutable(c.id);expect(first.results).toHaveLength(2);
    const sources=await f.maintenanceDb.execute<{source:string}>(sql`SELECT source FROM public.routine_refund_provider_evidence
      WHERE dispatch_id=${d.dispatch_id} ORDER BY source`);
    expect(Array.from(sources,row=>row.source)).toEqual(['query','request']);
    const known=await payment(c.id);expect(known).toMatchObject({attemptCount:1,providerStatus:'PROCESSING',
      providerRefundId:'provider_'+d.out_refund_no});

    network.mockImplementation(async(url,init)=>{
      await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');queries++;
      return new Response(JSON.stringify({code:'RESOURCE_NOT_EXISTS',message:'Unsigned absence is not a provider fact'}),{status:404});
    });
    expect(await service.execute('refund_execute',c.ctx,c.body)).toMatchObject({receipt:admitted.receipt,
      execution:{status:'UNKNOWN',completed:false}});
    expect(await payment(c.id)).toMatchObject({attemptCount:1,providerStatus:'UNKNOWN',providerRefundId:known.providerRefundId});
    expect(await immutable(c.id)).toEqual(first);expect(posts).toBe(1);

    network.mockImplementation(async(url,init)=>{
      await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');queries++;
      return signedResponse(keys,{code:'RESOURCE_NOT_EXISTS',message:'Signed absence contradicts the confirmed refund identity'},404);
    });
    expect(await service.execute('refund_execute',c.ctx,c.body)).toMatchObject({receipt:admitted.receipt,
      execution:{status:'UNKNOWN',completed:false}});
    expect(await payment(c.id)).toMatchObject({attemptCount:1,providerStatus:'UNKNOWN',providerRefundId:known.providerRefundId});
    expect(await immutable(c.id)).toEqual(first);expect(posts).toBe(1);

    // Use a later real query lease and a differently encoded, genuinely signed
    // body. Only its financial fact is unchanged; the first raw digest/xmin stay.
    await new Promise(resolve=>setTimeout(resolve,1100));
    network.mockImplementation(async(url,init)=>{
      const current=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');queries++;
      const reordered={user_received_account:'Non-financial provider response annotation',
        ...Object.fromEntries(Object.entries(providerBody(current)).reverse())};
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(providerBody(current)));
      return signedResponse(keys,reordered);
    });
    expect(await service.execute('refund_execute',c.ctx,c.body)).toMatchObject({receipt:admitted.receipt,
      execution:{status:'PROCESSING',completed:false,can_resume:true}});
    expect(await payment(c.id)).toMatchObject({attemptCount:1,providerStatus:'PROCESSING',providerRefundId:known.providerRefundId});
    expect(await immutable(c.id)).toEqual(first);expect(posts).toBe(1);expect(queries).toBe(4);
    expect(network).toHaveBeenCalledTimes(5);
    expect((await post('/pay/notify/routine-refund/'+d.dispatch_id,await callback(d))).status).toBe(204);
    expect((await immutable(c.id)).results).toHaveLength(3);
    expect(await service.status(f.actor(),c.ctx.request_key)).toMatchObject({receipt:admitted.receipt,
      execution:{status:'SUCCESS',completed:true,verified:true}});
    expect(posts).toBe(1);expect(network).toHaveBeenCalledTimes(5);
  },90000);
});
