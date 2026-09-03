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
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_CHUNK_BYTES = 5 * 1024 * 1024;
export const MAX_MULTIPART_VIDEO_CHUNK_BYTES = MAX_VIDEO_CHUNK_BYTES + 256 * 1024;
const SIGNED_ASSET_TTL_SECONDS = 15 * 60;
const MAX_SIGNED_ASSET_TTL_SECONDS = 60 * 60;
const MAX_ATTACHMENT_VARIANT_DIMENSION = 2_048;
const CATEGORY_LOCK_NAMESPACE = 505_609;
const MAX_VIDEO_CHUNKS = 100;
const TEMP_VIDEO_CHUNK_TTL_SECONDS = 12 * 60 * 60;

export interface AttachmentImageVariant {
  name: "mid";
  width: number;
  height: number;
}

export interface SignedAssetRead {
  response: Response;
  cacheWrite?: () => Promise<void>;
}

export interface AttachmentScope {
  type: 1 | 3 | 4;
  relationId: number;
  moduleType: 1 | 2 | 3 | 4;
}

export interface DetectedImage {
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  extension: "jpg" | "png" | "webp" | "gif";
}

export interface VideoChunkUploadInput {
  file: File;
  chunkNumber: unknown;
  currentChunkSize: unknown;
  chunkSize: unknown;
  totalChunks: unknown;
  md5: unknown;
  filename: unknown;
  pid: unknown;
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
  return signAttachmentReferencesWithVariant(appKey, references, null, ttlSeconds);
}

export async function signAttachmentVariantReferences(
  appKey: string | undefined,
  references: string[],
  variant: AttachmentImageVariant,
  ttlSeconds = SIGNED_ASSET_TTL_SECONDS,
): Promise<string[]> {
  const normalized = createAttachmentImageVariant(variant.name, variant.width, variant.height);
  if (!normalized) throw new ValidateException("附件变体无效");
  return signAttachmentReferencesWithVariant(appKey, references, normalized, ttlSeconds);
}

async function signAttachmentReferencesWithVariant(
  appKey: string | undefined,
  references: string[],
  variant: AttachmentImageVariant | null,
  ttlSeconds: number,
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
      new TextEncoder().encode(signatureMessage(id, expires, variant)),
    );
    const transform = variant
      ? `variant=${variant.name}&width=${variant.width}&height=${variant.height}&`
      : "";
    return `${reference}?${transform}expires=${expires}&signature=${encodeBase64Url(new Uint8Array(signature))}`;
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

export function detectMp4Type(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value === "::1") return true;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) || octets[0] >= 224;
}

function normalizeHttpsMediaUrl(
  value: unknown,
  label: string,
  extensions: readonly string[],
): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ValidateException(`${label}格式错误`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ValidateException(`${label}格式错误`);
  }
  const extension = parsed.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    (parsed.port && parsed.port !== "443") || !parsed.hostname ||
    isPrivateNetworkHostname(parsed.hostname) || !extensions.includes(extension)
  ) {
    throw new ValidateException(`${label}格式错误`);
  }
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeExternalVideoUrl(value: unknown): string {
  return normalizeHttpsMediaUrl(value, "视频地址", ["mp4"]);
}

function normalizeExternalVideoCoverUrl(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return normalizeHttpsMediaUrl(value, "视频封面地址", ["jpg", "jpeg", "png", "webp", "gif"]);
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
      (
        /^attachments\/(?:admin|supplier|user|kefu|visitor)\/[1-9]\d*\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(?:jpg|png|webp|gif|mp4)$/.test(key) ||
        /^attachments\/tmp\/supplier\/[1-9]\d*\/[0-9a-f]{64}\/(?:[1-9]\d{0,2})\.part$/.test(key)
      )
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

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function sanitizeOriginalName(value: string): string {
  const cleaned = value.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return [...(cleaned || "image")].slice(0, 255).join("");
}

function normalizeDeclaredMime(value: string): string {
  const mime = value.trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

export function createAttachmentImageVariant(
  nameValue: unknown,
  widthValue: unknown,
  heightValue: unknown,
): AttachmentImageVariant | null {
  const name = nameValue;
  const width = Number(widthValue);
  const height = Number(heightValue);
  if (
    name !== "mid" ||
    !Number.isSafeInteger(width) || width <= 0 || width > MAX_ATTACHMENT_VARIANT_DIMENSION ||
    !Number.isSafeInteger(height) || height <= 0 || height > MAX_ATTACHMENT_VARIANT_DIMENSION
  ) return null;
  return { name, width, height };
}

function requestedAttachmentVariant(
  nameValue: unknown,
  widthValue: unknown,
  heightValue: unknown,
): AttachmentImageVariant | null {
  if (nameValue === undefined && widthValue === undefined && heightValue === undefined) return null;
  const variant = createAttachmentImageVariant(nameValue, widthValue, heightValue);
  if (!variant) throw new NotFoundException("附件链接无效或已过期");
  return variant;
}

function signatureMessage(
  id: number,
  expires: number,
  variant: AttachmentImageVariant | null,
): string {
  const transform = variant
    ? `\nvariant=${variant.name}&width=${variant.width}&height=${variant.height}`
    : "";
  return `GET\n${canonicalAttachmentPath(id)}${transform}\n${expires}`;
}

function imageOutputFormat(contentType: string | undefined): ImageOutputOptions["format"] | null {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    normalized === "image/jpeg" || normalized === "image/png" || normalized === "image/gif" ||
    normalized === "image/webp"
  ) return normalized;
  return null;
}

function requestedR2Range(value: unknown): Headers | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 80 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(value)) {
    throw new NotFoundException("附件范围无效");
  }
  return new Headers({ Range: value });
}

