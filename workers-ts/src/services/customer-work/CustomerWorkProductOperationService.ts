import {and,eq,inArray} from 'drizzle-orm';
import type {Container} from '@/lib/di';
import {legacyCategory,storeProductLabel} from '@/models/schema';
import {applyMobileProductShow,applyMobileProductBatch,applyMobileProductSkus} from '@/services/product/MobileProductManagementCore';
import type {AdminProductSkuUpdate} from '@/services/admin/AdminMobileProductService';
import {ValidateException} from '@/utils/errors';
import {customerWorkId,type CustomerWorkActor} from './CustomerWorkScope';
import {CustomerWorkProductOperationRequest,customerProductExactKeys,type CustomerProductOperationContext,type CustomerProductOperationKind} from './CustomerWorkProductOperationRequest';

function payload(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidateException('商品操作内容无效');const raw=(value as Record<string,unknown>).payload;if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ValidateException('商品操作内容无效');return raw as Record<string,unknown>;}
function ids(value:unknown,allowEmpty=false){if(!Array.isArray(value)||value.length>50||!allowEmpty&&!value.length)throw new ValidateException('商品关联编号无效');let previous=0;return value.map(v=>{if(typeof v!=='number'||v<=previous)throw new ValidateException('商品关联编号须唯一排序');const id=customerWorkId(v,'关联');previous=id;return id;});}
function money(value:unknown){if(typeof value!=='string'||! /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(value))throw new ValidateException('商品价格须为两位小数字符串');return value;}
function skuUpdates(value:unknown):AdminProductSkuUpdate[]{if(!Array.isArray(value)||!value.length||value.length>500)throw new ValidateException('请选择有效规格');const seen=new Set<string>();return value.map(row=>{customerProductExactKeys(row,['unique','price','cost','ot_price','stock']);if(typeof row.unique!=='string'||!row.unique.length||row.unique.length>8||/[\u0000-\u001f\u007f]/.test(row.unique)||row.unique!==row.unique.trim()||seen.has(row.unique)||typeof row.stock!=='number'||!Number.isSafeInteger(row.stock)||row.stock<0||row.stock>2147483647)throw new ValidateException('商品规格编号或库存无效');seen.add(row.unique);return{unique:row.unique,price:money(row.price),cost:money(row.cost),otPrice:money(row.ot_price),stock:row.stock};});}
export class CustomerWorkProductOperationService {
 readonly requests:CustomerWorkProductOperationRequest;
 constructor(readonly container:Container){this.requests=new CustomerWorkProductOperationRequest(container);}
 async setShow(context:CustomerProductOperationContext,value:unknown){const p=payload(value);customerProductExactKeys(p,['is_show']);if(p.is_show!==0&&p.is_show!==1)throw new ValidateException('上下架状态无效');const isShow=p.is_show;
  return this.requests.execute('set_show',context,value,async(tx,_scope,states)=>applyMobileProductShow(tx,{ids:states.map(s=>s.product.id),isShow},async()=>undefined,{expectedTopology:states.map(s=>({productId:s.product.id,skus:s.skus,relations:s.relations}))}));
 }
 async batch(context:CustomerProductOperationContext,value:unknown){const p=payload(value),keys=Object.keys(p);let kind:CustomerProductOperationKind,relationIds:number[],type:1|2;if(keys.length===1&&keys[0]==='cate_id'){kind='replace_categories';type=1;relationIds=ids(p.cate_id);if(relationIds.join(',').length>64)throw new ValidateException('分类编号超过商品历史字段容量');}else if(keys.length===1&&keys[0]==='store_label_id'){kind='replace_labels';type=2;relationIds=ids(p.store_label_id,true);}else throw new ValidateException('商品批量操作仅接受分类或标签');
  return this.requests.execute(kind,context,value,async(tx,_scope,states)=>{
   if(type===2&&relationIds.length){const rows=await tx.select({id:storeProductLabel.id}).from(storeProductLabel).innerJoin(legacyCategory,eq(legacyCategory.id,storeProductLabel.labelCate)).where(and(inArray(storeProductLabel.id,relationIds),eq(legacyCategory.type,0),eq(legacyCategory.relationId,0),eq(legacyCategory.group,2),eq(legacyCategory.isShow,1)));if(rows.length!==relationIds.length)throw new ValidateException('标签分组不存在或不可用');}
   const result=await applyMobileProductBatch(tx,{type,ids:states.map(s=>s.product.id),relationIds},async()=>undefined,{catalogLocked:true,expectedTopology:states.map(s=>({productId:s.product.id,skus:s.skus,relations:s.relations}))});return{changed:result.changed,verified:true};
  });
 }
 async updateSkus(context:CustomerProductOperationContext,idValue:unknown,value:unknown){const id=customerWorkId(idValue,'商品'),p=payload(value);customerProductExactKeys(p,['attr_value']);const updates=skuUpdates(p.attr_value);
  if(!value||typeof value!=='object'||!Array.isArray((value as Record<string,unknown>).targets)||((value as {targets:unknown[]}).targets[0] as Record<string,unknown>|undefined)?.product_id!==id)throw new ValidateException('路径商品与操作目标不符');
  return this.requests.execute('update_skus',context,value,async(tx,_scope,states)=>{if(![0,1,2,3,4].includes(states[0].product.productType))throw new ValidateException('商品类型不支持快捷规格修改');const result=await applyMobileProductSkus(tx,id,updates,async()=>undefined,{customerStockPolicy:true,expectedBaseSkus:states[0].skus,expectedTopology:states.map(s=>({productId:s.product.id,skus:s.skus,relations:s.relations}))});return{changed:result.changed,verified:true};});
 }
 async outcome(actor:CustomerWorkActor,key:unknown){return{receipt:await this.requests.outcome(actor,key)};}
 async abandon(actor:CustomerWorkActor,key:string,value:unknown){customerProductExactKeys(value,['kind','input']);return{receipt:await this.requests.abandon(value.kind as CustomerProductOperationKind,{actor,request_key:key},value.input)};}
}
