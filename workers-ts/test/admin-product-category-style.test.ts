import { describe,expect,it } from 'vitest';
import { PRODUCT_CATEGORY_STYLES,PRODUCT_CATEGORY_STYLE_DEFAULT,isProductCategoryStyleValue,productCategoryStyleCanonical } from '../../view/common/productCategoryStyle';
import { categoryStyleInput,readProductCategoryStyleBody } from '../src/services/admin/AdminProductCategoryStyleInput';
import { decodeProductCategoryStyle,projectProductCategoryStyle,publicProductCategoryStyle } from '../src/services/content/ProductCategoryStyleReadService';
import { categoryPublicId,publicCategoryQuery } from '../src/services/product/PublicCategoryPolicy';
import { themeHash } from '../src/services/content/ThemeReadService';
describe('complete category style and public query contract',()=>{
  const valid={operationId:'12345678-1234-4234-8234-123456789abc',revision:'a'.repeat(64),level:2 as const,index:1};
  it('covers the two tree and all eight real product layout choices',()=>{
    expect(PRODUCT_CATEGORY_STYLES).toHaveLength(10);expect(PRODUCT_CATEGORY_STYLE_DEFAULT).toEqual({level:2,index:1});
    expect(PRODUCT_CATEGORY_STYLES.filter(item=>item.template===1)).toHaveLength(2);
    for(const value of PRODUCT_CATEGORY_STYLES)expect(isProductCategoryStyleValue(value)).toBe(true);
    for(const value of [{level:2,index:6},{level:3,index:4},{level:1,index:0},{level:'2',index:1},{level:3,index:1.5}])expect(isProductCategoryStyleValue(value)).toBe(false);
  });
  it('hashes fixed canonical keys independent of UUID or supplied property order',async()=>{
    const a=categoryStyleInput(valid),b=categoryStyleInput({index:1,level:2,revision:valid.revision,operationId:crypto.randomUUID()});
    expect(a.canonical).toEqual({operation:'update',revision:valid.revision,level:2,index:1});expect(await themeHash(a.canonical)).toBe(await themeHash(b.canonical));
    expect(productCategoryStyleCanonical(valid)).toEqual(a.canonical);
  });
  it('rejects incomplete, unknown, coerced or malformed write intents before proof',()=>{
    for(const value of [null,[],{...valid,actor:1},{...valid,revision:'A'.repeat(64)},{...valid,operationId:'1'},{...valid,index:'1'}, {...valid,level:3,index:4}])expect(()=>categoryStyleInput(value)).toThrow();
  });
  it('rejects duplicate escaped JSON keys and request byte overflow',async()=>{
    for(const body of ['{"level":2,"l\\u0065vel":3}',' '.repeat(4097)])await expect(readProductCategoryStyleBody(new Request('https://example.test',{method:'POST',body}))).rejects.toThrow();
    expect(await readProductCategoryStyleBody(new Request('https://example.test',{method:'POST',body:JSON.stringify(valid)}))).toEqual(valid);
  });
  it('preserves semantically exact opaque JSON and rejects numeric loss or duplicate keys',()=>{
    for(const value of ['{"level":2,"index":1,"opaque":9007199254740993}','{"level":2,"index":1,"opaque":1.234567890123456789}','{"level":2,"index":1,"opaque":1e999}','{"level":2,"index":1,"opaque":1e-999}','{"level":2,"index":1,"index":2}'])expect(decodeProductCategoryStyle(value)).toBeNull();
    expect(decodeProductCategoryStyle('{"level":2,"index":1,"opaque":{"n":1e3,"s":"9007199254740993"}}')).toEqual({level:2,index:1,opaque:{n:1000,s:'9007199254740993'}});
  });
  it('distinguishes a missing display default from valid saved authority',()=>{
    const snapshot=projectProductCategoryStyle({revision:'b'.repeat(64),rows:[]});
    expect(snapshot).toMatchObject({value:{level:2,index:1},configured:false,editable:true,issues:['category_style_missing']});
    expect(publicProductCategoryStyle(snapshot)).toEqual({level:2,index:1,configured:false,issues:['category_style_missing']});
  });
  it('accepts canonical reset0 and public IDs but rejects ambiguous classification query parameters',()=>{
    expect(publicCategoryQuery(new URLSearchParams('cid=1&sid=2&tid=3&is_big=1'))).toEqual({cid:1,sid:2,tid:3});
    expect(publicCategoryQuery(new URLSearchParams('cid=0&sid=0'))).toEqual({cid:0,sid:0});expect(categoryPublicId('2147483647')).toBe(2147483647);
    for(const q of ['cid=1&cid=10','cid=01','sid=1e2','tid=-1','tid=NaN','selectId=2147483648','is_big=2'])expect(()=>publicCategoryQuery(new URLSearchParams(q))).toThrow();
    for(const id of ['0','01','1e2','-1','2147483648'])expect(()=>categoryPublicId(id)).toThrow();
  });
});
