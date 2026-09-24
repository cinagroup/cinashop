import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/dao/BaseDao";
import { storeOrder, systemAttachment, systemForm, systemFormData } from "@/models/schema";
import { assistedFormAttachmentScope, belongsToAssistedFormScope,
  type AssistedFormAttachmentOwner } from '@/services/system/AssistedFormAttachmentScope';
import {
  canonicalAttachmentPath,
  parseCanonicalAttachmentId,
  R2_IMAGE_TYPE,
  type AttachmentService,
} from "@/services/system/AttachmentService";
import { ValidateException } from "@/utils/errors";

import {
  MAX_FORM_COMPONENTS, isRecord, parseArray, cloneRecord, parseOrderSystemFormTemplate,
  prepareOrderSystemFormSubmission as prepareCanonicalForm,
  SystemFormValidationError, type PreparedOrderSystemForm,
} from "../../../../view/common/order-system-form";
export type { PreparedOrderSystemForm } from "../../../../view/common/order-system-form";
type JsonRecord = Record<string, unknown>;
type AssistedFormContext = Pick<AssistedFormAttachmentOwner, 'adminId' | 'touristUid' | 'key'>;
const IMAGE_SCOPE = 'assistedImageScope';
const MAX_SNAPSHOT_BYTES = 1_000_000;
const scopedImageId = (value: unknown) => {
  const id = typeof value === 'string' ? parseCanonicalAttachmentId(value) : null;
  return id && id <= 2_147_483_647 ? id : null;
};

/** Only raised by authoritative form validation before the order transaction commits. */
export class OrderFormRejectedException extends ValidateException {}

/** Product-selected active template, not an arbitrary form directory or past
 * customer submission. Callers retain their own authentication/scope checks. */
