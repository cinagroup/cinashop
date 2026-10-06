/** Current genuine LOGIN slices; no global fixture grants or commissioning are
 * changed. Actual ordinary/read tables are shared with the immutable catalogue
 * fixture, and mutation privileges are its current production intersection. */
import {eq,sql,SQL} from 'drizzle-orm';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {createContainerFromDb,type DbClient} from '../../src/lib/di';
import {systemDise,storeProduct,storeProductDescription,storeProductEnsure,storeProductReply,community,communityRelevance,storeDiscounts,storeDiscountsProducts,systemConfig,storeCombination,storeCouponIssue,storeCouponProduct,systemAttachment,storeNewcomer,storeProductAttrValue,storeSeckill,storeActivity,storeSeckillTime,storePink,storeOrder,storeOrderRefund} from '../../src/models/schema';
import {cloneProductDetailDesign} from '../../../view/common/productDetailDesign';
import {AdminProductDetailDesignService} from '../../src/services/admin/AdminProductDetailDesignService';
import {productCategoryStyleFixture,categoryEnv} from './productCategoryStyleFixture';
export const detailDesignEnv={...categoryEnv,PUBLIC_H5_ORIGIN:'https://shop.example.com'};
export async function productDetailDesignFixture(){
  const f=await productCategoryStyleFixture();
  try{
    // One real activity entry is covered independently of the ordinary reader.
    const dialect=new PgDialect(),quote=(name:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Invalid detail fixture identifier');return `"${name}"`;};
    for(const table of[storeCombination,storeCouponIssue,storeCouponProduct,storeNewcomer,storeSeckill,storeActivity,storeSeckillTime,storePink,storeOrder,storeOrderRefund]){
      const definition=getTableConfig(table),columns=definition.columns.map(column=>{const value=column.default,initial=value===undefined?'':` DEFAULT ${value instanceof SQL?dialect.sqlToQuery(value).sql:dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;return `${quote(column.name)} ${column.getSQLType()}${initial}${column.notNull?' NOT NULL':''}${column.primary?' PRIMARY KEY':''}`;});
      await f.exec(`CREATE TABLE public.${quote(definition.name)} (${columns.join(',')})`);f.tables.push(table);
    }
    await f.db.insert(storeCombination).values({id:401,productId:70,type:0,relationId:0,storeName:'真实拼团详情',image:'/api/assets/41',images:'["/api/assets/41","/api/assets/43"]',price:'15.00',stock:8,quota:7,onceNum:3,num:8,people:2,status:1,isShow:1,isDel:0,specs:'[{"name":"活动参数","value":"活动"}]',ensureId:'2'});
    await f.db.insert(storeSeckillTime).values({id:1,startTime:'0000',endTime:'2400',status:1});
    await f.db.insert(storeSeckill).values({id:601,productId:70,type:0,relationId:0,storeName:'真实秒杀详情',image:'/api/assets/41',images:'["/api/assets/41","/api/assets/43"]',price:'8.25',stock:8,quota:7,onceNum:3,num:8,timeId:'1',status:1,isShow:1,isDel:0,specs:'[{"name":"活动参数","value":"活动"}]',ensureId:'2'});
    await f.db.insert(storeProductAttrValue).values([
      {id:601,productId:601,type:1,unique:'seck0601',suk:'红',stock:6,quota:5,price:'8.25',otPrice:'20.00',image:'/api/assets/41',cost:'7.00',diskInfo:'PRIVATE CARD'},
      {id:602,productId:601,type:1,unique:'seck0602',suk:'蓝',stock:6,quota:5,price:'9.25',otPrice:'30.00',image:'/api/assets/43',diskInfo:'PRIVATE CARD'},
      {id:401,productId:401,type:3,unique:'comb0401',suk:'红',stock:6,quota:5,price:'15.00',otPrice:'20.00',image:'/api/assets/41',diskInfo:'PRIVATE CARD'},
    ]);
    await f.db.insert(storeProductDescription).values([{productId:601,type:1,description:'<p>秒杀公开正文<img src="/api/assets/41"><img src="/api/assets/43"></p><script>PRIVATE XSS</script>'},
      {productId:401,type:3,description:'<p>拼团公开正文<img src="/api/assets/41"></p><script>PRIVATE XSS</script>'}]);
    await f.db.insert(storeNewcomer).values({id:701,productId:70,type:0,relationId:0,price:'9.00',isDel:0});
    await f.db.insert(storeProductAttrValue).values({id:701,productId:701,type:7,unique:'new00701',suk:'红',stock:8,price:'9.00',image:'/api/assets/43',cost:'7.00',diskInfo:'PRIVATE NEWCOMER CARD'});
    const value={...cloneProductDetailDesign(),isOpen:[3,4,5,1,2,0],opaque:{number:1.25,note:'完整扩展保留'},future:[true,null]};
    await f.db.update(systemDise).set({value:JSON.stringify(value),status:0,isShow:0,version:'legacy-design',addTime:100,updateTime:200,content:'PRIVATE OPAQUE METADATA'}).where(eq(systemDise.id,5));
    await f.db.update(storeProduct).set({ensureId:'2,55',specs:JSON.stringify([{name:'材质',value:'棉',sort:1}]),recommendList:'71,76',videoOpen:1,videoLink:'https://media.example.com/video.mp4'}).where(eq(storeProduct.id,70));
    await f.db.update(storeProductDescription).set({description:'<p>公开正文<img src="/api/assets/41"><img src="/api/assets/43" onerror="alert(1)"></p><script>PRIVATE-XSS</script>'}).where(eq(storeProductDescription.productId,70));
    await f.db.insert(storeProductEnsure).values({id:55,type:2,relationId:89,name:'外国保障',image:'/api/assets/43',desc:'PRIVATE FOREIGN ENSURE',status:1});
    await f.db.insert(systemAttachment).values([
      {attId:111,type:1,relationId:0,moduleType:1,fileType:2,imageType:8,name:'attachments/admin/1/2026/10/detail.mp4',attDir:'/api/assets/111',attType:'video/mp4'},
      {attId:112,type:4,relationId:89,moduleType:1,fileType:2,imageType:8,name:'attachments/supplier/89/2026/10/foreign.mp4',attDir:'/api/assets/112',attType:'video/mp4'},
      {attId:113,type:1,relationId:0,moduleType:1,fileType:2,imageType:8,name:'attachments/admin/1/2026/10/not-video.mp4',attDir:'/api/assets/113',attType:'text/html'},
    ]);
    await f.db.insert(storeProductReply).values([{id:101,productId:70,uid:11,nickname:'真实买家',comment:'公开评价',sku:'红',productScore:5,serviceScore:5,deliveryScore:5,status:1,isDel:0,addTime:4},
      {id:102,productId:70,uid:11,comment:'第二条',productScore:1,serviceScore:1,deliveryScore:1,status:1,isDel:0,addTime:3},
      {id:103,productId:70,uid:11,comment:'PRIVATE HIDDEN REPLY',status:0,isDel:0},{id:104,productId:71,uid:11,comment:'OTHER PRODUCT REPLY',status:1,isDel:0}]);
    await f.db.insert(community).values([{id:201,type:2,relationId:11,title:'公开晒单',content:'晒单内容',status:1,isVerify:1,isDel:0,addTime:3},
      {id:202,type:2,relationId:11,title:'下一晒单',status:1,isVerify:1,isDel:0,addTime:2},{id:203,title:'PRIVATE UNVERIFIED POST',status:1,isVerify:0,isDel:0},
      {id:204,title:'OTHER PRODUCT POST',status:1,isVerify:1,isDel:0},{id:205,title:'PRIVATE DELETED POST',status:1,isVerify:1,isDel:1}]);
    await f.db.insert(communityRelevance).values([{leftId:201,rightId:70,type:'community_product'},{leftId:201,rightId:70,type:'community_product'},
      {leftId:202,rightId:70,type:'community_product'},{leftId:203,rightId:70,type:'community_product'},{leftId:204,rightId:71,type:'community_product'},{leftId:205,rightId:70,type:'community_product'},{leftId:204,rightId:70,type:'other'}]);
    await f.db.insert(storeDiscounts).values([{id:301,title:'公开套餐',status:1,isDel:0,image:'/api/assets/41',sort:9},{id:302,title:'第二套餐',status:1,isDel:0,sort:8},{id:303,title:'隐藏套餐',status:0,isDel:0}]);
    await f.db.insert(storeDiscountsProducts).values([{discountId:301,productId:70},{discountId:301,productId:71},{discountId:302,productId:70},{discountId:303,productId:70}]);
    await f.db.insert(systemConfig).values({menuName:'site_url',value:'"https://wrong-api.example.com"',sort:999});
    return {...f,env:detailDesignEnv,designFor:(db:DbClient=f.db)=>new AdminProductDetailDesignService(createContainerFromDb(db))};
  }catch(error){await f.close();throw error;}
}
