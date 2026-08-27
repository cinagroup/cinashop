import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import { runCommunityAdminPostgresScenario } from "./CommunityAdminPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const MIGRATION_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "c_admin_moderation"
    ON public."community" ("is_verify", "type", "content_type", "add_time" DESC, "id" DESC)
    WHERE "is_del" = 0`,
  `CREATE INDEX IF NOT EXISTS "cc_admin_moderation"
    ON public."community_comment" ("is_reply", "is_verify", "is_show", "community_id", "add_time" DESC, "id" DESC)
    WHERE "is_del" = 0`,
  `CREATE INDEX IF NOT EXISTS "ct_admin_catalog"
    ON public."community_topic" ("status", "is_recommend", "sort" DESC, "id" DESC)
    WHERE "is_del" = 0`,
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
  if (!value.includes(`createindex${name}onpublic.`) || !value.includes("whereis_del=0")) return false;
  if (name === "c_admin_moderation") {
    return value.includes("communityusingbtreeis_verify,type,content_type,add_timedesc,iddesc");
  }
  if (name === "cc_admin_moderation") {
    return value.includes("community_commentusingbtreeis_reply,is_verify,is_show,community_id,add_timedesc,iddesc");
  }
  return value.includes("community_topicusingbtreestatus,is_recommend,sortdesc,iddesc");
}

async function businessSnapshot(db: DbClient) {
  const rows = await db.$client.unsafe<Array<Record<string, string>>>(`
    SELECT
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community t) AS community,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_comment t) AS comments,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_topic t) AS topics,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_relevance t) AS relevance,
      (SELECT count(*)::text || ':' || md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) FROM public.community_user t) AS profiles
  `);
  if (!rows[0]) throw new Error("community admin business snapshot returned no row");
  return rows[0];
}

async function currentState(db: DbClient) {
  const rows = await db.$client<Array<{
    server_version: string;
    community_rows: number;
    comment_rows: number;
    topic_rows: number;
    profile_rows: number;
    relevance_rows: number;
    visible_posts: number;
    visible_comments: number;
    temporary_schemas: number;
    c_index: string | null;
    cc_index: string | null;
    ct_index: string | null;
  }>>`
    SELECT current_setting('server_version') AS server_version,
      (SELECT count(*)::int FROM public.community) AS community_rows,
      (SELECT count(*)::int FROM public.community_comment) AS comment_rows,
      (SELECT count(*)::int FROM public.community_topic) AS topic_rows,
      (SELECT count(*)::int FROM public.community_user) AS profile_rows,
      (SELECT count(*)::int FROM public.community_relevance) AS relevance_rows,
      (SELECT count(*)::int FROM public.community WHERE status = 1 AND is_verify = 1 AND is_del = 0)
        AS visible_posts,
      (SELECT count(*)::int FROM public.community_comment
        WHERE is_show = 1 AND is_verify = 1 AND is_del = 0) AS visible_comments,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_community_admin_%')
        AS temporary_schemas,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'community' AND indexname = 'c_admin_moderation') AS c_index,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'community_comment' AND indexname = 'cc_admin_moderation') AS cc_index,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'community_topic' AND indexname = 'ct_admin_catalog') AS ct_index
  `;
  const state = rows[0];
  if (!state) throw new Error("community admin state query returned no row");
  const index_validity = {
    c_admin_moderation: indexValid("c_admin_moderation", state.c_index),
    cc_admin_moderation: indexValid("cc_admin_moderation", state.cc_index),
    ct_admin_catalog: indexValid("ct_admin_catalog", state.ct_index),
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
    ["c_admin_moderation", before.c_index],
    ["cc_admin_moderation", before.cc_index],
    ["ct_admin_catalog", before.ct_index],
  ] as const) {
    if (definition && !indexValid(name, definition)) throw new Error(`existing ${name} definition is incompatible`);
  }
  const businessBefore = await businessSnapshot(db);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '20s'`;
    for (const statement of MIGRATION_STATEMENTS) await tx.unsafe(statement);
  });
  const [after, businessAfter] = await Promise.all([currentState(db), businessSnapshot(db)]);
  if (!after.migration_valid) throw new Error("community admin index migration verification failed");
  const unchanged = JSON.stringify(businessBefore) === JSON.stringify(businessAfter);
  if (!unchanged) throw new Error("business row snapshot changed while applying community admin indexes");
  return { before, after, business_rows_unchanged: unchanged };
}

async function cleanupTemporarySchemas(db: DbClient) {
  const rows = await db.$client<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'codex_community_admin_%'
    ORDER BY nspname
  `;
  for (const row of rows) {
    if (!/^codex_community_admin_[a-z0-9_]+$/.test(row.nspname)) {
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
    WHERE nspname LIKE 'codex_community_admin_%'
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
      applicationName: "cinashop_community_admin_audit",
    });
    try {
      if (path === "/state") return Response.json(await currentState(db));
      if (path === "/apply") return Response.json(await applyMigration(db));
      if (path === "/cleanup-schemas") return Response.json(await cleanupTemporarySchemas(db));
      const state = await currentState(db);
      if (!state.migration_valid) throw new Error("community admin index migration is not applied");
      const scenario = await runCommunityAdminPostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ state, scenario, after: await currentState(db) });
    } catch (error) {
      console.error("[community-admin-audit] failed", error instanceof Error ? error.name : "unknown");
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
