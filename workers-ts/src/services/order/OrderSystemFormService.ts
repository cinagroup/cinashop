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

const MAX_FORM_COMPONENTS = 100;
const MAX_FORM_JSON_BYTES = 1_000_000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_UPLOAD_IMAGES = 9;

const COMPONENT_NAMES = new Set([
  "checkboxs",
  "citys",
  "dates",
  "dateranges",
  "radios",
  "selects",
  "texts",
  "times",
  "timeranges",
  "uploadPicture",
]);

type JsonRecord = Record<string, unknown>;

export interface PreparedOrderSystemForm {
  systemFormId: number;
  /** Complete canonical component snapshot stored on store_order.custom_form. */
  snapshotJson: string;
  /** PHP-compatible normalized collection stored on system_form_data.value. */
  collectedJson: string;
  attachmentIds: number[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArray(value: unknown, message: string): unknown[] {
  let parsed = value;
  if (typeof parsed === "string") {
    if (!parsed.trim()) return [];
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ValidateException(message);
    }
  }
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed)) throw new ValidateException(message);
  return parsed;
}

function jsonBytes(value: unknown, message: string): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ValidateException(message);
  }
  if (new TextEncoder().encode(json).byteLength > MAX_FORM_JSON_BYTES) {
    throw new ValidateException("自定义表单数据过大");
  }
  return json;
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function nestedRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function componentTitle(component: JsonRecord, index: number): string {
  const title = nestedRecord(component.titleConfig).value;
  return typeof title === "string" && title.trim() ? title.trim() : `第 ${index + 1} 项`;
}

function componentKey(component: JsonRecord, index: number): string {
  const id = component.id;
  return typeof id === "string" || typeof id === "number" ? `id:${String(id)}` : `index:${index}`;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0 || value.every(isEmpty);
  return false;
}

function componentRequired(component: JsonRecord): boolean {
  const value = nestedRecord(component.titleShow).val;
  return value === true || value === 1 || value === "1";
}

function uploadImageLimit(component: JsonRecord): number {
  const configured = Number(nestedRecord(component.numConfig).val);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MAX_UPLOAD_IMAGES)
    : MAX_UPLOAD_IMAGES;
}