function r2ObjectResponse(object: R2ObjectBody): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  const range = object.range;
  if (!range) {
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }
  let offset: number;
  let length: number;
  if ("suffix" in range) {
    length = Math.min(range.suffix, object.size);
    offset = object.size - length;
  } else {
    offset = range.offset ?? 0;
    length = range.length ?? object.size - offset;
  }
  headers.set("Content-Length", String(length));
  headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
  return new Response(object.body, { status: 206, headers });
}

function variantCacheRequest(
  id: number,
  sourceEtag: string,
  variant: AttachmentImageVariant,
  format: ImageOutputOptions["format"],
): Request {
  const key = [
    String(id),
    encodeURIComponent(sourceEtag),
    variant.name,
    `${variant.width}x${variant.height}`,
    encodeURIComponent(format),
  ].join("/");
  return new Request(`https://cinashop-asset-variant-cache.invalid/${key}`, { method: "GET" });
}

export async function putConcatenatedR2Objects(
  bucket: R2Bucket,
  sourceKeys: string[],
  destinationKey: string,
  totalSize: number,
  options: R2PutOptions,
): Promise<R2Object> {
  if (
    sourceKeys.length < 1 || sourceKeys.length > MAX_VIDEO_CHUNKS ||
    !Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize > MAX_VIDEO_BYTES
  ) throw new ValidateException("视频分片信息无效");
  const fixed = new FixedLengthStream(totalSize);
  const writer = fixed.writable.getWriter();
  const putPromise = bucket.put(destinationKey, fixed.readable, options);
  try {
    for (const key of sourceKeys) {
      const object = await bucket.get(key);
      if (!object) throw new ValidateException("视频分片不完整，请重新上传");
      const reader = object.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    await writer.close();
    const stored = await putPromise;
    if (stored.size !== totalSize) throw new ValidateException("视频上传不完整，请重试");
    return stored;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await putPromise.catch(() => undefined);
    throw error;
  }
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

  async uploadVideoChunk(scope: AttachmentScope, input: VideoChunkUploadInput) {
    if (scope.type !== 4 || scope.moduleType !== 1) throw new ValidateException("视频上传作用域无效");
    const { file } = input;
    if (!(file instanceof File) || file.size <= 0) throw new ValidateException("请选择视频文件");
    const chunkNumber = boundedPositiveInteger(input.chunkNumber, "视频分片序号", MAX_VIDEO_CHUNKS);
    const totalChunks = boundedPositiveInteger(input.totalChunks, "视频分片总数", MAX_VIDEO_CHUNKS);
    const chunkSize = boundedPositiveInteger(input.chunkSize, "视频分片大小", MAX_VIDEO_CHUNK_BYTES);
    const currentChunkSize = boundedPositiveInteger(
      input.currentChunkSize,
      "当前视频分片大小",
      MAX_VIDEO_CHUNK_BYTES,
    );
    if (chunkNumber > totalChunks || file.size !== currentChunkSize || currentChunkSize > chunkSize) {
      throw new ValidateException("视频分片信息无效");
    }
    if (chunkNumber < totalChunks && currentChunkSize !== chunkSize) {
      throw new ValidateException("非末尾视频分片大小不一致");
    }
    if ((totalChunks - 1) * chunkSize + 1 > MAX_VIDEO_BYTES) {
      throw new ValidateException("视频不能超过100 MiB");
    }
    const declaredMime = normalizeDeclaredMime(file.type);
    if (declaredMime && declaredMime !== "video/mp4" && declaredMime !== "application/octet-stream") {
      throw new ValidateException("只支持 MP4 视频");
    }
    const originalName = sanitizeOriginalName(textValue(input.filename, "视频文件名", 255));
    if (!/\.mp4$/i.test(originalName)) throw new ValidateException("只支持 MP4 视频");
    const sessionMd5 = typeof input.md5 === "string" ? input.md5.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{32}$/.test(sessionMd5)) throw new ValidateException("视频上传会话无效");
    if (chunkNumber === 1) {
      const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (!detectMp4Type(header)) throw new ValidateException("视频内容不是有效的 MP4");
    }
    const pid = nonNegativeId(input.pid, "分类ID");
    if (pid > 0) await this.assertCategory(scope, pid, 2);

    const sessionDigest = await sha256Hex(`${scope.relationId}\n${sessionMd5}\n${originalName}`);
    const temporaryPrefix = `attachments/tmp/supplier/${scope.relationId}/${sessionDigest}/`;
    const firstKey = `${temporaryPrefix}1.part`;
    let finalKey: string;
    if (chunkNumber === 1) {
      const now = new Date();
      finalKey = [
        "attachments",
        "supplier",
        String(scope.relationId),
        String(now.getUTCFullYear()),
        String(now.getUTCMonth() + 1).padStart(2, "0"),
        `${crypto.randomUUID()}.mp4`,
      ].join("/");
    } else {
      const first = await this.env.ASSETS_BUCKET.head(firstKey);
      const metadata = first?.customMetadata;
      if (
        !first || !metadata || metadata.sessionMd5 !== sessionMd5 ||
        metadata.filename !== originalName || metadata.totalChunks !== String(totalChunks) ||
        metadata.chunkSize !== String(chunkSize) || metadata.mp4Validated !== "1"
      ) throw new ValidateException("视频上传会话已失效，请重新上传");
      finalKey = metadata.finalKey ?? "";
      const expectedPrefix = `attachments/supplier/${scope.relationId}/`;
      if (!finalKey.startsWith(expectedPrefix) || !/\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.mp4$/.test(finalKey)) {
        throw new ValidateException("视频上传会话无效");
      }
    }
    const temporaryKey = `${temporaryPrefix}${chunkNumber}.part`;
    const chunkMetadata = {
      ownerType: String(scope.type),
      ownerId: String(scope.relationId),
      sessionMd5,
      filename: originalName,
      totalChunks: String(totalChunks),
      chunkSize: String(chunkSize),
      finalKey,
      mp4Validated: "1",
    };
    const storedChunk = await this.env.ASSETS_BUCKET.put(temporaryKey, file.stream(), {
      httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
      customMetadata: chunkMetadata,
    });
    if (storedChunk.size !== currentChunkSize) {
      await this.env.ASSETS_BUCKET.delete(temporaryKey);
      throw new ValidateException("视频分片上传不完整，请重试");
    }
    const cleanupMessage: AttachmentObjectCleanupMessage = {
      action: "deleteAttachmentObjects",
      keys: [temporaryKey],
    };
    try {
      await this.env.ORDER_QUEUE.send(cleanupMessage, { delaySeconds: TEMP_VIDEO_CHUNK_TTL_SECONDS });
    } catch (error) {
      emitOperationalEvent("warn", {
        event: "attachment_temporary_cleanup_enqueue_failed",
        component: "r2",
        operation: "cleanup_enqueue",
        outcome: "failure",
        resourceCount: 1,
        errorCode: operationalErrorCode(error),
      });
    }
    if (chunkNumber < totalChunks) {
      return {
        code: 1,
        msg: "waiting",
        file_path: "",
        name: "",
        dir: "",
        chunk: chunkNumber,
        total_chunks: totalChunks,
      };
    }

    const listed = await this.env.ASSETS_BUCKET.list({
      prefix: temporaryPrefix,
      limit: totalChunks + 1,
      include: ["customMetadata"],
    });
    if (listed.truncated || listed.objects.length !== totalChunks) {
      throw new ValidateException("视频分片不完整，请重新上传");
    }
    const byKey = new Map(listed.objects.map((object) => [object.key, object]));
    const sourceKeys: string[] = [];
    let totalSize = 0;
    for (let index = 1; index <= totalChunks; index += 1) {
      const key = `${temporaryPrefix}${index}.part`;
      const object = byKey.get(key);
      const metadata = object?.customMetadata;
      const expectedSize = index < totalChunks ? chunkSize : currentChunkSize;
      if (
        !object || object.size !== expectedSize || !metadata ||
        metadata.ownerId !== String(scope.relationId) || metadata.sessionMd5 !== sessionMd5 ||
        metadata.filename !== originalName || metadata.totalChunks !== String(totalChunks) ||
        metadata.chunkSize !== String(chunkSize) || metadata.finalKey !== finalKey ||
        metadata.mp4Validated !== "1"
      ) throw new ValidateException("视频分片信息不一致，请重新上传");
      sourceKeys.push(key);
      totalSize += object.size;
    }
    if (totalSize > MAX_VIDEO_BYTES) throw new ValidateException("视频不能超过100 MiB");

    let storedVideo: R2Object;
    try {
      storedVideo = await putConcatenatedR2Objects(
        this.env.ASSETS_BUCKET,
        sourceKeys,
        finalKey,
        totalSize,
        {
          httpMetadata: {
            contentType: "video/mp4",
            contentDisposition: "inline",
            cacheControl: "private, no-store",
          },
          customMetadata: {
            ownerType: String(scope.type),
            ownerId: String(scope.relationId),
            originalName,
          },
        },
      );
    } catch (error) {
      await this.env.ASSETS_BUCKET.delete(finalKey).catch(() => undefined);
      emitOperationalEvent("error", {
        event: "r2_video_compose_failed",
        component: "r2",
        operation: "compose",
        outcome: "failure",
        resourceCount: sourceKeys.length,
        errorCode: operationalErrorCode(error),
      });
      throw error;
    }

    let id: number;
    try {
      id = await withTx(this.container, async (tx) => {
        const inserted = await tx.insert(systemAttachment).values({
          type: scope.type,
          fileType: 2,
          relationId: scope.relationId,
          name: finalKey,
          attDir: "",
          sattDir: "",
          attSize: String(storedVideo.size),
          attType: "video/mp4",
          pid,
          time: Math.floor(Date.now() / 1000),
          imageType: R2_IMAGE_TYPE,
          moduleType: scope.moduleType,
          realName: originalName,
        }).returning({ id: systemAttachment.attId });
        const attachmentId = inserted[0].id;
        const canonical = canonicalAttachmentPath(attachmentId);
        await tx.update(systemAttachment).set({ attDir: canonical })
          .where(eq(systemAttachment.attId, attachmentId));
        return attachmentId;
      });
    } catch (error) {
      await this.env.ASSETS_BUCKET.delete(finalKey);
      throw error;
    }
    try {
      await this.env.ASSETS_BUCKET.delete(sourceKeys);
    } catch (error) {
      emitOperationalEvent("warn", {
        event: "attachment_temporary_cleanup_failed",
        component: "r2",
        operation: "cleanup",
        outcome: "failure",
        resourceCount: sourceKeys.length,
        errorCode: operationalErrorCode(error),
      });
    }
    const url = canonicalAttachmentPath(id);
    const [src] = await this.signReferences([url]);
    emitOperationalEvent("info", {
      event: "r2_video_written",
      component: "r2",
      operation: "put",
      outcome: "success",
      resourceCount: 1,
    });
    return {
      code: 2,
      msg: "success",
      att_id: id,
      name: url,
      dir: url,
      file_path: url,
      src,
      size: storedVideo.size,
      type: "video/mp4",
    };
  }

  async saveExternalVideoAttachment(
    scope: AttachmentScope,
    input: Record<string, unknown>,
  ) {
    const path = normalizeExternalVideoUrl(input.path);
    const cover = normalizeExternalVideoCoverUrl(input.cover_image);
    const pid = nonNegativeId(input.pid, "分类ID");
    if (pid > 0) await this.assertCategory(scope, pid, 2);
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(new URL(path).pathname.split("/").pop() ?? "video.mp4");
    } catch {
      decodedName = "video.mp4";
    }
    const realName = sanitizeOriginalName(decodedName);
    const inserted = await this.container.db.insert(systemAttachment).values({
      type: scope.type,
      fileType: 2,
      relationId: scope.relationId,
      name: path,
      attDir: path,
      sattDir: cover,
      attSize: "0",
      attType: "video/mp4",
      pid,
      time: Math.floor(Date.now() / 1000),
      imageType: 0,
      moduleType: scope.moduleType,
      realName,
    }).returning({ id: systemAttachment.attId });
    return {
      att_id: inserted[0].id,
      name: realName,
      url: path,
      src: path,
      cover_image: cover,
      type: "video/mp4",
    };
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
    const rows = await this.container.db.select({
      id: systemAttachment.attId,
      fileType: systemAttachment.fileType,
    })
      .from(systemAttachment).where(and(
        inArray(systemAttachment.attId, ids),
        eq(systemAttachment.type, scope.type),
        eq(systemAttachment.relationId, scope.relationId),
        eq(systemAttachment.moduleType, scope.moduleType),
      ));
    if (rows.length !== ids.length) throw new NotFoundException("一个或多个附件不存在");
    const fileTypes = new Set(rows.map((row) => row.fileType));
    if (fileTypes.size !== 1) throw new ValidateException("图片与视频不能同时移动");
    const fileType = rows[0].fileType;
    if (fileType !== 1 && fileType !== 2) throw new ValidateException("文件类型无效");
    if (pid > 0) await this.assertCategory(scope, pid, fileType);
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
    const allLevels = query.all === "1";
    const conditions = [
      eq(systemAttachmentCategory.type, scope.type),
      eq(systemAttachmentCategory.relationId, scope.relationId),
      eq(systemAttachmentCategory.fileType, fileType),
    ];
    if (name) conditions.push(ilike(systemAttachmentCategory.name, `%${name}%`));
    const all = await this.container.db.select().from(systemAttachmentCategory)
      .where(and(...conditions)).orderBy(systemAttachmentCategory.id);
    const rows = name || allLevels ? all : all.filter((row) => row.pid === pid);
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

  async getSignedAsset(
    idValue: unknown,
    expiresValue: unknown,
    signatureValue: unknown,
    variantValue?: unknown,
    widthValue?: unknown,
    heightValue?: unknown,
    rangeValue?: unknown,
  ): Promise<SignedAssetRead> {
    const id = positiveId(idValue, "附件ID");
    const expires = Number(expiresValue);
    const signature = typeof signatureValue === "string" ? decodeBase64Url(signatureValue) : null;
    const variant = requestedAttachmentVariant(variantValue, widthValue, heightValue);
    const range = variant ? undefined : requestedR2Range(rangeValue);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expires) || expires < now || expires > now + MAX_SIGNED_ASSET_TTL_SECONDS || !signature) {
      throw new NotFoundException("附件链接无效或已过期");
    }
    const key = await this.getSignatureKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(signatureMessage(id, expires, variant)),
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
      object = await this.env.ASSETS_BUCKET.get(rows[0].key, range ? { range } : undefined);
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
    if (!variant) return { response: r2ObjectResponse(object) };

    const format = imageOutputFormat(object.httpMetadata?.contentType);
    if (!format) return { response: r2ObjectResponse(object) };
    const cacheRequest = variantCacheRequest(id, object.etag, variant, format);
    let cached: Response | undefined;
    try {
      cached = await caches.default.match(cacheRequest);
    } catch (error) {
      emitOperationalEvent("warn", {
        event: "r2_object_variant_cache_failed",
        component: "r2",
        operation: "cache_match",
        outcome: "failure",
        errorCode: operationalErrorCode(error),
      });
    }
    if (cached) return { response: cached };

    try {
      const transformed = await this.env.IMAGES.input(object.body)
        .transform({ width: variant.width, height: variant.height, fit: "scale-down" })
        .output({ format, ...(format === "image/gif" ? { anim: true } : {}) });
      const transformedResponse = transformed.response({
        headers: {
          "Cache-Control": "public, max-age=604800",
          "ETag": `W/\"${object.etag}-${variant.name}-${variant.width}x${variant.height}\"`,
        },
      });
      return {
        response: transformedResponse.clone(),
        cacheWrite: async () => {
          try {
            await caches.default.put(cacheRequest, transformedResponse);
          } catch (error) {
            emitOperationalEvent("warn", {
              event: "r2_object_variant_cache_failed",
              component: "r2",
              operation: "cache_put",
              outcome: "failure",
              errorCode: operationalErrorCode(error),
            });
          }
        },
      };
    } catch (error) {
      emitOperationalEvent("warn", {
        event: "r2_object_transform_failed",
        component: "r2",
        operation: "transform",
        outcome: "failure",
        errorCode: operationalErrorCode(error),
      });
      const fallback = await this.env.ASSETS_BUCKET.get(rows[0].key);
      if (!fallback) throw new NotFoundException("附件不存在");
      return { response: r2ObjectResponse(fallback) };
    }
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
