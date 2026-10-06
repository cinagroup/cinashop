/** Integral activity selection is neither a stock reservation nor a financial quote. */
import { sanitizeArticleRichText } from './articleRichText';

export interface IntegralSku {
  id: number; unique: string; suk: string; image: string; price: string; otPrice: string;
  integral: number; stock: number; purchasable: boolean; issues: string[];
}
export interface IntegralDetail {
  storeInfo: {
    id: number; productId: number; storeName: string; unitName: string; image: string; images: string[];
    description: string; productType: number; sales: number; onceNum: number; num: number;
    systemFormId: number; deliveryType: string[]; price: string; otPrice: string; integral: number;
    storeLabel: { id: number; labelName: string; styleType: number; color: string; bgColor: string; borderColor: string; icon: string }[];
    ensure: { id: number; name: string; image: string; desc: string }[];
    specs: { name: string; value: string; sort: number }[]; brandName: string;
  };
  skus: IntegralSku[]; productAttr: { id: number; name: string; values: string[] }[];
  productValue: Record<string, IntegralSku>; saleStock: 0 | 1; issues: string[];
  siteName: string; siteUrl: string; shareQrcode: 0 | 1; productPosterTitle: string;
}
const invalid = (): never => { throw new Error('积分商品数据格式错误，请刷新或稍后重试'); };
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function array(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid(); }
function integer(value: unknown, min = 0, max = 2_147_483_647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function text(value: unknown, max = 4096, multiline = false, codepoints = true): string {
  return typeof value === 'string' && value.length <= max * (codepoints ? 2 : 1) && (!codepoints || [...value].length <= max) &&
    !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value) ? value : invalid();
}
function strings(value: unknown, max = 100): string[] { return array(value, max).map(item => text(item)); }
function money(value: unknown): string { const raw = text(value, 32); return /^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(raw) ? raw : invalid(); }
export function integralActivityId(value: unknown): number {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/u.test(value) ? integer(Number(value), 1) : invalid();
}
export function integralRouteQuery(query: Record<string, unknown>): { id: number; spid: number } {
  let source = query;
  if (query.scene !== undefined) {
    if (typeof query.scene !== 'string' || query.scene.length > 2048 || query.id !== undefined || query.spid !== undefined) return invalid();
    let decoded: string;
    try { decoded = decodeURIComponent(query.scene); } catch { return invalid(); }
    const fields: Record<string, string> = {};
    for (const entry of decoded.split('&')) {
      const position = entry.indexOf('='); if (position < 1) return invalid();
      let key: string, value: string;
      try { key = decodeURIComponent(entry.slice(0, position)); value = decodeURIComponent(entry.slice(position + 1)); } catch { return invalid(); }
      if (!['id', 'spid', 'type'].includes(key) || Object.hasOwn(fields, key)) return invalid(); fields[key] = value;
    }
    source = fields;
  }
  if (source.type !== undefined && source.type !== '4') return invalid();
  return { id: integralActivityId(source.id), spid: source.spid === undefined ? 0 : integralActivityId(source.spid) };
}
/** Signed public previews are accepted; unsafe or missing media becomes a local placeholder. */
function safeAddress(value: unknown, allowHttp = false): string {
  if (typeof value !== 'string' || !value || value.length > 8192) return '';
  let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer)) return '';
    try {
      if (/^\/(?!\/)/u.test(layer)) { if (!/^\/(?!\/)/u.test(new URL(layer, 'https://integral.invalid').pathname)) return ''; }
      else { const url = new URL(layer); if (!(allowHttp ? /^https?:\/\//iu : /^https:\/\//iu).test(layer) || ![...(allowHttp ? ['http:'] : []), 'https:'].includes(url.protocol) || url.username || url.password) return ''; }
    } catch { return ''; }
    if (!/%[a-f0-9]{2}/iu.test(layer)) return value;
    if (depth === 3) return ''; try { layer = decodeURIComponent(layer); } catch { return ''; }
  }
  return '';
}
export function integralImage(value: unknown): string { return safeAddress(value); }
export function integralDescription(value: string): string {
  // The server already authorizes and signs embedded assets. Rebuild markup a
  // second time for H5, then apply the same media policy as the gallery.
  return sanitizeArticleRichText(value).replace(/<img\b([^>]*)>/giu, (tag: string) => {
    const source = tag.match(/\ssrc="([^"]*)"/iu)?.[1]?.replace(/&amp;/gu, '&');
    return integralImage(source) ? tag : '';
  }).replace(/<a\b([^>]*)>/giu, (tag: string) => {
    const source = tag.match(/\shref="([^"]*)"/iu)?.[1]?.replace(/&amp;/gu, '&');
    return safeAddress(source, true) ? tag : tag.replace(/\shref="[^"]*"/iu, '');
  });
}
export function parseIntegralDetail(value: unknown, expectedId: number): IntegralDetail {
  integer(expectedId, 1);
  const row = object(value), info = object(row.storeInfo);
  if (info.id !== expectedId) return invalid();
  const ids = new Set<number>();
  const skus = array(row.skus, 500).map(value => {
    const sku = object(value), unique = text(sku.unique, 8), id = integer(sku.id, 1), stock = integer(sku.stock), issues = strings(sku.issues);
    if (ids.has(id) || typeof sku.purchasable !== 'boolean' || sku.purchasable && (stock < 1 || !unique || /\s/u.test(unique) || issues.some(issue => ['sku_money_invalid', 'sku_integral_invalid'].includes(issue)))) return invalid();
    if ((!unique || /\s/u.test(unique)) && (sku.purchasable || stock !== 0 || !issues.length)) return invalid();
    ids.add(id);
    return { id, unique, suk: text(sku.suk), image: integralImage(sku.image), price: money(sku.price), otPrice: money(sku.otPrice),
      integral: integer(sku.integral), stock, purchasable: sku.purchasable, issues };
  });
  for (const sku of skus) if (sku.unique && skus.filter(other => other.unique === sku.unique).length > 1 &&
    (sku.purchasable || sku.stock !== 0 || !sku.issues.length)) return invalid();
  const productValue: Record<string, IntegralSku> = Object.create(null);
  const rawValues = object(row.productValue);
  if (Object.keys(rawValues).length > 500) return invalid();
  for (const key of Object.keys(rawValues)) {
    const entry = object(rawValues[key]), sku = skus.find(item => item.id === entry.id && item.unique === entry.unique);
    if (!sku || entry.suk !== sku.suk || entry.stock !== sku.stock || entry.price !== sku.price || entry.integral !== sku.integral || entry.purchasable !== sku.purchasable) return invalid();
    productValue[key] = sku;
  }
  const saleStock = integer(row.saleStock, 0, 1) as 0 | 1;
  if (saleStock !== (skus.some(sku => sku.purchasable && sku.stock > 0) ? 1 : 0)) return invalid();
  return {
    storeInfo: { id: expectedId, productId: integer(info.productId, 1), storeName: text(info.storeName, 256), unitName: text(info.unitName, 16),
      image: integralImage(info.image), images: array(info.images, 1000).map(integralImage).filter(Boolean),
      description: integralDescription(text(info.description, 2 * 1024 * 1024, true, false)), productType: integer(info.productType, 0, 4), sales: integer(info.sales),
      onceNum: integer(info.onceNum), num: integer(info.num), systemFormId: integer(info.systemFormId), deliveryType: strings(info.deliveryType, 10),
      price: money(info.price), otPrice: money(info.otPrice), integral: integer(info.integral),
      storeLabel: array(info.storeLabel, 100).map(value => { const label = object(value); return { id: integer(label.id, 1), labelName: text(label.labelName, 255), styleType: integer(label.styleType), color: text(label.color, 64), bgColor: text(label.bgColor, 64), borderColor: text(label.borderColor, 64), icon: integralImage(label.icon) }; }),
      ensure: array(info.ensure, 100).map(value => { const ensure = object(value); return { id: integer(ensure.id, 1), name: text(ensure.name), image: integralImage(ensure.image), desc: text(ensure.desc, 10000, true) }; }),
      specs: array(info.specs, 100).map(value => { const spec = object(value); return { name: text(spec.name), value: text(spec.value, 10000, true), sort: integer(spec.sort, -2147483648, 2147483647) }; }),
      brandName: text(info.brandName, 100),
    },
    skus, productValue, productAttr: array(row.productAttr, 10).map(value => { const attr = object(value); return { id: integer(attr.id, 1), name: text(attr.name), values: strings(attr.values, 500) }; }),
    saleStock, issues: strings(row.issues, 1000), siteName: text(row.siteName, 255), siteUrl: integralSiteOrigin(text(row.siteUrl, 255)), shareQrcode: integer(row.shareQrcode, 0, 1) as 0 | 1, productPosterTitle: text(row.productPosterTitle, 255),
  };
}
export function integralMaxQuantity(detail: IntegralDetail, unique: string): number {
  const sku = detail.skus.find(sku => sku.unique === unique);
  return sku?.purchasable ? Math.max(0, Math.min(sku.stock, 32767, detail.storeInfo.onceNum || 32767)) : 0;
}
export function integralSkuPriceLabel(sku: IntegralSku): string {
  if (sku.issues.some(issue => issue === 'sku_money_invalid' || issue === 'sku_integral_invalid')) return '规格报价异常，暂不可兑换';
  return `${sku.integral}积分 + ¥${sku.price}`;
}
export function integralSelectionTotals(detail: IntegralDetail, unique: string, quantity: number): { integral: string; cash: string } | null {
  const sku = detail.skus.find(sku => sku.unique === unique);
  if (!sku || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > integralMaxQuantity(detail, unique)) return null;
  const cents = BigInt(sku.price.replace('.', '')) * BigInt(quantity);
  return { integral: String(BigInt(sku.integral) * BigInt(quantity)), cash: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` };
}
export function integralCartInput(detail: IntegralDetail, unique: string, quantity: number) {
  if (!integralSelectionTotals(detail, unique, quantity)) throw new Error('请选择有效的积分规格和兑换数量');
  return { productId: detail.storeInfo.productId, activityId: detail.storeInfo.id, unique, cartNum: quantity, type: 4 as const, new: 1 as const };
}
export function integralCheckoutUrl(cartId: number): string {
  integer(cartId, 1); return `/pages/order/confirm?mode=buy&cartId=${cartId}&type=4`;
}
export function integralDetailUrl(activityId: number): string { integer(activityId, 1); return `/pages/activity/integralDetail?id=${activityId}`; }
export function integralSiteOrigin(value: string): string {
  if (!value || value.length > 255) return '';
  try { const url = new URL(value), labels = url.hostname.split('.'); return /^https:\/\//u.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.port && url.origin === value &&
    labels.length >= 2 && url.hostname.length <= 253 && /^[a-z]{2,63}$/u.test(labels.at(-1)!) && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ? value : ''; }
  catch { return ''; }
}
