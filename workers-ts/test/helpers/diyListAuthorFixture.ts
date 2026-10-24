import { eq, sql } from 'drizzle-orm';
import { articleCategory, storeBrand, storeProduct, storeProductCategory, storeProductLabel, storeProductRelation, systemArticle, systemDise } from '@/models/schema';
import { diyCarouselAuthorFixture } from './diyCarouselAuthorFixture';
import { diyFooterBlock } from './diyFooterFixture';
import { sortedDiyState, type DiyStateRow as Row } from './diyStateFixture';
import defaults from '../fixtures/diy-list-author-defaults.json';

export const DIY_LIST_AUTHOR_IDS = { brandRoot:85001,brandChild:85002,label:85011,categoryRoot:85021,categoryChild:85022,
  fixedOne:85031,fixedTwo:85032,brandProduct:85033,categoryProduct:85034,labelProduct:85035,articleCategory:85081,articleOne:85091,articleTwo:85092 } as const;
export const DIY_LIST_AUTHOR_NAMES = ['goodList','articleList'] as const;
export function listAuthorBlock(kind: keyof typeof defaults,timestamp:number):Row { const block:Row=structuredClone(defaults[kind]);block.timestamp=timestamp;return block; }
type Images={platformImage:{url:string};secondIcon:{url:string};image:{url:string}};
export function listAuthorBlocks(f:Images,micro=false):Row[]{
  const goods=Array.from({length:4},(_,i)=>{const row=listAuthorBlock('goodList',10+i*10);row.authorScope=i+1;row.authorExtra={preserve:'goods-'+i,zero:0,empty:[]};row.typeConfig.activeValue=i+1;
    row.goodsList.ids=[DIY_LIST_AUTHOR_IDS.fixedOne];row.goodsList.list=[{id:DIY_LIST_AUTHOR_IDS.fixedOne,store_name:'导入旧商品快照',image:f.image.url,privateSnapshot:true}];
    row.brandList.brandVal=[DIY_LIST_AUTHOR_IDS.brandRoot];row.classList.classVal=[DIY_LIST_AUTHOR_IDS.categoryRoot];row.goodsLabel.activeValue=[704];
    row.goodsLabel.list=[{id:704,label_name:'旧标签快照',preserve:'inactive-material'}];row.productList.list=[{id:999999,store_name:'不能替代真实商品',image:f.image.url,unknown:{keep:true}}];return row;});
  const article=listAuthorBlock('articleList',50);article.selectConfig.activeValue=811;article.selectList.list=[{id:999999,title:'不能替代真实文章',image_input:[f.image.url],preserve:'private-stale-snapshot'}];article.authorExtra={preserve:'article',empty:[]};
  if(micro){
    goods[0].numberConfig.val=101;goods[0].filletImg.type=true;goods[0].filletImg.valList=[{val:'0.0005'},{val:' 1.25 '},{val:'2e0'},{val:3.5}];goods[0].fillet.val=' 0.0005 ';goods[0].goodsSort.tabVal='2';
    goods[1].numberConfig.val=0;goods[1].topConfig.val='1e30';goods[1].prConfig.val=' 12.5 ';goods[1].fillet.type=true;
    goods[2].numberConfig.val='0003';goods[2].productList.list=Array.from({length:2501},(_,i)=>({id:900000+i,image:f.image.url,opaque:'untrusted-material'}));
    goods[3].goodsLabel.activeValue=Array.from({length:101},(_,i)=>85011+i);goods[3].goodsList.list=[{id:DIY_LIST_AUTHOR_IDS.fixedOne,unknown:'dormant-list-kept'}];
    article.numConfig.val=101;article.filletImg.type=true;article.filletImg.valList=[{val:' 1e-3 '},{val:2.25},{val:'3e0'},{val:' 4.75 '}];
    article.selectConfig.activeValue=String(DIY_LIST_AUTHOR_IDS.articleCategory);article.selectConfig.list=Array.from({length:107},(_,i)=>({activeValue:String(i),title:'导入分类'+i,originalIndex:i}));
  }
  const hidden=listAuthorBlock('articleList',55);hidden.isHide=true;hidden.numConfig.val=0;hidden.selectConfig.activeValue='';hidden.unknown='hidden-import-preserved';
  return [{name:'titles',timestamp:1,titleConfig:{value:micro?'列表作者导入微页正文':'列表作者首页正文'},fontSize:{val:18},independent:'keep-title'},
    ...goods,article,...(micro?[hidden]:[]),{name:'unsupported-list-author-neighbor',timestamp:35,opaque:{zero:0,list:[]},preserve:'whole-object'},diyFooterBlock(f.platformImage.url)];
}

