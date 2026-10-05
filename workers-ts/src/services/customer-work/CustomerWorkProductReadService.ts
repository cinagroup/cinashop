import {and,asc,desc,eq,inArray,or,sql,type SQL} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import type {Env} from '@/env';
import {storeProduct,storeProductAttrValue,storeProductRelation,storeProductCategory,storeProductLabel,legacyCategory,systemStore,systemSupplier} from '@/models/schema';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {buildAdminProductCategoryTree} from '@/services/admin/AdminMobileProductService';
import {customerProductOperationReadiness} from '@/migrations/runCustomerProductOperation';
import {publicProductPictures,renderProductPictures,type ProductPicture} from '@/services/activity/ProductAssetPolicy';
import {seckillTimePicture} from '@/services/activity/SeckillTimeAssetPolicy';
import {AuthException,NotFoundException,ValidateException} from '@/utils/errors';
import {authorizeCustomerWorkActor,customerWorkId,type CustomerWorkActor,type CustomerWorkScope} from './CustomerWorkScope';
import {freezeCustomerActor} from './CustomerWorkOperationRequest';

export const CUSTOMER_PRODUCT_READ_VERSION='customer-work-product-read-v1' as const;
export const CUSTOMER_PRODUCT_SCOPES={products:'global',taxonomy:'platform',inventory:'active_base_skus'} as const;
type Product=typeof storeProduct.$inferSelect;
type Sku=typeof storeProductAttrValue.$inferSelect;
type Relation=typeof storeProductRelation.$inferSelect;
export interface CustomerProductState {product:Product;skus:Sku[];relations:Relation[];revision:string}
export function customerProductQuery(query:Record<string,string>,keys:readonly string[]){for(const key of Object.keys(query))if(key!=='scope_key'&&!keys.includes(key))throw new ValidateException(`商品工作台不支持查询参数：${key}`);if(query.scope_key!==undefined&&!/^[a-f0-9]{64}$/.test(query.scope_key))throw new ValidateException('商品管理身份指纹无效');}
function positive(value:string|undefined,fallback:number,max:number){if(value===undefined||value==='')return fallback;if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max)throw new ValidateException('商品分页无效');return Number(value);}
function money(value:string){if(!/^\d{1,10}\.\d{2}$/.test(value))throw new ValidateException('商品金额格式无效');return value;}
function ids(value:string|null){if(!value)return[];const values=value.split(',').map(Number);if(values.some(v=>!Number.isSafeInteger(v)||v<1||v>2147483647))throw new ValidateException('商品历史关联编号无效');return[...new Set(values)].sort((a,b)=>a-b);}
/** Preserve the complete read snapshot and mature owner checks while staying
 * within each shared picture query's declared capacity. */
async function customerProductPictures(db:DbClient,values:readonly ProductPicture[]){const result:string[]=[];for(let offset=0;offset<values.length;offset+=10000)result.push(...await publicProductPictures(db,values.slice(offset,offset+10000)));return result;}
/** Full base rows, including retirement topology and hidden card
 * inventory authority, are hashed. Only the digest crosses the public boundary. */
