import { ServiceUnavailableException } from '@/utils/errors';
import { erpInteger,erpObject,erpText,type ErpCallbackInput,type ErpItem } from './ErpInput';
import { erpCanonical } from './ErpProtocol';
import { ErpProviderClient } from './ErpProviderPolicy';
import type { ErpRuntimeSnapshot } from './ErpOperationService';

export interface ErpObservedOrder {providerOrderId:number;orderId:string;shopId:number;status:string;version:string;
  logisticsId:string;logisticsCompany:string;logisticsCode:string;items:Array<ErpItem&{status:string;skuUnique:string}>}
export interface ErpObservedStock {code:string;quantity:number;orderLock:number;version:string;extras:Record<string,number|null>;supported:boolean;available:number}
export interface ErpObservedReturn {receiptId:number;providerOrderId:number;orderId:string;shopId:number;afterSaleId:number;status:string;version:string;items:ErpItem[]}
const unavailable=()=>new ServiceUnavailableException('ERP 供应商事实不完整，请稍后核对');
const now=()=>Math.floor(Date.now()/1000);
function boundedRows(value:unknown,max:number):unknown[]{if(!Array.isArray(value)||!value.length||value.length>max)throw unavailable();return value;}
function version(row:Record<string,unknown>):string{
  if(typeof row.ts==='number'&&Number.isSafeInteger(row.ts)&&row.ts>0)return String(row.ts);
  return erpText(row.modified,'ERP 事实版本',64);
}
function projectedItem(value:unknown):ErpItem{
  const row=erpObject(value);return {code:erpText(row.sku_id,'ERP SKU',50),quantity:erpInteger(row.qty,'ERP 商品数量',1,32767),
    externalRowId:row.outer_oi_id===null||row.outer_oi_id===undefined?'':erpText(row.outer_oi_id,'ERP 商品来源',50,true),
    sourceOrderId:row.raw_so_id===null||row.raw_so_id===undefined?'':erpText(row.raw_so_id,'ERP 来源订单',128,true)};
}
export function projectErpOrders(data:Record<string,unknown>,expectedOrderId:string):ErpObservedOrder[]{
  if(data.has_next!==false)throw unavailable();const rows=boundedRows(data.orders,100).map(value=>{
    const row=erpObject(value),status=erpText(row.status,'ERP 订单状态',32),orderId=erpText(row.so_id,'ERP 订单标识',128);
    if(orderId!==expectedOrderId)throw unavailable();
    const items=boundedRows(row.items,200).map(item=>{const raw=erpObject(item),projected=projectedItem(item);return {...projected,
      status:raw.item_status===null||raw.item_status===undefined?status:erpText(raw.item_status,'ERP 商品状态',32),skuUnique:projected.externalRowId};});
    if(new Set(items.map(item=>erpCanonical([item.code,item.externalRowId]))).size!==items.length)throw unavailable();
    return {providerOrderId:erpInteger(row.o_id,'ERP 内部订单'),orderId,shopId:erpInteger(row.shop_id,'ERP 店铺'),status,version:version(row),
      logisticsId:row.l_id===null||row.l_id===undefined?'':erpText(row.l_id,'ERP 物流单号',64,true),
      logisticsCompany:row.logistics_company===null||row.logistics_company===undefined?'':erpText(row.logistics_company,'ERP 物流公司',64,true),
      logisticsCode:row.lc_id===null||row.lc_id===undefined?'':erpText(row.lc_id,'ERP 物流编码',50,true),items};
  });
  if(new Set(rows.map(row=>row.providerOrderId)).size!==rows.length)throw unavailable();return rows.sort((a,b)=>a.providerOrderId-b.providerOrderId);
}
export function projectErpStocks(data:Record<string,unknown>,expectedCodes:readonly string[]):ErpObservedStock[]{
  if(data.has_next!==false)throw unavailable();const rows=boundedRows(data.inventorys,100).map(value=>{
    const row=erpObject(value),code=erpText(row.sku_id,'ERP SKU',50),quantity=erpInteger(row.qty,'ERP 实物库存',0),orderLock=erpInteger(row.order_lock,'ERP 订单锁库存',0);
    if(!expectedCodes.includes(code))throw unavailable();
    const extras:Record<string,number|null>={};
    for(const key of ['virtual_qty','purchase_qty','in_qty','return_qty','lock_qty','customize_qty_1','customize_qty_2','customize_qty_3']){
      extras[key]=typeof row[key]==='number'&&Number.isSafeInteger(row[key])&&Math.abs(row[key])<=2147483647?row[key] as number:null;
    }
    return {code,quantity,orderLock,version:version(row),extras,supported:Object.values(extras).every(value=>value===0)&&quantity>=orderLock,available:quantity-orderLock};
  });
  if(new Set(rows.map(row=>row.code)).size!==rows.length||expectedCodes.some(code=>!rows.some(row=>row.code===code)))throw unavailable();
  return rows.sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0);
}
export function projectErpReturns(data:Record<string,unknown>,expected:{orderId:string;providerOrderId:number;shopId:number;afterSaleId:number}):ErpObservedReturn[]{
  if(data.has_next!==false)throw unavailable();const rows=boundedRows(data.datas,50).map(value=>{
    const row=erpObject(value),result={receiptId:erpInteger(row.io_id,'ERP 退仓标识'),providerOrderId:erpInteger(row.o_id,'ERP 内部订单'),orderId:erpText(row.so_id,'ERP 订单标识',128),
      shopId:erpInteger(row.shop_id,'ERP 店铺'),afterSaleId:erpInteger(row.as_id,'ERP 售后标识'),status:erpText(row.status,'ERP 退仓状态',32),version:version(row),items:boundedRows(row.items,200).map(projectedItem)};
    if(result.orderId!==expected.orderId||result.providerOrderId!==expected.providerOrderId||result.shopId!==expected.shopId||result.afterSaleId!==expected.afterSaleId)throw unavailable();
    return result;
  });
  if(new Set(rows.map(row=>row.receiptId)).size!==rows.length)throw unavailable();return rows.sort((a,b)=>a.receiptId-b.receiptId);
}
export class ErpProviderFactsService {
  constructor(private readonly provider:ErpProviderClient){}
  async observe(snapshot:ErpRuntimeSnapshot,input:ErpCallbackInput):Promise<{observedAt:number;orders?:ErpObservedOrder[];stocks?:ErpObservedStock[];returns?:ErpObservedReturn[]}>{
    const credentials={...snapshot.config,accessToken:snapshot.accessToken},observedAt=now();
    if(input.kind==='stock'){
      const codes=[...new Set(input.items.map(item=>item.code))],stocks:ErpObservedStock[]=[];
      for(let offset=0;offset<codes.length;offset+=100){const selected=codes.slice(offset,offset+100);
        stocks.push(...projectErpStocks(await this.provider.query('inventory',credentials,{sku_ids:selected.join(','),page_index:1,page_size:100,has_lock_qty:true},now()),selected));}
      return {observedAt,stocks};
    }
    const orders=projectErpOrders(await this.provider.query('order',credentials,{so_ids:[input.orderId],page_index:1,page_size:100},now()),input.orderId);
    if(input.kind==='refund-receive'){
      const returns=projectErpReturns(await this.provider.query('received',credentials,{as_ids:[input.afterSaleId],o_ids:[input.providerOrderId],so_ids:[input.orderId],shop_id:String(input.shopId),page_index:1,page_size:50},now()),input);
      return {observedAt,orders,returns};
    }
    return {observedAt,orders};
  }
}