/** Exact GUI changes only. Imported snapshots and all dormant scopes survive. */
export function expectedListRootEdit(f:Images,baseline=listAuthorBlocks(f)):Row[]{
  const value=structuredClone(baseline),goods=value.filter(r=>r.name==='goodList'),article=value.find(r=>r.name==='articleList')!;
  goods[0].goodsList.ids=[DIY_LIST_AUTHOR_IDS.fixedTwo,DIY_LIST_AUTHOR_IDS.fixedOne];
  goods[0].goodsList.list.push({id:DIY_LIST_AUTHOR_IDS.fixedTwo,store_name:'作者指定商品二'});goods[0].goodsList.list.reverse();
  goods[0].styleConfig.tabVal=1;goods[0].bntStyleConfig.tabVal=1;goods[0].numberConfig.val=2;goods[0].goodsNameColor.color[0].item='#13579b';
  goods[1].brandList.brandVal=[DIY_LIST_AUTHOR_IDS.brandChild];goods[1].styleConfig.tabVal=0;
  goods[2].classList.classVal=[DIY_LIST_AUTHOR_IDS.categoryChild];goods[2].styleConfig.tabVal=2;
  goods[3].goodsLabel.activeValue=[DIY_LIST_AUTHOR_IDS.label];goods[3].goodsLabel.list=[{id:DIY_LIST_AUTHOR_IDS.label,label_name:'列表作者标签'}];goods[3].styleConfig.tabVal=5;
  article.selectConfig.activeValue=DIY_LIST_AUTHOR_IDS.articleCategory;article.styleConfig.tabVal=2;article.numConfig.val=2;article.nameColor.color[0].item='#2468ac';return value;
}
export function expectedListAlternateEdit(f:Images,baseline=expectedListRootEdit(f)):Row[]{
  const value=structuredClone(baseline),goods=value.filter(r=>r.name==='goodList'),article=value.find(r=>r.name==='articleList')!;
  goods[0].styleConfig.tabVal=0;goods[0].bntStyleConfig.tabVal=0;goods[1].styleConfig.tabVal=4;goods[1].bntStyleConfig.tabVal=2;goods[2].styleConfig.tabVal=3;article.styleConfig.tabVal=1;return value;
}
export function expectedListMicroEdit(f:Images,baseline=listAuthorBlocks(f,true)):Row[]{const value=structuredClone(baseline);value.find(r=>r.name==='goodList')!.goodsNameColor.color[0].item='#a13f67';return value;}

/** All extra rows and warm configuration are explicit setup. Measured author
 * GETs and the three GUI POSTs start only after this complete owned snapshot. */
