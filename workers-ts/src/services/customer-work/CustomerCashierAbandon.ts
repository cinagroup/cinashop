import { and,or,eq,sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder } from '@/models/schema';
import { HttpApiException,ValidateException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { assertCashierSecondCardAbandonReads,cashierSecondCardAbandonReadiness } from '@/migrations/runCashierSecondCardAbandon';
import { assertCashierSecondCardFormImagesCatalog } from '@/migrations/runCashierSecondCardFormImages';
import { freezeCustomerJson } from './CustomerWorkOperationRequest';
import { parseCustomerCashierInput,parseCustomerCashierPaymentBody,type CustomerCashierInput } from './CustomerWorkCashierService';

export const CUSTOMER_CASHIER_ABANDON_VERSION='customer-cashier-abandon-v1' as const;
export type CashierOperationKind='creation'|'payment';
export function parseCashierAbandonIntent(kind:CashierOperationKind,value:unknown) {
 return kind==='creation'?parseCustomerCashierInput(value):parseCustomerCashierPaymentBody(value);
}
export function cashierAbandonIntentJson(intent:unknown) {return JSON.stringify(freezeCustomerJson(intent));}
/** Same namespace as drafts and form parents, before the core order lock. */
export async function lockCashierOperationRequest(tx:DbClient,uid:number,key:string) {
 await tx.execute(sql`SET LOCAL row_security=off`);
 await tx.execute(sql`SELECT set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text||'ms',true),
 set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
 const hash=await outRequestHash([uid,key]);await tx.execute(sql`SELECT pg_advisory_xact_lock(731688::int,${parseInt(hash.slice(0,8),16)|0}::int)`);
}
export async function readCashierAbandonment(db:DbClient,uid:number,key:string,kind:CashierOperationKind) {
 if(!(await assertCashierSecondCardAbandonReads(db)).present)return null;
 const rows=await db.execute<{actor_uid:number;request_key:string;kind:CashierOperationKind;request_hash:string;scope_key:string;intent:unknown;intent_json:string;created_at:string}>(sql`
 SELECT actor_uid,request_key::text,kind,request_hash,scope_key,intent,intent_json,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
 FROM public.cashier_second_card_abandon_v1 WHERE actor_uid=${uid} AND request_key=${key}::uuid AND kind=${kind} LIMIT 2`);
 if(rows.length>1)throw new ValidateException('原收银放弃证明身份重复');
 const row=rows[0];if(!row)return null;const intent=parseCashierAbandonIntent(kind,row.intent);
 if(row.actor_uid!==uid||row.request_key!==key||row.kind!==kind||row.scope_key!==intent.scope_key||await outRequestHash(intent)!==row.request_hash
  ||cashierAbandonIntentJson(intent)!==row.intent_json||cashierAbandonIntentJson(JSON.parse(row.intent_json))!==row.intent_json
  ||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(row.created_at))
 throw new ValidateException('原收银放弃证明或完整内容无法核对');
 const {intent_json:_json,...proof}=row;return{version:CUSTOMER_CASHIER_ABANDON_VERSION,...proof,intent};
}
export async function assertCashierNotAbandoned(db:DbClient,uid:number,key:string,kind:CashierOperationKind,requestHash?:string) {
 if(!(await cashierSecondCardAbandonReadiness(db)).ready)throw new HttpApiException('收银耐久放弃台账结构或完整写权限尚未验收，原请求写入暂不可用',503,503);
 const prior=await readCashierAbandonment(db,uid,key,kind);
 if(prior)throw new HttpApiException(requestHash&&prior.request_hash!==requestHash?'原收银编号已经绑定其他内容的耐久放弃证明':'原收银请求已经耐久放弃，不能恢复写入或重新使用编号',409,409);
}
/** Under the original creation locks. Mutable catalog/form changes never gate an owner fence. */
export async function checkCashierCreationAbandonBinding(db:DbClient,uid:number,key:string,intent:CustomerCashierInput,hash:string) {
 const drafts=await db.execute<{request_hash:string;buyer_uid:number;tourist_hash:string}>(sql`
 SELECT request_hash,buyer_uid,tourist_hash FROM public.cashier_second_card_cart_v1 WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);
 const touristHash=await outRequestHash(intent.tourist_key);
 if(drafts.length>1||drafts.some(row=>row.request_hash!==hash||row.buyer_uid!==intent.buyer_uid||row.tourist_hash!==touristHash))
 throw new HttpApiException('原收银草稿已绑定其他完整意图',409,409);
 const shadows=await db.select({id:storeOrder.id}).from(storeOrder).where(and(eq(storeOrder.unique,key.replaceAll('-','')),
  or(eq(storeOrder.uid,intent.buyer_uid),and(eq(storeOrder.staffId,uid),eq(storeOrder.isChannel,2))))).limit(1);
 if(shadows.length)throw new HttpApiException('实际原订单已经存在但原创建证明无法核对，请继续核对原编号',409,409);
 const [installed]=await db.execute<{present:boolean}>(sql`SELECT to_regclass('public.cashier_second_card_form_session_v1') IS NOT NULL AS present`);
 if(!installed.present)return;await assertCashierSecondCardFormImagesCatalog(db);
 const sessions=await db.execute<{intent_json:string;request_hash:string;frozen_request_hash:string|null;frozen_input_json:string|null;state:string}>(sql`
 SELECT intent_json,request_hash,frozen_request_hash,frozen_input_json,state FROM public.cashier_second_card_form_session_v1
 WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);
 if(sessions.length>1)throw new ValidateException('原收银表单准备身份重复');
 const session=sessions[0];if(!session)return;
 const selection=freezeCustomerJson(JSON.parse(session.intent_json)) as unknown as Record<string,unknown>;
 if(await outRequestHash(selection)!==session.request_hash||['scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity'].some(field=>selection[field]!==intent[field as keyof CustomerCashierInput]))
 throw new HttpApiException('原表单准备已经绑定其他选品或归属',409,409);
 if(session.state==='consumed')throw new HttpApiException('原表单已经消费但原创建证明无法核对',409,409);
 if(session.frozen_request_hash!==null&&(session.frozen_request_hash!==hash||!session.frozen_input_json||await outRequestHash(JSON.parse(session.frozen_input_json))!==hash))
 throw new HttpApiException('原表单已经冻结其他完整意图',409,409);
}
