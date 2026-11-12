import { describe, expect, it } from 'vitest';
import { supplierProductUserLabelInput, supplierUserLabelCatalogQuery } from '@/services/supplier/SupplierProductUserLabels';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';
import { productUserLabelEditor, productUserLabelPayload, productUserLabelCatalog, productUserLabelIds } from '../../view/supplier-ts/src/utils/productUserLabels';
const selection={version:1,ids:[2,1],entries:[{id:2,title:'有效平台',available:true},{id:1,title:'历史用户标签 #1',available:false}],consistent:false,truncated:false};
describe('Supplier purchased user label intent and historical read',()=>{
  it('preserves omitted inherited and undefined intent while accepting actual legacy id rows',()=>{
    for(const raw of [{},{label_id:undefined},Object.create({label_id:[1]})])expect(supplierProductUserLabelInput(raw)).toBeUndefined();
    expect(supplierProductUserLabelInput({label_id:[{id:'2',name:'untrusted',type:2},1]})).toEqual([2,1]);
    expect(supplierProductUserLabelInput({label_id:[]})).toEqual([]);
  });
  it.each([null,false,{},'', '1,2',[0],[-1],['01'],[2147483648],[1,1],Array(101).fill(1),Array.from({length:7},(_,i)=>2147483640+i)])('rejects malformed or over-capacity SQL input %j',raw=>expect(()=>supplierProductUserLabelInput({label_id:raw})).toThrow());
  it('accepts exactly64 CSV characters and rejects65 against actual schema capacity',()=>{
    const ids=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25];expect(ids.join(',')).toHaveLength(65);
    const valid=[2147483641,2147483642,2147483643,2147483644,2147483645,2147483646];expect(valid.join(',')).toHaveLength(65);
    valid[5]=147483646;expect(valid.join(',')).toHaveLength(64);expect(supplierProductUserLabelInput({label_id:valid})).toEqual(valid);
    expect(productUserLabelIds(valid)).toEqual(valid);expect(()=>productUserLabelIds([...valid.slice(0,5),2147483646])).toThrow();
  });
  it('preserves read order and unavailable historical IDs without converting them to save intent',()=>{
    const editor=productUserLabelEditor(selection);expect(productUserLabelPayload(editor)).toEqual({});
    expect(productUserLabelPayload({...editor,changed:true,ids:[]})).toEqual({label_id:[]});
    expect(productUserLabelPayload({...productUserLabelEditor(),changed:true,ids:[9]})).toEqual({});expect(productUserLabelEditor(undefined,true).ready).toBe(true);
  });
  it.each([null,[],{}, {...selection,version:2},{...selection,entries:[]},{...selection,ids:[1,1]},{...selection,extra:1}])('rejects corrupt read %j',raw=>expect(()=>productUserLabelEditor(raw)).toThrow());
  it('accepts database Unicode titles and declares configured separately from execution readiness',()=>{
    const raw={version:1,list:[{id:1,title:'🛍'.repeat(255)}],page:1,limit:20,count:1,runtime_configured:false};expect(productUserLabelCatalog(raw)).toEqual(raw);
    expect(()=>productUserLabelCatalog({...raw,runtime_configured:'yes'})).toThrow();expect(()=>productUserLabelCatalog({...raw,list:[...raw.list,...raw.list]})).toThrow();
  });
  it.each(['supplier_id=7','type=2','status=0','limit=51','page=0','page=1&page=2','keyword='+ 'x'.repeat(129)])('rejects scope injection %s',q=>expect(()=>supplierUserLabelCatalogQuery(new URLSearchParams(q))).toThrow());
  it('exposes only the exact readonly view permission route',()=>{
    expect(requiredSupplierPermissions('GET','/supplierapi/product/user-label/catalog')).toEqual(['supplier.product.view']);
    expect(requiredSupplierPermissions('POST','/supplierapi/product/user-label/catalog')).toBeNull();
    expect(requiredSupplierPermissions('GET','/supplierapi/product/user-label/delete/1')).toBeNull();
  });
});
