import { sql } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { inspectRoutineRefundCatalog, assertRoutineRefundReadInTx, assertRoutineRefundStatusReadTx } from '@/migrations/routineRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { routineEvidenceHmac } from './RoutineProviderObservation';

type Signing=Pick<Env,'APP_KEY'>;
interface Base {requestKey:string;requestHash:string;receiptDigest:string;role:string;roleOid:string}
export type RoutineRefundActorV2=(Base&{kind:'admin';adminId:number})
 |(Base&{kind:'manager';actorUid:number;storeId:number;staffId:number});
const fail=():never=>{throw new ServiceUnavailableException('原账号退款首次操作者回执尚未完整就绪，请核对原操作');};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const oid=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/u.test(v)&&BigInt(v)<=4294967295n;
function object(v:unknown,keys:string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return fail();
 const ds=Object.getOwnPropertyDescriptors(v);
 if(Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k])))return fail();
 return v as Record<string,unknown>;
}
export function parseRoutineRefundActorV2(value:unknown):RoutineRefundActorV2 {
 const kind=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'kind')?.value:undefined;
 const r=object(value,['kind','requestKey','requestHash','receiptDigest','role','roleOid',
  ...(kind==='admin'?['adminId']:['actorUid','storeId','staffId'])]);
 if(kind!=='admin'&&kind!=='manager'||!uuid(r.requestKey)||!hash(r.requestHash)||!hash(r.receiptDigest)
  ||typeof r.role!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/u.test(r.role)||!oid(r.roleOid)
  ||kind==='admin'&&!positive(r.adminId)||kind==='manager'&&(!positive(r.actorUid)||!positive(r.storeId)||!positive(r.staffId)))return fail();
 return Object.freeze({...r}) as unknown as RoutineRefundActorV2;
}
async function principal(tx:DbClient,kind:'admin'|'manager',statusRead=false){
 if(!await(statusRead?assertRoutineRefundStatusReadTx(tx):assertRoutineRefundReadInTx(tx)))return fail();
 const c=await inspectRoutineRefundCatalog(tx),b=c.binding;
 const[r]=await tx.execute<{name:string;oid:string}>(sql`SELECT current_user AS name,
  (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid`);
 if(!c.ready||!b||!r)return fail();
 const expected=kind==='admin'&&b.adminRefund?{name:b.admin,oid:b.adminOid}:kind==='manager'?{name:b.manager,oid:b.managerOid}:null;
 return{reader:r,expected};
}
const normalizedRow=sql`(pg_catalog.to_jsonb(t)-'created_at')||pg_catalog.jsonb_build_object(
 'created_at',pg_catalog.floor(extract(epoch FROM created_at))::bigint)`;

/** A new first dispatch may sign only the actor receipt actually appended by
 * this business transaction. An old ledger row cannot label a first merchant.
 * xmin is 32-bit, so compare the low xid32 of the current xid8 across epochs. */
export async function firstRoutineRefundActorV2Tx(tx:DbClient,env:Signing,kind:'admin'|'manager',
 identity:{refundId:number;childId:number;storeId:number}):Promise<RoutineRefundActorV2>{
 const p=await principal(tx,kind);
 if(!p.expected?.name||!p.expected.oid||p.reader.name!==p.expected.name||p.reader.oid!==p.expected.oid)return fail();
 const current=sql`t.xmin=pg_catalog.mod(pg_catalog.pg_current_xact_id()::text::numeric,4294967296)::text::xid`;
 if(kind==='admin'){
  const rows=await tx.execute<{admin_id:number;request_key:string;request_hash:string;row:unknown}>(sql`SELECT
   admin_id,request_key::text,request_hash,${normalizedRow} AS row FROM public.admin_refund_operation t
   WHERE refund_id=${identity.refundId} AND action='refund' AND outcome='provider-admitted' AND ${current}
   ORDER BY admin_id,request_key LIMIT 2`);
  if(rows.length!==1||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return fail();
  const r=rows[0];
  return parseRoutineRefundActorV2({kind,adminId:r.admin_id,requestKey:r.request_key,requestHash:r.request_hash,
   receiptDigest:routineEvidenceHmac(env,'refund-admin-receipt',r.row),role:p.reader.name,roleOid:p.reader.oid});
 }
 const rows=await tx.execute<{actor_uid:number;request_key:string;request_hash:string;store_id:number;staff_id:number;row:unknown}>(sql`SELECT
  actor_uid,request_key::text,request_hash,store_id,staff_id,${normalizedRow} AS row FROM public.manager_order_operation_request t
  WHERE order_id=${identity.childId} AND store_id=${identity.storeId} AND kind='refund_execute' AND outcome='provider-admitted'
   AND evidence->>'refund_id'=${String(identity.refundId)} AND ${current} ORDER BY actor_uid,request_key LIMIT 2`);
 if(rows.length!==1||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return fail();
 const r=rows[0];
 return parseRoutineRefundActorV2({kind,actorUid:r.actor_uid,requestKey:r.request_key,requestHash:r.request_hash,
  storeId:r.store_id,staffId:r.staff_id,receiptDigest:routineEvidenceHmac(env,'refund-manager-receipt',r.row),role:p.reader.name,roleOid:p.reader.oid});
}

/** Verify the first receipt only on the actual canonical matching business
 * role. Other consumers, including App callbacks, get no foreign ledger read.
 * The pinned role/OID attest admission history; a lawful later commissioning
 * does not erase that history or rewrite its first human actor. */
export async function validateRoutineRefundActorV2ReceiptTx(tx:DbClient,env:Signing,actor:RoutineRefundActorV2,
 identity:{refundId:number;childId:number;storeId:number},statusRead=false):Promise<void>{
 const a=parseRoutineRefundActorV2(actor),p=await principal(tx,a.kind,statusRead);
 if(!p.expected||p.reader.name!==p.expected.name||p.reader.oid!==p.expected.oid)return;
 const rows=a.kind==='admin'?await tx.execute<{row:unknown}>(sql`SELECT ${normalizedRow} AS row
  FROM public.admin_refund_operation t WHERE admin_id=${a.adminId} AND request_key=${a.requestKey}::uuid
   AND request_hash=${a.requestHash} AND refund_id=${identity.refundId} AND action='refund' AND outcome='provider-admitted' LIMIT 2`)
  :await tx.execute<{row:unknown}>(sql`SELECT ${normalizedRow} AS row FROM public.manager_order_operation_request t
   WHERE actor_uid=${a.actorUid} AND request_key=${a.requestKey}::uuid AND request_hash=${a.requestHash}
    AND store_id=${a.storeId} AND staff_id=${a.staffId} AND order_id=${identity.childId} AND store_id=${identity.storeId}
    AND kind='refund_execute' AND outcome='provider-admitted' AND evidence->>'refund_id'=${String(identity.refundId)} LIMIT 2`);
 if(rows.length!==1||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return fail();
 const expected=routineEvidenceHmac(env,a.kind==='admin'?'refund-admin-receipt':'refund-manager-receipt',rows[0].row);
 if(!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(a.receiptDigest,'hex')))return fail();
}
