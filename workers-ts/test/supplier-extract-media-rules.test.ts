import {describe,expect,it} from 'vitest';
import {parseSupplierExtractMediaQuery,supplierExtractHistoricalReference} from '@/services/supplier/SupplierExtractMediaService';
const signature='a'.repeat(43);
describe('Supplier historical extract closed query and reference boundary',()=>{
 it('requires exactly one lowercase64 revision and rejects extra ownership or media selectors',()=>{
  expect(parseSupplierExtractMediaQuery({revision:['a'.repeat(64)]})).toBe('a'.repeat(64));
  for(const value of[{}, {revision:[]},{revision:['a'.repeat(64),'b'.repeat(64)]},{revision:['A'.repeat(64)]},{revision:['a'.repeat(63)]},{revision:['a'.repeat(64)],id:['31']},{revision:['a'.repeat(64)],supplier_id:['8']}])expect(()=>parseSupplierExtractMediaQuery(value)).toThrow();
 });
 it.each(['/api/assets/31','/kefuapi/assets/31',`/api/assets/31?expires=1&signature=${signature}`,`/kefuapi/assets/31?signature=${signature}&expires=0`])('recognizes historical private row reference %s without trusting its old ticket',reference=>{
  expect(supplierExtractHistoricalReference(reference)).toEqual({kind:'asset',id:31,reference:'/api/assets/31'});
 });
 it.each(['','javascript:alert(1)','http://unsafe.test/a.png','//unsafe.test/a.png','/api/assets/031','/api/assets/0','/api/assets/2147483648','https://same.test/api/assets/31','/foo/../api/assets/31','/api/%61ssets/31','/api/assets/31#x',`/api/assets/31?expires=1&signature=${signature}&x=1`,`/api/assets/31?expires=1&expires=2&signature=${signature}`,`/api/assets/31?expires=1&signature=${signature}x`,'/api/assets/31?signature=a','/kefuapi//assets/31','\ud800','x\ny'])('keeps unavailable reference %j out of both public and private signing paths',reference=>{
  expect(supplierExtractHistoricalReference(reference)).toEqual({kind:'unavailable'});
 });
 it.each(['/owned-media/legacy.png?x=1&y=2','https://cdn.example.test/a.png?v=2','HTTPS://cdn.example.test/a.png'])('preserves a safe public historical literal %s exactly',reference=>{
  expect(supplierExtractHistoricalReference(reference)).toEqual({kind:'public',reference});
 });
});
