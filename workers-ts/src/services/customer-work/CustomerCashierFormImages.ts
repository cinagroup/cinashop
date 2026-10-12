import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { assertCashierNotAbandoned } from './CustomerCashierAbandon';
import type { Env } from '@/env';
import { storeOrder, storeProduct, storeProductAttrValue, systemAttachment, systemFormData, user } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { authorizeCustomerWorkActor, type CustomerWorkActor } from './CustomerWorkScope';
import { authorizeCustomerOperationOwner, freezeCustomerActor, freezeCustomerJson } from './CustomerWorkOperationRequest';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { assertCashierSecondCardFormImagesCatalog, cashierSecondCardFormImagesReadiness, inspectCashierSecondCardFormImages } from '@/migrations/runCashierSecondCardFormImages';
import { loadActiveOrderSystemForm, prepareOrderSystemFormSubmission, OrderFormRejectedException } from '@/services/order/OrderSystemFormService';
import { AttachmentService, canonicalAttachmentPath, detectImageType, parseCanonicalAttachmentId, R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { CASHIER_IMAGE_SCOPE, cashierFormFieldId, cashierFormObjectKey, cashierFormScopeDigest } from '@/services/system/CashierFormAttachmentScope';
import type { CustomerCashierInput } from './CustomerWorkCashierService';
import type { PreparedOrderSystemForm } from '../../../../view/common/order-system-form';
import { parseCashierSecondCardCreationFact } from '@/services/order/CashierSecondCardOrigin';

export const CASHIER_FORM_SESSION_VERSION = 'customer-cashier-form-session-v1' as const;
export const CASHIER_FORM_IMAGE_VERSION = 'customer-cashier-form-image-v1' as const;
/** Once the image protocol exists, even no-image UUIDs must check immutable
 * cancellation/freeze facts. A new DDL deployment requires its minimal SELECT
 * grants before ordinary cashier writes remain available. */
export async function cashierFormBaseReadiness(db:Pick<DbClient,'execute'>) {
  const catalog=await inspectCashierSecondCardFormImages(db);
  if(!catalog.present)return {ready:true,present:false,reason:''};
  if(!catalog.complete)return {ready:false,present:true,reason:'cashier_second_card_form_images_catalog_incompatible'};
  const [read]=await db.execute<{ready:boolean}>(sql`SELECT has_table_privilege(current_user,'public.cashier_second_card_form_session_v1','SELECT')
    AND has_table_privilege(current_user,'public.cashier_second_card_form_upload_v1','SELECT') AS ready`);
  return {ready:read?.ready===true,present:true,reason:read?.ready===true?'':'cashier_second_card_form_images_read_grants_missing'};
}
async function assertBaseReads(db:DbClient){const readiness=await cashierFormBaseReadiness(db);if(!readiness.ready)throw new HttpApiException('收银图片来源读取权限尚未验收，请核对部署的最小读权限',503,503);return readiness;}
async function bytesHash(value:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
export interface CashierFormSessionInput {
  version: typeof CASHIER_FORM_SESSION_VERSION; scope_key: string; buyer_uid: number; tourist_key: string;
  product_id: number; sku_unique: string; quantity: number;
}
export interface CashierFormImageInput {
  version: typeof CASHIER_FORM_IMAGE_VERSION; scope_key: string; session_key: string;
  field_id: string; sha256: string; size: number;
}
interface SessionRow extends Record<string, unknown> {
  actor_uid: number; service_id: number; scope_key: string; request_key: string; request_hash: string;
  intent_json: string; system_form_id: number; template_json: string; scope_digest: string;
  state: 'active'|'cancelled'|'frozen'|'consumed'; created_at: string; cancelled_at: string|null;
  frozen_request_hash: string|null; frozen_input_json: string|null; order_id: number|null; order_no: string|null;
  snapshot_json: string|null; snapshot_hash: string|null; collection_json: string|null; collection_hash: string|null;
}
interface UploadRow extends Record<string, unknown> {
  actor_uid: number; service_id: number; session_key: string; request_key: string; request_hash: string;
  intent_json: string; field_id: string; sha256: string; size: number; mime: string; scope_digest: string;
  object_key: string; state: 'reserved'|'stored'; attachment_id: number|null; created_at: string; stored_at: string|null;
}
const sessionColumns = sql`*,request_key::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  CASE WHEN cancelled_at IS NULL THEN NULL ELSE to_char(cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS cancelled_at`;
const uploadColumns = sql`*,session_key::text,request_key::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  CASE WHEN stored_at IS NULL THEN NULL ELSE to_char(stored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS stored_at`;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new ValidateException('收银图片合同字段不完整');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value) || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException('收银图片标识无效'); return value;
}
function integer(value: unknown, min = 1, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException('收银图片数量或身份无效'); return value;
}
function hash(value: unknown): string { const s = text(value, 64); if (!/^[a-f0-9]{64}$/.test(s)) throw new ValidateException('收银图片摘要无效'); return s; }
function sessionInput(value: unknown): CashierFormSessionInput {
  const r = exact(value, ['version','scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity']);
  if (r.version !== CASHIER_FORM_SESSION_VERSION) throw new ValidateException('收银图片会话版本无效');
  const buyer_uid = integer(r.buyer_uid, 0), tourist_key = text(r.tourist_key, 50, true);
  if (buyer_uid ? tourist_key !== '' : !/^[A-Za-z0-9_-]{1,50}$/.test(tourist_key)) throw new ValidateException('游客与会员图片归属不能混用');
  return freezeCustomerJson({version:CASHIER_FORM_SESSION_VERSION,scope_key:hash(r.scope_key),buyer_uid,tourist_key,
    product_id:integer(r.product_id),sku_unique:text(r.sku_unique,16),quantity:integer(r.quantity,1,32767)},65536) as unknown as CashierFormSessionInput;
}
function imageInput(value: unknown, sessionKey: string): CashierFormImageInput {
  const r = exact(value, ['version','scope_key','session_key','field_id','sha256','size']);
  if (r.version !== CASHIER_FORM_IMAGE_VERSION || normalizeOutRequestKey(r.session_key) !== sessionKey) throw new ValidateException('收银图片原会话不匹配');
  return freezeCustomerJson({version:CASHIER_FORM_IMAGE_VERSION,scope_key:hash(r.scope_key),session_key:sessionKey,
    field_id:text(r.field_id,255),sha256:hash(r.sha256),size:integer(r.size,1,10485760)},65536) as unknown as CashierFormImageInput;
}
export async function lockCashierFormCreation(db: DbClient, actorUid: number, key: string): Promise<void> {
  await db.execute(sql`SET LOCAL row_security=off`);
  await db.execute(sql`SELECT set_config('lock_timeout','1500ms',true),set_config('statement_timeout','5000ms',true)`);
  const digest = await outRequestHash([actorUid,key]);
  await db.execute(sql`SELECT pg_advisory_xact_lock(731688::int,${parseInt(digest.slice(0,8),16)|0}::int)`);
}
async function authorizeOwner(db: DbClient, actor: CustomerWorkActor): Promise<void> {
  const [row] = await db.select({status:user.status,isDel:user.isDel,deleteTime:user.deleteTime,auth:sql<string>`md5(${user.pwd})`}).from(user).where(eq(user.uid,actor.uid)).limit(1);
  if (!row || row.status !== 1 || row.isDel || row.deleteTime !== null || row.auth !== actor.auth_version
    || actor.expires_at <= Math.floor(Date.now()/1000)) throw new HttpApiException('原收银图片会话已失效，请重新登录核对',403,403);
}
async function writeScope(db: DbClient, actor: CustomerWorkActor, scopeKey: string) {
  await assertCashierSecondCardFormImagesCatalog(db);
  if (!(await cashierSecondCardFormImagesReadiness(db)).ready) throw new HttpApiException('收银图片权限尚未验收',503,503);
  await authorizeCustomerOperationOwner(db,actor); await acquireCustomerWorkScopeLock(db,actor.uid);
  const scope = await authorizeCustomerWorkActor(db,actor);
  if (scope.scope_key !== scopeKey) throw new HttpApiException('收银图片原经营资格已变化',403,403); return scope;
}
async function readSession(db: DbClient, uid: number, key: string, pin = false): Promise<SessionRow|null> {
  const rows = await db.execute<SessionRow>(sql`SELECT ${sessionColumns} FROM public.cashier_second_card_form_session_v1
    WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2 ${pin ? sql`FOR UPDATE NOWAIT` : sql``}`);
  if (rows.length > 1) throw new ValidateException('原收银图片会话身份重复');
  const row = rows[0]; if (!row) return null;
  const intent = sessionInput(JSON.parse(row.intent_json));
  if (row.actor_uid !== uid || row.request_key !== key || row.scope_key !== intent.scope_key || await outRequestHash(intent) !== row.request_hash
    || row.scope_digest !== await cashierFormScopeDigest({...intent,actor_uid:uid,service_id:row.service_id,request_key:key,system_form_id:row.system_form_id})) throw new ValidateException('原收银图片会话事实无法核对');
  return row;
}
function sessionDto(row: SessionRow) {
  return {actor_uid:row.actor_uid,service_id:row.service_id,scope_key:row.scope_key,request_key:row.request_key,request_hash:row.request_hash,
    intent:sessionInput(JSON.parse(row.intent_json)),system_form:JSON.parse(row.template_json) as Awaited<ReturnType<typeof loadActiveOrderSystemForm>>,
    scope_digest:row.scope_digest,state:row.state,created_at:row.created_at,cancelled_at:row.cancelled_at,
    frozen_request_hash:row.frozen_request_hash,order_id:row.order_id,order_no:row.order_no};
}
async function currentForm(db: DbClient, input: CashierFormSessionInput, formId?: number, pin = false) {
  const pq = db.select().from(storeProduct).where(eq(storeProduct.id,input.product_id)).limit(1);
  const [product] = await (pin ? pq.for('share',{noWait:true}) : pq);
  const sq = db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,input.product_id),eq(storeProductAttrValue.unique,input.sku_unique),eq(storeProductAttrValue.type,0))).limit(2);
  const skus = await (pin ? sq.for('share',{noWait:true}) : sq), sku = skus[0];
  const [clock] = await db.execute<{now:number}>(sql`SELECT extract(epoch from clock_timestamp())::bigint AS now`);
  if (!product || product.pid !== 0 || product.productType !== 4 || product.isShow !== 1 || product.isVerify !== 1 || product.isDel
    || product.isPresaleProduct || product.stock < input.quantity || skus.length !== 1 || !sku || sku.isRetired || sku.stock < input.quantity
    || sku.writeTimes <= 0 || ![1,2,3].includes(sku.writeValid) || (sku.writeValid===2 && sku.writeDays<=0)
    || (sku.writeValid===3 && (sku.writeStart<=0 || sku.writeEnd<=sku.writeStart || sku.writeEnd<=Number(clock.now)))
    || product.systemFormId<=0 || (formId !== undefined && product.systemFormId!==formId)) throw new ValidateException('收银图片对应选品、库存、权益或系统表单已变化');
  if (input.buyer_uid>0) {
    const bq=db.select({uid:user.uid}).from(user).where(and(eq(user.uid,input.buyer_uid),eq(user.status,1),eq(user.isDel,0),sql`${user.deleteTime} IS NULL`)).limit(1);
    if ((await (pin ? bq.for('share',{noWait:true}) : bq)).length!==1) throw new ValidateException('图片购买会员已失效');
  }
  const form = await loadActiveOrderSystemForm(db,product.systemFormId,pin);
  if(!form.value.length)throw new ValidateException('收银系统表单配置无效');
  const value = form.value.map(component=>{const c={...component};delete c.assistedImageScope;delete c[CASHIER_IMAGE_SCOPE];return c;});
  if (new TextEncoder().encode(JSON.stringify({...form,value})).byteLength>65536) throw new ValidateException('收银系统表单超过容量');
  const ids = value.map(cashierFormFieldId); if (new Set(ids).size!==ids.length) throw new ValidateException('收银系统表单字段身份重复');
  return {...form,value};
}
async function readUpload(db: DbClient, uid: number, key: string): Promise<UploadRow|null> {
  const rows=await db.execute<UploadRow>(sql`SELECT ${uploadColumns} FROM public.cashier_second_card_form_upload_v1 WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);
  if (rows.length>1) throw new ValidateException('原收银图片上传身份重复'); const row=rows[0]; if(!row)return null;
  const intent=imageInput(JSON.parse(row.intent_json),row.session_key);
  if(row.actor_uid!==uid||row.request_key!==key||await outRequestHash(intent)!==row.request_hash||intent.field_id!==row.field_id
    ||intent.sha256!==row.sha256||intent.size!==row.size)throw new ValidateException('原收银图片上传事实无法核对');
  const session=await readSession(db,uid,row.session_key);
  if(!session||row.service_id!==session.service_id||row.scope_digest!==session.scope_digest||intent.scope_key!==session.scope_key
    ||row.object_key!==cashierFormObjectKey(row.scope_digest,key,row.mime==='image/jpeg'?'jpg':row.mime.split('/')[1]))throw new ValidateException('原收银图片作用域无法核对');
  if(row.state==='stored')await validateAttachment(db,row); return row;
}
async function validateAttachment(db: DbClient, row: UploadRow, pin = false) {
  if(!row.attachment_id)throw new ValidateException('原收银图片元数据缺失');
  const q=db.select().from(systemAttachment).where(eq(systemAttachment.attId,row.attachment_id)).limit(1);
  const [a]=await (pin?q.for('share',{noWait:true}):q),ref=canonicalAttachmentPath(row.attachment_id);
  if(!a||a.type!==3||a.relationId!==row.actor_uid||a.moduleType!==6||a.fileType!==1||a.imageType!==R2_IMAGE_TYPE
    ||a.name!==row.object_key||a.attDir!==ref||a.sattDir!==ref||Number(a.attSize)!==row.size||a.attType.trim()!==row.mime||a.pid!==0)throw new ValidateException('原收银图片实体元数据无法核对');
}
function imageDto(row: UploadRow) {
  return {actor_uid:row.actor_uid,service_id:row.service_id,session_key:row.session_key,request_key:row.request_key,request_hash:row.request_hash,
    intent:imageInput(JSON.parse(row.intent_json),row.session_key),field_id:row.field_id,sha256:row.sha256,size:row.size,mime:row.mime,
    scope_digest:row.scope_digest,state:row.state,attachment_id:row.attachment_id,reference:row.attachment_id?canonicalAttachmentPath(row.attachment_id):null,
    created_at:row.created_at,stored_at:row.stored_at};
}
export class CustomerCashierFormImages {
  constructor(readonly container:Container,readonly env:Env) {}
  private async read<T>(actorValue:CustomerWorkActor, action:(db:DbClient,actor:CustomerWorkActor)=>Promise<T>) {
    const actor=freezeCustomerActor(actorValue), result=await withTx(this.container,async db=>{
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout','5000ms',true)`);await authorizeOwner(db,actor);
      await assertBaseReads(db);await assertCashierSecondCardFormImagesCatalog(db);return action(db,actor);});
    await authorizeOwner(this.container.db,actor);return result;
  }
  getSession(actor:CustomerWorkActor,keyValue:unknown) {const key=normalizeOutRequestKey(keyValue);return this.read(actor,async(db,a)=>{
    const row=await readSession(db,a.uid,key);return {version:CASHIER_FORM_SESSION_VERSION,actor_uid:a.uid,request_key:key,receipt:row?sessionDto(row):null};});}
  getImage(actor:CustomerWorkActor,keyValue:unknown) {const key=normalizeOutRequestKey(keyValue);return this.read(actor,async(db,a)=>{
    const row=await readUpload(db,a.uid,key);return {version:CASHIER_FORM_IMAGE_VERSION,actor_uid:a.uid,request_key:key,receipt:row?imageDto(row):null};});}
  async createSession(actorValue:CustomerWorkActor,keyValue:unknown,value:unknown) {
    const actor=freezeCustomerActor(actorValue), key=normalizeOutRequestKey(keyValue), intent=sessionInput(value), requestHash=await outRequestHash(intent);
    return withTx(this.container,async db=>{await lockCashierFormCreation(db,actor.uid,key);await assertCashierNotAbandoned(db,actor.uid,key,'creation');const scope=await writeScope(db,actor,intent.scope_key);
      const prior=await readSession(db,actor.uid,key,true);if(prior){if(prior.request_hash!==requestHash)throw new HttpApiException('原图片会话已绑定其他内容',409,409);
        return {version:CASHIER_FORM_SESSION_VERSION,actor_uid:actor.uid,request_key:key,receipt:sessionDto(prior)};}
      const drafts=await db.execute(sql`SELECT 1 FROM public.cashier_second_card_cart_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 1`);
      if(drafts.length)throw new HttpApiException('原收银请求已冻结，不能新增图片会话',409,409);
      const form=await currentForm(db,intent,undefined,true),digest=await cashierFormScopeDigest({...intent,actor_uid:actor.uid,service_id:scope.service_id,request_key:key,system_form_id:form.id});
      await db.execute(sql`INSERT INTO public.cashier_second_card_form_session_v1(actor_uid,service_id,scope_key,request_key,request_hash,intent_json,system_form_id,template_json,scope_digest)
        VALUES(${actor.uid},${scope.service_id},${intent.scope_key},${key}::uuid,${requestHash},${JSON.stringify(intent)},${form.id},${JSON.stringify(form)},${digest})`);
      return {version:CASHIER_FORM_SESSION_VERSION,actor_uid:actor.uid,request_key:key,receipt:sessionDto((await readSession(db,actor.uid,key))!)};});
  }
  async cancel(actorValue:CustomerWorkActor,keyValue:unknown,headerValue:unknown,value:unknown) {
    const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue),r=exact(value,['version','scope_key']);
    if(normalizeOutRequestKey(headerValue)!==key||r.version!==CASHIER_FORM_SESSION_VERSION)throw new ValidateException('图片取消必须绑定原创建请求');const scopeKey=hash(r.scope_key);
    return withTx(this.container,async db=>{await lockCashierFormCreation(db,actor.uid,key);await assertCashierNotAbandoned(db,actor.uid,key,'creation');await assertCashierSecondCardFormImagesCatalog(db);await authorizeCustomerOperationOwner(db,actor);
      await assertBaseReads(db);const [permission]=await db.execute<{ready:boolean}>(sql`SELECT has_column_privilege(current_user,'public.cashier_second_card_form_session_v1','state','UPDATE') AND has_column_privilege(current_user,'public.cashier_second_card_form_session_v1','cancelled_at','UPDATE') AS ready`);
      if(!permission?.ready)throw new HttpApiException('原图片会话取消权限尚未验收',503,503);
      const row=await readSession(db,actor.uid,key,true);if(!row||row.scope_key!==scopeKey)throw new ValidateException('原图片会话不存在或归属不符');
      if(row.state==='frozen'||row.state==='consumed')throw new HttpApiException('收银请求已冻结或创建，不能取消图片会话',409,409);
      const drafts=await db.execute(sql`SELECT 1 FROM public.cashier_second_card_cart_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 1`);
      if(drafts.length)throw new HttpApiException('收银请求已冻结，不能取消图片会话',409,409);
      if(row.state==='active')await db.execute(sql`UPDATE public.cashier_second_card_form_session_v1 SET state='cancelled',cancelled_at=clock_timestamp() WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid`);
      return {version:CASHIER_FORM_SESSION_VERSION,actor_uid:actor.uid,request_key:key,receipt:sessionDto((await readSession(db,actor.uid,key))!)};});
  }
  /** Owner and live write authority are checked before multipart buffering. */
  async authorizeUpload(actorValue:CustomerWorkActor,keyValue:unknown) {
    const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue);
    return withTx(this.container,async db=>{await lockCashierFormCreation(db,actor.uid,key);await assertCashierNotAbandoned(db,actor.uid,key,'creation');await assertCashierSecondCardFormImagesCatalog(db);
      await assertBaseReads(db);
      const row=await readSession(db,actor.uid,key,true);if(!row)throw new ValidateException('原收银图片会话不存在');await writeScope(db,actor,row.scope_key);
      if(row.state!=='active')throw new HttpApiException('原图片会话已取消或冻结',409,409);await currentForm(db,sessionInput(JSON.parse(row.intent_json)),row.system_form_id,true);});
  }
  async upload(actorValue:CustomerWorkActor,sessionValue:unknown,keyValue:unknown,value:unknown,file:File) {
    const actor=freezeCustomerActor(actorValue),sessionKey=normalizeOutRequestKey(sessionValue),key=normalizeOutRequestKey(keyValue),intent=imageInput(value,sessionKey);
    if(!(file instanceof File)||file.size!==intent.size)throw new ValidateException('原图片字节数不匹配');
    const bytes=new Uint8Array(await file.arrayBuffer()),detected=detectImageType(bytes);
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(!detected||sha!==intent.sha256||(file.type&&file.type!=='application/octet-stream'&&file.type!==detected.mime))throw new ValidateException('原图片内容、摘要或格式不匹配');
    const requestHash=await outRequestHash(intent);
    const reservation=await withTx(this.container,async db=>{await lockCashierFormCreation(db,actor.uid,sessionKey);await assertCashierNotAbandoned(db,actor.uid,sessionKey,'creation');await authorizeCustomerOperationOwner(db,actor);await assertCashierSecondCardFormImagesCatalog(db);
      const previous=await readUpload(db,actor.uid,key);if(previous){if(previous.request_hash!==requestHash||previous.session_key!==sessionKey||previous.mime!==detected.mime)throw new HttpApiException('原图片 UUID 已绑定其他内容',409,409);
        if(previous.state==='stored')return {row:previous,templateHash:null};}
      const row=await readSession(db,actor.uid,sessionKey,true);if(!row||row.scope_key!==intent.scope_key||row.state!=='active')throw new HttpApiException('原图片会话已取消、冻结或归属变化',409,409);
      await writeScope(db,actor,intent.scope_key);const form=await currentForm(db,sessionInput(JSON.parse(row.intent_json)),row.system_form_id,true);
      if(!form.value.some((c,i)=>c.name==='uploadPicture'&&cashierFormFieldId(c,i)===intent.field_id))throw new ValidateException('原图片字段已变化');
      if(!previous)await db.execute(sql`INSERT INTO public.cashier_second_card_form_upload_v1(actor_uid,service_id,session_key,request_key,request_hash,intent_json,field_id,sha256,size,mime,scope_digest,object_key)
        VALUES(${actor.uid},${row.service_id},${sessionKey}::uuid,${key}::uuid,${requestHash},${JSON.stringify(intent)},${intent.field_id},${sha},${file.size},${detected.mime},${row.scope_digest},${cashierFormObjectKey(row.scope_digest,key,detected.extension)})`);
      return {row:(await readUpload(db,actor.uid,key))!,templateHash:await outRequestHash(form)};});
    const envelope=(row:UploadRow)=>({version:CASHIER_FORM_IMAGE_VERSION,actor_uid:actor.uid,request_key:key,receipt:imageDto(row)});
    if(reservation.row.state==='stored')return envelope(reservation.row);
    const stored=await this.env.ASSETS_BUCKET.put(reservation.row.object_key,bytes,{httpMetadata:{contentType:detected.mime,contentDisposition:'inline',cacheControl:'private, no-store'},customMetadata:{principal:'customer-cashier',actorUid:String(actor.uid),uploadKey:key,sha256:sha}});
    if(stored.size!==file.size)throw new ValidateException('图片对象写入不完整，请保留原 UUID 恢复');
    try {const row=await withTx(this.container,async db=>{await lockCashierFormCreation(db,actor.uid,sessionKey);await assertCashierNotAbandoned(db,actor.uid,sessionKey,'creation');await authorizeCustomerOperationOwner(db,actor);await assertCashierSecondCardFormImagesCatalog(db);
      const prior=await readUpload(db,actor.uid,key);if(!prior||prior.request_hash!==requestHash)throw new ValidateException('原图片预约事实丢失');if(prior.state==='stored')return prior;
      const session=await readSession(db,actor.uid,sessionKey,true);if(!session||session.state!=='active'||session.scope_key!==intent.scope_key)throw new HttpApiException('图片会话已取消或冻结',409,409);
      await writeScope(db,actor,intent.scope_key);const form=await currentForm(db,sessionInput(JSON.parse(session.intent_json)),session.system_form_id,true);
      if(await outRequestHash(form)!==reservation.templateHash||!form.value.some((c,i)=>c.name==='uploadPicture'&&cashierFormFieldId(c,i)===intent.field_id))throw new ValidateException('图片上传期间系统表单已变化');
      const [attachment]=await db.insert(systemAttachment).values({type:3,relationId:actor.uid,moduleType:6,fileType:1,imageType:R2_IMAGE_TYPE,name:prior.object_key,
        attDir:'',sattDir:'',attSize:String(file.size),attType:detected.mime,pid:0,time:Math.floor(Date.now()/1000),realName:'cashier-form-image'}).returning({id:systemAttachment.attId});
      const reference=canonicalAttachmentPath(attachment.id);await db.update(systemAttachment).set({attDir:reference,sattDir:reference}).where(eq(systemAttachment.attId,attachment.id));
      await db.execute(sql`UPDATE public.cashier_second_card_form_upload_v1 SET state='stored',attachment_id=${attachment.id},stored_at=clock_timestamp() WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid`);
      return (await readUpload(db,actor.uid,key))!;});return envelope(row);
    } catch(error) {
      // A durable cancellation excludes every concurrent consumer. In all
      // other states retain the deterministic object, including lost COMMIT
      // replies and concurrent identical original-UUID retries.
      try {const cancelled=await this.read(actor,async db=>(await readSession(db,actor.uid,sessionKey))?.state==='cancelled');
        if(cancelled){try{await this.env.ASSETS_BUCKET.delete(reservation.row.object_key);}catch{await this.env.ORDER_QUEUE.send({action:'deleteAttachmentObjects',keys:[reservation.row.object_key]});}}}catch{/* uncertainty retains the private object */}
      throw error;
    }
  }
  previews(actor:CustomerWorkActor,keyValue:unknown,value:unknown) {const key=normalizeOutRequestKey(keyValue),r=exact(value,['references']);
    if(!Array.isArray(r.references)||r.references.length>900||r.references.some(v=>typeof v!=='string'||!parseCanonicalAttachmentId(v))||new Set(r.references).size!==r.references.length)throw new ValidateException('收银图片预览必须使用唯一 canonical 引用');
    const references=r.references as string[];return this.read(actor,async(db,a)=>{const session=await readSession(db,a.uid,key);if(!session)throw new ValidateException('原图片会话不存在');
      await validateReferences(db,session,references);const urls=await new AttachmentService(this.container,this.env).signReferences(references);
      return {version:'customer-cashier-form-preview-v1' as const,actor_uid:a.uid,session_key:key,previews:references.map((reference,i)=>({reference,url:urls[i]}))};});}
}

