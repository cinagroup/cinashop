import { createDbFromConnectionString } from "@/lib/di";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  ASSETS_BUCKET: R2Bucket;
  AUDIT_TOKEN_SHA256: string;
}

interface AttachmentCounts {
  total: number;
  supplier_total: number;
  supplier_images: number;
  supplier_videos: number;
  supplier_r2: number;
  supplier_external_or_legacy: number;
  supplier_distinct_owners: number;
  invalid_supplier_scope: number;
  noncanonical_r2_reference: number;
  invalid_r2_object_key: number;
  nonempty_scan_token: number;
  duplicate_r2_object_keys: number;
}

interface CategoryCounts {
  supplier_total: number;
  supplier_distinct_owners: number;
  invalid_supplier_scope: number;
  duplicate_names: number;
  attachment_owner_orphans: number;
  category_owner_orphans: number;
  attachment_category_orphans: number;
  category_parent_orphans: number;
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function r2Inventory(
  bucket: R2Bucket,
  databaseKeys: Set<string>,
  prefix: string,
  maximum = 10_000,
) {
  let cursor: string | undefined;
  let count = 0;
  let orphaned = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1_000 });
    for (const object of page.objects) {
      count += 1;
      if (!databaseKeys.has(object.key)) orphaned += 1;
    }
    if (count >= maximum) {
      return { count, orphaned, complete: !page.truncated };
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { count, orphaned, complete: true };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) return json({ error: "forbidden" }, 403);
    if (request.method !== "GET" || new URL(request.url).pathname !== "/supplier-attachments") {
      return json({ error: "not_found" }, 404);
    }

    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_supplier_attachment_read_only_audit",
    });
    try {
      const database = await db.$client.begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        await tx`SET LOCAL search_path TO public`;
        await tx`SET LOCAL statement_timeout TO '15s'`;
        const version = await tx<{ version: string }[]>`SELECT current_setting('server_version') AS version`;
        const attachment = await tx<AttachmentCounts[]>`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE type = 4 AND module_type = 1)::int AS supplier_total,
            count(*) FILTER (WHERE type = 4 AND module_type = 1 AND file_type = 1)::int AS supplier_images,
            count(*) FILTER (WHERE type = 4 AND module_type = 1 AND file_type = 2)::int AS supplier_videos,
            count(*) FILTER (WHERE type = 4 AND module_type = 1 AND image_type = 8)::int AS supplier_r2,
            count(*) FILTER (WHERE type = 4 AND module_type = 1 AND image_type <> 8)::int AS supplier_external_or_legacy,
            count(DISTINCT relation_id) FILTER (WHERE type = 4 AND module_type = 1)::int AS supplier_distinct_owners,
            count(*) FILTER (WHERE type = 4 AND (relation_id <= 0 OR module_type <> 1))::int AS invalid_supplier_scope,
            count(*) FILTER (
              WHERE type = 4 AND module_type = 1 AND image_type = 8
                AND (att_dir !~ '^/api/assets/[1-9][0-9]*$' OR satt_dir !~ '^(/api/assets/[1-9][0-9]*)?$')
            )::int AS noncanonical_r2_reference,
            count(*) FILTER (
              WHERE type = 4 AND module_type = 1 AND image_type = 8
                AND name !~ '^attachments/supplier/[1-9][0-9]*/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}\\.(jpg|png|webp|gif|mp4)$'
            )::int AS invalid_r2_object_key,
            count(*) FILTER (WHERE type = 4 AND module_type = 1 AND scan_token <> '')::int AS nonempty_scan_token,
            coalesce((
              SELECT sum(item_count - 1)::int
              FROM (
                SELECT count(*)::int AS item_count
                FROM public.system_attachment
                WHERE type = 4 AND module_type = 1 AND image_type = 8
                GROUP BY name
                HAVING count(*) > 1
              ) duplicate_keys
            ), 0)::int AS duplicate_r2_object_keys
          FROM public.system_attachment
        `;
        const category = await tx<CategoryCounts[]>`
          SELECT
            (SELECT count(*)::int FROM public.system_attachment_category WHERE type = 4) AS supplier_total,
            (SELECT count(DISTINCT relation_id)::int FROM public.system_attachment_category WHERE type = 4) AS supplier_distinct_owners,
            (SELECT count(*)::int FROM public.system_attachment_category WHERE type = 4 AND relation_id <= 0) AS invalid_supplier_scope,
            (SELECT coalesce(sum(item_count - 1), 0)::int FROM (
              SELECT count(*)::int AS item_count
              FROM public.system_attachment_category
              WHERE type = 4
              GROUP BY relation_id, file_type, name
              HAVING count(*) > 1
            ) duplicated) AS duplicate_names,
            (SELECT count(*)::int
              FROM public.system_attachment attachment
              LEFT JOIN public.system_supplier supplier ON supplier.id = attachment.relation_id
              WHERE attachment.type = 4 AND attachment.module_type = 1 AND supplier.id IS NULL
            ) AS attachment_owner_orphans,
            (SELECT count(*)::int
              FROM public.system_attachment_category category
              LEFT JOIN public.system_supplier supplier ON supplier.id = category.relation_id
              WHERE category.type = 4 AND supplier.id IS NULL
            ) AS category_owner_orphans,
            (SELECT count(*)::int
              FROM public.system_attachment attachment
              LEFT JOIN public.system_attachment_category category
                ON category.id = attachment.pid
                AND category.type = attachment.type
                AND category.relation_id = attachment.relation_id
                AND category.file_type = attachment.file_type
              WHERE attachment.type = 4 AND attachment.module_type = 1
                AND attachment.pid > 0 AND category.id IS NULL
            ) AS attachment_category_orphans,
            (SELECT count(*)::int
              FROM public.system_attachment_category child
              LEFT JOIN public.system_attachment_category parent
                ON parent.id = child.pid
                AND parent.type = child.type
                AND parent.relation_id = child.relation_id
                AND parent.file_type = child.file_type
              WHERE child.type = 4 AND child.pid > 0 AND parent.id IS NULL
            ) AS category_parent_orphans
        `;
        const r2Keys = await tx<{ name: string }[]>`
          SELECT name
          FROM public.system_attachment
          WHERE type = 4 AND module_type = 1 AND image_type = 8
          ORDER BY att_id
          LIMIT 10001
        `;
        return {
          version: version[0]?.version ?? "unknown",
          attachment: attachment[0],
          category: category[0],
          r2Keys,
        };
      });

      const databaseKeysComplete = database.r2Keys.length <= 10_000;
      const databaseKeys = new Set(database.r2Keys.slice(0, 10_000).map((row) => row.name));
      const supplierObjects = await r2Inventory(env.ASSETS_BUCKET, databaseKeys, "attachments/supplier/");
      const temporaryObjects = await r2Inventory(env.ASSETS_BUCKET, new Set(), "attachments/tmp/supplier/");
      let missingDatabaseObjects = 0;
      if (databaseKeysComplete) {
        const keys = [...databaseKeys];
        for (let offset = 0; offset < keys.length; offset += 20) {
          const heads = await Promise.all(keys.slice(offset, offset + 20).map((key) => env.ASSETS_BUCKET.head(key)));
          missingDatabaseObjects += heads.filter((object) => object === null).length;
        }
      }
      return json({
        generated_at: new Date().toISOString(),
        database_version: database.version,
        transaction_read_only: true,
        attachment: database.attachment,
        category: database.category,
        r2: {
          database_keys: databaseKeys.size,
          database_keys_complete: databaseKeysComplete,
          missing_database_objects: databaseKeysComplete ? missingDatabaseObjects : null,
          supplier_objects: supplierObjects.count,
          supplier_orphan_objects: databaseKeysComplete && supplierObjects.complete
            ? supplierObjects.orphaned
            : null,
          supplier_scan_complete: supplierObjects.complete,
          temporary_objects: temporaryObjects.count,
          temporary_scan_complete: temporaryObjects.complete,
        },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "supplier_attachment_read_only_audit_failed",
        errorCode: error instanceof Error ? error.name : "unknown",
      }));
      return json({ error: "audit_failed" }, 500);
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
