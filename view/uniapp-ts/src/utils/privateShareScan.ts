import {shareUri,type ShareScene} from './legacyShare';
import type {ShareScanInput} from './shareScanTransfer';
export type PrivateShareScanRealm='customer'|'staff'|'delivery';
export interface PrivateShareScanPayload {result?:unknown;path?:unknown;scanType?:unknown}
interface Candidate {token:string;origin?:string}
function scanText(value:unknown):string {if(value===undefined||value===null)return '';if(typeof value!=='string'||value.length>2048)throw Error('扫码内容无效');const text=value.trim();if(/[\u0000-\u001f\u007f]/u.test(text))throw Error('扫码内容无效');return text;}
function candidate(value:string):Candidate|null {
  if(!value)return null;let path=value,origin:string|undefined;
  if(/^https?:\/\//iu.test(value)){if(!/#\/pages\/share\/landing(?:\?|$)/u.test(value))return null;const address=shareUri(value);if(address.pathname!=='/'||address.searchParams.size||!address.hash.startsWith('#/pages/share/landing'))return null;if(address.protocol!=='https:')throw Error('分享扫码站点无效');path=address.hash.slice(1);origin=address.origin;}
  else if(path.startsWith('pages/'))path='/'+path;
  if(!/^\/pages\/share\/landing(?:\?|$)/u.test(path))return null;
  const route=shareUri(path),query=route.searchParams;if(route.hash||query.size!==1)throw Error('分享扫码参数无效');
  let token=query.get('q');if(query.has('scene')){const scene=query.get('scene')??'';if(!/^q=[a-f0-9]{24}$/u.test(scene))throw Error('小程序分享扫码场景无效');token=scene.slice(2);}
  if(typeof token!=='string'||!/^[a-f0-9]{24}$/u.test(token))throw Error('分享扫码参数无效');return {token,origin};
}
export function privateShareScanCandidate(payload:PrivateShareScanPayload):{token:string;origins:string[]}|null {
  const result=scanText(payload.result),path=scanText(payload.path),a=candidate(result),b=candidate(path);
  if(!a&&!b)return null;
  if(a&&b&&a.token!==b.token||a&&path&&!b)throw Error('扫码结果与分享目标不一致');
  if(b&&result&&!a&&!(payload.scanType==='WX_CODE'&&/^https?:\/\/weixin\.qq\.com\/q\/[A-Za-z0-9_-]{6,256}$/u.test(result)))throw Error('扫码结果与分享目标不一致');
  return {token:(b??a!).token,origins:[a?.origin,b?.origin].filter((value):value is string=>!!value)};
}
/** No external navigation/fetch. WX_CODE wrapper is only a format hint, never authorization. */
export async function decodePrivateShareScan(payload:PrivateShareScanPayload,realm:PrivateShareScanRealm,read:(token:string)=>Promise<ShareScene>,valid:()=>boolean):Promise<ShareScanInput|null> {
  if(!valid())return null;const selected=privateShareScanCandidate(payload);if(!selected)return null;
  const scene=await read(selected.token);if(!valid())return null;
  if(scene.type!==90&&scene.type!==91||scene.spid!==0||scene.viewer_scope!==realm&&scene.viewer_scope!=='owner'||scene.namespace!==(scene.type===90?'member':'order')||typeof scene.code!=='string'||!scene.code||scene.code.length>32||scene.code!==scene.code.trim()||scene.code==='undefined'||/[\u0000-\u001f\u007f]/u.test(scene.code)||scene.type===91&&!/^\d{12}$/u.test(scene.code)||scene.type===90&&/^\d{12}$/u.test(scene.code))throw Error('当前分享码不能在此工作台查询');
  for(const origin of selected.origins)if(origin!==scene.h5_origin)throw Error('分享扫码站点与当前商城不一致');
  return {namespace:scene.type===90?'member-barcode':'order-code',value:scene.code};
}
