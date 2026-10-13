import { BadRequestException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import type { ErpCallbackKind } from './ErpProtocol';
import { ERP_UUID, erpPhpJson } from './ErpProtocol';

type ObjectValue=Record<string,unknown>;
export function erpObject(value:unknown):ObjectValue {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new BadRequestException('ERP 数据必须为对象');
  return value as ObjectValue;
}
export function erpOnly(row:ObjectValue,fields:readonly string[]):void {
  if(Object.keys(row).some(key=>!fields.includes(key))) throw new BadRequestException('ERP 数据包含未知字段');
}
export function erpText(value:unknown,name:string,max=128,empty=false):string {
  if(typeof value!=='string' || (!empty && !value) || [...value].length>max || /[\u0000-\u001f\u007f]/.test(value)) throw new BadRequestException(`${name}无效`);
  erpPhpJson(value); return value;
}
export function erpInteger(value:unknown,name:string,min=1,max=2147483647):number {
  const parsed=typeof value==='string' && /^(0|[1-9]\d{0,9})$/.test(value) ? Number(value) : value;
  if(typeof parsed!=='number' || !Number.isSafeInteger(parsed) || Object.is(parsed,-0) || parsed<min || parsed>max) throw new BadRequestException(`${name}无效`);
  return parsed;
}
export function erpId(value:unknown):string { const id=erpText(value,'ERP 连接标识',36);if(!ERP_UUID.test(id)) throw new BadRequestException('ERP 连接标识无效');return id; }

/** JSON.parse alone loses duplicate keys, including escaped equivalents.
 * This bounded grammar walk validates each complete nested object first. */
export function erpUniqueJson(text:string):unknown {
  if(!text || text.length>262144) throw new BadRequestException('ERP 正文无效或超限');
  let offset=0,nodes=0;
  const fail=()=>{throw new BadRequestException('ERP JSON 无效或含重复字段');};
  const whitespace=()=>{while(/[\t\n\r ]/.test(text[offset]??'\u0000')) offset++;};
  function string():string {
    const start=offset;if(text[offset++]!=='"') return fail();
    while(offset<text.length) {
      const character=text[offset++];
      if(character==='"') {try{return JSON.parse(text.slice(start,offset)) as string;}catch{return fail();}}
      if(character==='\\') offset++;
    }
    return fail();
  }
  function value(depth:number):void {
    if(depth>20 || ++nodes>10000) fail();whitespace();
    if(text[offset]==='{') {
      offset++;whitespace();const keys=new Set<string>();if(text[offset]==='}') {offset++;return;}
      while(true) {
        whitespace();const key=string();if(keys.has(key) || ['__proto__','prototype','constructor'].includes(key)) fail();keys.add(key);
        whitespace();if(text[offset++]!==':') fail();value(depth+1);whitespace();
        const end=text[offset++];if(end==='}') return;if(end!==',') fail();
      }
    }
    if(text[offset]==='[') {
      offset++;whitespace();if(text[offset]===']'){offset++;return;}
      while(true){value(depth+1);whitespace();const end=text[offset++];if(end===']')return;if(end!==',')fail();}
    }
    if(text[offset]==='"'){string();return;}
    const start=offset;while(offset<text.length && !/[\s,\]}]/.test(text[offset]))offset++;
    if(start===offset)fail();try{const scalar:unknown=JSON.parse(text.slice(start,offset));if(scalar!==null && !['boolean','number'].includes(typeof scalar))fail();}catch{fail();}
  }
  value(0);whitespace();if(offset!==text.length)fail();
  let result:unknown;try{result=JSON.parse(text);}catch{return fail();}erpPhpJson(result);return result;
}
export async function erpReadJson(request:Request):Promise<ObjectValue> {
  if(!(request.headers.get('content-type')??'').toLowerCase().startsWith('application/json')) throw new BadRequestException('ERP 正文必须为 JSON');
  return erpObject(erpUniqueJson(await readBoundedUtf8Text(request,262144)));
}

