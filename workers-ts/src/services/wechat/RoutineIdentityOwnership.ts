import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { assertRoutineIdentityOwnershipReady } from '@/migrations/routineIdentityOwnership';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { verifyRoutineIdentityObservation, type RoutineIdentityObservation } from './RoutineIdentityObservation';
import { appendRoutineIdentityWitness, readRoutineIdentityWitnessAnchor, type RoutineIdentityWitness } from './RoutineIdentityWitness';
import { readRoutineCredentialsInTx } from './RoutineRuntimeConfig';

type RuntimeEnv = Pick<Env,'APP_KEY'>;
type Row = { ownership_id:string; app_id:string; openid:string; uid:number; binding_id:number; observation_id:string;
  format_version:number; observed_at:number|string; created_at:number|string; signature:string };
export interface RoutineIdentityOwner {
  readonly ownershipId:string; readonly appId:string; readonly openid:string; readonly uid:number; readonly bindingId:number;
  readonly observationId:string; readonly observedAt:number; readonly createdAt:number;
}
export interface OwnedRoutineIdentity { readonly owner:RoutineIdentityOwner; readonly witness:RoutineIdentityWitness }
const unavailable=()=>new ServiceUnavailableException('小程序账号归属记录未完整就绪，请维护后重试');
const conflict=()=>new ValidateException('小程序身份归属冲突，请先维护归属后重新授权');
const positive=(v:unknown):v is number=>Number.isSafeInteger(v) && Number(v)>0 && Number(v)<=2147483647;
const token=(v:unknown,max:number):v is string=>typeof v==='string' && v.length>0 && v.length<=max && /^[A-Za-z0-9_-]+$/u.test(v);
const fields=sql.raw('ownership_id,app_id,openid,uid,binding_id,observation_id,format_version,observed_at,created_at,signature');
function mac(env:RuntimeEnv,domain:string,value:unknown):string {
  if (typeof env.APP_KEY!=='string' || !env.APP_KEY) throw unavailable();
  return createHmac('sha256',env.APP_KEY).update('cinashop.routine-identity-ownership.'+domain+'.v1\0').update(JSON.stringify(value)).digest('hex');
}
function identityId(env:RuntimeEnv,row:Pick<Row,'app_id'|'openid'|'uid'|'binding_id'>) {
  return mac(env,'identity',[row.app_id,row.openid,row.uid,row.binding_id]);
}
function sign(env:RuntimeEnv,row:Omit<Row,'signature'>) {
  return mac(env,'record',[row.ownership_id,row.app_id,row.openid,row.uid,row.binding_id,row.observation_id,
    row.format_version,Number(row.observed_at),Number(row.created_at)]);
}
function decode(env:RuntimeEnv,row:Row):RoutineIdentityOwner {
  const observedAt=Number(row.observed_at),createdAt=Number(row.created_at);
  if (!positive(row.uid) || !positive(row.binding_id) || !token(row.app_id,32) || !token(row.openid,100)
    || row.format_version!==1 || !/^[a-f0-9]{64}$/u.test(row.ownership_id) || row.ownership_id!==identityId(env,row)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.observation_id)
    || !Number.isSafeInteger(observedAt) || observedAt<=0 || !Number.isSafeInteger(createdAt)
    || createdAt<observedAt-60 || createdAt>observedAt+900 || createdAt>Math.floor(Date.now()/1000)+60
    || typeof row.signature!=='string' || !/^[a-f0-9]{64}$/u.test(row.signature)
    || !timingSafeEqual(Buffer.from(row.signature,'hex'),Buffer.from(sign(env,row),'hex'))) throw unavailable();
  return Object.freeze({ownershipId:row.ownership_id,appId:row.app_id,openid:row.openid,uid:row.uid,bindingId:row.binding_id,
    observationId:row.observation_id,observedAt,createdAt});
}
async function context(tx:DbClient) {
  if (Object.hasOwn(tx,'$client')) throw unavailable();
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [state]=await tx.execute<{ready:boolean}>(sql`SELECT current_setting('transaction_isolation')='read committed'
    AND current_setting('transaction_read_only')='off' AS ready`);
  if (state?.ready!==true) throw unavailable();
  await assertRoutineIdentityOwnershipReady(tx);
}
async function anchor(tx:DbClient,env:RuntimeEnv,owner:RoutineIdentityOwner) {
  const witness=await readRoutineIdentityWitnessAnchor(tx,env,owner);
  if (!witness || witness.observation.observedAt!==owner.observedAt) throw unavailable();
  return witness;
}
async function lockUser(tx:DbClient,uid:number,write=false) {
  const rows=await tx.execute<{uid:number}>(sql`SELECT uid FROM public."user"
    WHERE uid=${uid} AND status=1 AND is_del=0 AND delete_time IS NULL
    ${sql.raw(write?'FOR UPDATE':'FOR SHARE')}`);
  if (rows.length!==1) throw new ValidateException('小程序身份关联账号不可用，请重新授权');
}
/** User is already locked, then the exact physical binding is locked. No
 * latest/global fallback, social locks, repair or external I/O is performed. */
async function liveBinding(tx:DbClient,owner:RoutineIdentityOwner,write=false):Promise<boolean> {
  const rows=await tx.execute<{uid:number;openid:string;user_type:string;is_del:number}>(sql`
    SELECT uid,openid,user_type,is_del FROM public.wechat_user WHERE id=${owner.bindingId}
    ${sql.raw(write?'FOR UPDATE':'FOR SHARE')}`);
  if (rows.length!==1 || rows[0].uid!==owner.uid || rows[0].openid!==owner.openid || rows[0].user_type!=='routine') throw unavailable();
  return rows[0].is_del===0;
}

