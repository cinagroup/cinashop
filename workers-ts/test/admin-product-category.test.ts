import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {withTx} from '@/lib/di';
import {storeProductCategory,storeProduct,storeProductRelation,storeProductCate,storeProductCategoryBrand,storeCouponIssue,storeCouponTemplate,systemAdmin,systemRole,systemAttachment,systemLog} from '@/models/schema';
import {prepareCouponScope} from '@/services/activity/OrderCouponService';
import {assertCheckoutCouponItems} from '@/services/order/CheckoutCouponItemAuthority';
import {parseProductCategoryInput,parseProductCategoryQuery,productCategoryCatalogType} from '@/services/admin/AdminProductCategoryInput';
import {categoryActor,categoryBody,productCategoryFixture} from './helpers/adminProductCategories';
describe('complete platform category hierarchy contracts',()=>{
  let f:Awaited<ReturnType<typeof productCategoryFixture>>;
  beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));f=await productCategoryFixture();},30000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  it('returns source lazy DTO, actual filters and an unpaged list despite old page/limit parameters',async()=>{
    const roots=await f.service.list(new URLSearchParams('page=2&limit=1'),categoryActor());expect(roots.count).toBe(4);expect(roots.list.find(row=>row.id===1)).toMatchObject({pid:0,type:0,relation_id:0,path:'',level:0,depth:0,children:[],loading:false,_loading:false});
    const child=await f.service.list(new URLSearchParams('pid=2&is_show=1&cate_name=三级&id=3'),categoryActor());expect(child.list).toEqual([expect.objectContaining({id:3,path:'1,2',level:2,add_time:'1970-01-01 08:00:01'})]);
    expect((await f.service.list(new URLSearchParams('cate_name=%'),categoryActor())).count).toBe(4);expect(JSON.stringify(roots)).not.toContain('秘密');expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('separates root/flat tier lists from nested cascaders and recursively filters hidden ancestors',async()=>{
    expect((await f.service.tree(0,new URLSearchParams(),categoryActor(103))).map(row=>row.id)).toEqual([1,12,4]);
    expect((await f.service.tree(9,new URLSearchParams(),categoryActor(106))).map(row=>row.id)).toEqual([1,2,3,12,4,5]);
    const nodes=await f.service.cascader(undefined,new URLSearchParams(),categoryActor(106));expect(nodes).toEqual(await f.service.cascader(77,new URLSearchParams(),categoryActor(103)));expect(JSON.stringify(nodes)).toContain('三级分类');expect(JSON.stringify(nodes)).not.toContain('隐藏根后代');
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('returns all six old form fields, public previews and parent exclusions with source defaults',async()=>{
    const create=await f.service.form(0,new URLSearchParams(),categoryActor());expect(create).toMatchObject({title:'添加分类',action:'product/category',method:'POST'});expect(create.rules.map(row=>row.field)).toEqual(['pid','cate_name','pic','big_pic','sort','is_show']);expect(create.rules.find(row=>row.field==='is_show')?.value).toBe(1);
    const edit=await f.service.form(2,new URLSearchParams(),categoryActor());expect(edit).toMatchObject({method:'PUT',action:'product/category/2'});expect(edit.rules[0].value).toEqual([1]);expect(JSON.stringify(edit.rules[0])).not.toContain('子分类');expect(edit.rules.find(row=>row.field==='pic')).toMatchObject({type:'frame',props:{type:'image',maxLength:1,modal:{'footer-hide':true}}});
  });
  it('creates three levels with exact parent paths, same-parent uniqueness and atomic depth/cycle rejection',async()=>{
    const root=await f.service.save(0,categoryBody(),categoryActor()),child=await f.service.save(0,categoryBody({pid:[root.id]}),categoryActor()),leaf=await f.service.save(0,categoryBody({pid:[root.id,child.id]}),categoryActor());
    await expect(f.service.save(0,categoryBody({pid:[root.id,child.id,leaf.id]}),categoryActor())).rejects.toThrow('父级');await expect(f.service.save(0,categoryBody({pid:[child.id]}),categoryActor())).rejects.toThrow('真实层级');await expect(f.service.save(0,categoryBody(),categoryActor())).rejects.toThrow('已经存在');await expect(f.service.save(root.id,categoryBody({pid:[root.id,child.id]}),categoryActor())).rejects.toThrow('下级');
    expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,leaf.id)))[0]).toMatchObject({level:2,path:`${root.id},${child.id}`});expect(await f.db.select().from(systemLog)).toHaveLength(3);
  });
  it('moves in-use categories across all three product owners and changes only derived parents',async()=>{
    await f.db.insert(storeProduct).values([{id:80,cateId:'3',price:'29.50'},{id:81,type:1,relationId:7,cateId:'2,3'},{id:82,type:2,relationId:77,cateId:'3'},{id:83,cateId:'3'}]);
    await f.db.insert(storeProductRelation).values([{id:801,productId:80,type:1,relationId:3,relationPid:2,status:0,addTime:9},{id:802,productId:81,type:1,relationId:2,relationPid:1},{id:803,productId:81,type:1,relationId:3,relationPid:2},{id:804,productId:82,type:1,relationId:3,relationPid:2},{id:805,productId:80,type:2,relationId:2,relationPid:123}]);
    const products=await f.db.select().from(storeProduct).orderBy(storeProduct.id),relations=await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id);
    await f.service.save(2,categoryBody({pid:[4],cate_name:'移动子'}),categoryActor());expect(await f.db.select().from(storeProduct).orderBy(storeProduct.id)).toEqual(products);expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,3)))[0]).toMatchObject({pid:2,path:'4,2',level:2});
    expect(await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id)).toEqual(relations.map(row=>row.id===802?{...row,relationPid:4}:row));expect(await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId,83))).toEqual([]);
  });
  it('reads stale PHP derived metadata and repairs only the explicitly edited subtree and existing category parents',async()=>{
    await f.db.update(storeProductCategory).set({path:'obsolete',level:0}).where(eq(storeProductCategory.id,3));await f.db.insert(storeProduct).values({id:80,cateId:'3'});await f.db.insert(storeProductRelation).values({productId:80,type:1,relationId:3,relationPid:99});
    expect((await f.service.list(new URLSearchParams('pid=2'),categoryActor())).list[0]).toMatchObject({path:'obsolete',level:0,depth:2});await f.service.save(2,categoryBody({pid:[4]}),categoryActor());
    expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,3)))[0]).toMatchObject({path:'4,2',level:2});expect((await f.db.select().from(storeProductRelation))[0].relationPid).toBe(2);expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,5)))[0].path).toBe('4');
  });
  it('recomputes actual coupon ancestry and invalidates a previously confirmed item scope while preserving coupon facts',async()=>{
    await f.db.insert(storeProduct).values({id:80,cateId:'3',price:'29.50'});const [issue]=await f.db.insert(storeCouponIssue).values({id:90,couponType:1,category_id:'1'}).returning();const [product]=await f.db.select().from(storeProduct);const items=[{cart:{cartNum:1},product,unitPriceCents:2950}];
    const old=await prepareCouponScope(f.container,items,[issue]);expect(old.items[0].categoryAncestorIds).toEqual([2,1]);await f.service.save(2,categoryBody({pid:[4]}),categoryActor());
    const fresh=await prepareCouponScope(f.container,items,[issue]);expect(fresh.items[0].categoryAncestorIds).toEqual([2,4]);await expect(withTx(f.container,tx=>assertCheckoutCouponItems(tx,old.items,1))).rejects.toThrow('范围已变化');await withTx(f.container,tx=>assertCheckoutCouponItems(tx,fresh.items,1));expect((await f.db.select().from(storeCouponIssue))[0]).toEqual(issue);
  });
  it('preserves the old self plus direct-child status operation and leaves grandchildren flags unchanged',async()=>{
    expect(await f.service.setShow(1,0,categoryActor())).toMatchObject({id:1,is_show:0,updated:2});expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,3)))[0].isShow).toBe(1);expect(JSON.stringify(await f.service.cascader(1,new URLSearchParams(),categoryActor()))).not.toContain('三级分类');
    await f.service.setShow(1,1,categoryActor());expect(JSON.stringify(await f.service.cascader(1,new URLSearchParams(),categoryActor()))).toContain('三级分类');expect((await f.db.select().from(systemLog)).map(row=>row.method)).toEqual(['PUT','PUT']);
  });
  it('guards direct, current, both historic generations and both coupon authorities before hard deletion',async()=>{
    await expect(f.service.remove(1,categoryActor())).rejects.toThrow('子分类');await f.db.insert(storeProduct).values({id:80,cateId:'012'});await expect(f.service.remove(12,categoryActor())).rejects.toThrow('引用');await f.db.update(storeProduct).set({cateId:'0, ,99999999999999,3,'}).where(eq(storeProduct.id,80));
    await f.db.insert(storeProductRelation).values({productId:800,type:1,relationId:900,relationPid:12});await expect(f.service.remove(12,categoryActor())).rejects.toThrow('引用');await f.db.delete(storeProductRelation);
    await f.db.insert(storeProductCate).values({productId:800,catePid:12});await expect(f.service.remove(12,categoryActor())).rejects.toThrow('引用');await f.db.delete(storeProductCate);
    await f.db.insert(storeProductCategoryBrand).values({productId:800,cateId:12});await expect(f.service.remove(12,categoryActor())).rejects.toThrow('引用');await f.db.delete(storeProductCategoryBrand);
    await f.db.insert(storeCouponIssue).values({couponType:1,category_id:'+12'});await expect(f.service.remove(12,categoryActor())).rejects.toThrow('引用');await f.db.delete(storeCouponIssue);
    await f.db.insert(storeCouponTemplate).values({title:'历史分类券',scopeType:1,categoryId:12,couponPrice:'1.00',validDays:1,addTime:1,isDel:1});await expect(f.service.remove(12,categoryActor())).rejects.toThrow('引用');await f.db.delete(storeCouponTemplate);
    await f.service.remove(12,categoryActor());expect(await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,12))).toEqual([]);expect((await f.db.select().from(systemLog))[0].method).toBe('DELETE');
  });
  it('rejects unknown CSV formats and inconsistent selections with complete rollback rather than guessing history',async()=>{
    await f.db.insert(storeProduct).values({id:80,cateId:'3'});await f.db.insert(storeProductRelation).values({productId:80,type:1,relationId:2});await expect(f.service.save(2,categoryBody({pid:[4]}),categoryActor())).rejects.toMatchObject({code:409});await f.db.delete(storeProductRelation);await f.db.update(storeProduct).set({cateId:'0x03'});await expect(f.service.remove(12,categoryActor())).rejects.toThrow('引用');await expect(f.service.save(2,categoryBody({pid:[4]}),categoryActor())).rejects.toMatchObject({code:409});expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,2)))[0].pid).toBe(1);expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('stores durable authorized platform pictures and respects the distinct pic512/bigPic255 limits',async()=>{
    await f.db.insert(systemAttachment).values([{attId:100,name:'attachments/admin/1/category.png',attDir:'/api/assets/100',imageType:8,fileType:1,moduleType:1,attType:'image/png',type:1,relationId:0},{attId:101,name:'attachments/supplier/77/secret.png',attDir:'/api/assets/101',imageType:8,fileType:1,moduleType:1,attType:'image/png',type:4,relationId:77}]);
    const saved=await f.service.save(0,categoryBody({pic:'/api/assets/100?expires=1&signature=copied',big_pic:'https://example.test/big.png'}),categoryActor());const row=(await f.service.list(new URLSearchParams(),categoryActor())).list.find(row=>row.id===saved.id)!;expect(row.pic).toBe('/api/assets/100');expect(row.pic_preview).toMatch(/^\/api\/assets\/100\?expires=\d+&signature=/);expect(row.big_pic_preview).toBe('https://example.test/big.png');
    await expect(f.service.save(0,categoryBody({cate_name:'异域图片',pic:'/api/assets/101'}),categoryActor())).rejects.toThrow('不属于平台');const long=`https://example.test/${'a'.repeat(280)}.png`;expect(parseProductCategoryInput(categoryBody({pic:long})).pic).toBe(long);expect(()=>parseProductCategoryInput(categoryBody({big_pic:long}))).toThrow();
  });
  it('uses current numeric menus and rejects foreign ownership, password, role, expiry and stale revisions without effects',async()=>{
    await expect(f.service.save(8,categoryBody(),categoryActor())).rejects.toThrow('平台');await expect(f.service.save(0,categoryBody({pid:[9]}),categoryActor())).rejects.toThrow('平台');await expect(f.service.save(0,categoryBody(),categoryActor(102))).rejects.toThrow('权限');
    const saved=await f.service.save(0,categoryBody(),categoryActor(105));await expect(f.service.setShow(saved.id,0,categoryActor(), '0'.repeat(64))).rejects.toMatchObject({code:409});await f.db.update(systemRole).set({rules:'user.view'}).where(eq(systemRole.id,1));await expect(f.service.save(0,categoryBody(),categoryActor())).rejects.toThrow('权限');await f.db.update(systemAdmin).set({pwd:'replaced'}).where(eq(systemAdmin.id,100));await expect(f.service.list(new URLSearchParams(),categoryActor(100))).rejects.toThrow('凭据');await expect(f.service.list(new URLSearchParams(),{...categoryActor(),expiresAt:1})).rejects.toThrow('过期');
  });
  it('preserves modern omitted hierarchy/picture fields and rejects fabricated owner, raw predicates and illegal scalar IDs',async()=>{
    await f.service.modernSave({id:3,cate_name:'现代三级'},categoryActor());expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id,3)))[0]).toMatchObject({pid:2,path:'1,2',level:2});
    for(const body of [categoryBody({type:2}),categoryBody({relation_id:77}),categoryBody({pid:[1,0]}),categoryBody({pid:1}),categoryBody({is_show:2}),categoryBody({cate_name:' '.repeat(5)})])expect(()=>parseProductCategoryInput(body)).toThrow();for(const query of ['pid=-1','pid=1&pid=2','where=x','page=-1'])expect(()=>parseProductCategoryQuery(new URLSearchParams(query))).toThrow();for(const type of ['',-1,'any'])expect(()=>productCategoryCatalogType(type)).toThrow();
  });
  it('rolls back outside-field and administrator rewrites and incomplete audit callbacks',async()=>{
    await f.exec("CREATE FUNCTION rewrite_category_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.type=2; RETURN NEW; END $$; CREATE TRIGGER rewrite_category_fixture BEFORE INSERT ON store_product_category FOR EACH ROW EXECUTE FUNCTION rewrite_category_fixture()");await expect(f.service.save(0,categoryBody(),categoryActor())).rejects.toThrow('回执');await f.exec('DROP TRIGGER rewrite_category_fixture ON store_product_category');
    await f.exec("CREATE FUNCTION rewrite_category_actor_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE system_admin SET pwd='lost' WHERE id=101; RETURN NEW; END $$; CREATE TRIGGER rewrite_category_actor_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_category_actor_fixture()");await expect(f.service.save(0,categoryBody(),categoryActor())).rejects.toThrow('身份');expect((await f.db.select().from(systemAdmin).where(eq(systemAdmin.id,101)))[0].pwd).toBe('category-fixture-password');await f.exec('DROP TRIGGER rewrite_category_actor_fixture ON system_log');
    await f.exec("CREATE FUNCTION skip_category_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_category_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_category_audit_fixture()");await expect(f.service.save(0,categoryBody(),categoryActor())).rejects.toThrow('审计');expect(await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.cateName,'新分类'))).toEqual([]);expect(await f.db.select().from(systemLog)).toEqual([]);
  });
});