export interface ErpItem {code:string;quantity:number;externalRowId:string;sourceOrderId:string}
export interface ErpStockInput {kind:'stock';items:Array<{code:string;quantity:number;shopId:number;modified:string;sourceId:string}>}
export interface ErpDeliverInput {kind:'deliver';orderId:string;providerOrderId:number;logisticsId:string;logisticsCode:string;logisticsCompany:string;items:ErpItem[]}
export interface ErpCancelInput {kind:'cancel';orderId:string;remark:string}
export interface ErpRefundInput {kind:'refund-receive';orderId:string;providerOrderId:number;shopId:number;afterSaleId:number;refundNo:string;eventId:string;remark:string;items:ErpItem[]}
export type ErpCallbackInput=ErpStockInput|ErpDeliverInput|ErpCancelInput|ErpRefundInput;
function items(value:unknown):ErpItem[] {
  if(!Array.isArray(value) || !value.length || value.length>200) throw new BadRequestException('ERP 商品行数量无效');
  const result=value.map(item=>{
    const row=erpObject(item);erpOnly(row,['sku_id','qty','so_id','outer_oi_id','oi_id','name','i_id','shop_sku_id']);
    return {code:erpText(row.sku_id,'ERP SKU',50),quantity:erpInteger(row.qty,'ERP 商品数量',1,32767),
      externalRowId:row.outer_oi_id===undefined || row.outer_oi_id===null?'':erpText(row.outer_oi_id,'ERP 外部行标识',50,true),
      sourceOrderId:row.so_id===undefined || row.so_id===null?'':erpText(row.so_id,'ERP 商品订单标识',128,true)};
  });
  const keys=result.map(item=>JSON.stringify([item.code,item.externalRowId,item.sourceOrderId]));
  if(new Set(keys).size!==keys.length)throw new BadRequestException('ERP 商品行重复');
  return result.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
}
export function parseErpCallback(kind:ErpCallbackKind,value:unknown):ErpCallbackInput {
  const row=erpObject(value);
  if(kind==='stock') {
    erpOnly(row,['datas']);if(!Array.isArray(row.datas)||!row.datas.length||row.datas.length>200)throw new BadRequestException('ERP 库存行数量无效');
    const result=row.datas.map(item=>{
      const data=erpObject(item);erpOnly(data,['qty','shop_id','sku_id','shop_sku_id','i_id','id','modified']);
      return {code:erpText(data.sku_id,'ERP SKU',50),quantity:erpInteger(data.qty,'ERP 库存',0),shopId:erpInteger(data.shop_id,'ERP 店铺'),
        modified:data.modified===undefined?'':erpText(data.modified,'ERP 库存版本',64,true),sourceId:data.id===undefined?'':String(erpInteger(data.id,'ERP 库存行'))};
    });
    const keys=result.map(item=>`${item.shopId}:${item.code}`);if(new Set(keys).size!==keys.length)throw new BadRequestException('ERP 库存行重复');
    return {kind,items:result.sort((a,b)=>a.shopId-b.shopId || (a.code<b.code?-1:a.code>b.code?1:0))};
  }
  if(kind==='cancel') {
    erpOnly(row,['so_id','remark']);return {kind,orderId:erpText(row.so_id,'ERP 订单标识',128),remark:erpText(row.remark??'','ERP 取消说明',255,true)};
  }
  if(kind==='deliver') {
    erpOnly(row,['type','logistics_company','l_id','lc_id','o_id','so_id','send_date','items']);
    if(row.type!==undefined && erpInteger(row.type,'ERP 发货类型')!==1)throw new BadRequestException('ERP 仅支持真实快递发货');
    return {kind,orderId:erpText(row.so_id,'ERP 订单标识',128),providerOrderId:erpInteger(row.o_id,'ERP 内部订单'),
      logisticsId:erpText(row.l_id,'ERP 运单',128),logisticsCode:erpText(row.lc_id,'ERP 物流编码',64),logisticsCompany:erpText(row.logistics_company,'ERP 物流公司',64),items:items(row.items)};
  }
  erpOnly(row,['so_id','shop_id','as_id','o_id','action_name','outer_as_id','remark','items','unique_id']);
  if(row.action_name!=='确认收货')throw new BadRequestException('ERP 售后动作尚不支持');
  return {kind,orderId:erpText(row.so_id,'ERP 订单标识',128),providerOrderId:erpInteger(row.o_id,'ERP 内部订单'),shopId:erpInteger(row.shop_id,'ERP 店铺'),
    afterSaleId:erpInteger(row.as_id,'ERP 售后标识'),refundNo:erpText(row.outer_as_id,'ERP 外部售后标识',64),eventId:row.unique_id===undefined?'':erpText(row.unique_id,'ERP 事件标识',128,true),
    remark:erpText(row.remark??'','ERP 售后说明',255,true),items:items(row.items)};
}
