/** Codec/candidate-author units only: catalog and SQL identity are explicit
 * stubs. They do not prove a real LOGIN, committed new producer or send grant. */
import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { captureRoutineSubscriptionNoticeBusiness,createRoutineSubscriptionNoticeRequestTx,parseRoutineSubscriptionNoticeRequest,
 type NoticeBusiness,type RoutineSubscriptionNoticeRequest } from '@/services/wechat/RoutineSubscriptionNoticeRequest';

const catalog=vi.hoisted(()=>vi.fn());
vi.mock('@/migrations/routineSubscriptionDelivery',()=>({inspectRoutineSubscriptionDeliveryCatalog:catalog}));
const env={APP_KEY:'inert-notice-request-signing-key'},scope={database:'notice_fixture',databaseOid:'102',maintenance:'notice_owner',maintenanceOid:'103'};
const actor={role:'notice_admin',roleOid:'104'},now=1793602800;
const business:NoticeBusiness={orderId:17,orderNo:'order_notice_17',userId:11,deliveryType:'express',
 deliveryName:'标本承运商',deliveryId:'NOTICE-17',userAddress:'测试收货地址'};
const raw=()=>({eventKey:'order.delivery.notice:17',aggregateId:17,payload:{...business},now});
const context=()=>({...scope,...actor,now:String(now+1),ready:true});
const ready=()=>({present:true,ready:true,failures:[],binding:{maintenance:scope.maintenance,maintenanceOid:scope.maintenanceOid,app:'notice_app',appOid:'105'}});
function mockQuery(){const execute=vi.fn(async(_query:unknown)=>[context()]);return{execute,tx:{execute} as unknown as Pick<DbClient,'execute'>};}
const message='小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)
  .map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
function mac(body:unknown,domain='notice-request'){
 return createHmac('sha256',env.APP_KEY).update('cinashop.routine.original-payment.subscription-'+domain+'.v1\0').update(canonical(body)).digest('hex');
}
async function signed():Promise<Readonly<RoutineSubscriptionNoticeRequest>>{const {tx}=mockQuery(),result=await createRoutineSubscriptionNoticeRequestTx(tx,env,raw());
 if(result.kind!=='original'||'unavailable'in result.request)throw Error('Fixture signed candidate missing');return result.request;}
const unavailable={kind:'original',request:{format:2,unavailable:true}};

