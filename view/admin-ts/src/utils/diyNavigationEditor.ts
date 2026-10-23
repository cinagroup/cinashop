import { DIY_NAVIGATION_DEFAULTS } from './diyNavigationDefaults';
import { presentationDocument, presentationRecord, canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';
import { fabLinkSafe } from '@/api/fabSettings';
import type { DiyTabSelection } from '@/api/diyAuthorOptions';
export type NavigationRecord = Record<string, unknown>;
export const NAVIGATION_NAMES = ['headerSerch', 'tabNav', 'menus', 'pictureCube'] as const;
export type NavigationKind = typeof NAVIGATION_NAMES[number];
export const navigationRecord = presentationRecord;
export const navigationDocument = presentationDocument;
// Same renderer allowlist, with footer excluded from body movement.
export const NAVIGATION_BODY_NAMES = ["homeComb", "headerSerch", "userInfor", "newVip", "articleList", "bargain", "blankPage", "combination", "coupon", "customerService", "goodList", "guide", "liveBroadcast", "menus", "news", "pictureCube", "promotionList", "richText", "seckill", "swiperBg", "swipers", "tabNav", "titles", "ranking", "presale", "pointsMall", "videos", "signIn", "hotspot", "follow", "community", "activeParty"] as const;
export const navigationLabels: Record<NavigationKind, string> = { headerSerch: '搜索框', tabNav: '选项卡', menus: '图片菜单', pictureCube: '图片魔方' };
export const cubeSlotCounts = [2,2,3,3,3,3,3,4,5,4,1,16];
export const navigationKind = (v: unknown): NavigationKind | null => NAVIGATION_NAMES.includes(v as NavigationKind) ? v as NavigationKind : null;
export const navRead = (root: unknown, path: Array<string | number>): unknown => path.reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string | number, unknown>)[key] : undefined, root);
export const navText = (v: unknown): string => typeof v === 'string' ? v : '';
export function navNumber(value:unknown,fallback=0):number {const n=typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;return Number.isFinite(n)&&n>=0?n:fallback;}
export const navOrdinal = (v: unknown, fallback = 0, max = 2): number => (typeof v === 'number' || typeof v === 'string' && /^(?:0|[1-9]\d*)$/u.test(v)) && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : fallback;
export const navFlag = (v: unknown): boolean => v === true || v === 1 || typeof v === 'string' && ['1', 'true'].includes(v.trim().toLowerCase());
export function navSet(root: NavigationRecord, path: Array<string | number>, value: unknown) {
  if (!path.length || path.some(key => typeof key === 'number' ? !Number.isInteger(key) || key < 0 || key > 100000 : ['__proto__', 'prototype', 'constructor'].includes(key))) throw Error('字段路径无效');
  let target: Record<string | number, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!, next = path[i + 1]!; const current = target[key];
    if (current === undefined) target[key] = typeof next === 'number' ? [] : {};
    else if (!current || typeof current !== 'object' || Array.isArray(current) !== (typeof next === 'number')) throw Error('该字段结构异常，请在装修 JSON 中明确修复');
    target = target[key] as Record<string | number, unknown>;
  }
  target[path[path.length - 1]!] = value;
}
export const navTimestamp = (block: unknown): number => { const v = Number(navigationRecord(block)?.timestamp); return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER; };
export function navigationEntries(value: unknown[]) { return value.flatMap((row, index) => { const kind = navigationKind(navigationRecord(row)?.name); return kind ? [{ index, kind }] : []; }).sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index); }
export function newNavigationBlock(kind: NavigationKind, timestamp: number): NavigationRecord {
  const block = structuredClone(DIY_NAVIGATION_DEFAULTS[kind]!); block.timestamp = timestamp;
  if (kind === 'pictureCube') navSet(block, ['picStyle', 'picList'], Array.from({ length: 2 }, () => ({ image: '', link: '' })));
  return block;
}
function nextAfter(value: number): number { const n = value + Math.max(1, Math.abs(value) * Number.EPSILON * 2); if (!Number.isFinite(n) || n <= value || n > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整'); return n; }
function nextBefore(value: number): number { const n = value - Math.max(1, Math.abs(value) * Number.EPSILON * 2); if (!Number.isFinite(n) || n >= value || n < -Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整'); return n; }
export function addNavigation(value: unknown[], kind: NavigationKind): { value: unknown[]; selected: number } {
  if (!navigationKind(kind)) throw Error('组件类型无效');
  const blocks = value.map(navigationRecord), top = kind === 'headerSerch' || kind === 'tabNav';
  if (top && blocks.some(b => b?.name === kind || b?.name === 'homeComb')) throw Error('搜索框和选项卡各限一组，且不能与组合头部共存；可先明确删除已有组件');
  const copy = structuredClone(value); let timestamp: number, at: number;
  if (kind === 'headerSerch') { timestamp = nextBefore(Math.min(0, ...blocks.filter(b=>NAVIGATION_BODY_NAMES.includes(b?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp))); at = 0; }
  else if (kind === 'tabNav') {
    const header = blocks.findIndex(b => b?.name === 'headerSerch');
    if (header < 0) { timestamp = nextBefore(Math.min(0, ...blocks.filter(b=>NAVIGATION_BODY_NAMES.includes(b?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp))); at = 0; }
    else {
      const before = navTimestamp(blocks[header]), following = blocks.filter((b, i) => i !== header && NAVIGATION_BODY_NAMES.includes(b?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp).filter(n => n > before), upper = Math.min(Number.MAX_SAFE_INTEGER, ...following);
      if (blocks.some((b, i) => i !== header && NAVIGATION_BODY_NAMES.includes(b?.name as typeof NAVIGATION_BODY_NAMES[number]) && navTimestamp(b) <= before)) throw Error('导入头部顺序异常，请先在 JSON 中明确修复');
      timestamp = before + (upper - before) / 2; if (!Number.isFinite(timestamp) || timestamp <= before || timestamp >= upper) throw Error('头部排序空间不足，请先在 JSON 中明确调整'); at = header + 1;
    }
  } else { timestamp = nextAfter(Math.max(0, ...blocks.filter(b=>NAVIGATION_BODY_NAMES.includes(b?.name as typeof NAVIGATION_BODY_NAMES[number])).map(b => navTimestamp(b)).filter(n => n !== Number.MAX_SAFE_INTEGER))); at = copy.length; }
  copy.splice(at, 0, newNavigationBlock(kind, timestamp)); navigationDocument(JSON.stringify(copy)); return { value: copy, selected: at };
}
/** Move through the full timestamp order, including other component families.
 * Only the two swapped blocks' position and timestamp ownership change. */
export function moveNavigation(value: unknown[], index: number, direction: number): { value: unknown[]; selected: number } {
  const row = navigationRecord(value[index]); if (!navigationKind(row?.name) || ['headerSerch', 'tabNav'].includes(String(row?.name)) || ![-1, 1].includes(direction)) throw Error('头部组件位置固定');
  const sorted = value.map((_, i) => i).filter(i => NAVIGATION_BODY_NAMES.includes(navigationRecord(value[i])?.name as typeof NAVIGATION_BODY_NAMES[number])).sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b), position = sorted.indexOf(index), target = sorted[position + direction];
  if (target === undefined || ['headerSerch', 'tabNav', 'homeComb', 'pageFoot'].includes(String(navigationRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(row), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = navigationRecord(copy[index])!, b = navigationRecord(copy[target])!;
  [a.timestamp, b.timestamp] = [b.timestamp, a.timestamp]; [copy[index], copy[target]] = [copy[target], copy[index]]; return { value: copy, selected: target };
}
export function navArray(block: unknown, path: Array<string | number>): unknown[] { const v = navRead(block, path); return Array.isArray(v) ? v : []; }
export function navigationListPath(kind: NavigationKind): string[] { return kind === 'headerSerch' ? ['hotWords', 'list'] : kind === 'tabNav' ? ['tabListConfig', 'list'] : kind === 'menus' ? ['menuConfig', 'list'] : ['picStyle', 'picList']; }
export function newNavigationItem(kind: NavigationKind): unknown { return kind === 'headerSerch' ? { val: '' } : structuredClone(navArray(DIY_NAVIGATION_DEFAULTS[kind], navigationListPath(kind))[0] ?? {}); }
export function setNavigationTabTarget(block: NavigationRecord, index: number, selection: DiyTabSelection) {
  if (block.name !== 'tabNav' || !Number.isSafeInteger(selection.id) || selection.id <= 0 || selection.id > 2147483647 || !['micro', 'category'].includes(selection.kind) || typeof selection.name !== 'string' || !selection.name) throw Error('目标身份无效');
  const path = ['tabListConfig', 'list', index] as Array<string | number>; if (!navigationRecord(navRead(block, path))) throw Error('选项卡条目损坏');
  navSet(block, [...path, 'dataType', 'tabVal'], selection.kind === 'micro' ? 0 : 1); navSet(block, [...path, selection.kind === 'micro' ? 'microPage' : 'classPage', 'id'], selection.id); navSet(block, [...path, selection.kind === 'micro' ? 'microPage' : 'classPage', 'name'], selection.name);
}
export function setCubeLayout(block: NavigationRecord, style: number) {
  if (block.name !== 'pictureCube' || !Number.isInteger(style) || style < 0 || style > 11) throw Error('魔方布局无效');
  navSet(block, ['styleConfig', 'tabVal'], style); navSet(block, ['styleConfig', 'count'], cubeSlotCounts[style]);
  const old = navRead(block, ['picStyle', 'picList']); if (old !== undefined && !Array.isArray(old)) throw Error('图片槽位结构异常');
  const items = structuredClone(Array.isArray(old) ? old : []); while (items.length < cubeSlotCounts[style]!) {const doc=navigationRecord(navArray(block,['picStyle','docPicList'])[items.length]);items.push({image:style===11&&typeof doc?.img==='string'?doc.img:'',link:style===11&&typeof doc?.link==='string'?doc.link:''});}
  navSet(block, ['picStyle', 'picList'], items); navSet(block, ['picStyle', 'tabVal'], 0);
}
/** Explicit author action only: unrelated edits and layout selection never clip imports. */
export function trimCubeSlots(block:NavigationRecord) {const style=navOrdinal(navRead(block,['styleConfig','tabVal']),0,11);if(block.name!=='pictureCube'||style===11)throw Error('仅固定布局可以明确移除后续图片槽位');const items=navArray(block,['picStyle','picList']);navSet(block,['picStyle','picList'],structuredClone(items.slice(0,cubeSlotCounts[style])));navSet(block,['picStyle','tabVal'],Math.min(navOrdinal(navRead(block,['picStyle','tabVal']),0,Math.max(0,items.length-1)),cubeSlotCounts[style]!-1));}
export interface CubeRectangle { startX: number; startY: number; w: number; h: number }
export function validCubeRectangle(raw: unknown): CubeRectangle | null {
  const r = navigationRecord(raw); if (!r) return null; const vals = ['startX','startY','w','h'].map(key => typeof r[key] === 'number' || typeof r[key] === 'string' && String(r[key]).trim() !== '' ? Number(r[key]) : NaN);
  const [startX, startY, w, h] = vals as [number,number,number,number]; return vals.every(Number.isFinite) && startX >= 0 && startY >= 0 && w > 0 && h > 0 && startX+w <= 375 && startY+h <= 375 ? { startX,startY,w,h } : null;
}
export function setCubeMedia(block: NavigationRecord, index: number, field: 'image' | 'link', raw: string) {
  if (block.name !== 'pictureCube' || !Number.isInteger(index) || index < 0 || index >= Math.max(navArray(block,['picStyle','picList']).length,navArray(block,['picStyle','docPicList']).length)) throw Error('魔方槽位无效');
  const value = field === 'image' ? canonicalNavigationImage(raw) : navigationLink(raw);
  const pics=structuredClone(navArray(block,['picStyle','picList']));while(pics.length<=index)pics.push({image:'',link:''});navSet(block,['picStyle','picList'],pics);
  navSet(block, ['picStyle', 'picList', index, field], value);
  const docs = navArray(block, ['picStyle', 'docPicList']); if (navigationRecord(docs[index])) navSet(block, ['picStyle', 'docPicList', index, field === 'image' ? 'img' : 'link'], value);
  navSet(block, ['picStyle', 'tabVal'], index);
  navSet(block, field === 'image' ? ['menuConfig','list',0,'img'] : ['menuConfig','list',0,'info',0,'value'], value);
}
export function addCubeRectangle(block: NavigationRecord, rectangle: CubeRectangle): number {
  const doc = validCubeRectangle(rectangle); if (block.name !== 'pictureCube' || !doc) throw Error('矩形必须位于375×375画布内');
  const docs = structuredClone(navArray(block, ['picStyle','docPicList'])), pics = structuredClone(navArray(block, ['picStyle','picList'])), index = docs.length;
  docs.push({ img: '', link: '', doc }); if (!pics[index]) pics[index] = { image: '', link: '' };
  navSet(block, ['picStyle','docPicList'], docs); navSet(block, ['picStyle','picList'], pics); navSet(block, ['picStyle','tabVal'], index); return index;
}
export function removeCubeRectangle(block: NavigationRecord, index: number) { const docs = structuredClone(navArray(block, ['picStyle','docPicList'])), pics = structuredClone(navArray(block, ['picStyle','picList'])); if (!Number.isInteger(index) || index < 0 || index >= docs.length) throw Error('矩形索引无效'); docs.splice(index,1); pics.splice(index,1); navSet(block,['picStyle','docPicList'],docs); navSet(block,['picStyle','picList'],pics); navSet(block,['picStyle','tabVal'],Math.max(0,index-1)); }
export function canonicalNavigationImage(raw: string): string { const value = canonicalPresentationReference(raw.trim()); if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片'); return value; }
export function navigationLink(value: string): string { if (value && !fabLinkSafe(value)) throw Error('请选择安全有效的链接目标'); return value; }
export function canonicalNavigationBlock(raw: NavigationRecord): NavigationRecord {
  const block = structuredClone(raw), kind = navigationKind(block.name); if (!kind) return block;
  const canonical = (root: NavigationRecord, key: string) => { if (typeof root[key] === 'string') root[key] = canonicalPresentationReference(root[key] as string); };
  if (kind === 'headerSerch') { const f = navigationRecord(block.logoConfig); if (f) canonical(f,'url'); }
  if (kind === 'menus') for (const raw of navArray(block,['menuConfig','list'])) { const r=navigationRecord(raw);if(r)canonical(r,'img'); }
  if (kind === 'pictureCube') for (const [key,field] of [['picList','image'],['docPicList','img']] as const) for(const raw of navArray(block,['picStyle',key])) {const r=navigationRecord(raw);if(r)canonical(r,field);}
  return block;
}
export function canonicalNavigationValue(raw: string): string { const value:unknown=JSON.parse(raw);if(value===null)throw Error('装修 value 不能为null');if(Array.isArray(value))for(let i=0;i<value.length;i++){const r=navigationRecord(value[i]);if(r&&navigationKind(r.name))value[i]=canonicalNavigationBlock(r);}return JSON.stringify(value); }
export function navigationColor(raw: unknown, fallback: string): string { if (typeof raw !== 'string') return fallback; const c=raw.trim();return /^#[0-9a-f]{3,8}$/iu.test(c)||/^(?:rgb|hsl)a?\([0-9.,%\s+-]+\)$/iu.test(c)||/^(?:transparent|black|white)$/iu.test(c)?c:fallback; }
export function navigationRadius(block: unknown, key='fillet'): string { const field=navigationRecord(navRead(block,[key])), separate=navFlag(field?.type)&&Array.isArray(field?.valList)&&field.valList.length===4, kind=navigationRecord(block)?.name, order=kind==='headerSerch'||kind==='tabNav'?[0,1,2,3]:[0,1,3,2], px=(v:unknown)=>`${Math.min(80,navNumber(v))}px`;return separate?order.map(i=>px(navRead(field,['valList',i,'val']))).join(' '):px(field?.val); }
export function navigationCubeRects(style: number,count: number): number[][] { if(style===3)return[[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1,.5]];if(style===4)return[[0,0,1,.5],[0,.5,.5,.5],[.5,.5,.5,.5]];if(style===5)return[[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]];if(style===6)return[[0,0,.5,.5],[0,.5,.5,.5],[.5,0,.5,1]];if(style===7)return Array.from({length:count},(_,i)=>[(i%2)/2,Math.floor(i/2)/Math.ceil(count/2),.5,1/Math.ceil(count/2)]);if(style===8)return[[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1/3,.5],[1/3,.5,1/3,.5],[2/3,.5,1/3,.5]];if(style===9)return[[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.25,.5],[.75,.5,.25,.5]];return[]; }

/** Author preview projects the same public fields without mutating imports. */
export function navigationPreview(block: NavigationRecord, previews: Record<string,string> = {}) {
  const kind = navigationKind(block.name), style = navOrdinal(navRead(block,['styleConfig','tabVal']),0,kind==='pictureCube'?11:2);
  const n = (key:string) => Math.min(100,navNumber(navRead(block,[key,'val'])));
  const c = (key:string,fallback:string,index=0) => navigationColor(navRead(block,[key,'color',index,'item']),fallback);
  const gradient = (key:string,fallback='#ffffff') => `linear-gradient(90deg,${c(key,fallback)} 0%,${c(key,fallback,1)} 100%)`;
  const image = (raw:unknown) => { const value=navText(raw), approved=presentationPreviewForReference(value,previews[canonicalPresentationReference(value)]);return approved||presentationPreviewUrl(value); };
  const custom = navOrdinal(navRead(block,['toneConfig','tabVal']),0,1)===1, columns=navOrdinal(navRead(block,['number','tabVal']))+3,rows=navOrdinal(navRead(block,['rowsNum','tabVal']),0,3)+1;
  const items = kind==='menus' ? navArray(block,['menuConfig','list']).map((r,index)=>({index,image:image(navRead(r,['img'])),label:navText(navRead(r,['info',0,'value'])).replace(/[\u0000-\u001f\u007f]/gu,'').trim().slice(0,200),visible:navRead(r,['show'])===true||navRead(r,['show'])===1||navRead(r,['show'])==='1',rectangle:null as CubeRectangle|null}))
    :kind==='pictureCube'?navArray(block,['picStyle',style===11?'docPicList':'picList']).flatMap((r,index)=>{const rectangle=validCubeRectangle(navRead(r,['doc']));return style===11&&!rectangle?[]:[{index,image:image(navRead(r,[style===11?'img':'image'])),label:'',visible:true,rectangle}];}):[];
  const pages=[];for(let i=0;i<items.length;i+=columns*rows)pages.push(items.slice(i,i+columns*rows));
  const tabs=navArray(block,['tabListConfig','list']).map((r,index)=>{const t=navRead(r,['dataType','tabVal']),isCategory=t===1||t==='1',id=navRead(r,[isCategory?'classPage':'microPage','id']);return{index:index+1,label:navText(navRead(r,['text','val'])).replace(/[\u0000-\u001f\u007f]/gu,'').trim().slice(0,6),valid:(t===undefined||[0,1,'0','1'].includes(t as number|string))&&/^[1-9]\d{0,9}$/u.test(String(id))&&Number(id)<=2147483647};});
  return {kind,style,items,pages,columns,rows,tabs,paged:navOrdinal(navRead(block,['showConfig','tabVal']),0,1)===1,menuStyle:navOrdinal(navRead(block,['menuStyleConfig','tabVal'])),hasCube:navArray(block,['picStyle','picList']).length>0,
    wrapperStyle:{padding:kind==='pictureCube'?`0 ${n('prConfig')}px`:`${n('topConfig')}px ${n('prConfig')}px ${n('bottomConfig')}px`,marginTop:kind==='headerSerch'?'0':`${n('mbConfig')}px`,background:c('bottomBgColor','transparent'),boxSizing:'border-box' as const},
    panelStyle:{borderRadius:navigationRadius(block),background:gradient(kind==='menus'?'bgColor':'moduleColor')},imageStyle:{borderRadius:navigationRadius(block,'filletImg')},
    gap:n('imgConfig'),horizontalPadding:n('prConfig')*2,logo:image(navRead(block,['logoConfig','url'])),title:navText(navRead(block,['titleConfig','value'])).slice(0,200),placeholder:navText(navRead(block,['tipConfig','value'])).slice(0,200)||'搜索商品',
    hotWords:navArray(block,['hotWords','list']).map(r=>navText(navRead(r,['val'])).trim().slice(0,200)).filter(Boolean),
    searchVariant:navOrdinal(navRead(block,['styleSearchConfig','tabVal'])),searchStyle:{background:c('searchBoxColor','#f5f5f5'),color:c('tipColor','#cccccc')},hotStyle:{color:c('hotWordsColor','#888888')},
    searchButtonStyle:{background:c('searchBgColor','#E93323'),color:c('searchTxtColor','#ffffff')},searchTextStyle:{color:c('searchColor','#E93323')},
    selectedStyle:{color:style===0?(custom?c('textColor','#333333'):'#333333'):style===1?(custom?c('textColor2','#E93323'):'#E93323'):(custom?c('textColor3','#ffffff'):'#ffffff'),...(style===2?{background:custom?gradient('decorateColor'):'linear-gradient(90deg,#E93323 0%,#FF7931 100%)'}:{})},
    decorationStyle:style===0?{background:custom?gradient('decorateColor'):'linear-gradient(90deg,#E93323 0%,#FF7931 100%)'}:{borderBottomColor:custom?c('decorateColor2','#E93323'):'#E93323'},
    pointerColor:c('pointerColor','#E93323'),pointerBackground:c('pointerBgColor','#dddddd'),sticky:navOrdinal(navRead(block,['stickyConfig','tabVal']),0,1)===0};
}
