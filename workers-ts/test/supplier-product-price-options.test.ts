import { describe, expect, it } from 'vitest';
import { supplierProductPriceOptions, supplierProductPriceAttrs, assertSupplierMemberPrices } from '@/services/supplier/SupplierProductPriceOptions';
import { normalizeSupplierProductInput } from '@/services/supplier/SupplierProductManagementService';
import { productPriceSelection, productPriceOptionsPayload } from '../../view/supplier-ts/src/utils/productPriceOptions';
const input = { product_type:0,store_name:'价格选项',cate_id:[11],slider_image:['/price.png'],spec_type:0,freight:1,
  attrs:[{price:'10.00',settle_price:'1.00',vip_price:'7.50',brokerage:'2.00',brokerage_two:'1.00',stock:5}] };
describe('Supplier complete member-price and commission options',()=>{
  it.each([{}, {is_sub:undefined}])('omission preserves the existing author path %j',value=>{
    expect(supplierProductPriceOptions(value)).toBeUndefined();expect(supplierProductPriceAttrs(input.attrs,undefined)).toBe(input.attrs);
  });
  it.each([[[],0,0],[[0],1,0],[[1],0,1],[[0,1],1,1],[['1','0'],1,1]] as const)('decodes independent legacy options %j',(selected,isVip,isSub)=>{
    expect(supplierProductPriceOptions({is_sub:selected})).toEqual({isVip,isSub});
  });
  it.each([null,false,0,'0','0,1',{},[0,0],['1',1],[2],[-1],[true],[0,1,2]])('rejects malformed options %j',selected=>{
    expect(()=>supplierProductPriceOptions({is_sub:selected})).toThrow();
  });
  it('clears disabled commission before validating a complete SKU while retaining member price',()=>{
    const attrs=[{...input.attrs[0],brokerage:'ignored-invalid',brokerage_two:999999}];
    expect(()=>normalizeSupplierProductInput({...input,attrs})).toThrow();
    const normalized=normalizeSupplierProductInput({...input,attrs:supplierProductPriceAttrs(attrs,{isVip:1,isSub:0})});
    expect(normalized.skus[0]).toMatchObject({vipPrice:'7.50',brokerage:'0.00',brokerageTwo:'0.00'});
    expect(attrs[0].brokerage).toBe('ignored-invalid');
  });
  it('requires positive member prices only when member pricing is enabled',()=>{
    const normalized=normalizeSupplierProductInput({...input,attrs:[{...input.attrs[0],vip_price:'0.00'}]});
    expect(()=>assertSupplierMemberPrices(normalized,1)).toThrow('所有SKU会员价必须大于0');expect(()=>assertSupplierMemberPrices(normalized,0)).not.toThrow();
  });
  it.each([[0,0,[]],[1,0,[0]],[0,1,[1]],[1,1,[0,1]]] as const)('projects precise read options without confusing scalar and write-array shapes',(member,commission,selected)=>{
    expect(productPriceSelection({version:1,is_vip:member,is_sub:commission})).toEqual({ready:true,selected});
    expect(productPriceOptionsPayload([...selected],true)).toEqual({is_sub:selected});
  });
  it('retains unknown old response state instead of converting it to explicit disabled intent',()=>{
    expect(productPriceSelection(undefined)).toEqual({ready:false,selected:[]});expect(productPriceOptionsPayload([],false)).toEqual({});
  });
  it.each([null,{},[],{version:2,is_vip:1,is_sub:1},{version:1,is_vip:'1',is_sub:1},{version:1,is_vip:1,is_sub:2},{version:1,is_vip:1,is_sub:1,extra:true}])('rejects incomplete read options %j',value=>expect(()=>productPriceSelection(value)).toThrow());
});
