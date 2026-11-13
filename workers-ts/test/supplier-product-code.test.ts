import { describe, expect, it } from 'vitest';
import { supplierProductCodeInput } from '@/services/supplier/SupplierProductCode';
import { productCodeEditor, productCodePayload, productCodeValue } from '../../view/supplier-ts/src/utils/productCode';

describe('Supplier product identity code intent', () => {
  it('separates omission inherited undefined and explicit clear from other product and SKU identities', () => {
    for (const raw of [{}, {code:undefined}, Object.create({code:'inherited'}), {bar_code:'barcode',spu:'generated',attrs:[{code:'sku-only'}]}])
      expect(supplierProductCodeInput(raw)).toBeUndefined();
    expect(supplierProductCodeInput({code:''})).toBe('');expect(supplierProductCodeInput({code:'  ERP-001  '})).toBe('ERP-001');
  });
  it('fits fifty Unicode characters in the actual column without counting valid surrogate pairs twice', () => {
    const code='码🛍'.repeat(25);expect(productCodeValue(code)).toBe(code);expect(supplierProductCodeInput({code})).toBe(code);
    expect(()=>supplierProductCodeInput({code:code+'x'})).toThrow();expect(()=>productCodeValue(code+'x')).toThrow();
  });
  it.each([null,1,false,{},[],'bad\ncode','\u0000','\ud800','\udfff','\tERP'])('rejects malformed explicit code %j', raw => {
    expect(()=>supplierProductCodeInput({code:raw})).toThrow();expect(()=>productCodeValue(raw)).toThrow();
  });
  it('retains historical text without turning a read echo into an author intent', () => {
    const editor=productCodeEditor({version:1,code:'old\ncode',erp_open:false});expect(productCodePayload(editor)).toEqual({});
    expect(productCodePayload({...editor,code:'',changed:true})).toEqual({code:''});expect(productCodePayload({...editor,code:'new',changed:true})).toEqual({code:'new'});
    expect(productCodePayload({...productCodeEditor(),code:'forged',changed:true})).toEqual({});expect(productCodeEditor(undefined,true).ready).toBe(true);
    expect(productCodeEditor({version:1,code:'ERP',erp_open:null}).erpOpen).toBeNull();
  });
  it.each([null,[],{}, {version:2,code:'',erp_open:false},{version:1,code:1,erp_open:false},{version:1,code:'',erp_open:'0'},{version:1,code:'',erp_open:false,extra:true}])('rejects malformed read metadata %j',raw=>expect(()=>productCodeEditor(raw)).toThrow());
});
