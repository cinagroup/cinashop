import type { OrderCouponScope, OrderCouponState } from './orderCoupons';

/** A cart suggestion has no authority. Consume it once, only after the current
 * owner's real order picker has returned that owned coupon as available. */
export class CartCouponPreselection {
  private fingerprint=''; private consumed=false; private pages=0;
  readonly id:number;
  private readonly owner:{uid:number;version:number}; private readonly cartIds:readonly number[];
  constructor(raw:unknown,owner:{uid:number;version:number},cartIds:readonly number[]){
    if(typeof raw!=='string'||!/^[1-9]\d{0,9}$/.test(raw)||Number(raw)>2147483647
      ||owner.uid<=0||!Number.isSafeInteger(owner.uid)||!Number.isSafeInteger(owner.version)||owner.version<0
      ||!cartIds.length||cartIds.length>100||new Set(cartIds).size!==cartIds.length
      ||cartIds.some(id=>!Number.isSafeInteger(id)||id<=0||id>2147483647))throw new Error('购物车优惠券参数无效');
    this.id=Number(raw);
    this.owner={...owner};this.cartIds=[...cartIds].sort((a,b)=>a-b);
  }
  revoke(){this.consumed=true;}
  bind(scope:OrderCouponScope|null,owner:{uid:number;version:number},cartIds:readonly number[],normal:boolean){
    if(this.consumed)return;
    if(owner.uid!==this.owner.uid||owner.version!==this.owner.version||!normal||JSON.stringify([...cartIds].sort((a,b)=>a-b))!==JSON.stringify(this.cartIds))return this.revoke();
    if(!scope)return;
    if(this.fingerprint&&this.fingerprint!==scope.fingerprint)return this.revoke();
    this.fingerprint=scope.fingerprint;
  }
  accept(page:OrderCouponState):{couponId:number;loadMore:boolean}{
    if(this.consumed||!this.fingerprint||page.fingerprint!==this.fingerprint||page.loading)return {couponId:0,loadMore:false};
    if(page.error){this.revoke();return {couponId:0,loadMore:false};}
    if(page.list.some(coupon=>coupon.id===this.id&&coupon.availability==='available')){this.revoke();return {couponId:this.id,loadMore:false};}
    // Cart computation scans at most 1000 owned candidates. Picker pages scan 20
    // each; a malformed/non-progressing backend cannot make this loop unbounded.
    if(page.nextCursor===null||++this.pages>=50){this.revoke();return {couponId:0,loadMore:false};}
    return {couponId:0,loadMore:true};
  }
}
