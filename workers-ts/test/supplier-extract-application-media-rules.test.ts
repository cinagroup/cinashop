import {describe,expect,it} from 'vitest';
import {parseSupplierExtractApplicationMediaQuery} from '@/services/supplier/SupplierExtractApplicationMediaService';
import {requiredSupplierPermissions} from '@/services/supplier/SupplierPermissionService';
const uuid='00000000-0000-4000-8000-000000000031',route='/supplierapi/finance/supplier_extract/application_operations/'+uuid;
describe('Supplier original receipt media closed query and exact self-service route',()=>{
 it('accepts exactly one lowercase64 original request hash',()=>{
  expect(parseSupplierExtractApplicationMediaQuery({request_hash:['a'.repeat(64)]})).toBe('a'.repeat(64));
 });
 it.each([{}, {request_hash:[]},{request_hash:undefined},{request_hash:['a'.repeat(64),'b'.repeat(64)]},
  {request_hash:['A'.repeat(64)]},{request_hash:['a'.repeat(63)]},{request_hash:['a'.repeat(65)]},
  {request_hash:['a'.repeat(64)],ref:['/api/assets/31']},{request_hash:['a'.repeat(64)],attachment:['31']},
  {request_hash:['a'.repeat(64)],supplier_id:['7']},{request_hash:['a'.repeat(64)],actor_id:['21']},
  {request_hash:['a'.repeat(64)],revision:['a'.repeat(64)]}])('rejects malformed or additional query selector %j',query=>{
  expect(()=>parseSupplierExtractApplicationMediaQuery(query)).toThrow();
 });
 it('admits only exact original media GET and preserves the existing receipt and explicit resolve admissions',()=>{
  expect(requiredSupplierPermissions('GET',route+'/media')).toEqual([]);
  expect(requiredSupplierPermissions('GET',route)).toEqual([]);
  expect(requiredSupplierPermissions('POST',route+'/resolve')).toEqual([]);
 });
 it.each([['POST',route+'/media'],['PUT',route+'/media'],['DELETE',route+'/media'],['HEAD',route+'/media'],
  ['GET',route+'/media/31'],['GET',route+'/medias'],['POST',route+'/media/resolve'],
  ['GET',route.replace('4000','3000')+'/media'],['GET',route.replace('8000','7000')+'/media'],
  ['GET','/supplierapi/finance/supplier_extract/application_operations/invalid/media']])('does not admit adjacent method or UUID %s %s',(method,path)=>{
  expect(requiredSupplierPermissions(method!,path!)).toBeNull();
 });
});
