import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { assertRoutineSubscriptionReadyTx, assertRoutineSubscriptionReadTx, inspectRoutineSubscriptionCatalog, ROUTINE_SUBSCRIPTION_GATE } from '@/migrations/routineSubscription';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { ServiceUnavailableException } from '@/utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from '@/services/payment/RoutineProviderObservation';

export type RoutineSubscriptionEnv = Pick<Env,'APP_KEY'|'ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS'>;
type Signing = Pick<Env,'APP_KEY'>;
export interface RoutineSubscriptionScope { database:string; databaseOid:string; maintenance:string; maintenanceOid:string }
export interface RoutineSubscriptionTemplate { mark:string;templateId:string }
export interface RoutineSubscriptionAccountPolicy {
 accountId:string;state:'active'|'revoked';appId:string;credentialRef:string;credentialVersion:number;
 credentialStamp:string;purposes:['subscription_send'];templates:RoutineSubscriptionTemplate[];validFrom:number;validUntil:number;
}
export interface RoutineSubscriptionAccountJournal {
 record_id:string;account_id:string;revision:number;payload:{format:1;scope:RoutineSubscriptionScope;previousRecordId:string;data:RoutineSubscriptionAccountPolicy};created_at:number;signature:string;
}
interface Materials {ref:string;version:number;appId:string;secret:string}
const preparedSlot=Symbol('routine.subscription.prepared-account.v1');
export interface PreparedRoutineSubscriptionAccount {
 readonly account:RoutineSubscriptionAccountJournal;readonly template:Readonly<RoutineSubscriptionTemplate>;readonly [preparedSlot]:true;
}
const privateMaterials=new WeakMap<PreparedRoutineSubscriptionAccount,Readonly<Materials>>();
export const routineSubscriptionUnavailable=():never=>{throw new ServiceUnavailableException('小程序原账号订阅通知批准、凭据或证据尚未完整就绪');};
export const subscriptionHex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export const subscriptionUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
export const subscriptionInteger=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const token=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`,'u').test(v);
export function subscriptionObject(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return routineSubscriptionUnavailable();
 const ds=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k])))return routineSubscriptionUnavailable();
 return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
export function freezeSubscription<T>(value:T):T{
 if(value&&typeof value==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freezeSubscription(d.value);Object.freeze(value);}return value;
}
export const subscriptionSame=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
export const subscriptionMac=(env:Signing,domain:string,value:unknown)=>routineEvidenceHmac(env,'subscription-'+domain,value);
export function subscriptionEqual(actual:unknown,expected:string){return subscriptionHex(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
/** Snapshot deployment primitives before BEGIN/provider/cache awaits. No current
 * SQL pair, cfg cache, path, URL or arbitrary environment selector is consulted. */
export function captureRoutineSubscriptionEnv(env:RoutineSubscriptionEnv):RoutineSubscriptionEnv{
 const value={APP_KEY:env.APP_KEY,ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS:env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS};
 if(typeof value.APP_KEY!=='string'||!value.APP_KEY||value.APP_KEY.length>8192
  ||value.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS!==undefined&&typeof value.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS!=='string')return routineSubscriptionUnavailable();
 return Object.freeze(value);
}
function materials(env:RoutineSubscriptionEnv,ref:string,version:number):Readonly<Materials>{
 if(!token(ref)||!subscriptionInteger(version))return routineSubscriptionUnavailable();
 const text=env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS;
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>131072)return routineSubscriptionUnavailable();
 let parsed:unknown;try{parsed=JSON.parse(text);}catch{return routineSubscriptionUnavailable();}
 const r=subscriptionObject(parsed,['format','credentials']);
 if(r.format!==1||!Array.isArray(r.credentials)||!r.credentials.length||r.credentials.length>16)return routineSubscriptionUnavailable();
 const all=r.credentials.map(raw=>{
  const c=subscriptionObject(raw,['ref','version','appId','secret']);
  if(!token(c.ref)||!subscriptionInteger(c.version)||!token(c.appId,32)||typeof c.secret!=='string'||!/^[\x21-\x7e]{1,512}$/u.test(c.secret))return routineSubscriptionUnavailable();
  return Object.freeze({ref:c.ref,version:c.version,appId:c.appId,secret:c.secret});
 });
 if(new Set(all.map(c=>`${c.ref}:${c.version}`)).size!==all.length)return routineSubscriptionUnavailable();
 const found=all.find(c=>c.ref===ref&&c.version===version);return found??routineSubscriptionUnavailable();
}
export function routineSubscriptionCredentialCommitment(env:RoutineSubscriptionEnv,ref:string,version:number){
 env=captureRoutineSubscriptionEnv(env);const m=materials(env,ref,version);
 return Object.freeze({appId:m.appId,credentialStamp:subscriptionMac(env,'app-materials',m)});
}
/** Exactly one latest journal exists for an intended AppID. A
 * second arbitrary account ID cannot bypass retirement of the first. */
export function routineSubscriptionAccountId(env:Signing,appId:string){
 if(!token(appId,32))return routineSubscriptionUnavailable();
 return subscriptionMac(env,'account-subject',[appId]);
}
function templates(value:unknown):RoutineSubscriptionTemplate[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||!value.length||value.length>16
  ||Reflect.ownKeys(value).length!==value.length+1)return routineSubscriptionUnavailable();
 const output:RoutineSubscriptionTemplate[]=[];
 for(let i=0;i<value.length;i++){
  const d=Object.getOwnPropertyDescriptor(value,String(i));
  if(!d?.enumerable||!('value'in d))return routineSubscriptionUnavailable();
  const entry=subscriptionObject(d.value,['mark','templateId']);
  if(!token(entry.mark)||!token(entry.templateId,128)||i>0&&output[i-1].mark>=entry.mark)return routineSubscriptionUnavailable();
  output.push({mark:entry.mark,templateId:entry.templateId});
 }
 return output;
}
function policy(env:Signing,value:unknown):RoutineSubscriptionAccountPolicy{
 const r=subscriptionObject(value,['accountId','state','appId','credentialRef','credentialVersion','credentialStamp','purposes','templates','validFrom','validUntil']);
 if(!token(r.appId,32)||r.accountId!==routineSubscriptionAccountId(env,r.appId)||!token(r.credentialRef)||!subscriptionInteger(r.credentialVersion)||!subscriptionHex(r.credentialStamp)
  ||r.state!=='active'&&r.state!=='revoked'||!subscriptionInteger(r.validFrom)||!subscriptionInteger(r.validUntil)||r.validUntil<=r.validFrom||r.validUntil-r.validFrom>366*86400)return routineSubscriptionUnavailable();
 const p=r.purposes;
 if(!Array.isArray(p)||Object.getPrototypeOf(p)!==Array.prototype||p.length!==1||Reflect.ownKeys(p).length!==2
  ||!Object.getOwnPropertyDescriptor(p,'0')?.enumerable||!('value'in Object.getOwnPropertyDescriptor(p,'0')!)||p[0]!=='subscription_send')return routineSubscriptionUnavailable();
 return{accountId:r.accountId as string,state:r.state,appId:r.appId,credentialRef:r.credentialRef,
  credentialVersion:r.credentialVersion,credentialStamp:r.credentialStamp,purposes:['subscription_send'],templates:templates(r.templates),validFrom:r.validFrom,validUntil:r.validUntil};
}
export async function routineSubscriptionScopeTx(tx:DbClient):Promise<RoutineSubscriptionScope>{
 const [s]=await tx.execute<RoutineSubscriptionScope & Record<string,unknown>>(sql`SELECT pg_catalog.current_database() AS database,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
  pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS "maintenanceOid"
  FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.routine_subscription_account_policy')`);
 if(!s||!token(s.database,128)||!token(s.maintenance,128)||!/^[0-9]+$/u.test(s.databaseOid)||!/^[0-9]+$/u.test(s.maintenanceOid))return routineSubscriptionUnavailable();
 return{database:s.database,databaseOid:s.databaseOid,maintenance:s.maintenance,maintenanceOid:s.maintenanceOid};
}
export function parseRoutineSubscriptionAccountJournal(env:Signing,raw:unknown,scope:RoutineSubscriptionScope):RoutineSubscriptionAccountJournal{
 const r=subscriptionObject(raw,['record_id','account_id','revision','payload','created_at','signature']),p=subscriptionObject(r.payload,['format','scope','previousRecordId','data']);
 const s=subscriptionObject(p.scope,['database','databaseOid','maintenance','maintenanceOid']);
 const created=typeof r.created_at==='string'&&/^[0-9]+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!subscriptionUuid(r.record_id)||!subscriptionHex(r.account_id)||!subscriptionInteger(r.revision)||!subscriptionInteger(created)||p.format!==1||!subscriptionSame(s,scope)
  ||p.previousRecordId!==''&&!subscriptionUuid(p.previousRecordId)||!subscriptionHex(r.signature))return routineSubscriptionUnavailable();
 const data=policy(env,p.data);if(data.accountId!==r.account_id)return routineSubscriptionUnavailable();
 const body={record_id:r.record_id,account_id:r.account_id,revision:r.revision,payload:{format:1 as const,scope:{...scope},previousRecordId:p.previousRecordId as string,data},created_at:created};
 if(!subscriptionEqual(r.signature,subscriptionMac(env,'account-policy',body)))return routineSubscriptionUnavailable();
 return freezeSubscription({...body,signature:r.signature});
}
async function history(tx:DbClient,env:Signing,id:string,scope:RoutineSubscriptionScope){
 const rows=await tx.execute(sql`SELECT * FROM public.routine_subscription_account_policy WHERE account_id=${id} ORDER BY revision LIMIT 65`);
 if(rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return routineSubscriptionUnavailable();
 const decoded=Array.from(rows,r=>parseRoutineSubscriptionAccountJournal(env,r,scope));
 for(let i=0;i<decoded.length;i++)if(decoded[i].account_id!==id||decoded[i].revision!==i+1
  ||decoded[i].payload.previousRecordId!==(i?decoded[i-1].record_id:'')||i>0&&decoded[i].created_at<decoded[i-1].created_at)return routineSubscriptionUnavailable();
 return decoded;
}
export async function routineSubscriptionClockTx(tx:DbClient){
 const [r]=await tx.execute<{now:string}>(sql`SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
 const now=Number(r?.now);return subscriptionInteger(now)?now:routineSubscriptionUnavailable();
}
async function deadline(tx:DbClient,validUntil?:number){
 const [row]=await tx.execute<{ready:boolean}>(sql`SELECT
  pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
  AND (${validUntil===undefined} OR pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${validUntil??0})) AS ready`);
 if(row?.ready!==true)return routineSubscriptionUnavailable();
}
function prepared(env:RoutineSubscriptionEnv,row:RoutineSubscriptionAccountJournal,now:number,mark:string):PreparedRoutineSubscriptionAccount{
 const p=row.payload.data;
 if(p.state!=='active'||now<row.created_at||now<p.validFrom||now>=p.validUntil)return routineSubscriptionUnavailable();
 const m=materials(env,p.credentialRef,p.credentialVersion);
 if(m.appId!==p.appId||!subscriptionEqual(p.credentialStamp,subscriptionMac(env,'app-materials',m)))return routineSubscriptionUnavailable();
 const selected=p.templates.find(t=>t.mark===mark);
 if(!token(mark)||!selected)return routineSubscriptionUnavailable();
 const result=Object.freeze({account:row,template:Object.freeze({...selected}),[preparedSlot]:true as const});privateMaterials.set(result,m);return result;
}
export function routineSubscriptionAccountMaterials(value:PreparedRoutineSubscriptionAccount):Readonly<Materials>{
 return privateMaterials.get(value)??routineSubscriptionUnavailable();
}
/** Caller holds the subscription gate before physical locks. This preparation
 * selects an approved AppID/template only; it proves no order or target owner.
 * Future dispatch must independently authenticate those facts before a POST. */
export async function prepareRoutineSubscriptionAccountTx(tx:DbClient,env:RoutineSubscriptionEnv,appId:string,mark:string){
 env=captureRoutineSubscriptionEnv(env);
 if(!await assertRoutineSubscriptionReadTx(tx))return routineSubscriptionUnavailable();
 const [gate]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_setting('transaction_isolation')='read committed'
  AND pg_catalog.current_setting('transaction_read_only')='off' AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
  AND pid=pg_catalog.pg_backend_pid() AND classid=${ROUTINE_SUBSCRIPTION_GATE[0]}::oid AND objid=${ROUTINE_SUBSCRIPTION_GATE[1]}::oid
  AND objsubid=2 AND mode='ShareLock' AND granted) AS ready`);
 if(gate?.ready!==true)return routineSubscriptionUnavailable();
 const scope=await routineSubscriptionScopeTx(tx);
 const row=(await history(tx,env,routineSubscriptionAccountId(env,appId),scope)).at(-1);
 if(!row)return routineSubscriptionUnavailable();
 const value=prepared(env,row,await routineSubscriptionClockTx(tx),mark);
 await deadline(tx,row.payload.data.validUntil);return value;
}
/** Recheck immediately before each token/provider request. No I/O is performed
 * while the short SQL transaction or its maintenance gate remains open. */
