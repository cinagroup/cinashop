/** Original application evidence delegates only its original QR reference.
 * Expiring media is a separate projection; immutable receipt bytes stay intact. */
import {and,eq,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {systemAttachment} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {signAttachmentReferences} from '@/services/system/AttachmentService';
import {extractUuid} from './SupplierExtractApplicationInput';
import {extractReceipt,readExtractOperation,verifyActualExtract} from './SupplierExtractApplicationOperation';
import {supplierExtractHistoricalReference,type SupplierExtractMediaPreview} from './SupplierExtractMediaService';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';

export interface SupplierExtractApplicationMediaContext {
 version:'supplier-extract-application-media-v1';operation_id:string;actor_id:number;supplier_id:number;
 request_hash:string;extract_id:number;preview:SupplierExtractMediaPreview;bounded:true;
}
const unavailable=()=>new ServiceUnavailableException('提现原申请媒体或实际读取权限尚未就绪');
export function parseSupplierExtractApplicationMediaQuery(value:Record<string,string[]|undefined>):string {
 if(Object.keys(value).length!==1||!Object.hasOwn(value,'request_hash')||value.request_hash?.length!==1||!/^[a-f0-9]{64}$/.test(value.request_hash[0]))
  throw new ValidateException('提现原申请媒体查询须携带唯一有效请求摘要');
 return value.request_hash[0];
}
/** Check metadata before touching any business relation: missing SELECT returns
 * 503 without putting the caller's read-only transaction into an aborted state. */
export async function assertSupplierExtractApplicationMediaReady(tx:DbClient) {
 const[row]=await tx.execute(sql`SELECT current_user=session_user AND current_setting('transaction_read_only')::boolean
  AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND NOT has_schema_privilege(current_user,'public','CREATE')
  AND NOT EXISTS(WITH RECURSIVE parents(oid) AS(SELECT r.oid UNION SELECT m.roleid FROM pg_auth_members m JOIN parents p ON p.oid=m.member)
   SELECT 1 FROM parents p JOIN pg_roles unsafe ON unsafe.oid=p.oid WHERE unsafe.rolsuper OR unsafe.rolcreaterole OR unsafe.rolcreatedb OR unsafe.rolreplication OR unsafe.rolbypassrls)
  AND(SELECT count(*)=7 AND bool_and(c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT')) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
   AND c.relname IN('system_admin','system_supplier','system_role','system_menus','supplier_extract','system_attachment','supplier_extract_application_operation_v1')) AS ready
  FROM pg_roles r WHERE r.rolname=current_user`);
 if(row?.ready!==true)throw unavailable();
}
function failure(error:unknown):never {
 let cause=error;
 for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
  if('code'in cause&&['42501','57014','42P01','42703'].includes(String(cause.code)))throw Object.assign(unavailable(),{cause:error});
  cause='cause'in cause?cause.cause:undefined;
 }
 throw error;
}
export class SupplierExtractApplicationMediaService {
 constructor(private readonly container:Container,private readonly appKey:string){}
 async read(value:SupplierVideoActor,operationId:string,requestHash:string):Promise<SupplierExtractApplicationMediaContext> {
  const actor=Object.freeze({...value}),uuid=extractUuid(operationId);
  if(!/^[a-f0-9]{64}$/.test(requestHash))throw new ValidateException('提现原申请请求摘要无效');
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await tx.execute(sql`SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','2000ms',true)`);
   await assertSupplierExtractApplicationMediaReady(tx);
   // Original recovery requires a live original identity, not today's financial
   // capabilities, current accounts, balance, config or mutable extract xmin.
   await assertSupplierVideoAuthority(tx,actor,null);
   const operation=await readExtractOperation(tx,uuid);
   if(!operation||operation.actor_id!==actor.id||operation.supplier_id!==actor.supplierId||operation.state!=='committed')
    throw new NotFoundException('提现原申请媒体不存在或不可读取');
   if(operation.request_hash!==requestHash)throw new HttpApiException('提现原申请请求摘要不匹配，请重新核对原结果',409,409);
   const receipt=extractReceipt(operation,uuid,actor);
   await verifyActualExtract(tx,operation);
   const result=receipt.result!;
   const preview:SupplierExtractMediaPreview={reference:result.qrcode_url,status:'unavailable',src:'',expires_at:null};
   if(result.extract_type==='alipay'||result.extract_type==='weixin'){
    const parsed=supplierExtractHistoricalReference(result.qrcode_url);
    if(parsed.kind==='public')Object.assign(preview,{status:'ready',src:result.qrcode_url});
    else if(parsed.kind==='asset'){
     const[asset]=await tx.select().from(systemAttachment).where(and(eq(systemAttachment.attId,parsed.id),eq(systemAttachment.type,4),
      eq(systemAttachment.relationId,actor.supplierId),eq(systemAttachment.moduleType,1),eq(systemAttachment.fileType,1),eq(systemAttachment.imageType,8))).limit(1);
     if(asset&&asset.attDir===parsed.reference&&asset.name.startsWith(`attachments/supplier/${actor.supplierId}/`)
      &&['image/png','image/jpeg','image/webp','image/gif'].includes(asset.attType.trim())){
      const[src]=await signAttachmentReferences(this.appKey,[parsed.reference],300);
      Object.assign(preview,{status:'ready',src,expires_at:Number(new URL(src,'https://asset.invalid').searchParams.get('expires'))});
     }
    }
   }
   await assertSupplierVideoAuthority(tx,actor,null);
   return{version:'supplier-extract-application-media-v1',operation_id:uuid,actor_id:actor.id,supplier_id:actor.supplierId,
    request_hash:operation.request_hash,extract_id:result.id,preview,bounded:true};
  });}catch(error){return failure(error);}
 }
}
