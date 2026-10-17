import {describe,expect,it} from 'vitest';
import {parseSupplierExtractHistoryQuery,parseSupplierExtractMarkInput,supplierExtractConfigAmount,supplierExtractRevision} from '@/services/supplier/SupplierExtractReadService';
describe('Supplier withdrawal history closed read and shared note rules',()=>{
 it('closes modern query defaults and normalizes the PHP wx alias',()=>{
  expect(parseSupplierExtractHistoryQuery({selection:'history'})).toEqual({modern:true,status:'',pay_status:'',extract_type:'',data:'',start:null,end:null,page:1,limit:20,offset:0});
  expect(parseSupplierExtractHistoryQuery({selection:'history',extract_type:'wx',status:'-1',pay_status:'0'})).toMatchObject({extract_type:'weixin',status:'-1',pay_status:'0'});
  expect(parseSupplierExtractHistoryQuery({page:'2',limit:'50',extract_type:'bank'})).toMatchObject({modern:false,page:2,limit:50,offset:50});
  expect(parseSupplierExtractHistoryQuery({page:'bad',limit:'1000',status:'bad'})).toMatchObject({page:1,limit:100,status:''});
 });
 it.each([{supplier_id:'8'},{keyword:'x'},{nireid:'x'},{selection:'ledger'},{status:'2'},{pay_status:'-1'},{extract_type:'balance'},
  {page:'0'},{page:'1.5'},{limit:'101'},{page:'2147483647',limit:'100'},{data:'2026/02/30-2026/03/01'}])('rejects an ambiguous modern filter %j',input=>{
  expect(()=>parseSupplierExtractHistoryQuery({selection:'history',...input})).toThrow();
 });
 it('preserves PHP date boundaries and pages beyond10000 rows without a global cap',()=>{
  const query=parseSupplierExtractHistoryQuery({selection:'history',data:'2026/09/01-2026/09/01',page:'101',limit:'100'});
  expect(query.end!-query.start!).toBe(86400);expect(query.offset).toBe(10000);
  for(const data of ['today','yesterday','week','last week','month','last month','quarter','year','last year','lately7','lately30'])expect(parseSupplierExtractHistoryQuery({selection:'history',data}).data).toBe(data);
 });
 it.each([[undefined,'0.00'],['','0.00'],['""','0.00'],['  "5.50"  ','5.50'],['0005.5','5.50'],['200','200.00'],['0.01','0.01'],['999999999999999999.99','999999999999999999.99']])('reads exact configuration scalar %j', (input,expected)=>{
  expect(supplierExtractConfigAmount(input)).toBe(expected);
 });
 it.each(['bad','null','false','[]','{}','-1','1e2','5.555','9999999999999999999','"not money"'])('refuses invalid nonempty configuration %s',value=>{
  expect(()=>supplierExtractConfigAmount(value)).toThrow();
 });
 it('separates modern versioned notes from legacy null-result writes and supports Unicode255',()=>{
  expect(parseSupplierExtractMarkInput({selection:'history',mark:'  对账\n完成  ',expected_revision:'a'.repeat(64)})).toEqual({modern:true,mark:'对账\n完成',expectedRevision:'a'.repeat(64)});
  expect(parseSupplierExtractMarkInput({mark:'😀'.repeat(255)})).toMatchObject({modern:false,expectedRevision:undefined});
 });
 it.each([null,[],{mark:''},{mark:' '},{mark:'x'.repeat(256)},{mark:'x\u0001'},{mark:'x\ty'},{mark:'x\ry'},{mark:'x\u007f'},
  {mark:'x',extract_price:'1.00'},{selection:'history',mark:'x'},{selection:'history',mark:'x',expected_revision:'A'.repeat(64)},
  {selection:'history',mark:'x',expected_revision:'a'.repeat(64),supplier_id:8}])('rejects invalid shared note %j',value=>{
  expect(()=>parseSupplierExtractMarkInput(value)).toThrow();
 });
 it('binds the note revision to tenant target and PostgreSQL row version',async()=>{
  const initial=await supplierExtractRevision(7,1,'100');expect(initial).toMatch(/^[a-f0-9]{64}$/);
  expect(await supplierExtractRevision(7,1,'100')).toBe(initial);
  for(const args of [[8,1,'100'],[7,2,'100'],[7,1,'101']] as const)expect(await supplierExtractRevision(args[0],args[1],args[2])).not.toBe(initial);
  await expect(supplierExtractRevision(0,1,'100')).rejects.toThrow();await expect(supplierExtractRevision(7,1,'bad')).rejects.toThrow();
 });
});