export async function readCustomerProductState(db:DbClient,id:number):Promise<CustomerProductState>{
 const[product]=await db.select().from(storeProduct).where(eq(storeProduct.id,id)).limit(1);if(!product)throw new NotFoundException('商品不存在');
 const[skus,relations]=await Promise.all([db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,id),eq(storeProductAttrValue.type,0))).orderBy(asc(storeProductAttrValue.id)),db.select().from(storeProductRelation).where(eq(storeProductRelation.productId,id)).orderBy(asc(storeProductRelation.id))]);
 const[versions]=await db.execute<{value:unknown}>(sql`SELECT jsonb_build_object('product',(SELECT xmin::text FROM store_product WHERE id=${id}),'skus',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,xmin::text) ORDER BY id),'[]'::jsonb) FROM store_product_attr_value WHERE product_id=${id} AND type=0),'relations',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,xmin::text) ORDER BY id),'[]'::jsonb) FROM store_product_relation WHERE product_id=${id})) AS value`);
 return{product,skus,relations,revision:await outRequestHash({version:'customer-product-revision-v1',product:JSON.parse(JSON.stringify(product)),skus:JSON.parse(JSON.stringify(skus)),relations:JSON.parse(JSON.stringify(relations)),versions:versions?.value})};
}
async function fingerprint(db:DbClient,tables:readonly string[]){
 const parts=tables.map(table=>sql.raw(`SELECT '${table}' AS kind,md5((to_jsonb(t)||jsonb_build_object('_xmin',t.xmin::text))::text) AS h FROM public."${table}" t`));
 const[row]=await db.execute<{value:unknown}>(sql`WITH facts AS(${sql.join(parts,sql` UNION ALL `)}), digests AS(SELECT kind,count(*)::text AS n,COALESCE(sum(('x'||substr(h,1,15))::bit(60)::bigint),0)::text AS a,COALESCE(sum(('x'||substr(h,17,15))::bit(60)::bigint),0)::text AS b,COALESCE(bit_xor(('x'||substr(h,1,16))::bit(64)::bigint),0)::text AS x FROM facts GROUP BY kind)SELECT COALESCE(jsonb_agg(jsonb_build_array(kind,n,a,b,x) ORDER BY kind),'[]'::jsonb) AS value FROM digests`);
 return outRequestHash({version:'customer-product-facts-v1',facts:row?.value});
}
export function customerProductCatalogRevision(db:DbClient){return fingerprint(db,['store_product_category','store_product_label','category']);}
function skuPolicy(state:CustomerProductState){const rows=state.skus.filter(s=>s.type===0&&s.isRetired===0);if(!rows.length)return'active_skus_missing';if(state.product.specType===0&&rows.length!==1)return'single_sku_ambiguous';if(rows.some(s=>!s.unique||s.unique!==s.unique.trim()||s.unique.length>8||/[\u0000-\u001f\u007f]/.test(s.unique)))return'invalid_sku_identity';if(new Set(rows.map(s=>s.unique)).size!==rows.length||new Set(rows.map(s=>s.suk)).size!==rows.length)return'duplicate_sku_identity';return'';}
function sku(row:Sku,product:Product){if([row.stock,row.sumStock,row.sales].some(v=>!Number.isSafeInteger(v)||v<0||v>2147483647))throw new ValidateException('当前规格库存或销量无效，请先修复原始数据');return{id:row.id,product_id:row.productId,unique:row.unique,suk:row.suk,price:money(row.price),cost:money(row.cost),ot_price:money(row.otPrice),stock:row.stock,sum_stock:row.sumStock,sales:row.sales,bar_code:row.barCode,image:row.image,stock_editable:!(product.productType===1&&!row.diskInfo)};}

