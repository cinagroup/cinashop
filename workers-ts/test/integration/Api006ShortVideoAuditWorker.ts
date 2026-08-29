import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import type { Env } from "@/env";
import { createContainerFromDb, createDbFromConnectionString, type DbClient } from "@/lib/di";
import { ShortVideoService } from "@/services/activity/ShortVideoService";
import { MigrationService } from "@/services/MigrationService";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & { AUDIT_TOKEN_SHA256: string };
const PREFIX = "codex_api006_short_video_";
const CLONE_TABLES = ["system_config", "user", "user_relation", "store_product", "live_room"] as const;
const FINGERPRINT_TABLES = ["system_config", "user", "user_relation", "store_product", "live_room"] as const;

async function authorized(request: Request, expectedHash: string): Promise<boolean> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const normalized = expectedHash.trim().toLowerCase();
  const configured = /^[a-f0-9]{64}$/.test(normalized)
    ? Uint8Array.from(normalized.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16))
    : new Uint8Array(32);
  return configured.length === 32 && crypto.subtle.timingSafeEqual(actual, configured.buffer);
}

function runtimeEnv(env: AuditEnv): Env {
  const values = new Map<string, string>();
  return {
    ...env,
    APP_KEY: "api006-short-video-audit-only",
    CONFIG_KV: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); },
    },
  } as unknown as Env;
}

function transactionDb(tx: unknown, options: unknown): DbClient {
  const client = tx as { options?: unknown };
  if (!client.options) client.options = options;
  return drizzle(tx as never, { schema }) as unknown as DbClient;
}

async function fingerprints(client: postgres.Sql) {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const table of FINGERPRINT_TABLES) {
    const [row] = await client.unsafe<Array<{ count: number; digest: string }>>(`
      SELECT count(*)::integer AS count,
             md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY to_jsonb(t)::text), '')) AS digest
      FROM public."${table}" t
    `);
    result[table] = { count: Number(row?.count ?? 0), digest: row?.digest ?? "" };
  }
  return result;
}

