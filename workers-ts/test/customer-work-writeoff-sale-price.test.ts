import { describe,it,expect } from 'vitest';
import { customerWriteoffLinePrice,customerWriteoffSalePriceProof } from '../src/services/customer-work/CustomerWorkWriteoffSalePrice';

function line(quantity=2,times=1,remaining=quantity*times,patch:Record<string,unknown>={}) {
 const snapshot={financial_version:'checkout-line-finance-v1',id:'opaque:原商品-A',cart_num:quantity,product:{id:70,storeName:'原成交商品'},sku:{id:1,unique:'owned-sku',price:'7.00',write_times:times},
 sum_price:'7.00',sum_true_price:(quantity*7).toFixed(2),costPrice:'0.00',promotions_true_price:'0.00',raw_postage_price:'0.00',coupon_price:'0.00',integral_price:'0.00',postage_price:'0.00',use_integral:'0',one_brokerage:'0.00',two_brokerage:'0.00',first_order_price:'0.00',division_staff_brokerage:'0.00',division_agent_brokerage:'0.00',division_brokerage:'0.00',...patch};
 return{id:9,cartId:'opaque:原商品-A',cartNum:quantity,cartInfo:JSON.stringify(snapshot),productId:70,productType:times>1?4:0,skuUnique:'owned-sku',writeTimes:quantity*times,writeSurplusTimes:remaining,isGift:0};
}
function promotion() {
 const allocation={promotionId:9,rootId:9,type:1,savingsCents:300,discountQuantity:1,labelIds:[],name:'首件优惠'};
 return line(2,1,2,{sum_price:'10.00',sku:{id:1,unique:'owned-sku',price:'10.00',write_times:1},sum_true_price:'16.00',coupon_price:'1.00',promotions_true_price:'1.50',
 promotion_quote_version:'order-promotion-quote-v1',promotion_line_price:'17.00',promotion_line_savings:'3.00',promotion_line_member_savings:'0.00',promotion_discount_quantity:1,promotion_allocations:[allocation],promotion_segments:[
 {quantity:1,rawGrossCents:1000,totalPriceCents:700,unitPriceCents:700,membershipSavingsCents:0,promotionIds:[9],promotionAllocations:[allocation],couponEligibleGrossCents:700},
 {quantity:1,rawGrossCents:1000,totalPriceCents:1000,unitPriceCents:1000,membershipSavingsCents:0,promotionIds:[],promotionAllocations:[],couponEligibleGrossCents:1000}]});
}
describe('ordinary customer immutable writeoff sale price',()=>{
 it('uses modern admitted 7.00 instead of a mutable market price',()=>{expect(customerWriteoffLinePrice(line(),1)).toBe('7.00');expect(customerWriteoffLinePrice(line(),2)).toBe('14.00');});
 it('charges the exact original root truePrice and never product/SKU fallbacks',()=>{const cart=line();cart.cartInfo=JSON.stringify({id:cart.cartId,cart_num:2,truePrice:'7.00',productInfo:{id:70,attrInfo:{unique:'owned-sku',write_times:1,price:'999.00'}}});expect(customerWriteoffLinePrice(cart,2)).toBe('14.00');const source=JSON.parse(cart.cartInfo);delete source.truePrice;cart.cartInfo=JSON.stringify(source);expect(()=>customerWriteoffLinePrice(cart,1)).toThrow();});
 it('repeats each purchased card sale price for its real SKU entitlements',()=>{expect(customerWriteoffLinePrice(line(2,3,6),2)).toBe('14.00');expect(customerWriteoffLinePrice(line(2,3,4),3)).toBe('21.00');expect(customerWriteoffLinePrice(line(2,3,1),1)).toBe('7.00');});
 it('preserves promotion order and bounded coupon allocation',()=>{const cart=promotion();expect(customerWriteoffLinePrice(cart,1)).toBe('6.59');expect(customerWriteoffLinePrice({...cart,writeSurplusTimes:1},1)).toBe('9.41');expect(customerWriteoffLinePrice(cart,2)).toBe('16.00');});
 it('preserves bcdiv four places and leaves the final cent on its purchase piece',()=>{const cart=line(6,1,6,{sum_price:'1.00',sum_true_price:'1.00',coupon_price:'5.00'});expect(customerWriteoffLinePrice(cart,3)).toBe('0.49');expect(customerWriteoffLinePrice({...cart,writeSurplusTimes:3},3)).toBe('0.51');});
 it('does not move penny ownership between successive UUID partial selections',()=>{const cart=line(3,1,3,{sum_true_price:'20.00',coupon_price:'1.00'});const amounts=[3,2,1].map(remaining=>customerWriteoffLinePrice({...cart,writeSurplusTimes:remaining},1));expect(amounts).toEqual(['6.66','6.67','6.67']);});
 it('proves zero price without substituting a positive SKU price',()=>{expect(customerWriteoffLinePrice(line(2,3,6,{sum_true_price:'0.00',coupon_price:'14.00'}),6)).toBe('0.00');});
 it('has a stable immutable price hash as the real counter changes',async()=>{const before=await customerWriteoffSalePriceProof(line(2,3,6)),after=await customerWriteoffSalePriceProof(line(2,3,4));expect(before.snapshot_hash).toBe(after.snapshot_hash);expect(before.price_hash).toBe(after.price_hash);expect(before.all_remaining_price).toBe('42.00');expect(after.all_remaining_price).toBe('28.00');});
 it.each(['sum_true_price','coupon_price','first_order_price','integral_price','one_brokerage','two_brokerage','division_brokerage','sum_price'])('rejects incomplete modern %s without a legacy or SKU fallback',key=>{const cart=line(),snapshot=JSON.parse(cart.cartInfo);delete snapshot[key];cart.cartInfo=JSON.stringify(snapshot);expect(()=>customerWriteoffLinePrice(cart,1)).toThrow();});
 it.each([{id:'foreign'},{cart_num:3},{product:{id:71}},{sku:{unique:'foreign',write_times:1}},{sum_true_price:'1e3'},{sum_true_price:'14.001'},{sum_true_price:'15.00'}])('rejects wrong modern identity or monetary evidence %j',patch=>{expect(()=>customerWriteoffLinePrice(line(2,1,2,patch),1)).toThrow();});
 it.each([0,-1,3,1.5,2147483648])('rejects invalid or over-remaining selection %s',quantity=>{expect(()=>customerWriteoffLinePrice(line(),quantity)).toThrow();});
 it('rejects counterfeit entitlements and inconsistent remaining counters',()=>{expect(()=>customerWriteoffLinePrice({...line(),writeTimes:6},1)).toThrow();expect(()=>customerWriteoffLinePrice({...line(),writeSurplusTimes:3},1)).toThrow();});
 it('rejects malformed or oversized JSON before allocating any amount',()=>{expect(()=>customerWriteoffLinePrice({...line(),cartInfo:'{'},1)).toThrow();expect(()=>customerWriteoffLinePrice({...line(),cartInfo:' '.repeat(262145)},1)).toThrow();});
 it('evaluates a safe large quantity without expanding per-piece arrays',()=>{const cart=line(1000000,1,1000000);expect(customerWriteoffLinePrice(cart,500001)).toBe('3500007.00');});
});
