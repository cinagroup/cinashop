import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  systemAttachment,
  systemAttachmentCategory,
  systemFile,
  systemStorage,
} from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  AttachmentService,
  canonicalAttachmentPath,
  createAttachmentImageVariant,
  detectImageType,
  detectMp4Type,
  isAttachmentObjectCleanupMessage,
  kefuAttachmentScope,
  normalizeExternalVideoUrl,
  parseCanonicalAttachmentId,
  signAttachmentReferences,
  signAttachmentVariantReferences,
} from "@/services/system/AttachmentService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("attachment and R2 storage migration boundary", () => {
  it("preserves all four source tables and their source primary keys", () => {
    expect(getTableName(systemAttachment)).toBe("system_attachment");
    expect(getTableName(systemAttachmentCategory)).toBe("system_attachment_category");
    expect(getTableName(systemFile)).toBe("system_file");
    expect(getTableName(systemStorage)).toBe("system_storage");
    expect(Object.keys(getTableColumns(systemAttachment))).toEqual([
      "attId", "type", "fileType", "relationId", "name", "attDir", "sattDir",
      "attSize", "attType", "pid", "time", "imageType", "moduleType", "realName", "scanToken",
    ]);
    expect(Object.keys(getTableColumns(systemAttachmentCategory))).toEqual([
      "id", "type", "fileType", "relationId", "pid", "name", "enname",
    ]);
    expect(Object.keys(getTableColumns(systemFile))).toEqual([
      "id", "cthash", "filename", "atime", "mtime", "ctime",
    ]);
    expect(Object.keys(getTableColumns(systemStorage))).toEqual([
      "id", "accessKey", "type", "name", "region", "acl", "domain", "cname",
      "isSsl", "status", "isDelete", "addTime", "updateTime",
    ]);
    for (const [table, key] of [
      ["system_attachment", ["att_id"]],
      ["system_attachment_category", ["id"]],
      ["system_file", ["id"]],
      ["system_storage", ["id"]],
    ] as const) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(key);
    }
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external and embedded 0067 SQL identical without invented relational constraints", () => {
    const migration = readFileSync("migrations/0067_attachment_storage.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(/private migration_0074\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"|CREATE UNIQUE INDEX/i);
    expect(migration).toContain('"type" SMALLINT DEFAULT 1,');
    expect(migration).toContain('"access_key" VARCHAR(100)');
  });

  it("uses a generated private R2 binding and never promotes legacy storage rows to runtime authority", () => {
    const config = readFileSync("wrangler.toml", "utf8");
    const generated = readFileSync("worker-configuration.d.ts", "utf8");
    const source = readFileSync("src/services/system/AttachmentService.ts", "utf8");
    expect(config).toContain('binding = "ASSETS_BUCKET"');
    expect(config).toContain('bucket_name = "cinashop-assets"');
    expect(config).toContain('[images]\nbinding = "IMAGES"');
    expect(config).toContain('[cache]\nenabled = true');
    expect(generated).toContain("ASSETS_BUCKET: R2Bucket;");
    expect(generated).toContain("IMAGES: ImagesBinding;");
    expect(source).toContain("this.env.ASSETS_BUCKET.put(key, file.stream()");
    expect(source).toContain("this.env.IMAGES.input(object.body)");
    expect(source).toContain("caches.default.put(cacheRequest");
    expect(source).toContain("runtime_authority: false");
    expect(source).not.toMatch(/access_key:\s*row\.accessKey|env\.(?:QINIU|OSS|COS)_/);
  });

  it("validates image content independently from a client MIME declaration", () => {
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      mime: "image/jpeg", extension: "jpg",
    });
    expect(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toEqual({
      mime: "image/png", extension: "png",
    });
    expect(detectImageType(new TextEncoder().encode("<svg><script>"))).toBeNull();
  });

  it("validates MP4 content and external video URLs without server-side fetching", () => {
    expect(detectMp4Type(Uint8Array.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]))).toBe(true);
    expect(detectMp4Type(new TextEncoder().encode("not-an-mp4"))).toBe(false);
    expect(normalizeExternalVideoUrl("https://media.example.test/demo.mp4#ignored"))
      .toBe("https://media.example.test/demo.mp4");
    expect(() => normalizeExternalVideoUrl("http://media.example.test/demo.mp4"))
      .toThrow("视频地址格式错误");
    expect(() => normalizeExternalVideoUrl("https://127.0.0.1/demo.mp4"))
      .toThrow("视频地址格式错误");
    expect(() => normalizeExternalVideoUrl("https://media.example.test/demo.svg"))
      .toThrow("视频地址格式错误");
  });

  it("signs only canonical asset paths with a bounded expiry", async () => {
    const attachments = new AttachmentService({} as Container, { APP_KEY: "test-only-key" } as Env);
    const [signed, external] = await attachments.signReferences([
      canonicalAttachmentPath(42),
      "https://legacy.example.test/qualification.jpg",
    ], 60);
    expect(parseCanonicalAttachmentId("/api/assets/42")).toBe(42);
    expect(parseCanonicalAttachmentId("/api/assets/42/extra")).toBeNull();
    expect(signed).toMatch(/^\/api\/assets\/42\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/);
    expect(external).toBe("https://legacy.example.test/qualification.jpg");
    await expect(signAttachmentReferences("test-only-key", [canonicalAttachmentPath(9)], 3_601))
      .rejects.toThrow("附件链接有效期无效");
  });

  it("binds a bounded fixed image variant into the signed private asset URL", async () => {
    const variant = createAttachmentImageVariant("mid", 400, 400);
    expect(variant).toEqual({ name: "mid", width: 400, height: 400 });
    expect(createAttachmentImageVariant("mid", 2_049, 400)).toBeNull();
    expect(createAttachmentImageVariant("arbitrary", 400, 400)).toBeNull();
    const [signed, external] = await signAttachmentVariantReferences(
      "test-only-key",
      [canonicalAttachmentPath(42), "https://legacy.example.test/product.jpg"],
      variant!,
      60,
    );
    expect(signed).toMatch(
      /^\/api\/assets\/42\?variant=mid&width=400&height=400&expires=\d+&signature=[A-Za-z0-9_-]{43}$/,
    );
    expect(external).toBe("https://legacy.example.test/product.jpg");

    const query = new URL(`https://asset.invalid${signed}`).searchParams;
    const dbMustNotRun = new Proxy({}, {
      get() { throw new Error("database must not be reached for a bad signature"); },
    });
    const verifier = new AttachmentService(
      { db: dbMustNotRun } as Container,
      { APP_KEY: "test-only-key" } as Env,
    );
    await expect(verifier.getSignedAsset(
      42,
      query.get("expires"),
      query.get("signature"),
      "mid",
      401,
      400,
    )).rejects.toThrow("附件链接无效或已过期");
  });

  it("isolates customer-service uploads by agent and the PHP module domain", () => {
    expect(kefuAttachmentScope(17)).toEqual({ type: 1, relationId: 17, moduleType: 2 });
    expect(() => kefuAttachmentScope(0)).toThrow("客服ID无效");
  });

  it("strictly validates idempotent object-cleanup queue messages", () => {
    const message = {
      action: "deleteAttachmentObjects",
      keys: ["attachments/user/9/2026/08/123e4567-e89b-12d3-a456-426614174000.png"],
    };
    expect(isAttachmentObjectCleanupMessage(message)).toBe(true);
    expect(isAttachmentObjectCleanupMessage({
      ...message,
      keys: ["attachments/kefu/17/2026/08/123e4567-e89b-12d3-a456-426614174000.webp"],
    })).toBe(true);
    expect(isAttachmentObjectCleanupMessage({
      ...message,
      keys: ["attachments/supplier/17/2026/09/123e4567-e89b-12d3-a456-426614174000.mp4"],
    })).toBe(true);
    expect(isAttachmentObjectCleanupMessage({
      ...message,
      keys: [`attachments/tmp/supplier/17/${"a".repeat(64)}/3.part`],
    })).toBe(true);
    expect(isAttachmentObjectCleanupMessage({ ...message, keys: ["../secret"] })).toBe(false);
    expect(isAttachmentObjectCleanupMessage({ ...message, keys: [] })).toBe(false);
  });

  it("registers compatibility routes under one attachment permission domain", () => {
    const userRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const supplierRoutes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(userRoutes).toContain('/assets/:id", AttachmentController.asset');
    expect(userRoutes).toContain('/upload/image", authMiddleware({ force: true })');
    for (const route of ["/file/file", "/file/upload", "/file/category", "/config/storage"]) {
      expect(adminRoutes).toContain(route);
    }
    for (const route of ["/file/file", "/file/upload", "/file/category"]) {
      expect(supplierRoutes).toContain(route);
    }
    for (const route of [
      "/file/video_upload",
      "/file/video_attachment",
      "/file/get/way_data",
      "/file/category/create",
    ]) expect(supplierRoutes).toContain(route);
    expect(adminRoutes).toContain('"/file/upload_type", adminAuth, AttachmentController.uploadType');
    expect(supplierRoutes).toContain('"/file/upload_type", AttachmentController.supplierUploadType');
    const decisions = JSON.parse(readFileSync("audit/legacy-route-decisions.json", "utf8")) as {
      decisions: Array<{ surface: string; method: string; path: string; status: string }>;
    };
    expect(decisions.decisions.filter((decision) =>
      decision.surface === "supplier" && decision.path.startsWith("/supplierapi/file/")
    ).map((decision) => `${decision.method} ${decision.path}`).sort()).toEqual([
      "GET /supplierapi/file/category/:id",
      "GET /supplierapi/file/file/move",
      "GET /supplierapi/file/remove/qrcode",
      "GET /supplierapi/file/scan/image/list/:scan_token",
      "GET /supplierapi/file/scan/qrcode",
      "GET /supplierapi/file/set/way_data/:is_way",
      "POST /supplierapi/file/online/upload",
    ].sort());
    expect(requiredAdminPermission("GET", "/adminapi/file/file")).toBe("attachment.view");
    expect(requiredAdminPermission("POST", "/adminapi/file/upload")).toBe("attachment.manage");
    expect(requiredAdminPermission("GET", "/adminapi/config/storage")).toBe("attachment.view");
  });

  it("bounds multipart bodies and verifies supplier qualification ownership transactionally", () => {
    const controller = readFileSync("src/controllers/system/AttachmentController.ts", "utf8");
    const application = readFileSync("src/services/supplier/SupplierApplicationService.ts", "utf8");
    expect(controller).toContain("total > MAX_MULTIPART_IMAGE_BYTES");
    expect(controller).toContain("total > MAX_MULTIPART_VIDEO_CHUNK_BYTES");
    expect(controller).toContain("await reader.cancel()");
    expect(controller).toContain('c.req.header("range")');
    expect(controller).toContain('headers.set("X-Content-Type-Options", "nosniff")');
    const attachment = readFileSync("src/services/system/AttachmentService.ts", "utf8");
    expect(attachment).toContain('headers.set("Content-Range"');
    expect(attachment).toContain("status: 206");
    expect(application).toContain("eq(systemAttachment.relationId, uid)");
    expect(application).toContain("eq(systemAttachment.moduleType, 3)");
    expect(application).toContain("eq(systemAttachment.imageType, R2_IMAGE_TYPE)");
    expect(application).toContain("历史 HTTPS 图片只能原样保留");
  });

  it("keeps the production Supplier attachment audit read-only and aggregate-only", () => {
    const audit = readFileSync("test/integration/SupplierAttachmentAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/supplier-attachment-audit.wrangler.toml", "utf8");
    expect(audit).toContain("SET TRANSACTION READ ONLY");
    expect(audit).toContain("databaseKeys, SUPPLIER_OBJECT_PREFIX");
    expect(audit).toContain('const SUPPLIER_OBJECT_PREFIX = ["attachments", "supplier", ""].join("/")');
    expect(audit).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    expect(audit).not.toMatch(/ASSETS_BUCKET\.(?:put|delete|createMultipartUpload)/);
    expect(config).toContain('id = "9748c294e21c49a99579c9cef70102e0"');
    expect(config).toContain('bucket_name = "cinashop-assets"');
  });
});