export async function loadActiveOrderSystemForm(db: DB, systemFormId: number, pinForCreation = false) {
  if (!Number.isSafeInteger(systemFormId) || systemFormId <= 0) throw new ValidateException("系统表单ID错误");
  const query = db.select({ id: systemForm.id, name: systemForm.name,
    value: sql<string | null>`CASE WHEN octet_length(${systemForm.value}) <= 1000000 THEN ${systemForm.value} ELSE NULL END`,
  }).from(systemForm).where(and(eq(systemForm.id, systemFormId), eq(systemForm.status, 1), eq(systemForm.isDel, 0))).limit(1);
  // Reuse the commissioned row-lock privilege, not configuration write access.
  // NOWAIT avoids introducing a form-management/product/user lock-order wait.
  // Quote-only callers remain READ ONLY and do not acquire row locks.
  const [row] = await (pinForCreation ? query.for('share', { noWait: true }) : query);
  if (!row) throw new ValidateException("系统表单已停用或不存在");
  try { return { id: row.id, name: row.name, value: parseOrderSystemFormTemplate(row.value) }; }
  catch (error) {
    if (error instanceof SystemFormValidationError) throw new ValidateException(error.message);
    throw error;
  }
}

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
  assisted?: AssistedFormContext,
): Promise<PreparedOrderSystemForm | null> {
  try { return await loadValidatedOrderSystemForm(db, systemFormId, submissionValue, uid, assisted); }
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
  assisted?: AssistedFormContext,
): Promise<PreparedOrderSystemForm | null> {
  if (!Number.isSafeInteger(systemFormId) || systemFormId < 0) {
    throw new ValidateException("系统表单ID错误");
  }
  if (systemFormId === 0) {
    const submission = parseArray(submissionValue, "自定义表单格式错误");
    if (submission.length) throw new ValidateException("当前订单不需要自定义表单");
    return null;
  }
  const definition = await loadActiveOrderSystemForm(db, systemFormId, true);
  // Reserved server evidence must not be inherited from an editable template.
  const template = definition.value.map(component => {
    const copy = { ...component }; delete copy[IMAGE_SCOPE]; return copy;
  });
  const prepared = prepareOrderSystemFormSubmission(template, submissionValue, systemFormId);
  if (assisted) {
    const scope = await assistedFormAttachmentScope({ ...assisted, uid, systemFormId });
    const components = JSON.parse(prepared.snapshotJson) as JsonRecord[];
    for (const component of components) {
      if (component.name !== 'uploadPicture') continue;
      if (!Array.isArray(component.value) || component.value.some(value => !scopedImageId(value))) {
        throw new ValidateException('代客表单图片必须使用当前结算上传的图片');
      }
      component[IMAGE_SCOPE] = { version: 1, adminId: assisted.adminId, uid,
        key: assisted.key, systemFormId, digest: scope.digest };
    }
    if (prepared.attachmentIds.length) {
      const owned = await db.select({ id: systemAttachment.attId, name: systemAttachment.name })
        .from(systemAttachment).where(and(inArray(systemAttachment.attId, prepared.attachmentIds),
          eq(systemAttachment.type, scope.type), eq(systemAttachment.relationId, scope.relationId),
          eq(systemAttachment.moduleType, scope.moduleType), eq(systemAttachment.fileType, 1),
          eq(systemAttachment.imageType, R2_IMAGE_TYPE))).for('share', { noWait: true });
      if (owned.length !== prepared.attachmentIds.length || owned.some(row => !belongsToAssistedFormScope(row.name, scope))) {
        throw new ValidateException('自定义表单包含无权使用的图片');
      }
    }
    prepared.snapshotJson = JSON.stringify(components);
    if (new TextEncoder().encode(prepared.snapshotJson).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new ValidateException('自定义表单数据过大');
    }
  } else if (prepared.attachmentIds.length) {
    // UID=0 is not an attachment principal. Assisted guest uploads need an
    // explicit guest/actor scope; never share all relation_id=0 attachments.
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("游客表单图片尚未建立独立归属");
    const attachments = await db
      .select({ id: systemAttachment.attId })
      .from(systemAttachment)
      .where(and(
        inArray(systemAttachment.attId, prepared.attachmentIds),
        eq(systemAttachment.type, 3),
        eq(systemAttachment.relationId, uid),
        eq(systemAttachment.moduleType, 3),
        eq(systemAttachment.fileType, 1),
        eq(systemAttachment.imageType, R2_IMAGE_TYPE),
      ));
    if (new Set(attachments.map((attachment) => attachment.id)).size !== prepared.attachmentIds.length) {
      throw new ValidateException("自定义表单包含无权使用的图片");
    }
  }
  return prepared;
}

type FormOrder = Pick<typeof storeOrder.$inferSelect,
  'id' | 'uid' | 'staffId' | 'isChannel' | 'unique' | 'pid' | 'customForm'>;

function snapshotComponents(value: unknown): JsonRecord[] | null {
  try {
    const json = typeof value === 'string' ? value : JSON.stringify(value ?? []);
    if (json.length > MAX_SNAPSHOT_BYTES || new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_BYTES) return null;
    const parsed = parseArray(json, '订单自定义表单格式错误');
    if (parsed.length > MAX_FORM_COMPONENTS || parsed.some(item => !isRecord(item)
      || (item.name === 'uploadPicture' && (!Array.isArray(item.value) || item.value.length > 9)))) return null;
    return (parsed as JsonRecord[]).map(cloneRecord);
  } catch { return null; }
}

/** Caller authorizes the visible order first, inside its read snapshot. Split
 * children retain the root's form verbatim; never authorize using a child's new
 * random key, a current cart, an expired KV session, or the shared guest UID. */