async function state(connectionString: string) {
  const client = postgres(connectionString, { max: 1, prepare: false, connection: { application_name: "cinashop_api006_short_video_state" } });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '25s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const [summary] = await tx<Array<Record<string, unknown>>>`
        SELECT current_setting('server_version') AS server_version,
          current_setting('transaction_read_only') AS transaction_read_only,
          (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS table_count,
          (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema='public') AS column_count,
          (SELECT count(*)::integer FROM pg_indexes WHERE schemaname='public') AS index_count,
          to_regclass('public.video')::text AS video_table,
          to_regclass('public.video_comment')::text AS video_comment_table,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`}) AS temporary_schemas
      `;
      const columns = await tx<Array<Record<string, unknown>>>`
        SELECT table_name, column_name, data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('video', 'video_comment')
        ORDER BY table_name, ordinal_position
      `;
      const indexes = await tx<Array<Record<string, unknown>>>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname='public' AND tablename IN ('video', 'video_comment')
        ORDER BY tablename, indexname
      `;
      let rows: Record<string, number> = {};
      if (summary?.video_table && summary?.video_comment_table) {
        const [counts] = await tx<Array<{ video: number; video_comment: number }>>`
          SELECT (SELECT count(*)::integer FROM video) AS video,
                 (SELECT count(*)::integer FROM video_comment) AS video_comment
        `;
        rows = { video: Number(counts?.video ?? 0), video_comment: Number(counts?.video_comment ?? 0) };
      }
      return { ...summary, columns, indexes, row_counts: rows };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function applyProductionDdl(connectionString: string) {
  const client = postgres(connectionString, { max: 1, prepare: false, connection: { application_name: "cinashop_api006_short_video_ddl" } });
  const ddl = new MigrationService({} as never).shortVideoCompatibilityMigrationSqlForVerification();
  try {
    const before = await fingerprints(client);
    const runs: string[] = [];
    for (let run = 1; run <= 2; run++) {
      await client.begin(async (tx) => {
        await tx`SET LOCAL search_path TO public`;
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SET LOCAL statement_timeout = '25s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtext('cinashop-api006-short-video-ddl'))`;
        await tx.unsafe(ddl);
      });
      runs.push(`run_${run}_ok`);
    }
    const after = await fingerprints(client);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("business table fingerprints changed during DDL");
    return { runs, public_business_fingerprints_unchanged: true, before, after, state: await state(connectionString) };
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function rejected(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function isolatedScenario(connectionString: string, env: AuditEnv) {
  const root = postgres(connectionString, { max: 2, prepare: false, connection: { application_name: "cinashop_api006_short_video_isolated" } });
  const before = await fingerprints(root);
  const [beforeSchemas] = await root<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`}
  `;
  const schemaName = `${PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let created = false;
  let report: Record<string, unknown> = {};
  let scenarioError: unknown;
  try {
    await root.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '25s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      created = true;
      for (const table of CLONE_TABLES) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      const ddl = new MigrationService({} as never).shortVideoCompatibilityMigrationSqlForVerification();
      await tx.unsafe(ddl);
      await tx.unsafe(ddl);
      await tx.unsafe(`
        INSERT INTO system_config (id, menu_name, value, is_store, status, sort) VALUES
          (1, 'video_func_status', '1', 0, 1, 1),
          (2, 'site_name', 'API006 Video Shop', 0, 1, 1),
          (3, 'wap_login_logo', '/api/assets/3', 0, 1, 1);
        INSERT INTO "user" (uid, nickname, avatar, status, is_del, is_money_level) VALUES
          (100, 'owner', '/api/assets/4', 1, 0, 1),
          (200, 'other', 'https://legacy.example/avatar.jpg', 1, 0, 0);
        INSERT INTO store_product (id, type, relation_id, store_name, price, stock, is_show, is_del, is_verify, is_vip_product) VALUES
          (501, 1, 77, 'visible product', 19.90, 5, 1, 0, 1, 0),
          (502, 0, 0, 'unreviewed product', 29.90, 5, 1, 0, 0, 0);
        INSERT INTO live_room (id, phone, status, live_status, is_show, is_del) VALUES
          (1, 'audit', 1, 101, 1, 0);
        INSERT INTO video (id, type, relation_id, image, "desc", video_url, product_id, is_show, is_recommend, sort, is_verify, comment_num, like_num, add_time, is_del) VALUES
          (10, 1, 77, '/api/assets/1', 'primary', '/api/assets/2', '501,502', 1, 1, 100, 1, 2, 0, 1724904000, 0),
          (11, 0, 0, '', 'unreviewed', '', '', 1, 1, 200, 0, 0, 0, 1724904000, 0),
          (12, 0, 0, 'https://legacy.example/cover.jpg', 'recommend', 'https://legacy.example/video.mp4', '', 1, 1, 50, 1, 0, 0, 1724904000, 0),
          (13, 0, 0, '', 'other video', '', '', 1, 0, 10, 1, 0, 0, 1724904000, 0);
        INSERT INTO video_comment (id, video_id, uid, nickname, avatar, content, pid, like_num, is_del, add_time) VALUES
          (1000, 10, 100, 'owner', '/api/assets/4', 'root', 0, 0, 0, 1724904000),
          (1001, 10, 200, 'other', 'https://legacy.example/avatar.jpg', 'reply', 1000, 0, 0, 1724904000);
        SELECT setval(pg_get_serial_sequence('video', 'id'), 13, true);
        SELECT setval(pg_get_serial_sequence('video_comment', 'id'), 1001, true);
        SELECT setval(pg_get_serial_sequence('user_relation', 'id'), 1, false);
      `);
    });

    const auditEnv = runtimeEnv(env);
    const readDb = createDbFromConnectionString(connectionString, 1, { applicationName: "api006_short_video_read" });
    const read = async <T>(fn: (service: ShortVideoService) => Promise<T>): Promise<T> => {
      const value = await readDb.$client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
        await tx`SET LOCAL statement_timeout = '25s'`;
        return fn(new ShortVideoService(createContainerFromDb(transactionDb(tx, readDb.$client.options)), auditEnv));
      });
      return value as unknown as T;
    };
    const writeDb = createDbFromConnectionString(connectionString, 3, { searchPath: schemaName, applicationName: "api006_short_video_write" });
    const writer = new ShortVideoService(createContainerFromDb(writeDb), auditEnv);
    try {
      const listed = await read((service) => service.list(100, { page: "1", limit: "10" }));
      const recommended = await read((service) => service.list(100, { order_type: "2", page: "1", limit: "10" }));
      const info = await read((service) => service.info(10));
      const products = await read((service) => service.products(0, 10));
      const commentsBefore = await read((service) => service.comments(100, 10, 0, 1, 20));
      const crossVideoReplyRejected = await rejected(() => writer.saveComment(100, 13, 1000, "cross video"));
      const saved = await writer.saveComment(100, 10, 1001, "nested reply");
      const foreignDeleteRejected = await rejected(() => writer.deleteComment(200, saved.id));
      const deleted = await writer.deleteComment(100, saved.id);
      const [toggleA, toggleB] = await Promise.all([
        writer.toggleVideoRelation(100, "like", 10),
        writer.toggleVideoRelation(100, "like", 10),
      ]);
      const commentLike = await writer.toggleCommentRelation(100, "like", 1000);
      await read((service) => service.recordPlays([10], 100));
      const [final] = await root.unsafe<Array<Record<string, unknown>>>(
        `SELECT play_num, like_num, comment_num,
           (SELECT count(*)::integer FROM "${schemaName}".user_relation
            WHERE uid=100 AND relation_id=10 AND type='play' AND category='video') AS play_relation_count
         FROM "${schemaName}".video WHERE id=10`,
      );
      const commentsAfter = await read((service) => service.comments(100, 10, 0, 1, 20));
      const assertions = {
        visibility_and_order: listed.list.map((item) => item.id).join(",") === "10,12,13",
        recommended_filter: recommended.list.map((item) => item.id).join(",") === "10,12",
        private_media_signed: String(listed.list[0]?.image).startsWith("/api/assets/1?expires=")
          && String(listed.list[0]?.video_url).startsWith("/api/assets/2?expires=")
          && listed.list[1]?.image === "https://legacy.example/cover.jpg",
        product_visibility: listed.list[0]?.product_num === 1 && products.count === 1
          && products.list[0]?.store_id === 77 && JSON.stringify(products.list[0]?.promotions) === "{}",
        reviewed_recommendation_only: (info.recommend as { id?: number }).id === 12,
        comment_projection: commentsBefore.length === 1 && commentsBefore[0]?.reply_count === 1
          && commentsBefore[0]?.is_money_level === 1,
        cross_video_reply_rejected: crossVideoReplyRejected,
        nested_reply_flattened: saved.pid === 1000,
        owner_delete_enforced: foreignDeleteRejected && deleted.id === saved.id,
        concurrent_toggle_converged: toggleA.status !== toggleB.status && Number(final?.like_num ?? -1) === 0,
        comment_relation_atomic: commentLike.status === 1 && commentsAfter[0]?.is_like === true,
        play_and_comment_counters_exact: Number(final?.play_num ?? 0) === 1 && Number(final?.comment_num ?? -1) === 2,
        play_relation_recorded: Number(final?.play_relation_count ?? 0) === 1,
      };
      if (Object.values(assertions).some((value) => !value)) throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      report = { assertions, assertion_count: Object.keys(assertions).length };
    } finally {
      await readDb.$client.end({ timeout: 1 });
      await writeDb.$client.end({ timeout: 1 });
    }
  } catch (error) {
    scenarioError = error;
  } finally {
    if (created) {
      await root.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '25s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }
  const after = await fingerprints(root);
  const [afterSchemas] = await root<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`}
  `;
  await root.end({ timeout: 1 });
  if (scenarioError) throw scenarioError;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("public business fingerprints changed");
  if (Number(beforeSchemas?.count ?? 0) !== Number(afterSchemas?.count ?? 0)) throw new Error("temporary schema leaked");
  return {
    ...report,
    schema: schemaName,
    cleanup: "dropped",
    public_state_unchanged: true,
    temporary_schemas_before: Number(beforeSchemas?.count ?? 0),
    temporary_schemas_after: Number(afterSchemas?.count ?? 0),
  };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorized(request, env.AUDIT_TOKEN_SHA256))) return Response.json({ error: "forbidden" }, { status: 403 });
    const path = new URL(request.url).pathname;
    try {
      const result = request.method === "GET" && path === "/state"
        ? await state(env.HYPERDRIVE.connectionString)
        : request.method === "POST" && path === "/isolated"
          ? await isolatedScenario(env.HYPERDRIVE.connectionString, env)
          : request.method === "POST" && path === "/apply"
            ? await applyProductionDdl(env.HYPERDRIVE.connectionString)
            : null;
      if (!result) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      console.error(JSON.stringify({ event: "api006_short_video_audit_failed", error: String(error) }));
      return Response.json({ error: "audit_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
