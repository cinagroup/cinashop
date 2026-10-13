import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { AuthException, ValidateException } from '@/utils/errors';

export const LEGACY_SHARE_TYPES = [-1, 0, 1, 2, 3, 4, 6, 7, 90, 91] as const;
export type LegacyShareType = typeof LEGACY_SHARE_TYPES[number];
export interface LegacyShareImage { mime: 'image/png' | 'image/jpeg' | 'image/gif'; base64: string }
export const LEGACY_SHARE_TTL = 30 * 86400;
export const LEGACY_SHARE_IMAGE_TTL = 900;
export const LEGACY_SHARE_IMAGE_LIMIT = 1024 * 1024;
export const legacyShareToken = () => Array.from(randomBytes(12), byte => byte.toString(16).padStart(2,'0')).join('');
export const validLegacyShareToken = (token: string) => /^[a-f0-9]{24}$/.test(token);
export function legacyShareHmac(secret: string, purpose: string, value: string): string {
  if (!secret) throw new ValidateException('分享签名未配置');
  return createHmac('sha256', secret).update(`legacy-share:v1:${purpose}:${value}`).digest('hex');
}
export function legacyShareEqual(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export function legacyShareImage(bytes: Uint8Array, mime: string): LegacyShareImage {
  if (!bytes.length || bytes.length > LEGACY_SHARE_IMAGE_LIMIT) throw new ValidateException('分享码图片超过容量');
  const valid = mime === 'image/png' ? [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'image/gif' ? ['GIF87a','GIF89a'].includes(new TextDecoder().decode(bytes.slice(0,6))) : false;
  if (!valid) throw new ValidateException('分享码图片格式错误');
  return { mime: mime as LegacyShareImage['mime'], base64: Buffer.from(bytes).toString('base64') };
}
export function legacyShareDataImage(data: string): LegacyShareImage {
  const match = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match || match[2].length > Math.ceil(LEGACY_SHARE_IMAGE_LIMIT / 3) * 4) throw new ValidateException('分享码图片格式错误');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) throw new ValidateException('分享码图片编码错误');
  return legacyShareImage(bytes, match[1]);
}
export function legacyShareWebsiteQr(url: string): LegacyShareImage {
  if (url.length > 2048 || !/^https:\/\//.test(url)) throw new ValidateException('分享站点地址错误');
  const qr = qrcode(0, 'M'); qr.addData(url, 'Byte'); qr.make();
  return legacyShareDataImage(qr.createDataURL(6, 4));
}
export function legacyShareOfficialScene(token: string, expires: number, secret: string): string {
  if (!validLegacyShareToken(token) || !Number.isSafeInteger(expires) || expires < 0) throw new ValidateException('分享场景错误');
  const message = `ls:${token}:${expires}`;
  return `${message}:${legacyShareHmac(secret, 'official', message).slice(0,24)}`;
}
export function parseLegacyShareOfficialScene(raw: string, secret: string, now = Math.floor(Date.now()/1000)): { token: string; expires: number } | null {
  const scene = raw.startsWith('qrscene_') ? raw.slice(8) : raw;
  const match = /^ls:([a-f0-9]{24}):(0|[1-9]\d{0,9}):([a-f0-9]{24})$/.exec(scene);
  if (!match || !secret) return null;
  const expires = Number(match[2]);
  if (expires !== 0 && (expires <= now || expires > now + LEGACY_SHARE_TTL)) return null;
  const expected = legacyShareHmac(secret, 'official', `ls:${match[1]}:${expires}`).slice(0,24);
  return timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(match[3],'hex')) ? { token: match[1], expires } : null;
}
export function verifyLegacyShareImageQuery(token: string, channel: string, query: URLSearchParams, secret: string,
  now = Math.floor(Date.now()/1000)): void {
  for (const key of query.keys()) if (!['expires','signature'].includes(key) || query.getAll(key).length !== 1) throw new ValidateException('分享图片参数错误');
  const raw = query.get('expires') ?? '', signature = query.get('signature') ?? '';
  if (!validLegacyShareToken(token) || !['routine','wechat'].includes(channel) || !/^[1-9]\d{0,9}$/.test(raw)
    || Number(raw) <= now || Number(raw) > now + LEGACY_SHARE_IMAGE_TTL
    || !legacyShareEqual(signature,legacyShareHmac(secret,'image',`${token}:${channel}:${raw}`))) throw new AuthException('分享图片凭据已失效');
}
