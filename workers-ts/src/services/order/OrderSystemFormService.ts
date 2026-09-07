import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "@/dao/BaseDao";
import { systemAttachment, systemForm, systemFormData } from "@/models/schema";
import {
  canonicalAttachmentPath,
  parseCanonicalAttachmentId,
  R2_IMAGE_TYPE,
  type AttachmentService,
} from "@/services/system/AttachmentService";
import { ValidateException } from "@/utils/errors";

import {
  MAX_FORM_COMPONENTS, isRecord, parseArray, cloneRecord,
  prepareOrderSystemFormSubmission as prepareCanonicalForm,
  SystemFormValidationError, type PreparedOrderSystemForm,
} from "../../../../view/common/order-system-form";
export type { PreparedOrderSystemForm } from "../../../../view/common/order-system-form";
type JsonRecord = Record<string, unknown>;

/** Only raised by authoritative form validation before the order transaction commits. */
export class OrderFormRejectedException extends ValidateException {}

export function prepareOrderSystemFormSubmission(
  templateValue: unknown, submissionValue: unknown, systemFormId: number,
): PreparedOrderSystemForm {
  try { return prepareCanonicalForm(templateValue, submissionValue, systemFormId); }
  catch (error) {
    if (error instanceof SystemFormValidationError) throw new ValidateException(error.message);
    throw error;
  }
}

export async function loadOrderSystemFormSubmission(
  db: DB, systemFormId: number, submissionValue: unknown, uid: number,
): Promise<PreparedOrderSystemForm | null> {
  try { return await loadValidatedOrderSystemForm(db, systemFormId, submissionValue, uid); }
  catch (error) {
    if (error instanceof ValidateException || error instanceof SystemFormValidationError) {
      throw new OrderFormRejectedException(error.message);
    }
    // Transport/SQL failures do not prove a business rejection.
    throw error;
  }
}

async function loadValidatedOrderSystemForm(
  db: DB,
  systemFormId: number,
  submissionValue: unknown,
  uid: number,
): Promise<PreparedOrderSystemForm | null> {
  if (!Number.isSafeInteger(systemFormId) || systemFormId < 0) {
    throw new ValidateException("系统表单ID错误");
  }
  if (systemFormId === 0) {
    const submission = parseArray(submissionValue, "自定义表单格式错误");
    if (submission.length) throw new ValidateException("当前订单不需要自定义表单");
    return null;
  }
  const rows = await db
    .select({ value: systemForm.value })
    .from(systemForm)
    .where(and(eq(systemForm.id, systemFormId), eq(systemForm.status, 1), eq(systemForm.isDel, 0)))
    .limit(1);
  if (!rows[0]) throw new ValidateException("系统表单已停用或不存在");
  const prepared = prepareOrderSystemFormSubmission(rows[0].value, submissionValue, systemFormId);
  if (prepared.attachmentIds.length) {
    const attachments = await db
      .select({ id: systemAttachment.attId })
      .from(systemAttachment)
      .where(and(
        inArray(systemAttachment.attId, prepared.attachmentIds),
        eq(systemAttachment.type, 3),
        eq(systemAttachment.relationId, uid),
        eq(systemAttachment.fileType, 1),
      ));
    if (new Set(attachments.map((attachment) => attachment.id)).size !== prepared.attachmentIds.length) {
      throw new ValidateException("自定义表单包含无权使用的图片");
    }
  }
  return prepared;
}

export async function collectOrderSystemForm(
  db: DB,
  prepared: PreparedOrderSystemForm | null,
  uid: number,
  orderId: number,
  addTime: number,
): Promise<void> {
  if (!prepared) return;
  await db.insert(systemFormData).values({
    uid,
    systemFormId: String(prepared.systemFormId),
    type: 1,
    relationId: orderId,
    value: prepared.collectedJson,
    isDel: 0,
    addTime,
  });
}

/**
 * Read the immutable order snapshot without letting malformed historical JSON
 * break order detail. Private attachment references are signed only when the
 * attachment still belongs to the order owner; unauthorized references vanish.
 */
export async function readOrderSystemFormSnapshot(
  db: DB,
  attachments: Pick<AttachmentService, "signReferences">,
  uid: number,
  snapshotValue: unknown,
): Promise<JsonRecord[]> {
  let parsed: unknown[];
  try {
    parsed = parseArray(snapshotValue, "订单自定义表单格式错误");
  } catch {
    return [];
  }
  if (parsed.length > MAX_FORM_COMPONENTS || parsed.some((item) => !isRecord(item))) return [];
  const components = (parsed as JsonRecord[]).map(cloneRecord);
  const canonicalIds = [...new Set(components.flatMap((component) => (
    component.name === "uploadPicture" && Array.isArray(component.value)
      ? component.value.flatMap((value) => {
          const id = parseCanonicalAttachmentId(String(value));
          return id ? [id] : [];
        })
      : []
  )))];
  const signedById = new Map<number, string>();
  if (canonicalIds.length) {
    const owned = await db
      .select({ id: systemAttachment.attId })
      .from(systemAttachment)
      .where(and(
        inArray(systemAttachment.attId, canonicalIds),
        eq(systemAttachment.type, 3),
        eq(systemAttachment.relationId, uid),
        eq(systemAttachment.fileType, 1),
        eq(systemAttachment.imageType, R2_IMAGE_TYPE),
      ));
    const paths = owned.map((attachment) => canonicalAttachmentPath(attachment.id));
    const signed = await attachments.signReferences(paths);
    owned.forEach((attachment, index) => {
      const reference = signed[index];
      if (reference) signedById.set(attachment.id, reference);
    });
  }
  return components.map((component) => {
    if (component.name !== "uploadPicture" || !Array.isArray(component.value)) return component;
    return {
      ...component,
      value: component.value.flatMap((value) => {
        const reference = String(value);
        if (/^https:\/\//i.test(reference)) return [reference];
        const id = parseCanonicalAttachmentId(reference);
        const signed = id ? signedById.get(id) : undefined;
        return signed ? [signed] : [];
      }),
    };
  });
}
