import { AttachmentService, userAttachmentScope } from '@/services/system/AttachmentService';
import { diyPresentationFixture } from './diyPresentationFixture';
import { diyEditorialBlocks } from './diyEditorialFixture';
import { diyCarouselBlocks } from './diyCarouselFixture';
import { diyNavigationBlocks } from './diyNavigationFixture';
import { diyFooterBlock } from './diyFooterFixture';
import { diyCustomerServiceBlock } from './diyCustomerServiceFixture';
import type { DiyStateRow as Row } from './diyStateFixture';

/** Browser-only real platform MP4 setup. The native32 fixture remains73/68.
 * This existing Admin video addon requires public namespace and adds its real
 * table: every Browser snapshot therefore covers the actual74tables68sequences. */
export async function diyMediaReferenceBrowserFixture(now = new Date()) {
  const f = await diyPresentationFixture(now);
  try {
    const before = await f.snapshot(), resourcesBefore = f.resources(), service = new AttachmentService(f.container, f.env);
    const foreignImage = await service.uploadImage(userAttachmentScope(22), new File([f.png], 'reference-foreign22.png', { type: 'image/png' }), 0);
    const privateVideo = await service.uploadUserVideo(11, f.file());
    return { ...f, foreignImage, privateVideo, referenceUploadSetup: { phase: 'Browser-only real user22 PNG and user11 MP4 owned setup',
      before, after: await f.snapshot(), resources_before: resourcesBefore, resources_after: f.resources(), foreignImage, privateVideo } };
  } catch (reason) { await f.close(); throw reason; }
}
export const DIY_MEDIA_REFERENCE_BROWSER_FAMILIES = ['news','hotspot','follow','activeParty','swipers','swiperBg','homeComb','headerSerch','menus','pictureCube','pageFoot','customerService','videos','richText'] as const;
const layered = (path: string, level: number) => path.replace('/api/', '/' + (level === 1 ? '&#97;' : level === 2 ? '&amp;#97;' : '&amp;amp;#97;') + 'pi/');
type Fixture = Awaited<ReturnType<typeof diyMediaReferenceBrowserFixture>>;
/** Full real component shapes; only the known media slots differ between the
 * private author input and its independently specified one-decode saved form. */
export function diyMediaReferenceBrowserBlocks(f: Fixture, micro: boolean, mode: 'initial'|'canonical-save'|'private-author'|'private-stored' = 'initial'): Row[] {
  const image=f.platformImage.url,control=f.secondIcon.url,video=f.platformVideo.url,privateMode=mode.startsWith('private-');
  const legacy=(other=false)=>privateMode?layered(other?f.foreignImage.url:f.image.url,mode==='private-author'?3:2):image;
  const json=(source:string)=>privateMode?layered(source,1):image;
  const selected=(source:Row[],name:string)=>structuredClone(source.find(block=>block.name===name)!);
  const editorial=diyEditorialBlocks(image),carousel=diyCarouselBlocks(image),navigation=diyNavigationBlocks(image);
  const header=selected(navigation,'headerSerch');header.styleConfig.tabVal=0;header.logoConfig.url=legacy(true);header.timestamp=10;
  const news=selected(editorial,'news');news.titleConfig.tabVal=0;news.styleConfig.tabVal=1;news.imgConfig.url=mode==='canonical-save'?control:legacy();
  const hotspot=selected(editorial,'hotspot');hotspot.picStyle.url=legacy();
  const follow=selected(editorial,'follow');follow.imgConfig.url=legacy();follow.codeConfig.url=legacy();
  const party=selected(editorial,'activeParty');party.menuConfig.list[0].img=legacy();party.menuConfig.list[1].img=control;
  const slides=(reference:string)=>[{img:reference,imgTitle:'真实首张素材',info:[{title:'链接',value:'/pages/diy/detail?id=2'},{title:'/pages/diy/detail?id=2',value:'/pages/diy/detail?id=2'}]},
    {img:control,imgTitle:'合法图片对照',info:[{title:'链接',value:'/pages/index/index'},{title:'/pages/index/index',value:'/pages/index/index'}]}];
  const swipers=selected(carousel,'swipers');swipers.swiperConfig.list=slides(legacy());swipers.tabConfig.tabVal=0;
  const swiperBg=selected(carousel,'swiperBg');swiperBg.swiperConfig.list=slides(legacy());
  const combination=selected(carousel,'homeComb');combination.swiperConfig.list=slides(legacy());combination.logoConfig.url=legacy();combination.classConfig.tabVal=1;combination.searchConfig.tabVal=0;combination.tabListConfig.list=[];
  const menus=selected(navigation,'menus');menus.showConfig.tabVal=0;menus.menuConfig.list=menus.menuConfig.list.slice(0,2);menus.menuConfig.list[0].img=legacy(true);menus.menuConfig.list[1].img=control;
  const cube=selected(navigation,'pictureCube');cube.styleConfig.tabVal=11;cube.picStyle.docPicList=[{img:legacy(),link:'/pages/diy/detail?id=2',doc:{startX:0,startY:0,w:160,h:90}},{img:control,link:'/pages/index/index',doc:{startX:160,startY:0,w:160,h:90}}];cube.picStyle.picList=[{image:legacy(),link:'/pages/diy/detail?id=2'},{image:control,link:'/pages/index/index'}];
  const footer=diyFooterBlock(image);footer.menuList.forEach((item:Row)=>{item.imgList=[legacy(),control];});
  const service=diyCustomerServiceBlock(image);service.logoConfig.url=json(f.foreignImage.url);service.logoConfig.link=micro?'/pages/index/index':'/pages/diy/detail?id=2';service.topConfig.val='20';service.locationConfig.tabVal=1;
  const standalone={name:'videos',isHide:false,scaleConfig:{tabVal:0},videoConfig:{url:privateMode?layered(f.privateVideo.url,1):video},imgConfig:{url:json(f.image.url)},topConfig:{val:6},bottomConfig:{val:6},prConfig:{val:10}};
  const htmlImage=privateMode?layered(f.image.url,2):image,htmlVideo=privateMode?layered(f.privateVideo.url,2):video;
  const rich={name:'richText',isHide:false,lrConfig:{val:10},udConfig:{val:6},richText:{val:`<p><strong>真实十四族素材正文</strong><a href="/pages/index/index">保留首页链接</a><img src="${htmlImage}" alt="实际媒体"><img src="${control}" alt="合法图片对照"><video src="${htmlVideo}" controls></video></p>`}};
  const body:Row[]=[news,hotspot,follow,party,swipers,swiperBg,combination,menus,cube,service,standalone,rich];
  body.forEach((block,index)=>{block.timestamp=100+index*10;block.authorUnknown={preview:f.image.url+'?expires=1&signature=historical',href:f.foreignImage.url,zero:0,keep:['unmodified']};});
  footer.timestamp=900;
  const title={name:'titles',timestamp:50,titleConfig:{value:micro?'真实媒体引用微页':'真实媒体引用首页'},fontSize:{val:18},buttonConfig:{tabVal:0},linkConfig:{value:micro?'/pages/index/index':'/pages/diy/detail?id=2'}};
  return [header,title,...body,{name:'unknown-media-neighbor',timestamp:800,logoConfig:{url:f.image.url},preview:f.foreignImage.url+'?expires=1&signature=historical',link:f.privateVideo.url},footer];
}
