import {describe,expect,it} from 'vitest';
import {parseSupplierFlowMarkInput,parseSupplierFlowQuery,supplierFlowRevision} from '@/services/supplier/SupplierFlowReadService';
describe('Supplier ledger closed query and note rules',()=>{
 it('has a closed modern default and preserves normal legacy pagination',()=>{
  expect(parseSupplierFlowQuery({selection:'ledger'})).toEqual({modern:true,type:'',keyword:'',data:'',start:null,end:null,page:1,limit:20,offset:0});
  expect(parseSupplierFlowQuery({page:'2',limit:'50',type:'2'})).toMatchObject({modern:false,type:'2',page:2,limit:50,offset:50});
  expect(parseSupplierFlowQuery({page:'bad',limit:'999',type:'unknown'})).toMatchObject({page:1,limit:100,type:''});
 });
 it.each([{supplier_id:'8'},{status:'1'},{type:'0'},{type:' 1'},{selection:'period'},{page:'0'},{page:'1.5'},{limit:'101'},{page:'2147483647',limit:'100'},{keyword:'x'.repeat(81)},{keyword:'bad\nword'},{data:'2026-02-30 - 2026-03-01'}])('rejects modern invalid %j',input=>{
  expect(()=>parseSupplierFlowQuery({selection:'ledger',...input})).toThrow();
 });
 it('normalizes literal search, supports PHP dates and keeps valid pages above10000',()=>{
  const query=parseSupplierFlowQuery({selection:'ledger',type:'1',keyword:'  A%_\\  ',data:'2026/09/01-2026/09/01',page:'101',limit:'100'});
  expect(query).toMatchObject({keyword:'A%_\\',page:101,offset:10000,type:'1'});expect(query.end!-query.start!).toBe(86400);
  for(const data of ['today','yesterday','week','last week','month','last month','quarter','year','last year','lately7','lately30'])expect(parseSupplierFlowQuery({selection:'ledger',data}).data).toBe(data);
 });
 it('keeps modern CAS and legacy note input separate and closed',()=>{
  expect(parseSupplierFlowMarkInput({selection:'ledger',mark:'  核对完成  ',expected_revision:'a'.repeat(64)})).toEqual({modern:true,mark:'核对完成',expectedRevision:'a'.repeat(64)});
  expect(parseSupplierFlowMarkInput({mark:'旧调用'})).toEqual({modern:false,mark:'旧调用',expectedRevision:undefined});
  expect(parseSupplierFlowMarkInput({mark:'汉'.repeat(255)}).mark).toHaveLength(255);
 });
 it.each([null,[],{mark:''},{mark:' '},{mark:'x'.repeat(256)},{mark:'x\0y'},{mark:'x\u0001y'},{mark:'x\u007fy'},{mark:'x',number:'1.00'},{selection:'ledger',mark:'x'},{selection:'ledger',mark:'x',expected_revision:'A'.repeat(64)},{selection:'ledger',mark:'x',expected_revision:'a'.repeat(64),supplier_id:8}])('rejects malformed note %j',input=>{
  expect(()=>parseSupplierFlowMarkInput(input)).toThrow();
 });
 it('binds a bounded revision to supplier, row id and every row update',async()=>{
  const revision=await supplierFlowRevision(7,1,'12345');expect(revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await supplierFlowRevision(7,1,'12345')).toBe(revision);
  for(const args of [[8,1,'12345'],[7,2,'12345'],[7,1,'12346']] as const)expect(await supplierFlowRevision(args[0],args[1],args[2])).not.toBe(revision);
  await expect(supplierFlowRevision(0,1,'1')).rejects.toThrow();await expect(supplierFlowRevision(7,1,'1x')).rejects.toThrow();
 });
});

import {getTableColumns} from 'drizzle-orm';
import {supplierFlowingWater} from '@/models/schema';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {projectSupplierFlowDescription,SUPPLIER_FLOW_DESCRIPTION_COLUMNS} from '@/services/supplier/SupplierFlowDescription';
const frozenFlow={id:1,supplierId:7,uid:11,orderId:'Powned',linkId:'owned',pm:1,number:'5.00',type:1,payType:'offline',
 payPrice:'18.75',totalPrice:'20.00',payPostage:'0.00',remark:'protected lineage',finishTime:100,status:1,mark:'original',isDel:0,tradeTime:99,addTime:98};
describe('closed Supplier ledger descriptive comparison view',()=>{
 it('enumerates the complete real19-column schema and changes only the bounded mark comparison',async()=>{
  expect(SUPPLIER_FLOW_DESCRIPTION_COLUMNS).toHaveLength(19);expect([...SUPPLIER_FLOW_DESCRIPTION_COLUMNS].sort()).toEqual(Object.keys(getTableColumns(supplierFlowingWater)).sort());
  const original=Object.freeze({...frozenFlow}),current=Object.freeze({...frozenFlow,mark:'真实备注\r\n\t'+'😀'.repeat(200)}),view=projectSupplierFlowDescription(current,original);
  expect(view).toEqual(original);expect(await outRequestHash(view)).toBe(await outRequestHash(original));expect(current.mark).not.toBe(original.mark);expect(view).not.toBe(current);
  expect(projectSupplierFlowDescription({...frozenFlow,mark:'😀'.repeat(255)},frozenFlow)).not.toBeNull();
 });
 it.each([{id:2},{supplierId:8},{uid:12},{orderId:'other'},{linkId:'other'},{pm:0},{number:'0.01'},{type:2},{payType:'yue'},
  {payPrice:'0.01'},{totalPrice:'0.01'},{payPostage:'0.01'},{remark:'other lineage'},{finishTime:101},{status:0},{isDel:1},{tradeTime:100},{addTime:99}])('keeps every nonmark field protected %j',async mutation=>{
   const current={...frozenFlow,...mutation,mark:'合法新备注'},view=projectSupplierFlowDescription(current,frozenFlow);expect(view).not.toBeNull();
   expect(await outRequestHash(view)).not.toBe(await outRequestHash(frozenFlow));expect(view).toEqual({...current,mark:frozenFlow.mark});
 });
 it('refuses schema drift accessor or invalid descriptions before making any comparison view',()=>{
  const {uid:_uid,...missing}=frozenFlow;
  for(const value of [null,[],missing,{...frozenFlow,unknown:1},{...frozenFlow,mark:1},{...frozenFlow,mark:'x'.repeat(256)},
   {...frozenFlow,mark:'x\u0001'},{...frozenFlow,mark:'x\u007f'},Object.create(frozenFlow),{...frozenFlow,id:'1'}])expect(projectSupplierFlowDescription(value,frozenFlow)).toBeNull();
  const accessor={...frozenFlow};Object.defineProperty(accessor,'mark',{get:()=>{throw Error('must not execute getter');},enumerable:true});
  expect(projectSupplierFlowDescription(accessor,frozenFlow)).toBeNull();expect(projectSupplierFlowDescription(frozenFlow,missing)).toBeNull();
 });
});
