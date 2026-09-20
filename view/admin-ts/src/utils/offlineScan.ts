import { offlineReturnOrigin } from '../../../common/offlineReturn';

export type OfflineScanType = 0 | 1;
export type OfflineScanSurface = 'wechat' | 'routine';
export interface OfflineScan {
  type: OfflineScanType; wechat: string; wechatUrl: string; routine: string;
  routineStatus: 'ready' | 'not_configured' | 'unavailable';
}
const fail = (): never => { throw Error('收银码响应无效，请重新获取；不要展示或保存该图片'); };
const page = '/#/pages/annex/offline_pay/index';
function binary(value: unknown, mime: string, max: number): string {
  if (typeof value !== 'string' || !value.startsWith(`data:${mime};base64,`)) return fail();
  const raw = value.slice(`data:${mime};base64,`.length);
  if (!raw || raw.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return fail();
  try { const bytes = atob(raw); if (bytes.length > max || btoa(bytes) !== raw) return fail(); return bytes; }
  catch { return fail(); }
}
function raster(value: unknown) {
  if (typeof value !== 'string') return fail();
  const mime = value.startsWith('data:image/png;') ? 'image/png' : 'image/jpeg';
  const bytes = binary(value, mime, 1024 * 1024);
  if (mime === 'image/png' ? !bytes.startsWith('\x89PNG\r\n\x1a\n') : !bytes.startsWith('\xff\xd8\xff')) return fail();
}
function svg(value: unknown, max: number): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary(value, 'image/svg+xml', max), c => c.charCodeAt(0))); }
  catch { return fail(); }
}
/** This version's fixed wire format, NOT an arbitrary SVG sanitizer. No XML
 * entities, scripts, extra attributes, external resources or hidden markup.
 * Layout changes must update the contract and the real-backend fixtures. */
function rawQr(value: unknown) {
  const source = svg(value, 256 * 1024);
  const match = /^<svg version="1\.1" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)px" height="\1px" viewBox="0 0 \1 \1"  preserveAspectRatio="xMinYMin meet"><rect width="100%" height="100%" fill="white" cx="0" cy="0"\/><path d="([M0-9,l z-]+)" stroke="transparent" fill="black"\/><\/svg>$/.exec(source);
  if (!match) return fail();
  const size = Number(match[1]), modules = size / 6 - 8;
  if (String(size) !== match[1] || size > 1110 || modules < 21 || modules > 177 || (modules - 21) % 4 !== 0) return fail();
  const path = match[2], found = [...path.matchAll(/M(\d+),(\d+)l6,0 0,6 -6,0 0,-6z /g)];
  if (!found.length || found.map(cell => cell[0]).join('') !== path || found.length > modules * modules) return fail();
  for (const cell of found) for (const coordinate of [Number(cell[1]), Number(cell[2])]) {
    if (coordinate < 24 || coordinate > size - 30 || coordinate % 6 !== 0) return fail();
  }
}
const compact = (value: string) => value.trim().replace(/>\s+</g, '><');
function poster(value: unknown, surface: OfflineScanSurface) {
  const source = svg(value, 2 * 1024 * 1024), match = /<image href="([A-Za-z0-9:/+;,=]+)"/.exec(source);
  if (!match) return fail();
  const image = match[1]; surface === 'wechat' ? rawQr(image) : raster(image);
  const expected = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="720" viewBox="0 0 500 720">
    <title>线下消费收银海报</title><desc>扫码进入收银台，登录后核对金额。此码不代表付款成功。</desc>
    <rect width="500" height="720" fill="white"/><rect width="500" height="100" fill="#16324f"/>
    <g text-anchor="middle" font-family="sans-serif"><text x="250" y="63" font-size="30" fill="white">线下消费收银</text>
    <image href="${image}" x="60" y="126" width="380" height="380"/>
    <text x="250" y="551" font-size="24" fill="#16324f">${surface === 'wechat' ? 'H5' : '小程序'} 扫码进入收银台</text>
    <text x="250" y="601" font-size="18" fill="#334155">登录后核对金额，应付至少 0.01 元</text>
    <text x="250" y="636" font-size="18" fill="#334155">此二维码不是付款成功凭据</text></g></svg>`;
  if (compact(source) !== compact(expected)) return fail();
}
export function parseOfflineScan(value: unknown, expectedType: OfflineScanType): OfflineScan {
  if (expectedType !== 0 && expectedType !== 1) return fail();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (Object.keys(data).sort().join(',') !== 'routine,routine_status,type,version,wechat,wechat_url'
    || data.version !== 'admin-offline-scan-v1' || data.type !== expectedType || typeof data.wechat_url !== 'string'
    || typeof data.wechat !== 'string' || typeof data.routine !== 'string') return fail();
  try { const url = new URL(data.wechat_url); if (data.wechat_url !== offlineReturnOrigin(url.origin) + page) return fail(); }
  catch { return fail(); }
  expectedType === 0 ? rawQr(data.wechat) : poster(data.wechat, 'wechat');
  const status = data.routine_status;
  if (status === 'ready') { expectedType === 0 ? raster(data.routine) : poster(data.routine, 'routine'); }
  else if ((status !== 'not_configured' && status !== 'unavailable') || data.routine !== '') return fail();
  return { type: expectedType, wechat: data.wechat, wechatUrl: data.wechat_url, routine: data.routine, routineStatus: status };
}
export function offlineScanFilename(data: OfflineScan, surface: OfflineScanSurface): string {
  const extension = data[surface].startsWith('data:image/png;') ? 'png' : data[surface].startsWith('data:image/jpeg;') ? 'jpg' : 'svg';
  return `cinashop-offline-${surface === 'wechat' ? 'h5' : 'mini'}-${data.type === 1 ? 'poster' : 'qr'}.${extension}`;
}
