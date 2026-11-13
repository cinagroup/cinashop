import { describe, expect, it } from 'vitest';
import { adminOrderEditId, adminOrderEditPoints, parseAdminOrderEditInput } from '@/services/admin/AdminOrderEditInput';
import { parseAdminOrderEditForm } from '../../view/admin-ts/src/utils/orderEdit';

const values={order_id:'123456',total_price:'20.00',total_postage:'3.00',pay_postage:'2.00',pay_price:'18.75',gain_integral:'17.00'};
const form=()=>({action:'/order/update/8',method:'PUT',revision:'a'.repeat(64),values:{...values},
  rules:Object.entries(values).map(([field,value],index)=>({field,value:index===0?value:Number(value),props:{disabled:index<4,...(index>0?{max:9_999_999_999}:{})}}))});
describe('Admin desktop six-field boundary',()=>{
  it('accepts the exact historical six fields without requiring a Supplier revision or operation ID',()=>{
    expect(parseAdminOrderEditInput({...values,pay_price:18.75,gain_integral:17})).toMatchObject({orderId:'123456',payPrice:'18.75',gainIntegral:'17.00',revision:undefined});
    expect(parseAdminOrderEditInput({...values,total_price:1234567890.12,pay_price:1234567890.12})).toMatchObject({totalPrice:'1234567890.12',payPrice:'1234567890.12'});
    expect(adminOrderEditId('8')).toBe(8);expect(adminOrderEditPoints('9999999999.00')).toBe(9_999_999_999);
  });
  it.each(['-1.00','0.01','10000000000.00'])('rejects an edited whole grant %s',value=>expect(()=>adminOrderEditPoints(value)).toThrow());
  it('preserves exact fractional historical echoes while leaving eligibility to the locked service',()=>{
    expect(parseAdminOrderEditInput({...values,gain_integral:'-0.50'}).gainIntegral).toBe('-0.50');
    expect(parseAdminOrderEditInput({...values,total_postage:'-0.50',pay_postage:'-0.25'})).toMatchObject({totalPostage:'-0.50',payPostage:'-0.25'});
    expect(parseAdminOrderEditInput({...values,pay_price:'9999999999.99'}).payPrice).toBe('9999999999.99');
  });
  it.each(['8e1','08','0','2147483648',NaN,{}])('refuses an ambiguous primary ID %s',value=>expect(()=>adminOrderEditId(value)).toThrow());
  it.each(['18.751','1e2','Infinity','',null,undefined,{},-1])('rejects a malformed price %s',value=>expect(()=>parseAdminOrderEditInput({...values,pay_price:value})).toThrow());
  it('binds frontend forms to their exact primary ID, order number, field set and disabled echoes',()=>{
    expect(parseAdminOrderEditForm(form(),8,'123456')).toEqual({values,revision:'a'.repeat(64)});
    for(const changed of [{...form(),action:'/order/update/123456'},{...form(),values:{...values,order_id:'Other'}},
      {...form(),values:{...values,total_price:20}},{...form(),values:{...values,admin_id:1}},
      {...form(),rules:form().rules.slice(1)},{...form(),rules:form().rules.map(row=>({...row,props:{disabled:false}}))},
      {...form(),revision:''},{...form(),method:'POST'}])expect(()=>parseAdminOrderEditForm(changed,8,'123456')).toThrow();
  });
});
