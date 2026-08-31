import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { AttachmentObjectCleanupMessage, Env } from "@/env";
import { withTx, type Container } from "@/lib/di";
import {
  systemAttachment,
  systemAttachmentCategory,
  systemStorage,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

export const R2_IMAGE_TYPE = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPART_IMAGE_BYTES = MAX_IMAGE_BYTES + 256 * 1024;
const SIGNED_ASSET_TTL_SECONDS = 15 * 60;
const MAX_SIGNED_ASSET_TTL_SECONDS = 60 * 60;
const CATEGORY_LOCK_NAMESPACE = 505_609;

export interface AttachmentScope {
  type: 1 | 3 | 4;
  relationId: number;
  moduleType: 1 | 2 | 3 | 4;
}

export interface DetectedImage {
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  extension: "jpg" | "png" | "webp" | "gif";
}

export function adminAttachmentScope(): AttachmentScope {
  return { type: 1, relationId: 0, moduleType: 1 };
}

export function supplierAttachmentScope(supplierId: number): AttachmentScope {
  return { type: 4, relationId: positiveId(supplierId, "供应商ID"), moduleType: 1 };
}

export function userAttachmentScope(uid: number): AttachmentScope {
  return { type: 3, relationId: positiveId(uid, "用户ID"), moduleType: 3 };
}

/** PHP customer-service uploads used module_type=2; relationId now isolates each agent. */
export function kefuAttachmentScope(kefuId: number): AttachmentScope {
  return { type: 1, relationId: positiveId(kefuId, "客服ID"), moduleType: 2 };
}

/** Anonymous visitors use a separate module namespace from registered users. */
export function visitorAttachmentScope(visitorUid: number): AttachmentScope {
  return { type: 3, relationId: positiveId(visitorUid, "游客ID"), moduleType: 4 };
}

export function canonicalAttachmentPath(id: number): string {
  return `/api/assets/${positiveId(id, "附件ID")}`;
}

export function parseCanonicalAttachmentId(value: string): number | null {
  const match = /^\/api\/assets\/([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export async function signAttachmentReferences(
  appKey: string | undefined,
  references: string[],
  ttlSeconds = SIGNED_ASSET_TTL_SECONDS,
): Promise<string[]> {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_SIGNED_ASSET_TTL_SECONDS) {
    throw new ValidateException("附件链接有效期无效");
  }
  if (!appKey) throw new ValidateException("APP_KEY未配置");
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Promise.all(references.map(async (reference) => {
    const id = parseCanonicalAttachmentId(reference);
    if (!id) return reference;
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signatureMessage(id, expires)),
    );
    return `${reference}?expires=${expires}&signature=${encodeBase64Url(new Uint8Array(signature))}`;
  }));
}

export function detectImageType(bytes: Uint8Array): DetectedImage | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { mime: "image/png", extension: "png" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { mime: "image/gif", extension: "gif" };
    }
  }
  return null;
}

export function isAttachmentObjectCleanupMessage(
  value: unknown,
): value is AttachmentObjectCleanupMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AttachmentObjectCleanupMessage>;
  return candidate.action === "deleteAttachmentObjects" &&
    Array.isArray(candidate.keys) && candidate.keys.length > 0 && candidate.keys.length <= 100 &&
    candidate.keys.every((key) =>
      typeof key === "string" &&
      key.length <= 180 &&
      /^attachments\/(?:admin|supplier|user|kefu|visitor)\/[1-9]\d*\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(?:jpg|png|webp|gif)$/.test(key)
    );
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new ValidateException(`${label}无效`);
  }
  return id;
}

function nonNegativeId(value: unknown, label: string): number {
  const id = Number(value ?? 0);
  if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) {
    throw new ValidateException(`${label}无效`);
  }
  return id;
}

function fileTypeValue(value: unknown): 1 | 2 {
  const fileType = Number(value ?? 1);
  if (fileType !== 1 && fileType !== 2) throw new ValidateException("文件类型无效");
  return fileType;
}

function pageValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function textValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new ValidateException(`${label}不能为空`);
  const result = value.trim();
  if (!result || [...result].length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return result;
}

function sanitizeOriginalName(value: string): string {
  const cleaned = value.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return [...(cleaned || "image")].slice(0, 255).join("");
}

function normalizeDeclaredMime(value: string): string {
  const mime = value.trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function signatureMessage(id: number, expires: number): string {
  return `GET\n${canonicalAttachmentPath(id)}\n${expires}`;
}

function formatEpoch(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) return "";
  return new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return value;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function scopeFolder(scope: AttachmentScope): "admin" | "supplier" | "user" | "kefu" | "visitor" {
  if (scope.moduleType === 2) return "kefu";
  if (scope.moduleType === 4) return "visitor";
  return scope.type === 1 ? "admin" : scope.type === 4 ? "supplier" : "user";
}

export class AttachmentService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async uploadImage(scope: AttachmentScope, file: File, pidValue: unknown) {
    if (!(file instanceof File) || file.size <= 0) throw new ValidateException("请选择图片文件");
    if (file.size > MAX_IMAGE_BYTES) throw new ValidateException("图片不能超过10 MiB");
    const detected = detectImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!detected) throw new ValidateException("只支持 JPEG、PNG、WebP 或 GIF 图片");
    const declaredMime = normalizeDeclaredMime(file.type);
    if (declaredMime && declaredMime !== detected.mime) {
      throw new ValidateException("图片内容与声明类型不一致");
    }
    const pid = nonNegativeId(pidValue, "分类ID");
    if (pid > 0) await this.assertCategory(scope, pid, 1);

    const now = new Date();
    const owner = scope.relationId > 0 ? scope.relationId : 1;
    const key = [
      "attachments",
      scopeFolder(scope),
      String(owner),
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      `${crypto.randomUUID()}.${detected.extension}`,
    ].join("/");
    const originalName = sanitizeOriginalName(file.name);
    const r2StartedAt = Date.now();
    let stored: R2Object;
    try {
      stored = await this.env.ASSETS_BUCKET.put(key, file.stream(), {
        httpMetadata: {
          contentType: detected.mime,
          contentDisposition: "inline",
          cacheControl: "private, no-store",
        },
        customMetadata: {
          ownerType: String(scope.type),
          ownerId: String(scope.relationId),
          originalName,
        },
      });
    } catch (error) {
      emitOperationalEvent("error", {
        event: "r2_object_write_failed",
        component: "r2",
        operation: "put",
        outcome: "failure",
        durationMs: Date.now() - r2StartedAt,
        errorCode: operationalErrorCode(error),
      });
      throw error;
    }
    if (stored.size !== file.size) {
      await this.env.ASSETS_BUCKET.delete(key);
      emitOperationalEvent("error", {
        event: "r2_object_write_failed",
        component: "r2",
        operation: "put",
        outcome: "failure",
        durationMs: Date.now() - r2StartedAt,
        errorCode: "size_mismatch",
      });
      throw new ValidateException("图片上传不完整，请重试");
    }

    let id: number;
    try {
      id = await withTx(this.container, async (tx) => {
        const inserted = await tx.insert(systemAttachment).values({
          type: scope.type,
          fileType: 1,
          relationId: scope.relationId,
          name: key,
          attDir: "",
          sattDir: "",
          attSize: String(stored.size),
          attType: detected.mime,
          pid,
          time: Math.floor(Date.now() / 1000),
          imageType: R2_IMAGE_TYPE,
          moduleType: scope.moduleType,
          realName: originalName,
        }).returning({ id: systemAttachment.attId });
        const attachmentId = inserted[0].id;
        const canonical = canonicalAttachmentPath(attachmentId);
        await tx.update(systemAttachment).set({ attDir: canonical, sattDir: canonical })
          .where(eq(systemAttachment.attId, attachmentId));
        return attachmentId;
      });
    } catch (error) {
      await this.env.ASSETS_BUCKET.delete(key);
      emitOperationalEvent("error", {
        event: "r2_metadata_commit_failed",
        component: "r2",
        operation: "metadata_commit",
        outcome: "failure",
        durationMs: Date.now() - r2StartedAt,
        errorCode: operationalErrorCode(error),
      });
      throw error;
    }
    const url = canonicalAttachmentPath(id);
    const [src] = await this.signReferences([url]);
    emitOperationalEvent("info", {
      event: "r2_object_written",
      component: "r2",
      operation: "put",
      outcome: "success",
      durationMs: Date.now() - r2StartedAt,
      resourceCount: 1,
    });
    return { att_id: id, name: originalName, size: stored.size, type: detected.mime, url, src };
  }

  async list(scope: AttachmentScope, query: Record<string, string>) {
    const page = pageValue(query.page, 1);
    const limit = Math.min(100, pageValue(query.limit, 20));
    const pid = nonNegativeId(query.pid ?? 0, "分类ID");
    const fileType = fileTypeValue(query.file_type ?? 1);
    const conditions = [
      eq(systemAttachment.type, scope.type),
      eq(systemAttachment.relationId, scope.relationId),
      eq(systemAttachment.moduleType, scope.moduleType),
      eq(systemAttachment.fileType, fileType),
      eq(systemAttachment.pid, pid),
    ];
    const name = (query.name ?? query.real_name ?? "").trim().slice(0, 80);
    if (name) conditions.push(ilike(systemAttachment.realName, `%${name}%`));
    const where = and(...conditions)!;
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(systemAttachment).where(where)
        .orderBy(desc(systemAttachment.attId)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::int` })
        .from(systemAttachment).where(where),
    ]);
    const urls = await this.signReferences(rows.flatMap((row) => [row.attDir, row.sattDir]));
    return {
      list: rows.map((row, index) => ({
        att_id: row.attId,
        type: row.type,
        file_type: row.fileType,
        relation_id: row.relationId,
        name: row.name,
        att_dir: urls[index * 2],
        satt_dir: urls[index * 2 + 1],
        att_size: formatBytes(row.attSize.trim()),
        raw_size: Number(row.attSize.trim()) || 0,
        att_type: row.attType.trim(),
        pid: row.pid,
        time: formatEpoch(row.time),
        time_epoch: row.time,
        image_type: row.imageType,
        module_type: row.moduleType,
        real_name: row.realName,
      })),
      count: Number(totals[0]?.count ?? 0),
    };
  }

  async rename(scope: AttachmentScope, idValue: unknown, nameValue: unknown) {
    const id = positiveId(idValue, "附件ID");
    const realName = textValue(nameValue, "文件名称", 255);
    const updated = await this.container.db.update(systemAttachment).set({ realName }).where(and(
      eq(systemAttachment.attId, id),
      eq(systemAttachment.type, scope.type),
      eq(systemAttachment.relationId, scope.relationId),
      eq(systemAttachment.moduleType, scope.moduleType),
    )).returning({ id: systemAttachment.attId });
    if (!updated[0]) throw new NotFoundException("附件不存在");
    return { id, real_name: realName };
  }

  async move(scope: AttachmentScope, idsValue: unknown, pidValue: unknown) {
    const ids = this.attachmentIds(idsValue);
    const pid = nonNegativeId(pidValue, "分类ID");
    if (pid > 0) await this.assertCategory(scope, pid, 1);
    const rows = await this.container.db.select({ id: systemAttachment.attId })
      .from(systemAttachment).where(and(
        inArray(systemAttachment.attId, ids),
        eq(systemAttachment.type, scope.type),
        eq(systemAttachment.relationId, scope.relationId),
        eq(systemAttachment.moduleType, scope.moduleType),
      ));
    if (rows.length !== ids.length) throw new NotFoundException("一个或多个附件不存在");
    await this.container.db.update(systemAttachment).set({ pid }).where(and(
      inArray(systemAttachment.attId, ids),
      eq(systemAttachment.type, scope.type),
      eq(systemAttachment.relationId, scope.relationId),
      eq(systemAttachment.moduleType, scope.moduleType),
    ));
    return { ids, pid };
  }

  async delete(scope: AttachmentScope, idsValue: unknown) {
    const ids = this.attachmentIds(idsValue);
    const keys = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        id: systemAttachment.attId,
        key: systemAttachment.name,
        imageType: systemAttachment.imageType,
      }).from(systemAttachment).where(and(
        inArray(systemAttachment.attId, ids),
        eq(systemAttachment.type, scope.type),
        eq(systemAttachment.relationId, scope.relationId),
        eq(systemAttachment.moduleType, scope.moduleType),
      )).for("update");
      if (rows.length !== ids.length) throw new NotFoundException("一个或多个附件不存在");
      await tx.delete(systemAttachment).where(and(
        inArray(systemAttachment.attId, ids),
        eq(systemAttachment.type, scope.type),
        eq(systemAttachment.relationId, scope.relationId),
        eq(systemAttachment.moduleType, scope.moduleType),
      ));
      return rows.filter((row) => row.imageType === R2_IMAGE_TYPE).map((row) => row.key);
    });
    if (keys.length > 0) {
      const message: AttachmentObjectCleanupMessage = { action: "deleteAttachmentObjects", keys };
      try {
        await this.env.ORDER_QUEUE.send(message);
      } catch (queueError) {
        try {
          await this.env.ASSETS_BUCKET.delete(keys);
        } catch (r2Error) {
          emitOperationalEvent("error", {
            event: "attachment_cleanup_enqueue_and_fallback_failed",
            component: "r2",
            operation: "cleanup",
            outcome: "failure",
            resourceCount: keys.length,
            errorCode: `${operationalErrorCode(queueError)}_${operationalErrorCode(r2Error)}`.slice(0, 64),
          });
        }
      }
    }
    return { ids, deleted: ids.length };
  }

  async listCategories(scope: AttachmentScope, query: Record<string, string>) {
    const fileType = fileTypeValue(query.file_type ?? 1);
    const pid = nonNegativeId(query.pid ?? 0, "上级分类ID");
    const name = (query.name ?? "").trim().slice(0, 50);
    const conditions = [
      eq(systemAttachmentCategory.type, scope.type),
      eq(systemAttachmentCategory.relationId, scope.relationId),
      eq(systemAttachmentCategory.fileType, fileType),
    ];
    if (name) conditions.push(ilike(systemAttachmentCategory.name, `%${name}%`));
    const all = await this.container.db.select().from(systemAttachmentCategory)
      .where(and(...conditions)).orderBy(systemAttachmentCategory.id);
    const rows = name ? all : all.filter((row) => row.pid === pid);
    const parents = new Set(all.map((row) => row.pid));
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        file_type: row.fileType,
        relation_id: row.relationId,
        pid: row.pid,
        name: row.name,
        enname: row.enname,
        title: row.name,
        children: [],
        ...(parents.has(row.id) ? { loading: false } : {}),
      })),
    };
  }

  async categoryDetail(scope: AttachmentScope, idValue: unknown) {
    const id = positiveId(idValue, "分类ID");
    const rows = await this.container.db.select().from(systemAttachmentCategory).where(and(
      eq(systemAttachmentCategory.id, id),
      eq(systemAttachmentCategory.type, scope.type),
      eq(systemAttachmentCategory.relationId, scope.relationId),
    )).limit(1);
    if (!rows[0]) throw new NotFoundException("附件分类不存在");
    return rows[0];
  }

  async saveCategory(scope: AttachmentScope, idValue: unknown, input: Record<string, unknown>) {
    const id = idValue === undefined || idValue === null || idValue === ""
      ? 0
      : positiveId(idValue, "分类ID");
    const name = textValue(input.name, "分类名称", 50);
    const pid = nonNegativeId(input.pid ?? 0, "上级分类ID");
    const fileType = fileTypeValue(input.file_type ?? input.fileType ?? 1);
    if (id > 0 && pid === id) throw new ValidateException("分类不能作为自己的上级");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_LOCK_NAMESPACE + scope.type}, ${scope.relationId})`);
      const categories = await tx.select().from(systemAttachmentCategory).where(and(
        eq(systemAttachmentCategory.type, scope.type),
        eq(systemAttachmentCategory.relationId, scope.relationId),
        eq(systemAttachmentCategory.fileType, fileType),
      )).for("update");
      const current = id > 0 ? categories.find((row) => row.id === id) : undefined;
      if (id > 0 && !current) throw new NotFoundException("附件分类不存在");
      if (categories.some((row) => row.name === name && row.id !== id)) {
        throw new ValidateException("该附件分类已经存在");
      }
      if (pid > 0 && !categories.some((row) => row.id === pid)) {
        throw new NotFoundException("上级附件分类不存在");
      }
      const byId = new Map(categories.map((row) => [row.id, row]));
      let ancestor = pid;
      const visited = new Set<number>();
      while (ancestor > 0) {
        if (ancestor === id || visited.has(ancestor)) throw new ValidateException("附件分类层级形成循环");
        visited.add(ancestor);
        ancestor = byId.get(ancestor)?.pid ?? 0;
      }
      if (id > 0) {
        await tx.update(systemAttachmentCategory).set({ name, pid })
          .where(and(
            eq(systemAttachmentCategory.id, id),
            eq(systemAttachmentCategory.type, scope.type),
            eq(systemAttachmentCategory.relationId, scope.relationId),
            eq(systemAttachmentCategory.fileType, fileType),
          ));
        return { id, name, pid, file_type: fileType };
      }
      const inserted = await tx.insert(systemAttachmentCategory).values({
        type: scope.type,
        relationId: scope.relationId,
        fileType,
        pid,
        name,
      }).returning({ id: systemAttachmentCategory.id });
      return { id: inserted[0].id, name, pid, file_type: fileType };
    });
  }

  async deleteCategory(scope: AttachmentScope, idValue: unknown) {
    const id = positiveId(idValue, "分类ID");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_LOCK_NAMESPACE + scope.type}, ${scope.relationId})`);
      const rows = await tx.select().from(systemAttachmentCategory).where(and(
        eq(systemAttachmentCategory.id, id),
        eq(systemAttachmentCategory.type, scope.type),
        eq(systemAttachmentCategory.relationId, scope.relationId),
      )).for("update").limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundException("附件分类不存在");
      const [children, assets] = await Promise.all([
        tx.select({ count: sql<number>`count(*)::int` }).from(systemAttachmentCategory).where(and(
          eq(systemAttachmentCategory.pid, id),
          eq(systemAttachmentCategory.type, scope.type),
          eq(systemAttachmentCategory.relationId, scope.relationId),
          eq(systemAttachmentCategory.fileType, row.fileType),
        )),
        tx.select({ count: sql<number>`count(*)::int` }).from(systemAttachment).where(and(
          eq(systemAttachment.pid, id),
          eq(systemAttachment.type, scope.type),
          eq(systemAttachment.relationId, scope.relationId),
          eq(systemAttachment.fileType, row.fileType),
        )),
      ]);
      if (Number(children[0]?.count ?? 0) > 0) throw new ValidateException("请先删除下级分类");
      if (Number(assets[0]?.count ?? 0) > 0) throw new ValidateException("请先移动或删除分类中的附件");
      await tx.delete(systemAttachmentCategory).where(and(
        eq(systemAttachmentCategory.id, id),
        eq(systemAttachmentCategory.type, scope.type),
        eq(systemAttachmentCategory.relationId, scope.relationId),
      ));
      return { id };
    });
  }

  async signReferences(references: string[], ttlSeconds = SIGNED_ASSET_TTL_SECONDS) {
    return signAttachmentReferences(this.env.APP_KEY, references, ttlSeconds);
  }

  async getSignedAsset(idValue: unknown, expiresValue: unknown, signatureValue: unknown) {
    const id = positiveId(idValue, "附件ID");
    const expires = Number(expiresValue);
    const signature = typeof signatureValue === "string" ? decodeBase64Url(signatureValue) : null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expires) || expires < now || expires > now + MAX_SIGNED_ASSET_TTL_SECONDS || !signature) {
      throw new NotFoundException("附件链接无效或已过期");
    }
    const key = await this.getSignatureKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(signatureMessage(id, expires)),
    );
    if (!valid) throw new NotFoundException("附件链接无效或已过期");
    const rows = await this.container.db.select({ key: systemAttachment.name })
      .from(systemAttachment).where(and(
        eq(systemAttachment.attId, id),
        eq(systemAttachment.imageType, R2_IMAGE_TYPE),
      )).limit(1);
    if (!rows[0] || !rows[0].key.startsWith("attachments/")) throw new NotFoundException("附件不存在");
    const r2StartedAt = Date.now();
    let object: R2ObjectBody | null;
    try {
      object = await this.env.ASSETS_BUCKET.get(rows[0].key);
    } catch (error) {
      emitOperationalEvent("error", {
        event: "r2_object_read_failed",
        component: "r2",
        operation: "get",
        outcome: "failure",
        durationMs: Date.now() - r2StartedAt,
        errorCode: operationalErrorCode(error),
      });
      throw error;
    }
    const durationMs = Date.now() - r2StartedAt;
    if (!object) {
      emitOperationalEvent("warn", {
        event: "r2_object_missing",
        component: "r2",
        operation: "get",
        outcome: "rejected",
        durationMs,
      });
      throw new NotFoundException("附件不存在");
    }
    if (durationMs >= 500) {
      emitOperationalEvent("warn", {
        event: "r2_object_slow",
        component: "r2",
        operation: "get",
        outcome: "success",
        durationMs,
        thresholdMs: 500,
      });
    }
    return object;
  }

  async legacyStorageList(query: Record<string, string>) {
    const page = pageValue(query.page, 1);
    const limit = Math.min(100, pageValue(query.limit, 20));
    const where = eq(systemStorage.isDelete, 0);
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(systemStorage).where(where)
        .orderBy(desc(systemStorage.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(systemStorage).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        region: row.region,
        acl: row.acl,
        domain: row.domain,
        cname: row.cname,
        is_ssl: row.isSsl,
        status: row.status,
        is_delete: row.isDelete,
        add_time: row.addTime,
        update_time: row.updateTime,
        access_key_configured: row.accessKey.length > 0,
        runtime_authority: false,
      })),
      count: Number(totals[0]?.count ?? 0),
      active: {
        type: R2_IMAGE_TYPE,
        name: "Cloudflare R2",
        binding: "ASSETS_BUCKET",
        configured: true,
        private: true,
      },
    };
  }

  async processObjectCleanup(message: AttachmentObjectCleanupMessage): Promise<{ deleted: number }> {
    if (!isAttachmentObjectCleanupMessage(message)) throw new ValidateException("附件清理消息格式错误");
    await this.env.ASSETS_BUCKET.delete(message.keys);
    return { deleted: message.keys.length };
  }

  private attachmentIds(value: unknown): number[] {
    const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
    const ids = [...new Set(raw.map((item) => positiveId(item, "附件ID")))];
    if (ids.length < 1 || ids.length > 50) throw new ValidateException("请选择1至50个附件");
    return ids;
  }

  private async assertCategory(scope: AttachmentScope, id: number, fileType: 1 | 2) {
    const rows = await this.container.db.select({ id: systemAttachmentCategory.id })
      .from(systemAttachmentCategory).where(and(
        eq(systemAttachmentCategory.id, id),
        eq(systemAttachmentCategory.type, scope.type),
        eq(systemAttachmentCategory.relationId, scope.relationId),
        eq(systemAttachmentCategory.fileType, fileType),
      )).limit(1);
    if (!rows[0]) throw new NotFoundException("附件分类不存在");
  }

  private async getSignatureKey(): Promise<CryptoKey> {
    if (!this.env.APP_KEY) throw new ValidateException("APP_KEY未配置");
    return crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.env.APP_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
}
