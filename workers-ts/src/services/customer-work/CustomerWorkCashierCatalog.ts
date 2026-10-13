import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeProduct, storeProductAttrValue } from '@/models/schema';
import { cashierSecondCardOriginReadiness } from '@/migrations/runCashierSecondCardOrigin';
import { cashierSecondCardFormImagesReadiness } from '@/migrations/runCashierSecondCardFormImages';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { loadActiveOrderSystemForm } from '@/services/order/OrderSystemFormService';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { authorizeCustomerWorkActor, customerWorkId, type CustomerWorkActor } from './CustomerWorkScope';
import { freezeCustomerActor } from './CustomerWorkOperationRequest';
import { cashierFormBaseReadiness } from './CustomerCashierFormImages';
import { cashierSecondCardAbandonReadiness } from '@/migrations/runCashierSecondCardAbandon';

export const CUSTOMER_CASHIER_CATALOG_VERSION = 'customer-cashier-catalog-v1' as const;
export function publicCashierSystemForm(form:Awaited<ReturnType<typeof loadActiveOrderSystemForm>>|null) {
  return form?{...form,value:form.value.map(component=>{const copy={...component};delete copy.assistedImageScope;delete copy.cashierImageScope;return copy;})}:null;
}
const productColumns = { id: storeProduct.id, storeName: storeProduct.storeName, image: storeProduct.image,
  type: storeProduct.type, relationId: storeProduct.relationId, systemFormId: storeProduct.systemFormId,stock:storeProduct.stock };
const eligibleProduct = and(eq(storeProduct.pid, 0), eq(storeProduct.productType, 4), eq(storeProduct.isShow, 1),
  eq(storeProduct.isVerify, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isPresaleProduct, 0),sql`${storeProduct.stock}>0`);
const eligibleSku = and(eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0),
  sql`${storeProductAttrValue.stock}>0`, sql`${storeProductAttrValue.writeTimes}>0`,
  sql`${storeProductAttrValue.writeValid} IN(1,2,3)`,
  sql`(${storeProductAttrValue.writeValid}=1 OR (${storeProductAttrValue.writeValid}=2 AND ${storeProductAttrValue.writeDays}>0)
    OR (${storeProductAttrValue.writeValid}=3 AND ${storeProductAttrValue.writeStart}>0 AND ${storeProductAttrValue.writeEnd}>${storeProductAttrValue.writeStart} AND ${storeProductAttrValue.writeEnd}>extract(epoch from now())::bigint))`);
