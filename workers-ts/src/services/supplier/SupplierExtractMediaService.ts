/** A historical extract row delegates exactly two media references. It never
 * grants a gallery, infers old accounts from current settings, or moves money. */
import {and,eq,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {supplierExtract,systemAdmin,systemAttachment} from '@/models/schema';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {classifyProductMediaReference} from '../../../../view/common/productMediaReference';
import {signAttachmentReferences} from '@/services/system/AttachmentService';
import {supplierExtractRevision} from './SupplierExtractReadService';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';
export interface SupplierExtractMediaPreview {reference:string;status:'ready'|'unavailable';src:string;expires_at:number|null}
export interface SupplierExtractMediaContext {version:'supplier-extract-media-v1';actor_id:number;supplier_id:number;id:number;revision:string;previews:{qrcode:SupplierExtractMediaPreview;voucher:SupplierExtractMediaPreview};bounded:true}
const unavailable=()=>new ServiceUnavailableException('提现历史媒体或实际读取权限尚未就绪');
export function parseSupplierExtractMediaQuery(value:Record<string,string[]|undefined>):string {
 if(Object.keys(value).length!==1||!Object.hasOwn(value,'revision')||value.revision?.length!==1||!/^[a-f0-9]{64}$/.test(value.revision[0]))throw new ValidateException('提现历史媒体查询须携带唯一有效版本');
 return value.revision[0];
}
/** Old tickets are parsed only as the row's stored reference, never verified as
 * authorization. A new ticket follows a fresh row/tenant/namespace check. */
export function supplierExtractHistoricalReference(value:unknown):{kind:'asset';id:number;reference:string}|{kind:'public';reference:string}|{kind:'unavailable'} {
 if(typeof value!=='string'||!value||[...value].length>256||/[\u0000-\u001f\u007f]/.test(value)||[...value].some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff))return{kind:'unavailable'};
 const classified=classifyProductMediaReference(value);
 if(classified.kind==='public'&&classified.reference===value)return{kind:'public',reference:value};
 if(classified.kind!=='asset')return{kind:'unavailable'};
 const match=/^\/(?:api|kefuapi)\/assets\/([1-9]\d*)(?:\?([^#]+))?$/.exec(value);
 if(!match||Number(match[1])!==classified.id||classified.id>2147483647)return{kind:'unavailable'};
 if(match[2]){const query=new URLSearchParams(match[2]);if([...query.keys()].length!==2||query.getAll('expires').length!==1||query.getAll('signature').length!==1||!/^\d{1,16}$/.test(query.get('expires')??'')||!/^[A-Za-z0-9_-]{43}$/.test(query.get('signature')??''))return{kind:'unavailable'};}
 return{kind:'asset',id:classified.id,reference:classified.reference};
}
export async function assertSupplierExtractMediaReady(tx:DbClient) {
 const[row]=await tx.execute(sql`SELECT current_user=session_user AND current_setting('transaction_read_only')::boolean AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND NOT has_schema_privilege(current_user,'public','CREATE')
  AND NOT EXISTS(WITH RECURSIVE parents(oid) AS(SELECT r.oid UNION SELECT m.roleid FROM pg_auth_members m JOIN parents p ON p.oid=m.member)
   SELECT 1 FROM parents p JOIN pg_roles unsafe ON unsafe.oid=p.oid WHERE unsafe.rolsuper OR unsafe.rolcreaterole OR unsafe.rolcreatedb OR unsafe.rolreplication OR unsafe.rolbypassrls)
  AND(SELECT count(*)=6 AND bool_and(c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT')) FROM pg_class c WHERE c.relnamespace='public'::regnamespace
   AND c.relname IN('system_admin','system_supplier','system_role','system_menus','supplier_extract','system_attachment')) AS ready FROM pg_roles r WHERE r.rolname=current_user`);
 if(row?.ready!==true)throw unavailable();
}
function failed(error:unknown):never {let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){
 if('code'in cause&&['42501','57014','42P01','42703'].includes(String(cause.code)))throw Object.assign(unavailable(),{cause:error});cause='cause'in cause?cause.cause:undefined;
 }throw error;}
export class SupplierExtractMediaService {
 constructor(private readonly container:Container,private readonly appKey:string){}
 async read(value:SupplierVideoActor,id:number,revision:string):Promise<SupplierExtractMediaContext> {
  const actor=Object.freeze({...value});if(!Number.isSafeInteger(id)||id<1||id>2147483647||!/^[a-f0-9]{64}$/.test(revision))throw new ValidateException('提现历史媒体身份或版本无效');
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await tx.execute(sql`SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','2000ms',true)`);
   await assertSupplierExtractMediaReady(tx);await assertSupplierVideoAuthority(tx,actor,'supplier.finance.view');
   const[extract]=await tx.execute<{id:number;extractType:string;qrcodeUrl:string;voucherImage:string;status:number;payStatus:number;payTime:number;adminId:number;rowVersion:string}>(sql`SELECT ${supplierExtract.id} AS id,${supplierExtract.extractType} AS "extractType",
    ${supplierExtract.qrcodeUrl} AS "qrcodeUrl",${supplierExtract.voucherImage} AS "voucherImage",${supplierExtract.status} AS status,${supplierExtract.payStatus} AS "payStatus",
    ${supplierExtract.payTime} AS "payTime",${supplierExtract.adminId} AS "adminId",${supplierExtract}.xmin::text AS "rowVersion" FROM ${supplierExtract}
    WHERE ${supplierExtract.id}=${id} AND ${supplierExtract.supplierId}=${actor.supplierId} LIMIT 1`);
   if(!extract)throw new NotFoundException('提现记录不存在或不属于当前供应商');
   if(await supplierExtractRevision(actor.supplierId,id,extract.rowVersion)!==revision)throw new HttpApiException('提现记录已变化，请重新读取明细',409,409);
   const blank=(reference:string):SupplierExtractMediaPreview=>({reference,status:'unavailable',src:'',expires_at:null});
   async function project(reference:string,kind:'qrcode'|'voucher',enabled:boolean):Promise<SupplierExtractMediaPreview> {
    const denied=blank(reference),parsed=supplierExtractHistoricalReference(reference);if(!enabled||parsed.kind==='unavailable')return denied;
    if(parsed.kind==='public')return{reference,status:'ready',src:reference,expires_at:null};
    const[asset]=await tx.select().from(systemAttachment).where(and(eq(systemAttachment.attId,parsed.id),eq(systemAttachment.type,kind==='qrcode'?4:1),eq(systemAttachment.relationId,kind==='qrcode'?actor.supplierId:0),eq(systemAttachment.moduleType,1),eq(systemAttachment.fileType,1),eq(systemAttachment.imageType,8))).limit(1);
    const prefix=kind==='qrcode'?`attachments/supplier/${actor.supplierId}/`:'attachments/admin/1/';
    if(!asset||asset.attDir!==parsed.reference||!asset.name.startsWith(prefix)||!['image/png','image/jpeg','image/webp','image/gif'].includes(asset.attType.trim()))return denied;
    return{reference,status:'ready',src:parsed.reference,expires_at:null};
   }
   const valid=(x:number)=>Number.isSafeInteger(x)&&x>0&&x<=2147483647;
   let voucher=extract.status===1&&extract.payStatus===1&&valid(extract.payTime)&&valid(extract.adminId);
   if(voucher){const[admin]=await tx.select({id:systemAdmin.id}).from(systemAdmin).where(and(eq(systemAdmin.id,extract.adminId),eq(systemAdmin.adminType,1))).limit(1);voucher=!!admin;}
   const previews={qrcode:await project(extract.qrcodeUrl,'qrcode',['alipay','weixin'].includes(extract.extractType)),voucher:await project(extract.voucherImage,'voucher',voucher)};
   const privatePreviews=Object.values(previews).filter(p=>p.status==='ready'&&p.src.startsWith('/api/assets/'));
   if(privatePreviews.length){const signed=await signAttachmentReferences(this.appKey,privatePreviews.map(p=>p.src),300);privatePreviews.forEach((p,i)=>{p.src=signed[i];p.expires_at=Number(new URL(p.src,'https://asset.invalid').searchParams.get('expires'));});}
   await assertSupplierVideoAuthority(tx,actor,'supplier.finance.view');
   return{version:'supplier-extract-media-v1',actor_id:actor.id,supplier_id:actor.supplierId,id,revision,previews,bounded:true};
  });}catch(error){return failed(error);}
 }
}
