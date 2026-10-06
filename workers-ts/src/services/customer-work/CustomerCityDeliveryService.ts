import { createHash, createHmac, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { cityArea, storeOrder, storeOrderCartInfo, storeOrderRefund, storeDeliveryOrder, storePink, systemConfig, systemStore, systemSupplier, user } from '@/models/schema';
import { customerCityDeliveryJob as jobs, customerCityDeliveryAttempt as attempts, customerCityDeliveryBinding as bindings, type CustomerCityJobStatus } from '@/models/schema/customer_city_delivery';
import { assertCustomerCityDeliveryReady } from '@/migrations/customerCityDelivery';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { CityDeliverySettingsResolver, readCityDeliverySettingsInTx, lockCityConfigForRead } from '@/services/delivery/CityDeliverySettingsResolver';
import { CustomerCityDeliveryProvider, CustomerCityProviderRejection, type CustomerCityEnv, type CustomerCityIssueInput, type CustomerCityStation, type CustomerCityQuote, type CustomerCityIssued } from '@/services/delivery/CustomerCityDeliveryProvider';
import { DadaCityDeliveryProvider } from '@/services/delivery/DadaCityDeliveryProvider';
import { UuCityDeliveryProvider } from '@/services/delivery/UuCityDeliveryProvider';
import { SupplierFulfillmentService, type SupplierDeliveryInput } from '@/services/supplier/SupplierFulfillmentService';
import { AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { authorizeCustomerWorkActor, type CustomerWorkActor } from './CustomerWorkScope';
import { normalizeConfigScalar } from '@/utils/config';
import { assertPresaleDispatchReady } from '@/services/activity/PresaleFulfillmentSnapshot';
import { planOrderFinancialSplit } from '@/services/order/OrderSplitFinance';
import { assertOrderPromotionLedger } from '@/services/order/OrderPromotionLedgerSplit';
import { loadRefundOrderGeneration } from '@/services/order/RefundOrderGeneration';

export interface CustomerCityIdentity { requestedOrderId:number; rootOrderId:number; orderId:number; customerUid:number; storeId:number; supplierId:number }
export interface CustomerCityPayload { station_type:1|2; cargo_weight:string; delivery_remark:string }
export interface CustomerCityAdmission { actor_uid:number;service_id:number;scope_key:string;actor_auth_version:string;actor_expires_at:number;request_key:string;request_hash:string;identity:CustomerCityIdentity;payload:CustomerCityPayload;cart_ids?:{cart_id:string;cart_num:number}[] }
export interface CustomerCityOutcome { job_id:number;request_key:string;status:CustomerCityJobStatus;provider:'dada'|'uu';provider_order_id:string;delivery_status:number|null;last_error_code:string;updated_at:number;may_retry:false }
type CityJob=typeof jobs.$inferSelect;
interface CityIntent { identity:CustomerCityIdentity; payload:CustomerCityPayload;cart_ids:{cart_id:string;cart_num:number}[];issue:CustomerCityIssueInput; settings_revision:string;provider_authority_revision:string;order_fingerprint:string;root_store_id:number }
const now=()=>Math.floor(Date.now()/1000);
const canonical=(v:unknown):unknown=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const errorCode=(e:unknown)=>e instanceof CustomerCityProviderRejection?e.code:'city_effect_unresolved';
const asRecord=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Same table-first graph as provider callbacks. Called before any resource lock. */
export async function acquireCustomerCityAdmissionFence(tx:DbClient, noWait=false){
  await assertCustomerCityDeliveryReady(tx);
  await tx.execute(sql.raw(`LOCK TABLE store_delivery_order IN SHARE ROW EXCLUSIVE MODE${noWait?' NOWAIT':''}`));
}
async function deadline(tx:DbClient){await tx.execute(sql`SET LOCAL lock_timeout='1500ms'`);await tx.execute(sql`SET LOCAL statement_timeout='10000ms'`);}
async function lockJobResources(tx:DbClient,job:CityJob){await lockOrderSettlement(tx,job.rootOrderId);if(job.orderId!==job.rootOrderId)await lockOrderSettlement(tx,job.orderId);}
async function liveIdentity(tx:DbClient,identity:CustomerCityIdentity,lock=false){
  let query=tx.select().from(storeOrder).where(eq(storeOrder.id,identity.orderId)).limit(1);const rows=lock?await query.for('update',{noWait:true}):await query;
  const order=rows[0];if(!order||order.pid<0||order.uid!==identity.customerUid||order.storeId!==identity.storeId||order.supplierId!==identity.supplierId||(order.pid>0?order.pid:order.id)!==identity.rootOrderId||order.isDel!==0||order.isSystemDel!==0)throw new ValidateException('配送实体已变化');
  const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,identity.rootOrderId)).limit(1);
  if(!root||root.uid!==order.uid||root.isDel!==0||root.isSystemDel!==0||root.paid!==1)throw new ValidateException('配送主单已变化');
  if(order.productType!==0||order.paid!==1||order.status!==0||![1,3].includes(order.shippingType)||![0,3].includes(order.refundStatus)||!order.realName||!/^1\d{10}$/.test(order.userPhone)||!order.userAddress)throw new ValidateException('当前订单不支持第三方同城配送');
  const refunds=await tx.select({id:storeOrderRefund.id}).from(storeOrderRefund).where(and(inArray(storeOrderRefund.storeOrderId,[identity.rootOrderId,identity.orderId]),eq(storeOrderRefund.isCancel,0),eq(storeOrderRefund.isDel,0),inArray(storeOrderRefund.refundType,[0,1,2,4,5]))).limit(1);
  if(refunds.length)throw new ValidateException('售后处理中不能配送');
  if(order.type===3){const [pink]=await tx.select({status:storePink.status}).from(storePink).where(eq(storePink.id,order.pinkId)).limit(1).for('key share',{noWait:true});if(pink?.status!==2)throw new ValidateException('拼团尚未成功，不能配送');}
  if(lock)await assertPresaleDispatchReady(tx,order);
  const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(501);
  if(!carts.length||carts.length>500||carts.some(c=>c.uid!==order.uid||c.cartNum<=0||c.splitSurplusNum<0))throw new ValidateException('配送商品身份无效');
  return {order,root,carts,fingerprint:hash({order,root,carts})};
}
async function assertSelectedCarts(tx:DbClient,current:Awaited<ReturnType<typeof liveIdentity>>,selected:{cart_id:string;cart_num:number}[]){
  if(!selected.length)return;
  const available=current.carts.filter(c=>c.splitStatus<2&&c.splitSurplusNum>0),source=new Map(available.map(c=>[c.cartId,c]));
  const quantities=new Map(selected.map(c=>[c.cart_id,c.cart_num]));
  if(selected.length>200||source.size!==available.length||quantities.size!==selected.length||selected.some(c=>!c.cart_id||!Number.isSafeInteger(c.cart_num)||c.cart_num<1||!source.has(c.cart_id)||c.cart_num>source.get(c.cart_id)!.splitSurplusNum))throw new ValidateException('拆单配送商品或数量已变化');
  await loadRefundOrderGeneration(tx,current.order,current.carts);
  planOrderFinancialSplit(current.order,current.carts,quantities);
  await assertOrderPromotionLedger(tx,current.order,current.carts);
}
async function station(tx:DbClient,id:CustomerCityIdentity):Promise<CustomerCityStation|null>{
  if(id.storeId>0){const [s]=await tx.select().from(systemStore).where(and(eq(systemStore.id,id.storeId),eq(systemStore.isDel,0),eq(systemStore.isShow,1))).limit(1);if(!s)return null;const [c]=await tx.select({name:cityArea.name}).from(cityArea).where(eq(cityArea.id,s.city)).limit(1);return {type:1,relation_id:s.id,name:s.name,address:s.detailedAddress||s.address,phone:s.phone.trim(),city_name:c?.name??'',shop_no:s.cityShopId};}
  if(id.supplierId>0){const [s]=await tx.select().from(systemSupplier).where(and(eq(systemSupplier.id,id.supplierId),eq(systemSupplier.isDel,0),eq(systemSupplier.isShow,1))).limit(1);if(!s)return null;const [c]=await tx.select({name:cityArea.name}).from(cityArea).where(eq(cityArea.id,s.city)).limit(1);return {type:2,relation_id:s.id,name:s.supplierName,address:s.detailedAddress||s.address,phone:s.phone,city_name:c?.name??'',shop_no:s.cityShopId};}
  const rows=await tx.select().from(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,['refund_address','refund_name','refund_phone']))).orderBy(sql`${systemConfig.sort} DESC`,sql`${systemConfig.id} DESC`).limit(100);
  const get=(k:string)=>normalizeConfigScalar(rows.find(r=>r.menuName===k)?.value),address=get('refund_address');
  const city=address.match(/^(?:[^省]+省)?([^市省]+市)/)?.[1]??'';
  return {type:0,relation_id:0,name:get('refund_name'),address,phone:get('refund_phone'),city_name:city,shop_no:'plat_delivery_city_shop_001'};
}
function parsePayload(value:CustomerCityPayload){
  if(!value||Object.keys(value).sort().join(',')!=='cargo_weight,delivery_remark,station_type'||![1,2].includes(value.station_type)||typeof value.cargo_weight!=='string'||!/^(?:[1-9]\d{0,2}|0)(?:\.\d{1,2})?$/.test(value.cargo_weight)||Number(value.cargo_weight)<=0||Number(value.cargo_weight)>100||typeof value.delivery_remark!=='string'||[...value.delivery_remark].length>255||/[\u0000-\u001f\u007f]/.test(value.delivery_remark))throw new ValidateException('同城配送参数无效');
  return Object.freeze({...value});
}
async function actorForJob(tx:DbClient,job:CityJob){await acquireCustomerWorkScopeLock(tx,job.actorUid);const scope=await authorizeCustomerWorkActor(tx,{uid:job.actorUid,auth_version:job.actorAuthVersion,expires_at:job.actorExpiresAt});if(scope.service_id!==job.serviceId||scope.scope_key!==job.scopeKey)throw new AuthException('同城配送授权已变化');}
function intentFor(job:CityJob):CityIntent {
  if(hash(job.intent)!==job.intentHash)throw Error('city_intent_integrity');const i=job.intent as unknown as CityIntent;
  if(!asRecord(i)||!asRecord(i.identity)||!asRecord(i.payload)||!asRecord(i.issue)||!Array.isArray(i.cart_ids)||i.identity.requestedOrderId!==job.requestedOrderId||i.identity.rootOrderId!==job.rootOrderId||i.identity.orderId!==job.orderId||i.identity.customerUid!==job.customerUid||i.identity.storeId!==job.storeId||i.identity.supplierId!==job.supplierId||i.issue.provider!==job.provider||!Number.isSafeInteger(i.root_store_id)||i.root_store_id<0)throw Error('city_intent_integrity');
  if(job.provider==='dada'&&i.issue.provider_order_id!==job.providerOrderId)throw Error('city_original_origin_binding_conflict');
  parsePayload(i.payload);return i;
}
function issuedFor(value:CustomerCityIssued){if(!value||!/^[A-Za-z0-9._:-]{1,32}$/.test(value.provider_order_id)||!/^[A-Za-z0-9._:-]{1,32}$/.test(value.delivery_no)||!Number.isFinite(value.distance)||value.distance<0||value.distance>1000000||!/^\d{1,6}\.\d{2}$/.test(value.fee))throw Error('city_issued_binding_invalid');return value;}

