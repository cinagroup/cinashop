import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeCart,storeOrder,storeOrderCartInfo,storeProduct,storeProductAttr,storeProductAttrValue,systemStore,systemSupplier } from '../src/models/schema';
import { StoreProductService } from '../src/services/product/StoreProductService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { productCategoryStyleFixture,observeCategoryDb } from './helpers/productCategoryStyleFixture';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
type Fixture=Awaited<ReturnType<typeof productCategoryStyleFixture>>;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real public category tree/filter and safe SKU consumption',()=>{
  let f:Fixture,fetchGuard:ReturnType<typeof vi.spyOn>;
  beforeEach(async()=>{fetchGuard=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider/media HTTP in category read'));f=await productCategoryStyleFixture();},30000);
  afterEach(async()=>{try{expect(fetchGuard).not.toHaveBeenCalled();}finally{fetchGuard?.mockRestore();await f?.close();}},30000);
  it('returns only safe platform branches with actual parents and owner checked images, including id1 versus id10',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');const before=await f.snapshot(),tree=await f.categoryFor(app.db).getCategory();
    expect(tree.map(row=>row.id)).toEqual([1,10]);expect(tree[0].pic).toMatch(/^\/api\/assets\/41\?/);expect(tree[0].children.map(row=>row.id)).toEqual([2]);expect(tree[0].children[0].pic).toBe('');expect(tree[0].children[0].children.map(row=>row.id)).toEqual([3]);
    expect(await f.categoryFor(app.db).getLevelCategory(2)).toEqual(tree[0].children);expect(JSON.stringify(tree)).not.toMatch(/隐藏|供应商分类|循环|孤儿|挂外属/);expect(await f.snapshot()).toEqual(before);
  });});
  it('filters cid descendants, sid children and tid exact relation without stale CSV paths or tenant leakage',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');const service=f.productFor(app.db);
    const ids=(rows:Record<string,unknown>[])=>rows.map(row=>Number(row.id)).sort((a,b)=>a-b);
    expect(ids((await service.getGoodsList({cid:1},0)).list)).toEqual([70,72,73]);expect(ids((await service.getGoodsList({cid:10},0)).list)).toEqual([71]);
    expect(ids((await service.getGoodsList({cid:1,sid:2,tid:3},0)).list)).toEqual([70,73]);expect((await service.getGoodsList({cid:1,selectId:3},0)).count).toBe(2);
    for(const query of[{cid:30},{sid:21},{tid:42},{cid:10,sid:2},{cid:1,sid:2,tid:11},{cid:999}])await expect(service.getGoodsList(query,0)).rejects.toThrow();
    const card=(await service.getGoodsList({cid:1},11)).list.find(row=>row.id===70)!;expect(card).toMatchObject({brand_name:'真实品牌',cart_num:2,spec_type:1,cart_button:1});expect(card.image).toMatch(/^\/api\/assets\/41\?/);expect(JSON.stringify(card)).not.toMatch(/SECRET|settle_price|disk_info|"cost"/);
  });});
  it('returns actual safe dimensions, exact member quotes and actor cart quantities without cost/card/commission fields',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');const before=await f.snapshot(),result=await f.productFor(app.db).getProductDetail(70,11),skus=result.attr_value as Record<string,unknown>[];
    expect(result.productAttr).toEqual([{attr_name:'颜色',attr_values:['红','蓝']}]);expect(result).toMatchObject({id:70,stock:8,price:'20.00',cart_button:1,cart_num:2,brand_name:'真实品牌'});
    expect(skus[0]).toMatchObject({id:80,unique:'base0070',suk:'红',price:'20.00',member_price:'17.60',price_type:'level',level_name:'实际会员',stock:8,cart_num:2,purchasable:true});expect(skus[0].image).toMatch(/^\/api\/assets\/41\?/);
    expect(skus[1]).toMatchObject({stock:3,cart_num:0,image:'',small_image:''});expect(JSON.stringify(result)).not.toMatch(/SECRET|"cost"|"settlePrice"|"settle_price"|"barCode"|"code"|"diskInfo"|"brokerage"/);expect(await f.snapshot()).toEqual(before);
    const guest=(await f.productFor(app.db).getProductDetail(70,0)).attr_value as Record<string,unknown>[];expect(guest).toHaveLength(2);expect(guest[0]).toMatchObject({id:80,price:'20.00',member_price:'20.00',price_type:'',stock:8});expect(guest[1]).toMatchObject({id:81,price:'30.00',member_price:'30.00',price_type:'',stock:3});
  });});
  it('keeps zero stock readable and disables inline purchase for presale, custom form and each special product type',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');const service=f.productFor(app.db);
    await f.db.update(storeProduct).set({stock:0}).where(eq(storeProduct.id,70));let result=await service.getProductDetail(70,0);expect(result.price).toBe('20.00');expect(result.attr_value).toMatchObject([{stock:0,purchasable:false},{stock:0,purchasable:false}]);
    for(const patch of[{isPresaleProduct:1},{systemFormId:3},{customForm:'[{"field":"required"}]'},{productType:1},{productType:2},{productType:3},{productType:4}]){
      await f.db.update(storeProduct).set({stock:8,isPresaleProduct:0,systemFormId:0,customForm:'[]',productType:0,...patch}).where(eq(storeProduct.id,70));await f.db.update(storeProductAttrValue).set({productType:patch.productType??0}).where(eq(storeProductAttrValue.productId,70));
      result=await service.getProductDetail(70,0);expect(result.cart_button).toBe(0);expect(result.attr_value).toMatchObject([{purchasable:false},{purchasable:false}]);
      expect((await service.getGoodsList({ids:'70'},0)).list[0].cart_button).toBe(0);
    }
  });});
  it('rejects malformed dimensions, ambiguous or mismatched active SKU identities and bounded capacities without fallback',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');const service=f.productFor(app.db);
    await f.db.update(storeProductAttr).set({attrValues:'["bad"'}).where(eq(storeProductAttr.productId,70));await expect(service.getProductDetail(70,0)).rejects.toThrow('JSON');
    await f.db.update(storeProductAttr).set({attrValues:'红,蓝'}).where(eq(storeProductAttr.productId,70));expect((await service.getProductDetail(70,0)).productAttr).toEqual([{attr_name:'颜色',attr_values:['红','蓝']}]);
    await f.db.update(storeProductAttrValue).set({suk:'未声明'}).where(eq(storeProductAttrValue.id,80));await expect(service.getProductDetail(70,0)).rejects.toThrow('维度');
    await f.db.update(storeProductAttrValue).set({suk:'红',unique:'blue0070'}).where(eq(storeProductAttrValue.id,80));await expect(service.getProductDetail(70,0)).rejects.toThrow('身份');
    await f.db.update(storeProductAttrValue).set({unique:'base0070',price:'-1.00'}).where(eq(storeProductAttrValue.id,80));await expect(service.getProductDetail(70,0)).rejects.toThrow('报价');
    await f.db.delete(storeProductAttr).where(eq(storeProductAttr.productId,70));await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.productId,70));
    await f.db.insert(storeProductAttrValue).values(Array.from({length:501},(_,i)=>({productId:70,type:0,unique:String(i+1).padStart(8,'0'),suk:`SKU${i}`,price:'20.00',stock:1})));
    await expect(service.getProductDetail(70,0)).rejects.toThrow('容量');
  });});
  it('requires published owners and platform parents; retired rows never regain purchase authority',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');const service=f.productFor(app.db);
    for(const patch of[{isShow:0},{isDel:1},{isVerify:0}]){await f.db.update(storeProduct).set({isShow:1,isDel:0,isVerify:1,...patch}).where(eq(storeProduct.id,70));await expect(service.getProductDetail(72,0)).rejects.toThrow('下架');await expect(service.getProductDetail(73,0)).rejects.toThrow('下架');}
    await f.db.update(storeProduct).set({isShow:1,isDel:0,isVerify:1}).where(eq(storeProduct.id,70));await f.db.update(systemStore).set({isShow:0}).where(eq(systemStore.id,77));await expect(service.getProductDetail(72,0)).rejects.toThrow();
    await f.db.update(systemSupplier).set({isDel:1}).where(eq(systemSupplier.id,88));await expect(service.getProductDetail(73,0)).rejects.toThrow();await expect(service.getProductDetail(74,0)).rejects.toThrow();await expect(service.getProductDetail(75,0)).rejects.toThrow();
    await f.db.update(storeProductAttrValue).set({isRetired:1}).where(eq(storeProductAttrValue.id,80));expect((await service.getProductDetail(70,0)).attr_value).toHaveLength(1);
  });});
  it('keeps category/SKU/media/member reads in one RR readonly snapshot while a separate writer changes stocks',async()=>{await f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');let observed=false;
    const db=observeCategoryDb(app.db,async(tx,command)=>{if(!observed&&command.includes('from "store_product"')){observed=true;expect((await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly`))[0].readonly).toBe('on');await f.withPeer(async peer=>{await peer.db.update(storeProductAttrValue).set({stock:0,price:'99.00'}).where(eq(storeProductAttrValue.id,80));});}});
    const old=await f.productFor(db).getProductDetail(70,11);expect((old.attr_value as Record<string,unknown>[])[0]).toMatchObject({stock:8,price:'20.00',member_price:'17.60'});expect(observed).toBe(true);
    const fresh=(await f.productFor(app.db).getProductDetail(70,11)).attr_value as Record<string,unknown>[];expect(fresh).toHaveLength(2);expect(fresh[0]).toMatchObject({id:80,stock:0,price:'99.00',member_price:'87.12',purchasable:false});expect(fresh[1]).toMatchObject({id:81,stock:3,price:'30.00',member_price:'26.40',purchasable:true});
  });});
  it('uses a real migrated current-commissioned App LOGIN for SKU cart increments, edits, deletion and checkout quote',async()=>{
    const whole=await refundRuntimeFixture();try{const roles=whole.withRuntimeRole;if(!roles)throw Error('Real runtime LOGIN required');await roles(app=>roles(async admin=>{
      const[database]=await whole.db.execute(sql`SELECT current_database() AS name`),names={database:String(database.name),maintenance:'finance_test',app:app.role,admin:admin.role,pricingOwner:whole.pricingOwner};await runRuntimeBusinessCommissioning(whole.db,names);
      expect(await auditRuntimeBusinessPrivileges(app.db,'app',names)).toMatchObject({ready:true,failures:[]});expect((await app.exec('SELECT current_user,session_user'))[0]).toEqual({current_user:app.role,session_user:app.role});
      await whole.db.update(storeProduct).set({isVerify:1}).where(eq(storeProduct.id,70));await whole.exec("SELECT setval(pg_get_serial_sequence('store_cart','id'),(SELECT MAX(id) FROM store_cart),true)");
      const container=createContainerFromDb(app.db),read=new StoreProductService(container,whole.env),cart=new StoreCartService(container,whole.env),detail=await read.getProductDetail(70,11),sku=(detail.attr_value as Record<string,unknown>[])[0];
      expect(sku.unique).toBe('qared001');const added=await cart.add({uid:11,productId:70,unique:String(sku.unique),cartNum:1,type:0});expect(added.cartNum).toBe(1);
      await cart.setNum(11,added.id,3);expect((await read.getProductDetail(70,11)).attr_value).toMatchObject([{cart_num:3}]);await expect(cart.setNum(11,added.id,32768)).rejects.toThrow();
      const created=await StoreOrderCreateService.createWithRuntime(container,{CONFIG_KV:whole.env.CONFIG_KV,nextOrderId:async()=> 'category_actual_checkout'},{uid:11,key:'category_actual_quote',cartIds:[added.id],addressId:11,userIp:'127.0.0.1',useIntegral:false});
      const[order]=await whole.db.select().from(storeOrder).where(eq(storeOrder.orderId,created.orderId));expect(order).toMatchObject({uid:11,paid:0,status:0});
      expect((await whole.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id))).map(row=>({productId:row.productId,cartNum:row.cartNum}))).toEqual([{productId:70,cartNum:3}]);
      const second=await cart.add({uid:11,productId:70,unique:String(sku.unique),cartNum:1,type:0});await cart.del(11,[second.id]);expect((await whole.db.select().from(storeCart).where(eq(storeCart.id,second.id)))[0].isDel).toBe(1);
    }));}finally{await whole.close();}
  },120000);
});
