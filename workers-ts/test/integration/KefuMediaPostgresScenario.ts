import { and, eq } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type DbClient,
} from "@/lib/di";
import {
  storeServiceLog,
  systemAttachment,
} from "@/models/schema";
import { KefuCoreService } from "@/services/kefu/KefuCoreService";
import {
  KefuRealtimeService,
  type ChatSocketSession,
} from "@/services/kefu/KefuRealtimeService";
import {
  AttachmentService,
  kefuAttachmentScope,
  R2_IMAGE_TYPE,
  userAttachmentScope,
} from "@/services/system/AttachmentService";
import { md5 } from "@/utils/jwt";

const TABLES = [
  "system_attachment",
  "store_service",
  "store_service_log",
  "store_service_record",
  "user",
] as const;
const PRIVATE_SEQUENCES = [
  ["system_attachment", "att_id"],
  ["store_service_log", "id"],
  ["store_service_record", "id"],
] as const;

interface Fingerprint {
  count: number;
  digest: string;
}

export interface KefuMediaPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  production_attachment_rows: number;
  r2_residue_after: number;
  isolated: Record<string, boolean>;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Kefu media integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_kefu_media_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

function randomPositiveId(): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return 1_000_000_000 + (random[0] % 900_000_000);
}

async function fingerprints(db: DbClient) {
  const tables: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const row = (await db.$client.unsafe<Array<Fingerprint>>(`
      SELECT count(*)::int AS count,
             COALESCE(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest
      FROM public.${identifier(table)} AS t
    `))[0];
    assertCondition(row, `could not fingerprint public.${table}`);
    tables[table] = row;
  }
  const sequences = await db.$client<Array<{ sequencename: string; last_value: string | null }>>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public'
      AND sequencename IN (
        'system_attachment_att_id_seq',
        'store_service_log_id_seq',
        'store_service_record_id_seq'
      )
    ORDER BY sequencename
  `;
  return { tables, sequences };
}

async function setupSchema(
  db: DbClient,
  schemaName: string,
  kefuId: number,
  kefuPassword: string,
  userPassword: string,
) {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await tx.unsafe(`CREATE TABLE ${schema}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`);
    }
    for (const [table, column] of PRIVATE_SEQUENCES) {
      const sequence = `${table}_${column}_seq`;
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequence)}`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${identifier(sequence)} OWNED BY ${schema}.${identifier(table)}.${identifier(column)}`);
      await tx.unsafe(`ALTER TABLE ${schema}.${identifier(table)} ALTER COLUMN ${identifier(column)} SET DEFAULT nextval('${schemaName}.${sequence}'::regclass)`);
    }
    await tx.unsafe(`
      INSERT INTO ${schema}."user" (uid, account, pwd, nickname, avatar, phone, user_type, status, is_del)
      VALUES
        (1001, 'audit-kefu', '', '媒体审计客服', '/kefu.png', '13800000001', 'kefu', 1, 0),
        (2001, 'audit-customer', '${md5(userPassword)}', '媒体审计用户', '/user.png', '13900000001', 'wechat', 1, 0)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service
        (id, uid, account, password, nickname, avatar, phone, online, account_status, status, is_del)
      VALUES
        (${kefuId}, 1001, 'audit-support', '${kefuPassword}', '媒体审计客服', '/kefu.png', '13800000001', 1, 1, 1, 0)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service_record
        (id, user_id, to_uid, nickname, avatar, is_tourist, online, type, add_time, update_time, mssage_num, message, message_type)
      VALUES
        (1, 1001, 2001, '媒体审计用户', '/user.png', 0, 1, 1, 1, 1, 0, '', 1)
    `);
    for (const [table, column] of PRIVATE_SEQUENCES) {
      const sequence = `${table}_${column}_seq`;
      await tx.unsafe(`SELECT setval('${schemaName}.${sequence}', 10, true)`);
    }
  });
}

function pngFile(name: string): File {
  const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}

async function objectsForPrefix(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 100 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function deletePrefixes(bucket: R2Bucket, prefixes: string[]): Promise<void> {
  for (const prefix of prefixes) {
    const objects = await objectsForPrefix(bucket, prefix);
    if (objects.length) await bucket.delete(objects.map((object) => object.key));
  }
}

function signedAssetReference(value: string): boolean {
  return /^\/api\/assets\/[1-9]\d*\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/.test(value);
}

export async function runKefuMediaPostgresScenario(
  connectionString: string,
  bucket: R2Bucket,
): Promise<KefuMediaPostgresReport> {
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_kefu_media_audit_root",
  });
  const schemaName = randomSchemaName();
  const kefuId = randomPositiveId();
  const rollbackKefuId = kefuId + 1;
  const prefixes = [
    `attachments/kefu/${kefuId}/`,
    `attachments/user/2001/`,
    `attachments/kefu/${rollbackKefuId}/`,
  ];
  const appKey = crypto.randomUUID();
  const kefuPassword = "Audit-Kefu-Pass-2026";
  const userPassword = "Audit-User-Pass-2026";
  let schemaCreated = false;
  let report: KefuMediaPostgresReport | null = null;

  try {
    await deletePrefixes(bucket, prefixes);
    const before = await fingerprints(root);
    const serverVersion = (await root.$client<Array<{ server_version: string }>>`SHOW server_version`)[0]?.server_version ?? "unknown";
    await setupSchema(root, schemaName, kefuId, kefuPassword, userPassword);
    schemaCreated = true;

    const isolated = createDbFromConnectionString(connectionString, 3, {
      searchPath: schemaName,
      applicationName: "cinashop_kefu_media_audit_isolated",
    });
    const runtimeEnv = {
      APP_KEY: appKey,
      ASSETS_BUCKET: bucket,
      UPSTASH_REDIS_URL: "",
      UPSTASH_REDIS_TOKEN: "",
    } as Env;
    const container = createContainerFromDb(isolated);
    const attachments = new AttachmentService(container, runtimeEnv);
    const kefuUpload = await attachments.uploadImage(kefuAttachmentScope(kefuId), pngFile("kefu-audit.png"), 0);
    const userUpload = await attachments.uploadImage(userAttachmentScope(2001), pngFile("user-audit.png"), 0);

    const attachmentRows = await withTx(container, (tx) => tx
      .select()
      .from(systemAttachment)
      .where(and(
        eq(systemAttachment.imageType, R2_IMAGE_TYPE),
        eq(systemAttachment.fileType, 1),
      )));
    const kefuRow = attachmentRows.find((row) => row.attId === kefuUpload.att_id);
    const userRow = attachmentRows.find((row) => row.attId === userUpload.att_id);
    assertCondition(kefuRow && userRow, "uploaded attachment metadata was not committed");

    const storedObject = await bucket.get(kefuRow.name);
    assertCondition(storedObject, "uploaded R2 object was not found");
    const signedUrl = new URL(kefuUpload.src, "https://audit.invalid");
    const signedObject = await withTx(container, (tx) => new AttachmentService(
      createContainerFromDb(tx),
      runtimeEnv,
    ).getSignedAsset(
      kefuUpload.att_id,
      signedUrl.searchParams.get("expires"),
      signedUrl.searchParams.get("signature"),
    ));
    const signedBytes = new Uint8Array(await signedObject.arrayBuffer());

    const kefuSession: ChatSocketSession = {
      principalUid: 1001,
      role: 2,
      toUid: 2001,
      authId: kefuId,
      tokenKey: "11111111111111111111111111111111",
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      authVersion: md5(kefuPassword),
      connectedAt: Date.now(),
    };
    const userSession: ChatSocketSession = {
      principalUid: 2001,
      role: 1,
      toUid: 1001,
      authId: 2001,
      tokenKey: "22222222222222222222222222222222",
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      authVersion: md5(userPassword),
      connectedAt: Date.now(),
    };
    const realtime = new KefuRealtimeService(container, runtimeEnv);
    const kefuMessage = await realtime.persistMessage(kefuSession, {
      toUid: 2001,
      message: kefuUpload.url,
      messageType: 3,
    });
    const userMessage = await realtime.persistMessage(userSession, {
      toUid: 1001,
      message: userUpload.url,
      messageType: 3,
    });
    let crossScopeRejected = false;
    try {
      await realtime.persistMessage(kefuSession, {
        toUid: 2001,
        message: userUpload.url,
        messageType: 3,
      });
    } catch (error) {
      crossScopeRejected = error instanceof Error && error.message.includes("无权访问");
    }
    const storedMessages = await withTx(container, (tx) => tx
      .select({ msn: storeServiceLog.msn, msnType: storeServiceLog.msnType })
      .from(storeServiceLog)
      .where(eq(storeServiceLog.msnType, 3)));
    const kefuHistory = await withTx(container, (tx) => new KefuCoreService(
      createContainerFromDb(tx),
      runtimeEnv,
    ).chatHistory(1001, 2001, 0, 0, 100));
    const userHistory = await realtime.userRecord(2001, { toUid: "1001", limit: "100" });

    await root.$client.unsafe(`
      CREATE OR REPLACE FUNCTION ${identifier(schemaName)}.reject_kefu_media_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced kefu media audit rollback';
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER reject_kefu_media_audit
      BEFORE INSERT ON ${identifier(schemaName)}.system_attachment
      FOR EACH ROW EXECUTE FUNCTION ${identifier(schemaName)}.reject_kefu_media_audit();
    `);
    let rollbackRejected = false;
    try {
      await attachments.uploadImage(kefuAttachmentScope(rollbackKefuId), pngFile("rollback-audit.png"), 0);
    } catch (error) {
      rollbackRejected = error instanceof Error && error.message.includes("forced kefu media audit rollback");
    }
    const rollbackObjects = await objectsForPrefix(bucket, prefixes[2]);

    const isolatedChecks = {
      kefu_scope_written:
        kefuRow.type === 1 && kefuRow.relationId === kefuId && kefuRow.moduleType === 2 &&
        kefuRow.fileType === 1 && kefuRow.imageType === R2_IMAGE_TYPE &&
        kefuRow.name.startsWith(prefixes[0]) && kefuUpload.url === `/api/assets/${kefuRow.attId}`,
      user_scope_written:
        userRow.type === 3 && userRow.relationId === 2001 && userRow.moduleType === 3 &&
        userRow.name.startsWith(prefixes[1]),
      private_r2_metadata:
        storedObject.httpMetadata?.contentType === "image/png" &&
        storedObject.httpMetadata?.cacheControl === "private, no-store" &&
        storedObject.customMetadata?.ownerType === "1" &&
        storedObject.customMetadata?.ownerId === String(kefuId),
      signed_read_exact:
        signedBytes.byteLength === storedObject.size && signedBytes[0] === 0x89 && signedBytes[1] === 0x50,
      image_messages_stored_canonical:
        storedMessages.length === 2 && storedMessages.every((message) => /^\/api\/assets\/[1-9]\d*$/.test(message.msn)),
      realtime_images_signed:
        signedAssetReference(kefuMessage.msn) && signedAssetReference(kefuMessage.recored.message) &&
        signedAssetReference(userMessage.msn) && signedAssetReference(userMessage.recored.message),
      kefu_history_signed:
        kefuHistory.length === 2 && kefuHistory.every((message) => signedAssetReference(message.msn)),
      user_history_signed:
        userHistory.serviceList.length === 2 && userHistory.serviceList.every((message) => signedAssetReference(message.msn)),
      cross_scope_rejected: crossScopeRejected,
      rollback_deleted_object: rollbackRejected && rollbackObjects.length === 0,
    };
    for (const [name, value] of Object.entries(isolatedChecks)) {
      assertCondition(value, `${name} check failed`);
    }

    await isolated.$client.end();
    await deletePrefixes(bucket, prefixes);
    const residue = (await Promise.all(prefixes.map((prefix) => objectsForPrefix(bucket, prefix))))
      .reduce((total, objects) => total + objects.length, 0);
    await root.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
    schemaCreated = false;
    const temporarySchemasAfter = Number((await root.$client<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_namespace
      WHERE nspname LIKE 'codex_kefu_media_%'
    `)[0]?.count ?? -1);
    const after = await fingerprints(root);
    const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
    assertCondition(temporarySchemasAfter === 0, "temporary schema leaked");
    assertCondition(residue === 0, "temporary R2 object leaked");
    assertCondition(publicStateUnchanged, "public production state changed");
    report = {
      server_version: serverVersion,
      schema_created: true,
      schema_removed: true,
      temporary_schemas_after: temporarySchemasAfter,
      public_state_unchanged: publicStateUnchanged,
      production_attachment_rows: before.tables.system_attachment.count,
      r2_residue_after: residue,
      isolated: isolatedChecks,
    };
  } finally {
    await deletePrefixes(bucket, prefixes).catch(() => undefined);
    if (schemaCreated) {
      await root.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`).catch(() => undefined);
    }
    await root.$client.end().catch(() => undefined);
  }
  assertCondition(report, "scenario did not produce a report");
  return report;
}
