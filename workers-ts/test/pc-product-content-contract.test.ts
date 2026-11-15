import { expect, it } from 'vitest';
import { productCouponId, productCouponPage } from '@/services/product/ProductCouponDirectoryService';
it('uses canonical product/issuer ids and bounded unique selectors',()=>{
  expect(productCouponId('2147483647')).toBe(2147483647);expect(productCouponPage('http://local/?page=2&limit=50')).toEqual({page:2,limit:50});
  for(const id of [undefined,'','0','01','-1','1e1','2147483648','1%32'])expect(()=>productCouponId(id)).toThrow();
  for(const query of ['page=01','page=1&page=1','limit=0','limit=51','page=1001','uid=11','type=2','page=1000&limit=50'])expect(()=>productCouponPage('http://local/?'+query)).toThrow();
  expect(productCouponPage('http://local/?product_id=70&page=2',true)).toEqual({page:2,limit:10});
  expect(productCouponPage('http://local/?view=uni_product_coupons&page=2&limit=10')).toEqual({page:2,limit:10});
  for(const query of ['view=','view=uni_product_coupons&view=uni_product_coupons','view=other','view=uni_product_coupons&uid=11'])expect(()=>productCouponPage('http://local/?'+query)).toThrow();
  expect(()=>productCouponPage('http://local/?product_id=70&view=uni_product_coupons',true)).toThrow();
});
