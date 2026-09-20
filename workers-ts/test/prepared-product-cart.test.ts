import { describe, expect, it } from 'vitest';
import { prepareProductCart } from '../../view/common/preparedProductCart';
describe('acknowledged direct-product cart navigation identity', () => {
  it('retains immutable exact ordinary and package identities, never prices or arbitrary URLs', () => {
    expect(prepareProductCart({id:91,cartId:91,url:'https://irrelevant.example'},0)).toEqual({ids:[91],type:0});
    const ids = [91,92]; const result = prepareProductCart({cartIds:ids,cartId:[91,92]},5,2); ids[0]=99;
    expect(result).toEqual({ids:[91,92],type:5}); expect(Object.isFrozen(result.ids)).toBe(true);
  });
  it.each([null, {}, {id:0}, {id:-1}, {id:1.5}, {id:'91'}, {id:2147483648}, {id:91,cartId:92}])('rejects unacknowledged ordinary identity %j', response => {
    expect(()=>prepareProductCart(response,0)).toThrow();
  });
  it.each([null, {}, {cartIds:[91]}, {cartIds:[91,91]}, {cartIds:[91,0]}, {cartIds:['91',92]}, {cartIds:[91,92,93]},
    {cartIds:[91,92],cartId:[92,91]}, {cartIds:[91,92],cartId:91}])('rejects incomplete or inconsistent package identity %j', response => {
    expect(()=>prepareProductCart(response,5,2)).toThrow();
  });
});