describe('versioned subscription notice request candidate/codec without real SQL claims',()=>{
 beforeEach(()=>{catalog.mockReset().mockResolvedValue(ready());});

 it('copies exact facts and independently MAC-binds version, scope, actor, event, UUID and SQL createdAt',async()=>{
  const {tx,execute}=mockQuery(),result=await createRoutineSubscriptionNoticeRequestTx(tx,env,raw());
  expect(result.kind).toBe('original');if(result.kind!=='original'||'unavailable'in result.request)throw Error('Expected signed fixture');
  const request=result.request;expect(request).toMatchObject({format:2,scope,actor,eventKey:raw().eventKey,aggregateId:17,eventTime:now,body:business,createdAt:now+1});
  expect(request.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  const {signature,...body}=request;expect(signature).toBe(mac(body));
  expect(parseRoutineSubscriptionNoticeRequest(env,JSON.parse(JSON.stringify(request)),scope)).toEqual(request);
  for(const value of [result,request,request.scope,request.actor,request.body])expect(Object.isFrozen(value)).toBe(true);
  expect(catalog).toHaveBeenCalledWith(tx);expect(execute).toHaveBeenCalledTimes(1);
  const query=new PgDialect().sqlToQuery(execute.mock.calls[0][0] as never);
  expect(query.sql).toContain('current_user=session_user');expect(query.sql).toContain("transaction_isolation')='read committed'");
  expect(query.sql).toContain("transaction_read_only')='off'");expect(query.sql).toContain('pg_catalog.pg_backend_pid()');
  expect(query.sql).toContain('NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit');
  expect(query.sql).not.toMatch(/pg_(?:try_)?advisory|set_config|\bGRANT\b|\bINSERT\s+INTO\b|\bUPDATE\b/u);
  expect(query.sql).not.toMatch(/FROM\s+(?:public\.)?(?:routine_original_payment_evidence|routine_identity_ownership|routine_payment_account_policy|routine_subscription_account_policy)\b/u);
 });

 it('captures DTO and APP_KEY before the first asynchronous catalog read',async()=>{
  let release!:(value:ReturnType<typeof ready>)=>void;catalog.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const {tx}=mockQuery(),dto=raw(),mutable={...env};
  const pending=createRoutineSubscriptionNoticeRequestTx(tx,mutable,dto);
  dto.payload.deliveryId='changed';dto.payload.userAddress='changed';dto.now=1;mutable.APP_KEY='changed';
  release(ready());const result=await pending;
  if(result.kind!=='original'||'unavailable'in result.request)throw Error('Expected captured candidate');
  expect(result.request.body).toEqual(business);expect(result.request.eventTime).toBe(now);
  expect(parseRoutineSubscriptionNoticeRequest(env,result.request,scope)).toEqual(result.request);
  expect(()=>parseRoutineSubscriptionNoticeRequest(mutable,result.request,scope)).toThrow(message);
 });

 it('uses legacy only for complete namespace absence even when signing material is missing',async()=>{
  catalog.mockResolvedValue({present:false,ready:false,failures:[],binding:null});const {tx,execute}=mockQuery();
  expect(await createRoutineSubscriptionNoticeRequestTx(tx,undefined,raw())).toEqual({kind:'legacy'});expect(execute).not.toHaveBeenCalled();
 });

 it.each([{present:true,ready:false,failures:['namespace'],binding:null},
  {present:true,ready:false,failures:['acl'],binding:ready().binding},
  {present:true,ready:true,failures:[],binding:null}])('keeps partial/unbound catalog %# unavailable without legacy fallback',async(value)=>{
  catalog.mockResolvedValue(value);const {tx,execute}=mockQuery();expect(await createRoutineSubscriptionNoticeRequestTx(tx,env,raw())).toEqual(unavailable);
  expect(execute).not.toHaveBeenCalled();
 });

 it.each([undefined,{}, {APP_KEY:''},{APP_KEY:'x'.repeat(8193)}])('keeps absent/invalid signing material %# unavailable',async(value)=>{
  const {tx,execute}=mockQuery();expect(await createRoutineSubscriptionNoticeRequestTx(tx,value,raw())).toEqual(unavailable);expect(execute).not.toHaveBeenCalled();
 });

 it('never invokes an APP_KEY getter and cannot borrow an inherited key',async()=>{
  let reads=0;const {tx,execute}=mockQuery(),getter={get APP_KEY(){reads++;return env.APP_KEY;}};
  expect(await createRoutineSubscriptionNoticeRequestTx(tx,getter,raw())).toEqual(unavailable);
  expect(await createRoutineSubscriptionNoticeRequestTx(tx,Object.create(env),raw())).toEqual(unavailable);
  expect(reads).toBe(0);expect(execute).not.toHaveBeenCalled();
 });

 it('refuses a root connection or false SQL writer proof without signing',async()=>{
  const {tx,execute}=mockQuery();expect(await createRoutineSubscriptionNoticeRequestTx({...tx,$client:{}} as unknown as DbClient,env,raw())).toEqual(unavailable);
  execute.mockResolvedValue([{...context(),ready:false}]);expect(await createRoutineSubscriptionNoticeRequestTx(tx,env,raw())).toEqual(unavailable);
 });

 it.each([{now:'0'},{role:'pg_superuser'},{roleOid:'0'},{databaseOid:'0002'}])('refuses malformed SQL provenance %#',async(patch)=>{
  const execute=vi.fn(async()=>[{...context(),...patch}]);expect(await createRoutineSubscriptionNoticeRequestTx({execute} as unknown as DbClient,env,raw())).toEqual(unavailable);
 });

 it('propagates genuine catalog and SQL faults for the caller real savepoint instead of continuing an aborted transaction',async()=>{
  const {tx,execute}=mockQuery(),fault=Error('synthetic SQL fault');catalog.mockRejectedValueOnce(fault);
  await expect(createRoutineSubscriptionNoticeRequestTx(tx,env,raw())).rejects.toBe(fault);
  execute.mockRejectedValueOnce(fault);await expect(createRoutineSubscriptionNoticeRequestTx(tx,env,raw())).rejects.toBe(fault);
 });

 it('does not sign guest or fictitious requests when the protocol is present',async()=>{
  for(const payload of [{...business,userId:0},{...business,deliveryType:'fictitious' as const}]){
   const {tx,execute}=mockQuery();expect(await createRoutineSubscriptionNoticeRequestTx(tx,env,{...raw(),payload})).toEqual(unavailable);
   expect(execute).not.toHaveBeenCalled();
  }
 });

 it('binds the exact city suffix and refuses foreign city fields or mismatched aggregate identity',async()=>{
  const city={...business,deliveryType:'city_delivery' as const,cityDeliveryJobId:27};const {tx}=mockQuery();
  const result=await createRoutineSubscriptionNoticeRequestTx(tx,env,{...raw(),payload:city,eventKey:'order.delivery.notice:17:city:27'});
  if(result.kind!=='original'||'unavailable'in result.request)throw Error('Expected city candidate');
  expect(parseRoutineSubscriptionNoticeRequest(env,result.request,scope).body).toEqual(city);
  for(const patch of [{payload:city},{payload:{...business,cityDeliveryJobId:27}},{aggregateId:18},{eventKey:'order.delivery.notice:017'}])
   await expect(createRoutineSubscriptionNoticeRequestTx(tx,env,{...raw(),...patch})).rejects.toMatchObject({code:503,message});
 });

 it('rejects getters, symbols, arrays and extra facts before SQL without coercion',async()=>{
  let reads=0;const {tx,execute}=mockQuery(),withGetter={...business,get deliveryName(){reads++;return 'unexpected';}},
   coercion={toString(){reads++;return 'express';}};
  for(const payload of [withGetter,{...business,deliveryType:coercion},{...business,routineAppId:'not-accepted'},
   {...business,[Symbol('extra')]:true},[business]])
   await expect(createRoutineSubscriptionNoticeRequestTx(tx,env,{...raw(),payload} as unknown as ReturnType<typeof raw>)).rejects.toMatchObject({code:503,message});
  expect(reads).toBe(0);expect(catalog).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
 });

 it('counts Unicode scalar lengths and rejects unpaired surrogates without changing original business bytes',()=>{
  expect(captureRoutineSubscriptionNoticeBusiness({...business,deliveryName:'😀'.repeat(64),userAddress:'a\nb'}).deliveryName).toHaveLength(128);
  for(const patch of [{deliveryName:'😀'.repeat(65)},{deliveryId:'x'.repeat(65)},{userAddress:'x'.repeat(101)},
   {orderNo:'x'.repeat(33)},{deliveryName:'\ud800'},{userId:-1},{orderId:2147483648}])
   expect(()=>captureRoutineSubscriptionNoticeBusiness({...business,...patch})).toThrow(message);
 });

 it('authenticates historical provenance without requiring the writer to remain active or using the current clock as approval',async()=>{
  const request=await signed();catalog.mockRejectedValue(Error('must not inspect current writer/catalog'));
  const date=vi.spyOn(Date,'now').mockReturnValue(0);
  try{expect(parseRoutineSubscriptionNoticeRequest(env,request,scope)).toEqual(request);expect(catalog).toHaveBeenCalledTimes(1);}
  finally{date.mockRestore();}
 });

 it('rejects absent/unavailable/legacy bodies and wrong MAC domain, key or scope',async()=>{
  const request=await signed(),{signature:_signature,...body}=request;
  for(const value of [{format:2,unavailable:true},{...business,routineAppId:'legacy'}, {...request,signature:mac(body,'shipping-request')},
   {...request,signature:'0'.repeat(64)}, {...request,format:1}])
   expect(()=>parseRoutineSubscriptionNoticeRequest(env,value,scope)).toThrow(message);
  expect(()=>parseRoutineSubscriptionNoticeRequest({APP_KEY:'wrong-key'},request,scope)).toThrow(message);
  expect(()=>parseRoutineSubscriptionNoticeRequest(env,request,{...scope,databaseOid:'999'})).toThrow(message);
 });

 it('rejects every altered signed field, nested getter and extra field',async()=>{
  const request=await signed();
  const changes=[{requestId:'b2312692-b2bd-4dce-a24b-c80578fc660d'},{actor:{...actor,roleOid:'105'}},
   {scope:{...scope,maintenanceOid:'104'}},{eventKey:'order.delivery.notice:18'},{aggregateId:18},{eventTime:now-1},
   {body:{...business,deliveryId:'altered'}},{createdAt:now+2},{extra:true}];
  for(const patch of changes)expect(()=>parseRoutineSubscriptionNoticeRequest(env,{...request,...patch},scope)).toThrow(message);
  let reads=0;expect(()=>parseRoutineSubscriptionNoticeRequest(env,{...request,get signature(){reads++;return request.signature;}},scope)).toThrow(message);
  expect(reads).toBe(0);
 });
});