function boundedString(value: unknown, title: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${title}格式错误`);
  }
  const result = String(value).trim();
  if (result.length > MAX_TEXT_LENGTH) throw new ValidateException(`${title}内容过长`);
  return result;
}

function normalizeComponentValue(component: JsonRecord, value: unknown, title: string): unknown {
  const type = typeof component.name === "string" ? component.name : "";
  if (type === "uploadPicture") {
    if (!Array.isArray(value)) throw new ValidateException(`${title}格式错误`);
    const limit = uploadImageLimit(component);
    if (value.length > limit) {
      throw new ValidateException(`${title}最多上传 ${limit} 张图片`);
    }
    return value.map((item) => {
      const reference = boundedString(item, title);
      if (!reference || reference.length > 2_048) throw new ValidateException(`${title}图片地址错误`);
      if (!/^\/api\/assets\/[1-9]\d*$/.test(reference) && !/^https:\/\//i.test(reference)) {
        throw new ValidateException(`${title}图片地址错误`);
      }
      return reference;
    });
  }
  if (type === "dateranges") {
    if (!Array.isArray(value)) throw new ValidateException(`${title}格式错误`);
    if (value.length !== 0 && value.length !== 2) throw new ValidateException(`${title}格式错误`);
    const range = value.map((item) => boundedString(item, title));
    if (range.some((item) => item && !/^\d{4}-\d{2}-\d{2}$/.test(item))) {
      throw new ValidateException(`${title}格式错误`);
    }
    if (range.length === 2 && range[0] > range[1]) throw new ValidateException(`${title}范围错误`);
    return range;
  }
  if (type === "checkboxs") {
    if (Array.isArray(value)) {
      if (value.length > 100) throw new ValidateException(`${title}选择项过多`);
      return value.map((item) => boundedString(item, title));
    }
    return boundedString(value ?? "", title);
  }
  const result = boundedString(value ?? "", title);
  if (type === "dates" && result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new ValidateException(`${title}格式错误`);
  }
  if (type === "times" && result && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) {
    throw new ValidateException(`${title}格式错误`);
  }
  if (type === "timeranges" && result) {
    const match = /^((?:[01]\d|2[0-3]):[0-5]\d)\s+-\s+((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result);
    if (!match || match[1] > match[2]) throw new ValidateException(`${title}范围错误`);
  }
  return result;
}

function validateTextSubtype(component: JsonRecord, value: unknown, title: string): void {
  if (component.name !== "texts" || isEmpty(value)) return;
  const subtype = Number(nestedRecord(component.valConfig).tabVal ?? 0);
  const text = String(value);
  if (subtype === 1 && !/^1[3-9]\d{9}$/.test(text)) throw new ValidateException(`请填写正确的${title}`);
  if (subtype === 2 && !/^[1-9]\d{14}(?:\d{2}[\dXx])?$/.test(text)) {
    throw new ValidateException(`请填写正确的${title}`);
  }
  if (subtype === 3 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new ValidateException(`请填写正确的${title}`);
  }
  if (subtype === 4 && (!Number.isFinite(Number(text)) || Number(text) <= 0)) {
    throw new ValidateException(`请填写大于 0 的${title}`);
  }
}

function validateChoices(component: JsonRecord, value: unknown, title: string): void {
  const type = typeof component.name === "string" ? component.name : "";
  if (!["checkboxs", "radios", "selects"].includes(type) || isEmpty(value)) return;
  const choices = nestedRecord(component.wordsConfig).list;
  if (!Array.isArray(choices)) throw new ValidateException(`系统表单「${title}」选项无效`);
  const allowed = new Set(choices.flatMap((choice) => {
    if (typeof choice === "string" || typeof choice === "number") return [String(choice)];
    if (!isRecord(choice)) return [];
    const candidate = choice.val ?? choice.value ?? choice.label;
    return typeof candidate === "string" || typeof candidate === "number" ? [String(candidate)] : [];
  }));
  const selected = Array.isArray(value)
    ? value.map(String)
    : String(value).split(",").map((item) => item.trim()).filter(Boolean);
  if (selected.some((choice) => !allowed.has(choice))) {
    throw new ValidateException(`${title}包含无效选项`);
  }
}

/**
 * Merge client values into the authoritative template. Client-controlled
 * titles, choices and required flags are discarded rather than persisted.
 */
export function prepareOrderSystemFormSubmission(
  templateValue: unknown,
  submissionValue: unknown,
  systemFormId: number,
): PreparedOrderSystemForm {
  const template = parseArray(templateValue, "系统表单配置无效");
  const submission = parseArray(submissionValue, "自定义表单格式错误");
  if (!template.length || template.length > MAX_FORM_COMPONENTS) {
    throw new ValidateException("系统表单配置无效");
  }
  if (!submission.length) throw new ValidateException("请填写自定义表单");
  if (submission.length !== template.length) throw new ValidateException("自定义表单项目不完整");
  jsonBytes(submission, "自定义表单格式错误");

  const submittedByKey = new Map<string, JsonRecord>();
  submission.forEach((raw, index) => {
    if (!isRecord(raw)) throw new ValidateException("自定义表单格式错误");
    const key = componentKey(raw, index);
    if (submittedByKey.has(key)) throw new ValidateException("自定义表单包含重复项目");
    submittedByKey.set(key, raw);
  });

  const canonical: JsonRecord[] = template.map((raw, index): JsonRecord => {
    if (!isRecord(raw)) throw new ValidateException("系统表单配置无效");
    const type = typeof raw.name === "string" ? raw.name : "";
    if (!COMPONENT_NAMES.has(type)) throw new ValidateException("系统表单包含不支持的组件");
    const submitted = submittedByKey.get(componentKey(raw, index));
    if (!submitted) throw new ValidateException("自定义表单项目不完整");
    if (submitted.name !== undefined && submitted.name !== type) {
      throw new ValidateException("自定义表单组件不匹配");
    }
    const title = componentTitle(raw, index);
    const value = normalizeComponentValue(raw, submitted.value, title);
    if (componentRequired(raw) && isEmpty(value)) {
      throw new ValidateException(`请填写${title}`);
    }
    validateTextSubtype(raw, value, title);
    validateChoices(raw, value, title);
    return { ...cloneRecord(raw), value };
  });

  if (submittedByKey.size !== canonical.length) throw new ValidateException("自定义表单包含未知项目");
  const snapshotJson = jsonBytes(canonical, "自定义表单格式错误");
  const collected = canonical.map((component, index) => {
    const type = typeof component.name === "string" ? component.name : "";
    const wordsConfig = nestedRecord(component.wordsConfig);
    return {
      id: typeof component.id === "string" || typeof component.id === "number" ? component.id : "",
      type,
      name: ({
        checkboxs: "多选框",
        citys: "城市",
        dates: "日期",
        dateranges: "日期范围",
        radios: "单选框",
        selects: "下拉框",
        texts: "文本框",
        times: "时间",
        timeranges: "时间范围",
        uploadPicture: "图片",
      } as Record<string, string>)[type] ?? "",
      title: componentTitle(component, index),
      tip: typeof nestedRecord(component.tipConfig).value === "string"
        ? nestedRecord(component.tipConfig).value
        : "",
      list: ["checkboxs", "radios", "selects"].includes(type) && Array.isArray(wordsConfig.list)
        ? wordsConfig.list
        : [],
      require: componentRequired(component),
      value: component.value ?? "",
    };
  });
  return {
    systemFormId,
    snapshotJson,
    collectedJson: jsonBytes(collected, "自定义表单格式错误"),
    attachmentIds: [...new Set(canonical.flatMap((component) => (
      component.name === "uploadPicture" && Array.isArray(component.value)
        ? component.value.flatMap((value) => {
            const match = /^\/api\/assets\/([1-9]\d*)$/.exec(String(value));
            return match ? [Number(match[1])] : [];
          })
        : []
    )))],
  };
}

export async function loadOrderSystemFormSubmission(
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
