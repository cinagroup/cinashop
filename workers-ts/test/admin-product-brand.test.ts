import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {storeBrand,storeProduct,storeProductRelation,storeProductCategoryBrand,storePromotionsAuxiliary,storeCouponIssue,systemAdmin,systemRole,systemLog} from '@/models/schema';
import {brandActor,brandBody,productBrandFixture} from './helpers/adminProductBrands';
import {parseProductBrandInput,parseProductBrandQuery,productBrandCatalogType} from '@/services/admin/AdminProductBrandInput';
describe('complete platform brand hierarchy contracts',()=>{
  let f:Awaited<ReturnType<typeof productBrandFixture>>;
  beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));f=await productBrandFixture();},30000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  it('returns exact lazy DTOs and counts only live base products directly using each brand',async()=>{
    await f.db.insert(storeProduct).values([{id:80,brandId:3,pid:0},{id:81,brandId:3,pid:80},{id:82,brandId:3,isDel:1}]);
    const roots=await f.service.list(new URLSearchParams(),brandActor());expect(roots.count).toBe(4);
    expect(roots.list.find(row=>row.id===1)).toMatchObject({fid:[],fid_son:[1],type:1,children:[],loading:false,_loading:false,brand_num:0,store_id:0});
    const children=await f.service.list(new URLSearchParams('pid=2&brand_name=三级'),brandActor());
    expect(children.list).toEqual([expect.objectContaining({id:3,fid:[1,2],type:0,brand_num:1,add_time:'1970-01-01 08:00:01'})]);
    expect(JSON.stringify(roots)).not.toContain('门店秘密');expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('supports both cascader modes and recursively hides unreachable descendants without changing child flags',async()=>{
    const parents=await f.service.cascader(undefined,new URLSearchParams(),brandActor(103));
    expect(parents[0]).toEqual({value:0,label:'顶级品牌'});expect(JSON.stringify(parents)).not.toContain('三级品牌');
    expect(JSON.stringify(await f.service.cascader(2,new URLSearchParams(),brandActor(106)))).toContain('三级品牌');
    expect(JSON.stringify(parents)).not.toContain('隐藏根后代');await f.service.setShow(1,0,brandActor());
    expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,2)))[0].isShow).toBe(1);
    expect(JSON.stringify(await f.service.cascader(2,new URLSearchParams(),brandActor()))).not.toContain('子品牌');
    await f.service.setShow(1,1,brandActor());expect(JSON.stringify(await f.service.cascader(2,new URLSearchParams(),brandActor()))).toContain('子品牌');
  });
  it('creates three levels, enforces exact parent paths and rejects same-parent duplicates and cycles',async()=>{
    const root=await f.service.save(0,brandBody(),brandActor());const child=await f.service.save(0,brandBody({fid:[root.id]}),brandActor());
    const leaf=await f.service.save(0,brandBody({fid:[root.id,child.id]}),brandActor());
    await expect(f.service.save(0,brandBody({fid:[root.id,child.id,leaf.id]}),brandActor())).rejects.toThrow('三级');
    await expect(f.service.save(0,brandBody({fid:[child.id],brand_name:'伪造链'}),brandActor())).rejects.toThrow('真实层级');
    await expect(f.service.save(0,brandBody(),brandActor())).rejects.toThrow('已经存在');
    await expect(f.service.save(root.id,brandBody({fid:[root.id,child.id],brand_name:'循环'}),brandActor())).rejects.toThrow('后代');
  });
  it('moves an unreferenced subtree and recomputes all descendant paths atomically',async()=>{
    await f.service.save(2,brandBody({fid:[4],brand_name:'迁移子'}),brandActor());
    expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,2)))[0]).toMatchObject({pid:4,fid:'4'});
    expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,3)))[0]).toMatchObject({pid:2,fid:'4,2'});
    await expect(f.service.save(4,brandBody({fid:[1,2],brand_name:'过深'}),brandActor())).rejects.toThrow();
  });
  it('moves an in-use subtree and maintains only proved derived chains while preserving explicit selections and common history',async()=>{
    await f.db.insert(storeProduct).values([{id:80,brandId:3,brandCom:'1,2,3',price:'29.50'},{id:81,brandId:3,brandCom:'3'},{id:82,brandId:3,brandCom:'12,3'},{id:83,brandId:3,brandCom:''},{id:84,brandId:3,brandCom:'1,2,3'}]);
    await f.db.insert(storeProductRelation).values([{id:801,productId:80,type:2,relationId:1,status:0,addTime:1},{id:802,productId:80,type:2,relationId:2,status:0,addTime:2},{id:803,productId:80,type:2,relationId:3,status:1,addTime:3},{productId:81,type:2,relationId:3},{productId:82,type:2,relationId:12},{productId:82,type:2,relationId:3}]);
    await f.db.insert(storePromotionsAuxiliary).values({promotionsId:99,brandId:3});await f.db.insert(storeCouponIssue).values({id:99,couponType:3,brandId:'1,3'});await f.db.insert(storeProductCategoryBrand).values({productId:99,brandId:3});
    const before=await f.db.select().from(storeProduct).orderBy(storeProduct.id),relations=await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id);
    await f.service.save(2,brandBody({fid:[4],brand_name:'迁移子'}),brandActor());
    const after=await f.db.select().from(storeProduct).orderBy(storeProduct.id);
    expect(after.map(row=>[row.id,row.brandCom])).toEqual([[80,'4,2,3'],[81,'3'],[82,'12,3'],[83,''],[84,'4,2,3']]);
    expect(after.map(({brandCom,...row})=>row)).toEqual(before.map(({brandCom,...row})=>row));
    const next=await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id);
    for(const row of relations.filter(row=>row.id!==801))expect(next.find(item=>item.id===row.id)).toEqual(row);
    expect(next.filter(row=>row.productId===80).map(row=>row.relationId).sort()).toEqual([2,3,4]);expect(next.filter(row=>row.productId===84)).toEqual([]);
    expect((await f.db.select().from(storeCouponIssue))[0].brandId).toBe('1,3');expect((await f.db.select().from(systemLog)).find(row=>row.path.endsWith('move-products'))?.action).toBe(JSON.stringify({operation:'move-products',ids:[80,84]}));
  });
  it('rolls back a whole subtree when any affected product has ambiguous or inconsistent brand facts',async()=>{
    await f.db.insert(storeProduct).values([{id:80,brandId:3,brandCom:'1,2,3'},{id:81,brandId:3,brandCom:'3'}]);
    await f.db.insert(storeProductRelation).values({productId:81,type:2,relationId:2});
    await expect(f.service.save(2,brandBody({fid:[4]}),brandActor())).rejects.toMatchObject({code:409});
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,80)))[0].brandCom).toBe('1,2,3');expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,2)))[0].pid).toBe(1);expect(await f.db.select().from(systemLog)).toEqual([]);
    await f.db.delete(storeProductRelation);await f.db.update(storeProduct).set({brandCom:'0x03'}).where(eq(storeProduct.id,81));
    await expect(f.service.save(2,brandBody({fid:[4]}),brandActor())).rejects.toMatchObject({code:409});
  });
  it('detects trigger rewrites outside the sole product field authorized by a move',async()=>{
    await f.db.insert(storeProduct).values({id:80,brandId:3,brandCom:'1,2,3',price:'29.50'});
    await f.exec("CREATE FUNCTION rewrite_brand_product_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.price=1; RETURN NEW; END $$; CREATE TRIGGER rewrite_brand_product_fixture BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION rewrite_brand_product_fixture()");
    await expect(f.service.save(2,brandBody({fid:[4]}),brandActor())).rejects.toThrow('回执');expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,80)))[0]).toMatchObject({brandCom:'1,2,3',price:'29.50'});
    expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,2)))[0].pid).toBe(1);expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('protects active children and deletes a leaf with an exact soft-delete and audit receipt',async()=>{
    await expect(f.service.remove(1,brandActor())).rejects.toThrow('子品牌');await f.service.remove(12,brandActor());
    expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,12)))[0]).toMatchObject({isDel:1,isShow:0});
    await expect(f.service.remove(12,brandActor())).rejects.toThrow('不存在');
    expect((await f.db.select().from(systemLog))[0]).toMatchObject({method:'DELETE',type:'product_brand_catalog'});
  });
  it('protects each current, direct, historical, promotion and coupon reference without treating unrelated decimals as references',async()=>{
    await f.db.insert(storeProductRelation).values({productId:90,type:2,relationId:12});await expect(f.service.remove(12,brandActor())).rejects.toThrow('引用');await f.db.delete(storeProductRelation);
    await f.db.insert(storeProduct).values({id:90,brandId:12});await expect(f.service.remove(12,brandActor())).rejects.toThrow('引用');await f.db.update(storeProduct).set({brandId:0,brandCom:'012'}).where(eq(storeProduct.id,90));
    await expect(f.service.remove(12,brandActor())).rejects.toThrow('引用');await f.db.update(storeProduct).set({brandCom:'0, ,99999999999999,3,'}).where(eq(storeProduct.id,90));
    await f.db.insert(storeProductCategoryBrand).values({productId:900,brandId:12});await expect(f.service.remove(12,brandActor())).rejects.toThrow('历史辅助');await f.db.delete(storeProductCategoryBrand);
    await f.db.insert(storePromotionsAuxiliary).values({promotionsId:900,brandId:12});await expect(f.service.remove(12,brandActor())).rejects.toThrow('活动');await f.db.delete(storePromotionsAuxiliary);
    await f.db.insert(storeCouponIssue).values({id:900,couponType:3,brandId:'12'});await expect(f.service.remove(12,brandActor())).rejects.toThrow('优惠券');await f.db.delete(storeCouponIssue);
    await f.service.remove(12,brandActor());expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,12)))[0].isDel).toBe(1);
  });
  it('rejects foreign ownership and fresh role, password and expiry changes without writes',async()=>{
    await expect(f.service.save(8,brandBody(),brandActor())).rejects.toThrow('平台');await expect(f.service.remove(8,brandActor())).rejects.toThrow('平台');
    await expect(f.service.save(0,brandBody({fid:[8]}),brandActor())).rejects.toThrow('平台');await expect(f.service.save(0,brandBody(),brandActor(102))).rejects.toThrow('权限');
    await f.db.update(systemRole).set({rules:'user.view'}).where(eq(systemRole.id,1));await expect(f.service.save(0,brandBody(),brandActor())).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({pwd:'replaced'}).where(eq(systemAdmin.id,100));await expect(f.service.list(new URLSearchParams(),brandActor(100))).rejects.toThrow('凭据');
    await expect(f.service.list(new URLSearchParams(),{...brandActor(),expiresAt:1})).rejects.toThrow('过期');expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('preserves existing modern hierarchy fields and rejects malformed, fabricated-owner and Logo input',async()=>{
    await f.service.modernSave({id:3,brand_name:'现代三级'},brandActor());expect((await f.db.select().from(storeBrand).where(eq(storeBrand.id,3)))[0]).toMatchObject({pid:2,fid:'1,2'});
    for(const raw of [brandBody({store_id:7}),brandBody({pic:'x'}),brandBody({brand_name:'一二三四五六七八九十十'}),brandBody({fid:[1,0]}),brandBody({is_show:2})])expect(()=>parseProductBrandInput(raw)).toThrow();
    for(const q of ['pid=-1','pid=1&pid=2','page=1','store_id=7'])expect(()=>parseProductBrandQuery(new URLSearchParams(q))).toThrow();
    for(const type of ['',0,3,'any'])expect(()=>productBrandCatalogType(type)).toThrow();
    await expect(f.service.modernSave({brand_name:'无Logo',pic:'x'},brandActor())).rejects.toThrow('未知字段');
  });
  it('rolls back rewritten ownership and skipped audit callbacks instead of acknowledging a save',async()=>{
    await f.exec("CREATE FUNCTION rewrite_brand_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.store_id=7; RETURN NEW; END $$; CREATE TRIGGER rewrite_brand_fixture BEFORE INSERT ON store_brand FOR EACH ROW EXECUTE FUNCTION rewrite_brand_fixture()");
    await expect(f.service.save(0,brandBody(),brandActor())).rejects.toThrow('回执');expect(await f.db.select().from(storeBrand).where(eq(storeBrand.brandName,'新品牌'))).toEqual([]);
    await f.exec('DROP TRIGGER rewrite_brand_fixture ON store_brand');
    await f.exec("CREATE FUNCTION skip_brand_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_brand_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_brand_audit_fixture()");
    await expect(f.service.save(0,brandBody(),brandActor())).rejects.toThrow('审计');expect(await f.db.select().from(storeBrand).where(eq(storeBrand.brandName,'新品牌'))).toEqual([]);
  });
});
