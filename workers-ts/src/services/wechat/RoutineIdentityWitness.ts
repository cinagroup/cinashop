import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { assertRoutineIdentityWitnessReady } from '@/migrations/routineIdentityWitness';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { verifyRoutineIdentityObservation, type RoutineIdentityObservation } from './RoutineIdentityObservation';
import { readRoutineCredentialsInTx } from './RoutineRuntimeConfig';

type RuntimeEnv = Pick<Env,'APP_KEY'>;
type Row = {
  observation_id: string; uid: number; binding_id: number; format_version: number;
  observation: unknown; created_at: number | string; signature: string;
};
export interface RoutineIdentityWitness {
  readonly observationId: string; readonly uid: number; readonly bindingId: number;
  readonly observation: Readonly<RoutineIdentityObservation>; readonly createdAt: number;
}
const unavailable = () => new ServiceUnavailableException('小程序身份观察记录无效，请重新授权或维护');
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value)>0 && Number(value)<=2147483647;
function sign(env: RuntimeEnv, row: Omit<Row,'signature'>): string {
  if (typeof env.APP_KEY!=='string' || !env.APP_KEY) throw unavailable();
  const o = row.observation as RoutineIdentityObservation;
  return createHmac('sha256',env.APP_KEY).update('cinashop.routine-identity-witness.record.v1\0')
    .update(JSON.stringify([row.observation_id,row.uid,row.binding_id,row.format_version,
      [o.version,o.purpose,o.observationId,o.appId,o.openid,o.unionid,o.sourceStamp,o.observedAt,o.signature],Number(row.created_at)])).digest('hex');
}
function verified(env: RuntimeEnv, raw: Row): RoutineIdentityWitness {
  const observation = verifyRoutineIdentityObservation(env,raw.observation,undefined,{allowExpired:true});
  const row = {...raw,created_at:Number(raw.created_at),observation};
  if (!positive(row.uid) || !positive(row.binding_id) || row.format_version!==1
    || row.observation_id!==observation.observationId || !Number.isSafeInteger(row.created_at)
    || row.created_at<observation.observedAt-60 || row.created_at>Math.floor(Date.now()/1000)+60
    || typeof row.signature!=='string' || !/^[a-f0-9]{64}$/u.test(row.signature)
    || !timingSafeEqual(Buffer.from(row.signature,'hex'),Buffer.from(sign(env,row),'hex'))) throw unavailable();
  return Object.freeze({observationId:row.observation_id,uid:row.uid,bindingId:row.binding_id,observation,createdAt:row.created_at});
}

/** Called after full identity reconciliation on the very same transaction.
 * It records this exchange's observed public identity and exact live binding;
 * it never assigns an AppID to the old binding or changes UID/entitlements.
 * The PK consumes an observation at most once, including across UID changes. */
