/** Composes immutable real ORM reader fixture with the exact current privilege
 * intersection. App is SELECT-only; Admin keeps only its existing privileges.
 * This finite fixture is not production commissioning or a financial fixture. */
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import type { Env } from '../../src/env';
import { systemAdmin, systemRole, systemMenus, systemLog, systemDise, systemConfig, user, userRelation, systemUserLevel, memberRight,
  storeCart, storeProduct, storeProductAttr, storeProductAttrValue, storeProductCategory, storeProductRelation,
  storePromotions, storePromotionsAuxiliary,storeProductReply,community,communityRelevance,storeDiscounts,storeDiscountsProducts } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { AdminProductCategoryStyleService } from '../../src/services/admin/AdminProductCategoryStyleService';
import { ProductCategoryStyleReadService } from '../../src/services/content/ProductCategoryStyleReadService';
import { V2PublicCompatibilityService } from '../../src/services/content/V2PublicCompatibilityService';
import { StoreCategoryService } from '../../src/services/product/StoreCategoryService';
import { StoreProductService } from '../../src/services/product/StoreProductService';
import { integralProductReadFixture, observeIntegralReadDb } from './integralProductReadFixture';

export const categoryActor = { id: 7 };
export const observeCategoryDb = observeIntegralReadDb;
const bindings = { APP_KEY: 'owned-category-style-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
  CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } satisfies Pick<Env,'APP_KEY'|'UPSTASH_REDIS_URL'|'UPSTASH_REDIS_TOKEN'> &
  { CONFIG_KV: { get: () => Promise<null>; put: () => Promise<void>; delete: () => Promise<void> } };
