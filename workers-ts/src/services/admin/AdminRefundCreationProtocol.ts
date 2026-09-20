import { ValidateException } from '@/utils/errors';
import { amountToCents } from '@/services/payment/RefundGateway';
import { centsToDecimal } from '@/services/order/OrderBrokerageService';

export const ADMIN_REFUND_CREATION_VERSION = 'admin-refund-creation-v1';
export const ADMIN_REFUND_CREATION_QUOTE_VERSION = 'admin-refund-creation-quote-v1';
export function refundCreationId(value: unknown, zero=false): number {
  if (typeof value!=='number' || !Number.isSafeInteger(value) || value<(zero?0:1) || value>2_147_483_647) throw new ValidateException('主动退款身份或数量无效');
  return value;
}
function record(value:unknown, keys:readonly string[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==keys.length || keys.some(k=>!Object.hasOwn(value,k))) throw new ValidateException('主动退款字段无效');
  return value as Record<string,unknown>;
}
function money(value:unknown):string {
  if (typeof value!=='string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw new ValidateException('主动退款金额格式无效');
  const cents=amountToCents(value); if(cents===null) throw new ValidateException('主动退款金额无效');
  return centsToDecimal(cents);
}
function text(value:unknown,max:number):string {
  if(typeof value!=='string' || !value.trim() || value.length>max || /[\u0000-\u001f\u007f]/.test(value))throw new ValidateException('主动退款单号或原因无效');
  return value.trim();
}
/** Strict, copied before any await. Canonical cart IDs only, sorted for hashing.
 * A fresh quote must precede UI confirmation; this is never an implicit selector. */
export function adminRefundCreationReview(value:unknown) {
  const r=record(value,['id','orderId','uid','storeId','supplierId','payPrice','totalNum','status','refundPrice','payType']);
  const status=refundCreationId(r.status,true); if(status>5) throw new ValidateException('订单状态无效');
  return Object.freeze({id:refundCreationId(r.id),orderId:text(r.orderId,32),uid:refundCreationId(r.uid),
    storeId:refundCreationId(r.storeId,true),supplierId:refundCreationId(r.supplierId,true),payPrice:money(r.payPrice),
    totalNum:refundCreationId(r.totalNum),status,refundPrice:money(r.refundPrice),payType:text(r.payType,32)});
}
function selection(mode:unknown,value:unknown) {
  if(mode!=='remaining' && mode!=='items')throw new ValidateException('主动退款选择方式无效');
  if(!Array.isArray(value) || value.length>100 || (mode==='items' ? !value.length : value.length!==0)) throw new ValidateException('请选择明确的退款商品和件数');
  const items=value.map(value=>{const row=record(value,['cartId','cartNum']);return Object.freeze({cartId:refundCreationId(row.cartId),cartNum:refundCreationId(row.cartNum)});}).sort((a,b)=>a.cartId-b.cartId);
  if(new Set(items.map(row=>row.cartId)).size!==items.length)throw new ValidateException('退款商品不能重复选择');
  return {mode,items:Object.freeze(items)};
}
export function parseAdminRefundCreationQuote(value:unknown) {
  const body=record(value,['version','orderId','mode','items']);
  if(body.version!==ADMIN_REFUND_CREATION_QUOTE_VERSION)throw new ValidateException('主动退款报价协议无效');
  return Object.freeze({version:ADMIN_REFUND_CREATION_QUOTE_VERSION,orderId:refundCreationId(body.orderId),...selection(body.mode,body.items)});
}
export function parseAdminRefundCreation(value:unknown) {
  const body=record(value,['version','review','mode','items','quotedPrice','refundPrice','reason','quoteFingerprint']);
  if(body.version!==ADMIN_REFUND_CREATION_VERSION) throw new ValidateException('主动退款协议无效');
  if(typeof body.quoteFingerprint!=='string' || !/^[a-f0-9]{64}$/.test(body.quoteFingerprint))throw new ValidateException('请重新取得主动退款报价');
  const review=adminRefundCreationReview(body.review),selected=selection(body.mode,body.items);
  const quotedPrice=money(body.quotedPrice),refundPrice=money(body.refundPrice);
  if(amountToCents(refundPrice)!>amountToCents(quotedPrice)!)throw new ValidateException('主动退款金额超过已核对上限');
  return Object.freeze({version:ADMIN_REFUND_CREATION_VERSION,review,...selected,
    quotedPrice,refundPrice,reason:text(body.reason,255),quoteFingerprint:body.quoteFingerprint});
}
export type AdminRefundCreationInput=ReturnType<typeof parseAdminRefundCreation>;

/** Preserve all actor/key bits without truncation: base36 int32 + base64url
 * UUID is at most31 chars, including prefix/separator. user_bill.link_id has
 * only32 chars even though the refund table allows50. Content lives in the
 * ledger hash, never in an ID which changes when the submitted body changes. */
export function adminRefundCreationNumber(adminId:number,key:string):string {
  refundCreationId(adminId);
  const hex=key.replaceAll('-','');
  if(!/^[0-9a-f]{32}$/.test(hex))throw new ValidateException('创建操作标识无效');
  const bytes=hex.match(/../g)!.map(pair=>Number.parseInt(pair,16));
  const encoded=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  return `AR${adminId.toString(36)}_${encoded}`;
}
