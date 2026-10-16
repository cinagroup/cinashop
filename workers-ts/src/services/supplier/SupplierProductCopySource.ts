import { and, asc, eq } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription, storeProductRelation, storeProductCoupon } from '@/models/schema';
import { ADMIN_LEGACY_PRODUCT_FIELDS } from '@/services/admin/AdminLegacyProductInput';
import { dimensions } from '@/services/admin/AdminLegacyProductReadService';
import { budgetLegacyProductRead } from '@/services/admin/AdminLegacyProductReadBudget';
import { productSaveCanonical, productSaveConflict } from '@/services/admin/AdminLegacyProductSaveState';
import { canonicalizePublishedAttachmentReference, canonicalizePublishedHtmlAttachmentReferences } from '@/services/content/ArticleContentPolicy';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { assertProductVideoReference } from '@/services/product/ProductVideoPolicy';
import { normalizeSupplierProductInput } from './SupplierProductManagementService';
import { prepareSupplierProductMediaInput } from './SupplierProductMediaService';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
import { legacyPhpJsonDecodeWire } from '@/utils/legacy-php-json';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

type Row = Record<string, unknown>;
export const SUPPLIER_COPY_FIELDS = ['id','product_type','store_name','store_info','keyword','unit_name','bar_code',
  'cate_id','slider_image','description','spec_type','items','attrs','freight','postage','temp_id','is_postage',
  'is_support_refund','is_limit','limit_type','limit_num','sort','ficti','video_link'] as const;
