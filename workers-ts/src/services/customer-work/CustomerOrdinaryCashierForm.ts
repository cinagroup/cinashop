import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { DB } from '@/dao/BaseDao';
import { storeOrder, systemAttachment } from '@/models/schema';
import { loadActiveOrderSystemForm, loadOrderSystemFormSubmission, prepareOrderSystemFormSubmission } from '@/services/order/OrderSystemFormService';
import { canonicalAttachmentPath, parseCanonicalAttachmentId, R2_IMAGE_TYPE, type AttachmentService } from '@/services/system/AttachmentService';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { ValidateException } from '@/utils/errors';
import type { CashierOrdinaryCreationFacts } from '@/services/order/CashierOrdinaryOrigin';
import { readCashierOrdinaryOrigin } from '@/services/order/CashierOrdinaryOrigin';
import { freezeCustomerJson } from './CustomerWorkOperationRequest';

const scopeName = 'ordinaryCashierImageScope';
export function publicOrdinaryCashierForm(form: Awaited<ReturnType<typeof loadActiveOrderSystemForm>> | null) {
  return form ? { ...form, value: form.value.map(component => {
    const copy = { ...component }; delete copy.assistedImageScope; delete copy.cashierImageScope; delete copy[scopeName]; return copy;
  }) } : null;
}
/** Uses actual authenticated creator-owned User image uploads. The buyer UID
 * never becomes an upload principal, including guests and other members. */
export async function loadOrdinaryCashierFormSubmission(tx: DbClient, facts: CashierOrdinaryCreationFacts, formId: number, value: unknown) {
  if (formId === 0) return loadOrderSystemFormSubmission(tx, 0, value, facts.intent.buyer_uid);
  const definition = publicOrdinaryCashierForm(await loadActiveOrderSystemForm(tx, formId, true))!;
  const prepared = prepareOrderSystemFormSubmission(definition.value, value, formId);
  if (prepared.attachmentIds.length) {
    const owned = await tx.select({ id: systemAttachment.attId }).from(systemAttachment).where(and(
      inArray(systemAttachment.attId, prepared.attachmentIds), eq(systemAttachment.type, 3), eq(systemAttachment.relationId, facts.actor.uid),
      eq(systemAttachment.moduleType, 3), eq(systemAttachment.fileType, 1), eq(systemAttachment.imageType, R2_IMAGE_TYPE))).for('share', { noWait: true });
    if (owned.length !== prepared.attachmentIds.length) throw new ValidateException('普通收银表单图片须属于原经营账户真实上传');
  }
  const components = JSON.parse(prepared.snapshotJson) as Array<Record<string, unknown>>;
  for (const component of components) {
    delete component.assistedImageScope; delete component.cashierImageScope; delete component[scopeName];
    if (component.name !== 'uploadPicture') continue;
    if (!Array.isArray(component.value) || component.value.some(value => typeof value !== 'string' || !parseCanonicalAttachmentId(value)))
      throw new ValidateException('普通收银图片需要真实附件编号');
    const ids = component.value.map(value => parseCanonicalAttachmentId(value as string)!);
    component[scopeName] = { version: 1, actor_uid: facts.actor.uid, buyer_uid: facts.intent.buyer_uid, creation_key: facts.request_key,
      system_form_id: formId, attachment_ids: ids, attachment_ids_hash: await outRequestHash(ids) };
  }
  prepared.snapshotJson = JSON.stringify(freezeCustomerJson(components, 1_000_000));
  return prepared;
}
/** Null means an older channel contract. A recognized ordinary origin returns
 * its whole bounded form even when an attachment was legitimately removed. */
export async function readOrdinaryCashierFormForOrder(db: DB, attachments: Pick<AttachmentService, 'signReferences'>,
  input: { id: number; uid: number; pid: number; customForm: string | null }) {
  const [root] = await db.select().from(storeOrder).where(eq(storeOrder.id, input.pid > 0 ? input.pid : input.id)).limit(1);
  if (!root || root.productType !== 0 || root.isChannel !== 2) return null;
  const saved = await readCashierOrdinaryOrigin(db, root);
  if (!saved) return null;
  if (root.uid !== input.uid || root.customForm !== input.customForm || typeof input.customForm !== 'string') return [];
  let components: Array<Record<string, unknown>>;
  try { if (new TextEncoder().encode(input.customForm).length > 1_000_000) return []; components = JSON.parse(input.customForm); }
  catch { return []; }
  if (!Array.isArray(components) || components.length > 200 || components.some(c => !c || typeof c !== 'object' || Array.isArray(c))) return [];
  const allowedIds: number[] = [];
  for (const component of components) {
    if (component.name !== 'uploadPicture') continue;
    const proof = component[scopeName] as Record<string, unknown> | undefined;
    if (!proof || proof.version !== 1 || proof.actor_uid !== saved.origin.creator_uid || proof.buyer_uid !== root.uid
      || proof.creation_key !== saved.origin.creation_key || !Number.isSafeInteger(proof.system_form_id) || Number(proof.system_form_id) < 1
      || !Array.isArray(component.value) || component.value.length > 9 || !Array.isArray(proof.attachment_ids)
      || component.value.some(value => typeof value !== 'string' || !parseCanonicalAttachmentId(value))) return [];
    const ids = component.value.map(value => parseCanonicalAttachmentId(value as string)!);
    if (await outRequestHash(ids) !== proof.attachment_ids_hash || await outRequestHash(ids) !== await outRequestHash(proof.attachment_ids)) return [];
    allowedIds.push(...ids);
  }
  const ids = [...new Set(allowedIds)];
  const owned = ids.length ? await db.select({ id: systemAttachment.attId }).from(systemAttachment).where(and(inArray(systemAttachment.attId, ids),
    eq(systemAttachment.type, 3), eq(systemAttachment.relationId, saved.origin.creator_uid), eq(systemAttachment.moduleType, 3),
    eq(systemAttachment.fileType, 1), eq(systemAttachment.imageType, R2_IMAGE_TYPE))) : [];
  const signed = owned.length ? await attachments.signReferences(owned.map(row => canonicalAttachmentPath(row.id))) : [];
  return components.map(component => {
    const result = { ...component }; delete result[scopeName]; delete result.assistedImageScope; delete result.cashierImageScope;
    if (result.name === 'uploadPicture') result.value = (component.value as string[]).flatMap(value => {
      const index = owned.findIndex(row => row.id === parseCanonicalAttachmentId(value)); return index >= 0 && signed[index] ? [signed[index]] : [];
    });
    return result;
  });
}
