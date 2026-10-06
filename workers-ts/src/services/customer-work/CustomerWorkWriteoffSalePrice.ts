import type { storeOrderCartInfo } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { partitionRefundCartSnapshot, readPromotionLineEvidence, REFUND_SPLIT_LINE_FIELDS } from '@/services/order/RefundSplitAllocation';
import { readRefundGenerationMarker } from '@/services/order/RefundGenerationMarker';

type Cart = Pick<typeof storeOrderCartInfo.$inferSelect, 'id'|'cartId'|'cartNum'|'cartInfo'|'productId'|'productType'|'skuUnique'|'writeTimes'|'writeSurplusTimes'|'isGift'>;
export const CUSTOMER_WRITEOFF_SALE_PRICE_VERSION = 'customer-writeoff-sale-price-v1' as const;
const invalid = () => new ValidateException('原成交价格、商品归属或次数快照无法证明，请先核对订单');
function integer(value: unknown, zero = false): number {
 if(typeof value !== 'number'||!Number.isSafeInteger(value)||value<(zero?0:1)||value>2147483647)throw invalid();return value;
}
function record(value: unknown): Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw invalid();return value as Record<string,unknown>;
}
function cents(value: unknown): bigint {
 if(typeof value!=='string'&&typeof value!=='number')throw invalid();const text=String(value);
 if(!/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text))throw invalid();const[whole,fraction='']=text.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
function decimal(value: bigint): string {if(value<0n||value>999999999999n)throw invalid();return`${value/100n}.${String(value%100n).padStart(2,'0')}`;}
function sameQuantity(value: unknown, expected: number) {return value===expected||typeof value==='string'&&value===String(expected);}
interface PricePlan {
 source:'legacy-root-true-price'|'modern-line-finance';snapshot:Record<string,unknown>;unitWriteTimes:number;
 prefix:(purchasedQuantity:number)=>bigint;facts:Record<string,unknown>;
}
/** No database or mutable product/SKU read. The original finance partitioner
 * owns promotion order, benefit allocation, bcdiv(4) and the last cent. */
