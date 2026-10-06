import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {storeProduct,storeProductAttrValue,storeProductRelation} from '@/models/schema';
import {lockProductWrite} from '@/services/product/ProductAssociationService';
import {boundBargainSourceProductChange,lockBargainSourceProductChange} from '@/services/activity/BargainSourceProductLifecycle';
import {normalizeOutRequestKey,outRequestHash} from '@/services/out/OutIdempotency';
import {assertCustomerProductOperationCatalog,customerProductOperationReadiness} from '@/migrations/runCustomerProductOperation';
import {acquireCustomerProductCatalogLock} from '@/migrations/runCustomerProductCatalogLock';
import {acquireCustomerWorkScopeLock} from '@/migrations/runCustomerWorkScopeLock';
import {AuthException,HttpApiException,NotFoundException,ValidateException} from '@/utils/errors';
import {authorizeCustomerWorkActor,customerWorkId,type CustomerWorkActor,type CustomerWorkScope} from './CustomerWorkScope';
import {authorizeCustomerOperationOwner,freezeCustomerActor,freezeCustomerJson,type CustomerJson} from './CustomerWorkOperationRequest';
import {customerProductCatalogRevision,readCustomerProductState,type CustomerProductState} from './CustomerWorkProductReadService';

export const CUSTOMER_PRODUCT_OPERATION_VERSION='customer-work-product-operation-v1' as const;
export type CustomerProductOperationKind='set_show'|'replace_categories'|'replace_labels'|'update_skus';
export type CustomerProductOperationOutcome='products-updated'|'skus-updated'|'rollback-rejected'|'abandoned';
export interface CustomerProductOperationBody {readonly version:typeof CUSTOMER_PRODUCT_OPERATION_VERSION;readonly scope_key:string;readonly targets:readonly{readonly product_id:number;readonly expected_product_revision:string}[];readonly expected_catalog_revision:string;readonly payload:CustomerJson}
export interface CustomerProductOperationContext {actor:CustomerWorkActor;request_key:string}
export interface PreparedCustomerProductOperation {readonly actor:CustomerWorkActor;readonly key:string;readonly hash:string;readonly kind:CustomerProductOperationKind;readonly input:CustomerProductOperationBody}
export interface CustomerProductOperationReceipt {version:typeof CUSTOMER_PRODUCT_OPERATION_VERSION;actor_uid:number;service_id:number;request_key:string;request_hash:string;kind:CustomerProductOperationKind;product_ids:number[];outcome:CustomerProductOperationOutcome;evidence:Record<string,CustomerJson>}
export interface CustomerProductOperationResult {receipt:CustomerProductOperationReceipt;replayed:boolean}
const kinds=new Set(['set_show','replace_categories','replace_labels','update_skus']),hash=/^[a-f0-9]{64}$/;
export function customerProductExactKeys(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new ValidateException('商品操作字段不符合合同');}
export async function prepareCustomerProductOperation(kind:CustomerProductOperationKind,context:CustomerProductOperationContext,value:unknown):Promise<PreparedCustomerProductOperation>{
 if(!kinds.has(kind))throw new ValidateException('商品操作种类无效');const actor=freezeCustomerActor(context.actor),key=normalizeOutRequestKey(context.request_key),body=freezeCustomerJson(value);customerProductExactKeys(body,['version','scope_key','targets','expected_catalog_revision','payload']);
 if(body.version!==CUSTOMER_PRODUCT_OPERATION_VERSION||typeof body.scope_key!=='string'||!hash.test(body.scope_key)||typeof body.expected_catalog_revision!=='string'||!hash.test(body.expected_catalog_revision)||!Array.isArray(body.targets)||!body.targets.length||body.targets.length>100)throw new ValidateException('商品操作身份或版本无效');
 let previous=0;const targets=body.targets.map(value=>{customerProductExactKeys(value,['product_id','expected_product_revision']);if(typeof value.product_id!=='number'||value.product_id<=previous||typeof value.expected_product_revision!=='string'||!hash.test(value.expected_product_revision))throw new ValidateException('商品目标须按编号唯一排序');const id=customerWorkId(value.product_id,'商品');previous=id;return Object.freeze({product_id:id,expected_product_revision:value.expected_product_revision});});
 if(kind==='update_skus'&&targets.length!==1)throw new ValidateException('规格修改仅接受一个商品');
 const input=Object.freeze({version:CUSTOMER_PRODUCT_OPERATION_VERSION,scope_key:body.scope_key,targets:Object.freeze(targets),expected_catalog_revision:body.expected_catalog_revision,payload:body.payload as CustomerJson});return Object.freeze({actor,key,kind,input,hash:await outRequestHash({version:CUSTOMER_PRODUCT_OPERATION_VERSION,actor_uid:actor.uid,kind,input})});
}
async function lockRequest(tx:DbClient,uid:number,key:string,write=true){
 if(Object.hasOwn(tx,'$client'))throw Error('Product operation requires caller-owned transaction');await assertCustomerProductOperationCatalog(tx);await tx.execute(sql`LOCK TABLE public.customer_product_operation_request IN ROW SHARE MODE NOWAIT`);if(write&&!(await customerProductOperationReadiness(tx)).ready)throw new HttpApiException('商品操作台账或运行权限尚未验收',503,503);
 await tx.execute(sql`SET LOCAL row_security=off`);await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text||'ms',true)`);
 const digest=await outRequestHash([uid,key]);await tx.execute(sql`SELECT pg_advisory_xact_lock(731646::int,${parseInt(digest.slice(0,8),16)|0}::int)`);
}
async function readReceipt(tx:DbClient,uid:number,key:string):Promise<CustomerProductOperationReceipt|null>{const rows=await tx.execute<{actor_uid:number;service_id:number;request_hash:string;kind:CustomerProductOperationKind;targets:{product_id:number}[];outcome:CustomerProductOperationOutcome;evidence:Record<string,CustomerJson>}>(sql`SELECT actor_uid,service_id,request_hash,kind,targets,outcome,evidence FROM public.customer_product_operation_request WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);if(rows.length>1)throw Error('Product receipt identity ambiguous');if(!rows[0])return null;const{targets,...row}=rows[0];return{version:CUSTOMER_PRODUCT_OPERATION_VERSION,request_key:key,...row,product_ids:targets.map(t=>t.product_id)};}
function same(receipt:CustomerProductOperationReceipt,p:PreparedCustomerProductOperation){if(receipt.request_hash!==p.hash||receipt.kind!==p.kind||receipt.product_ids.join(',')!==p.input.targets.map(t=>t.product_id).join(','))throw new HttpApiException('原请求键已用于不同商品操作',409,409);}
async function prior(tx:DbClient,p:PreparedCustomerProductOperation,write=true){await lockRequest(tx,p.actor.uid,p.key,write);const result=await readReceipt(tx,p.actor.uid,p.key);if(result)same(result,p);return result;}
async function append(tx:DbClient,p:PreparedCustomerProductOperation,serviceId:number,outcome:CustomerProductOperationOutcome,evidence:Record<string,CustomerJson>={}):Promise<CustomerProductOperationReceipt>{
 const expected=p.kind==='update_skus'?'skus-updated':'products-updated';if(!Number.isSafeInteger(serviceId)||serviceId<0||![expected,'abandoned','rollback-rejected'].includes(outcome)||serviceId===0&&outcome===expected)throw new ValidateException('商品回执无效');const safe=freezeCustomerJson(evidence,16384),existing=await prior(tx,p);if(existing){if(existing.outcome!==outcome)throw new HttpApiException('原商品操作已有确定回执',409,409);return existing;}
 await tx.execute(sql`INSERT INTO public.customer_product_operation_request(actor_uid,request_key,request_hash,service_id,kind,scope_key,targets,expected_catalog_revision,intent,evidence,outcome) VALUES(${p.actor.uid},${p.key}::uuid,${p.hash},${serviceId},${p.kind},${p.input.scope_key},${JSON.stringify(p.input.targets)}::jsonb,${p.input.expected_catalog_revision},${JSON.stringify(p.input)}::jsonb,${JSON.stringify(safe)}::jsonb,${outcome})`);const result=await readReceipt(tx,p.actor.uid,p.key);if(!result)throw Error('Product receipt did not persist');same(result,p);return result;
}
export async function authorizeCustomerProductWrite(tx:DbClient,p:PreparedCustomerProductOperation){await authorizeCustomerOperationOwner(tx,p.actor);await acquireCustomerWorkScopeLock(tx,p.actor.uid);const scope=await authorizeCustomerWorkActor(tx,p.actor);if(scope.scope_key!==p.input.scope_key)throw new HttpApiException('商品管理身份已变化，请重新读取',403,403);return scope;}
/** Resource order follows the established management writer. NOWAIT avoids
 * checkout's cart→SKU→product lock cycle; account and role locks last to commit. */