async function validateReferences(db:DbClient,session:SessionRow,references:string[],fieldId?:string,pin=false) {
  for(const reference of references){const id=parseCanonicalAttachmentId(reference);if(!id)throw new ValidateException('收银表单图片必须使用 canonical 引用');
    const rows=await db.execute<UploadRow>(sql`SELECT ${uploadColumns} FROM public.cashier_second_card_form_upload_v1 WHERE actor_uid=${session.actor_uid}
      AND session_key=${session.request_key}::uuid AND attachment_id=${id} AND state='stored' LIMIT 2 ${pin?sql`FOR SHARE NOWAIT`:sql``}`);
    if(rows.length!==1||rows[0].scope_digest!==session.scope_digest||(fieldId!==undefined&&rows[0].field_id!==fieldId))throw new ValidateException('收银表单图片不属于原会话与字段');
    const row=await readUpload(db,session.actor_uid,rows[0].request_key);if(!row)throw new ValidateException('原图片事实缺失');await validateAttachment(db,row,pin);
  }
}
/** Called only under the same creation advisory lock as the real draft cart. */
export async function freezeCashierFormSession(db:DbClient,actor:CustomerWorkActor,key:string,input:CustomerCashierInput,requestHash:string) {
  await assertCashierNotAbandoned(db,actor.uid,key,'creation',requestHash);
  const [installed]=await db.execute<{present:boolean}>(sql`SELECT to_regclass('public.cashier_second_card_form_session_v1') IS NOT NULL AS present`);
  const submitted=typeof input.custom_form==='string'?JSON.parse(input.custom_form):input.custom_form;
  const hasImages=Array.isArray(submitted)&&submitted.some(c=>c&&typeof c==='object'&&(c as Record<string,unknown>).name==='uploadPicture'&&Array.isArray((c as Record<string,unknown>).value)&&((c as Record<string,unknown>).value as unknown[]).length>0);
  if(!installed.present){if(hasImages)throw new ValidateException('收银图片会话尚未建立');return;}
  await assertBaseReads(db);await assertCashierSecondCardFormImagesCatalog(db);const session=await readSession(db,actor.uid,key);
  if(!session){if(hasImages)throw new ValidateException('收银图片必须使用原创建会话');return;}
  if(!(await cashierSecondCardFormImagesReadiness(db)).ready)throw new HttpApiException('原收银图片会话写入权限尚未验收',503,503);
  await readSession(db,actor.uid,key,true);
  if(session.state==='cancelled')throw new HttpApiException('原图片会话已取消，不能创建收银草稿',409,409);
  const selection=sessionInput(JSON.parse(session.intent_json));
  if(['scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity'].some(k=>selection[k as keyof CashierFormSessionInput]!==input[k as keyof CustomerCashierInput]))throw new ValidateException('原图片会话与收银创建选品归属不符');
  if(session.state==='frozen'||session.state==='consumed'){if(session.frozen_request_hash!==requestHash)throw new HttpApiException('原图片会话已冻结其他创建内容',409,409);return;}
  const form=await currentForm(db,selection,session.system_form_id,true),prepared=prepareOrderSystemFormSubmission(form.value,input.custom_form,form.id);
  await validatePrepared(db,session,prepared,true);
  await db.execute(sql`UPDATE public.cashier_second_card_form_session_v1 SET state='frozen',frozen_request_hash=${requestHash},frozen_input_json=${JSON.stringify(freezeCustomerJson(input))} WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid`);
}
async function validatePrepared(db:DbClient,session:SessionRow,prepared:PreparedOrderSystemForm,pin:boolean) {
  const components=JSON.parse(prepared.snapshotJson) as Record<string,unknown>[];
  for(let i=0;i<components.length;i++){const component=components[i];if(component.name!=='uploadPicture')continue;
    if(!Array.isArray(component.value)||component.value.some(v=>typeof v!=='string'||!parseCanonicalAttachmentId(v)))throw new ValidateException('收银表单图片必须使用原会话 canonical 引用');
    await validateReferences(db,session,component.value as string[],cashierFormFieldId(component,i),pin);
  }
}
/** Runtime-only cashier capability supplies this context; clients cannot issue it. */
export async function loadCashierFormSubmission(db:DbClient,context:{actor:CustomerWorkActor;request_key:string;request_hash:string},formId:number,value:unknown):Promise<PreparedOrderSystemForm|null> {
  await assertCashierNotAbandoned(db,context.actor.uid,context.request_key,'creation',context.request_hash);
  try {if(formId===0){const submitted=typeof value==='string'?JSON.parse(value):value;
    if(!Array.isArray(submitted)||submitted.length)throw new ValidateException('当前订单不需要表单');return null;}
    const form=await loadActiveOrderSystemForm(db,formId,true),template=form.value.map(c=>{const copy={...c};delete copy.assistedImageScope;delete copy[CASHIER_IMAGE_SCOPE];return copy;});
    const prepared=prepareOrderSystemFormSubmission(template,value,formId),components=JSON.parse(prepared.snapshotJson) as Record<string,unknown>[];
    const imageValues=components.flatMap(c=>c.name==='uploadPicture'&&Array.isArray(c.value)?c.value:[]);
    if(imageValues.some(v=>typeof v!=='string'||!parseCanonicalAttachmentId(v)))throw new ValidateException('收银表单图片只接受原上传 canonical 引用');
    const [installed]=await db.execute<{present:boolean}>(sql`SELECT to_regclass('public.cashier_second_card_form_session_v1') IS NOT NULL AS present`);
    if(!installed.present){if(imageValues.length)throw new ValidateException('收银图片会话尚未建立');return prepared;}
    await assertBaseReads(db);await assertCashierSecondCardFormImagesCatalog(db);const session=await readSession(db,context.actor.uid,context.request_key);
    if(!session){if(imageValues.length)throw new ValidateException('原收银图片会话缺失');return prepared;}
    if(!(await cashierSecondCardFormImagesReadiness(db)).ready)throw new HttpApiException('原收银图片消费权限尚未验收',503,503);
    await readSession(db,context.actor.uid,context.request_key,true);
    if(session.state!=='frozen'||session.frozen_request_hash!==context.request_hash||session.system_form_id!==formId)throw new ValidateException('原收银图片会话未冻结或创建内容不符');
    if(!session.frozen_input_json||await outRequestHash(JSON.parse(session.frozen_input_json))!==context.request_hash)throw new ValidateException('原冻结表单事实无法核对');
    await validatePrepared(db,session,prepared,true);
    for(const component of components)if(component.name==='uploadPicture')component[CASHIER_IMAGE_SCOPE]={version:1,actor_uid:session.actor_uid,service_id:session.service_id,
      session_key:session.request_key,creation_hash:context.request_hash,system_form_id:formId,scope_digest:session.scope_digest};
    prepared.snapshotJson=JSON.stringify(components);return prepared;
  }catch(error){if(error instanceof ValidateException)throw new OrderFormRejectedException(error.message);throw error;}
}
/** Runs in the original order transaction, before its final expiration clock. */
export async function captureCashierFormConsumption(db:DbClient,context:{actor:CustomerWorkActor;request_key:string;request_hash:string},order:{id:number;orderId:string;uid:number;customForm:string|null},prepared:PreparedOrderSystemForm|null) {
  await assertCashierNotAbandoned(db,context.actor.uid,context.request_key,'creation',context.request_hash);
  const [installed]=await db.execute<{present:boolean}>(sql`SELECT to_regclass('public.cashier_second_card_form_session_v1') IS NOT NULL AS present`);if(!installed.present)return;
  const session=await readSession(db,context.actor.uid,context.request_key);if(!session)return;
  await readSession(db,context.actor.uid,context.request_key,true);
  if(!prepared||session.state!=='frozen'||session.frozen_request_hash!==context.request_hash||prepared.systemFormId!==session.system_form_id||order.customForm!==prepared.snapshotJson)throw new ValidateException('原表单消费与创建事务不符');
  const collections=await db.select().from(systemFormData).where(and(eq(systemFormData.relationId,order.id),eq(systemFormData.type,1))).limit(2);
  if(collections.length!==1||collections[0].uid!==order.uid||collections[0].systemFormId!==String(session.system_form_id)||collections[0].isDel||collections[0].value!==prepared.collectedJson)throw new ValidateException('实际表单收集结果无法核对');
  await db.execute(sql`UPDATE public.cashier_second_card_form_session_v1 SET state='consumed',order_id=${order.id},order_no=${order.orderId},snapshot_json=${prepared.snapshotJson},
    snapshot_hash=${await bytesHash(prepared.snapshotJson)},collection_json=${prepared.collectedJson},collection_hash=${await bytesHash(prepared.collectedJson)} WHERE actor_uid=${context.actor.uid} AND request_key=${context.request_key}::uuid`);
}
export async function readCashierConsumedForm(db:DbClient,container:Container,env:Env,actor:CustomerWorkActor,orderId:number,key:string,creationHash:string) {
  const [installed]=await db.execute<{present:boolean}>(sql`SELECT to_regclass('public.cashier_second_card_form_session_v1') IS NOT NULL AS present`);if(!installed.present)return null;
  await assertBaseReads(db);await assertCashierSecondCardFormImagesCatalog(db);const session=await readSession(db,actor.uid,key);if(!session)return null;
  const origins=await db.execute<{origin:unknown;origin_hash:string}>(sql`SELECT origin,origin_hash FROM public.cashier_second_card_origin_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid AND order_id=${orderId} LIMIT 2`);
  if(origins.length!==1)throw new ValidateException('原表单消费缺少真实收银创建来源');
  const origin=parseCashierSecondCardCreationFact(origins[0].origin);
  if(await outRequestHash(origin)!==origins[0].origin_hash||origin.creation_key!==key||origin.creation_hash!==creationHash||origin.creator_uid!==actor.uid
    ||origin.root_order_id!==orderId||origin.service_id!==session.service_id||origin.scope_key!==session.scope_key)throw new ValidateException('原表单消费与真实创建来源不符');
  const [order]=await db.select({id:storeOrder.id,uid:storeOrder.uid,orderId:storeOrder.orderId,staffId:storeOrder.staffId,
    customForm:sql<string|null>`CASE WHEN octet_length(${storeOrder.customForm})<=1048576 THEN ${storeOrder.customForm} ELSE NULL END`}).from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1);
  if(!order||session.state!=='consumed'||session.order_id!==orderId||session.order_no!==order.orderId||session.frozen_request_hash!==creationHash
    ||order.staffId!==actor.uid||order.uid!==origin.buyer_uid||order.orderId!==origin.root_order_no||!session.snapshot_json||!session.collection_json||order.customForm!==session.snapshot_json
    ||await bytesHash(session.snapshot_json)!==session.snapshot_hash||await bytesHash(session.collection_json)!==session.collection_hash)throw new ValidateException('原收银表单消费事实与订单无法核对');
  const rows=await db.select().from(systemFormData).where(and(eq(systemFormData.relationId,orderId),eq(systemFormData.type,1))).limit(2);
  if(rows.length!==1||rows[0].uid!==order.uid||rows[0].systemFormId!==String(session.system_form_id)||rows[0].isDel||rows[0].value!==session.collection_json)throw new ValidateException('原收银表单收集事实缺失或变化');
  const components=JSON.parse(session.snapshot_json) as Record<string,unknown>[],references:string[]=[];
  for(let i=0;i<components.length;i++){const c=components[i];if(c.name==='uploadPicture'){
    const proof=c[CASHIER_IMAGE_SCOPE] as Record<string,unknown>|undefined;
    if(!proof||proof.version!==1||proof.actor_uid!==actor.uid||proof.service_id!==session.service_id||proof.session_key!==key||proof.creation_hash!==creationHash
      ||proof.system_form_id!==session.system_form_id||proof.scope_digest!==session.scope_digest||!Array.isArray(c.value))throw new ValidateException('原收银图片字段消费证明失效');
    await validateReferences(db,session,c.value as string[],cashierFormFieldId(c,i));for(const reference of c.value as string[])if(!references.includes(reference))references.push(reference);
  }delete c.assistedImageScope;delete c[CASHIER_IMAGE_SCOPE];}
  const urls=await new AttachmentService(container,env).signReferences(references);
  return {session_key:key,system_form_id:session.system_form_id,components,previews:references.map((reference,i)=>({reference,url:urls[i]}))};
}
