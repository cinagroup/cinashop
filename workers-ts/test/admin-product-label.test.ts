import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProduct,storeProductRelation,systemAdmin,systemRole,systemAttachment,systemLog} from '@/models/schema';
import {labelActor,labelBody,productLabelFixture} from './helpers/adminProductLabels';
import {parseLabelBatch,parseProductLabelInput,parseProductLabelQuery} from '@/services/admin/AdminProductLabelInput';
describe('complete platform product label and group contracts',()=>{
  let f:Awaited<ReturnType<typeof productLabelFixture>>;
  beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));f=await productLabelFixture();},30000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  it('returns complete scoped group/list/tree/all/form contracts in one snapshot',async()=>{
    const groups=await f.service.categoryList(new URLSearchParams(),labelActor());
    expect(groups.count).toBe(3);expect(groups.list.map(row=>row.id)).toEqual([2,3,1]);
    expect(groups.list[0].product_label.map(row=>row.id)).toEqual([10,11]);
    const list=await f.service.list(new URLSearchParams('label_cate=2&limit=1&page=2'),labelActor());
    expect(list.count).toBe(2);expect(list.list[0]).toMatchObject({id:11,type:0,relation_id:0,status:0,is_show:0,style_type:1});
    expect((await f.service.list(new URLSearchParams('label_cate=2'),labelActor())).list[0].add_time).toBe('1970-01-01 08:00:01');
    expect((await f.service.categoryList(new URLSearchParams('name=旧标签'),labelActor())).list.map(row=>row.id)).toEqual([2]);
    const tree=await f.service.tree(new URLSearchParams(),labelActor(103));
    expect(tree[0].children[0]).toMatchObject({value:10,label:'旧标签'});
    expect((await f.service.all(new URLSearchParams(),labelActor())).length).toBe(4);
    expect(await f.service.categoryForm(2,new URLSearchParams(),labelActor())).toMatchObject({method:'PUT',action:'product/label_cate/2'});
    expect((await f.service.form(new URLSearchParams(),labelActor())).rules[0].options).toEqual(expect.arrayContaining([{label:'常用',value:2}]));
    expect(JSON.stringify(groups)).not.toContain('秘密');expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('creates, edits and deletes an empty group with duplicate and default protection',async()=>{
    const created=await f.service.saveCategory(0,{name:'新分组',sort:3},labelActor());
    await expect(f.service.saveCategory(0,{name:'新分组',sort:0},labelActor())).rejects.toThrow('已存在');
    await f.service.saveCategory(created.id,{name:'更名',sort:4},labelActor());
    expect((await f.db.select().from(legacyCategory).where(eq(legacyCategory.id,created.id)))[0]).toMatchObject({name:'更名',group:2,type:0,relationId:0});
    await expect(f.service.deleteCategory(1,labelActor())).rejects.toThrow('默认');
    await expect(f.service.deleteCategory(2,labelActor())).rejects.toThrow('有标签');
    await f.service.deleteCategory(created.id,labelActor());expect(await f.db.select().from(legacyCategory).where(eq(legacyCategory.id,created.id))).toEqual([]);
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['POST','PUT','DELETE']);
  });
  it('saves all presentation fields and moves groups while keeping duplicate scope exact',async()=>{
    const first=await f.service.save(0,labelBody(),labelActor());
    await expect(f.service.save(0,labelBody(),labelActor())).rejects.toThrow('已经存在');
    const other=await f.service.save(0,labelBody({label_cate:3}),labelActor());
    await f.service.save(first.id,labelBody({label_cate:1,label_name:'改名',color:'rgba(1,2,3,0.5)',is_show:0,status:0}),labelActor());
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,first.id)))[0]).toMatchObject({labelCate:1,labelName:'改名',color:'rgba(1,2,3,0.5)',isShow:0,status:0,sort:7});
    expect(other.id).not.toBe(first.id);
    await f.service.deleteLabel(first.id,labelActor());await f.service.deleteLabel(other.id,labelActor());
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['POST','POST','POST','DELETE','DELETE']);
  });
  it('keeps enablement and mobile display independent and preserves protected defaults',async()=>{
    await f.service.setFlag(10,0,'status',labelActor());expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,10)))[0]).toMatchObject({status:0,isShow:1});
    await f.service.setFlag(10,0,'isShow',labelActor());await f.service.setFlag(10,1,'status',labelActor());
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,10)))[0]).toMatchObject({status:1,isShow:0});
    await expect(f.service.deleteLabel(1,labelActor())).rejects.toThrow('默认标签');
    expect(await f.service.batchDelete({ids:[1,11],all:0,where:''},labelActor())).toEqual({ids:[11],protected_ids:[1],count:1});
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,1))).length).toBe(1);
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['PUT','PUT','PUT','PUT']);
  });
  it('rejects foreign ownership, unrelated groups and all historical reference generations atomically',async()=>{
    await expect(f.service.save(20,labelBody(),labelActor())).rejects.toThrow('平台');
    await expect(f.service.save(0,labelBody({label_cate:4}),labelActor())).rejects.toThrow('分组不存在');
    await expect(f.service.saveCategory(5,{name:'不能改模板',sort:0},labelActor())).rejects.toThrow('分组不存在');
    await f.db.insert(storeProductLabelAuxiliary).values({labelId:10,productId:999});
    await expect(f.service.batchDelete({ids:[10,11]},labelActor())).rejects.toThrow('历史辅助引用');
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,11))).length).toBe(1);
    await f.db.delete(storeProductLabelAuxiliary);
    await f.db.insert(storeProductRelation).values({productId:88,relationId:10,type:3});
    await expect(f.service.deleteLabel(10,labelActor())).rejects.toThrow('引用');await f.db.delete(storeProductRelation);
    await f.db.insert(storeProduct).values({id:88,storeLabelId:' 10 ',isDel:0});
    await expect(f.service.deleteLabel(10,labelActor())).rejects.toThrow('引用');
    await f.db.update(storeProduct).set({storeLabelId:'010'}).where(eq(storeProduct.id,88));
    await expect(f.service.deleteLabel(10,labelActor())).rejects.toThrow('引用');
    await f.db.update(storeProduct).set({storeLabelId:'+10'}).where(eq(storeProduct.id,88));
    await expect(f.service.deleteLabel(10,labelActor())).rejects.toThrow('引用');
    await f.db.update(storeProduct).set({storeLabelId:'0x0a'}).where(eq(storeProduct.id,88));
    await expect(f.service.deleteLabel(10,labelActor())).rejects.toThrow('引用');
    await f.db.update(storeProduct).set({storeLabelId:'1e1'}).where(eq(storeProduct.id,88));
    await expect(f.service.deleteLabel(10,labelActor())).rejects.toThrow('引用');
    await f.db.update(storeProduct).set({storeLabelId:'0, ,99999999999999,11,'}).where(eq(storeProduct.id,88));
    await expect(f.service.deleteLabel(11,labelActor())).rejects.toThrow('引用');
    await f.service.deleteLabel(10,labelActor());
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,11))).length).toBe(1);
  });
  it('saves durable authorized image references and renders fresh public previews',async()=>{
    await f.db.insert(systemAttachment).values([{attId:100,name:'attachments/admin/1/label.png',attDir:'/api/assets/100',imageType:8,fileType:1,moduleType:1,attType:'image/png',type:1,relationId:0},
      {attId:101,name:'attachments/supplier/77/secret.png',attDir:'/api/assets/101',imageType:8,fileType:1,moduleType:1,type:4,relationId:77}]);
    const saved=await f.service.save(0,labelBody({style_type:2,icon:'/api/assets/100?expires=1&signature=copied'}),labelActor());
    const list=await f.service.list(new URLSearchParams('label_cate=2'),labelActor());const row=list.list.find(row=>row.id===saved.id)!;
    expect(row.icon).toBe('/api/assets/100');expect(row.icon_preview).toMatch(/^\/api\/assets\/100\?expires=\d+&signature=/);
    await expect(f.service.save(0,labelBody({label_name:'异域图片',style_type:2,icon:'/api/assets/101'}),labelActor())).rejects.toThrow('不属于平台');
    await expect(f.service.save(0,labelBody({style_type:2,icon:'/adminapi/assets/100?ticket=x'}),labelActor())).rejects.toThrow();
  });
  it('requires fresh write authority and accepts exact numeric selection capability',async()=>{
    await expect(f.service.save(0,labelBody(),labelActor(102))).rejects.toThrow('权限');
    await expect(f.service.form(new URLSearchParams(),labelActor(103))).rejects.toThrow('权限');
    expect((await f.service.all(new URLSearchParams(),labelActor(106))).length).toBe(4);
    await f.db.update(systemRole).set({rules:'user.view'}).where(eq(systemRole.id,1));
    await expect(f.service.save(0,labelBody(),labelActor())).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({relationId:77}).where(eq(systemAdmin.id,100));
    await expect(f.service.list(new URLSearchParams(),labelActor(100))).rejects.toThrow('身份');
  });
  it('rejects malformed and unbounded input without granting client ownership or raw predicates',()=>{
    for(const body of [labelBody({type:2}),labelBody({label_cate:0}),labelBody({status:2}),labelBody({style_type:3}),labelBody({color:'url(javascript:x)'}),labelBody({label_name:' '}),labelBody({icon:'https://example.test/a.png?expires=1'})])expect(()=>parseProductLabelInput(body)).toThrow();
    for(const query of ['page=0','page=1&page=2','limit=101','page=102&limit=100','type=2'])expect(()=>parseProductLabelQuery(new URLSearchParams(query))).toThrow();
    for(const body of [{ids:[]},{ids:[-1]},{ids:[11],all:1},{all:1,where:{type:2}},{ids:Array.from({length:51},(_,i)=>i+1)}])expect(()=>parseLabelBatch(body)).toThrow();
  });
  it('routes legacy and modern writes through the same group, scope and presentation checks',async()=>{
    const saved=await f.service.modernSave({labelName:'现代',labelCate:2,color:'#abc',sort:3},labelActor());
    await f.service.modernSave({id:saved.id,labelName:'现代改名'},labelActor());
    expect((await f.service.modernList(new URLSearchParams(),labelActor())).find(row=>row.id===saved.id)).toMatchObject({labelCate:2,labelName:'现代改名',color:'#abc'});
    await expect(f.service.modernSave({id:20,labelName:'跨域'},labelActor())).rejects.toThrow('平台');
    await expect(f.service.modernSave({id:12,labelName:'未修复历史'},labelActor())).rejects.toThrow('ID错误');
  });
  it('rolls back a database rewrite or skipped audit instead of reporting a false successful save',async()=>{
    await f.exec(`CREATE FUNCTION rewrite_label_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.type=2; RETURN NEW; END $$;
      CREATE TRIGGER rewrite_label_fixture BEFORE INSERT ON store_product_label FOR EACH ROW EXECUTE FUNCTION rewrite_label_fixture()`);
    await expect(f.service.save(0,labelBody(),labelActor())).rejects.toThrow('回执');
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.labelName,'新品'))).length).toBe(0);
    await f.exec('DROP TRIGGER rewrite_label_fixture ON store_product_label');
    await f.exec(`CREATE FUNCTION skip_label_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_label_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_label_audit_fixture()`);
    await expect(f.service.save(0,labelBody(),labelActor())).rejects.toThrow('审计回执');
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.labelName,'新品'))).length).toBe(0);
  });
});