function queryKeys(query: Record<string,string>, keys: string[]) {
  if (Object.keys(query).some(key => !['scope_key', ...keys].includes(key))) throw new ValidateException('收银选品查询参数无效');
  if (query.scope_key !== undefined && !/^[a-f0-9]{64}$/.test(query.scope_key)) throw new ValidateException('收银身份摘要无效');
}
function positive(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,6}$/.test(value) || Number(value)>maximum) throw new ValidateException('收银选品分页无效');
  return Number(value);
}
function text(value: string, maximum: number) {
  if (value.length>maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException('收银商品文字无效');
  return value;
}
function money(value: string) {
  if (!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(value)) throw new ValidateException('收银规格标价无效');
  return value;
}

/** Catalogue data only selects the real purchase intent. The established
 * preview and creation core remains the authority for current price/stock. */
export class CustomerWorkCashierCatalog {
  constructor(readonly container: Container, readonly env: Env) {}
  private async snapshot<T extends object>(value: CustomerWorkActor, query: Record<string,string>, read: (db: DbClient) => Promise<T>) {
    const actor=freezeCustomerActor(value),result=await withTx(this.container,async db=>{
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
      const scope=await authorizeCustomerWorkActor(db,actor);
      if(query.scope_key!==undefined&&query.scope_key!==scope.scope_key)throw new AuthException('收银经营资格已变化，请重新读取');
      const readiness=await cashierSecondCardOriginReadiness(db),base=await cashierFormBaseReadiness(db),abandon=await cashierSecondCardAbandonReadiness(db),facts=await read(db);
      const formReason='form_blocker' in facts&&typeof facts.form_blocker==='string'?facts.form_blocker:'';
      const {form_blocker:_reason,...projection}=facts as T & {form_blocker?:string};
      const data={...projection,readiness:{writes:readiness.ready&&base.ready&&abandon.ready&&!formReason,reason:readiness.reason||base.reason||abandon.reason||formReason}};
      return {version:CUSTOMER_CASHIER_CATALOG_VERSION,actor_uid:actor.uid,
        principal:{kind:'customer-order-manager' as const,service_id:scope.service_id,scope:'global' as const},scope_key:scope.scope_key,
        consistency_key:await outRequestHash({version:CUSTOMER_CASHIER_CATALOG_VERSION,scope_key:scope.scope_key,data}),data};
    });
    const fresh=await authorizeCustomerWorkActor(this.container.db,actor);
    if(fresh.scope_key!==result.scope_key)throw new AuthException('收银经营资格已变化，请重新读取');
    return result;
  }
  private async product(db:DbClient,row:typeof storeProduct.$inferSelect|{id:number;storeName:string;image:string;type:number;relationId:number;systemFormId:number}) {
    const [image]=await publicProductPictures(db,[{image:row.image,type:row.type,relationId:row.relationId}]);
    return {id:row.id,store_name:text(row.storeName,512),image,product_type:4 as const,system_form_id:row.systemFormId};
  }
  async list(actor:CustomerWorkActor,query:Record<string,string>={}) {
    queryKeys(query,['page','limit','keyword']);const page=positive(query.page,1,1000000),limit=positive(query.limit,20,50);
    const keyword=query.keyword??'';if(keyword.trim()!==keyword||keyword.length>100||/[\u0000-\u001f\u007f]/.test(keyword))throw new ValidateException('收银商品搜索无效');
    const result=await this.snapshot(actor,query,async db=>{
      const filters:SQL[]=[eligibleProduct!,sql`EXISTS(SELECT 1 FROM store_product_attr_value s WHERE s.product_id=${storeProduct.id} AND s.type=0 AND s.is_retired=0 AND s.stock>0 AND s.write_times>0 AND s.write_valid IN(1,2,3)
        AND(s.write_valid=1 OR(s.write_valid=2 AND s.write_days>0)OR(s.write_valid=3 AND s.write_start>0 AND s.write_end>s.write_start AND s.write_end>extract(epoch from now())::bigint)))`];
      if(keyword)filters.push(sql`${storeProduct.storeName} LIKE ${`%${keyword.replace(/[\\%_]/g,'\\$&')}%`} ESCAPE '\\'`);
      const rows=await db.select(productColumns).from(storeProduct).where(and(...filters)).orderBy(desc(storeProduct.sort),desc(storeProduct.id)).limit(limit+1).offset((page-1)*limit);
      const list=[];for(const row of rows.slice(0,limit)) {
        const [count]=await db.select({n:sql<number>`count(*)::int`}).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,row.id),eligibleSku));
        list.push({...await this.product(db,row),sku_count:count.n});
      }
      return {list,page,limit,has_more:rows.length>limit};
    });
    const images=await renderProductPictures(this.env.APP_KEY,result.data.list.map(p=>p.image));result.data.list.forEach((p,i)=>{p.image=images[i];});
    return result;
  }
  async selection(actor:CustomerWorkActor,idValue:unknown,query:Record<string,string>={}) {
    queryKeys(query,[]);const id=customerWorkId(idValue,'次卡商品');
    const result=await this.snapshot(actor,query,async db=>{
      const [row]=await db.select(productColumns).from(storeProduct).where(and(eq(storeProduct.id,id),eligibleProduct)).limit(1);
      if(!row)throw new NotFoundException('次卡商品已下架或不可购买');
      const values=await db.select({id:storeProductAttrValue.id,unique:storeProductAttrValue.unique,suk:storeProductAttrValue.suk,
        image:storeProductAttrValue.image,price:storeProductAttrValue.price,stock:storeProductAttrValue.stock,writeTimes:storeProductAttrValue.writeTimes,
        writeValid:storeProductAttrValue.writeValid,writeDays:storeProductAttrValue.writeDays,writeStart:storeProductAttrValue.writeStart,writeEnd:storeProductAttrValue.writeEnd})
        .from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,id),eligibleSku)).orderBy(asc(storeProductAttrValue.id)).limit(501);
      if(!values.length)throw new NotFoundException('次卡规格已售罄或失效');
      if(values.length>500)throw new ValidateException('次卡规格超过完整选品容量');
      const pictures=await publicProductPictures(db,values.map(v=>({image:v.image,type:row.type,relationId:row.relationId})));
      const skus=values.map((v,i)=>({sku_unique:text(v.unique,16),sku:text(v.suk,512),image:pictures[i],price:money(v.price),stock:Math.min(v.stock,row.stock,32767),
        write_times:v.writeTimes,write_valid:v.writeValid as 1|2|3,write_days:v.writeDays,write_start:v.writeStart,write_end:v.writeEnd}));
      if(new Set(skus.map(v=>v.sku_unique)).size!==skus.length||skus.some(v=>!v.sku_unique))throw new ValidateException('次卡规格身份不唯一');
      const form=row.systemFormId>0?await loadActiveOrderSystemForm(db,row.systemFormId):null;
      let system_form=publicCashierSystemForm(form);
      let form_blocker='';
      if(system_form&&new TextEncoder().encode(JSON.stringify(system_form)).byteLength>65536){form_blocker='cashier_form_capacity_exceeded';system_form=null;}
      if(system_form?.value.some(component=>{const required=component.titleShow as Record<string,unknown>|undefined;
        return component.name==='uploadPicture'&&[true,1,'1'].includes(required?.val as boolean|number|string);})&&!(await cashierSecondCardFormImagesReadiness(db)).ready)form_blocker='cashier_form_upload_scope_unavailable';
      return {product:await this.product(db,row),skus,system_form,form_blocker};
    });
    const pictures=await renderProductPictures(this.env.APP_KEY,[result.data.product.image,...result.data.skus.map(v=>v.image)]);
    result.data.product.image=pictures[0];result.data.skus.forEach((v,i)=>{v.image=pictures[i+1];});return result;
  }
}