export async function appendRoutineIdentityWitness(tx: DbClient, env: RuntimeEnv, input: {
  uid: number; observation: RoutineIdentityObservation;
}): Promise<RoutineIdentityWitness> {
  const observation=verifyRoutineIdentityObservation(env,input.observation), uid=input.uid;
  if (!positive(uid)) throw new ValidateException('小程序身份关联账号无效');
  if (Object.hasOwn(tx,'$client')) throw unavailable();
  await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','5s',true)`);
  const [context]=await tx.execute<{valid:boolean;locked:boolean}>(sql`SELECT
    current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean AS valid,
    pg_try_advisory_xact_lock_shared(731666,0) AS locked`);
  if (context?.valid!==true || context.locked!==true) throw unavailable();
  const sourceMatches=async () => {
    const current=await readRoutineCredentialsInTx(tx,env);
    if (current.stamp!==observation.sourceStamp || current.appId!==observation.appId)
      throw new ValidateException('小程序身份观察配置已变化，请重新授权');
  };
  await sourceMatches();
  await assertRoutineIdentityWitnessReady(tx);
  const rows=await tx.execute<{id:number;uid:number;unionid:string}>(sql`SELECT w.id,w.uid,w.unionid
    FROM public.wechat_user w JOIN public."user" u ON u.uid=w.uid
    WHERE w.uid=${uid} AND w.openid=${observation.openid} AND w.user_type='routine' AND w.is_del=0
      AND u.status=1 AND u.is_del=0 AND u.delete_time IS NULL
    LIMIT 2 FOR UPDATE OF w,u`);
  if (rows.length!==1 || !positive(rows[0].id)
    || rows[0].unionid && observation.unionid && rows[0].unionid!==observation.unionid)
    throw new ValidateException('小程序身份缺少唯一的有效精确绑定，请维护后重新授权');
  const [clock]=await tx.execute<{now:string|number}>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
  const now=Number(clock?.now);
  if (!Number.isSafeInteger(now) || now<observation.observedAt-60 || now-observation.observedAt>900) throw unavailable();
  const facts={observation_id:observation.observationId,uid,binding_id:rows[0].id,
    format_version:1,observation,created_at:now};
  await tx.execute(sql`INSERT INTO public.routine_identity_witness(observation_id,uid,binding_id,format_version,observation,created_at,signature)
    VALUES(${facts.observation_id}::uuid,${facts.uid},${facts.binding_id},1,${JSON.stringify(observation)}::jsonb,${now},${sign(env,facts)})
    ON CONFLICT(observation_id) DO NOTHING`);
  const saved=await tx.execute<Row>(sql`SELECT observation_id,uid,binding_id,format_version,observation,created_at,signature
    FROM public.routine_identity_witness WHERE observation_id=${observation.observationId}::uuid LIMIT 2`);
  if (saved.length!==1) throw unavailable();
  const witness=verified(env,saved[0]);
  if (witness.uid!==facts.uid || witness.bindingId!==facts.binding_id
    || witness.observation.signature!==observation.signature) throw new ValidateException('小程序身份观察已用于其他绑定，请重新授权');
  await sourceMatches();
  const [deadline]=await tx.execute<{valid:boolean}>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS valid`);
  if (deadline?.valid!==true) throw unavailable();
  return witness;
}

/** A later public identity read may outlive OAuth Secret rotation. The caller
 * supplies the intended public AppID; current configuration is never read here.
 * Live UID and exact channel binding must still match. This is NOT an original
 * payment/account authorization and does not recover historical orders. */
export async function readRoutineIdentityWitness(tx: DbClient, env: RuntimeEnv, input: {
  uid:number; bindingId:number; appId:string; openid:string;
}): Promise<RoutineIdentityWitness | null> {
  const {uid,bindingId,appId,openid}=input;
  const id=(value:unknown,max:number): value is string => typeof value==='string' && value.length>0
    && value.length<=max && !/[^A-Za-z0-9_-]/u.test(value);
  if (!positive(uid) || !positive(bindingId) || !id(appId,32) || !id(openid,100)) throw new ValidateException('小程序身份观察读取参数无效');
  await assertRoutineIdentityWitnessReady(tx);
  const rows=await tx.execute<Row>(sql`SELECT e.observation_id,e.uid,e.binding_id,e.format_version,e.observation,e.created_at,e.signature
    FROM public.routine_identity_witness e JOIN public.wechat_user w ON w.id=e.binding_id AND w.uid=e.uid
    JOIN public."user" u ON u.uid=e.uid
    WHERE e.uid=${uid} AND e.binding_id=${bindingId} AND e.observation->>'appId'=${appId}
      AND w.openid=${openid} AND w.user_type='routine' AND w.is_del=0
      AND u.status=1 AND u.is_del=0 AND u.delete_time IS NULL
    ORDER BY e.created_at DESC,e.observation_id LIMIT 2 FOR SHARE OF w,u`);
  const proofs=rows.map(row=>verified(env,row));
  if (proofs.some(proof=>proof.uid!==uid || proof.bindingId!==bindingId
    || proof.observation.appId!==appId || proof.observation.openid!==openid)) throw unavailable();
  return proofs[0]??null;
}
