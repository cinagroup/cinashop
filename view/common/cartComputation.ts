import type { CheckoutCartItem } from './checkoutSelection';
import { quoteMoney } from './checkoutQuote';

export interface CartBudgetSelection { id:number; productId:number; cartNum:number; unique:string; type:number; activityId:number }
export interface CartBudgetScope { uid:number; version:number; fingerprint:string; selection:CartBudgetSelection[] }
export interface CartBudget {
  raw:string; membership:string; promotions:string; couponDiscount:string; firstOrder:string; pay:string;
  svipActive:boolean; svipSaving:string; hypotheticalPaidMemberPayPrice:string|null;
  requiredIntegral:number;
  coupon:null|{issueId:number;userId:number;requiresClaim:boolean;title:string;discount:string};
  gifts:{id:number;name:string;giveIntegral:number;coupons:{issueId:number;title:string}[];products:{productId:number;quantity:number}[]}[];
}
export interface CartBudgetState { fingerprint:string; loading:boolean; error:string; result:CartBudget|null }
const fail=()=>new Error('购物车预算响应无效，请重新读取');
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw fail();return value as Record<string,unknown>;};
const integer=(value:unknown,min=0,max=2147483647):number=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw fail();return value;};
const text=(value:unknown,max=255):string=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))throw fail();return value;};
function money(value:unknown):{cents:number;display:string} {
  if(typeof value!=='number'&&typeof value!=='string')throw fail();
  const display=quoteMoney(String(value)),cents=Number(BigInt(display.replace('.','')));
  return {cents,display};
}
export function cartBudgetScope(items:readonly CheckoutCartItem[],owner:{uid:number;version:number}):CartBudgetScope {
  if(!Number.isSafeInteger(owner.uid)||owner.uid<=0||!Number.isSafeInteger(owner.version)||owner.version<0
    ||!items.length||items.length>100||new Set(items.map(item=>item.id)).size!==items.length)throw new Error('请选择有效购物车商品');
  const selection=items.map(item=>{
    if(!item.isValid||item.isNew!==0||!item.productInfo)throw new Error('选中商品已失效，请重新选择');
    return {id:integer(item.id,1),productId:integer(item.productId,1),cartNum:integer(item.cartNum,1,32767),
      unique:text(item.unique,8),type:integer(item.type,0,7),activityId:integer(item.activityId??0)};
  });
  if(selection.some(item=>!item.unique))throw new Error('商品规格已失效');
  return {...owner,selection,fingerprint:JSON.stringify([owner.uid,owner.version,selection])};
}
export function cartBudgetRequest(scope:CartBudgetScope):{cartId:string} {return {cartId:scope.selection.map(item=>item.id).join(',')};}
export function normalizeCartBudget(value:unknown,scope:CartBudgetScope):CartBudget {
  const row=record(value),deduction=record(row.deduction),budget=record(row.budget);
  if(!Array.isArray(row.promotions)||row.promotions.length!==0||typeof row.svip_status!=='boolean'
    ||budget.needsCheckoutRequote!==true||!Array.isArray(budget.excludes)||JSON.stringify(budget.excludes)!==JSON.stringify(['shipping','integral','payment'])
    ||!Array.isArray(budget.selection)||budget.selection.length!==scope.selection.length)throw fail();
  const selection=budget.selection.map(item=>{const r=record(item);return {id:integer(r.id,1),productId:integer(r.productId,1),cartNum:integer(r.cartNum,1,32767),
    unique:text(r.unique,8),type:integer(r.type,0,7),activityId:integer(r.activityId)};});
  if(JSON.stringify(selection)!==JSON.stringify(scope.selection)||integer(deduction.type)!==selection[0]!.type
    ||integer(deduction.activity_id)!==selection[0]!.activityId)throw new Error('购物车商品已变化，请重新读取');
  integer(deduction.product_type,0,4);
  const raw=money(deduction.sum_price),membership=money(deduction.vip_price),promotions=money(deduction.promotions_price),
    couponDiscount=money(deduction.coupon_price),firstOrder=money(deduction.first_order_price),pay=money(deduction.pay_price),svipSaving=money(row.svip_price);
  if(raw.cents-membership.cents-promotions.cents-couponDiscount.cents-firstOrder.cents!==pay.cents)throw fail();
  if(typeof budget.requiresCouponClaim!=='boolean')throw fail();
  const issueId=integer(budget.couponIssueId),userId=integer(budget.couponUserId);
  let coupon:CartBudget['coupon']=null;
  if(issueId===0){if(userId!==0||budget.requiresCouponClaim||couponDiscount.cents!==0||!Array.isArray(row.coupon)||row.coupon.length!==0)throw fail();}
  else{
    const c=record(row.coupon);
    if(couponDiscount.cents<=0||money(c.true_coupon_price).cents!==couponDiscount.cents||budget.requiresCouponClaim!==(userId===0))throw fail();
    if(userId){const used=record(c.used);if(integer(used.id,1)!==userId||integer(used.cid,1)!==issueId)throw fail();}
    else if(c.used!==undefined)throw fail();
    coupon={issueId,userId,requiresClaim:budget.requiresCouponClaim,title:text(c.coupon_title||c.title),discount:couponDiscount.display};
  }
  const hypothetical=budget.hypotheticalPaidMemberPayPrice===null?null:money(budget.hypotheticalPaidMemberPayPrice);
  if(svipSaving.cents!==Math.max(0,pay.cents-(hypothetical?.cents??pay.cents))||row.svip_status&&hypothetical!==null)throw fail();
  if(!Array.isArray(budget.gifts)||budget.gifts.length>1000)throw fail();
  const gifts=budget.gifts.map(value=>{const gift=record(value);
    if(!Array.isArray(gift.coupons)||gift.coupons.length>1000||!Array.isArray(gift.products)||gift.products.length>1000)throw fail();
    return {id:integer(gift.id,1),name:text(gift.name),giveIntegral:integer(gift.giveIntegral),
      coupons:gift.coupons.map(value=>{const c=record(value);return {issueId:integer(c.issueId,1),title:text(c.title)};}),
      products:gift.products.map(value=>{const p=record(value);return {productId:integer(p.productId,1),quantity:integer(p.quantity,1)};})};});
  return {raw:raw.display,membership:membership.display,promotions:promotions.display,couponDiscount:couponDiscount.display,firstOrder:firstOrder.display,
    pay:pay.display,svipActive:row.svip_status,svipSaving:svipSaving.display,hypotheticalPaidMemberPayPrice:hypothetical?.display??null,
    requiredIntegral:integer(budget.requiredIntegral),coupon,gifts};
}
/** A changed selection/account/hide invalidates all pending replies, including
 * a reply for a formerly identical selection after an intervening quantity edit. */
export class CartBudgetSession {
  private epoch=0;
  state:CartBudgetState={fingerprint:'',loading:false,error:'',result:null};
  constructor(private readonly read:(scope:CartBudgetScope)=>Promise<unknown>,private readonly publish:(state:CartBudgetState)=>void){}
  reset(){this.epoch++;this.update({fingerprint:'',loading:false,error:'',result:null});}
  private update(state:CartBudgetState){this.state=state;this.publish(state);}
  async load(scope:CartBudgetScope){
    const epoch=++this.epoch;this.update({fingerprint:scope.fingerprint,loading:true,error:'',result:null});
    try{const result=normalizeCartBudget(await this.read(scope),scope);if(epoch===this.epoch)this.update({fingerprint:scope.fingerprint,loading:false,error:'',result});}
    catch(error){if(epoch===this.epoch)this.update({fingerprint:scope.fingerprint,loading:false,error:error instanceof Error?error.message:'预算读取失败',result:null});}
  }
}
