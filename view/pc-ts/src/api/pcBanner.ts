import request, { getData } from '@/utils/request';

export interface PcHomeBanner { id: number; title: string; image: string; url: string }
export interface PcBannerLink { kind: 'router' | 'href'; href: string }

/** Check every decoded layer before URL parsing can silently strip control bytes. */
function safeLayers(value: string, protocols: readonly string[]): boolean {
  let decoded = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(decoded) || /[\u0000-\u001f\u007f\\]/u.test(decoded)) return false;
    if (/^\/(?!\/)/u.test(decoded)) { try { if (!/^\/(?!\/)/u.test(new URL(decoded, 'https://pc-banner.invalid').pathname)) return false; } catch { return false; } }
    else { try { const url = new URL(decoded); if (!/^https?:\/\//iu.test(decoded) || !protocols.includes(url.protocol) || url.username || url.password) return false; } catch { return false; } }
    if (!/%[a-f0-9]{2}/iu.test(decoded)) return true;
    if (depth === 3) return false;
    let next: string; try { next = decodeURIComponent(decoded); } catch { return false; }
    decoded = next;
  }
  return false;
}
function supportedRoute(path: string): boolean {
  return /^(?:\/$|\/(?:goods|category|search|seckill|bargain|combination|presale|goods_presell|cart|checkout|order|express|login|register|forgot-password|community|service)$|\/(?:goods|seckill|bargain|combination|presale)\/[1-9]\d*$|\/order\/[^/]+$|\/refund\/[^/]+$|\/user(?:\/(?:offline-pay|offline-result|refunds|phone|address|collect|coupon|balance|spread|invoice|level|recharge))?$|\/user\/refunds\/[1-9]\d*$|\/user\/coupon\/[1-9]\d*\/products$)/u.test(path);
}
export function resolvePcBannerLink(value: unknown): PcBannerLink | null {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 2048 || !safeLayers(value, ['http:', 'https:'])) return null;
  const source = value.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) {
      const url = new URL(source);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^https?:\/\//iu.test(source)) return null;
      return { kind: 'href', href: source };
    }
    const url = new URL(source, 'https://pc-banner.invalid/');
    if (url.origin !== 'https://pc-banner.invalid' || url.username || url.password) return null;
    const legacy = /^\/product\/detail\/([1-9]\d*)\/?$/u.exec(url.pathname);
    if (legacy) url.pathname = `/goods/${legacy[1]}`;
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (!/^\/(?!\/)/u.test(href)) return null;
    return { kind: supportedRoute(url.pathname) ? 'router' : 'href', href };
  } catch { return null; }
}
export function safePcBannerImage(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || !safeLayers(value, ['https:'])) return '';
  try {
    const url = new URL(value, 'https://pc-banner.invalid/');
    if (url.protocol !== 'https:' || url.username || url.password || !(value.startsWith('/') || /^https:\/\//iu.test(value))) return '';
    return value;
  } catch { return ''; }
}
export function parsePcHomeBanners(value: unknown): PcHomeBanner[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('首页轮播格式错误');
  const list = (value as Record<string, unknown>).list;
  if (!Array.isArray(list) || list.length > 10 || list.some(row => !row || typeof row !== 'object' || Array.isArray(row)
    || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > 2_147_483_647 || typeof row.title !== 'string' || [...row.title].length > 4096
    || typeof row.image !== 'string' || !safePcBannerImage(row.image) || typeof row.url !== 'string' || row.url !== '' && !resolvePcBannerLink(row.url))
    || new Set(list.map(row => row.id)).size !== list.length) throw Error('首页轮播响应不完整或包含无效图片与跳转');
  return list.map(row => ({ id: row.id, title: row.title, image: row.image, url: row.url }));
}
export async function apiPcHomeBanners(signal?: AbortSignal): Promise<PcHomeBanner[]> {
  return parsePcHomeBanners(await getData(request.get('/pc/get_banner', { signal })));
}
