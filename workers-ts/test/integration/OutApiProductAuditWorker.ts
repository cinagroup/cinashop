import { createContainerFromDb, createDbFromConnectionString } from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import {
  fingerprintOutProductPublicState,
  runOutApiProductPostgresScenario,
} from "./OutApiProductPostgresScenario";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

async function authorize(request: Request, verifier: string): Promise<boolean> {
  if (!verifier) return false;
  const token = request.headers.get("X-Audit-Token") ?? "";
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

async function currentState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_product_public_audit",
  });
  try {
    const rows = await db.$client<Array<{
      server_version: string;
      public_tables: number;
      public_columns: number;
      public_indexes: number;
      public_primary_keys: number;
      products: number;
      platform_products: number;
      physical_platform_products: number;
      platform_skus: number;
      nonempty_platform_barcodes: number;
      duplicate_platform_barcodes: number;
      replay_table_exists: boolean;
      public_failure_probe_exists: boolean;
      audit_product_ids: number[];
      audit_sku_ids: number[];
      audit_relation_rows: number;
      audit_description_rows: number;
      audit_attr_rows: number;
      audit_result_rows: number;
      audit_stock_rows: number;
      audit_cart_rows: number;
      audit_cart_fixture_ids: number[];
      store_cart_rows: number;
      store_cart_max_id: number | null;
      store_cart_sequence_last: string | null;
      temporary_schemas: number;
      temporary_schema_names: string[];
    }>>`
      SELECT
        current_setting('server_version') AS server_version,
        (SELECT count(*)::integer FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS public_tables,
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema = 'public') AS public_columns,
        (SELECT count(*)::integer FROM pg_indexes WHERE schemaname = 'public') AS public_indexes,
        (SELECT count(*)::integer FROM pg_constraint c
          JOIN pg_class r ON r.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = r.relnamespace
          WHERE n.nspname = 'public' AND c.contype = 'p') AS public_primary_keys,
        (SELECT count(*)::integer FROM store_product) AS products,
        (SELECT count(*)::integer FROM store_product WHERE type = 0 AND relation_id = 0) AS platform_products,
        (SELECT count(*)::integer FROM store_product WHERE type = 0 AND relation_id = 0 AND product_type = 0) AS physical_platform_products,
        (SELECT count(*)::integer
           FROM store_product_attr_value av
           JOIN store_product p ON p.id = av.product_id
          WHERE av.type = 0 AND p.type = 0 AND p.relation_id = 0 AND p.is_del = 0) AS platform_skus,
        (SELECT count(*)::integer
           FROM store_product_attr_value av
           JOIN store_product p ON p.id = av.product_id
          WHERE av.type = 0 AND av.bar_code <> ''
            AND p.type = 0 AND p.relation_id = 0 AND p.is_del = 0) AS nonempty_platform_barcodes,
        (SELECT count(*)::integer FROM (
          SELECT av.bar_code
          FROM store_product_attr_value av
          JOIN store_product p ON p.id = av.product_id
          WHERE av.type = 0 AND av.bar_code <> ''
            AND p.type = 0 AND p.relation_id = 0 AND p.is_del = 0
          GROUP BY av.bar_code HAVING count(*) > 1
        ) duplicates) AS duplicate_platform_barcodes,
        to_regclass('public.out_product_write_replay') IS NOT NULL AS replay_table_exists,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.store_product_attr_result'::regclass
            AND conname = 'out_product_result_failure_probe'
        ) AS public_failure_probe_exists,
        ARRAY(
          SELECT id FROM store_product
          WHERE store_name IN ('Out 平台商品', 'Out 平台商品-已编辑', '不应提交的名称', '重复平台条码商品')
          ORDER BY id
        ) AS audit_product_ids,
        ARRAY(
          SELECT av.id FROM store_product_attr_value av
          WHERE av.bar_code IN ('OUT-SKU-001', 'OUT-RED', 'OUT-BLUE')
             OR av.code IN ('OUT-001', 'OUT-EDIT', 'ROLLBACK-PROBE')
          ORDER BY av.id
        ) AS audit_sku_ids,
        (SELECT count(*)::integer FROM store_product_relation
          WHERE product_id IN (SELECT id FROM store_product
            WHERE store_name IN ('Out 平台商品', 'Out 平台商品-已编辑', '不应提交的名称', '重复平台条码商品'))) AS audit_relation_rows,
        (SELECT count(*)::integer FROM store_product_description
          WHERE product_id IN (SELECT id FROM store_product
            WHERE store_name IN ('Out 平台商品', 'Out 平台商品-已编辑', '不应提交的名称', '重复平台条码商品'))) AS audit_description_rows,
        (SELECT count(*)::integer FROM store_product_attr
          WHERE product_id IN (SELECT id FROM store_product
            WHERE store_name IN ('Out 平台商品', 'Out 平台商品-已编辑', '不应提交的名称', '重复平台条码商品'))) AS audit_attr_rows,
        (SELECT count(*)::integer FROM store_product_attr_result
          WHERE product_id IN (SELECT id FROM store_product
            WHERE store_name IN ('Out 平台商品', 'Out 平台商品-已编辑', '不应提交的名称', '重复平台条码商品'))) AS audit_result_rows,
        (SELECT count(*)::integer FROM store_product_stock_record
          WHERE product_id IN (SELECT id FROM store_product
            WHERE store_name IN ('Out 平台商品', 'Out 平台商品-已编辑', '不应提交的名称', '重复平台条码商品'))) AS audit_stock_rows,
        (SELECT count(*)::integer FROM store_cart
          WHERE product_id IN (SELECT id FROM store_product
            WHERE store_name IN ('Out 平台商品', 'Out 平台商品-已编辑', '不应提交的名称', '重复平台条码商品'))) AS audit_cart_rows,
        ARRAY(
          SELECT id FROM store_cart
          WHERE uid = 1 AND tourist_uid = '' AND type = 0 AND product_id = 1
            AND product_type = 0 AND activity_id = 0 AND store_id = 0 AND staff_id = 0
            AND product_attr_unique = '' AND cart_num = 1 AND add_time = 1
            AND is_pay = 0 AND is_del = 0 AND is_new = 0 AND status = 0
          ORDER BY id
        ) AS audit_cart_fixture_ids,
        (SELECT count(*)::integer FROM store_cart) AS store_cart_rows,
        (SELECT max(id)::integer FROM store_cart) AS store_cart_max_id,
        (SELECT last_value::text FROM pg_sequences
          WHERE schemaname = 'public' AND sequencename = 'store_cart_id_seq') AS store_cart_sequence_last,
        (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_product_%') AS temporary_schemas,
        ARRAY(SELECT nspname FROM pg_namespace WHERE nspname LIKE 'codex_out_product_%' ORDER BY nspname) AS temporary_schema_names
    `;
    const state = rows[0];
    const replayRows = state.replay_table_exists
      ? Number((await db.$client.unsafe<Array<{ count: number }>>(
          "SELECT count(*)::integer AS count FROM public.out_product_write_replay",
        ))[0]?.count ?? 0)
      : 0;
    return { ...state, replay_rows: replayRows };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function applyReplaySchema(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_product_replay_apply",
  });
  try {
    const before = await fingerprintOutProductPublicState(db);
    const ddl = new MigrationService(createContainerFromDb(db))
      .outProductWriteReplayMigrationSqlForVerification();
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SELECT pg_advisory_xact_lock(744220003, 0)`;
      await tx.unsafe(ddl);
      await tx.unsafe(ddl);
    });
    const after = await fingerprintOutProductPublicState(db);
    const [verification] = await db.$client<Array<{
      columns: number;
      constraints: number;
      indexes: number;
      rows: number;
    }>>`
      SELECT
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'out_product_write_replay') AS columns,
        (SELECT count(*)::integer FROM pg_constraint
          WHERE conrelid = 'public.out_product_write_replay'::regclass) AS constraints,
        (SELECT count(*)::integer FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'out_product_write_replay') AS indexes,
        (SELECT count(*)::integer FROM out_product_write_replay) AS rows
    `;
    const publicStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!publicStateUnchanged || verification.columns !== 8 || verification.constraints !== 4
      || verification.indexes !== 3 || verification.rows !== 0) {
      throw new Error("Out product replay schema verification failed");
    }
    return {
      applied: true,
      repeated_apply_succeeded: true,
      public_business_state_unchanged: publicStateUnchanged,
      ...verification,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    console.log(JSON.stringify({ event: "out_product_audit_request", method: request.method, path }));
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || !new Set(["/state", "/run", "/apply"]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      if (path === "/state") return Response.json(await currentState(env.HYPERDRIVE.connectionString));
      if (path === "/apply") return Response.json(await applyReplaySchema(env.HYPERDRIVE.connectionString));
      const before = await currentState(env.HYPERDRIVE.connectionString);
      const scenario = await runOutApiProductPostgresScenario(env.HYPERDRIVE.connectionString);
      const after = await currentState(env.HYPERDRIVE.connectionString);
      return Response.json({ before, scenario, after });
    } catch (error) {
      console.error(JSON.stringify({
        event: "out_product_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
