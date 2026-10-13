import { and,asc,eq,inArray,or } from 'drizzle-orm';
import { withTx,type Container,type DbClient } from '@/lib/di';
import { storeOrder,storeOrderCartInfo,storeOrderRefund,systemStore } from '@/models/schema';
import type { ErpOperationScope } from '@/models/erp';
import { ForbiddenException } from '@/utils/errors';
import { erpObject,erpUniqueJson,type ErpCallbackInput,type ErpItem } from './ErpInput';
import { erpBinding,erpConflict,erpDeadlines } from './ErpConnectionPolicy';
import { ErpOperationService,type ErpRuntimeSnapshot } from './ErpOperationService';
import type { ErpObservedOrder } from './ErpProviderFacts';

export type ErpOrderRow=typeof storeOrder.$inferSelect;
export type ErpCartRow=typeof storeOrderCartInfo.$inferSelect;
export interface ErpOrderPreflight {rootId:number;shopIds:number[];mappedIds:number[];refundId?:number}
export interface ErpOrderPlan {order:ErpOrderRow;root:ErpOrderRow;carts:ErpCartRow[];selected:Array<{row:ErpCartRow;quantity:number;code:string}>;
  scope:ErpOperationScope;providerShopId:number}
export function erpCartIdentity(row:ErpCartRow):{code:string;unique:string}{
  const snapshot=erpObject(erpUniqueJson(row.cartInfo??'')),product=erpObject(snapshot.productInfo),attr=erpObject(product.attrInfo);
  if(typeof attr.code!=='string'||!attr.code||attr.code.length>50)throw erpConflict('ERP 商品快照缺少真实编码');
  const stored=snapshot.product_attr_unique;
  const unique=row.skuUnique||((typeof stored==='string'||typeof stored==='number'&&Number.isSafeInteger(stored))?String(stored):'');
  if(!unique||unique.length>128||(row.skuUnique&&stored!==undefined&&String(stored)!==row.skuUnique))throw erpConflict('ERP 商品快照规格身份不一致');
  return {code:attr.code,unique};
}
async function shop(tx:DbClient,snapshot:ErpRuntimeSnapshot,order:ErpOrderRow):Promise<number>{
  let providerShopId=snapshot.config.defaultShopId;
  if(order.storeId>0){const [store]=await tx.select().from(systemStore).where(eq(systemStore.id,order.storeId)).limit(1);
    if(!store||store.isDel!==0||store.isShow!==1||store.erpShopId<=0)throw new ForbiddenException('ERP 门店状态已变化');providerShopId=store.erpShopId;}
  erpBinding(snapshot.connection,providerShopId,order.storeId,order.supplierId);return providerShopId;
}
export class ErpOrderScopeService {
  constructor(private readonly container:Container,private readonly operations:ErpOperationService){}
  async preflight(snapshot:ErpRuntimeSnapshot,input:Exclude<ErpCallbackInput,{kind:'stock'}>):Promise<ErpOrderPreflight>{
    return withTx(this.container,async tx=>{
      await erpDeadlines(tx);await this.operations.recheck(tx,snapshot);
      const mapped=await tx.select().from(storeOrder).where(and(eq(storeOrder.erpOrderId,input.orderId),eq(storeOrder.isSystemDel,0),eq(storeOrder.isDel,0),eq(storeOrder.paid,1)))
        .orderBy(asc(storeOrder.id)).limit(201);
      if(!mapped.length||mapped.length>200)throw new ForbiddenException('ERP 订单无法唯一定位');
      const roots=[...new Set(mapped.map(row=>row.pid>0?row.pid:row.id))];if(roots.length!==1)throw erpConflict('ERP 订单映射跨越实际支付父单');
      const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,roots[0])).limit(1);
      if(!root||root.isDel!==0||root.isSystemDel!==0||root.paid!==1||mapped.some(row=>row.uid!==root.uid))throw erpConflict('ERP 支付父单身份不一致');
      const shopIds:number[]=[];for(const row of mapped){const providerShopId=await shop(tx,snapshot,row);if(!shopIds.includes(providerShopId))shopIds.push(providerShopId);}
      let refundId:number|undefined;
      if(input.kind==='refund-receive'){
        if(!shopIds.includes(input.shopId))throw new ForbiddenException('ERP 售后店铺不属于该连接');
        const refunds=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.orderId,input.refundNo)).limit(2);
        if(refunds.length!==1||refunds[0].uid!==root.uid||refunds[0].isDel!==0||refunds[0].isCancel!==0)throw new ForbiddenException('ERP 售后记录不属于该订单');
        const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,refunds[0].storeOrderId)).limit(1);
        if(!order||(order.pid>0?order.pid:order.id)!==root.id||await shop(tx,snapshot,order)!==input.shopId)throw new ForbiddenException('ERP 售后记录跨越实际订单范围');
        refundId=refunds[0].id;
      }
      return {rootId:root.id,shopIds:shopIds.sort((a,b)=>a-b),mappedIds:mapped.map(row=>row.id),...(refundId?{refundId}:{})};
    });
  }
  async plan(snapshot:ErpRuntimeSnapshot,input:Exclude<ErpCallbackInput,{kind:'stock'}>,preflight:ErpOrderPreflight,observed:ErpObservedOrder[],items:ErpItem[]):Promise<ErpOrderPlan>{
    return withTx(this.container,async tx=>{
      await erpDeadlines(tx);await this.operations.recheck(tx,snapshot);
      const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,preflight.rootId)).limit(1);
      if(!root||root.uid<0||root.paid!==1||root.isDel!==0||root.isSystemDel!==0)throw erpConflict('ERP 支付父单状态已变化');
      const orders=await tx.select().from(storeOrder).where(or(eq(storeOrder.id,root.id),eq(storeOrder.pid,root.id))).orderBy(asc(storeOrder.id)).limit(201);
      if(orders.length>200)throw erpConflict('ERP 订单履约分支超限');
      const eligible=orders.filter(row=>row.uid===root.uid&&row.paid===1&&row.isDel===0&&row.isSystemDel===0&&row.pid!==-1&&row.status===0&&row.refundStatus<2&&row.productType===0);
      const carts=eligible.length?await tx.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid,eligible.map(row=>row.id))).orderBy(asc(storeOrderCartInfo.id)).limit(1001):[];
      if(carts.length>1000||!items.length||items.length>200)throw erpConflict('ERP 商品范围无法核对');
      const selected:Array<{row:ErpCartRow;quantity:number;code:string}>=[];
      for(const item of items){
        const matched=carts.filter(row=>{if(row.uid!==root.uid||row.productType!==0||row.splitStatus>=2||row.splitSurplusNum<=0)return false;
          const identity=erpCartIdentity(row);return identity.code===item.code&&(!item.externalRowId||identity.unique===item.externalRowId);});
        if(matched.length!==1||matched[0].splitSurplusNum<item.quantity||matched[0].cartNum<item.quantity||selected.some(row=>row.row.id===matched[0].id))throw erpConflict('ERP 商品行无法唯一核对或数量越界');
        selected.push({row:matched[0],quantity:item.quantity,code:item.code});
      }
      const ids=[...new Set(selected.map(row=>row.row.oid))];if(ids.length!==1)throw erpConflict('ERP 本批跨越多个履约主体，需分别核对');
      const order=eligible.find(row=>row.id===ids[0])!;const providerShopId=await shop(tx,snapshot,order);
      if(!observed.some(row=>row.shopId===providerShopId))throw erpConflict('ERP 当前店铺事实与本地订单不一致');
      if(!orders.some(row=>preflight.mappedIds.includes(row.id)&&row.erpOrderId===input.orderId))throw erpConflict('ERP 原始订单映射已变化');
      const orderCarts=carts.filter(row=>row.oid===order.id);
      return {order,root,carts:orderCarts,selected,providerShopId,scope:{providerShopId,storeId:order.storeId,supplierId:order.supplierId,customerUid:order.uid,
        rootOrderId:root.id,activeOrderId:order.id,cartRows:selected.map(row=>({id:row.row.id,quantity:row.quantity,code:row.code}))}};
    });
  }
}
