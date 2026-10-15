import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeProduct, storeProductAttrValue, user, userAddress } from '@/models/schema';
import { ValidateException, NotFoundException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { loadActiveOrderSystemForm } from '@/services/order/OrderSystemFormService';
import { cashierOrdinaryReadiness } from '@/migrations/runCashierOrdinary';
import type { CustomerWorkActor } from './CustomerWorkScope';
import { ordinaryCashierInteger, ordinaryCashierText } from './CustomerOrdinaryCashierContract';
import { withOrdinaryCashierRead } from './CustomerWorkOrdinaryCashierService';
import { publicOrdinaryCashierForm } from './CustomerOrdinaryCashierForm';
import { assertOrdinaryBuyer } from './CustomerOrdinaryCashierLedger';

const columns = { id: storeProduct.id, storeName: storeProduct.storeName, image: storeProduct.image, type: storeProduct.type,
  relationId: storeProduct.relationId, systemFormId: storeProduct.systemFormId, stock: storeProduct.stock };
const productFilter = and(eq(storeProduct.pid,0),eq(storeProduct.productType,0),eq(storeProduct.isShow,1),eq(storeProduct.isVerify,1),
  eq(storeProduct.isDel,0),eq(storeProduct.isPresaleProduct,0),sql`${storeProduct.stock}>0`);
const skuFilter = and(eq(storeProductAttrValue.type,0),eq(storeProductAttrValue.isRetired,0),sql`${storeProductAttrValue.stock}>0`);
function query(value:Record<string,string>,keys:readonly string[]) {
  if(Object.keys(value).some(key=>key!=='scope_key'&&!keys.includes(key))||value.scope_key!==undefined&&!/^[a-f0-9]{64}$/.test(value.scope_key))
    throw new ValidateException('普通收银读取参数无效');
}
function integer(value:string|undefined,fallback:number,maximum:number) {
  if(value===undefined)return fallback;
  if(!/^(0|[1-9]\d*)$/.test(value))throw new ValidateException('普通收银分页或编号无效');
  return ordinaryCashierInteger(Number(value),fallback===0,maximum);
}
function money(value:string){if(!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(value))throw new ValidateException('收银规格实际金额无效');return value;}
function keyword(value:string|undefined){return ordinaryCashierText(value??'',100,true);}
function pattern(value:string){return `%${value.replace(/[\\%_]/g,'\\$&')}%`;}
async function readiness(db:DbClient){const state=await cashierOrdinaryReadiness(db);return{writes:state.ready,reason:state.reason};}
export class CustomerWorkOrdinaryCashierReadService {
  constructor(readonly container:Container,readonly env:Env){}
  async catalog(actor:CustomerWorkActor,q:Record<string,string>={}) {
    query(q,['page','limit','keyword']);const page=integer(q.page,1,1000000),limit=integer(q.limit,20,50),search=keyword(q.keyword);
    const result=await withOrdinaryCashierRead(this.container,actor,q.scope_key,async db=>{
      const filters:SQL[]=[productFilter!,sql`EXISTS(SELECT 1 FROM store_product_attr_value s WHERE s.product_id=${storeProduct.id} AND s.type=0 AND s.is_retired=0 AND s.stock>0)`];
      if(search)filters.push(sql`${storeProduct.storeName} LIKE ${pattern(search)} ESCAPE '\\'`);
      const rows=await db.select(columns).from(storeProduct).where(and(...filters)).orderBy(desc(storeProduct.sort),desc(storeProduct.id)).limit(limit+1).offset((page-1)*limit);
      const pictures=await publicProductPictures(db,rows.slice(0,limit).map(row=>({image:row.image,type:row.type,relationId:row.relationId})));
      const list=await Promise.all(rows.slice(0,limit).map(async(row,index)=>{
        const[count]=await db.select({n:sql<number>`count(*)::int`}).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,row.id),skuFilter));
        return{id:row.id,store_name:ordinaryCashierText(row.storeName,512),image:pictures[index],product_type:0 as const,system_form_id:row.systemFormId,sku_count:count.n};
      }));
      return{list,page,limit,has_more:rows.length>limit,readiness:await readiness(db)};
    });
    const pictures=await renderProductPictures(this.env.APP_KEY,result.data.list.map(p=>p.image));result.data.list.forEach((p,i)=>{p.image=pictures[i];});
    result.consistency_key=await outRequestHash({scope_key:result.scope_key,data:result.data});return result;
  }
  async selection(actor:CustomerWorkActor,idValue:unknown,q:Record<string,string>={}) {
    query(q,[]);const id=typeof idValue==='string'&&/^[1-9]\d*$/.test(idValue)?ordinaryCashierInteger(Number(idValue)):ordinaryCashierInteger(idValue);
    const result=await withOrdinaryCashierRead(this.container,actor,q.scope_key,async db=>{
      const[row]=await db.select(columns).from(storeProduct).where(and(eq(storeProduct.id,id),productFilter)).limit(1);
      if(!row)throw new NotFoundException('普通商品已下架或售罄');
      const values=await db.select({id:storeProductAttrValue.id,unique:storeProductAttrValue.unique,suk:storeProductAttrValue.suk,image:storeProductAttrValue.image,
        price:storeProductAttrValue.price,stock:storeProductAttrValue.stock}).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,id),skuFilter)).orderBy(asc(storeProductAttrValue.id)).limit(501);
      if(!values.length||values.length>500||new Set(values.map(v=>v.unique)).size!==values.length)throw new ValidateException('普通规格失效、重复或超过完整选品容量');
      const pictures=await publicProductPictures(db,[{image:row.image,type:row.type,relationId:row.relationId},...values.map(v=>({image:v.image,type:row.type,relationId:row.relationId}))]);
      return{product:{id:row.id,store_name:ordinaryCashierText(row.storeName,512),image:pictures[0],product_type:0 as const,system_form_id:row.systemFormId},
        skus:values.map((v,i)=>({sku_unique:ordinaryCashierText(v.unique,16),sku:ordinaryCashierText(v.suk,512,true),image:pictures[i+1],price:money(v.price),stock:Math.min(v.stock,row.stock,32767)})),
        system_form:row.systemFormId>0?publicOrdinaryCashierForm(await loadActiveOrderSystemForm(db,row.systemFormId)):null,readiness:await readiness(db)};
    });
    const pictures=await renderProductPictures(this.env.APP_KEY,[result.data.product.image,...result.data.skus.map(s=>s.image)]);
    result.data.product.image=pictures[0];result.data.skus.forEach((s,i)=>{s.image=pictures[i+1];});
    result.consistency_key=await outRequestHash({scope_key:result.scope_key,data:result.data});return result;
  }
  users(actor:CustomerWorkActor,q:Record<string,string>={}) {
    query(q,['page','limit','keyword']);const page=integer(q.page,1,1000000),limit=integer(q.limit,20,50),search=keyword(q.keyword);
    return withOrdinaryCashierRead(this.container,actor,q.scope_key,async db=>{
      const filters:SQL[]=[eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime),sql`${user.uid}>0`];
      if(search)filters.push(sql`(${user.nickname} LIKE ${pattern(search)} ESCAPE '\\' OR ${user.phone} LIKE ${pattern(search)} ESCAPE '\\' OR ${user.uid}::text=${search})`);
      const rows=await db.select({uid:user.uid,nickname:user.nickname,phone:user.phone,integral:user.integral,nowMoney:user.nowMoney}).from(user).where(and(...filters)).orderBy(desc(user.uid)).limit(limit+1).offset((page-1)*limit);
      return{list:rows.slice(0,limit).map(row=>({uid:ordinaryCashierInteger(row.uid),nickname:ordinaryCashierText(row.nickname,255,true),phone:ordinaryCashierText(row.phone,20,true),
        integral:ordinaryCashierInteger(row.integral,true),now_money:money(row.nowMoney)})),page,limit,has_more:rows.length>limit};
    });
  }
  addresses(actor:CustomerWorkActor,uidValue:unknown,q:Record<string,string>={}) {
    query(q,[]);const uid=typeof uidValue==='string'&&/^[1-9]\d*$/.test(uidValue)?ordinaryCashierInteger(Number(uidValue)):ordinaryCashierInteger(uidValue);
    return withOrdinaryCashierRead(this.container,actor,q.scope_key,async db=>{
      await assertOrdinaryBuyer(db,uid);
      const rows=await db.select().from(userAddress).where(and(eq(userAddress.uid,uid),eq(userAddress.isDel,0))).orderBy(desc(userAddress.isDefault),desc(userAddress.id)).limit(201);
      if(rows.length>200)throw new ValidateException('会员地址簿超过完整选择容量');
      return{buyer_uid:uid,list:rows.map(r=>({id:r.id,real_name:r.realName,phone:r.phone,province:r.province,city:r.city,district:r.district,street:r.street,detail:r.detail,
        city_id:r.cityId,is_default:r.isDefault===1}))};
    });
  }
}
