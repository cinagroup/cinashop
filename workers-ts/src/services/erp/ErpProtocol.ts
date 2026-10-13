import { createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@/utils/errors';

export const ERP_CALLBACK_METHODS = {
  stock: 'inventory.upload', deliver: 'logistics.upload', cancel: 'cancel.order', 'refund-receive': 'refund.goods',
} as const;
export type ErpCallbackKind = keyof typeof ERP_CALLBACK_METHODS;
export const ERP_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const ERP_HASH = /^[a-f0-9]{64}$/;
const MD5 = /^[a-fA-F0-9]{32}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** PHP JSON_UNESCAPED_UNICODE still escapes slashes and line separators.
 * HTTP business values are finite safe JSON numbers with ordinary decimal
 * notation; very small fractions and negative zero are rejected
 * because PHP preserves its sign while JSON.parse/JSON.stringify can lose it. */
export function erpPhpJson(value: unknown): string {
  const seen = new Set<object>();
  function check(item: unknown, depth: number): void {
    if (depth > 20) throw new BadRequestException('ERP 数据层级超限');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      for (let i=0;i<item.length;i++) {
        const unit=item.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next=item.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new BadRequestException('ERP 字符数据无效');
        } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new BadRequestException('ERP 字符数据无效');
      }
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item,-0)
      && (Number.isInteger(item) ? Number.isSafeInteger(item) : Math.abs(item)>=0.0001 && Math.abs(item)<1e15)) return;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new BadRequestException('ERP JSON 数据无效');
    const prototype=Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new BadRequestException('ERP JSON 数据无效');
    if(Array.isArray(item)&&(Object.keys(item).length!==item.length||Object.keys(item).some((key,index)=>key!==String(index))))throw new BadRequestException('ERP JSON 数组无效');
    seen.add(item);
    for (const [key,child] of Object.entries(item)) { check(key,depth+1); check(child,depth+1); }
    seen.delete(item);
  }
  check(value,0);
  return JSON.stringify(value).replaceAll('/','\\/').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
}

/** The readable PHP driver is prefix-secret MD5, not HMAC. Zero is included
 * under PHP 8; null, false and empty string are omitted. */
export function erpPopSign(parameters: Record<string, unknown>, secret: string): string {
  if (Object.keys(parameters).length === 0) return '';
  let material=secret;
  for (const key of Object.keys(parameters).sort()) {
    if (key === '' || key === 'sign') continue;
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))throw new BadRequestException('ERP 签名字段无效');
    const value=parameters[key];
    if (value === null || value === false || value === '') continue;
    if (value === undefined || typeof value === 'bigint') throw new BadRequestException('ERP 签名参数无效');
    erpPhpJson(value);
    if(typeof value==='number'&&!Number.isSafeInteger(value))throw new BadRequestException('ERP 标量签名必须使用整数或十进制字符串');
    material+=key+(typeof value === 'object' ? erpPhpJson(value) : value === true ? '1' : String(value));
  }
  return createHash('md5').update(material,'utf8').digest('hex');
}

export function erpSha256(value: string): string { return createHash('sha256').update(value,'utf8').digest('hex'); }
export function erpEqualHash(actual: string, expected: string): boolean {
  return ERP_HASH.test(actual) && ERP_HASH.test(expected) && timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
}
export function erpEqualSign(actual: string, expected: string): boolean {
  return MD5.test(actual) && MD5.test(expected) && timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
}
export function erpRandomToken(): string { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); }
export function erpCapabilityHash(value: string): string {
  if (!TOKEN.test(value) || Buffer.from(value,'base64url').toString('base64url') !== value) throw new ForbiddenException('ERP 回调凭据无效');
  return erpSha256(value);
}

export type ErpOrderedQuery = ReadonlyArray<readonly [string,string]>;
export function erpOrderedQuery(rawUrl: string): ErpOrderedQuery {
  const url=new URL(rawUrl);
  if (url.search.length > 4096) throw new BadRequestException('ERP 查询参数超限');
  const entries:Array<[string,string]>=[],keys=new Set<string>();
  for (const part of url.search.slice(1).split('&')) {
    if (!part) { if (url.search) throw new BadRequestException('ERP 查询参数无效'); continue; }
    const at=part.indexOf('='); if (at <= 0) throw new BadRequestException('ERP 查询参数无效');
    let key:string,value:string;
    try { key=decodeURIComponent(part.slice(0,at).replaceAll('+',' ')); value=decodeURIComponent(part.slice(at+1).replaceAll('+',' ')); }
    catch { throw new BadRequestException('ERP 查询编码无效'); }
    if (!/^[a-z_]{1,32}$/.test(key) || CONTROL.test(value) || keys.has(key) || entries.length >= 12 || value.length > 1024) {
      throw new BadRequestException('ERP 查询参数无效或重复');
    }
    keys.add(key); entries.push([key,value]);
  }
  return entries;
}

/** JST push query is signed in supplied URL order. Its fixed public key is
 * compatibility only: the private URL capability is separately mandatory. */
export function erpPushSign(query: ErpOrderedQuery): string {
  const map=new Map(query),method=map.get('method') ?? '',partner=map.get('partnerid') ?? '';
  let material=method+partner;
  for (const [key,value] of query) if (!['method','partnerid','partnerkey','sign'].includes(key)) material+=key+value;
  return createHash('md5').update(material+'erp','utf8').digest('hex');
}
export interface ErpCallbackQuery { connectionId:string; capability:string; timestamp:number; ordered:ErpOrderedQuery }
export function erpVerifyCallbackQuery(kind: ErpCallbackKind, rawUrl: string, now: number): ErpCallbackQuery {
  const ordered=erpOrderedQuery(rawUrl),map=new Map(ordered);
  if (ordered.some(([key]) => !['method','partnerid','ts','sign','token','connection','cap'].includes(key))
    || map.get('method') !== ERP_CALLBACK_METHODS[kind] || map.get('partnerid') !== 'erp'
    || !/^\d{10}$/.test(map.get('ts') ?? '') || !ERP_UUID.test(map.get('connection') ?? '')) {
    throw new ForbiddenException('ERP 回调协议无效');
  }
  const timestamp=Number(map.get('ts'));
  if (!Number.isSafeInteger(now) || Math.abs(timestamp-now) > 600 || !erpEqualSign(map.get('sign') ?? '',erpPushSign(ordered))) {
    throw new ForbiddenException('ERP 回调签名或时间无效');
  }
  const capability=map.get('cap') ?? ''; erpCapabilityHash(capability);
  return {connectionId:map.get('connection')!,capability,timestamp,ordered};
}

/** Durable hashes sort object keys; the transport signature intentionally does
 * not. Their distinct representations must never be used interchangeably. */
export function erpCanonical(value: unknown): string {
  erpPhpJson(value);
  function canonical(item:unknown):string {
    if(Array.isArray(item))return `[${item.map(canonical).join(',')}]`;
    if(item!==null&&typeof item==='object')return `{${Object.keys(item as Record<string,unknown>).sort()
      .map(key=>`${JSON.stringify(key)}:${canonical((item as Record<string,unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(item);
  }
  return canonical(value);
}