export async function readOrderSystemFormForOrder(
  db: DB, attachments: Pick<AttachmentService, 'signReferences'>, order: FormOrder,
): Promise<JsonRecord[]> {
  if (order.isChannel !== 2) return readOrderSystemFormSnapshot(db, attachments, order.uid, order.customForm);
  const components = snapshotComponents(order.customForm);
  if (!components) return [];
  let root: FormOrder | undefined = order;
  if (order.pid > 0) {
    [root] = await db.select({ id: storeOrder.id, uid: storeOrder.uid, staffId: storeOrder.staffId,
      isChannel: storeOrder.isChannel, unique: storeOrder.unique, pid: storeOrder.pid,
      customForm: sql<string | null>`CASE WHEN octet_length(${storeOrder.customForm}) <= 1000000 THEN ${storeOrder.customForm} ELSE NULL END`,
    }).from(storeOrder).where(and(eq(storeOrder.id, order.pid), eq(storeOrder.uid, order.uid),
      eq(storeOrder.staffId, order.staffId), eq(storeOrder.isChannel, 2), eq(storeOrder.pid, -1),
      eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(1);
    if (root?.customForm !== order.customForm) root = undefined;
  } else if (order.pid !== 0 && order.pid !== -1) root = undefined;
  const scopes = components.map(component => {
    const proof = component[IMAGE_SCOPE];
    if (component.name !== 'uploadPicture' || !root || !isRecord(proof) || proof.version !== 1
      || !Number.isSafeInteger(root.staffId) || root.staffId <= 0 || !Number.isSafeInteger(root.uid) || root.uid < 0
      || proof.adminId !== root.staffId || proof.uid !== root.uid || proof.key !== root.unique
      || typeof root.unique !== 'string' || !/^[a-f0-9]{32}$/.test(root.unique) || !Number.isSafeInteger(proof.systemFormId)
      || Number(proof.systemFormId) <= 0 || typeof proof.digest !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(proof.digest)) return null;
    return { type: 1 as const, relationId: root.staffId, moduleType: 5 as const, digest: proof.digest };
  });
  const ids = [...new Set(components.flatMap((component, index) => scopes[index] && Array.isArray(component.value)
    ? component.value.flatMap(value => { const id = scopedImageId(value); return id ? [id] : []; }) : []))];
  const owned = ids.length && root ? await db.select({ id: systemAttachment.attId, name: systemAttachment.name })
    .from(systemAttachment).where(and(inArray(systemAttachment.attId, ids), eq(systemAttachment.type, 1),
      eq(systemAttachment.relationId, root.staffId), eq(systemAttachment.moduleType, 5),
      eq(systemAttachment.fileType, 1), eq(systemAttachment.imageType, R2_IMAGE_TYPE))) : [];
  const allowed = owned.filter(row => scopes.some(scope => scope && belongsToAssistedFormScope(row.name, scope)));
  const signed = allowed.length ? await attachments.signReferences(allowed.map(row => canonicalAttachmentPath(row.id))) : [];
  return components.map((component, index) => {
    const scope = scopes[index]; delete component[IMAGE_SCOPE];
    if (component.name !== 'uploadPicture') return component;
    return { ...component, value: scope && Array.isArray(component.value) ? component.value.flatMap(value => {
      const id = scopedImageId(value);
      const position = allowed.findIndex(row => row.id === id && belongsToAssistedFormScope(row.name, scope));
      return position >= 0 && signed[position] ? [signed[position]] : [];
    }) : [] };
  });
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
  const components = snapshotComponents(snapshotValue);
  if (!components) return [];
  components.forEach(component => { delete component[IMAGE_SCOPE]; });
  const canonicalIds = [...new Set(components.flatMap((component) => (
    component.name === "uploadPicture" && Array.isArray(component.value)
      ? component.value.flatMap((value) => {
          const id = parseCanonicalAttachmentId(String(value));
          return id ? [id] : [];
        })
      : []
  )))];
  const signedById = new Map<number, string>();
  if (canonicalIds.length && Number.isSafeInteger(uid) && uid > 0) {
    const owned = await db
      .select({ id: systemAttachment.attId })
      .from(systemAttachment)
      .where(and(
        inArray(systemAttachment.attId, canonicalIds),
        eq(systemAttachment.type, 3),
        eq(systemAttachment.relationId, uid),
        eq(systemAttachment.moduleType, 3),
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
