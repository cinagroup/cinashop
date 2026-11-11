import { describe, expect, it } from 'vitest';
import { normalizeOutPhysicalProductInput, normalizeOutProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';
const base = {product_type:0,cate_id:[9],store_name:'隔离商品',slider_image:['/fixture.png'],delivery_type:[1],freight:1,spec_type:0,
  attrs:[{price:'10.00',stock:7,bar_code:'ISOLATED'}]};
describe('Out manual virtual product authoring',()=>{
  it('preserves the physical normalization and receipt hash exactly',async()=>{
    expect(normalizeOutProductInput(base)).toEqual(normalizeOutPhysicalProductInput(base));
    expect(await outRequestHash(normalizeOutProductInput(base))).toBe(await outRequestHash(normalizeOutPhysicalProductInput(base)));
  });
  it('normalizes non-logistics terms and binds the distinct type into the receipt',async()=>{
    const manual=normalizeOutProductInput({...base,product_type:3,delivery_type:[],freight:3,temp_id:999,postage:'80.00'});
    expect(manual).toMatchObject({productType:3,deliveryType:'',freight:2,tempId:0,postage:'0.00'});
    expect(await outRequestHash(manual)).not.toBe(await outRequestHash(normalizeOutProductInput(base)));
  });
  it.each([{product_type:1},{product_type:2},{product_type:4},
    {product_type:3,is_presale_product:1},
    {product_type:3,attrs:[{price:'10.00',stock:1,disk_info:'content'}]},
    {product_type:3,attrs:[{price:'10.00',stock:1,virtual_list:[{card_no:'fixture'}]}]}])
    ('rejects unsupported fulfillment intent %j',patch=>{expect(()=>normalizeOutProductInput({...base,...patch})).toThrow();});
});
