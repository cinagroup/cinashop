import { ValidateException } from '@/utils/errors';

/** All fields come from the authenticated actor and stored checkout, never the
 * multipart body. UID=0 is meaningful only with a nonempty tourist identity. */
export interface AssistedFormAttachmentOwner {
  adminId: number;
  uid: number;
  touristUid: string;
  key: string;
  systemFormId: number;
}

export interface AssistedFormAttachmentScope {
  type: 1;
  relationId: number;
  moduleType: 5;
  digest: string;
}

const validId = (value: number, zero = false) => Number.isSafeInteger(value)
  && value >= (zero ? 0 : 1) && value <= 2_147_483_647;

export async function assistedFormAttachmentScope(owner: AssistedFormAttachmentOwner): Promise<AssistedFormAttachmentScope> {
  if (!validId(owner.adminId) || !validId(owner.uid, true) || !validId(owner.systemFormId)
    || !/^[a-f0-9]{32}$/.test(owner.key)
    || (owner.uid > 0 ? owner.touristUid !== '' : !/^[A-Za-z0-9_-]{1,50}$/.test(owner.touristUid))) {
    throw new ValidateException('代客表单图片归属无效');
  }
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    'assisted-form-image-v1', owner.adminId, owner.uid, owner.touristUid, owner.key, owner.systemFormId,
  ]))));
  // Full 256-bit digest, not a truncated identity or raw guest identifier.
  const digest = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { type: 1, relationId: owner.adminId, moduleType: 5, digest };
}

export function assertAssistedFormAttachmentScope(scope: AssistedFormAttachmentScope): void {
  if (scope.type !== 1 || scope.moduleType !== 5 || !validId(scope.relationId)
    || !/^[A-Za-z0-9_-]{43}$/.test(scope.digest)) throw new ValidateException('代客表单图片归属无效');
}

export function assistedFormAttachmentKey(scope: AssistedFormAttachmentScope, extension: string): string {
  assertAssistedFormAttachmentScope(scope);
  if (!['jpg', 'png', 'webp', 'gif'].includes(extension)) throw new ValidateException('图片格式无效');
  // At most 96 ASCII bytes, within the inherited system_attachment.name(100).
  return `attachments/ao/${scope.digest}/${crypto.randomUUID().replaceAll('-', '')}.${extension}`;
}

export function isAssistedFormAttachmentKey(value: string): boolean {
  return /^attachments\/ao\/[A-Za-z0-9_-]{43}\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/.test(value);
}

export function belongsToAssistedFormScope(key: string, scope: AssistedFormAttachmentScope): boolean {
  assertAssistedFormAttachmentScope(scope);
  return isAssistedFormAttachmentKey(key) && key.startsWith(`attachments/ao/${scope.digest}/`);
}