export class CustomerWorkProductReadService {
 constructor(readonly container:Container,readonly env:Env){}
 private async snapshot<T extends object>(value:CustomerWorkActor,query:Record<string,string>,read:(db:DbClient,scope:CustomerWorkScope,ready:boolean)=>Promise<T>){
  const actor=freezeCustomerActor(value),result=await withTx(this.container,async db=>{
   await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await db.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
   const scope=await authorizeCustomerWorkActor(db,actor);if(query.scope_key!==undefined&&query.scope_key!==scope.scope_key)throw new AuthException('商品管理身份已变化，请重新读取');
   const readiness=await customerProductOperationReadiness(db),data=await read(db,scope,readiness.ready),catalog_revision=await customerProductCatalogRevision(db);
   const digest=await fingerprint(db,['store_product','store_product_attr_value','store_product_relation','store_product_category','store_product_label','category','system_store','system_supplier','system_attachment']);
   return{version:CUSTOMER_PRODUCT_READ_VERSION,actor_uid:actor.uid,principal:{kind:'customer-order-manager' as const,service_id:scope.service_id,scope:'global' as const},scope_key:scope.scope_key,consistency_key:await outRequestHash({version:CUSTOMER_PRODUCT_READ_VERSION,scope_key:scope.scope_key,digest,readiness:readiness.ready}),data:{...data,scopes:CUSTOMER_PRODUCT_SCOPES,catalog_revision,readiness:{writes:readiness.ready,reason:readiness.reason}}};
  });const fresh=await authorizeCustomerWorkActor(this.container.db,actor);if(fresh.scope_key!==result.scope_key)throw new AuthException('商品管理身份已变化，请重新读取');return result;
 }
 private async projection(db:DbClient,state:CustomerProductState,ready:boolean){
  const p=state.product,active=state.skus.filter(s=>s.type===0&&s.isRetired===0),policy=skuPolicy(state),stock=active.reduce((n,s)=>n+s.stock,0);if(!Number.isSafeInteger(stock)||stock<0||stock>2147483647)throw new ValidateException('基础规格库存超出允许范围');
  const categoryIds=ids(p.cateId),categories=categoryIds.length?await db.select({id:storeProductCategory.id,name:storeProductCategory.cateName}).from(storeProductCategory).where(inArray(storeProductCategory.id,categoryIds)):[];
  let plate_name='平台';if(p.type===1){const[s]=await db.select({name:systemStore.name}).from(systemStore).where(eq(systemStore.id,p.relationId)).limit(1);plate_name=`门店：${s?.name??''}`;}if(p.type===2){const[s]=await db.select({name:systemSupplier.supplierName}).from(systemSupplier).where(eq(systemSupplier.id,p.relationId)).limit(1);plate_name=`供应商：${s?.name??''}`;}
  const pictureInputs=[{image:p.image,type:p.type,relationId:p.relationId},...active.map(s=>({image:s.image,type:p.type,relationId:p.relationId}))],images=await customerProductPictures(db,pictureInputs);
  // Store static pictures are persisted public catalogue URLs. Uploaded asset
  // references retain the actual attachment owner gate; no synthetic owner.
  for(let i=0;i<images.length;i++)if(p.type===1&&!images[i]){try{const reference=seckillTimePicture(pictureInputs[i].image);if(!/^\/api\/assets(?:\/|$)/i.test(new URL(reference,'https://customer-product-picture.invalid').pathname))images[i]=reference;}catch{}}
  const rendered=await renderProductPictures(this.env.APP_KEY,images),projected=active.map((s,i)=>({...sku(s,p),image:rendered[i+1]}));
  const writable=ready&&p.isDel===0;
  return{id:p.id,type:p.type,relation_id:p.relationId,pid:p.pid,product_type:p.productType,store_name:p.storeName,image:rendered[0],plate_name,spec_type:p.specType,price:money(p.price),cost:money(p.cost),ot_price:money(p.otPrice),stock,branch_stock:stock,sales:p.sales,branch_sales:p.sales,is_show:p.isShow,is_verify:p.isVerify,is_police:p.isPolices,is_sold:p.isSold,cate_id:categoryIds,cate_name:categoryIds.map(id=>categories.find(c=>c.id===id)?.name??'').filter(Boolean).join(','),store_label_id:ids(p.storeLabelId),sku_count:active.length,attr_value:p.specType===0&&!policy?projected[0]:null,product_revision:state.revision,actions:{show:writable&&p.isVerify===1,hide:writable,categories:writable,labels:writable,skus:writable&&!policy},sku_policy:policy,skus:projected};
 }
 async list(actor:CustomerWorkActor,query:Record<string,string>={}){
  customerProductQuery(query,['page','limit','type','store_name']);const page=positive(query.page,1,1000000),limit=positive(query.limit,20,100),keyword=(query.store_name??'').trim(),status=query.type??'';if(keyword.length>100||/[\u0000-\u001f\u007f]/.test(keyword)||!['','1','2','4','5'].includes(status))throw new ValidateException('商品搜索或状态无效');
  return this.snapshot(actor,query,async(db,_scope,ready)=>{
   const filters:SQL[]=[eq(storeProduct.isDel,0)];if(status==='1')filters.push(eq(storeProduct.isShow,1),eq(storeProduct.isVerify,1));if(status==='2')filters.push(eq(storeProduct.isShow,0),eq(storeProduct.isVerify,1));if(status==='4')filters.push(eq(storeProduct.isVerify,1),sql`(${storeProduct.isSold}=1 OR ${storeProduct.stock}=0)`);if(status==='5')filters.push(eq(storeProduct.isShow,1),eq(storeProduct.isVerify,1),eq(storeProduct.isPolices,1),sql`${storeProduct.stock}>0`);
   if(keyword){const like=`%${keyword.replace(/[\\%_]/g,'\\$&')}%`;filters.push(or(sql`${storeProduct.id}::text LIKE ${like} ESCAPE '\\'`,sql`${storeProduct.storeName} LIKE ${like} ESCAPE '\\'`,sql`${storeProduct.keyword} LIKE ${like} ESCAPE '\\'`,sql`${storeProduct.storeInfo} LIKE ${like} ESCAPE '\\'`,sql`${storeProduct.barCode} LIKE ${like} ESCAPE '\\'`,sql`EXISTS(SELECT 1 FROM store_product_attr_value s WHERE s.product_id=${storeProduct.id} AND s.bar_code=${keyword})`)!);}
   const where=and(...filters),[rows,[count]]=await Promise.all([db.select({id:storeProduct.id}).from(storeProduct).where(where).orderBy(desc(storeProduct.sort),desc(storeProduct.id)).limit(limit).offset((page-1)*limit),db.select({count:sql<number>`count(*)::int`}).from(storeProduct).where(where)]);
   const list=[];for(const row of rows){const {skus:_skus,...product}=await this.projection(db,await readCustomerProductState(db,row.id),ready);list.push(product);}return{list,count:count.count,page,limit,has_more:(page-1)*limit+list.length<count.count};
  });
 }
 async categories(actor:CustomerWorkActor,query:Record<string,string>={}){customerProductQuery(query,[]);return this.snapshot(actor,query,async db=>{const rows=await db.select().from(storeProductCategory).where(and(eq(storeProductCategory.type,0),eq(storeProductCategory.relationId,0),eq(storeProductCategory.isShow,1))).orderBy(desc(storeProductCategory.sort),asc(storeProductCategory.id));const categories=buildAdminProductCategoryTree(rows);const refs=await customerProductPictures(db,rows.flatMap(r=>[{image:r.pic,type:0,relationId:0},{image:r.bigPic,type:0,relationId:0}])),rendered=await renderProductPictures(this.env.APP_KEY,refs),byId=new Map(rows.map((r,i)=>[r.id,{pic:rendered[i*2],big_pic:rendered[i*2+1]}]));const visit=(nodes:typeof categories)=>{for(const node of nodes){Object.assign(node,byId.get(node.id));visit(node.children);}};visit(categories);return{categories};});}
 async labels(actor:CustomerWorkActor,query:Record<string,string>={}){customerProductQuery(query,[]);return this.snapshot(actor,query,async db=>{const[groups,labels]=await Promise.all([db.select().from(legacyCategory).where(and(eq(legacyCategory.type,0),eq(legacyCategory.relationId,0),eq(legacyCategory.group,2),eq(legacyCategory.isShow,1))).orderBy(desc(legacyCategory.sort),asc(legacyCategory.id)),db.select().from(storeProductLabel).where(and(eq(storeProductLabel.type,0),eq(storeProductLabel.relationId,0),eq(storeProductLabel.status,1),eq(storeProductLabel.isShow,1))).orderBy(desc(storeProductLabel.sort),asc(storeProductLabel.id))]);const rendered=await renderProductPictures(this.env.APP_KEY,await customerProductPictures(db,labels.map(r=>({image:r.icon,type:0,relationId:0}))));return{labels:groups.map(g=>({id:g.id,label_name:g.name,children:labels.filter(l=>l.labelCate===g.id).map(l=>({id:l.id,label_name:l.labelName,color:l.color,bg_color:l.bgColor,border_color:l.borderColor,icon:rendered[labels.indexOf(l)]}))}))};});}
 async skus(actor:CustomerWorkActor,idValue:unknown,query:Record<string,string>={}){customerProductQuery(query,[]);const id=customerWorkId(idValue,'商品');return this.snapshot(actor,query,async(db,_scope,ready)=>{const state=await readCustomerProductState(db,id);if(state.product.isDel)throw new NotFoundException('商品不存在');const{skus,...product}=await this.projection(db,state,ready);return{product,skus};});}
}
