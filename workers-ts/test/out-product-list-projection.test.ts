import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { storeProduct, storeProductAttrValue } from '../src/models/schema';
import { outListProduct, outListSku } from '../src/services/out/OutProductListProjection';
const defaults = (table: Parameters<typeof getTableColumns>[0]) => Object.fromEntries(Object.entries(getTableColumns(table)).map(([key,col]) => [key,col.default ?? null]));
const product = (extra: Partial<typeof storeProduct.$inferSelect> = {}) => ({...defaults(storeProduct),id:1,...extra}) as typeof storeProduct.$inferSelect;
const sku = (extra: Partial<typeof storeProductAttrValue.$inferSelect> = {}) => ({...defaults(storeProductAttrValue),id:1,productId:1,unique:'local001',...extra}) as typeof storeProductAttrValue.$inferSelect;
describe('Out management product list source projection',()=>{
  it('returns raw product counters and flags with PHP accessor and amount semantics',()=>{
    expect(outListProduct(product({sales:5,ficti:12,isSub:1,isVip:1,isPolices:1,isLimit:1,videoOpen:1,
      cateId:'1,2',sliderImage:'["/a.png"]',deliveryType:'1,2',labelId:'1,2',storeLabelId:'3',ensureId:'4',
      customForm:'[{"id":"one"}]',specs:'[{"name":"材质"}]',price:'13.25',vipPrice:'7.50',cost:'2.10'})))
      .toMatchObject({sales:5,ficti:12,is_sub:1,is_vip:1,is_police:1,is_limit:1,video_open:1,cate_id:'1,2',
        slider_image:['/a.png'],delivery_type:['1','2'],label_id:[1,2],store_label_id:[3],ensure_id:[4],
        custom_form:[{id:'one'}],specs:[{name:'材质'}],price:13.25,vip_price:7.5,cost:2.1});
  });
  it('preserves PHP null, empty and zero JSON behavior',()=>{
    expect(outListProduct(product({sliderImage:'',customForm:null,specs:'0',deliveryType:'0'})))
      .toMatchObject({slider_image:null,custom_form:[],specs:[],delivery_type:[]});
    expect(outListProduct(product({sliderImage:'0'})).slider_image).toBe(0);
  });
  it('keeps source SKU numeric strings and exposes retirement state explicitly',()=>{
    expect(outListSku(sku({price:'4.20',diskInfo:'synthetic metadata',isRetired:1,retiredAt:10})))
      .toMatchObject({product_id:1,unique:'local001',price:'4.20',disk_info:'synthetic metadata',is_retired:1,retired_at:10});
  });
});
