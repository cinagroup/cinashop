import { DIY_EDITORIAL_DEFAULTS } from './diyEditorialDefaults';
import { navigationDocument, navigationRecord, navRead, navSet, navTimestamp, NAVIGATION_BODY_NAMES } from './diyNavigationEditor';
import { presentationPreviewUrl } from './diyPresentationEditor';
export const EDITORIAL_NAMES = ['news', 'hotspot', 'activeParty'] as const;
export type EditorialKind = typeof EDITORIAL_NAMES[number];
export type EditorialRecord = Record<string, unknown>;
export type EditorialPath = Array<string | number>;
export const editorialLabels = { news: '新闻公告', hotspot: '热区', activeParty: '活动魔方' };
export const editorialDocument = navigationDocument, editorialRecord = navigationRecord, editorialRead = navRead;
export const editorialKind = (raw: unknown): EditorialKind | null => EDITORIAL_NAMES.includes(raw as EditorialKind) ? raw as EditorialKind : null;
export function editorialEntries(value: unknown[]) { return value.flatMap((raw,index) => { const kind=editorialKind(navigationRecord(raw)?.name); return kind ? [{index,kind}] : []; }).sort((a,b)=>navTimestamp(value[a.index])-navTimestamp(value[b.index]) || a.index-b.index); }
export function newEditorialBlock(kind: EditorialKind, timestamp: number): EditorialRecord { return { ...structuredClone(DIY_EDITORIAL_DEFAULTS[kind]), timestamp }; }
export function addEditorialBlock(value: unknown[], kind: EditorialKind, source?: EditorialRecord) {
  if (!editorialKind(kind)) throw Error('内容组件类型无效');
  const copy=structuredClone(value), maximum=Math.max(0,...copy.filter(row=>NAVIGATION_BODY_NAMES.includes(navigationRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp));
  const timestamp=maximum+Math.max(1,Math.abs(maximum)*Number.EPSILON*2);
  if(!Number.isSafeInteger(timestamp)||timestamp<=maximum)throw Error('排序空间不足，请先明确调整排序');
  const footer=copy.findIndex(row=>navigationRecord(row)?.name==='pageFoot'),selected=footer<0?copy.length:footer;
  copy.splice(selected,0,source?{...structuredClone(source),timestamp}:newEditorialBlock(kind,timestamp));return{value:copy,selected};
}
export function moveEditorialBlock(value: unknown[], selected: number, direction: -1|1) {
  if(!editorialKind(navigationRecord(value[selected])?.name))throw Error('未选择内容组件');
  const indices=value.map((_,i)=>i).filter(i=>NAVIGATION_BODY_NAMES.includes(navigationRecord(value[i])?.name as typeof NAVIGATION_BODY_NAMES[number])).sort((a,b)=>navTimestamp(value[a])-navTimestamp(value[b])||a-b),target=indices[indices.indexOf(selected)+direction];
  if(target===undefined||['homeComb','headerSerch','tabNav','pageFoot'].includes(String(navigationRecord(value[target])?.name)))throw Error('不能越过头部或底部导航');
  const a=navTimestamp(value[selected]),b=navTimestamp(value[target]);if(a===b||[a,b].includes(Number.MAX_SAFE_INTEGER))throw Error('相同或异常排序值需要先明确调整');
  const copy=structuredClone(value);navigationRecord(copy[selected])!.timestamp=b;navigationRecord(copy[target])!.timestamp=a;[copy[selected],copy[target]]=[copy[target],copy[selected]];return{value:copy,selected:target};
}
/** Exact ordinary-image decoder: these slots do not use the state-image grammar. */
export function editorialImageIdentity(value: unknown): string {
  if(typeof value!=='string')return '';
  const entities:Record<string,string>={amp:'&',apos:"'",colon:':',gt:'>',lt:'<',newline:'\n',quot:'"',tab:'\t'};
  const decoded=value.replace(/&#x([0-9a-f]{1,6});?/giu,(_,code:string)=>Number.parseInt(code,16)<=0x10ffff?String.fromCodePoint(Number.parseInt(code,16)):'').replace(/&#([0-9]{1,7});?/gu,(_,code:string)=>Number(code)<=0x10ffff?String.fromCodePoint(Number(code)):'').replace(/&(amp|apos|colon|gt|lt|newline|quot|tab);/giu,(_,name:string)=>entities[name.toLowerCase()]!).trim();
  const local=/^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/u.exec(decoded);return local?`/api/assets/${local[1]}`:decoded;
}
export function editorialMediaPaths(block: EditorialRecord): EditorialPath[] {
  if(block.name==='news')return [['imgConfig','url']];
  if(block.name==='hotspot')return [['picStyle','url']];
  const list=navRead(block,['menuConfig','list']);return block.name==='activeParty'&&Array.isArray(list)?list.slice(0,4).flatMap((row,i)=>navigationRecord(row)?[['menuConfig','list',i,'img'] as EditorialPath]:[]):[];
}
export function canonicalEditorialBlock(raw:EditorialRecord, published=false) {
  const block=structuredClone(raw);if(!editorialKind(block.name))return block;
  for(const path of editorialMediaPaths(block)){const value=navRead(block,path);if(typeof value==='string')navSet(block,path,editorialImageIdentity(value));}
  if(published&&block.name==='activeParty')for(const key of ['titleConfig','desConfig']){const field=navigationRecord(block[key]);if(field){delete field.place;delete field.max;}}
  return block;
}
export function canonicalEditorialValue(raw:string) {const value:unknown=JSON.parse(raw);if(value===null)throw Error('装修 value 不能为null');if(Array.isArray(value))for(let i=0;i<value.length;i++){const block=navigationRecord(value[i]);if(block&&editorialKind(block.name))value[i]=canonicalEditorialBlock(block);}return JSON.stringify(value);}
export function editorialPreviewUrl(reference: unknown, signed?: unknown) {
  const identity=editorialImageIdentity(reference);if(!identity)return '';
  const candidate=typeof signed==='string'?signed:identity;
  return editorialImageIdentity(candidate)===identity?presentationPreviewUrl(candidate):'';
}
export function editorialList(block: EditorialRecord, path: EditorialPath): unknown[] {
  const value=navRead(block,path);if(value!==undefined&&!Array.isArray(value))throw Error('已存列表结构异常，请在 JSON 中明确修复');return Array.isArray(value)?value:[];
}
export interface EditorialRect { starX:number;starY:number;areaWidth:number;areaHeight:number }
export function editorialRect(raw:unknown):EditorialRect|null {const row=navigationRecord(raw);if(!row)return null;const fields=['starX','starY','areaWidth','areaHeight'] as const;const values=fields.map(key=>row[key]);if(values.some(value=>!(typeof value==='number'||typeof value==='string'&&value.trim()!=='')||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>1e6))return null;const [starX,starY,areaWidth,areaHeight]=values.map(Number) as [number,number,number,number];return areaWidth>0&&areaHeight>0?{starX,starY,areaWidth,areaHeight}:null;}
export function clampEditorialRect(rect:EditorialRect,height:number):EditorialRect {const starX=Math.min(750,Math.max(0,rect.starX)),starY=Math.min(height,Math.max(0,rect.starY));return{starX,starY,areaWidth:Math.max(0,Math.min(rect.areaWidth,750-starX)),areaHeight:Math.max(0,Math.min(rect.areaHeight,height-starY))};}
