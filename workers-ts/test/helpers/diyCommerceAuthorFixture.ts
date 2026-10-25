import { eq } from 'drizzle-orm';
import { systemDise } from '@/models/schema';
import { diyNavigationAuthorFixture } from './diyNavigationAuthorFixture';
import { sortedDiyState,type DiyStateRow as Row } from './diyStateFixture';
import defaults from '../fixtures/diy-commerce-author-defaults.json';
export const COMMERCE_AUTHOR_NAMES=['promotionList','seckill','combination','bargain','presale','pointsMall','coupon','liveBroadcast'] as const;
export function commerceAuthorBlocks(image:string):Row[]{
 const blocks=COMMERCE_AUTHOR_NAMES.map((name,i)=>({...structuredClone(defaults[name]),timestamp:10+i*10,authorExtra:{zero:0,empty:[],retain:name}})) as Row[];
 for(const block of blocks){if(['seckill','combination','bargain','presale','pointsMall'].includes(block.name)){for(const key of block.name==='pointsMall'?['imgConfig','imgConfig2','imgBgConfig']:['imgConfig','imgColorConfig','imgBgConfig'])block[key].url=image;}
 if(block.name==='promotionList'){block.tabConfig.list=Array.from({length:15},(_,i)=>({...structuredClone(defaults.promotionList.tabConfig.list[0]),chiild:[{title:'标题',val:i===0?'指定商品':`分组${i+1}`,max:4,unknown:'keep-title'},{title:'简介',val:'真实列表',max:4}],image,goodsList:{max:20,ids:[601,611],list:[{id:601,store_name:'导入商品快照',image:'/api/assets/999?never-authorized',opaque:[]}]} }));}
 }
 return[{name:'titles',timestamp:1,titleConfig:{value:'商城作者验收页'},fontSize:{val:18}},...blocks,{name:'unmigrated-commerce-neighbor',timestamp:75,opaque:{image:'/api/assets/999?keep',empty:[],zero:0}}];
}
export async function diyCommerceAuthorFixture(now=new Date(),options:{namespace?:'public'}={}){
 const f=await diyNavigationAuthorFixture(now,options);
 try{const blocks=commerceAuthorBlocks(f.platformImage.url);for(const id of[1,2])await f.db.update(systemDise).set({name:'商城作者验收页',title:'商城作者验收页',value:JSON.stringify(blocks),content:'independent-commerce-content-'+id,version:'commerce-author-initial',updateTime:Math.floor(now.getTime()/1000)-3600}).where(eq(systemDise.id,id));return{...f,blocks,snapshot:async()=>sortedDiyState(await f.snapshot())};}catch(reason){await f.close();throw reason;}
}
