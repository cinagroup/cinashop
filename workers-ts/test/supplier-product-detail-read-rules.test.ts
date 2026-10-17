import {describe,expect,it} from 'vitest';
import {assertSupplierProductDetailQuery,supplierProductDetailAttribute,supplierProductDetailId,supplierProductDetailMoney,supplierProductDetailSliders} from '@/services/supplier/SupplierProductDetailReadService';
describe('Supplier product detail read-only input and bounded source rules',()=>{
 it.each(['1','80','2147483647'])('accepts canonical detail id %s',value=>expect(supplierProductDetailId(value)).toBe(Number(value)));
 it.each(['0','01','-1','1e2','2147483648','80.0',' 80',80,null,undefined])('rejects malformed detail id (%j)',value=>expect(()=>supplierProductDetailId(value)).toThrow());
 it('accepts only an empty detail query',()=>expect(()=>assertSupplierProductDetailQuery({})).not.toThrow());
 it.each([{supplier_id:['7']},{selection:['view']},{id:['80']},{id:['80','81']}])('rejects extra or duplicate query selectors (%j)',query=>expect(()=>assertSupplierProductDetailQuery(query)).toThrow());
 it.each(['0.00','19.99','999999999999999999.99'])('keeps exact decimal text %s',value=>expect(supplierProductDetailMoney(value)).toBe(value));
 it.each(['1','01.00','-0.01','1e2','NaN','1000000000000000000.00',1,null])('rejects malformed or lossy monetary data (%j)',value=>expect(()=>supplierProductDetailMoney(value)).toThrow());
 it('retains public media and canonicalizes private historical aliases without retaining tickets',()=>{
  expect(supplierProductDetailSliders('["/owned-media/p.png","/kefuapi/assets/31"]')).toEqual(['/owned-media/p.png','/api/assets/31']);
 });
 it('does not turn unsafe historical image strings into preview sources',()=>expect(supplierProductDetailSliders('["javascript:alert(1)","//outside.invalid/image.png"]')).toEqual(['','']));
 it.each(['{broken','{}','[1]'])('rejects malformed carousel data %s',value=>expect(()=>supplierProductDetailSliders(value)).toThrow());
 it('rejects an eleventh carousel item rather than returning the first ten',()=>expect(()=>supplierProductDetailSliders(JSON.stringify(Array(11).fill('/p.png')))).toThrow());
 it('preserves ordered bounded dimension values',()=>expect(supplierProductDetailAttribute('颜色','蓝, 红')).toEqual({name:'颜色',values:['蓝','红']}));
 it('rejects duplicate or excessive dimension values without truncation',()=>{
  expect(()=>supplierProductDetailAttribute('颜色','蓝,蓝')).toThrow();
  expect(()=>supplierProductDetailAttribute('颜色',Array.from({length:101},(_,i)=>String(i)).join(','))).toThrow();
 });
});
