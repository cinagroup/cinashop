/** Actual Admin assisted express checkout -> RSA/AES default Routine callback ->
 * App paid consumer -> independently authenticated Admin assignment HTTP/service.
 * Only transport/KV/Queue and the labelled late caller-abort adapter are local.
 * Inventory, store and authority setup are explicit fixture configuration; no
 * paid/root/cart/assignment success is manufactured by maintenance SQL. These
 * cases do not exercise Manager delivery, a browser, or real provider I/O. */
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { adminFulfillmentAssignmentRoutes } from '@/routes/admin-fulfillment-assignments';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeProduct, storeProductAttrValue,
  systemAdmin, systemRole, systemStore } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { upgradeStoreOrderFulfillmentAssignments } from '@/migrations/upgradeStoreOrderFulfillmentAssignments';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { AdminOrderFulfillmentAssignmentService } from '@/services/admin/AdminOrderFulfillmentAssignmentService';
import { AdminFullGiftService } from '@/services/admin/AdminFullGiftService';
import type { AssignmentRequest } from '@/services/admin/AdminOrderFulfillmentAssignmentInput';
import type { AdminAuthorityActor } from '@/services/admin/AdminAuthorityWriteService';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { amountToCents } from '@/services/payment/RefundGateway';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Review = Awaited<ReturnType<AdminOrderFulfillmentAssignmentService['review']>>;
const APP='wx_assignment_native', MERCHANT='1900000381', AES='a'.repeat(32), PLATFORM='PUB_ASSIGNMENT_NATIVE';
const PAYER='assignment_native_verified_payer', PASSWORD='offline-native-admin-password';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real Admin whole-root fulfillment assignment author',()=>{
  let f:Fixture, peers:RuntimeGiftPeerDeclarations, keys:ReturnType<typeof paymentQueryKeys>;
  let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>;
  const logs:unknown[]=[];
  const actor=(id=1):AdminAuthorityActor=>({id,authVersion:md5(PASSWORD),expiresAt:Math.floor(Date.now()/1000)+3600});
  const service=(db:DbClient=f.adminRuntime.db)=>new AdminOrderFulfillmentAssignmentService(createContainerFromDb(db),peers);
  const actual=async(id:number)=>(await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id,id)))[0]!;
  const rows=async(orderId:number)=>Array.from(await f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin
    FROM public.store_order_fulfillment_assignment t WHERE order_id=${orderId} ORDER BY ordinal`));
  const noSecrets=(value:unknown)=>{const text=JSON.stringify(value);for(const secret of[PAYER,AES,f.env.APP_KEY,'BEGIN PRIVATE KEY'])expect(text).not.toContain(secret);};
  const review=(id:number,idActor=1)=>service().review(String(id),new URLSearchParams(),actor(idActor));
  function intent(r:Review,target=77,kind:'grant'|'revoke'='grant',operation_id=randomUUID()):AssignmentRequest{
    const source=kind==='grant'?r.grant:r.revoke;if(!source)throw Error('Actual assignment review has no requested decision source: '+r.grant_reason);
    return{format_version:1,operation_id,kind,order_id:r.order_id,target_store_id:target,expected_head:r.expected_head,
      expected_order_revision:source.order_revision,expected_source_hash:source.source_hash};
  }
  const h=()=>{
    const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
    app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(f.appRuntime.db));await next();});
    app.onError(errorHandler);app.route('/api',v1Routes);
    // Production exported router, including the real ordinary-auth -> distinct
    // Admin LOGIN middleware. This harness explicitly covers these two mounts.
    app.route('/adminapi/order/fulfillment_assignment',adminFulfillmentAssignmentRoutes);
    app.route('/api/admin/order/fulfillment_assignment',adminFulfillmentAssignmentRoutes);return app;
  };
  const http=async(path:string,body?:unknown,id=1,bindings=f.env,method?:string)=>{
    const token=(await createToken(id,'admin',md5(PASSWORD),f.env.APP_KEY)).token;
    const response=await h().request(path,{method:method??(body===undefined?'GET':'POST'),headers:{Authorization:'Bearer '+token,
      ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},bindings);
    const json=await response.json() as {status:number;msg:string;data:any};noSecrets(json);return{response,body:json};
  };
  const admin=async(path:string,body?:unknown,method?:string)=>{
    const r=await http('/api'+path,body,1,f.env,method);expect(r.response.status).toBe(200);expect(r.body.status,r.body.msg).toBe(200);return r.body.data;
  };
  async function paid(quantity=1,type:0|1=0){
    // Catalog-only configuration is an input to the real checkout. Neither its
    // order/cart snapshots, paid flag, counters nor receipts are seeded.
    await f.maintenanceDb.update(storeProduct).set({type,relationId:type===1?1:0}).where(eq(storeProduct.id,70));
    const cart=await admin('/admin/order/cart/add/11',{tourist_uid:'',productId:70,uniqueId:'qared001',cartNum:quantity,new:1});
    const selection={cartId:[cart.cartId],tourist_uid:'',new:1,shipping_type:1,store_id:1,addressId:11,
      real_name:'',phone:'',payType:'cash',useIntegral:false,couponId:0,from:'pc'};
    const quote=await admin('/admin/order/confirm/11',selection), created=await admin('/admin/order/create/'+quote.orderKey+'/11',{...selection,quoteToken:quote.quoteToken});
    const order=await f.container.storeOrderDao.findByOrderId(created.result.order_id);if(!order)throw Error('Actual assisted express root absent');
    expect(order).toMatchObject({paid:0,pid:0,storeId:0,supplierId:0,uid:11,shippingType:1,productType:0,status:0});
    const total=amountToCents(order.payPrice);if(total===null||total<=0)throw Error('Real checkout amount absent');
    const transaction='assign_tx_'+randomUUID().replaceAll('-',''),nonce=Buffer.from(randomBytes(6)).toString('hex'),associated='transaction';
    const cipher=createCipheriv('aes-256-gcm',Buffer.from(AES),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
    const payload={appid:APP,mchid:MERCHANT,out_trade_no:order.orderId,transaction_id:transaction,trade_state:'SUCCESS',trade_type:'JSAPI',
      payer:{openid:PAYER},success_time:new Date().toISOString(),amount:{total,currency:'CNY'}};
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString('base64');
    const raw=JSON.stringify({id:randomUUID(),event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',
      original_type:'transaction',ciphertext,nonce,associated_data:associated}}),timestamp=String(Math.floor(Date.now()/1000)),before=f.messages.length,pending:Promise<unknown>[]=[];
    const response=await h().request('/api/pay/notify/routine',{method:'POST',body:raw,headers:{'Content-Type':'application/json','Wechatpay-Timestamp':timestamp,
      'Wechatpay-Nonce':nonce,'Wechatpay-Serial':PLATFORM,'Wechatpay-Signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),keys.privateKey)).toString('base64')}},f.env,
      {waitUntil:(p:Promise<unknown>)=>pending.push(p),props:{},passThroughOnException:()=>{throw Error('Unexpected payment fallback');}});
    await Promise.all(pending);expect(response.status,await response.text()).toBe(200);
    const message=f.messages.slice(before).find(isPaymentCallbackMessage);expect(message).toBeDefined();
    expect(await new PaymentCallbackEventService(createContainerFromDb(f.appRuntime.db),f.env).processMessage(message!)).toBe('completed');
    expect(await actual(order.id)).toMatchObject({paid:1,payType:'weixin',tradeNo:transaction,storeId:0,supplierId:0});
    const [outbox]=await f.maintenanceDb.select({id:storeOrderOutbox.id,eventKey:storeOrderOutbox.eventKey}).from(storeOrderOutbox)
      .where(and(eq(storeOrderOutbox.aggregateId,order.id),eq(storeOrderOutbox.eventType,'order.paid')));
    if(!outbox)throw Error('Actual paid outbox absent');await f.consume(outbox);
    const result=await actual(order.id);expect(result).toMatchObject({paid:1,pid:0,storeId:0,supplierId:0,supplierAllocationStatus:2});
    const carts=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    expect(carts.length).toBeGreaterThan(0);expect(carts.every(c=>c.type===type&&c.surplusNum===c.cartNum&&c.splitSurplusNum===c.cartNum)).toBe(true);
    return result;
  }
  async function hold(lock:(tx:Pick<DbClient,'execute'>)=>Promise<unknown>,work:()=>Promise<void>){
    await f.withMaintenancePeer(async peer=>{
      let ready!:()=>void,release!:()=>void;const acquired=new Promise<void>(r=>{ready=r;}),released=new Promise<void>(r=>{release=r;});
      const held=peer.transaction(async tx=>{await lock(tx);ready();await released;});
      try{await Promise.race([acquired,held.then(()=>{throw Error('Assignment lock holder ended early');})]);await work();}finally{release();await held;}
    });
  }
  beforeAll(async()=>{
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No external network in assignment author acceptance'));
    for(const level of['log','warn','error'] as const)vi.spyOn(console,level).mockImplementation((...args:unknown[])=>{logs.push(args);});
    f=await customerCashierRuntimeHttpFixture();keys=paymentQueryKeys();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    const owner=await f.createOwnedRole('assigncity'),city={owner:owner.role,app:true,admin:true,manager:true} as const;
    const installedCity=await upgradeFulfillmentCityConflictReaders(f.maintenanceDb,f.target,{readers:city},{...f.peers,cityConflictReaders:city},f.appReaders);
    const installed=await upgradeStoreOrderFulfillmentAssignments(f.maintenanceDb,f.target,{assignments:true},
      {...installedCity.peers,fulfillmentAssignments:{assignments:true}},f.appReaders);peers=installed.peers;
    f.env.ADMIN_FULFILLMENT_ASSIGNMENT_RUNTIME=peers;
    Object.assign(f.env,{WECHAT_MCH_PRIVATE_KEY:keys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:keys.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID:PLATFORM,WECHAT_API_V3_KEY:AES});
    const config={routine_appId:APP,wechat_appid:APP,pay_weixin_mchid:MERCHANT,pay_weixin_serial_no:'A1B2C3D4',pay_weixin_open:'1',order_shipping_open:'1'};
    await f.setConfig(config);
    for(const[menuName,value]of Object.entries(config)){
      await f.maintenanceDb.execute(sql`DELETE FROM public.system_config WHERE menu_name=${menuName}`);
      await f.maintenanceDb.execute(sql`INSERT INTO public.system_config(menu_name,value,sort) VALUES(${menuName},${JSON.stringify(value)},100)`);
    }
    await f.maintenanceDb.update(storeProduct).set({type:0,relationId:0,productType:0,stock:100,freight:1,isVip:0,isLimit:0,deliveryType:'1'}).where(eq(storeProduct.id,70));
    await f.maintenanceDb.update(storeProductAttrValue).set({stock:100,price:'5.00',vipPrice:'5.00'}).where(eq(storeProductAttrValue.id,1));
    await f.maintenanceDb.insert(systemStore).values([77,78].map(id=>({id,name:'原生分配门店'+id,isStore:1,isShow:1,isDel:0})));
    await f.maintenanceDb.insert(systemRole).values({id:77,roleName:'原生分配作者',rules:'order.manage',status:1});
    await f.maintenanceDb.insert(systemAdmin).values([2,3].map(id=>({id,account:'assignment-admin-'+id,pwd:PASSWORD,adminType:1,status:1,isDel:0,level:1,roles:'77'})));
    expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.managerRuntime,f.financialRuntime,f.cashierRuntime].map(p=>p.verify()))).size).toBe(5);
  },180000);
  afterEach(()=>{noSecrets(logs);noSecrets(f.messages);expect(network).not.toHaveBeenCalled();});
  afterAll(async()=>{try{if(f)await f.close();}finally{vi.restoreAllMocks();}},30000);

  it('authors real HTTP grant, reassign and revoke without changing finance or cart ownership',async()=>{
    const order=await paid(),before=await actual(order.id),carts=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    const stores=await http('/adminapi/order/fulfillment_assignment/stores');expect(stores.body.status,stores.body.msg).toBe(200);
    expect(stores.body.data.list).toEqual(expect.arrayContaining([{id:77,name:'原生分配门店77'},{id:78,name:'原生分配门店78'}]));
    const r=await http('/adminapi/order/fulfillment_assignment/review/'+order.id);expect(r.body.status,r.body.msg).toBe(200);
    expect(r.body.data).toMatchObject({order_id:order.id,financial_store_id:0,admission:'requires_locked_commit',expected_head:{ordinal:0,operation_id:null}});
    const grant=intent(r.body.data),g=await http('/adminapi/order/fulfillment_assignment/commit',grant);
    expect(g.body.status,g.body.msg).toBe(200);expect(g.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(g.body.data).toMatchObject({replayed:false,receipt:{operation_id:grant.operation_id,actor_id:1,kind:'grant',ordinal:1,target_store_id:77,financial_store_id:0}});
    const reassign=intent(await review(order.id),78),s=await http('/api/admin/order/fulfillment_assignment/commit',reassign);
    expect(s.body.status,s.body.msg).toBe(200);expect(s.body.data.receipt).toMatchObject({kind:'grant',ordinal:2,target_store_id:78,previous_ref:grant.operation_id});
    const revoke=intent(await review(order.id),78,'revoke'),v=await http('/adminapi/order/fulfillment_assignment/commit',revoke);
    expect(v.body.status,v.body.msg).toBe(200);expect(v.body.data.receipt).toMatchObject({kind:'revoke',ordinal:3,target_store_id:78,previous_ref:reassign.operation_id});
    for(const request of[grant,reassign,revoke]){
      const receipt=await http('/adminapi/order/fulfillment_assignment/receipt/'+request.operation_id);expect(receipt.body.status,receipt.body.msg).toBe(200);
      expect(receipt.body.data).toMatchObject({state:'recorded',receipt:{operation_id:request.operation_id,order_id:order.id}});
      expect(receipt.body.data.receipt).not.toHaveProperty('source');noSecrets(receipt.body);
    }
    expect(await actual(order.id)).toEqual(before);expect(await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id))).toEqual(carts);
    expect(await rows(order.id)).toHaveLength(3);
  },90000);

  it('replays exactly one UUID, refuses changed content, same-target renewal and stale heads',async()=>{
    const order=await paid(),first=intent(await review(order.id)),saved=await service().commit(first,actor()),before=await rows(order.id);
    expect(saved.replayed).toBe(false);expect(await service().commit(first,actor())).toEqual({...saved,replayed:true});
    await expect(service().commit({...first,target_store_id:78},actor())).rejects.toMatchObject({httpStatus:409});
    await expect(service().commit({...first,operation_id:randomUUID()},actor())).rejects.toMatchObject({httpStatus:412});
    await expect(service().commit(intent(await review(order.id)),actor())).rejects.toMatchObject({httpStatus:409});
    expect(await rows(order.id)).toEqual(before);
  },90000);

  it('refuses an old source review after the actual Admin remark writer and admits a fresh review',async()=>{
    const order=await paid(),input=intent(await review(order.id));
    await admin('/admin/order/remark',{order_id:order.orderId,remark:'实际 Admin 作者改变订单来源'});
    expect((await actual(order.id)).remark).toBe('实际 Admin 作者改变订单来源');
    await expect(service().commit(input,actor())).rejects.toMatchObject({httpStatus:412});expect(await rows(order.id)).toHaveLength(0);
    expect((await service().commit(intent(await review(order.id)),actor())).receipt).toMatchObject({ordinal:1,target_store_id:77});
  },90000);

  it('withdraws the original grant after real Admin delivery while retaining its immutable old source',async()=>{
    const order=await paid(),grant=intent(await review(order.id)),saved=await service().commit(grant,actor());
    await admin('/admin/order/delivery/'+order.orderId,{delivery_type:'express',delivery_name:'本机真实承运商',delivery_id:'ASSIGN-'+order.id});
    expect(await actual(order.id)).toMatchObject({status:1,deliveryId:'ASSIGN-'+order.id,storeId:0});
    const after=await review(order.id);expect(after.grant).toBeNull();expect(after.grant_reason).not.toBe('');
    expect(after.revoke).toMatchObject({target_store_id:77,order_revision:saved.receipt.order_revision,source_hash:saved.receipt.source_hash});
    const revoke=await service().commit(intent(after,77,'revoke'),actor());expect(revoke.receipt).toMatchObject({kind:'revoke',ordinal:2,source_hash:saved.receipt.source_hash});
    expect(await actual(order.id)).toMatchObject({status:1,deliveryId:'ASSIGN-'+order.id,storeId:0});
    const history=await f.maintenanceDb.execute<{kind:string;source:unknown}>(sql`SELECT kind,source FROM public.store_order_fulfillment_assignment WHERE order_id=${order.id} ORDER BY ordinal`);
    expect(history).toHaveLength(2);expect(history[1]!.source).toEqual(history[0]!.source);
  },90000);

  it('allows minimal original-owner HTTP recovery after authority revocation and conceals other owners',async()=>{
    const order=await paid(),input=intent(await review(order.id,2)),saved=await service().commit(input,actor(2)),before=await rows(order.id);
    // Explicit adversarial authority fixture change, not assignment evidence.
    await f.maintenanceDb.update(systemAdmin).set({roles:''}).where(eq(systemAdmin.id,2));
    try{
      const receipt=await http('/adminapi/order/fulfillment_assignment/receipt/'+input.operation_id,undefined,2);
      expect(receipt.body.status,receipt.body.msg).toBe(200);expect(receipt.body.data).toEqual({state:'recorded',receipt:saved.receipt});
      expect(receipt.body.data.receipt).not.toHaveProperty('source');
      expect(await service().commit(input,actor(2))).toEqual({...saved,replayed:true});
      await expect(service().commit({...input,operation_id:randomUUID()},actor(2))).rejects.toThrow(/权限/);
      expect((await http('/adminapi/order/fulfillment_assignment/review/'+order.id,undefined,2)).body.status).not.toBe(200);
      expect((await http('/adminapi/order/fulfillment_assignment/commit',input,2)).body.status).not.toBe(200);
      for(const[id,operation]of[[3,input.operation_id],[2,randomUUID()]] as const){
        const absent=await http('/adminapi/order/fulfillment_assignment/receipt/'+operation,undefined,id);
        expect(absent.body.status,absent.body.msg).toBe(200);expect(absent.body.data).toEqual({state:'unknown',receipt:null});
      }
      expect(await rows(order.id)).toEqual(before);
    }finally{await f.maintenanceDb.update(systemAdmin).set({roles:'77'}).where(eq(systemAdmin.id,2));}
  },90000);

  it('closes missing declarations and refuses App, Manager and maintenance connections as actual Admin authors',async()=>{
    const order=await paid(),input=intent(await review(order.id)),bindings={...f.env,ADMIN_FULFILLMENT_ASSIGNMENT_RUNTIME:undefined};
    const missing=await http('/adminapi/order/fulfillment_assignment/commit',input,1,bindings);expect(missing.response.status).toBe(503);
    for(const db of[f.appRuntime.db,f.managerRuntime.db,f.maintenanceDb])await expect(service(db).commit(input,actor())).rejects.toThrow();
    expect(await rows(order.id)).toHaveLength(0);
  },90000);

  it('refuses actual root-row and empty waybill table contention without reserving or appending a decision',async()=>{
    const order=await paid(),input=intent(await review(order.id));
    const [{n}]=await f.maintenanceDb.execute<{n:number}>(sql`SELECT pg_catalog.count(*)::integer AS n FROM public.order_waybill_job WHERE root_order_id=${order.id}`);expect(n).toBe(0);
    for(const lock of[
      (tx:Pick<DbClient,'execute'>)=>tx.execute(sql`SELECT id FROM public.store_order WHERE id=${order.id} FOR UPDATE NOWAIT`),
      (tx:Pick<DbClient,'execute'>)=>tx.execute(sql`LOCK TABLE ONLY public.order_waybill_job IN ROW EXCLUSIVE MODE NOWAIT`),
    ])await hold(lock,async()=>{await expect(service().commit(input,actor())).rejects.toMatchObject({httpStatus:409});expect(await rows(order.id)).toHaveLength(0);});
    expect((await service().commit(input,actor())).receipt).toMatchObject({operation_id:input.operation_id,ordinal:1});
  },90000);

  it('rolls a complete real Admin insert and readback back on a controlled caller abort, then safely retries',async()=>{
    const order=await paid(),input=intent(await review(order.id)),container=createContainerFromDb(f.adminRuntime.db),db=container.db;
    // Only the outer transaction's return is fault-injected. The callback gets
    // the original driver's actual Admin transaction and executes all real SQL.
    const transaction:DbClient['transaction']=async(callback,config)=>db.transaction(async tx=>{
      await callback(tx);throw Error('owned caller abort after complete assignment');
    },config);
    container.db=new Proxy(db,{get(target,key,receiver){return key==='transaction'?transaction:Reflect.get(target,key,receiver);}});
    await expect(new AdminOrderFulfillmentAssignmentService(container,peers).commit(input,actor())).rejects.toThrow('owned caller abort after complete assignment');
    expect(await rows(order.id)).toHaveLength(0);expect(await service().receipt(input.operation_id,new URLSearchParams(),actor())).toEqual({state:'unknown',receipt:null});
    expect((await service().commit(input,actor())).receipt).toMatchObject({operation_id:input.operation_id,ordinal:1});
  },90000);

  it('retains a genuinely created type-one inventory origin while assigning only fulfillment to another store',async()=>{
    const order=await paid(1,1),carts=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    expect(carts).toHaveLength(1);expect(carts[0]).toMatchObject({type:1,relationId:1,productType:0,surplusNum:1,splitSurplusNum:1});
    const saved=await service().commit(intent(await review(order.id),77),actor());expect(saved.receipt).toMatchObject({target_store_id:77,financial_store_id:0});
    expect(await actual(order.id)).toMatchObject({pid:0,storeId:0,supplierId:0});
    expect(await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id))).toEqual(carts);
  },90000);

  it('refuses actual cart source drift, refund-generation and unknown finance versions without appending',async()=>{
    const order=await paid(),input=intent(await review(order.id));
    const [cart]=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    const info=JSON.parse(cart.cartInfo!);
    // Explicit adversarial source specimens only. The positive source above
    // came from checkout/payment; restore its exact bytes after each rejection.
    for(const changed of [{...info,financial_version:'refund-order-line-finance-v1'},
      {...info,refund_order_generation:{refundId:1,role:'remaining'}},
      {...info,financial_version:'unknown'}, {...info,id:'another-cart'}, {...info,cart_num:2}]){
      try{
        await f.maintenanceDb.update(storeOrderCartInfo).set({cartInfo:JSON.stringify(changed)}).where(eq(storeOrderCartInfo.id,cart.id));
        expect((await review(order.id)).grant).toBeNull();
        await expect(service().commit(input,actor())).rejects.toThrow();
        expect(await rows(order.id)).toHaveLength(0);
      }finally{
        await f.maintenanceDb.update(storeOrderCartInfo).set({cartInfo:cart.cartInfo}).where(eq(storeOrderCartInfo.id,cart.id));
      }
    }
    expect((await service().commit(input,actor())).receipt).toMatchObject({operation_id:input.operation_id,ordinal:1});
  },90000);

  it('captures the real gift writer final physical quantity together with charged cart rows',async()=>{
    // Explicit new inventory catalogue, then the existing real Admin campaign
    // author. No order, cart, gift entitlement or paid outcome is seeded.
    await f.maintenanceDb.insert(storeProduct).values({id:777,storeName:'分配原生赠品',stock:10,image:'/native-gift.png',
      type:0,relationId:0,productType:0,isShow:1,isVerify:1,freight:1,deliveryType:'1'});
    await f.maintenanceDb.insert(storeProductAttrValue).values({id:777,productId:777,type:0,unique:'gift38',suk:'原生赠品',stock:10});
    const shanghai=(hours:number)=>{
      const date=new Date(Date.now()+(hours+8)*3600000),p=(v:number)=>String(v).padStart(2,'0');
      return`${date.getUTCFullYear()}-${p(date.getUTCMonth()+1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
    };
    await new AdminFullGiftService(createContainerFromDb(f.adminRuntime.db)).mutate('create',0,{name:'分配原生满件赠品',
      section_time:[shanghai(-1),shanghai(24)],promotions_cate:1,threshold_type:2,
      promotions:[{threshold:1,give_integral:0,give_coupon_id:[],give_product_id:[{give_product_id:777,unique:'gift38',give_product_num:10}]}],
      is_label:0,label_id:[],product_partake_type:2,product_id:[{product_id:70,unique:['qared001']}],brand_id:[],store_label_id:[],
      status:1,sort:0,request_id:randomUUID()},{id:1});
    const order=await paid(2),carts=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    expect(carts).toHaveLength(2);expect(carts.find(c=>c.isGift===1)).toMatchObject({productId:777,skuUnique:'gift38',cartNum:1,surplusNum:1,splitSurplusNum:1});
    expect(order.totalNum).toBe(3);
    const r=await review(order.id);expect(r.grant?.source.cart_rows).toHaveLength(2);
    expect(r.grant?.source.cart_rows.reduce((sum,c)=>sum+c.quantity,0)).toBe(3);
    expect((await service().commit(intent(r),actor())).receipt).toMatchObject({target_store_id:77,financial_store_id:0,ordinal:1});
    expect(await actual(order.id)).toEqual(order);expect(await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id))).toEqual(carts);
  },90000);
});
