import {expect} from 'vitest';
import {checkoutPricingFixture} from './checkoutPricingFixture';
import {membershipCouponsFixture} from './membershipCouponsFixture';

/** Explicit native test commissioning only. Historical business fixtures stay
 * immutable; requests never install a missing capability or gain source DML. */
export async function membershipCouponPricingFixture(){
 const f=await membershipCouponsFixture();let close=f.close;
 try{
  if(!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Membership coupon pricing-fence proof requires owned PG16');
  const before=await f.snapshot(),resources=f.resources(),sequence=f.sequence();
  const commissioned=await checkoutPricingFixture(f);close=commissioned.close;
  expect(await commissioned.snapshot()).toEqual(before);
  expect(commissioned.resources()).toEqual(resources);expect(commissioned.sequence()).toEqual(sequence);
  return commissioned;
 }catch(error){await close();throw error;}
}
