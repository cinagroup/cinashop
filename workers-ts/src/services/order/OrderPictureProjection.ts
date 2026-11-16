import { inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';

type Row = Record<string, unknown>;
type Owner = { type: number; relationId: number };
type Slot = { row: Row; owner: Owner; image: unknown };
const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const missingOwner: Owner = { type: -1, relationId: 0 };

function picture(slots: Slot[], value: unknown, owner: Owner) {
  const row = record(value);
  if (row && Object.hasOwn(row, 'image')) slots.push({ row, owner, image: row.image });
}

async function render(db: DbClient, appKey: string | undefined, slots: Slot[]) {
  const references: string[] = [];
  // Preserve the complete response when a bounded order page has many lines;
  // each ownership query retains the policy's existing finite batch limit.
  for (let start = 0; start < slots.length; start += 10_000) {
    references.push(...await publicProductPictures(db, slots.slice(start, start + 10_000)
      .map(slot => ({ ...slot.owner, image: slot.image }))));
  }
  const images = await renderProductPictures(appKey, references);
  slots.forEach((slot, index) => { slot.row.image = images[index]!; });
}

/** Response-only copies. Call after cart ownership/admission, never on the
 * internal pricing rows: signatures are not cart, quote or snapshot authority. */
export async function projectCartPictures<T>(db: DbClient, appKey: string | undefined, rows: readonly T[]): Promise<T[]> {
  const output = structuredClone([...rows]);
  const productId = (value: unknown) => {
    const row = record(value), product = record(row?.productInfo);
    const id = row?.productId ?? row?.product_id ?? product?.id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const ids = [...new Set(output.map(productId).filter((id): id is number => id !== null))];
  const products = ids.length ? await db.select({ id: storeProduct.id, type: storeProduct.type,
    relationId: storeProduct.relationId }).from(storeProduct).where(inArray(storeProduct.id, ids)) : [];
  const owners = new Map(products.map(product => [product.id, product]));
  const slots: Slot[] = [];
  for (const value of output) {
    const row = record(value), product = record(row?.productInfo);
    const id = productId(value), owner = id === null ? missingOwner : owners.get(id) ?? missingOwner;
    picture(slots, product, owner);
    picture(slots, product?.attrInfo, owner);
  }
  await render(db, appKey, slots);
  return output;
}

/** Call only after the persisted order owner has been checked. The media owner
 * is store_order_cart_info.type/relationId, copied from the product at creation;
 * neither activity type nor untrusted JSON owner fields grant a signature.
 * Cloning also keeps signed URLs out of stored JSON and finance fingerprints. */
export async function projectOrderPictures<T extends { type: number; relationId: number; cartInfo: unknown }>(
  db: DbClient, appKey: string | undefined, rows: readonly T[],
): Promise<T[]> {
  const output = structuredClone([...rows]), slots: Slot[] = [];
  for (const row of output) {
    const snapshot = record(row.cartInfo);
    const owner = { type: row.type, relationId: row.relationId };
    picture(slots, snapshot?.product, owner);
    picture(slots, snapshot?.sku, owner);
    const product = record(snapshot?.productInfo);
    picture(slots, product, owner);
    picture(slots, product?.attrInfo, owner);
  }
  await render(db, appKey, slots);
  return output;
}
