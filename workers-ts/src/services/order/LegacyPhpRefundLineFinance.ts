import type {storeOrder,storeOrderCartInfo} from '@/models/schema';
import {ValidateException} from '@/utils/errors';
import { LEGACY_GAIN_EDIT_MARKER, LEGACY_EDITED_GAIN_FINANCIAL_VERSION, LEGACY_EDITED_GAIN_SOURCE,
 legacyGainIntegralForLine, type LegacyGainIntegralProof } from './UnpaidOrderGainIntegralProof';

/** A deterministic projection of original PHP purchase facts. This is never a
 * checkout snapshot, never writes the original cart, and never reprices from
 * today's product, membership, promotion or configuration tables. */
export const LEGACY_PHP_REFUND_LINE_VERSION='legacy-php-refund-line-finance-v1';
type Order=Pick<typeof storeOrder.$inferSelect,'id'|'uid'|'payPostage'|'totalPostage'|'divisionStaffBrokerage'|'divisionAgentBrokerage'|'divisionBrokerage'|'promotionsPrice'|'gainIntegral'>;
type Cart=Pick<typeof storeOrderCartInfo.$inferSelect,'oid'|'uid'|'cartId'|'cartNum'|'productId'|'skuUnique'|'isGift'|'writeTimes'|'promotionsId'> & Partial<typeof storeOrderCartInfo.$inferSelect>;
const invalid=()=>new ValidateException('原PHP退款财务快照无法完整核对，请核对原购买记录');
const record=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function money(value:unknown):bigint{
 if(typeof value!=='string'&&typeof value!=='number')throw invalid();
 const text=String(value);if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text))throw invalid();
 const[whole,fraction='']=text.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
const decimal=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;
const required=['sum_price','costPrice','sum_true_price','coupon_price','integral_price','first_order_price','one_brokerage','two_brokerage','use_integral','integral'];
const optional={postage_price:'payPostage',raw_postage_price:'totalPostage',division_staff_brokerage:'divisionStaffBrokerage',division_agent_brokerage:'divisionAgentBrokerage',division_brokerage:'divisionBrokerage'} as const;

/** Missing nonnegative allocations are proved only by an exact zero total or
 * one actual non-gift line owning the whole existing amount. Multiple lines
 * with a positive missing allocation remain unavailable; no ratio is guessed.
 * The caller subsequently reconciles EVERY projected total against the order.
 */
export function projectLegacyPhpRefundLine(order:Order,row:Cart,info:Record<string,unknown>,solePayingLine:boolean,proof?:LegacyGainIntegralProof|null):Record<string,unknown>|null{
 const product=record(info.productInfo),attr=record(product?.attrInfo);
 if(!product||!attr||required.some(key=>!Object.hasOwn(info,key)))return null;
 if(['financial_version','refund_order_generation','promotion_quote_version','member_savings_version','legacy_php_financial_source','product','sku'].some(key=>Object.hasOwn(info,key)))throw invalid();
 if(String(info.id)!==row.cartId||String(info.cart_num)!==String(row.cartNum)||!Number.isSafeInteger(row.cartNum)||row.cartNum<=0||row.oid!==order.id||row.uid!==order.uid||product.id!==row.productId||attr.unique!==row.skuUnique||![0,1].includes(row.isGift))throw invalid();
 // PHP setCartInfo uses max(attrInfo.write_times ?? 1, 1), so a genuine raw
 // zero is an implicit single-use unit. Preserve it in the original JSON;
 // validate canonical integer input before projecting that exact PHP rule.
 const rawWriteTimes=attr.write_times??1;
 if((typeof rawWriteTimes!=='number'&&typeof rawWriteTimes!=='string')||!/^(0|[1-9]\d{0,9})$/.test(String(rawWriteTimes))||!Number.isSafeInteger(Number(rawWriteTimes))||Number(rawWriteTimes)>2147483647)throw invalid();
 const unitWriteTimes=Math.max(1,Number(rawWriteTimes));
 if(row.writeTimes!==unitWriteTimes*row.cartNum)throw invalid();
 const derived:Record<string,unknown>={...info,id:row.cartId,financial_version:LEGACY_PHP_REFUND_LINE_VERSION,legacy_php_financial_source:'original-php-purchase-facts-v1',sku:{...attr,write_times:unitWriteTimes},product:{...product,storeName:product.store_name}};
 for(const field of required)money(info[field]);
 for(const[field,orderField]of Object.entries(optional)){
  if(Object.hasOwn(info,field)){money(info[field]);continue;}
  const total=money(order[orderField as typeof optional[keyof typeof optional]]);
  if(total!==0n&&!solePayingLine)return null;
  derived[field]=decimal(row.isGift?0n:total);
 }
 if(Object.hasOwn(info,'promotions_true_price'))money(info.promotions_true_price);
 else{if(money(order.promotionsPrice)!==0n||(row.promotionsId!==''&&row.promotionsId!==null)||info.price_type==='promotions')return null;derived.promotions_true_price='0.00';}
 const give=Object.hasOwn(product,'give_integral')?money(product.give_integral):money(order.gainIntegral)===0n?0n:null;
 if(give===null)return null;
 // StoreOrderCreateServices.php:163 uses bcmul(give_integral, cart_num, 0).
 const gained=give*BigInt(row.cartNum)/100n;
 const edited=Object.hasOwn(info,LEGACY_GAIN_EDIT_MARKER)?legacyGainIntegralForLine(proof,row as typeof storeOrderCartInfo.$inferSelect):undefined;
 if(edited===undefined&&Object.hasOwn(info,'gain_integral')&&money(info.gain_integral)!==gained*100n)throw invalid();
 if(edited!==undefined){derived.financial_version=LEGACY_EDITED_GAIN_FINANCIAL_VERSION;derived.legacy_php_financial_source=LEGACY_EDITED_GAIN_SOURCE;}
 derived.gain_integral=String(edited??gained);derived.product={...derived.product as Record<string,unknown>,giveIntegral:decimal(give)};
 if(row.isGift){
  if(required.some(field=>money(derived[field])!==0n)||Object.keys(optional).some(field=>money(derived[field])!==0n)||money(derived.promotions_true_price)!==0n||(edited===undefined?gained:BigInt(edited))!==0n)throw invalid();
 }
 return derived;
}