// Unused external bindings are disabled. Values above retain their real types.
export const categoryEnv = bindings as unknown as Env;
const ident = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid category fixture identifier'); return `"${value}"`; };
export async function productCategoryStyleFixture() {
  const f = await integralProductReadFixture({ extraTables: [systemAdmin,systemRole,systemMenus,systemLog,userRelation,systemUserLevel,memberRight,
    storeCart,storeProductCategory,storeProductRelation,storePromotions,storePromotionsAuxiliary,storeProductReply,community,communityRelevance,storeDiscounts,storeDiscountsProducts] });
  try {
    await f.db.insert(systemDise).values([{ id: 2, templateName: 'ordinary', type: 1, isDiy: 1, value: '[]' },
      { id: 88, name: '商品分类', title: '商品分类布局', templateName: 'category', type: 3, status: 0, isShow: 0, isDel: 0,
        value: '{"level":2,"index":1,"opaque":{"note":"保留","number":1.25},"future":[true,null]}',
        content: 'preserved metadata', defaultValue: 'legacy-default', addTime: 1626055689, updateTime: 1726022341, version: 'legacy-v1' }]);
    await f.db.insert(systemConfig).values([{ id: 20, menuName: 'member_func_status', value: '1' },
      { id: 21, menuName: 'level_activate_status', value: '0' }, { id: 22, menuName: 'member_price_status', value: '1' },
      { id: 23, menuName: 'product_category_level', value: '0' }, { id: 24, menuName: 'category', value: '3' }]);
    await f.db.insert(systemUserLevel).values({ id: 1, name: '实际会员', grade: 1, discount: '88.50', isShow: 1, isDel: 0 });
    await f.db.update(user).set({ level: 1, levelStatus: 1 }).where(eq(user.uid, 11));
    await f.db.insert(memberRight).values({ rightType: 'vip_price', status: 1 });
    await f.db.update(storeProduct).set({ price: '20.00', vipPrice: '18.00', otPrice: '30.00', stock: 8, isVip: 1, brandId: 3,
      sliderImage: '["/api/assets/41","/legacy/gallery.png"]', deliveryType: '1,2', unitName: '件' }).where(eq(storeProduct.id,70));
    await f.db.update(storeProductAttrValue).set({ price: '20.00', vipPrice: '18.00', otPrice: '30.00', stock: 12, image: '/api/assets/41',
      cost: '11.00', settlePrice: '14.00', code: 'SECRET-CODE', diskInfo: 'SECRET-CARD', barCode: 'SECRET-BAR', brokerage: '5.00' }).where(eq(storeProductAttrValue.id,80));
    await f.db.update(storeProductAttrValue).set({ price: '30.00', vipPrice: '25.00', otPrice: '40.00', stock: 3, image: '/api/assets/43' }).where(eq(storeProductAttrValue.id,81));
    await f.db.insert(storeProductAttr).values({ id:2,productId:70,type:0,attrName:'颜色',attrValues:'["红","蓝"]' });
    await f.db.insert(storeProduct).values([
      { id:71,storeName:'另一个根',isVerify:1,price:'20.00',stock:7,image:'/legacy/71.png' },
      { id:72,type:1,relationId:77,pid:70,storeName:'门店副本',isVerify:1,price:'20.00',stock:8,image:'/api/assets/41' },
      { id:73,type:2,relationId:88,pid:70,storeName:'供应商副本',isVerify:1,price:'20.00',stock:8,image:'/api/assets/42' },
      { id:74,type:2,relationId:999,pid:70,storeName:'外属不公开',isVerify:1,price:'20.00',stock:8 },
      { id:75,storeName:'未审核',isVerify:0,price:'20.00',stock:8 },
    ]);
    await f.db.insert(storeProductCategory).values([
      { id:1,cateName:'根1',level:0,pid:0,sort:5,pic:'/api/assets/41' },
      { id:2,cateName:'二级',level:1,pid:1,path:'10',pic:'/api/assets/43' },
      { id:3,cateName:'三级',level:2,pid:2,path:'WRONG' },
      { id:10,cateName:'根10',level:0,pid:0,sort:1 },
      { id:11,cateName:'根10下级',level:1,pid:10,path:'1' },
      { id:20,cateName:'隐藏根',level:0,isShow:0 }, { id:21,cateName:'隐藏根下级',level:1,pid:20 },
      { id:30,cateName:'供应商分类',type:2,relationId:88,level:0 },
      { id:31,cateName:'挂外属父级',level:1,pid:30 },
      { id:40,cateName:'孤儿',level:1,pid:999 },
      { id:41,cateName:'循环A',level:1,pid:42 },{ id:42,cateName:'循环B',level:2,pid:41 },
    ]);
    await f.db.insert(storeProductRelation).values([{ productId:70,type:1,relationId:3 }, { productId:71,type:1,relationId:11 },
      { productId:72,type:1,relationId:2 },{ productId:73,type:1,relationId:3 },{ productId:74,type:1,relationId:3 },{ productId:75,type:1,relationId:3 }]);
    await f.db.insert(storeCart).values([{ uid:11,productId:70,productAttrUnique:'base0070',cartNum:2,status:1 },
      { uid:22,productId:70,productAttrUnique:'base0070',cartNum:99,status:1 },
      { uid:11,productId:70,productAttrUnique:'base0070',cartNum:80,status:1,isPay:1 },
      { uid:11,productId:70,productAttrUnique:'base0070',cartNum:70,status:1,type:4,activityId:9 }]);
    for (const table of f.tables) {
      const definition=getTableConfig(table);
      for (const column of definition.columns) if (['serial','bigserial'].includes(column.getSQLType()))
        await f.exec(`SELECT setval(pg_get_serial_sequence('public.${definition.name}','${column.name}'),GREATEST(COALESCE((SELECT MAX(${ident(column.name)}) FROM ${ident(definition.name)}),0),1),true)`);
    }
    type Peer = Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
    const installSlice = async (app:Peer,admin:Peer) => {
      await f.installSelectSlice(app,'app');
      const plan=runtimeBusinessPrivilegePlan('admin');
      for(const table of f.tables){
        const d=getTableConfig(table),privileges=plan.tables[d.name]; if(!privileges?.includes('SELECT')) throw Error(`Admin cannot read ${d.name}`);
        await f.exec(`GRANT ${privileges.join(',')} ON ${ident(d.name)} TO ${ident(admin.role)}`);
        const columns=plan.updateColumns[d.name]; if(columns?.length) await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON ${ident(d.name)} TO ${ident(admin.role)}`);
        if(privileges.includes('INSERT')) for(const c of d.columns) if(['serial','bigserial'].includes(c.getSQLType())){
          const [row]=await f.exec(`SELECT pg_get_serial_sequence('public.${d.name}','${c.name}') AS name`),parts=String(row.name).split('.');
          if(parts.length!==2||parts[0]!=='public') throw Error('Unexpected category sequence');
          await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(parts[1])} TO ${ident(admin.role)}`);
        }
      }
    };
    return { ...f,env:categoryEnv,installSlice,
      serviceFor:(db:DbClient=f.db)=>new AdminProductCategoryStyleService(createContainerFromDb(db)),
      readFor:(db:DbClient=f.db)=>new ProductCategoryStyleReadService(createContainerFromDb(db)),
      publicFor:(db:DbClient=f.db)=>new V2PublicCompatibilityService(createContainerFromDb(db),categoryEnv),
      categoryFor:(db:DbClient=f.db)=>new StoreCategoryService(createContainerFromDb(db),categoryEnv),
      productFor:(db:DbClient=f.db)=>new StoreProductService(createContainerFromDb(db),categoryEnv),
      settingsSnapshot:async()=>({rows:await f.db.select().from(systemDise).orderBy(systemDise.id),logs:await f.db.select().from(systemLog).orderBy(systemLog.id),configs:await f.db.select().from(systemConfig).orderBy(systemConfig.id)}) };
  }catch(error){await f.close();throw error;}
}