export async function diyListAuthorFixture(now=new Date(),options:{namespace?:'public'}={}){
  const f=await diyCarouselAuthorFixture(now,options);
  try{
    const before=await f.snapshot(),resourcesBefore=f.resources(),ids=DIY_LIST_AUTHOR_IDS;
    await f.db.insert(storeBrand).values([{id:ids.brandRoot,brandName:'列表作者品牌',pid:0,isShow:1,isDel:0,storeId:0},{id:ids.brandChild,pid:ids.brandRoot,fid:String(ids.brandRoot),brandName:'列表作者子品牌',isShow:1,isDel:0,storeId:0},
      {id:85003,brandName:'列表作者隐藏品牌',isShow:0},{id:85004,pid:85003,brandName:'列表作者隐藏品牌子项'},{id:85005,brandName:'列表作者门店品牌',storeId:77}]);
    await f.db.insert(storeProductCategory).values([{id:ids.categoryRoot,pid:0,level:0,path:'',cateName:'列表作者分类',type:0,relationId:0,isShow:1},
      {id:ids.categoryChild,pid:ids.categoryRoot,level:1,path:String(ids.categoryRoot),cateName:'列表作者子分类',type:0,relationId:0,isShow:1}]);
    await f.db.insert(storeProductLabel).values([{id:ids.label,labelName:'列表作者标签',type:0,relationId:0,status:1,isShow:1,styleType:1,color:'#123456',bgColor:'#eef2f6',borderColor:'#123456',icon:f.secondIcon.url},
      {id:85012,labelName:'列表作者隐藏标签',isShow:0},{id:85013,labelName:'列表作者供应商标签',type:2,relationId:84061}]);
    await f.db.insert(storeProduct).values([
      {id:ids.fixedOne,storeName:'作者指定商品一',image:f.platformImage.url,price:'11.00',isVerify:1,sales:7,ficti:3,stock:8,unitName:'件',star:'4.50',keyword:'never-author-private-keyword',storeInfo:'真实公开商品简介',barCode:'LIST85031'},
      {id:ids.fixedTwo,storeName:'作者指定商品二',image:f.secondIcon.url,price:'12.00',isVerify:1,sales:9,stock:7,unitName:'件',star:'4.00'},
      {id:ids.brandProduct,storeName:'作者品牌商品',image:f.platformImage.url,price:'13.00',isVerify:1,brandId:ids.brandChild,brandCom:`${ids.brandRoot},${ids.brandChild}`,sales:5,stock:6,unitName:'件'},
      {id:ids.categoryProduct,storeName:'作者分类商品',image:f.secondIcon.url,price:'14.00',isVerify:1,cateId:String(ids.categoryChild),sales:4,stock:5,unitName:'件'},
      {id:ids.labelProduct,storeName:'作者标签商品',image:f.platformImage.url,price:'15.00',isVerify:1,storeLabelId:String(ids.label),sales:3,stock:4,unitName:'件'},
      {id:85036,storeName:'列表作者隐藏商品',image:f.image.url,price:'16.00',isVerify:1,isShow:0,brandId:ids.brandChild,storeLabelId:String(ids.label)},
    ]);
    await f.db.insert(storeProductRelation).values([{productId:ids.brandProduct,type:2,relationId:ids.brandRoot},{productId:ids.brandProduct,type:2,relationId:ids.brandChild,relationPid:ids.brandRoot},
      {productId:ids.categoryProduct,type:1,relationId:ids.categoryRoot},{productId:ids.categoryProduct,type:1,relationId:ids.categoryChild,relationPid:ids.categoryRoot},
      {productId:85036,type:2,relationId:ids.brandChild,relationPid:ids.brandRoot},{productId:85036,type:1,relationId:ids.categoryChild,relationPid:ids.categoryRoot}]);
    await f.db.insert(articleCategory).values([{id:ids.articleCategory,title:'列表作者文章分类',status:1,isDel:0,hidden:0},{id:85082,title:'列表作者隐藏文章分类',hidden:1}]);
    const seconds=Math.floor(now.getTime()/1000);
    await f.db.insert(systemArticle).values([{id:ids.articleOne,cid:ids.articleCategory,title:'作者列表文章一',imageInput:f.platformImage.url,visit:0,likes:0,addTime:seconds-60,status:1,isDel:0,hide:0,content:'never-author-private-body',synopsis:'真实作者摘要一'},
      {id:ids.articleTwo,cid:ids.articleCategory,title:'作者列表文章二',imageInput:f.secondIcon.url,visit:12,likes:3,addTime:seconds-120,status:1,isDel:0,hide:0,synopsis:'真实作者摘要二'},
      {id:85093,cid:ids.articleCategory,title:'列表作者隐藏文章',status:1,hide:1},{id:85094,cid:85082,title:'隐藏分类里的文章',status:1}]);
    const rootBlocks=listAuthorBlocks(f),microBlocks=listAuthorBlocks(f,true);
    for(const id of[1,2])await f.db.update(systemDise).set({name:id===1?'列表作者首页':'列表作者微页',title:id===1?'列表作者首页':'列表作者导入微页',value:JSON.stringify(id===1?rootBlocks:microBlocks),content:`independent-list-author-content-${id}`,version:'list-author-initial'}).where(eq(systemDise.id,id));
    const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r=>r.name),sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r=>r.name);
    async function snapshot(){const value=await f.snapshot();if(Object.keys(value).length!==tables.length+1||value.__sequences.length!==sequences.length)throw Error('Full list author inventory changed');return sortedDiyState(value);}
    return{...f,tables,sequences,snapshot,rootBlocks,microBlocks,listAuthorSetup:{phase:'Owned full real product/relation/brand/label/category/article and literal page setup; not measured GET or GUI business write',before,after:await snapshot(),resources_before:resourcesBefore,resources_after:f.resources(),tables,sequences,ids}};
  }catch(reason){await f.close();throw reason;}
}
