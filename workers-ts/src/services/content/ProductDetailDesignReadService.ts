import { sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemDise } from '@/models/schema';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { categoryStyleNumbersExact } from './ProductCategoryStyleReadService';
import { DISE_TEMPLATE_TRIM_CHARACTERS, themeDeadlines, themeHash } from './ThemeReadService';
import { cloneProductDetailDesign, isProductDetailDesignValue, PRODUCT_DETAIL_DESIGN_KEYS, type ProductDetailDesignSnapshot } from '../../../../view/common/productDetailDesign';

export const PRODUCT_DETAIL_TEMPLATE_NAME = 'product_detail';
export const PRODUCT_DETAIL_MAX_VALUE_BYTES = 1_048_576;
/** Reject duplicate keys/prototype keys and numeric loss, while retaining every
 * safe opaque extension in storage. The public API only projects PHP's keys. */
export function decodeProductDetailDesign(value: string | null): Record<string, unknown> | null {
  try {
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > PRODUCT_DETAIL_MAX_VALUE_BYTES || !categoryStyleNumbersExact(value)) return null;
    const parsed = parseLevelActivationJson(value);
    let nodes=0;
    const safe=(node:unknown,depth=0):boolean=>{
      if(++nodes>10000||depth>32)return false;
      if(!node||typeof node!=='object')return true;
      if(Array.isArray(node))return node.every(value=>safe(value,depth+1));
      return Object.entries(node).every(([key,value])=>!['__proto__','prototype','constructor'].includes(key)&&safe(value,depth+1));
    };
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)&&safe(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
export function mergeProductDetailDesign(saved: Record<string, unknown> | null) {
  const value = cloneProductDetailDesign();
  if (saved) for (const key of PRODUCT_DETAIL_DESIGN_KEYS) if (Object.hasOwn(saved,key)) Object.assign(value,{[key]:saved[key]});
  return value;
}
export async function productDetailDesignCatalog(tx: DbClient) {
  const rows = await tx.select({ id:systemDise.id,templateName:systemDise.templateName,type:systemDise.type,isDel:systemDise.isDel,
    status:systemDise.status,isShow:systemDise.isShow,version:systemDise.version,updateTime:systemDise.updateTime,
    value:sql<string|null>`CASE WHEN octet_length(${systemDise.value})<=${PRODUCT_DETAIL_MAX_VALUE_BYTES} THEN ${systemDise.value} ELSE NULL END`,
    valueBytes:sql<number|null>`octet_length(${systemDise.value})`,xmin:sql<string>`xmin::text` })
    .from(systemDise).where(sql`lower(btrim(${systemDise.templateName},${DISE_TEMPLATE_TRIM_CHARACTERS}))=${PRODUCT_DETAIL_TEMPLATE_NAME}`).orderBy(systemDise.id).limit(3);
  return {rows,revision:await themeHash({template:PRODUCT_DETAIL_TEMPLATE_NAME,type:3,rows})};
}
export function projectProductDetailDesign(catalog:Awaited<ReturnType<typeof productDetailDesignCatalog>>):ProductDetailDesignSnapshot {
  const snapshot:ProductDetailDesignSnapshot={revision:catalog.revision,value:null,configured:false,editable:false,issues:[]};
  if (!catalog.rows.length) return {...snapshot,value:cloneProductDetailDesign(),editable:true,issues:['product_detail_missing']};
  if(catalog.rows.length!==1)return {...snapshot,issues:['product_detail_duplicate']};
  const row=catalog.rows[0];
  if(row.id<=0||row.templateName!==PRODUCT_DETAIL_TEMPLATE_NAME||row.type!==3||row.isDel!==0)return {...snapshot,issues:['product_detail_identity_invalid']};
  const saved=decodeProductDetailDesign(row.value),value=mergeProductDetailDesign(saved);
  if(!saved||!isProductDetailDesignValue(value))return {...snapshot,configured:true,issues:['product_detail_value_invalid']};
  return {...snapshot,value,configured:true,editable:true};
}
/** Does not start a transaction: detail readers use their own RR snapshot. */
export async function readProductDetailDesignSnapshot(tx:DbClient){return projectProductDetailDesign(await productDetailDesignCatalog(tx));}
export function publicProductDetailDesign(snapshot:ProductDetailDesignSnapshot){
  return {revision:snapshot.revision,value:cloneProductDetailDesign(snapshot.value??undefined),configured:snapshot.configured,issues:[...snapshot.issues]};
}
export class ProductDetailDesignReadService{
  constructor(private readonly container:Container){}
  read(){return withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);return readProductDetailDesignSnapshot(tx);});}
}