export async function assertPreparedRoutineSubscriptionAccount(container:Container,env:RoutineSubscriptionEnv,value:PreparedRoutineSubscriptionAccount){
 env=captureRoutineSubscriptionEnv(env);
 if(!Object.hasOwn(container.db,'$client')||!container.db.$client)return routineSubscriptionUnavailable();
 routineSubscriptionAccountMaterials(value);
 return withTx(container,async tx=>{
  if(!await assertRoutineSubscriptionReadyTx(tx))return routineSubscriptionUnavailable();
  const s=await routineSubscriptionScopeTx(tx),latest=(await history(tx,env,value.account.account_id,s)).at(-1);
  if(!latest||!subscriptionSame(latest,value.account))return routineSubscriptionUnavailable();
  const current=prepared(env,latest,await routineSubscriptionClockTx(tx),value.template.mark);
  if(!subscriptionSame(current.template,value.template))return routineSubscriptionUnavailable();
  await deadline(tx,latest.payload.data.validUntil);
 });
}
/** Historical policy inspection is not proof of a sent notification. Retirement
 * cannot erase a previously active policy; this never grants fresh provider use. */
export async function assertRoutineSubscriptionHistoricalAccountTx(tx:DbClient,env:Signing,row:RoutineSubscriptionAccountJournal,at:number){
 if(!await assertRoutineSubscriptionReadTx(tx))return routineSubscriptionUnavailable();
 const s=await routineSubscriptionScopeTx(tx),saved=(await history(tx,env,row.account_id,s)).find(r=>r.record_id===row.record_id);
 if(!saved||!subscriptionSame(saved,row)||!subscriptionInteger(at)||saved.payload.data.state!=='active'
  ||at<saved.created_at||at<saved.payload.data.validFrom||at>=saved.payload.data.validUntil)return routineSubscriptionUnavailable();
 await deadline(tx);
 return saved;
}
/** Explicit maintenance author. The operator supplies audited AppID/template
 * authority; this API does not discover ownership or provision AppSecrets. */
