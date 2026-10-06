import type {Context} from 'hono';
import type {Env,AppVariables} from '@/env';
import {sql} from 'drizzle-orm';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {normalizeOutRequestKey} from '@/services/out/OutIdempotency';
import {withTx,type DbClient} from '@/lib/di';
import {user} from '@/models/schema';
import {eq} from 'drizzle-orm';
import {HttpApiException} from '@/utils/errors';
import {assertCashierSecondCardOriginCatalog} from '@/migrations/runCashierSecondCardOrigin';
import {CustomerWorkCashierService, type CustomerCashierPaymentInput} from '@/services/customer-work/CustomerWorkCashierService';
import {customerWorkActor} from './CustomerWorkController';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function input(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  if(new URL(c.req.url).search)throw new ValidateException('次卡收银不接受查询身份或参数');
  return{actor:customerWorkActor(c),service:new CustomerWorkCashierService(c.get('container'),c.env)};}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw new ValidateException('收银请求字段不完整');return value as Record<string,unknown>;}
async function body(c:C){if(!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')
  ||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('次卡收银仅接受UTF-8 JSON');
  const raw=await readBoundedUtf8Text(c.req.raw,262144);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('收银JSON无效');}}
export async function cashierDraft(c:C){const s=input(c);return jsonOk(c,await s.service.draft(s.actor,c.req.header('Idempotency-Key')??'',await body(c)));}
/** Read quote does not consume an Idempotency-Key or create a draft cart. */
export async function cashierQuote(c:C){const s=input(c),r=object(await body(c),['request_key','intent']);return jsonOk(c,await s.service.quote(s.actor,r.request_key,r.intent));}
export async function cashierCreate(c:C){const s=input(c),r=object(await body(c),['intent','quote_token']);return jsonOk(c,await s.service.create(s.actor,c.req.header('Idempotency-Key')??'',r.intent,r.quote_token));}
export async function cashierCash(c:C){const s=input(c),r=object(await body(c),['version','scope_key','order_id','order_no','expected_amount']);
  if(typeof r.order_id!=='number'||String(r.order_id)!==c.req.param('id'))throw new ValidateException('现金付款必须绑定原物理订单');
  return jsonOk(c,await s.service.cash(s.actor,{...r,request_key:c.req.header('Idempotency-Key')??''} as CustomerCashierPaymentInput));}
/** Only immutable receipts of the original user session. Current role loss
 * does not dispatch payment or erase already committed evidence. */
async function receipt(c:C,kind:'creation'|'payment'){const s=input(c),key=normalizeOutRequestKey(c.req.param('key'));
  const authorizeOwner=async(db:DbClient)=>{
    const rows=await db.select({uid:user.uid,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime,digest:sql<string>`md5(${user.pwd})`}).from(user).where(eq(user.uid,s.actor.uid)).limit(1);
    if(s.actor.expires_at<=Math.floor(Date.now()/1000)||rows.length!==1||rows[0].status!==1||rows[0].isDel!==0||rows[0].deleteTime!==null
      ||rows[0].digest!==s.actor.auth_version)throw new HttpApiException('原收银会话已失效，请重新登录核对',403,403);};
  const data=await withTx(c.get('container'),async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await authorizeOwner(tx);await assertCashierSecondCardOriginCatalog(tx);
    const rows=kind==='creation'?await tx.execute(sql`SELECT order_id,request_hash,origin_hash,origin AS evidence FROM public.cashier_second_card_origin_v1 WHERE actor_uid=${s.actor.uid} AND request_key=${key}::uuid LIMIT 2`)
      :await tx.execute(sql`SELECT order_id,request_hash,evidence FROM public.cashier_second_card_payment_v1 WHERE actor_uid=${s.actor.uid} AND request_key=${key}::uuid LIMIT 2`);
    if(rows.length>1)throw Error('Cashier receipt identity is ambiguous');return rows[0]??null;});
  await authorizeOwner(c.get('container').db);
  return jsonOk(c,{version:'customer-cashier-receipt-v1',request_key:key,actor_uid:s.actor.uid,kind,receipt:data});}
export async function cashierCreationStatus(c:C){return receipt(c,'creation');}
export async function cashierPaymentStatus(c:C){return receipt(c,'payment');}