export async function lockCustomerProducts(tx:DbClient,ids:number[]){for(const id of ids)await lockProductWrite(tx,id);const rows=await tx.select().from(storeProduct).where(inArray(storeProduct.id,ids)).orderBy(asc(storeProduct.id)).for('update',{noWait:true});if(rows.length!==ids.length||rows.some(r=>r.isDel))throw new NotFoundException('商品不存在或已删除');await tx.select({id:storeProductAttrValue.id}).from(storeProductAttrValue).where(and(inArray(storeProductAttrValue.productId,ids),eq(storeProductAttrValue.type,0))).orderBy(asc(storeProductAttrValue.productId),asc(storeProductAttrValue.id)).for('update',{noWait:true});await tx.select({id:storeProductRelation.id}).from(storeProductRelation).where(inArray(storeProductRelation.productId,ids)).orderBy(asc(storeProductRelation.productId),asc(storeProductRelation.id)).for('update',{noWait:true});return rows;}
/** Normal topology writers cooperate through the product row/advisory lock.
 * This final read additionally refuses any already-observed noncooperating
 * insertion. It is not a global table fence for arbitrary direct SQL writers. */
async function verifyTopology(tx:DbClient,states:CustomerProductState[],p:PreparedCustomerProductOperation){
 const payload=p.input.payload as Record<string,CustomerJson>;
 for(const before of states){const after=await readCustomerProductState(tx,before.product.id),updates=p.kind==='update_skus'?payload.attr_value as unknown as{unique:string;price:string;cost:string;ot_price:string;stock:number}[]:[],expectedSkus=before.skus.map(row=>{const update=row.isRetired===0?updates.find(u=>u.unique===row.unique):undefined;return update?{...row,price:update.price,cost:update.cost,otPrice:update.ot_price,stock:update.stock,sumStock:before.product.productType===1&&!row.diskInfo?row.sumStock:update.stock}:row;});
  if(await outRequestHash(after.skus)!==await outRequestHash(expectedSkus))throw new HttpApiException('商品规格完整集合在写入期间变化，请重新读取',412,412);
  const relationType=p.kind==='replace_categories'?1:p.kind==='replace_labels'?3:0;
  if(relationType){const expectedIds=(relationType===1?payload.cate_id:payload.store_label_id) as number[],replaced=after.relations.filter(r=>r.type===relationType);if(replaced.length!==expectedIds.length||replaced.some(r=>!expectedIds.includes(r.relationId)))throw new HttpApiException('商品关联完整集合在写入期间变化，请重新读取',412,412);}
  const expectedRelations=before.relations.filter(r=>relationType===0||r.type!==relationType).map(row=>p.kind==='set_show'&&row.type===1?{...row,status:Number(payload.is_show)}:row),actualRelations=after.relations.filter(r=>relationType===0||r.type!==relationType);
  if(await outRequestHash(actualRelations)!==await outRequestHash(expectedRelations))throw new HttpApiException('商品其他关联在写入期间变化，请重新读取',412,412);
 }
}
export class CustomerWorkProductOperationRequest {
 constructor(readonly container:Container){}
 async outcome(value:CustomerWorkActor,keyValue:unknown){const actor=freezeCustomerActor(value),key=normalizeOutRequestKey(keyValue);return withTx(this.container,async tx=>{await lockRequest(tx,actor.uid,key,false);await authorizeCustomerOperationOwner(tx,actor);return readReceipt(tx,actor.uid,key);});}
 async abandon(kind:CustomerProductOperationKind,context:CustomerProductOperationContext,value:unknown){const p=await prepareCustomerProductOperation(kind,context,value);return withTx(this.container,async tx=>{const existing=await prior(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return existing??append(tx,p,0,'abandoned');});}
 private async rejection(p:PreparedCustomerProductOperation,error:unknown){if(!(error instanceof ValidateException||error instanceof NotFoundException||error instanceof AuthException||error instanceof HttpApiException&&[403,412].includes(error.httpStatus)))return null;return withTx(this.container,async tx=>{const existing=await prior(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:existing??await append(tx,p,0,'rollback-rejected',{code:error instanceof HttpApiException?String(error.httpStatus):String(error.code)}),replayed:Boolean(existing)};});}
 async execute(kind:CustomerProductOperationKind,context:CustomerProductOperationContext,value:unknown,callback:(tx:DbClient,scope:CustomerWorkScope,states:CustomerProductState[],p:PreparedCustomerProductOperation)=>Promise<{changed:number;verified:true}>):Promise<CustomerProductOperationResult>{
  const p=await prepareCustomerProductOperation(kind,context,value);try{return await withTx(this.container,async tx=>{const existing=await prior(tx,p);if(existing){await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:existing,replayed:true};}
   // Visibility writers enter the bargain lifecycle boundary before product,
   // SKU, relation or cart locks. Targets are already strictly ascending.
   if(kind==='set_show'){await boundBargainSourceProductChange(tx);for(const target of p.input.targets)await lockBargainSourceProductChange(tx,target.product_id);}
   await lockCustomerProducts(tx,p.input.targets.map(t=>t.product_id));const scope=await authorizeCustomerProductWrite(tx,p);
   // All four intents use the same full catalog fence, including ancestors and
   // rows which do not exist yet. Caller has no taxonomy DML privilege.
   await acquireCustomerProductCatalogLock(tx,kind==='replace_labels'?'label':'category',[]);
   if(await customerProductCatalogRevision(tx)!==p.input.expected_catalog_revision)throw new HttpApiException('商品分类或标签目录已变化，请重新读取',412,412);
   const states=[];for(const target of p.input.targets){const state=await readCustomerProductState(tx,target.product_id);if(state.revision!==target.expected_product_revision)throw new HttpApiException('商品或规格已变化，请重新读取',412,412);states.push(state);}
   const evidence=await callback(tx,scope,states,p);await verifyTopology(tx,states,p);await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:await append(tx,p,scope.service_id,kind==='update_skus'?'skus-updated':'products-updated',evidence),replayed:false};});}
  catch(error){let failure=error,cause:unknown=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){if('code' in cause&&cause.code==='55P03'){failure=new ValidateException('商品或权限正在变化，请重新读取后重试');break;}cause='cause'in cause?cause.cause:undefined;}const rejected=await this.rejection(p,failure);if(rejected)return rejected;throw failure;}
 }
}