export async function appendRoutineSubscriptionAccountPolicy(db:DbClient,env:RoutineSubscriptionEnv,
 declared:Pick<RoutinePaymentRuntimeTarget,'database'|'maintenance'|'app'|'admin'>,
 input:{operationId:string;expectedRevision:number;data:RoutineSubscriptionAccountPolicy}){
 env=captureRoutineSubscriptionEnv(env);const r=subscriptionObject(input,['operationId','expectedRevision','data']);
 const t=subscriptionObject(declared,['database','maintenance','app','admin']);
 if(!subscriptionUuid(r.operationId)||!Number.isSafeInteger(r.expectedRevision)||Number(r.expectedRevision)<0||Number(r.expectedRevision)>=64
  ||Object.values(t).some(v=>!token(v,128)))return routineSubscriptionUnavailable();
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
  if(identity?.ready!==true)return routineSubscriptionUnavailable();
  const [gate]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${ROUTINE_SUBSCRIPTION_GATE[0]},${ROUTINE_SUBSCRIPTION_GATE[1]}) AS locked`);
  if(gate?.locked!==true||!(await inspectRoutineSubscriptionCatalog(tx,target)).ready)return routineSubscriptionUnavailable();
  const s=await routineSubscriptionScopeTx(tx),rows=await history(tx,env,data.accountId,s);
  const globalRows=await tx.execute(sql`SELECT * FROM public.routine_subscription_account_policy WHERE record_id=${operationId}::uuid LIMIT 2`);
  if(globalRows.length>1)return routineSubscriptionUnavailable();
  const replay=globalRows.length?parseRoutineSubscriptionAccountJournal(env,globalRows[0],s):undefined;
  if(replay&&replay.account_id!==data.accountId)return routineSubscriptionUnavailable();
  if(replay){
   if(replay.revision!==expectedRevision+1||!subscriptionSame(replay.payload.data,data))return routineSubscriptionUnavailable();
   await deadline(tx);return{recordId:replay.record_id,revision:replay.revision,replayed:true};
  }
  const prior=rows.at(-1),now=await routineSubscriptionClockTx(tx);
  if((prior?.revision??0)!==expectedRevision||prior&&now<prior.created_at||data.state==='active'&&now>=data.validUntil)return routineSubscriptionUnavailable();
  if(data.state==='active'){
   const c=routineSubscriptionCredentialCommitment(env,data.credentialRef,data.credentialVersion);
   if(c.appId!==data.appId||c.credentialStamp!==data.credentialStamp)return routineSubscriptionUnavailable();
  }
  const body={record_id:operationId,account_id:data.accountId,revision:expectedRevision+1,
   payload:{format:1 as const,scope:s,previousRecordId:prior?.record_id??'',data},created_at:now};
  await tx.execute(sql`INSERT INTO public.routine_subscription_account_policy(record_id,account_id,revision,payload,created_at,signature)
   VALUES(${operationId}::uuid,${body.account_id},${body.revision},${JSON.stringify(body.payload)}::text::jsonb,${now},${subscriptionMac(env,'account-policy',body)})`);
  const [saved]=await tx.execute(sql`SELECT * FROM public.routine_subscription_account_policy WHERE record_id=${operationId}::uuid`);
  if(!subscriptionSame(parseRoutineSubscriptionAccountJournal(env,saved,s),{...body,signature:subscriptionMac(env,'account-policy',body)}))return routineSubscriptionUnavailable();
  await deadline(tx,data.state==='active'?data.validUntil:undefined);
  return{recordId:operationId,revision:body.revision,replayed:false};
 });
}
