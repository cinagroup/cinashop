import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, hasAdminPermission, normalizeRoleRules,
  PRODUCT_CATEGORY_SELECTION_PERMISSION, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financePostgres } from './helpers/financePostgres';

const page={id:3,authType:1,menuPath:'/admin/product/product_classify',uniqueAuth:'admin-store-storeCategory-index',apiUrl:'',methods:''};
const menu=(id:number,apiUrl:string,methods:string,menuPath='',uniqueAuth='')=>({id,authType:2,apiUrl,methods,menuPath,uniqueAuth});
const tuples=[menu(170,'product/category','GET','/adminproduct/category'),menu(171,'product/category/<id>','DELETE','/adminproduct/category/<id>'),
  menu(172,'product/category/<id>','PUT','/adminproduct/category/<id>'),menu(173,'product/category','POST','/adminproduct/category','product-save-cate'),
  menu(174,'product/category/set_show/<id>/<is_show>','PUT','/adminproduct/category/set_show/<id>/<is_show>'),
  menu(176,'product/category/create','GET','/admincategory/create'),menu(177,'product/category/<id>','GET','/admincategory/<id>/edit'),
  menu(178,'product/category/tree/<type>','GET','/admincategory/tree/:type'),
  ...[376,387,398,411,940].map(id=>menu(id,'product/category/tree/<type>','GET')),menu(912,'product/category/cascader_list/<type?>','GET')];
describe('platform category exact legacy page and API menu admission from real SQL',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>,service:AdminPermissionService;
  beforeAll(async()=>{f=await financePostgres([systemMenus,systemRole]);service=new AdminPermissionService(createContainerFromDb(f.db));
    await f.db.insert(systemMenus).values([page,...tuples,menu(175,'product/category/set_category/<id>','PUT','/adminproduct/category/set_category/<id>'),
      {...page,id:9001},{...menu(9002,'product/category','GET'),uniqueAuth:'category.manage'},menu(9003,'product/category/set_category/<id>','PUT')]);
  },60000);afterAll(async()=>{await f?.close();},30000);
  it('keeps the old nine-contract capabilities separate from product selector admission',()=>{
    for(const [method,path,expected] of [['GET','product/category','category.view'],['GET','product/category/create','category.view'],['GET','product/category/12','category.view'],
      ['POST','product/category','category.manage'],['PUT','product/category/12','category.manage'],['DELETE','product/category/12','category.manage'],['PUT','product/category/set_show/12/1','category.manage'],
      ['GET','product/category/tree/1',PRODUCT_CATEGORY_SELECTION_PERMISSION],['GET','product/category/cascader_list',PRODUCT_CATEGORY_SELECTION_PERMISSION],['GET','product/category/cascader_list/13',PRODUCT_CATEGORY_SELECTION_PERMISSION]]) expect(requiredAdminPermission(method,path)).toBe(expected);
  });
  it('unknown quick edits, bad visibility, wrong verbs and unproved children have no permission',()=>{
    for(const [method,path] of [['PUT','product/category/set_category/12'],['GET','product/category/set_category/12'],['GET','product/category/12/edit'],['POST','product/category/12'],['PUT','product/category/set_show/12/2'],['POST','product/category/tree/1']]) expect(requiredAdminPermission(method,path)).toBeNull();
  });
  it('authorizes selectors for product or category grants without converting them into a manager',()=>{
    for(const key of ['product.view','product.manage','category.view','category.manage']) expect(hasAdminPermission(new Set([key]),PRODUCT_CATEGORY_SELECTION_PERMISSION)).toBe(true);
    expect(hasAdminPermission(new Set(['product.manage']),'category.manage')).toBe(false);expect(hasAdminPermission(new Set(['brand.view']),PRODUCT_CATEGORY_SELECTION_PERMISSION)).toBe(false);
    expect(()=>normalizeRoleRules(PRODUCT_CATEGORY_SELECTION_PERMISSION)).toThrow();
  });
  it('resolves every actual installation tuple through both complete real SQL menu readers',async()=>{
    const rows=[page,...tuples], rules=rows.map(row=>String(row.id)), batch=await service.resolveManyRulePermissionKeys(rules);
    for(let index=0;index<rows.length;index++){
      const row=rows[index], key=row.id===3?'category.view':requiredAdminPermission(row.methods,row.apiUrl)!;
      const expected=key==='category.manage'?['category.manage','category.view']:[key];
      expect(batch[index].sort(),String(row.id)).toEqual(expected.sort());expect((await service.resolveRulePermissionKeys(rules[index])).sort(),String(row.id)).toEqual(expected.sort());
      expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
    }
  });
  it('rejected protected tuples cannot retain opaque membership or fall back to unrelated generic grants',async()=>{
    const rules=['175','9001','9002','9003'], batch=await service.resolveManyRulePermissionKeys(rules);
    for(let index=0;index<rules.length;index++){expect(batch[index]).toEqual([]);expect(await service.resolveRulePermissionKeys(rules[index])).toEqual([]);}
    for(const row of [{...page,id:9001},{...page,uniqueAuth:'category.manage'},menu(175,'product/category/set_category/<id>','PUT'),menu(9003,'product/category/set_category/<id>','PUT')]) expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
  });
  it('preserves the earlier mobile namespace selection without widening the legacy management list',()=>{
    expect(requiredAdminPermission('GET','/api/admin/product/category')).toBe(PRODUCT_CATEGORY_SELECTION_PERMISSION);
    expect(requiredAdminPermission('GET','/adminapi/product/category')).toBe('category.view');
  });
});