export class CustomerCityDeliveryService {
  private readonly settings:CityDeliverySettingsResolver;
  private readonly provider:CustomerCityDeliveryProvider;
  constructor(private readonly container:Container,private readonly env:CustomerCityEnv){this.settings=new CityDeliverySettingsResolver(container,env);this.provider=new CustomerCityDeliveryProvider(env,this.settings);}
  async blocking(tx:DbClient,identity:CustomerCityIdentity,lock=false):Promise<boolean>{
    if(lock)await tx.execute(sql`LOCK TABLE ${jobs} IN ROW SHARE MODE NOWAIT`);
    const rows=await tx.select({status:jobs.status,active:bindings.active}).from(jobs).leftJoin(bindings,eq(bindings.jobId,jobs.id)).where(eq(jobs.rootOrderId,identity.rootOrderId)).limit(501);
    if(rows.length>500)throw new ServiceUnavailableException('同城配送历史超出上限');return rows.some(j=>['PENDING','PROCESSING','UNKNOWN'].includes(j.status)||(j.status==='ADMITTED'&&j.active===1));
  }
  async bootstrap(tx:DbClient,identity:CustomerCityIdentity){
    let ready=true;try{await assertCustomerCityDeliveryReady(tx);}catch{ready=false;}
    const s=ready?await station(tx,identity):null,settings=await readCityDeliverySettingsInTx(tx,this.env);
    const providers=([1,2] as const).map(station_type=>{const provider=station_type===1?'dada' as const:'uu' as const,reasons:string[]=[];
      if(!ready)reasons.push('runtime_catalog_or_privileges_unavailable');if(settings.snapshot.flags.city_delivery_status!==1)reasons.push('city_delivery_disabled');
      if(settings.snapshot.flags[station_type===1?'dada_delivery_status':'uu_delivery_status']!==1)reasons.push('provider_disabled');
      if(!s||!s.name||!s.address||!/^1\d{10}$/.test(s.phone)||!s.city_name)reasons.push('station_unavailable');
      if(station_type===1&&!s?.shop_no)reasons.push('station_registration_unavailable');
      const keys=station_type===1?['dada_app_key','dada_app_sercret','dada_source_id'] as const:['uupt_app_id','uupt_appkey','uupt_open_id'] as const;
      if(keys.some(k=>!settings.snapshot.credentials[k].configured))reasons.push('provider_credentials_unavailable');
      if(station_type===1&&!settings.snapshot.readiness.dada_client_id)reasons.push('provider_client_unavailable');
      if(station_type===2&&!settings.snapshot.readiness.uu_timestamp_unit)reasons.push('uu_timestamp_unit_unverified');
      if(station_type===2&&this.env.CUSTOMER_CITY_UU_ORIGIN_BINDING_CONTRACT!=='uu-v3-originId-return-v1')reasons.push('uu_origin_binding_contract_unverified');
      try{this.provider.callback(provider);}catch{reasons.push('callback_deployment_unavailable');}return {station_type,provider,available:reasons.length===0,reasons};});
    const [job]=ready?await tx.select().from(jobs).where(eq(jobs.rootOrderId,identity.rootOrderId)).orderBy(sql`${jobs.id} DESC`).limit(1):[];
    const publicStation=s?{type:s.type,relation_id:s.relation_id,name:s.name,address:s.address,phone:s.phone,city_name:s.city_name}:null;
    return {schema_ready:ready,providers,station:publicStation,job:job?await this.project(tx,job):null};
  }
  async admitInTx(tx:DbClient,input:CustomerCityAdmission){
    await assertCustomerCityDeliveryReady(tx);if(!uuid.test(input.request_key)||!/^[a-f0-9]{64}$/.test(input.request_hash))throw new ValidateException('同城配送请求标识无效');
    const payload=parsePayload(input.payload),scope=await authorizeCustomerWorkActor(tx,{uid:input.actor_uid,auth_version:input.actor_auth_version,expires_at:input.actor_expires_at});
    if(scope.service_id!==input.service_id||scope.scope_key!==input.scope_key)throw new AuthException('同城配送身份已变化');
    const [prior]=await tx.select().from(jobs).where(and(eq(jobs.actorUid,input.actor_uid),eq(jobs.requestKey,input.request_key))).limit(1);
    if(prior){if(prior.requestHash!==input.request_hash)throw new HttpApiException('原始请求标识不能用于不同配送内容',409,409);return this.project(tx,prior);}
    if(await this.blocking(tx,input.identity,true))throw new ValidateException('订单已有同城配送任务，先恢复原始结果');
    const current=await liveIdentity(tx,input.identity,true),readiness=await this.bootstrap(tx,input.identity),selected=readiness.providers.find(p=>p.station_type===payload.station_type);
    if(!selected?.available)throw new ServiceUnavailableException('同城配送尚未就绪：'+selected?.reasons.join(','));
    const s=await station(tx,input.identity);if(!s)throw new ValidateException('发货站点无效');
    const provider=payload.station_type===1?'dada' as const:'uu' as const,providerId=(provider==='dada'?'dd':'uu')+hash({uid:input.actor_uid,key:input.request_key}).slice(0,30);
    const issue:CustomerCityIssueInput={provider,provider_order_id:providerId,station:s,receiver_name:current.order.realName,receiver_phone:current.order.userPhone,receiver_address:current.order.userAddress,cargo_price:current.order.payPrice,cargo_weight:payload.cargo_weight,delivery_remark:payload.delivery_remark};
    const settings=await readCityDeliverySettingsInTx(tx,this.env),intent:CityIntent={identity:{...input.identity},payload,cart_ids:input.cart_ids?.map(c=>({...c}))??[],issue,settings_revision:settings.snapshot.revision,provider_authority_revision:await this.privateProviderAuthority(tx),order_fingerprint:current.fingerprint,root_store_id:current.root.storeId};
    await assertSelectedCarts(tx,current,intent.cart_ids);
    const time=now(),[job]=await tx.insert(jobs).values({actorUid:input.actor_uid,serviceId:input.service_id,actorAuthVersion:input.actor_auth_version,actorExpiresAt:input.actor_expires_at,scopeKey:input.scope_key,requestKey:input.request_key,requestHash:input.request_hash,intentHash:hash(intent),requestedOrderId:input.identity.requestedOrderId,rootOrderId:input.identity.rootOrderId,orderId:input.identity.orderId,customerUid:input.identity.customerUid,storeId:input.identity.storeId,supplierId:input.identity.supplierId,provider,providerOrderId:providerId,intent:intent as unknown as Record<string,unknown>,addTime:time,updateTime:time}).returning();
    if(!job)throw Error('city_admission_not_written');return this.project(tx,job);
  }
  private async project(tx:DbClient,job:CityJob):Promise<CustomerCityOutcome>{const [b]=await tx.select({status:storeDeliveryOrder.status}).from(bindings).innerJoin(storeDeliveryOrder,eq(storeDeliveryOrder.id,bindings.deliveryOrderId)).where(eq(bindings.jobId,job.id)).limit(1);return {job_id:job.id,request_key:job.requestKey,status:job.status,provider:job.provider,provider_order_id:job.providerOrderId,delivery_status:b?.status??null,last_error_code:job.lastErrorCode,updated_at:job.updateTime,may_retry:false};}
  async outcome(actor:CustomerWorkActor,jobId:number){
    const captured=Object.freeze({...actor});
    if(!Number.isSafeInteger(jobId)||jobId<=0)throw new NotFoundException('配送结果不存在');
    const result=await withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);await this.assertOrdinaryActor(tx,captured);const [job]=await tx.select().from(jobs).where(and(eq(jobs.id,jobId),eq(jobs.actorUid,captured.uid))).limit(1);if(!job)throw new NotFoundException('配送结果不存在');return this.project(tx,job);});
    await this.assertOrdinaryActor(this.container.db,captured);return result;
  }
  private async assertOrdinaryActor(tx:DbClient,actor:CustomerWorkActor){if(!Number.isSafeInteger(actor.uid)||actor.uid<=0||!Number.isSafeInteger(actor.expires_at)||actor.expires_at<=now()||!/^[a-f0-9]{32}$/.test(actor.auth_version))throw new AuthException();const [account]=await tx.select({auth:sql<string>`md5(${user.pwd})`}).from(user).where(and(eq(user.uid,actor.uid),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).limit(1);if(account?.auth!==actor.auth_version)throw new AuthException('原始配送会话已失效');}
  private async assertCurrentStation(tx:DbClient,job:CityJob,intent:CityIntent){
    const current=await station(tx,intent.identity);if(!current||hash(current)!==hash(intent.issue.station))throw new ValidateException('同城发货站点已变化');
    const ready=await this.bootstrap(tx,intent.identity);if(!ready.providers.find(p=>p.provider===job.provider)?.available)throw new ValidateException('配送配置已变化');
    if(intent.provider_authority_revision!==await this.privateProviderAuthority(tx))throw new ValidateException('同城供应商授权已变化');
  }
  /** This HMAC stays in the private intent; public readiness never exposes a
   * dictionary-testable hash of plaintext credentials or deployment tokens. */
  private async privateProviderAuthority(tx:DbClient){
    if(!this.env.APP_KEY)throw new ServiceUnavailableException('同城服务授权键未配置');
    const settings=await readCityDeliverySettingsInTx(tx,this.env),authority={values:settings.values,dada_client_id:this.env.DADA_CLIENT_ID??'',dada_callback_token:this.env.DADA_CALLBACK_TOKEN??'',uu_callback_token:this.env.UU_CALLBACK_TOKEN??'',timestamp_unit:this.env.UU_API_TIMESTAMP_UNIT??'',callback_origin:this.env.CUSTOMER_CITY_CALLBACK_ORIGIN??'',uu_binding_contract:this.env.CUSTOMER_CITY_UU_ORIGIN_BINDING_CONTRACT??''};
    return createHmac('sha256',this.env.APP_KEY).update('customer-city-provider-authority-v1\0'+JSON.stringify(canonical(authority))).digest('hex');
  }
  async postCommitDispatch(jobId:number){await this.process(jobId);}
  async dispatchPending(limit=20){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('city_dispatch_limit');
    const [catalog]=await this.container.db.execute<{installed:number}>(sql`SELECT count(*)::int AS installed FROM pg_class WHERE oid IN(to_regclass('public.customer_city_delivery_job'),to_regclass('public.customer_city_delivery_attempt'),to_regclass('public.customer_city_delivery_binding'))`);
    if(catalog?.installed===0)return 0;if(catalog?.installed!==3)throw Error('city_binding_catalog_partial');await assertCustomerCityDeliveryReady(this.container.db);
    const rows=await this.container.db.select({id:jobs.id}).from(jobs).where(inArray(jobs.status,['PENDING','PROCESSING'])).orderBy(asc(jobs.id)).limit(limit);for(const row of rows)await this.process(row.id);return rows.length;
  }
  private async mark(job:CityJob,phase:'REVOKED'|'REJECTED'|'UNKNOWN',code:string){await withTx(this.container,async tx=>{await deadline(tx);await acquireCustomerCityAdmissionFence(tx);await lockJobResources(tx,job);const [current]=await tx.select({id:jobs.id}).from(jobs).where(and(eq(jobs.id,job.id),eq(jobs.status,'PROCESSING'),eq(jobs.leaseToken,job.leaseToken))).limit(1).for('update',{noWait:true});if(!current)return;await tx.update(jobs).set({status:phase,leaseToken:'',leaseUntil:0,lastErrorCode:code,updateTime:now()}).where(eq(jobs.id,job.id));await tx.update(attempts).set({phase,errorCode:code,updateTime:now()}).where(eq(attempts.jobId,job.id));});}
  async process(jobId:number){
    const [hint]=await this.container.db.select().from(jobs).where(eq(jobs.id,jobId)).limit(1);if(!hint||!['PENDING','PROCESSING'].includes(hint.status))return;
    const claim=await withTx(this.container,async tx=>{await deadline(tx);await acquireCustomerCityAdmissionFence(tx);await lockJobResources(tx,hint);const [job]=await tx.select().from(jobs).where(eq(jobs.id,hint.id)).limit(1).for('update',{noWait:true});if(!job||!['PENDING','PROCESSING'].includes(job.status)||job.status==='PROCESSING'&&job.leaseUntil>now())return null;
      const [attempt]=await tx.select().from(attempts).where(eq(attempts.jobId,job.id)).limit(1);
      if(attempt){await tx.update(jobs).set({status:'UNKNOWN',lastErrorCode:'city_interrupted_attempt',leaseToken:'',leaseUntil:0,updateTime:now()}).where(eq(jobs.id,job.id));await tx.update(attempts).set({phase:'UNKNOWN',errorCode:'city_interrupted_attempt',updateTime:now()}).where(eq(attempts.id,attempt.id));return null;}
      try{await actorForJob(tx,job);const intent=intentFor(job),current=await liveIdentity(tx,intent.identity,true);if(current.fingerprint!==intent.order_fingerprint)throw new ValidateException('配送订单已变化');await assertSelectedCarts(tx,current,intent.cart_ids);await this.assertCurrentStation(tx,job,intent);await lockCityConfigForRead(tx);const settings=await readCityDeliverySettingsInTx(tx,this.env);if(settings.snapshot.revision!==intent.settings_revision)throw new ValidateException('配送配置已变化');}
      catch{await tx.update(jobs).set({status:'REVOKED',lastErrorCode:'city_preflight_revoked',updateTime:now()}).where(eq(jobs.id,job.id));return null;}
      const token=randomUUID(),time=now();await tx.update(jobs).set({status:'PROCESSING',leaseToken:token,leaseUntil:time+60,updateTime:time}).where(eq(jobs.id,job.id));await tx.insert(attempts).values({jobId:job.id,requestKey:job.requestKey,phase:'QUOTING',startedTime:time,updateTime:time});return {...job,status:'PROCESSING' as const,leaseToken:token};});
    if(!claim)return;const intent=intentFor(claim);let quote:CustomerCityQuote;
    try{quote=await this.provider.quote(intent.issue);}catch(e){await this.mark(claim,e instanceof CustomerCityProviderRejection?'REJECTED':'UNKNOWN',errorCode(e));return;}
    let authorized=false;
    try{authorized=await withTx(this.container,async tx=>{await deadline(tx);await acquireCustomerCityAdmissionFence(tx);await lockJobResources(tx,claim);const [job]=await tx.select().from(jobs).where(and(eq(jobs.id,claim.id),eq(jobs.leaseToken,claim.leaseToken),eq(jobs.status,'PROCESSING'))).limit(1).for('update',{noWait:true});if(!job)return false;await actorForJob(tx,job);const current=await liveIdentity(tx,intent.identity,true);if(current.fingerprint!==intent.order_fingerprint)throw new ValidateException('配送订单已变化');await assertSelectedCarts(tx,current,intent.cart_ids);await this.assertCurrentStation(tx,job,intent);await lockCityConfigForRead(tx);const settings=await readCityDeliverySettingsInTx(tx,this.env);if(settings.snapshot.revision!==intent.settings_revision)throw new ValidateException('配送配置已变化');await tx.update(attempts).set({phase:'ISSUING',quote:quote as unknown as Record<string,unknown>,issuedTime:now(),updateTime:now()}).where(eq(attempts.jobId,job.id));return true;});}
    catch{await this.mark(claim,'REVOKED','city_before_issue_revoked');return;}if(!authorized)return;
    let issued:CustomerCityIssued;
    try{issued=await this.provider.issue(intent.issue,quote);}catch(e){await this.mark(claim,e instanceof CustomerCityProviderRejection?'REJECTED':'UNKNOWN',errorCode(e));return;}
    try{
      issuedFor(issued);
      await withTx(this.container,async tx=>{await deadline(tx);await acquireCustomerCityAdmissionFence(tx);await lockJobResources(tx,claim);const [current]=await tx.select().from(jobs).where(eq(jobs.id,claim.id)).limit(1).for('update',{noWait:true});if(!current||!(current.status==='UNKNOWN'||current.status==='PROCESSING'&&current.leaseToken===claim.leaseToken))throw Error('city_effect_lease_changed');await tx.update(attempts).set({result:issued as unknown as Record<string,unknown>,updateTime:now()}).where(and(eq(attempts.jobId,claim.id),eq(attempts.requestKey,claim.requestKey),inArray(attempts.phase,['ISSUING','UNKNOWN'])));});
      await this.apply(claim,issued);
    }catch{await this.mark(claim,'UNKNOWN','city_provider_accepted_local_unresolved');}
  }
  private async apply(job:CityJob,result:CustomerCityIssued){
    issuedFor(result);const intent=intentFor(job);return withTx(this.container,async tx=>{await deadline(tx);await acquireCustomerCityAdmissionFence(tx);await lockJobResources(tx,job);
      const [current]=await tx.select().from(jobs).where(eq(jobs.id,job.id)).limit(1).for('update',{noWait:true});if(!current||!['PROCESSING','UNKNOWN'].includes(current.status))return;
      const before=await liveIdentity(tx,intent.identity,true);if(before.fingerprint!==intent.order_fingerprint)throw Error('city_order_changed_after_provider');
      const [attempt]=await tx.select().from(attempts).where(eq(attempts.jobId,job.id)).limit(1).for('update',{noWait:true});if(!attempt)throw Error('city_attempt_missing');
      const input:SupplierDeliveryInput={deliveryType:'city_delivery',deliveryName:job.provider==='dada'?'达达配送':'UU跑腿',deliveryId:result.delivery_no,deliveryCode:job.provider,fictitiousContent:'',deliveryUid:0};
      const options={cityDeliveryJobId:job.id,expectedStoreId:job.storeId,expectedRootStoreId:intent.root_store_id,authorize:async(_tx:DbClient,identity:{requestedOrderId:number;rootOrderId:number;customerUid:number;supplierId:number})=>{if(identity.requestedOrderId!==job.orderId||identity.rootOrderId!==job.rootOrderId||identity.customerUid!==job.customerUid||identity.supplierId!==job.supplierId)throw Error('city_fulfillment_identity_conflict');},audit:{changeType:'customer_city_delivery_actor',changeMessage:JSON.stringify({actor_uid:job.actorUid,service_id:job.serviceId,request_key:job.requestKey,job_id:job.id})},replay:{changeType:intent.cart_ids.length?'out_order_split_delivery' as const:'out_order_delivery' as const,accountId:job.actorUid,requestHash:job.requestHash}};
      const fulfillment=new SupplierFulfillmentService(createContainerFromDb(tx),this.env);
      const fulfilled=intent.cart_ids.length?await fulfillment.splitDelivery(job.supplierId,job.orderId,input,intent.cart_ids.map(c=>({cartId:c.cart_id,cartNum:c.cart_num})),options):await fulfillment.deliver(job.supplierId,job.orderId,input,options);
      const orderId=fulfilled.order_id,[physical]=await tx.select().from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1);if(!physical||physical.uid!==job.customerUid||physical.storeId!==job.storeId||physical.supplierId!==job.supplierId||physical.deliveryType!=='city_delivery')throw Error('city_fulfillment_projection_conflict');
      const time=now(),[delivery]=await tx.insert(storeDeliveryOrder).values({type:intent.issue.station.type,relationId:intent.issue.station.relation_id,oid:orderId,uid:job.customerUid,stationType:job.provider==='dada'?1:2,orderId:result.provider_order_id,deliveryNo:result.delivery_no,cargoPrice:intent.issue.cargo_price,userName:intent.issue.receiver_name,receiverPhone:intent.issue.receiver_phone,fromAddress:intent.issue.station.address,toAddress:intent.issue.receiver_address,cityCode:intent.issue.station.city_name,distance:result.distance,fee:result.fee,mark:intent.payload.delivery_remark,status:0,addTime:time}).returning({id:storeDeliveryOrder.id});if(!delivery)throw Error('city_delivery_record_missing');
      await tx.insert(bindings).values({jobId:job.id,attemptId:attempt.id,deliveryOrderId:delivery.id,orderId,rootOrderId:job.rootOrderId,customerUid:job.customerUid,storeId:job.storeId,supplierId:job.supplierId,provider:job.provider,providerOrderId:result.provider_order_id,active:1,addTime:time,updateTime:time});
      await tx.update(attempts).set({phase:'ACCEPTED',result:result as unknown as Record<string,unknown>,updateTime:time}).where(eq(attempts.id,attempt.id));
      await tx.update(jobs).set({status:'ADMITTED',providerOrderId:result.provider_order_id,leaseToken:'',leaseUntil:0,lastErrorCode:'',updateTime:time}).where(eq(jobs.id,job.id));
    });
  }
  /** Read-only provider reconciliation; never republishes an ambiguous original intent. */
  async recover(actor:CustomerWorkActor,jobId:number){
    const owned=await this.outcome(actor,jobId),scope=await authorizeCustomerWorkActor(this.container.db,actor),[job]=await this.container.db.select().from(jobs).where(eq(jobs.id,jobId)).limit(1);if(!job||scope.service_id!==job.serviceId||scope.scope_key!==job.scopeKey)throw new AuthException('请重新确认手机经营身份');
    if(owned.status!=='UNKNOWN')return owned;
    const [attempt]=await this.container.db.select().from(attempts).where(eq(attempts.jobId,job.id)).limit(1);if(!attempt?.issuedTime)return owned;
    intentFor(job);
    const quote=attempt.quote as unknown as CustomerCityQuote;
    if(job.provider==='dada'){
      if(!quote.delivery_no||quote.provider_order_id!==job.providerOrderId)throw Error('city_original_quote_binding_missing');
      const event=await new DadaCityDeliveryProvider(this.env,()=>this.settings.dada()).query(job.providerOrderId);
      if(!['1','2','3','4','100'].includes(event.providerStatus))return owned;
      await this.apply(job,{provider_order_id:job.providerOrderId,delivery_no:quote.delivery_no,distance:quote.distance,fee:quote.fee});
    }else{
      if(this.env.CUSTOMER_CITY_UU_ORIGIN_BINDING_CONTRACT!=='uu-v3-originId-return-v1')return owned;
      const result=attempt.result as unknown as CustomerCityIssued;if(!result.provider_order_id||!result.delivery_no)return owned;
      const event=await new UuCityDeliveryProvider(this.env,()=>this.settings.uu()).query(result.provider_order_id);
      if(!['1','3','4','5','6','10'].includes(event.providerStatus))return owned;if(event.payload.providerOrderCode!==result.delivery_no)throw Error('city_provider_recovery_binding_conflict');await this.apply(job,result);
    }return this.outcome(actor,jobId);
  }
}

