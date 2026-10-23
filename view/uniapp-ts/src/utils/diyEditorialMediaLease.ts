import { diyPresentationHtmlMediaReferences, mapDiyPresentationHtmlMedia } from '../../../common/diyPresentationHtml';
import { API_BASE } from './request';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** These are published media slots, never links or arbitrary editor strings. */
function mediaSlots(page: unknown): {holder:Record<string,unknown>;key:string; html?:boolean}[] {
  const value = record(page).value;
  if (!Array.isArray(value)) return [];
  const footers = value.filter(raw => typeof record(raw).name === 'string' && String(record(raw).name).toLowerCase() === 'pagefoot');
  return [...value.slice(0, 200).filter(raw => !footers.includes(raw)), ...footers].flatMap(raw => {
    const block = record(raw), field = (key: string) => ({holder:record(block[key]),key:'url'});
    if (typeof block.name === 'string' && block.name.toLowerCase() === 'pagefoot') {
      const items = block.menuList;
      return Array.isArray(items) ? items.flatMap(item => { const icons = record(item).imgList; return Array.isArray(icons) ? [0, 1].map(index => ({holder: icons as unknown as Record<string, unknown>, key: String(index)})) : []; }) : [];
    }
    if(block.name==='videos')return [field('videoConfig'),field('imgConfig')];
    if(block.name==='richText'){const holder=record(block.richText);if(typeof holder.val!=='string')return [];return [{holder,key:'val',html:true}];}
    if (block.name === 'news') return [field('imgConfig')];
    if (block.name === 'hotspot') return [field('picStyle')];
    if (block.name === 'follow') return [field('imgConfig'), field('codeConfig')];
    if (block.name === 'activeParty') { const items = record(block.menuConfig).list; return Array.isArray(items) ? items.slice(0, 4).map(item => ({holder:record(item),key:'img'})) : []; }
    if (['swipers','swiperBg','homeComb'].includes(String(block.name))) {
      const items=record(block.swiperConfig).list;
      return [...(Array.isArray(items)?items.map(item=>({holder:record(item),key:'img'})):[]),...(block.name==='homeComb'?[field('logoConfig')]:[])];
    }
    if (block.name === 'headerSerch') return [field('logoConfig')];
    if (block.name === 'menus') { const items=record(block.menuConfig).list; return Array.isArray(items)?items.map(item=>({holder:record(item),key:'img'})):[]; }
    if (block.name === 'pictureCube') {
      const style=record(block.picStyle), variant=record(block.styleConfig).tabVal, normal=Array.isArray(style.picList)?style.picList:[], custom=(variant===11||variant==='11')&&Array.isArray(style.docPicList)?style.docPicList:[];
      return [...normal.map(item=>({holder:record(item),key:'image'})),...custom.map(item=>({holder:record(item),key:'img'}))];
    }
    return [];
  });
}
/** Signed capabilities are transport material, not an authored config change.
 * Only the explicit published slots lose their ticket when comparing intent;
 * links, external URLs, IDs, item order and every other field remain exact. */
export function diyAuthoredPageFingerprint(components:unknown):string {
  const copy=JSON.parse(JSON.stringify({value:components}));
  for(const {holder,key,html} of mediaSlots(copy)){if(html)holder[key]=mapDiyPresentationHtmlMedia(String(holder[key]),ref=>assetQuery(ref)!==null?ref.split(/[?#]/u,1)[0]!:ref);else if(assetQuery(holder[key])!==null)holder[key]=String(holder[key]).split(/[?#]/u,1)[0];}
  return JSON.stringify(copy);
}
function assetQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let path = value;
  if (API_BASE && path.startsWith(API_BASE + '/api/assets/')) path = path.slice(API_BASE.length);
  else if (typeof window !== 'undefined' && path.startsWith(window.location.origin + '/api/assets/')) path = path.slice(window.location.origin.length);
  if (!/^\/api\/assets\/[1-9]\d*(?:\?|#|$)/u.test(path)) return null;
  return path.split('?', 2)[1]?.split('#', 1)[0] ?? '';
}
/** Server signatures last 900s. Public cache may reuse them for at most 840s
 * and must leave a full minute before the earliest ticket expiry. Static and
 * external images retain their existing offline schema contract. */
export function diyEditorialMediaDeadline(page: unknown, cachedAt: number, now = Date.now()): number {
  let earliest=Infinity;
  let slots:ReturnType<typeof mediaSlots>;try{slots=mediaSlots(page);}catch{return 0;}
  for (const {holder,key,html} of slots) {
    let references:unknown[];try{references=html?diyPresentationHtmlMediaReferences(String(holder[key])).map(ref=>ref.value):[holder[key]];}catch{return 0;}
    for(const value of references){
    const query = assetQuery(value); if (query === null) continue;
    if (!Number.isFinite(cachedAt) || cachedAt <= 0 || cachedAt > now) return 0;
    let params: [string, string][];
    try { params = query.split('&').map(part => { const at = part.indexOf('='); return [decodeURIComponent(at < 0 ? part : part.slice(0, at)), decodeURIComponent(at < 0 ? '' : part.slice(at + 1))]; }); }
    catch { return 0; }
    const expires = params.filter(([key]) => key === 'expires'), signatures = params.filter(([key]) => key === 'signature');
    if (expires.length !== 1 || signatures.length !== 1 || !/^[1-9]\d{0,10}$/u.test(expires[0]![1]) || !/^[A-Za-z0-9_-]{16,256}$/u.test(signatures[0]![1])) return 0;
    const deadline = Number(expires[0]![1]) * 1000;
    if (!Number.isSafeInteger(deadline)) return 0;
    earliest=Math.min(earliest,cachedAt+840000,deadline-60000);
  }
  }
  return earliest;
}
export const diyEditorialMediaCacheUsable=(page:unknown,cachedAt:number,now=Date.now())=>diyEditorialMediaDeadline(page,cachedAt,now)>now;
