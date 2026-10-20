import { bargainShareTarget } from '../../../common/bargainInvitation';
export const SHARE_TYPES = [-1, 0, 1, 2, 3, 4, 6, 7, 90, 91] as const;
export type LegacyShareType = typeof SHARE_TYPES[number];
export interface LegacyShareCode { routineUrl: string; wechatUrl: string; site_name: string; nickname: string }
export interface ShareScene { type: LegacyShareType; id: number; spid: number; path: string; bargain_user_id?: number; h5_origin?: string; namespace?: 'member'|'order'; code?: string; viewer_scope?: 'owner'|'customer'|'staff'|'delivery'; order_id?: string; time?: string; status?: string }
export interface SpreadPosterData { spread: { pic: string }[]; avatar: string; nickname: string; site_name: string }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('分享资料格式无效'); return v as Record<string, unknown>; }
function text(v: unknown, max = 255): string { if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/u.test(v)) throw Error('分享资料文字无效'); return v; }
function integer(v: unknown, min = 0): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > 2147483647) throw Error('分享目标无效'); return v; }
/** WeChat/App JS runtimes need no Web URL or URLSearchParams globals for these fixed routes. */
export function shareUri(source: string, base = 'https://share-route.invalid') {
  if (!source || /[\s\\]/u.test(source) || source.startsWith('//')) throw Error('分享地址无效');
  const absolute = /^(https?:)\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/u.exec(source);
  const relative = source.startsWith('/') ? /^([^?#]+)(?:\?([^#]*))?(?:#(.*))?$/u.exec(source) : null;
  if (!absolute && !relative) throw Error('分享地址无效');
  const authority = absolute?.[2] ?? '', pathname = absolute ? absolute[3] || '/' : relative![1]!;
  if (authority.includes('@') || absolute && !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/iu.test(authority) || pathname.split('/').some(part => part === '.' || part === '..')) throw Error('分享地址无效');
  const raw = (absolute ? absolute[4] : relative![2]) ?? '', pairs: [string,string][] = [];
  for (const part of raw ? raw.split('&') : []) { const at = part.indexOf('='), decode = (v:string) => decodeURIComponent(v.replace(/\+/gu,' ')); pairs.push([decode(at < 0 ? part : part.slice(0,at)),decode(at < 0 ? '' : part.slice(at+1))]); }
  const searchParams = { get size(){return pairs.length;},get:(key:string)=>pairs.find(pair=>pair[0]===key)?.[1]??null,getAll:(key:string)=>pairs.filter(pair=>pair[0]===key).map(pair=>pair[1]),has:(key:string)=>pairs.some(pair=>pair[0]===key),keys:()=>pairs.map(pair=>pair[0]),delete:(key:string)=>{for(let i=pairs.length-1;i>=0;i--)if(pairs[i]![0]===key)pairs.splice(i,1);} };
  return { origin:absolute?absolute[1]+'//'+authority.toLowerCase():base,protocol:absolute?.[1]??base.slice(0,base.indexOf(':')+1),pathname,hash:(absolute?absolute[5]:relative![3])===undefined?'':'#'+(absolute?absolute[5]:relative![3]),searchParams,get search(){return pairs.length?'?'+pairs.map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(value)).join('&'):'';} };
}
export function shareH5Origin(value:unknown):string {
  const origin=text(value,255);if(!/^https:\/\/[a-z0-9.-]+$/u.test(origin))throw Error('分享站点无效');
  const host=origin.slice(8),labels=host.split('.');if(labels.length<2||host.length>253||!/^[a-z]{2,63}$/u.test(labels[labels.length-1]!)||labels.some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))throw Error('分享站点无效');return origin;
}
export function shareToken(options: Record<string, unknown> | undefined): string {
  if (!options || (options.q !== undefined && options.scene !== undefined)) throw Error('分享码参数无效');
  let value: unknown = options.q;
  if (options.scene !== undefined) {
    if (typeof options.scene !== 'string' || options.scene.length > 96) throw Error('小程序分享场景无效');
    let decoded: string; try { decoded = decodeURIComponent(options.scene); } catch { throw Error('小程序分享场景无效'); }
    if (!/^q=[a-f0-9]{24}$/u.test(decoded)) throw Error('小程序分享场景无效');
    value = decoded.slice(2);
  }
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/u.test(value)) throw Error('分享码参数无效');
  return value;
}
export function shareCodeImage(value: unknown, apiOrigin = ''): string {
  const source = text(value, 1500000); if (!source) return '';
  if (/^data:image\/(?:png|jpeg|gif);base64,/u.test(source)) {
    const [header, encoded] = source.split(',');
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0 ||
      !(header === 'data:image/png;base64' && encoded.startsWith('iVBORw0KGgo') || header === 'data:image/jpeg;base64' && encoded.startsWith('/9j/') || header === 'data:image/gif;base64' && /^R0lGOD[dl]/u.test(encoded))) throw Error('分享码图片无效');
    return source;
  }
  if (source.length > 8192 || /[\s\\]/u.test(source) || source.startsWith('//')) throw Error('分享码图片地址无效');
  const origin = apiOrigin || 'https://share-code.invalid';
  let url; try { url = shareUri(source, origin); } catch { throw Error('分享码图片地址无效'); }
  if (url.hash) throw Error('分享码图片地址无效');
  if (url.origin === 'https://mp.weixin.qq.com' && url.pathname === '/cgi-bin/showqrcode' && url.searchParams.size === 1 && url.searchParams.getAll('ticket').length === 1 && url.searchParams.get('ticket')) return source;
  if (url.origin !== origin || !/^\/api\/share\/code\/image\/[a-f0-9]{24}\/(?:wechat|routine)$/u.test(url.pathname) || url.searchParams.size !== 2 || url.searchParams.getAll('expires').length !== 1 || url.searchParams.getAll('signature').length !== 1 || !/^[1-9]\d{8,12}$/u.test(url.searchParams.get('expires') ?? '') || !/^[A-Za-z0-9_-]{20,512}$/u.test(url.searchParams.get('signature') ?? '')) throw Error('分享码图片地址无效');
  return source;
}
export function parseLegacyShareCode(value: unknown, apiOrigin = ''): LegacyShareCode {
  const row = object(value);
  return { routineUrl: shareCodeImage(row.routineUrl, apiOrigin), wechatUrl: shareCodeImage(row.wechatUrl, apiOrigin), site_name: text(row.site_name), nickname: text(row.nickname) };
}
export function parseSpreadPosterData(value: unknown, apiOrigin = ''): SpreadPosterData {
  const row = object(value);
  if (!Array.isArray(row.spread) || row.spread.length > 30) throw Error('推广海报模板过多或格式无效');
  const media = (value: unknown) => { const source = posterImage(value); if(!apiOrigin||!source.startsWith('/'))return source;
    const url=shareUri(source),query=url.searchParams;if(!/^\/api\/assets\/[1-9]\d*$/u.test(url.pathname)||query.getAll('expires').length!==1||query.getAll('signature').length!==1||!/^[1-9]\d{8,12}$/u.test(query.get('expires')??'')||!/^[A-Za-z0-9_-]{20,512}$/u.test(query.get('signature')??'')||query.keys().some(key=>!['expires','signature','variant','width','height'].includes(key)||query.getAll(key).length!==1))throw Error('海报图片旧路径尚未映射，请联系商家');return apiOrigin+source; };
  return { spread: row.spread.map(v => ({ pic: media(object(v).pic) })), avatar: media(row.avatar), nickname: text(row.nickname), site_name: text(row.site_name) };
}
export function posterImage(value: unknown): string {
  const source = text(value, 2048); if (!source) return '';
  if (/^\/(?!\/)[^\\\s]*$/u.test(source)) return source;
  let url; try { url = shareUri(source); } catch { throw Error('海报图片地址无效'); }
  if (url.protocol !== 'https:' || url.hash || /[\\\s]/u.test(source)) throw Error('海报图片地址无效');
  return source;
}
export function parseShareScene(value: unknown): ShareScene {
  const row = object(value), type = row.type;
  if (!SHARE_TYPES.includes(type as LegacyShareType)) throw Error('分享类型无效');
  const scene: ShareScene = { type: type as LegacyShareType, id: integer(row.id, type === -1 ? 0 : 1), spid: integer(row.spid), path: text(row.path, 1024) };
  if(row.h5_origin!==undefined)scene.h5_origin=shareH5Origin(row.h5_origin);
  if (!scene.path.startsWith('/pages/') || scene.path.startsWith('//') || /[\\\s#]/u.test(scene.path)) throw Error('分享目的地无效');
  const route = shareUri(scene.path), query = route.searchParams;
  if (scene.type === 90 || scene.type === 91) {
    scene.namespace = scene.type === 90 ? 'member' : 'order'; scene.code = text(row.code, 32);
    if (!scene.code || scene.spid !== 0 || row.namespace !== scene.namespace || !['owner','customer','staff','delivery'].includes(String(row.viewer_scope))) throw Error('核销查询分享目标不一致');
    scene.viewer_scope = row.viewer_scope as ShareScene['viewer_scope'];
    let expected = ({customer:'/pages/customer-work/scanning',staff:'/pages/operator/writeoff?role=staff',delivery:'/pages/delivery/scanning'} as Record<string,string>)[scene.viewer_scope!];
    if (scene.viewer_scope === 'owner') {
      expected = '/pages/user/memberCode';
      if (scene.type === 91) { scene.order_id = text(row.order_id, 64); if (!/^[A-Za-z0-9_-]{1,64}$/u.test(scene.order_id)) throw Error('本人订单编号无效'); expected = '/pages/order/detail?orderId=' + encodeURIComponent(scene.order_id); }
    }
    if (scene.path !== expected) throw Error('核销查询分享目标不一致');
    return scene;
  }
  const paths: Record<number, string> = { '-1': '/pages/index/index', 0: '/pages/goods/detail', 1: '/pages/activity/seckillDetail', 2: '/pages/activity/bargainDetail', 3: '/pages/activity/detail', 4: '/pages/activity/integralDetail', 6: '/pages/activity/presaleDetail', 7: '/pages/activity/newcomerDetail' };
  if (route.pathname !== paths[scene.type]) throw Error('分享目的地与类型不一致');
  const allowed = scene.type === 2 ? ['id', 'bargain_id', 'spid', 'bargainUserId', 'help'] : ['id', 'spid', 'time', 'status'];
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw Error('分享目的地参数无效');
  const idKey = scene.type === 2 && query.has('bargain_id') ? 'bargain_id' : 'id';
  if (scene.type === 2 && query.has('id') && query.has('bargain_id')) throw Error('分享目标编号不一致');
  if (row.bargain_user_id !== undefined) {
    if (scene.type !== 2 || idKey !== 'id') throw Error('砍价邀请目标无效');
    scene.bargain_user_id = integer(row.bargain_user_id, 1);
    if (query.get('bargainUserId') !== String(scene.bargain_user_id) || query.get('help') !== '1') throw Error('砍价邀请目标不一致');
  } else if (query.has('bargainUserId') || query.has('help')) throw Error('砍价邀请目标缺失');
  if (scene.type !== -1 && query.get(idKey) !== String(scene.id) || query.has('spid') && query.get('spid') !== String(scene.spid) || scene.type === -1 && (query.has('id') || query.has('bargain_id'))) throw Error('分享目标编号不一致');
  for (const field of ['time', 'status'] as const) if (row[field] !== undefined) {
    scene[field] = text(row[field], 40);
    if (query.get(field) !== scene[field]) throw Error('秒杀分享参数不一致');
  }
  return scene;
}
/** Referral is consumed by the app-owned intent; existing detail-page visits keep their own contracts. */
export function shareDestination(scene: ShareScene): string {
  const route = shareUri(scene.path);
  // Historical PHP invitations used spid as the owner; canonical links use an
  // exact participant and consume spid only as referral attribution.
  if (!(scene.type === 2 && route.searchParams.has('bargain_id'))) route.searchParams.delete('spid');
  return `${route.pathname}${route.search}`;
}
export function activityShareDescriptor(path: string): { type: LegacyShareType; id: number; bargainUserId?: number } | null {
  const invitation = bargainShareTarget(path);
  if (invitation) return { type: 2, ...invitation };
  const routes: Record<string, LegacyShareType> = { '/pages/activity/seckillDetail': 1, '/pages/activity/bargainDetail': 2, '/pages/activity/detail': 3, '/pages/activity/integralDetail': 4, '/pages/activity/presaleDetail': 6, '/pages/activity/newcomerDetail': 7 };
  try { const url = shareUri(path), type = routes[url.pathname], key = type === 2 ? 'bargain_id' : 'id';
    if (type === 2 && (url.searchParams.size !== 1 || url.hash)) return null;
    if (type === undefined || url.origin !== 'https://share-route.invalid' || url.searchParams.getAll(key).length !== 1 || !/^[1-9]\d*$/u.test(url.searchParams.get(key) ?? '')) return null;
    return { type, id: integer(Number(url.searchParams.get(key)), 1) }; } catch { return null; }
}
