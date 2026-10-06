/** Owned PG16 ORM-column slice + exact current production ACL intersection.
 * This does not commission all production tables or install new grants/DDL. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { articleCategory, pageCategory, pageLink, storeBargain, storeCombination, storeIntegral, storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription,
  storeProductCategory, storeProductRelation, storeSeckill, systemAdmin, systemArticle, systemAttachment,
  systemConfig, systemDise, systemMenus, systemRole, systemStore, systemSupplier } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { AdminFabLinkCatalogService } from '../../src/services/admin/AdminFabLinkCatalogService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
export const fabLinkTables = [pageCategory,pageLink,storeProduct,storeProductAttr,storeProductAttrValue,storeProductDescription,storeProductCategory,storeProductRelation,
  storeSeckill,storeBargain,storeCombination,storeIntegral,systemArticle,articleCategory,systemDise,
  systemAttachment,systemStore,systemSupplier,systemConfig,systemAdmin,systemRole,systemMenus];
export const fabLinkEnv = { APP_KEY: 'owned-fab-link-catalog-key' };
const identifier = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned FAB catalog identifier'); return `"${value}"`; };
export async function fabLinkCatalogFixture() {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('FAB catalog fixture requires isolated PG16'); }
  try {
    const dialect = new PgDialect();
    for (const table of fabLinkTables) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    await f.db.insert(pageCategory).values([{id:801,pid:0,type:'link',name:'Renamed public root'},
      {id:805,pid:801,type:'link',name:'Renamed links'}, {id:806,pid:801,type:'marketing_link',name:'Renamed marketing'},
      {id:899,pid:9999,type:'link',name:'Orphan category'}]);
    await f.db.insert(pageLink).values([{id:1,cateId:805,type:1,name:'首页',url:'/pages/index/index',sort:10},
      {id:2,cateId:805,type:3,name:'联系客服',url:'/pages/extension/customer_list/chat'},
      {id:3,cateId:805,type:2,name:'推广海报',url:'/pages/users/user_spread_code/index'},
      {id:4,cateId:806,type:4,name:'积分商城',url:'/pages/activity/points_mall/index'},
      {id:5,cateId:806,type:5,name:'已承接旧抽奖',url:'/pages/goods/lottery/grids/index?type=1'},
      {id:6,cateId:805,type:1,name:'坏链接',url:'javascript:alert(1)'},
      {id:7,cateId:805,type:1,name:'隐藏链接',url:'/pages/index/index',status:0},
      {id:8,cateId:899,type:1,name:'孤儿链接',url:'/pages/index/index'},
      {id:9,cateId:806,type:5,name:'未知历史营销目标',url:'/pages/removed/lottery/index'}]);
    await f.db.insert(storeProductCategory).values([{id:11,pid:0,cateName:'服装',type:0,relationId:0},
      {id:12,pid:11,cateName:'衬衫',type:0,relationId:0}, {id:13,pid:0,cateName:'隐藏',isShow:0},
      {id:14,pid:13,cateName:'隐藏祖先下'}, {id:15,pid:999,cateName:'孤儿'}, {id:16,pid:0,type:2,relationId:77,cateName:'供应商私有类目'}]);
    await f.db.insert(systemSupplier).values([{id:77,name:'可见供应商',isShow:1,isDel:0},{id:78,name:'隐藏供应商',isShow:0}]);
    await f.db.insert(storeProduct).values([{id:21,storeName:'普通商品',isVerify:1,image:'/api/assets/41',price:'10.00',keyword:'not-serialized',storeInfo:'private-info-21',barCode:'BASE-21',cost:'1.00'},
      {id:22,storeName:'预售商品',isVerify:1,isPresaleProduct:1,price:'20.00'},
      {id:23,storeName:'供应商商品',isVerify:1,type:2,relationId:77,image:'/api/assets/42',price:'30.00'},
      {id:24,storeName:'未审核',isVerify:0},{id:25,storeName:'隐藏',isVerify:1,isShow:0},
      {id:26,storeName:'删除',isVerify:1,isDel:1},{id:27,storeName:'隐藏供应商',isVerify:1,type:2,relationId:78},
      {id:28,storeName:'门店副本',isVerify:1,type:1,relationId:5,pid:21},
      {id:29,storeName:'会员商品',isVerify:1,isVipProduct:1,price:'40.00',vipPrice:'3.00'}]);
    await f.db.insert(storeProductAttrValue).values([
      {id:1,productId:22,type:0,unique:'SKU00022',barCode:'SKU-catalog-22'},
      {id:2,productId:21,type:1,unique:'ACT00021',barCode:'foreign-activity-code'},
      {id:3,productId:21,type:0,unique:'OLD00021',barCode:'retired-sku-code',isRetired:1},
    ]);
    await f.db.insert(storeProductRelation).values([{productId:21,type:1,relationId:12,relationPid:11},{productId:24,type:1,relationId:12}]);
    await f.db.insert(storeSeckill).values([{id:31,productId:21,storeName:'秒杀',image:'/api/assets/41',price:'5.00'},
      {id:32,productId:999,storeName:'孤儿秒杀'}, {id:33,productId:21,storeName:'未发布秒杀',status:0},
      {id:34,productId:23,type:0,relationId:0,storeName:'跨所有者秒杀'}]);
    await f.db.insert(storeBargain).values({id:41,productId:21,title:'砍价',price:'7.00'});
    await f.db.insert(storeCombination).values({id:51,productId:21,storeName:'拼团',price:'8.00'});
    await f.db.insert(storeIntegral).values({id:61,productId:21,storeName:'积分商品',price:'0.00'});
    await f.db.insert(articleCategory).values([{id:71,title:'公开文章分类'},{id:72,title:'隐藏分类',hidden:1}]);
    await f.db.insert(systemArticle).values([{id:81,cid:71,title:'文章',imageInput:'/api/assets/41',content:'secret body not in catalog'},
      {id:82,cid:72,title:'隐藏分类文章'}, {id:83,cid:999,title:'孤儿文章'}, {id:84,cid:71,title:'草稿',status:0}]);
    await f.db.insert(systemDise).values([{id:91,name:'已发布专题',type:2,status:1,isShow:0,value:'[]',coverImage:'/api/assets/41'},
      {id:92,name:'草稿专题',type:2,status:0,value:'[]'}, {id:93,name:'损坏专题',type:2,status:1,value:'{"secret":'},
      {id:94,name:'悬浮配置',templateName:'suspended_window',type:3,status:1,value:'{}'}]);
    await f.db.insert(systemAttachment).values([{attId:41,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,
      name:'attachments/admin/1/2026/10/owned.png',attDir:'/api/assets/41',attType:'image/png'},
      {attId:42,type:4,relationId:77,moduleType:1,fileType:1,imageType:8,name:'attachments/supplier/77/2026/10/owned.png',attDir:'/api/assets/42',attType:'image/png'}]);
    const installSlice = async (app: Peer, admin: Peer) => {
      for (const [kind, peer] of [['app',app],['admin',admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for(const table of fabLinkTables) {
          const definition = getTableConfig(table), privileges = plan.tables[definition.name];
          if(!privileges?.includes('SELECT')) throw Error(`${kind} has no production SELECT on ${definition.name}`);
          await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          const columns = plan.updateColumns[definition.name];
          if(columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          if(privileges.includes('INSERT')) for(const column of definition.columns) if(['serial','bigserial'].includes(column.getSQLType())) {
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
            const sequence = String(row.name).split('.'); if(sequence.length!==2 || sequence[0]!=='public') throw Error('Unexpected owned catalog sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
          }
        }
      }
    };
    return { ...f, env:fabLinkEnv, tables:fabLinkTables, installSlice,
      serviceFor:(db:DbClient=f.db)=>new AdminFabLinkCatalogService(createContainerFromDb(db),fabLinkEnv),
      snapshot:async()=>({links:await f.db.select().from(pageLink).orderBy(pageLink.id),categories:await f.db.select().from(pageCategory).orderBy(pageCategory.id),diy:await f.db.select().from(systemDise).orderBy(systemDise.id)}),
      withRuntimeRole:f.withRuntimeRole,withPeer:f.withPeer };
  } catch(error) { await f.close(); throw error; }
}
