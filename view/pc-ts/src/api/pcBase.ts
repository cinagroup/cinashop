import request, { getData } from '@/utils/request';
import type { GoodsItem } from '@/types/product';
import { pcBaseImage, pcBaseLink } from '../../../common/pcBase';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('PC公开配置响应无效');
  return value as Record<string, unknown>;
};
const text = (value: unknown) => typeof value === 'string' ? value : '';
export function pcPublicImage(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (/^\/api\/assets\/[1-9]\d{0,9}\?expires=[1-9]\d{0,15}&signature=[A-Za-z0-9_-]{43}$/u.test(value)) return value;
  try { const image = pcBaseImage(value); return /^\/api\/assets\//u.test(image) ? '' : image; } catch { return ''; }
}
export function pcPublicLink(value: unknown): string {
  try { return pcBaseLink(value, true); } catch { return ''; }
}
function companyLogo(row: Record<string, unknown>): string {
  const source = pcPublicImage(row.pc_logo);
  // Absolute public HTTP values retain their exact authored bytes. Canonical
  // signed private assets belong to this API origin, never site_url's origin.
  if (!source || !source.startsWith('/') || source.startsWith('/api/assets/')) return source;
  const resolved = pcPublicImage(row.logoUrl);
  if (!/^https?:\/\//iu.test(resolved)) return source;
  try {
    const target = new URL(resolved), expected = new URL(source, target.origin);
    // The server may supply the legacy display origin, not a different image.
    return target.href === expected.href ? resolved : source;
  } catch { return source; }
}
export interface PcCompany {
  logo: string; siteName: string; phone: string; address: string; copyright: string; recordNo: string;
  keywords: string; description: string; links: Array<{ name: string; url: string }>;
  filings: Array<{ name: string; url: string; icon: string }>;
}
export function checkedPcCompany(value: unknown): PcCompany {
  const row = object(value);
  if (!Array.isArray(row.links_list) || !Array.isArray(row.filing_list)) throw Error('PC页脚响应不完整');
  return { logo: companyLogo(row), siteName: text(row.site_name), phone: text(row.contact_number),
    address: text(row.company_address), copyright: text(row.copyright), recordNo: text(row.record_No),
    keywords: text(row.site_keywords), description: text(row.site_description),
    links: row.links_open === 1 ? row.links_list.flatMap(value => { const item = object(value), url = pcPublicLink(item.url); return url && text(item.name) ? [{ name: text(item.name), url }] : []; }) : [],
    filings: row.filing_list.map(value => { const item = object(value); return { name: text(item.name), url: pcPublicLink(item.url), icon: pcPublicImage(item.icon) }; }),
  };
}
function cards(value: unknown): GoodsItem[] {
  if (!Array.isArray(value)) throw Error('首页商品完整列表不可用');
  const ids = new Set<number>();
  return value.map(value => {
    const row = object(value);
    if (!Number.isSafeInteger(row.id) || Number(row.id) < 1 || ids.has(Number(row.id)) || typeof row.store_name !== 'string'
      || typeof row.price !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(row.price)) throw Error('首页商品完整列表无效');
    ids.add(Number(row.id));
    return { ...row, image: pcPublicImage(row.image) } as unknown as GoodsItem;
  });
}
export function checkedPcHomepage(value: unknown) {
  const row = object(value), info = object(row.info);
  return { best: cards(info.bastList), fresh: cards(info.firstList) };
}
export const apiPcCompany = (signal?: AbortSignal) => getData<unknown>(request.get('/pc/get_company_info', { signal })).then(checkedPcCompany);
export const apiPcHomepage = (signal?: AbortSignal) => getData<unknown>(request.get('/index', { signal })).then(checkedPcHomepage);
export const apiPcProductCode = (id: number, signal?: AbortSignal) => {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw Error('商品标识无效');
  return getData<unknown>(request.get(`/pc/get_product_code/${id}`, { signal })).then(value => {
    const row = object(value), source = text(row.routineCode);
    if (source && (source.length > 4 * 1024 * 1024 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(source))) throw Error('手机购买图片无效');
    let mobileUrl = '';
    try {
      const base = new URL(text(row.site_url));
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('手机站地址无效');
      mobileUrl = new URL(`/pages/goods_details/index?id=${id}`, base).toString();
    } catch { /* An invalid historical origin supplies no purchase link. */ }
    return { routineCode: source, mobileUrl };
  });
};