const SKU_FIELDS = ['suk','detail','image','price','settle_price','cost','ot_price','vip_price','stock','bar_code',
  'weight','volume','brokerage','brokerage_two','code','disk_info'];
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('复制商品须为JSON对象');
  return value as Row;
}
export function supplierCopyId(value: unknown): number {
  const n = typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new ValidateException('复制来源ID错误');
  return n;
}
export function supplierCopyEditable(value: unknown): Row {
  const row = object(value), keys = Object.keys(row);
  if (keys.some(key => !(SUPPLIER_COPY_FIELDS as readonly string[]).includes(key) && key !== 'store_label_id')
    || SUPPLIER_COPY_FIELDS.some(key => !Object.hasOwn(row,key)) || row.id !== 0 || typeof row.product_type !== 'number' || ![0,1,3].includes(row.product_type))
    throw new ValidateException('复制仅接受完整安全编辑字段与新商品ID0');
  if(!['cate_id','slider_image','items'].every(key=>Array.isArray(row[key]))
    ||Object.hasOwn(row,'store_label_id')&&(!Array.isArray(row.store_label_id)||row.store_label_id.length>100
      ||row.store_label_id.some(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<=0||id>2147483647)
      ||new Set(row.store_label_id).size!==row.store_label_id.length))throw new ValidateException('复制编辑选集格式错误');
  if (!Array.isArray(row.attrs) || !row.attrs.length || row.attrs.some(value => {
    const sku = object(value);
    return Object.keys(sku).some(key => !SKU_FIELDS.includes(key)) || sku.disk_info !== ''
      || row.product_type === 1 && sku.stock !== 0;
  })) throw new ValidateException('复制不能提交SKU身份、卡密、固定交付内容或卡密库存，请保存后独立配置');
  // Retain the actual Supplier editor's validated monetary/category/media limits.
  normalizeSupplierProductInput(prepareSupplierProductMediaInput(row));
  return row;
}
function csv(value: string | null): number[] {
  if (!value || value === '0') return [];
  const parts = value.split(',');
  if (parts.length > 256 || parts.some(p => !/^[1-9]\d{0,9}$/.test(p) || Number(p)>2147483647)
    || new Set(parts).size !== parts.length) throw productSaveConflict('来源商品关联集合无效，请先修复来源配置');
  return parts.map(Number);
}
function json(value: string | null): unknown {
  return value ? legacyPhpJsonDecodeWire(value, 512*1024) : [];
}
const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function time(value: number): string {
  if (!value) return '';
  const p = Object.fromEntries(formatter.formatToParts(new Date(value*1000)).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
/** No card table, card count or card credential is selected by this protocol.
 * Fixed delivery material enters only the opaque source MAC, never the seed. */
export async function readSupplierCopySource(tx: DbClient, sourceId: number, actor: SupplierVideoActor, appKey: string) {
  supplierCopyId(sourceId);
  if (!appKey) throw new ServiceUnavailableException('供应商复制签名尚未就绪');
  const owner = and(eq(storeProduct.id,sourceId),eq(storeProduct.type,2),eq(storeProduct.relationId,actor.supplierId));
  // Prove ownership before expanding private child collections.
  const [root] = await tx.select({id:storeProduct.id}).from(storeProduct).where(owner).limit(1);
  if (!root) throw new NotFoundException('复制来源不存在或不属于当前供应商');
  await budgetLegacyProductRead(tx,[{table:storeProduct,where:owner!},
    {table:storeProductAttr,where:and(eq(storeProductAttr.productId,sourceId),eq(storeProductAttr.type,0))!},
    {table:storeProductAttrValue,where:and(eq(storeProductAttrValue.productId,sourceId),eq(storeProductAttrValue.type,0))!},
    {table:storeProductDescription,where:and(eq(storeProductDescription.productId,sourceId),eq(storeProductDescription.type,0))!},
    {table:storeProductRelation,where:eq(storeProductRelation.productId,sourceId)},
    {table:storeProductCoupon,where:eq(storeProductCoupon.productId,sourceId)}]);
  const [product] = await tx.select().from(storeProduct).where(owner).limit(1);
  if (!product || ![0,1].includes(product.isDel) || ![0,1,3].includes(product.productType))
    throw productSaveConflict('来源状态或履约类型不支持供应商复制');
  const [attrs,skus,descriptions,relations,coupons] = await Promise.all([
    tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId,sourceId),eq(storeProductAttr.type,0))).orderBy(asc(storeProductAttr.id)),
    tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,sourceId),eq(storeProductAttrValue.type,0))).orderBy(asc(storeProductAttrValue.id)),
    tx.select().from(storeProductDescription).where(and(eq(storeProductDescription.productId,sourceId),eq(storeProductDescription.type,0))),
    tx.select().from(storeProductRelation).where(eq(storeProductRelation.productId,sourceId)).orderBy(asc(storeProductRelation.id)),
    tx.select().from(storeProductCoupon).where(eq(storeProductCoupon.productId,sourceId)).orderBy(asc(storeProductCoupon.id)),
  ]);
  if (descriptions.length>1 || skus.some(s=>![0,1].includes(s.isRetired)) || new Set(skus.map(s=>s.unique)).size!==skus.length)
    throw productSaveConflict('来源商品规格或描述不完整');
  const token = createHmac('sha256',appKey).update('cinashop.supplier-product-copy.source.v1\0')
    .update(productSaveCanonical({supplierId:actor.supplierId,actorId:actor.id,authVersion:actor.authVersion,product,attrs,skus,descriptions,relations,coupons})).digest('hex');
  const active = skus.filter(s=>s.isRetired===0);
  if (!active.length) throw productSaveConflict('来源没有可复制的有效SKU，请先修复来源');
  const dims = dimensions(product,attrs,active);
  const canonical = (value:string) => canonicalizePublishedAttachmentReference(value);
  const skuRows = active.map(s=>({suk:s.suk,detail:Object.fromEntries(dims.map((d,i)=>[d.value,s.suk.split(',')[i]])),
    image:canonical(s.image||product.image),price:s.price,settle_price:s.settlePrice,cost:s.cost,ot_price:s.otPrice,vip_price:s.vipPrice,
    stock:product.productType===1?0:s.stock,bar_code:s.barCode,weight:s.weight,volume:s.volume,brokerage:s.brokerage,
    brokerage_two:s.brokerageTwo,code:s.code,disk_info:''}));
  const ids = (type:number,fallback:number[]) => {
    const rows=relations.filter(r=>r.type===type), result=rows.length?rows.map(r=>r.relationId):fallback;
    if(result.some(id=>id<=0)||new Set(result).size!==result.length)throw productSaveConflict('来源关联存在重复或无效身份');
    return result;
  };
  const specRelations=ids(6,product.specsId?[product.specsId]:[]);
  if(specRelations.length>1)throw productSaveConflict('来源参数模板不唯一');
  const values:Row = Object.fromEntries(Object.entries(product).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v]));
  Object.assign(values,{supplier_id:actor.supplierId,cate_id:ids(1,csv(product.cateId)),brand_id:ids(2,product.brandCom?csv(product.brandCom):product.brandId?[product.brandId]:[]),
    store_label_id:ids(3,csv(product.storeLabelId)),label_id:ids(4,csv(product.labelId)),ensure_id:ids(5,csv(product.ensureId)),specs_id:specRelations[0]??0,
    slider_image:json(product.sliderImage),is_sub:[...(product.isVip===1?[0]:[]),...(product.isSub===1?[1]:[])],
    description:canonicalizePublishedHtmlAttachmentReferences(descriptions[0]?.description??''),
    items:product.specType===1?dims:[],attrs:skuRows.map(({image,...s})=>({...s,pic:image,virtual_list:[]})),
    recommend:[],activity:product.activity?product.activity.split(',').map(x=>({'1':'秒杀','2':'砍价','3':'拼团'}[x]??'默认')):[],
    coupon_ids:coupons.map(c=>c.issueCouponId),type:0,tao_words:'',soure_link:'',is_show:0,
    recommend_list:csv(product.recommendList),delivery_type:product.productType===0?[1]:[],
    presale_time:product.isPresaleProduct?[time(product.presaleStartTime),time(product.presaleEndTime)]:[],
    auto_on_time:time(product.autoOnTime),auto_off_time:time(product.autoOffTime),custom_form:json(product.customForm),specs:json(product.specs)});
  const body=Object.fromEntries(ADMIN_LEGACY_PRODUCT_FIELDS.map(k=>[k,values[k]]));
  // Every media slot, including hidden recommendation/HTML configuration, must
  // remain usable. Never turn a denied source image into an empty copied slot.
  const privateImages:string[]=[];
  const collect=(raw:string)=>{const ref=canonical(raw);if(ref.startsWith('/api/assets/'))privateImages.push(ref);return ref;};
  body.recommend_image=collect(String(body.recommend_image??''));
  if(!Array.isArray(body.slider_image))throw productSaveConflict('来源轮播图不是完整数组');
  body.slider_image=body.slider_image.map(value=>collect(String(value)));
  for(const sku of body.attrs as Row[])sku.pic=collect(String(sku.pic));
  body.description=canonicalizePublishedHtmlAttachmentReferences(String(body.description),ref=>{privateImages.push(ref);});
  if(privateImages.length){const allowed=await publicProductPictures(tx,privateImages.map(image=>({image,type:2,relationId:actor.supplierId})));
    if(allowed.some((ref,i)=>ref!==privateImages[i]))throw productSaveConflict('来源私有图片不可用于复制，请先替换来源素材');}
  try { body.video_link=await assertProductVideoReference(tx,String(body.video_link??''),{type:2,relationId:actor.supplierId}); }
  catch(cause){if(cause instanceof ValidateException)throw productSaveConflict('来源视频不可用于复制，请先替换来源视频');throw cause;}
  const safe:Row={id:0,product_type:product.productType,store_name:product.storeName,store_info:product.storeInfo,keyword:product.keyword,
    unit_name:product.unitName,bar_code:product.barCode,cate_id:body.cate_id,slider_image:body.slider_image,description:body.description,
    spec_type:product.specType,items:product.specType===1?dims:[],attrs:skuRows,freight:product.freight,postage:product.postage,temp_id:product.tempId,
    is_postage:product.isPostage,is_support_refund:product.isSupportRefund,is_limit:product.isLimit,limit_type:product.limitType,
    limit_num:product.limitNum,sort:product.sort,ficti:product.ficti,video_link:body.video_link,store_label_id:body.store_label_id,retired_attrs:[]};
  return {product,body,safe,token};
}
export function assertSupplierCopyToken(value: unknown, token: string): void {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)||!timingSafeEqual(new TextEncoder().encode(value),new TextEncoder().encode(token)))
    throw productSaveConflict('来源商品已变化，请保留编辑并重新载入复制来源');
}
export function overlaySupplierCopy(source: Awaited<ReturnType<typeof readSupplierCopySource>>, editable: Row): Row {
  if(editable.product_type!==source.product.productType)throw new ValidateException('复制不能切换来源履约类型');
  const output={...source.body};
  for(const key of SUPPLIER_COPY_FIELDS) if(!['id','product_type','attrs'].includes(key))output[key]=editable[key];
  if(Object.hasOwn(editable,'store_label_id'))output.store_label_id=editable.store_label_id;
  output.attrs=(editable.attrs as Row[]).map(({image,...sku})=>({...sku,pic:image,virtual_list:[]}));
  // A stored link can intentionally be disabled. Preserve the hidden switch
  // unless the user actually replaces or removes the editable reference.
  if(editable.video_link!==source.safe.video_link)output.video_open=output.video_link?1:0;
  return output;
}
