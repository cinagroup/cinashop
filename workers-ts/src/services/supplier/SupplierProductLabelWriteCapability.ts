import {getTableColumns,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeProductLabel} from '@/models/schema';
import {assertSupplierProductLabelCapabilityReady} from '@/migrations/supplierProductLabelCapability';
import {ApiErrorCode,AuthException,HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import type {SupplierProductLabelActor} from './SupplierProductLabelService';

type Label=typeof storeProductLabel.$inferSelect;
const columns=getTableColumns(storeProductLabel);
const stringFields=new Set(['labelName','color','bgColor','borderColor','icon']);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export function supplierProductLabelCapabilityRow(row:Label){
 return Object.fromEntries(Object.entries(columns).map(([key,column])=>[column.name,row[key as keyof Label]]));
}

function failure(error:unknown):never{
 let cause=error;
 for(let i=0;i<8&&cause&&typeof cause==='object';i++){
  const code='code'in cause?String(cause.code):'',message='message'in cause?String(cause.message):'';
  if(code==='P2101')throw new ValidateException(message.slice(0,256)||'商品标签数据或引用不允许此操作');
  if(code==='P2102')throw new NotFoundException('商品标签不存在或不属于当前供应商');
  if(code==='P2103')throw new HttpApiException('商品标签或权限已变化，请刷新后重试',409,409);
  if(code==='P2104')throw new AuthException('供应商标签权限已变化',ApiErrorCode.ERR_AUTH);
  if(code==='P2105')throw new AuthException('登录凭据已变化或已过期',ApiErrorCode.ERR_EXPIRED);
  if(code==='P2106')throw new ServiceUnavailableException('商品标签提交事实或审计回执不完整');
  cause='cause'in cause?cause.cause:null;
 }
 throw error;
}

/** This port never repairs grants or borrows an Admin connection. The reviewed
 * function owns only Supplier label mutations and their exact audit; ordinary
 * App table DML and historical auxiliary-table reads stay denied. */
export async function mutateSupplierProductLabel(db:DbClient,supplierId:number,actor:SupplierProductLabelActor,
 operation:'create'|'update'|'delete',id:number,previous:Label|undefined,payload:{label_cate:number;label_name:string}|Record<string,never>):Promise<Label>{
 const context=JSON.stringify({actor_id:actor.id,supplier_id:supplierId,auth_version:actor.authVersion,expires_at:actor.expiresAt});
 const expected=previous?JSON.stringify(supplierProductLabelCapabilityRow(previous)):null,payloadJson=JSON.stringify(payload);
 await assertSupplierProductLabelCapabilityReady(db);
 let result:unknown;
 try{
  const [row]=await db.execute(sql`SELECT public.supplier_product_label_mutate_v1(${context}::jsonb,${operation},${id},${expected}::jsonb,${payloadJson}::jsonb) AS mutation`);
  result=row?.mutation;
 }catch(error){failure(error);}
 if(!record(result)||Object.keys(result).sort().join(',')!=='audit_id,row'||typeof result.audit_id!=='number'||!Number.isSafeInteger(result.audit_id)||Number(result.audit_id)<=0||!record(result.row))throw new ServiceUnavailableException('商品标签写入回执不完整');
 const raw=result.row,keys=Object.values(columns).map(column=>column.name).sort();
 if(Object.keys(raw).sort().join(',')!==keys.join(','))throw new ServiceUnavailableException('商品标签完整字段回执不一致');
 const values:Record<string,string|number>={};
 for(const [key,column]of Object.entries(columns)){
  const value=raw[column.name];
  if(stringFields.has(key)){
   if(typeof value!=='string')throw new ServiceUnavailableException('商品标签文本回执不一致');
   values[key]=value;
  }else{
   if(typeof value!=='number'||!Number.isSafeInteger(value)||value< -2147483648||value>2147483647)throw new ServiceUnavailableException('商品标签数字回执不一致');
   values[key]=value;
  }
 }
 const saved=values as unknown as Label;
 if(saved.id<=0||saved.type!==2||saved.relationId!==supplierId||(operation==='create'?id!==0:saved.id!==id))throw new ServiceUnavailableException('商品标签归属回执不一致');
 return saved;
}
