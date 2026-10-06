import { describe, expect, it } from 'vitest';
import { FAB_LINK_CATEGORIES, parseFabLinkQuery, projectFabLinkTarget, projectFabIntegralLinkTarget } from '../src/services/admin/AdminFabLinkCatalogService';
describe('dedicated FAB target catalog contract', () => {
  it('retains all old chooser kinds and explicitly adds the real presale product identity', () => {
    expect(FAB_LINK_CATEGORIES.map(item => item.kind)).toEqual(['basic','personal','distribution','marketing','product','product_category','seckill','bargain','combination','integral','presale','news','special']);
    expect(parseFabLinkQuery(new URLSearchParams('kind=product_category'))).toEqual({kind:'product_category',search:'',page:1,limit:15,offset:0,parent_id:0});
  });
  it('rejects duplicate/unknown/coerced parameters and bounds both pagination and category scope', () => {
    for (const value of ['kind=product&kind=news','kind=product&extra=1','kind=unknown','kind=product&page=01','kind=product&limit=101','kind=product&page=102&limit=100','kind=news&parent_id=1','kind=product&search=%0A']) expect(()=>parseFabLinkQuery(new URLSearchParams(value))).toThrow();
    expect(parseFabLinkQuery(new URLSearchParams('kind=product&page=101&limit=100&parent_id=17&search=%25_'))).toMatchObject({offset:10000,parent_id:17,search:'%_'});
  });
  it('keeps unavailable historical targets diagnostic rather than inventing an activity/product fallback', () => {
    for(const url of ['javascript:alert(1)','/pages/removed/index']) {
      expect(projectFabLinkTarget({id:41,name:'历史目标',kind:'integral',url})).toMatchObject({url:'',selectable:false,issues:[expect.any(String)]});
    }
    expect(projectFabLinkTarget({id:5,name:'佣金排行',kind:'distribution',url:'/pages/users/commission_rank/index'})).toMatchObject({selectable:true,partial:true});
    expect(projectFabLinkTarget({id:7,name:'商品',kind:'product',url:'/pages/goods_details/index?id=7'})).toMatchObject({selectable:true,partial:false,url:'/pages/goods_details/index?id=7'});
  });
  it('keeps the integral activity identity linkable when sold out and diagnoses unsafe summary values without inventing a free price', () => {
    expect(projectFabIntegralLinkTarget({id:41,name:'已兑完商品',price:'4.25',stock:0,quota:0})).toMatchObject({
      id:41,url:'/pages/activity/goods_details/index?id=41&type=4',selectable:true,price:'4.25',issues:expect.arrayContaining([expect.stringContaining('为0')])});
    const corrupt=projectFabIntegralLinkTarget({id:42,name:'坏\u0000名称',price:'-1.00',stock:-1,quota:2});
    expect(corrupt).toMatchObject({id:42,name:'积分商品',selectable:true,url:'/pages/activity/goods_details/index?id=42&type=4'});
    expect(corrupt).not.toHaveProperty('price');expect(corrupt.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('名称异常'),expect.stringContaining('价格异常'),expect.stringContaining('库存或配额异常')]));
    expect(projectFabIntegralLinkTarget({id:43,name:'资料超限积分',price:'1.00',stock:0,quota:0},['description_duplicate']))
      .toMatchObject({id:43,url:'/pages/activity/goods_details/index?id=43&type=4',selectable:false,
        issues:expect.arrayContaining([expect.stringContaining('暂不可选择')])});
  });
});
