/** A product.view projection. The editing DTO and virtual delivery data never
 * participate in this query or response. All facts share one read-only snapshot. */
import {and,asc,eq,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {storeProduct,storeProductAttr,storeProductAttrValue,storeProductDescription} from '@/models/schema';
import {NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {sanitizePublishedArticleHtml} from '@/services/content/ArticleContentPolicy';
import {parseCanonicalAttachmentId,signAttachmentReferences} from '@/services/system/AttachmentService';
import {resolveProductVideoReference} from '@/services/product/ProductVideoPolicy';
import {normalizeSupplierProductMediaReference,projectSupplierProductMedia,supplierProductEditingHtml} from './SupplierProductMediaService';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';

export const SUPPLIER_PRODUCT_DETAIL_LIMITS={skus:500,attributes:16,values:100,sliders:10,previews:640,html:400_000,bytes:2*1024*1024} as const;
const unavailable=()=>new ServiceUnavailableException('商品只读详情或实际读取权限尚未就绪');
export function supplierProductDetailId(value:unknown):number {
 if(typeof value!=='string'||!/^[1-9]\d*$/.test(value)||Number(value)>2_147_483_647)throw new ValidateException('商品详情ID无效');
 return Number(value);
}
export function assertSupplierProductDetailQuery(value:Record<string,string[]|undefined>):void {
 if(Object.keys(value).length)throw new ValidateException('商品只读详情不接受查询参数');
}
function text(value:unknown,maximum:number):string {
 if(typeof value!=='string'||value.length>maximum||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw unavailable();
 return value;
}
function integer(value:number,minimum=0,maximum=2_147_483_647):number {
 if(!Number.isSafeInteger(value)||value<minimum||value>maximum)throw unavailable();return value;
}
function member(value:number,values:readonly number[]):number {if(!values.includes(value))throw unavailable();return value;}
export function supplierProductDetailMoney(value:unknown):string {
 if(typeof value!=='string'||!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value))throw unavailable();return value;
}
export function supplierProductDetailSliders(value:string):string[] {
 let parsed:unknown;try{parsed=value===''?[]:JSON.parse(value);}catch{throw unavailable();}
 if(!Array.isArray(parsed)||parsed.length>SUPPLIER_PRODUCT_DETAIL_LIMITS.sliders||parsed.some(x=>typeof x!=='string'||x.length>4096))throw unavailable();
 return parsed.map(reference);
}
function reference(value:string):string {try{return normalizeSupplierProductMediaReference(value);}catch{return '';}}
export function supplierProductDetailAttribute(name:string,values:string):{name:string;values:string[]} {
 const items=text(values,32_768).split(',').map(x=>x.trim()).filter(Boolean);
 if(!name.trim()||items.length>SUPPLIER_PRODUCT_DETAIL_LIMITS.values||items.some(x=>x.length>512)||new Set(items).size!==items.length)throw unavailable();
 return{name:text(name,32),values:items};
}
/** Metadata SELECT precedes business SELECT, so a missing grant returns 503
 * without aborting the caller's transaction. Writer LOGINs are also safe here. */
export async function assertSupplierProductDetailReadReady(tx:DbClient):Promise<void> {
 const[row]=await tx.execute(sql`SELECT current_user=session_user AND current_setting('transaction_read_only')::boolean
  AND current_setting('transaction_isolation')='repeatable read'
  AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND NOT has_schema_privilege(current_user,'public','CREATE')
  AND NOT EXISTS(WITH RECURSIVE parents(oid)AS(SELECT r.oid UNION SELECT m.roleid FROM pg_auth_members m JOIN parents p ON p.oid=m.member)
   SELECT 1 FROM parents p JOIN pg_roles unsafe ON unsafe.oid=p.oid WHERE unsafe.rolsuper OR unsafe.rolcreaterole OR unsafe.rolcreatedb OR unsafe.rolreplication OR unsafe.rolbypassrls)
  AND(SELECT count(*)=9 AND bool_and(c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT'))FROM pg_class c
   WHERE c.relnamespace='public'::regnamespace AND c.relname IN('system_admin','system_supplier','system_role','system_menus',
    'store_product','store_product_attr','store_product_attr_value','store_product_description','system_attachment'))AS ready
  FROM pg_roles r WHERE r.rolname=current_user`);
 if(row?.ready!==true)throw unavailable();
}
function readFailure(error:unknown):never {
 let cause=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
  if('code'in cause&&['42501','42P01','42703','57014'].includes(String(cause.code)))throw Object.assign(unavailable(),{cause:error});
  cause='cause'in cause?cause.cause:undefined;
 }throw error;
}
/** Explicitly exported for trusted transaction composition and native snapshot
 * proof; its admission still enforces actual RR/READ ONLY and live authority. */
export async function readSupplierProductDetailSnapshot(tx:DbClient,actor:SupplierVideoActor,productId:number,appKey:string|undefined){
 await assertSupplierProductDetailReadReady(tx);
 await assertSupplierVideoAuthority(tx,actor,'supplier.product.view');
 const[p]=await tx.select({product_type:storeProduct.productType,store_name:storeProduct.storeName,store_info:storeProduct.storeInfo,
  keyword:storeProduct.keyword,unit_name:storeProduct.unitName,bar_code:storeProduct.barCode,image:storeProduct.image,
  slider_image:storeProduct.sliderImage,price:storeProduct.price,ot_price:storeProduct.otPrice,vip_price:storeProduct.vipPrice,
  stock:storeProduct.stock,sales:storeProduct.sales,spec_type:storeProduct.specType,freight:storeProduct.freight,
  postage:storeProduct.postage,temp_id:storeProduct.tempId,is_postage:storeProduct.isPostage,is_support_refund:storeProduct.isSupportRefund,
  is_limit:storeProduct.isLimit,limit_type:storeProduct.limitType,limit_num:storeProduct.limitNum,is_show:storeProduct.isShow,
  is_verify:storeProduct.isVerify,refusal:storeProduct.refusal,sort:storeProduct.sort,ficti:storeProduct.ficti,
  add_time:storeProduct.addTime,video_link:storeProduct.videoLink}).from(storeProduct).where(and(eq(storeProduct.id,productId),
   eq(storeProduct.type,2),eq(storeProduct.relationId,actor.supplierId),eq(storeProduct.isDel,0))).limit(1);
 if(!p)throw new NotFoundException('商品不存在或不属于当前供应商');
 const dimensions=await tx.select({name:storeProductAttr.attrName,values:storeProductAttr.attrValues}).from(storeProductAttr)
  .where(and(eq(storeProductAttr.productId,productId),eq(storeProductAttr.type,0))).orderBy(asc(storeProductAttr.id)).limit(17);
 const rows=await tx.select({id:storeProductAttrValue.id,suk:storeProductAttrValue.suk,price:storeProductAttrValue.price,
  ot_price:storeProductAttrValue.otPrice,vip_price:storeProductAttrValue.vipPrice,stock:storeProductAttrValue.stock,
  sales:storeProductAttrValue.sales,image:storeProductAttrValue.image,bar_code:storeProductAttrValue.barCode,is_retired:storeProductAttrValue.isRetired})
  .from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,productId),eq(storeProductAttrValue.type,0),eq(storeProductAttrValue.isRetired,0)))
  .orderBy(asc(storeProductAttrValue.id)).limit(501);
 const descriptions=await tx.select({html:storeProductDescription.description}).from(storeProductDescription)
  .where(and(eq(storeProductDescription.productId,productId),eq(storeProductDescription.type,0))).limit(2);
 if(dimensions.length>16||rows.length>500||descriptions.length>1)throw unavailable();
 const attributes=dimensions.map(x=>supplierProductDetailAttribute(x.name,x.values));
 if(new Set(attributes.map(x=>x.name)).size!==attributes.length)throw unavailable();
 const skus=rows.map(x=>({id:integer(x.id,1),suk:text(x.suk,512),price:supplierProductDetailMoney(x.price),
  ot_price:supplierProductDetailMoney(x.ot_price),vip_price:supplierProductDetailMoney(x.vip_price),stock:integer(x.stock),
  sales:integer(x.sales),image:reference(text(x.image,4096)),bar_code:text(x.bar_code,50),is_retired:0 as const}));
 const sliders=supplierProductDetailSliders(p.slider_image),rawHtml=descriptions[0]?.html??'';
 if(rawHtml.length>SUPPLIER_PRODUCT_DETAIL_LIMITS.html)throw unavailable();
 const canonicalHtml=sanitizePublishedArticleHtml(supplierProductEditingHtml(rawHtml));
 if(canonicalHtml.length>SUPPLIER_PRODUCT_DETAIL_LIMITS.html)throw unavailable();
 // Reuse mature tenant media authority, but never send its signed HTML into a
 // second frontend reference parser. Only the preview map contains tickets.
 const media=await projectSupplierProductMedia(tx,actor.supplierId,{sliderImages:[reference(p.image),...sliders],skus,description:canonicalHtml},appKey);
 if(media.status==='too_many_references')throw unavailable();
 media.description_html=canonicalHtml;
 const video=await resolveProductVideoReference(tx,p.video_link,{type:2,relationId:actor.supplierId},{allowLegacyRelative:true});
 const videoPreview=video&&parseCanonicalAttachmentId(video)!==null
  ?appKey?(await signAttachmentReferences(appKey,[video],300))[0]:'':video;
 const product={product_type:member(p.product_type,[0,1,2,3,4]),store_name:text(p.store_name,256),store_info:text(p.store_info,256),
  keyword:text(p.keyword,256),unit_name:text(p.unit_name,32),bar_code:text(p.bar_code,15),image:reference(text(p.image,4096)),
  slider_image:sliders,price:supplierProductDetailMoney(p.price),ot_price:supplierProductDetailMoney(p.ot_price),vip_price:supplierProductDetailMoney(p.vip_price),
  stock:integer(p.stock),sales:integer(p.sales),spec_type:member(p.spec_type,[0,1]),freight:member(p.freight,[1,2,3]),
  postage:supplierProductDetailMoney(p.postage),temp_id:integer(p.temp_id),is_postage:member(p.is_postage,[0,1]),
  is_support_refund:member(p.is_support_refund,[0,1]),is_limit:member(p.is_limit,[0,1]),limit_type:member(p.limit_type,[0,1,2]),
  limit_num:integer(p.limit_num),is_show:member(p.is_show,[0,1]),is_verify:member(p.is_verify,[-2,-1,0,1]),refusal:text(p.refusal,4096),
  sort:integer(p.sort,-2_147_483_648),ficti:integer(p.ficti),add_time:integer(p.add_time),video_link:video,video_preview_url:videoPreview};
 const result={version:'supplier-product-detail-v1' as const,actor_id:actor.id,supplier_id:actor.supplierId,product_id:productId,
  product,attributes,skus,media,bounded:true as const};
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>SUPPLIER_PRODUCT_DETAIL_LIMITS.bytes)throw unavailable();
 await assertSupplierVideoAuthority(tx,actor,'supplier.product.view');return result;
}
export class SupplierProductDetailReadService {
 constructor(private readonly container:Container,private readonly appKey?:string){}
 async read(value:SupplierVideoActor,productId:number){
  if(!Number.isSafeInteger(productId)||productId<1||productId>2_147_483_647)throw new ValidateException('商品详情ID无效');
  const actor=Object.freeze({...value});
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await tx.execute(sql`SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','2000ms',true)`);
   return readSupplierProductDetailSnapshot(tx,actor,productId,this.appKey);
  });}catch(error){return readFailure(error);}
 }
}
