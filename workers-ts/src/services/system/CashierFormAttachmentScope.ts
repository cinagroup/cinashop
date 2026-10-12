import { ValidateException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';

export const CASHIER_IMAGE_SCOPE = 'cashierImageScope';
/** Stable field identity never depends on an editable label or title. */
export function cashierFormFieldId(component: Record<string, unknown>, index: number): string {
  return typeof component.id === 'number' || typeof component.id === 'string'
    ? `id:${JSON.stringify(component.id)}` : `index:${index}`;
}
export interface CashierFormAttachmentOwner {
  actor_uid: number; service_id: number; scope_key: string; request_key: string;
  buyer_uid: number; tourist_key: string; product_id: number; sku_unique: string;
  quantity: number; system_form_id: number;
}
export async function cashierFormScopeDigest(owner: CashierFormAttachmentOwner): Promise<string> {
  const hash = await outRequestHash({ domain: 'customer-cashier-form-images-v1', ...owner });
  const bytes = Uint8Array.from(hash.match(/../g)!, value => parseInt(value, 16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function cashierFormObjectKey(digest: string, uploadKey: string, extension: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(digest) || !/^[0-9a-f-]{36}$/.test(uploadKey)
    || !['jpg', 'png', 'gif', 'webp'].includes(extension)) throw new ValidateException('收银图片存储归属无效');
  return `attachments/cc/${digest}/${uploadKey.replaceAll('-', '')}.${extension}`;
}
export function isCashierFormAttachmentKey(key: string): boolean {
  return /^attachments\/cc\/[A-Za-z0-9_-]{43}\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/.test(key);
}