/** Called only after the legacy delivery-table and root/order resource fences.
 * Old installations with all three new tables absent keep the strict legacy
 * single-attempt rule. Partial or malformed installations fail closed. */
export async function customerCityProjectionBinding(tx:DbClient,delivery:typeof storeDeliveryOrder.$inferSelect,order:typeof storeOrder.$inferSelect){
  const [catalog]=await tx.execute<{installed:number}>(sql`SELECT count(*)::int AS installed FROM pg_class WHERE oid IN(to_regclass('public.customer_city_delivery_job'),to_regclass('public.customer_city_delivery_attempt'),to_regclass('public.customer_city_delivery_binding'))`);
  if(catalog?.installed===0)return null;if(catalog?.installed!==3)throw Error('city_binding_catalog_partial');
  await assertCustomerCityDeliveryReady(tx);
  const [binding]=await tx.select().from(bindings).where(eq(bindings.deliveryOrderId,delivery.id)).limit(1).for('update',{noWait:true});
  if(!binding)return null;
  const [job]=await tx.select().from(jobs).where(eq(jobs.id,binding.jobId)).limit(1).for('update',{noWait:true});
  const [attempt]=await tx.select().from(attempts).where(eq(attempts.id,binding.attemptId)).limit(1).for('update',{noWait:true});
  const rootId=order.pid>0?order.pid:order.id;
  if(!job||!attempt||attempt.jobId!==job.id||attempt.phase!=='ACCEPTED'||attempt.requestKey!==job.requestKey||!['ADMITTED','CANCELLED','DELIVERED'].includes(job.status)||binding.orderId!==order.id||binding.rootOrderId!==rootId||binding.customerUid!==order.uid||binding.storeId!==order.storeId||binding.supplierId!==order.supplierId||binding.providerOrderId!==delivery.orderId||binding.provider!==job.provider||binding.providerOrderId!==job.providerOrderId||job.customerUid!==binding.customerUid||job.storeId!==binding.storeId||job.supplierId!==binding.supplierId||job.rootOrderId!==rootId)throw Error('city_exact_attempt_binding_conflict');
  intentFor(job);const accepted=issuedFor(attempt.result as unknown as CustomerCityIssued);
  if(accepted.provider_order_id!==delivery.orderId||accepted.delivery_no!==delivery.deliveryNo||delivery.stationType!==(job.provider==='dada'?1:2))throw Error('city_exact_provider_result_binding_conflict');
  if(binding.active!==1){
    if(job.status!=='CANCELLED')throw Error('city_inactive_attempt_conflict');
    const competing=await tx.select({id:jobs.id}).from(jobs).where(and(eq(jobs.rootOrderId,rootId),inArray(jobs.status,['PENDING','PROCESSING','UNKNOWN','ADMITTED']))).limit(1);
    if(competing.length)throw Error('city_historical_attempt_conflict');
  }
  return binding;
}
export async function finishCustomerCityProjection(tx:DbClient,binding:typeof bindings.$inferSelect|null,status:'CANCELLED'|'DELIVERED'){
  if(!binding)return;const time=now();
  await tx.update(jobs).set({status,updateTime:time}).where(eq(jobs.id,binding.jobId));
  if(status==='CANCELLED')await tx.update(bindings).set({active:0,updateTime:time}).where(eq(bindings.jobId,binding.jobId));
}
