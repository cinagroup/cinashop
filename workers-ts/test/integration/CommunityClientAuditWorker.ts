import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import { runCommunityClientPostgresScenario } from "./CommunityClientPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const MIGRATION_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "cc_public_replies"
    ON public."community_comment" ("reply_id", "add_time", "id")
    WHERE "is_reply" = 0 AND "is_del" = 0 AND "is_show" = 1 AND "is_verify" = 1`,
  `CREATE INDEX IF NOT EXISTS "spl_user_source_latest"
    ON public."store_product_log" ("uid", "type", "add_time" DESC, "product_id")`,
  `CREATE INDEX IF NOT EXISTS "ur_user_product_collect_latest"
    ON public."user_relation" ("uid", "add_time" DESC, "id" DESC, "relation_id")
    WHERE "type" = 'collect' AND "category" = 'product'`,
] as const;

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

function normalizedIndex(definition: string | null): string {
  return (definition ?? "").toLowerCase().replace(/["\s()]/g, "");
}

function indexValid(name: string, definition: string | null): boolean {
  const value = normalizedIndex(definition);
  if (!value.includes(`createindex${name}onpublic.`)) return false;
  if (name === "cc_public_replies") {
    return value.includes("community_commentusingbtreereply_id,add_time,id")
      && value.includes("whereis_reply=0andis_del=0andis_show=1andis_verify=1");
  }
  if (name === "spl_user_source_latest") {
    return value.includes("store_product_logusingbtreeuid,type,add_timedesc,product_id")
      && !value.includes("where");
  }
  const collectPredicate = (
    value.includes("type::text='collect'::text")
    || value.includes("type='collect'::charactervarying")
  ) && (
    value.includes("category::text='product'::text")
    || value.includes("category='product'::charactervarying")
  );
  return value.includes("user_relationusingbtreeuid,add_timedesc,iddesc,relation_id")
    && value.includes("where")
    && collectPredicate;
}

async function businessSnapshot(db: DbClient) {
  const rows = await db.$client.unsafe<Array<Record<string, string>>>(`
    SELECT
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public."user" t) AS users,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_user t) AS profiles,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community t) AS community,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_comment t) AS comments,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_topic t) AS topics,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_relevance t) AS relevance,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.store_product t) AS products,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.store_product_log t) AS product_logs,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.user_relation t) AS user_relations
  `);
  if (!rows[0]) throw new Error("community client business snapshot returned no row");
  return rows[0];
}

async function currentState(db: DbClient) {
  const rows = await db.$client<Array<{
    server_version: string;
    community_rows: number;
    comment_rows: number;
    topic_rows: number;
    relevance_rows: number;
    product_log_rows: number;
    user_relation_rows: number;
    visible_posts: number;
    visible_comments: number;
    temporary_schemas: number;
    cc_index: string | null;
    spl_index: string | null;
    ur_index: string | null;
  }>>`
    SELECT current_setting('server_version') AS server_version,
      (SELECT count(*)::int FROM public.community) AS community_rows,
      (SELECT count(*)::int FROM public.community_comment) AS comment_rows,
      (SELECT count(*)::int FROM public.community_topic) AS topic_rows,
      (SELECT count(*)::int FROM public.community_relevance) AS relevance_rows,
      (SELECT count(*)::int FROM public.store_product_log) AS product_log_rows,
      (SELECT count(*)::int FROM public.user_relation) AS user_relation_rows,
      (SELECT count(*)::int FROM public.community WHERE status = 1 AND is_verify = 1 AND is_del = 0)
        AS visible_posts,
      (SELECT count(*)::int FROM public.community_comment
        WHERE is_show = 1 AND is_verify = 1 AND is_del = 0) AS visible_comments,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_community_client_%')
        AS temporary_schemas,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'community_comment' AND indexname = 'cc_public_replies') AS cc_index,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'store_product_log' AND indexname = 'spl_user_source_latest') AS spl_index,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'user_relation' AND indexname = 'ur_user_product_collect_latest') AS ur_index
  `;
  const state = rows[0];
  if (!state) throw new Error("community client state query returned no row");
  const index_validity = {
    cc_public_replies: indexValid("cc_public_replies", state.cc_index),
    spl_user_source_latest: indexValid("spl_user_source_latest", state.spl_index),
    ur_user_product_collect_latest: indexValid("ur_user_product_collect_latest", state.ur_index),
  };
  return {
    ...state,
    index_validity,
    migration_valid: Object.values(index_validity).every(Boolean),
  };
}

async function applyMigration(db: DbClient) {
  const before = await currentState(db);
  for (const [name, definition] of [
    ["cc_public_replies", before.cc_index],
    ["spl_user_source_latest", before.spl_index],
    ["ur_user_product_collect_latest", before.ur_index],
  ] as const) {
    if (definition && !indexValid(name, definition)) {
      throw new Error(`existing ${name} definition is incompatible`);
    }
  }
  const businessBefore = await businessSnapshot(db);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '20s'`;
    for (const statement of MIGRATION_STATEMENTS) await tx.unsafe(statement);
  });
  const [after, businessAfter] = await Promise.all([currentState(db), businessSnapshot(db)]);
  if (!after.migration_valid) throw new Error("community client index migration verification failed");
  const unchanged = JSON.stringify(businessBefore) === JSON.stringify(businessAfter);
  if (!unchanged) throw new Error("business row snapshot changed while applying community client indexes");
  return { before, after, business_rows_unchanged: unchanged };
}

async function cleanupTemporarySchemas(db: DbClient) {
  const rows = await db.$client<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'codex_community_client_%'
    ORDER BY nspname
  `;
  for (const row of rows) {
    if (!/^codex_community_client_[a-z0-9_]+$/.test(row.nspname)) {
      throw new Error("temporary schema name failed the cleanup guard");
    }
  }
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    for (const row of rows) await tx.unsafe(`DROP SCHEMA "${row.nspname}" CASCADE`);
  });
  const remaining = await db.$client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_namespace
    WHERE nspname LIKE 'codex_community_client_%'
  `;
  if (remaining[0]?.count !== 0) throw new Error("temporary schema cleanup did not converge");
  return { removed: rows.map((row) => row.nspname), remaining: 0 };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !new Set([
      "/state", "/apply", "/run", "/cleanup-schemas",
    ]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_community_client_audit",
    });
    try {
      if (path === "/state") return Response.json(await currentState(db));
      if (path === "/apply") return Response.json(await applyMigration(db));
      if (path === "/cleanup-schemas") return Response.json(await cleanupTemporarySchemas(db));
      const state = await currentState(db);
      if (!state.migration_valid) throw new Error("community client index migration is not applied");
      const scenario = await runCommunityClientPostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ state, scenario, after: await currentState(db) });
    } catch (error) {
      console.error(JSON.stringify({
        message: "community client audit failed",
        error: error instanceof Error ? error.message : String(error),
        path,
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
