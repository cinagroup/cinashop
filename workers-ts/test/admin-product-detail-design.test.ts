import {describe,expect,it} from 'vitest';
import {cloneProductDetailDesign,isProductDetailDesignValue,PRODUCT_DETAIL_DESIGN_DEFAULT,PRODUCT_DETAIL_DESIGN_KEYS,productDetailDesignPayload} from '../../view/common/productDetailDesign';
import {decodeProductDetailDesign,mergeProductDetailDesign,projectProductDetailDesign} from '../src/services/content/ProductDetailDesignReadService';
import {productDetailDesignInput} from '../src/services/admin/AdminProductDetailDesignInput';
import {detailDisplayPrice,productDetailDescriptionHtml} from '../src/services/product/ProductDetailDesignData';
const revision='a'.repeat(64),operationId='00000000-0000-4000-8000-000000000001';
describe('complete product detail design authority',()=>{
  it('defines exactly all nineteen PHP keys in canonical payload order without the operation UUID',()=>{
    expect(PRODUCT_DETAIL_DESIGN_KEYS).toEqual(['navList','openShare','pictureConfig','swiperDot','showPrice','isOpen','showSvip','showRank','showService','showReply','replyNum','showMatch','matchNum','showRecommend','recommendNum','menuList','showCart','showCommunity','communityNum']);
    const input=productDetailDesignInput({operationId,revision,value:cloneProductDetailDesign()});expect(input.canonical).toEqual(productDetailDesignPayload(revision,cloneProductDetailDesign()));
    expect(Object.keys(input.canonical.value)).toEqual(PRODUCT_DETAIL_DESIGN_KEYS);expect(JSON.stringify(input.canonical)).not.toContain(operationId);
  });
  it('accepts empty selector arrays and keeps every historical ordinal in its saved order',()=>{
    const value=cloneProductDetailDesign();value.navList=[];value.showService=[];value.showPrice=[];value.menuList=[];value.isOpen=[3,4,5,1,2,0];
    expect(isProductDetailDesignValue(value)).toBe(true);expect(productDetailDesignInput({operationId,revision,value}).canonical.value.isOpen).toEqual([3,4,5,1,2,0]);
  });
  it('isolates clones and deeply freezes the default arrays',()=>{const a=cloneProductDetailDesign(),b=cloneProductDetailDesign();a.isOpen.reverse();a.navList.pop();expect(b).toEqual(PRODUCT_DETAIL_DESIGN_DEFAULT);expect(Object.isFrozen(PRODUCT_DETAIL_DESIGN_DEFAULT)).toBe(true);for(const key of ['navList','showPrice','isOpen','showService','menuList'] as const)expect(Object.isFrozen(PRODUCT_DETAIL_DESIGN_DEFAULT[key])).toBe(true);});
  it('rejects boolean/range/duplicate/unknown/omitted editor values and noncanonical UUIDs',()=>{
    for(const change of[{showCart:2},{openShare:true},{replyNum:0},{recommendNum:25},{showPrice:[2]},{menuList:[5]},{isOpen:[6]},{navList:[1,1]},{extra:1}])expect(()=>productDetailDesignInput({operationId,revision,value:{...cloneProductDetailDesign(),...change}})).toThrow();
    const missing:Record<string,unknown>={...cloneProductDetailDesign()};delete missing.showPrice;expect(isProductDetailDesignValue(missing)).toBe(false);expect(()=>productDetailDesignInput({operationId:'bad',revision,value:cloneProductDetailDesign()})).toThrow();
  });
  it('merges only missing PHP defaults while preserving opaque extensions in the decoded source',()=>{const saved=decodeProductDetailDesign('{"showReply":0,"isOpen":[3,4,5],"opaque":{"amount":1.25}}')!;expect(mergeProductDetailDesign(saved)).toMatchObject({showReply:0,isOpen:[3,4,5],replyNum:3});expect(Object.keys(mergeProductDetailDesign(saved))).toEqual(PRODUCT_DETAIL_DESIGN_KEYS);expect(saved.opaque).toEqual({amount:1.25});});
  it('rejects duplicate JSON keys, prototype pollution, numeric precision loss and corrupted/oversized sources',()=>{for(const raw of['{"showCart":1,"showCart":0}','{"opaque":{"__proto__":1}}','{"opaque":9007199254740993}','{bad','['+']','{"opaque":"'+'x'.repeat(1048576)+'"}'])expect(decodeProductDetailDesign(raw)).toBeNull();
    for(const source of['<p>公开正文</p><script>PRIVATE-XSS</script>','<p>公开正文</p><STYLE media="all">PRIVATE-STYLE</STYLE>','<p>公开正文</p><script\u0000>PRIVATE-UNCLOSED']){const html=productDetailDescriptionHtml(source);expect(html).toContain('公开正文');expect(html).not.toMatch(/PRIVATE|<script|<style/i);}
  });
  it('does not initialize missing rows and diagnoses ambiguous/wrong/deleted identity independently of status0',()=>{
    const catalog=(rows:any[])=>({rows,revision});expect(projectProductDetailDesign(catalog([]))).toMatchObject({configured:false,editable:true,value:PRODUCT_DETAIL_DESIGN_DEFAULT,issues:['product_detail_missing']});
    const row={id:1,templateName:'product_detail',type:3,isDel:0,status:0,value:'{}'};expect(projectProductDetailDesign(catalog([row]))).toMatchObject({configured:true,editable:true});
    for(const rows of [[row,row],[{...row,templateName:' Product_Detail '}],[{...row,type:1}],[{...row,isDel:1}]])expect(projectProductDetailDesign(catalog(rows)).editable).toBe(false);
  });
  it('does not silently repair known malformed saved fields while leaving a safe public default available',()=>{expect(projectProductDetailDesign({revision,rows:[{id:1,templateName:'product_detail',type:3,isDel:0,status:0,isShow:0,version:'',updateTime:0,xmin:'1',valueBytes:17,value:'{"replyNum":0}'}]})).toMatchObject({configured:true,editable:false,value:null,issues:['product_detail_value_invalid']});});
  it('uses only the requested display offers with minimum-price selection and no eligibility substitution',()=>{
    expect(detailDisplayPrice([], '20.00','18.00',88,'会员',true)).toMatchObject({enabled:false,price:'20.00',vip_price:'0.00'});
    expect(detailDisplayPrice([0], '20.00','18.00',88,'会员',true)).toMatchObject({price:'17.60',price_type:'level'});
    expect(detailDisplayPrice([1], '20.00','18.00',88,'会员',true)).toMatchObject({price:'18.00',price_type:'member'});
    expect(detailDisplayPrice([0,1], '20.00','18.00',88,'会员',true)).toMatchObject({price:'17.60',price_type:'level'});
    expect(detailDisplayPrice([1], '20.00','18.00',88,'会员',false)).toMatchObject({enabled:false,price:'20.00'});
    expect(detailDisplayPrice([0],'0.29','0.25',85,'会员',true).price).toBe('0.24');expect(detailDisplayPrice([0],'0.10','0.10',85.5,'会员',true).price).toBe('0.08');
    expect(detailDisplayPrice([0],'9999999999.99','1.00',99,'会员',false).price).toBe('9899999999.99');
  });
});
