import { quoteMoney } from './checkoutQuote';

/** Additive, server-calculated ordinary-SKU membership quote; not an order total. */
export interface SkuMembershipPrice {
  member_price?: string;
  price_type?: '' | 'level' | 'member';
  level_name?: string;
}

const cents = (value: string) => BigInt(quoteMoney(value).replace('.', ''));

export function normalizeSkuMembershipPrice(row: Record<string, unknown>): SkuMembershipPrice {
  // Old responses have no current-user quote. Never inherit a product-level discount.
  if (row.member_price === undefined || row.member_price === null || row.member_price === '') return {};
  const price = quoteMoney(row.member_price);
  const base = quoteMoney(row.price);
  const type = row.price_type;
  if ((type !== '' && type !== 'level' && type !== 'member')
    || (row.level_name !== undefined && typeof row.level_name !== 'string')
    || cents(price) > cents(base) || (cents(base) > 0n && cents(price) === 0n)
    || (type === '') !== (cents(price) === cents(base))) {
    throw new Error('商品规格会员报价不一致');
  }
  return { member_price: price, price_type: type,
    level_name: type === 'level' && typeof row.level_name === 'string' ? row.level_name.trim() : '' };
}

type DisplaySku = SkuMembershipPrice & { price: string; vip_price: string | null };

export function skuDisplayPrice(sku: DisplaySku): string { return sku.member_price ?? sku.price; }

export function skuPriceLabel(sku: SkuMembershipPrice | null | undefined): string {
  if (!sku?.member_price) return '';
  return sku.price_type === 'member' ? 'SVIP价' : sku.price_type === 'level' ? `${sku.level_name || '会员'}价` : '';
}

/** Advertised paid-member offer is separate from the price this user currently gets. */
export function skuVipOffer(sku: DisplaySku | null | undefined, enabled: boolean): string | null {
  if (!enabled || !sku?.vip_price) return null;
  try {
    const offer = quoteMoney(sku.vip_price);
    return cents(offer) > 0n && cents(offer) < cents(skuDisplayPrice(sku)) ? offer : null;
  } catch { return null; }
}
