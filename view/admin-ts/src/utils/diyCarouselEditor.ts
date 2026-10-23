import { DIY_CAROUSEL_DEFAULTS } from './diyCarouselDefaults';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord as record, navRead as read, navArray, navText as text, navNumber as number, navFlag as flag, navSet, navTimestamp, canonicalNavigationImage, navigationLink, navigationColor } from './diyNavigationEditor';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';
import type { DiyTabSelection } from '@/api/diyAuthorOptions';
export type CarouselRecord = Record<string, unknown>;
// The installed carousel consumer intentionally accepts Number-coercible enum imports.
export function carouselOrdinal(value:unknown,fallback=0,max=2):number{const n=Number(value);return Number.isInteger(n)&&n>=0&&n<=max?n:fallback;}
const ordinal=carouselOrdinal;
export const CAROUSEL_NAMES = ['swiperBg','homeComb','swipers'] as const;
export type CarouselKind = typeof CAROUSEL_NAMES[number];
export type ModernCarouselKind = Exclude<CarouselKind,'swipers'>;
export const carouselLabels:Record<CarouselKind,string>={swiperBg:'背景轮播',homeComb:'轮播搜索',swipers:'旧版轮播（导入）'};
export const carouselKind=(v:unknown):CarouselKind|null=>CAROUSEL_NAMES.includes(v as CarouselKind)?v as CarouselKind:null;
export function carouselEntries(value:unknown[]){return value.flatMap((row,index)=>{const kind=carouselKind(record(row)?.name);return kind?[{index,kind}]:[];}).sort((a,b)=>navTimestamp(value[a.index])-navTimestamp(value[b.index])||a.index-b.index);}
export function newCarouselBlock(kind:ModernCarouselKind,timestamp:number):CarouselRecord{if(!['swiperBg','homeComb'].includes(kind))throw Error('旧版轮播仅编辑导入数据');const b=structuredClone(DIY_CAROUSEL_DEFAULTS[kind]!);b.timestamp=timestamp;return b;}
export function addCarousel(value:unknown[],kind:ModernCarouselKind){
  if(!['swiperBg','homeComb'].includes(kind))throw Error('组件类型无效');
  if(kind==='homeComb'&&value.some(row=>['homeComb','headerSerch','tabNav'].includes(String(record(row)?.name))))throw Error('轮播搜索限一组，且不能与搜索框或选项卡共存；可先明确删除已有组件');
  const times=value.filter(row=>NAVIGATION_BODY_NAMES.includes(record(row)?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp).filter(n=>n!==Number.MAX_SAFE_INTEGER),edge=kind==='homeComb'?Math.min(0,...times):Math.max(0,...times),timestamp=edge+(kind==='homeComb'?-1:1)*Math.max(1,Math.abs(edge)*Number.EPSILON*2);
  if(!Number.isFinite(timestamp)||Math.abs(timestamp)>Number.MAX_SAFE_INTEGER||timestamp===edge)throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const copy=structuredClone(value),selected=kind==='homeComb'?0:copy.length;copy.splice(selected,0,newCarouselBlock(kind,timestamp));navigationDocument(JSON.stringify(copy));return{value:copy,selected};
}
export function moveCarousel(value:unknown[],index:number,direction:number){
  const row=record(value[index]);if(!carouselKind(row?.name)||row?.name==='homeComb'||![-1,1].includes(direction))throw Error('轮播搜索固定在顶部');
  const sorted=value.map((_,i)=>i).filter(i=>NAVIGATION_BODY_NAMES.includes(record(value[i])?.name as typeof NAVIGATION_BODY_NAMES[number])).sort((a,b)=>navTimestamp(value[a])-navTimestamp(value[b])||a-b),at=sorted.indexOf(index),target=sorted[at+direction];
  if(target===undefined||['headerSerch','tabNav','homeComb'].includes(String(record(value[target])?.name)))throw Error('不能越过头部或底部导航');
  const a=navTimestamp(row),b=navTimestamp(value[target]);if(a===b||a===Number.MAX_SAFE_INTEGER||b===Number.MAX_SAFE_INTEGER)throw Error('相同或异常排序值需先在装修 JSON 中明确修复');
  const copy=structuredClone(value),one=record(copy[index])!,two=record(copy[target])!;[one.timestamp,two.timestamp]=[two.timestamp,one.timestamp];[copy[index],copy[target]]=[copy[target],copy[index]];return{value:copy,selected:target};
}
export function newCarouselItem(kind:ModernCarouselKind,list:'slides'|'tabs'|'words'):unknown{if(list==='words')return{val:''};const path=list==='tabs'?['tabListConfig','list']:['swiperConfig','list'];return structuredClone(navArray(DIY_CAROUSEL_DEFAULTS[kind],path)[0]??{});}
export function setCarouselTabTarget(block:CarouselRecord,index:number,selection:DiyTabSelection){
  if(block.name!=='homeComb'||!Number.isInteger(index)||index<0||!record(navReadTab(block,index))||!Number.isSafeInteger(selection.id)||selection.id<=0||selection.id>2147483647||!['micro','category'].includes(selection.kind)||typeof selection.name!=='string'||!selection.name)throw Error('目标身份无效');
  const path:Array<string|number>=['tabListConfig','list',index];navSet(block,[...path,'dataType','tabVal'],selection.kind==='micro'?0:1);navSet(block,[...path,selection.kind==='micro'?'microPage':'classPage','id'],selection.id);navSet(block,[...path,selection.kind==='micro'?'microPage':'classPage','name'],selection.name);
}
function navReadTab(block:CarouselRecord,index:number){return read(block,['tabListConfig','list',index]);}
/** The legacy title slot wins even when invalid; only a missing/blank caption falls back. */
export function carouselLinkPath(kind:CarouselKind,item:unknown):Array<string|number>{const slot=kind==='swiperBg'?0:1,title=read(item,['info',slot,'title']),fallback=title===undefined||title===null||typeof title==='string'&&(!title.trim()||title.trim()==='链接');return['info',slot,kind==='swipers'&&!fallback?'title':'value'];}
export function setCarouselLink(block:CarouselRecord,index:number,value:string){const kind=carouselKind(block.name),items=navArray(block,['swiperConfig','list']);if(!kind||!record(items[index])||!Number.isInteger(index)||index<0)throw Error('图片条目无效');navigationLink(value);const path=carouselLinkPath(kind,items[index]);navSet(block,['swiperConfig','list',index,...path],value);
  // Clearing the winning title also clears its fallback, so the explicit action cannot reactivate an older link.
  if(kind==='swipers'&&path[2]==='title'&&!value&&read(items[index],['info',1,'value'])!==undefined)navSet(block,['swiperConfig','list',index,'info',1,'value'],'');
}
export function canonicalCarouselBlock(raw:CarouselRecord):CarouselRecord{const b=structuredClone(raw);if(!carouselKind(b.name))return b;for(const item of navArray(b,['swiperConfig','list'])){const r=record(item);if(r&&typeof r.img==='string')r.img=canonicalPresentationReference(r.img);}if(b.name==='homeComb'){const logo=record(b.logoConfig);if(logo&&typeof logo.url==='string')logo.url=canonicalPresentationReference(logo.url);}return b;}
export function canonicalCarouselValue(raw:string):string{const value:unknown=JSON.parse(raw);if(value===null)throw Error('装修 value 不能为null');if(Array.isArray(value))for(let i=0;i<value.length;i++){const b=record(value[i]);if(b&&carouselKind(b.name))value[i]=canonicalCarouselBlock(b);}return JSON.stringify(value);}
export function carouselRadius(block:unknown):string{const f=record(read(block,['filletImg'])),separate=flag(f?.type)&&Array.isArray(f?.valList)&&f.valList.length===4,order=record(block)?.name==='homeComb'?[0,1,2,3]:[0,1,3,2],px=(v:unknown)=>`${Math.min(80,number(v))}px`;return separate?order.map(i=>px(read(f,['valList',i,'val']))).join(' '):px(f?.val);}
/** Read-only projection of the installed UniApp consumer at 375 design width (1rpx=.5px). */
export function carouselPreview(block:CarouselRecord,previews:Record<string,string>={}){
  const kind=carouselKind(block.name),home=kind==='homeComb',legacy=kind==='swipers',style=ordinal(read(block,['styleConfig','tabVal']),home?0:1,2),n=(key:string,fallback=0,max=100)=>Math.min(max,number(read(block,[key,'val']),fallback)),color=(key:string,fallback:string,index=0)=>navigationColor(read(block,[key,'color',index,'item']),fallback),image=(v:unknown)=>{const raw=text(v);return presentationPreviewForReference(raw,previews[canonicalPresentationReference(raw)])||presentationPreviewUrl(raw);},custom=ordinal(read(block,['toneConfig','tabVal']),0,1)===1;
  const clean=(v:unknown,fallback='',limit=100)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/gu,'').trim().slice(0,limit):fallback;
  return{kind,home,legacy,style,enabled:!flag(block.isHide)&&flag(block.isShow??true),stacked:legacy&&ordinal(read(block,['tabConfig','tabVal']),1,1)===0,
    items:navArray(block,['swiperConfig','list']).flatMap((row,index)=>{const src=image(read(row,['img']));return record(row)&&src?[{index,image:src}]:[];}),logo:home?image(read(block,['logoConfig','url'])):'',
    interval:legacy?2500:3000,duration:500,hotInterval:n('numConfig',2.5,3600)*1000||2500,hotWords:navArray(block,['hotWords','list']).map(r=>clean(read(r,['val']))).filter(Boolean),placeholder:clean(read(block,['inputConfig','value']),'请输入搜索词',10),
    tabs:[{index:0,label:'首页',valid:true},...navArray(block,['tabListConfig','list']).map((row,index)=>{const rawType=read(row,['dataType','tabVal']),t=rawType===1||rawType==='1'?'classPage':'microPage',rawId=read(row,[t,'id']),id=(typeof rawId==='number'||typeof rawId==='string')&&/^[1-9]\d{0,9}$/u.test(String(rawId))?Number(rawId):NaN;return{index:index+1,label:clean(read(row,['text','val']),'',4),valid:(rawType===undefined||[0,1,'0','1'].includes(rawType as never))&&Number.isSafeInteger(id)&&id<=2147483647};})],showTabs:home&&ordinal(read(block,['classConfig','tabVal']),0,1)===0,stickySearch:home&&ordinal(read(block,['searchConfig','tabVal']),0,1)===1,tabGap:n('contentConfig',20),categoryBackground:`linear-gradient(90deg,${Number(read(block,['toneConfig','tabVal']))===1?color('classColor','#e93323'):'#e93323'} 0%,${Number(read(block,['toneConfig','tabVal']))===1?color('classColor','#e93323',1):'#e93323'} 100%)`,
    indicator:legacy?ordinal(read(block,['docConfig','type']),0,1)===1?3:0:ordinal(read(block,['docConfig','tabVal']),0,3),dotPosition:ordinal(read(block,['docPosition','tabVal']),1,2),dotColor:legacy?'#ffffff':home||custom?color('dotColor','#e93323'):'#e93323',dotBackground:legacy?'rgba(0,0,0,.4)':home||custom?color('dotBgColor','#dddddd'):'#dddddd',
    wrapperStyle:legacy?{marginTop:`${n('mbConfig')/2}px`,padding:`0 ${n('lrConfig')/2}px`}:home?{paddingBottom:'15px'}:{marginTop:`${n('mbConfig')}px`,padding:`${n('topConfig',10)}px ${n('prConfig',10)}px ${n('bottomConfig',10)}px`},
    backgroundStyle:{background:color('bgColor','transparent'),height:!home&&style===1?'50%':'100%'},imageStyle:{borderRadius:legacy?flag(read(block,['imgConfig','type']))?'0':'5px':carouselRadius(block)},
    horizontalPadding:legacy?n('lrConfig'):home?10:n('prConfig',10)*2,previousMargin:(legacy?n('itemEdge'):home?style?50:10:style===2?55:0)/2,gap:kind==='swiperBg'&&style===2?n('imgConfig',10):0,inactiveScale:kind==='swiperBg'?.9:.93};
}
export {canonicalNavigationImage};
