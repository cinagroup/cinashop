import { describe,expect,it } from 'vitest';
import { parseCartComputationInput } from '../src/services/order/CartComputationInput';

describe('PHP cart/compute bounded first-party input',()=>{
  it('preserves omitted/-1 delivery without inventing an address or pickup method',()=>{
    for(const shipping_type of [undefined,-1,'-1'])expect(parseCartComputationInput({cartId:'3,1',shipping_type})).toEqual({cartIds:[3,1]});
    for(const shipping_type of [1,2,3,'1','2','3'])expect(parseCartComputationInput({cartId:'1',shipping_type}).shippingType).toBe(Number(shipping_type));
  });
  it.each([null,[],{}, {cartId:1},{cartId:[1]},{cartId:''},{cartId:'0'},{cartId:'01'},{cartId:'-1'},
    {cartId:'1,1'},{cartId:'1,'},{cartId:'1, 2'},{cartId:'1e2'},{cartId:'2147483648'},
    {cartId:'1',uid:22},{cartId:'1',couponId:11},{cartId:'1',new:1},{cartId:'1',price:0},
    {cartId:'1',shipping_type:0},{cartId:'1',shipping_type:'2x'},{cartId:'1',shipping_type:null},
    {cartId:Array.from({length:101},(_,i)=>i+1).join(',')},{cartId:'1'.repeat(1101)}])('rejects malformed, client price/owner or oversized selection %j',body=>{
    expect(()=>parseCartComputationInput(body)).toThrow();
  });
  it('accepts exactly 100 distinct positive database IDs in requested order',()=>{
    const cartIds=Array.from({length:100},(_,i)=>100-i);expect(parseCartComputationInput({cartId:cartIds.join(',')})).toEqual({cartIds});
  });
});
