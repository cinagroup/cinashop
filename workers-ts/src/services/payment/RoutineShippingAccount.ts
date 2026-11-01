import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { assertRoutineShippingReadyTx, assertRoutineShippingReadTx, inspectRoutineShippingCatalog, ROUTINE_SHIPPING_GATE } from '@/migrations/routineShipping';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { ServiceUnavailableException } from '@/utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';

export type RoutineShippingEnv = Pick<Env,'APP_KEY'|'ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS'>;
type Signing = Pick<Env,'APP_KEY'>;
export interface RoutineShippingScope { database:string; databaseOid:string; maintenance:string; maintenanceOid:string }
export interface RoutineShippingAccountPolicy {
 accountId:string;state:'active'|'revoked';appId:string;merchantId:string;credentialRef:string;credentialVersion:number;
 credentialStamp:string;purposes:['shipping_upload'];validFrom:number;validUntil:number;
}
export interface RoutineShippingAccountJournal {
 record_id:string;account_id:string;revision:number;payload:{format:1;scope:RoutineShippingScope;previousRecordId:string;data:RoutineShippingAccountPolicy};created_at:number;signature:string;
}
interface Materials {ref:string;version:number;appId:string;secret:string}
const preparedSlot=Symbol('routine.shipping.prepared-account.v1');
export interface PreparedRoutineShippingAccount {readonly account:RoutineShippingAccountJournal;readonly [preparedSlot]:true}
const privateMaterials=new WeakMap<PreparedRoutineShippingAccount,Readonly<Materials>>();
export const routineShippingUnavailable=():never=>{throw new ServiceUnavailableException('小程序原账号发货批准、凭据或证据尚未完整就绪');};
export const shippingHex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export const shippingUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
export const shippingInteger=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const token=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`,'u').test(v);
export function shippingObject(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return routineShippingUnavailable();
 const ds=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k])))return routineShippingUnavailable();
 return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
export function freezeShipping<T>(value:T):T{
 if(value&&typeof value==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freezeShipping(d.value);Object.freeze(value);}return value;
}
export const shippingSame=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
export const shippingMac=(env:Signing,domain:string,value:unknown)=>routineEvidenceHmac(env,'shipping-'+domain,value);
export function shippingEqual(actual:unknown,expected:string){return shippingHex(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
/** Snapshot deployment primitives before BEGIN/provider/cache awaits. No current
 * SQL pair, cfg cache, path, URL or arbitrary environment selector is consulted. */
export function captureRoutineShippingEnv(env:RoutineShippingEnv):RoutineShippingEnv{
 const value={APP_KEY:env.APP_KEY,ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS:env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS};
 if(typeof value.APP_KEY!=='string'||!value.APP_KEY||value.APP_KEY.length>8192
  ||value.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS!==undefined&&typeof value.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS!=='string')return routineShippingUnavailable();
 return Object.freeze(value);
}
function materials(env:RoutineShippingEnv,ref:string,version:number):Readonly<Materials>{
 if(!token(ref)||!shippingInteger(version))return routineShippingUnavailable();
 const text=env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS;
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>131072)return routineShippingUnavailable();
 let parsed:unknown;try{parsed=JSON.parse(text);}catch{return routineShippingUnavailable();}
 const r=shippingObject(parsed,['format','credentials']);
 if(r.format!==1||!Array.isArray(r.credentials)||!r.credentials.length||r.credentials.length>16)return routineShippingUnavailable();
 const all=r.credentials.map(raw=>{
  const c=shippingObject(raw,['ref','version','appId','secret']);
  if(!token(c.ref)||!shippingInteger(c.version)||!token(c.appId,32)||typeof c.secret!=='string'||!/^[\x21-\x7e]{1,512}$/u.test(c.secret))return routineShippingUnavailable();
  return Object.freeze({ref:c.ref,version:c.version,appId:c.appId,secret:c.secret});
 });
 if(new Set(all.map(c=>`${c.ref}:${c.version}`)).size!==all.length)return routineShippingUnavailable();
 const found=all.find(c=>c.ref===ref&&c.version===version);return found??routineShippingUnavailable();
}
export function routineShippingCredentialCommitment(env:RoutineShippingEnv,ref:string,version:number){
 env=captureRoutineShippingEnv(env);const m=materials(env,ref,version);
 return Object.freeze({appId:m.appId,credentialStamp:shippingMac(env,'app-materials',m)});
}
/** Exactly one latest journal exists for an authenticated original pair. A
 * second arbitrary account ID cannot bypass retirement of the first. */
export function routineShippingAccountId(env:Signing,appId:string,merchantId:string){
 if(!token(appId,32)||typeof merchantId!=='string'||!/^[0-9]{1,32}$/u.test(merchantId))return routineShippingUnavailable();
 return shippingMac(env,'account-subject',[appId,merchantId]);
}
function policy(env:Signing,value:unknown):RoutineShippingAccountPolicy{
 const r=shippingObject(value,['accountId','state','appId','merchantId','credentialRef','credentialVersion','credentialStamp','purposes','validFrom','validUntil']);
 if(!token(r.appId,32)||typeof r.merchantId!=='string'||!/^[0-9]{1,32}$/u.test(r.merchantId)
  ||r.accountId!==routineShippingAccountId(env,r.appId,r.merchantId)||!token(r.credentialRef)||!shippingInteger(r.credentialVersion)||!shippingHex(r.credentialStamp)
  ||r.state!=='active'&&r.state!=='revoked'||!shippingInteger(r.validFrom)||!shippingInteger(r.validUntil)||r.validUntil<=r.validFrom||r.validUntil-r.validFrom>366*86400)return routineShippingUnavailable();
 const p=r.purposes;
 if(!Array.isArray(p)||Object.getPrototypeOf(p)!==Array.prototype||p.length!==1||Reflect.ownKeys(p).length!==2
  ||!Object.getOwnPropertyDescriptor(p,'0')?.enumerable||!('value'in Object.getOwnPropertyDescriptor(p,'0')!)||p[0]!=='shipping_upload')return routineShippingUnavailable();
 return{accountId:r.accountId as string,state:r.state,appId:r.appId,merchantId:r.merchantId,credentialRef:r.credentialRef,
  credentialVersion:r.credentialVersion,credentialStamp:r.credentialStamp,purposes:['shipping_upload'],validFrom:r.validFrom,validUntil:r.validUntil};
}
export async function routineShippingScopeTx(tx:DbClient):Promise<RoutineShippingScope>{
 const [s]=await tx.execute<RoutineShippingScope & Record<string,unknown>>(sql`SELECT pg_catalog.current_database() AS database,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
  pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS "maintenanceOid"
  FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.routine_shipping_account_policy')`);
 if(!s||!token(s.database,128)||!token(s.maintenance,128)||!/^[0-9]+$/u.test(s.databaseOid)||!/^[0-9]+$/u.test(s.maintenanceOid))return routineShippingUnavailable();
 return{database:s.database,databaseOid:s.databaseOid,maintenance:s.maintenance,maintenanceOid:s.maintenanceOid};
}
export function parseRoutineShippingAccountJournal(env:Signing,raw:unknown,scope:RoutineShippingScope):RoutineShippingAccountJournal{
 const r=shippingObject(raw,['record_id','account_id','revision','payload','created_at','signature']),p=shippingObject(r.payload,['format','scope','previousRecordId','data']);
 const s=shippingObject(p.scope,['database','databaseOid','maintenance','maintenanceOid']);
 const created=typeof r.created_at==='string'&&/^[0-9]+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!shippingUuid(r.record_id)||!shippingHex(r.account_id)||!shippingInteger(r.revision)||!shippingInteger(created)||p.format!==1||!shippingSame(s,scope)
  ||p.previousRecordId!==''&&!shippingUuid(p.previousRecordId)||!shippingHex(r.signature))return routineShippingUnavailable();
 const data=policy(env,p.data);if(data.accountId!==r.account_id)return routineShippingUnavailable();
 const body={record_id:r.record_id,account_id:r.account_id,revision:r.revision,payload:{format:1 as const,scope:{...scope},previousRecordId:p.previousRecordId as string,data},created_at:created};
 if(!shippingEqual(r.signature,shippingMac(env,'account-policy',body)))return routineShippingUnavailable();
 return freezeShipping({...body,signature:r.signature});
}
async function history(tx:DbClient,env:Signing,id:string,scope:RoutineShippingScope){
 const rows=await tx.execute(sql`SELECT * FROM public.routine_shipping_account_policy WHERE account_id=${id} ORDER BY revision LIMIT 65`);
 if(rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return routineShippingUnavailable();
 const decoded=Array.from(rows,r=>parseRoutineShippingAccountJournal(env,r,scope));
 for(let i=0;i<decoded.length;i++)if(decoded[i].account_id!==id||decoded[i].revision!==i+1
  ||decoded[i].payload.previousRecordId!==(i?decoded[i-1].record_id:'')||i>0&&decoded[i].created_at<decoded[i-1].created_at)return routineShippingUnavailable();
 return decoded;
}
export async function routineShippingClockTx(tx:DbClient){
 const [r]=await tx.execute<{now:string}>(sql`SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
 const now=Number(r?.now);return shippingInteger(now)?now:routineShippingUnavailable();
}
function prepared(env:RoutineShippingEnv,row:RoutineShippingAccountJournal,now:number):PreparedRoutineShippingAccount{
 const p=row.payload.data;
 if(p.state!=='active'||now<row.created_at||now<p.validFrom||now>=p.validUntil)return routineShippingUnavailable();
 const m=materials(env,p.credentialRef,p.credentialVersion);
 if(m.appId!==p.appId||!shippingEqual(p.credentialStamp,shippingMac(env,'app-materials',m)))return routineShippingUnavailable();
 const result=Object.freeze({account:row,[preparedSlot]:true as const});privateMaterials.set(result,m);return result;
}
export function routineShippingAccountMaterials(value:PreparedRoutineShippingAccount):Readonly<Materials>{
 return privateMaterials.get(value)??routineShippingUnavailable();
}
/** Caller already holds the shipping gate before physical locks. This reader
 * acquires no backwards gate and uses the real original pair, never config. */
export async function prepareRoutineShippingAccountTx(tx:DbClient,env:RoutineShippingEnv,appId:string,merchantId:string){
 env=captureRoutineShippingEnv(env);
 if(!await assertRoutineShippingReadTx(tx))return routineShippingUnavailable();
 const [gate]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_setting('transaction_isolation')='read committed'
  AND pg_catalog.current_setting('transaction_read_only')='off' AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
  AND pid=pg_catalog.pg_backend_pid() AND classid=${ROUTINE_SHIPPING_GATE[0]}::oid AND objid=${ROUTINE_SHIPPING_GATE[1]}::oid
  AND objsubid=2 AND mode='ShareLock' AND granted) AS ready`);
 if(gate?.ready!==true)return routineShippingUnavailable();
 const scope=await routineShippingScopeTx(tx);
 const row=(await history(tx,env,routineShippingAccountId(env,appId,merchantId),scope)).at(-1);
 if(!row)return routineShippingUnavailable();return prepared(env,row,await routineShippingClockTx(tx));
}
/** Recheck immediately before each token/provider request. No I/O is performed
 * while the short SQL transaction or its maintenance gate remains open. */
export async function assertPreparedRoutineShippingAccount(container:Container,env:RoutineShippingEnv,value:PreparedRoutineShippingAccount){
 env=captureRoutineShippingEnv(env);
 if(!Object.hasOwn(container.db,'$client')||!container.db.$client)return routineShippingUnavailable();
 routineShippingAccountMaterials(value);
 return withTx(container,async tx=>{
  if(!await assertRoutineShippingReadyTx(tx))return routineShippingUnavailable();
  const s=await routineShippingScopeTx(tx),latest=(await history(tx,env,value.account.account_id,s)).at(-1);
  if(!latest||!shippingSame(latest,value.account))return routineShippingUnavailable();prepared(env,latest,await routineShippingClockTx(tx));
  const [tail]=await tx.execute<{valid:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${latest.payload.data.validUntil})
   AND pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS valid`);
  if(tail?.valid!==true)return routineShippingUnavailable();
 });
}
/** Durable proof reads historical approval only; retirement and secret removal
 * cannot erase an already accepted upload. It never grants fresh provider use. */
export async function assertRoutineShippingHistoricalAccountTx(tx:DbClient,env:Signing,row:RoutineShippingAccountJournal,at:number){
 if(!await assertRoutineShippingReadTx(tx))return routineShippingUnavailable();
 const s=await routineShippingScopeTx(tx),saved=(await history(tx,env,row.account_id,s)).find(r=>r.record_id===row.record_id);
 if(!saved||!shippingSame(saved,row)||!shippingInteger(at)||saved.payload.data.state!=='active'
  ||at<saved.created_at||at<saved.payload.data.validFrom||at>=saved.payload.data.validUntil)return routineShippingUnavailable();
 return saved;
}
/** Explicit maintenance author. The operator supplies audited original-pair
 * authority; this API does not discover ownership or provision AppSecrets. */
export async function appendRoutineShippingAccountPolicy(db:DbClient,env:RoutineShippingEnv,
 declared:Pick<RoutinePaymentRuntimeTarget,'database'|'maintenance'|'app'|'admin'>,
 input:{operationId:string;expectedRevision:number;data:RoutineShippingAccountPolicy}){
 env=captureRoutineShippingEnv(env);const r=shippingObject(input,['operationId','expectedRevision','data']);
 const t=shippingObject(declared,['database','maintenance','app','admin']);
 if(!shippingUuid(r.operationId)||!Number.isSafeInteger(r.expectedRevision)||Number(r.expectedRevision)<0||Number(r.expectedRevision)>=64
  ||Object.values(t).some(v=>!token(v,128)))return routineShippingUnavailable();
 const target=t as unknown as Pick<RoutinePaymentRuntimeTarget,'database'|'maintenance'|'app'|'admin'>;
 const operationId=r.operationId,expectedRevision=Number(r.expectedRevision),data=policy(env,r.data);
 return withTx(createContainerFromDb(db),async tx=>{
  await tx.execute(sql`SELECT
   pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
   pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
   pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_database()=${target.database} AND current_user=${target.maintenance}
   AND current_user=session_user AND r.rolsuper AND r.rolcanlogin AND pg_catalog.current_schema()='public'
   AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
   AND pg_catalog.current_setting('server_version_num')::integer/10000=16 AND pg_catalog.current_setting('transaction_isolation')='read committed'
   AND pg_catalog.current_setting('transaction_read_only')='off' AND pg_catalog.current_setting('session_replication_role')='origin' AS ready
   FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if(identity?.ready!==true)return routineShippingUnavailable();
  const [gate]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${ROUTINE_SHIPPING_GATE[0]},${ROUTINE_SHIPPING_GATE[1]}) AS locked`);
  if(gate?.locked!==true||!(await inspectRoutineShippingCatalog(tx,target)).ready)return routineShippingUnavailable();
  const s=await routineShippingScopeTx(tx),rows=await history(tx,env,data.accountId,s);
  const globalRows=await tx.execute(sql`SELECT * FROM public.routine_shipping_account_policy WHERE record_id=${operationId}::uuid LIMIT 2`);
  if(globalRows.length>1)return routineShippingUnavailable();
  const replay=globalRows.length?parseRoutineShippingAccountJournal(env,globalRows[0],s):undefined;
  if(replay&&replay.account_id!==data.accountId)return routineShippingUnavailable();
  if(replay){if(replay.revision!==expectedRevision+1||!shippingSame(replay.payload.data,data))return routineShippingUnavailable();return{recordId:replay.record_id,revision:replay.revision,replayed:true};}
  const prior=rows.at(-1),now=await routineShippingClockTx(tx);
  if((prior?.revision??0)!==expectedRevision||prior&&now<prior.created_at||data.state==='active'&&now>=data.validUntil)return routineShippingUnavailable();
  if(data.state==='active'){
   const c=routineShippingCredentialCommitment(env,data.credentialRef,data.credentialVersion);
   if(c.appId!==data.appId||c.credentialStamp!==data.credentialStamp)return routineShippingUnavailable();
  }
  const body={record_id:operationId,account_id:data.accountId,revision:expectedRevision+1,
   payload:{format:1 as const,scope:s,previousRecordId:prior?.record_id??'',data},created_at:now};
  await tx.execute(sql`INSERT INTO public.routine_shipping_account_policy(record_id,account_id,revision,payload,created_at,signature)
   VALUES(${operationId}::uuid,${body.account_id},${body.revision},${JSON.stringify(body.payload)}::text::jsonb,${now},${shippingMac(env,'account-policy',body)})`);
  const [saved]=await tx.execute(sql`SELECT * FROM public.routine_shipping_account_policy WHERE record_id=${operationId}::uuid`);
  if(!shippingSame(parseRoutineShippingAccountJournal(env,saved,s),{...body,signature:shippingMac(env,'account-policy',body)}))return routineShippingUnavailable();
  return{recordId:operationId,revision:body.revision,replayed:false};
 });
}
