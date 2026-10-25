import { eq } from 'drizzle-orm';
import { community,communityTopic,systemDise,systemRole } from '@/models/schema';
import { diyNavigationAuthorFixture } from './diyNavigationAuthorFixture';
import { sortedDiyState,type DiyStateRow as Row } from './diyStateFixture';
import defaults from '../fixtures/diy-community-author-defaults.json';
export function communityAuthorBlocks(image:string):Row[]{
 const one:Row={...structuredClone(defaults.community),timestamp:10,authorExtra:{zero:0,empty:[],null:null},imgConfig:{...structuredClone(defaults.community.imgConfig),url:image}};
 const two:Row={...structuredClone(one),timestamp:20,styleConfig:{...structuredClone(defaults.community.styleConfig),tabVal:1},titleConfig:{...structuredClone(defaults.community.titleConfig),tabVal:1},titleTxtConfig:{...structuredClone(defaults.community.titleTxtConfig),value:'社区双列'},selectConfig:{...structuredClone(defaults.community.selectConfig),activeValue:'999',list:[{value:'999',name:'旧话题元数据',keep:[]}]}};
 return[{name:'titles',timestamp:1,titleConfig:{value:'社区作者验收页'},fontSize:{val:18}},one,two,{name:'unmigrated-community-neighbor',timestamp:15,opaque:{image:'/api/assets/999?keep',empty:[],zero:0}}];
}
export async function diyCommunityAuthorFixture(now=new Date(),options:{namespace?:'public'}={}){
 const f=await diyNavigationAuthorFixture(now,options);
 try{
  const authorPermissions=[...new Set([...f.adminSession.uniqueAuth,'community.view'])];
  await f.db.update(systemRole).set({rules:authorPermissions.join(',')}).where(eq(systemRole.id,901));
  const adminSession={...f.adminSession,uniqueAuth:authorPermissions};
  await f.db.insert(community).values([
   ...[2,3].map(id=>({id,type:2,relationId:11,title:`社区作者公开${id}`,content:'真实只读社区内容',contentType:1,image:f.image.url,sliderImage:JSON.stringify([f.image.url]),status:1,isVerify:1,likeNum:id,star:20-id,addTime:1000+id})),
   {id:4,type:2,relationId:11,title:'社区作者待审旁观',isVerify:0,status:1,star:999},
   {id:5,type:2,relationId:11,title:'社区作者下架旁观',isVerify:1,status:0,star:999},
   {id:6,type:2,relationId:11,title:'社区作者删除旁观',isVerify:1,status:1,isDel:1,star:999},
  ]);
  await f.db.insert(communityTopic).values([{id:19,name:'社区作者真实话题',status:1,isDel:0},{id:29,name:'社区作者隐藏话题',status:0,isDel:0}]);
  const blocks=communityAuthorBlocks(f.platformImage.url);
  for(const id of [1,2])await f.db.update(systemDise).set({name:'社区作者验收页',title:'社区作者验收页',value:JSON.stringify(blocks),content:'independent-community-content-'+id,version:'community-author-initial',updateTime:Math.floor(now.getTime()/1000)-3600}).where(eq(systemDise.id,id));
  return{...f,adminSession,blocks,snapshot:async()=>sortedDiyState(await f.snapshot())};
 }catch(reason){await f.close();throw reason;}
}
