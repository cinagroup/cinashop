import { eq } from 'drizzle-orm';
import { systemDise } from '@/models/schema';
import { diyNavigationAuthorFixture } from './diyNavigationAuthorFixture';
import { sortedDiyState, type DiyStateRow as Row } from './diyStateFixture';
import defaults from '../fixtures/diy-editorial-author-defaults.json';
export const EDITORIAL_AUTHOR_NAMES = ['news','hotspot','activeParty'] as const;
export function editorialAuthorBlocks(image: string): Row[] {
  const news:Row={...structuredClone(defaults.news),timestamp:10},hotspot:Row={...structuredClone(defaults.hotspot),timestamp:20},party:Row={...structuredClone(defaults.activeParty),timestamp:30};
  news.listConfig.list[0].chiild[0].val='原版新闻公告';news.listConfig.list[0].chiild[1].val='/pages/article/list';
  hotspot.picStyle={url:image,list:[{number:1,starX:' 40.5 ',starY:24,areaWidth:220,areaHeight:150,nowImgWidth:750,link:'/pages/article/list',unknown:{keep:true}}]};
  party.menuConfig.list.forEach((item:Row)=>{item.img=image;item.info[2].value='/pages/article/list';});
  return [news,hotspot,party,{name:'unmigrated-editorial-neighbor',timestamp:25,opaque:{zero:0,empty:[],signed:' /api/assets/9?expires=1&signature=opaque '}}];
}
export async function diyEditorialAuthorFixture(now=new Date(),options:{namespace?:'public'}={}) {
  const f=await diyNavigationAuthorFixture(now,options);
  try{const blocks=editorialAuthorBlocks(f.platformImage.url);for(const id of[1,2])await f.db.update(systemDise).set({name:'内容作者验收页',title:'内容作者验收页',value:JSON.stringify(blocks),content:'independent-editorial-content-'+id,version:'editorial-author-initial',updateTime:Math.floor(now.getTime()/1000)-3600}).where(eq(systemDise.id,id));
    return {...f,blocks,snapshot:async()=>sortedDiyState(await f.snapshot())};
  }catch(reason){await f.close();throw reason;}
}