function plan(cart:Cart):PricePlan {
 integer(cart.id);integer(cart.productId);integer(cart.cartNum);integer(cart.writeTimes);integer(cart.writeSurplusTimes,true);
 if(cart.writeSurplusTimes>cart.writeTimes||![0,1].includes(cart.isGift)||typeof cart.cartId!=='string'||!cart.cartId||typeof cart.cartInfo!=='string'||new TextEncoder().encode(cart.cartInfo).length>262144)throw invalid();
 let value:unknown;try{value=JSON.parse(cart.cartInfo);}catch{throw invalid();}const snapshot=record(value);
 if(snapshot.id!==cart.cartId||!sameQuantity(snapshot.cart_num,cart.cartNum))throw invalid();
 const modern=Object.hasOwn(snapshot,'financial_version');
 const product=record(modern?snapshot.product:snapshot.productInfo),sku=record(modern?snapshot.sku:product.attrInfo);
 if(!sameQuantity(product.id,cart.productId)||sku.unique!==cart.skuUnique||typeof cart.skuUnique!=='string'||!cart.skuUnique)throw invalid();
 const unitWriteTimes=integer(Number(sku.write_times));
 if(!sameQuantity(sku.write_times,unitWriteTimes)||cart.writeTimes!==cart.cartNum*unitWriteTimes||!Number.isSafeInteger(cart.cartNum*unitWriteTimes))throw invalid();
 let prefix:(quantity:number)=>bigint;let source:PricePlan['source'];
 if(!modern){
  if(!Object.hasOwn(snapshot,'truePrice'))throw invalid();const unit=cents(snapshot.truePrice);if(cart.isGift&&unit!==0n)throw invalid();
  prefix=(quantity)=>unit*BigInt(quantity);source='legacy-root-true-price';
 }else{
  if(!['checkout-line-finance-v1','refund-order-line-finance-v1'].includes(String(snapshot.financial_version)))throw invalid();
  if(snapshot.financial_version==='refund-order-line-finance-v1')readRefundGenerationMarker(snapshot.refund_order_generation);
  for(const key of [...REFUND_SPLIT_LINE_FIELDS,'sum_price','costPrice','promotions_true_price','raw_postage_price'])cents(snapshot[key]);
  const total=cents(snapshot.sum_true_price),promotion=readPromotionLineEvidence(snapshot,cart.cartNum);
  const gross=promotion?BigInt(promotion.priceCents):cents(snapshot.sum_price)*BigInt(cart.cartNum);
  if(gross-cents(snapshot.coupon_price)-cents(snapshot.first_order_price)-cents(snapshot.integral_price)!==total)throw invalid();
  const memberFields=['member_savings_version','paid_member','member_postage_price','member_coupon_price'];
  if(memberFields.some(key=>Object.hasOwn(snapshot,key))){
   if(snapshot.member_savings_version!=='checkout-member-savings-v1'||![0,1].includes(snapshot.paid_member as number)||!['','level','member'].includes(String(snapshot.price_type)))throw invalid();
   const benefit=cents(snapshot.vip_truePrice),freight=cents(snapshot.member_postage_price),voucher=cents(snapshot.member_coupon_price),raw=cents(snapshot.raw_postage_price),charged=cents(snapshot.postage_price),coupon=cents(snapshot.coupon_price),eligible=snapshot.paid_member===1;
   if(snapshot.price_type===''&&benefit!==0n||snapshot.price_type==='member'&&!eligible||!eligible&&(freight!==0n||voucher!==0n)||charged>raw||freight!==0n&&freight!==raw-charged||voucher!==0n&&voucher!==coupon)throw invalid();
   if(promotion&&(cents(snapshot.promotion_line_member_savings)!==BigInt(promotion.memberSavingsCents)||snapshot.price_type===''&&promotion.memberSavingsCents!==0))throw invalid();
  }
  if(cart.isGift&&[...REFUND_SPLIT_LINE_FIELDS,'sum_price','promotions_true_price','raw_postage_price'].some(key=>cents(snapshot[key])!==0n))throw invalid();
  // Validate the complete partition even for a whole/zero selection; optional
  // member freight/coupon evidence must never conceal a corrupt allocation.
  const all=partitionRefundCartSnapshot(cart.cartInfo,cart.cartNum,cart.cartNum,cart.isGift===1);if(all.missingFields.length)throw invalid();
  prefix=(quantity)=>{
   if(quantity===0)return 0n;if(quantity===cart.cartNum)return total;
   const selected=partitionRefundCartSnapshot(cart.cartInfo!,cart.cartNum,quantity,cart.isGift===1);
   if(selected.missingFields.length||!selected.selected)throw invalid();return cents(record(JSON.parse(selected.selected)).sum_true_price);
  };source='modern-line-finance';
 }
 const facts={version:CUSTOMER_WRITEOFF_SALE_PRICE_VERSION,source,cart_row_id:cart.id,opaque_cart_id:cart.cartId,product_id:cart.productId,product_type:cart.productType,sku_unique:cart.skuUnique,cart_num:cart.cartNum,write_times:cart.writeTimes,unit_write_times:unitWriteTimes,snapshot};
 return{source,snapshot,unitWriteTimes,prefix,facts};
}
/** Each purchased piece has its original admitted sale price; its SKU
 * entitlement repeats that price, exactly as PHP truePrice * writeoff_num.
 * Prefix queries are bounded independently of an int4 quantity. */
export function customerWriteoffLinePrice(cart:Cart,quantity:number):string {
 integer(quantity);const p=plan(cart);if(quantity>cart.writeSurplusTimes)throw invalid();const start=cart.writeTimes-cart.writeSurplusTimes,end=start+quantity,unit=p.unitWriteTimes;
 const prefixWrites=(writes:number)=>{const whole=Math.floor(writes/unit),remainder=writes%unit;const amount=p.prefix(whole)*BigInt(unit);if(!remainder)return amount;const next=p.prefix(whole+1)-p.prefix(whole);if(next<0n)throw invalid();return amount+next*BigInt(remainder);};
 return decimal(prefixWrites(end)-prefixWrites(start));
}
export async function customerWriteoffSalePriceProof(cart:Cart) {
 const p=plan(cart);return{source:p.source,version:CUSTOMER_WRITEOFF_SALE_PRICE_VERSION,snapshot_hash:await outRequestHash(p.snapshot),price_hash:await outRequestHash(p.facts),
 next_price:cart.writeSurplusTimes?customerWriteoffLinePrice(cart,1):'0.00',all_remaining_price:cart.writeSurplusTimes?customerWriteoffLinePrice(cart,cart.writeSurplusTimes):'0.00',reason:''};
}