/** Prospective mapping only. The caller must authenticate UID continuity
 * before calling this API; a fresh observation alone does not adopt an old UID.
 * All mutations, gifts, witness and mapping remain in the caller transaction. */
export async function appendRoutineIdentityOwnershipTx(tx:DbClient,env:RuntimeEnv,input:{
  uid:number; bindingId:number; observation:RoutineIdentityObservation;
}):Promise<OwnedRoutineIdentity> {
  const uid=input.uid,bindingId=input.bindingId,observation=verifyRoutineIdentityObservation(env,input.observation);
  if (!positive(uid) || !positive(bindingId)) throw conflict();
  await context(tx);
  await lockUser(tx,uid,true);
  const exact=Object.freeze({ownershipId:'',appId:observation.appId,openid:observation.openid,uid,bindingId,
    observationId:observation.observationId,observedAt:observation.observedAt,createdAt:0});
  if (!await liveBinding(tx,exact,true)) throw conflict();
  const matches=async()=>{
    const current=await readRoutineCredentialsInTx(tx,env);
    if (current.stamp!==observation.sourceStamp || current.appId!==observation.appId) throw conflict();
  };
  await matches();
  const witness=await appendRoutineIdentityWitness(tx,env,{uid,observation});
  if (witness.bindingId!==bindingId) throw conflict();
  const [clock]=await tx.execute<{now:number|string}>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
  const now=Number(clock?.now);
  if (!Number.isSafeInteger(now) || now<observation.observedAt-60 || now>observation.observedAt+900) throw unavailable();
  const row={app_id:observation.appId,openid:observation.openid,uid,binding_id:bindingId,observation_id:observation.observationId,
    format_version:1,observed_at:observation.observedAt,created_at:now};
  const facts={ownership_id:identityId(env,row),...row};
  await tx.execute(sql`INSERT INTO public.routine_identity_ownership
    (ownership_id,app_id,openid,uid,binding_id,observation_id,format_version,observed_at,created_at,signature)
    VALUES(${facts.ownership_id},${facts.app_id},${facts.openid},${uid},${bindingId},${facts.observation_id}::uuid,
      1,${facts.observed_at},${now},${sign(env,facts)}) ON CONFLICT DO NOTHING`);
  const saved=await tx.execute<Row>(sql`SELECT ${fields} FROM public.routine_identity_ownership
    WHERE (app_id=${observation.appId} AND openid=${observation.openid}) OR binding_id=${bindingId} LIMIT 3`);
  if (saved.length!==1) throw conflict();
  const owner=decode(env,saved[0]);
  if (owner.uid!==uid || owner.bindingId!==bindingId || owner.appId!==observation.appId || owner.openid!==observation.openid) throw conflict();
  // Existing mapping keeps its first anchor/xmin; every new exchange still
  // records its own witness without rewriting the original prospective scope.
  const original=await anchor(tx,env,owner);
  await matches();
  const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS ready`);
  if (deadline?.ready!==true) throw unavailable();
  return Object.freeze({owner,witness:original});
}

export async function readRoutineIdentityOwnerBySubjectTx(tx:DbClient,env:RuntimeEnv,input:{
  appId:string; openid:string; expectedUid?:number;
}):Promise<OwnedRoutineIdentity|null> {
  const {appId,openid,expectedUid}=input;
  if (!token(appId,32) || !token(openid,100) || expectedUid!==undefined && !positive(expectedUid)) throw conflict();
  await context(tx);
  const rows=await tx.execute<Row>(sql`SELECT ${fields} FROM public.routine_identity_ownership
    WHERE app_id=${appId} AND openid=${openid} LIMIT 2`);
  if (!rows.length) return null;
  if (rows.length!==1) throw unavailable();
  const owner=decode(env,rows[0]);
  if (owner.appId!==appId || owner.openid!==openid) throw unavailable();
  if (expectedUid!==undefined && owner.uid!==expectedUid) throw conflict();
  await lockUser(tx,owner.uid);
  const live=await liveBinding(tx,owner),witness=await anchor(tx,env,owner);
  if (!live) throw conflict();
  return Object.freeze({owner,witness});
}

/** All records for this UID and intended AppID are checked. Old other-AppID
 * bindings remain untouched; multiple live subjects in this scope refuse. */
export async function readRoutineIdentityOwnerForUidTx(tx:DbClient,env:RuntimeEnv,input:{
  uid:number; appId:string;
}):Promise<OwnedRoutineIdentity|null> {
  const {uid,appId}=input;
  if (!positive(uid) || !token(appId,32)) throw conflict();
  await context(tx); await lockUser(tx,uid);
  const rows=await tx.execute<Row>(sql`SELECT ${fields} FROM public.routine_identity_ownership
    WHERE uid=${uid} AND app_id=${appId} ORDER BY ownership_id LIMIT 65`);
  if (rows.length>64 || Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576) throw unavailable();
  const live:OwnedRoutineIdentity[]=[];
  for (const row of rows) {
    const owner=decode(env,row);
    if (owner.uid!==uid || owner.appId!==appId) throw unavailable();
    const active=await liveBinding(tx,owner),witness=await anchor(tx,env,owner);
    if (active) live.push(Object.freeze({owner,witness}));
  }
  if (live.length>1) throw conflict();
  return live[0]??null;
}
