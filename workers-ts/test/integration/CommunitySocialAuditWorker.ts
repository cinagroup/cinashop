import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import { runCommunitySocialPostgresScenario } from "./CommunitySocialPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const MIGRATION_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "c_author_public_latest"
    ON public."community" ("type", "relation_id", "add_time" DESC, "id" DESC)
    WHERE "status" = 1 AND "is_verify" = 1 AND "is_del" = 0`,
  `CREATE INDEX IF NOT EXISTS "cu_recommend_rank"
    ON public."community_user" ("fans_num" DESC, "id" DESC)
    WHERE "status" = 1 AND "is_del" = 0 AND "community_num" > 0`,
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

function authorIndexValid(definition: string | null): boolean {
  const value = normalizedIndex(definition);
  return value.includes(
    "createindexc_author_public_latestonpublic.communityusingbtreetype,relation_id,add_timedesc,iddescwhere",
  ) && value.includes("status=1") && value.includes("is_verify=1") && value.includes("is_del=0");
}

function recommendIndexValid(definition: string | null): boolean {
  const value = normalizedIndex(definition);
  return value.includes(
    "createindexcu_recommend_rankonpublic.community_userusingbtreefans_numdesc,iddescwhere",
  ) && value.includes("status=1") && value.includes("is_del=0") && value.includes("community_num>0");
}

async function businessSnapshot(db: DbClient) {
  const rows = await db.$client<Array<{
    community_rows: string;
    community_play_total: string;
    profile_rows: string;
    profile_follow_total: string;
    profile_fans_total: string;
    relevance_rows: string;
    friend_rows: string;
  }>>`
    SELECT
      (SELECT count(*)::text FROM public.community) AS community_rows,
      (SELECT COALESCE(sum(play_num), 0)::text FROM public.community) AS community_play_total,
      (SELECT count(*)::text FROM public.community_user) AS profile_rows,
      (SELECT COALESCE(sum(follow_num), 0)::text FROM public.community_user) AS profile_follow_total,
      (SELECT COALESCE(sum(fans_num), 0)::text FROM public.community_user) AS profile_fans_total,
      (SELECT count(*)::text FROM public.community_relevance) AS relevance_rows,
      (SELECT count(*)::text FROM public.user_friends) AS friend_rows
  `;
  if (!rows[0]) throw new Error("community business snapshot returned no row");
  return rows[0];
}

async function currentState(db: DbClient) {
  const rows = await db.$client<Array<{
    server_version: string;
    users: number;
    active_users: number;
    profiles: number;
    active_profiles: number;
    platform_profiles: number;
    user_profiles: number;
    visible_posts: number;
    interest_rows: number;
    interest_pairs: number;
    browse_rows: number;
    friend_rows: number;
    duplicate_profile_groups: number;
    duplicate_profile_extra_rows: number;
    duplicate_interest_groups: number;
    duplicate_interest_extra_rows: number;
    temporary_schemas: number;
    author_index: string | null;
    recommend_index: string | null;
  }>>`
    WITH duplicate_profiles AS (
      SELECT type, relation_id, count(*)::int AS rows
      FROM public.community_user
      WHERE is_del = 0
      GROUP BY type, relation_id HAVING count(*) > 1
    ), duplicate_interests AS (
      SELECT left_id, right_id, type, count(*)::int AS rows
      FROM public.community_relevance
      WHERE type = 'community_interest'
      GROUP BY left_id, right_id, type HAVING count(*) > 1
    )
    SELECT current_setting('server_version') AS server_version,
      (SELECT count(*)::int FROM public."user") AS users,
      (SELECT count(*)::int FROM public."user" WHERE status = 1 AND is_del = 0) AS active_users,
      (SELECT count(*)::int FROM public.community_user) AS profiles,
      (SELECT count(*)::int FROM public.community_user WHERE status = 1 AND is_del = 0)
        AS active_profiles,
      (SELECT count(*)::int FROM public.community_user WHERE type = 0 AND relation_id = 0 AND is_del = 0)
        AS platform_profiles,
      (SELECT count(*)::int FROM public.community_user WHERE type = 2 AND is_del = 0)
        AS user_profiles,
      (SELECT count(*)::int FROM public.community WHERE status = 1 AND is_verify = 1 AND is_del = 0)
        AS visible_posts,
      (SELECT count(*)::int FROM public.community_relevance WHERE type = 'community_interest')
        AS interest_rows,
      (SELECT count(DISTINCT (left_id, right_id))::int FROM public.community_relevance
        WHERE type = 'community_interest') AS interest_pairs,
      (SELECT count(*)::int FROM public.community_relevance WHERE type = 'community_browse')
        AS browse_rows,
      (SELECT count(*)::int FROM public.user_friends) AS friend_rows,
      (SELECT count(*)::int FROM duplicate_profiles) AS duplicate_profile_groups,
      (SELECT COALESCE(sum(rows - 1), 0)::int FROM duplicate_profiles) AS duplicate_profile_extra_rows,
      (SELECT count(*)::int FROM duplicate_interests) AS duplicate_interest_groups,
      (SELECT COALESCE(sum(rows - 1), 0)::int FROM duplicate_interests)
        AS duplicate_interest_extra_rows,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_community_social_%')
        AS temporary_schemas,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'community' AND indexname = 'c_author_public_latest') AS author_index,
      (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'community_user' AND indexname = 'cu_recommend_rank') AS recommend_index
  `;
  const state = rows[0];
  if (!state) throw new Error("community social state query returned no row");
  return {
    ...state,
    author_index_valid: authorIndexValid(state.author_index),
    recommend_index_valid: recommendIndexValid(state.recommend_index),
    migration_valid: authorIndexValid(state.author_index) && recommendIndexValid(state.recommend_index),
  };
}

async function applyMigration(db: DbClient) {
  const before = await currentState(db);
  if (before.author_index && !before.author_index_valid) {
    throw new Error("existing c_author_public_latest definition is incompatible");
  }
  if (before.recommend_index && !before.recommend_index_valid) {
    throw new Error("existing cu_recommend_rank definition is incompatible");
  }
  const businessBefore = await businessSnapshot(db);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '20s'`;
    for (const statement of MIGRATION_STATEMENTS) await tx.unsafe(statement);
  });
  const [after, businessAfter] = await Promise.all([currentState(db), businessSnapshot(db)]);
  if (!after.migration_valid) throw new Error("community social index migration verification failed");
  const unchanged = JSON.stringify(businessBefore) === JSON.stringify(businessAfter);
  if (!unchanged) throw new Error("business row snapshot changed while applying community indexes");
  return { before, after, business_rows_unchanged: unchanged };
}

async function cleanupTemporarySchemas(db: DbClient) {
  const rows = await db.$client<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'codex_community_social_%'
    ORDER BY nspname
  `;
  for (const row of rows) {
    if (!/^codex_community_social_[a-z0-9_]+$/.test(row.nspname)) {
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
    WHERE nspname LIKE 'codex_community_social_%'
  `;
  if (remaining[0]?.count !== 0) throw new Error("temporary schema cleanup did not converge");
  return { removed: rows.map((row) => row.nspname), remaining: 0 };
}

async function liveState(db: DbClient) {
  const rows = await db.$client<Array<{
    observed_at: string;
    community_rows: string;
    profile_rows: string;
    relevance_rows: string;
    friend_rows: string;
    temporary_schemas: string;
    target_indexes: string;
  }>>`
    SELECT clock_timestamp()::text AS observed_at,
      (SELECT count(*)::text FROM public.community WHERE random() >= 0) AS community_rows,
      (SELECT count(*)::text FROM public.community_user WHERE random() >= 0) AS profile_rows,
      (SELECT count(*)::text FROM public.community_relevance WHERE random() >= 0) AS relevance_rows,
      (SELECT count(*)::text FROM public.user_friends WHERE random() >= 0) AS friend_rows,
      (SELECT count(*)::text FROM pg_namespace
        WHERE nspname LIKE 'codex_community_social_%' AND random() >= 0) AS temporary_schemas,
      (SELECT count(*)::text FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('c_author_public_latest', 'cu_recommend_rank') AND random() >= 0)
        AS target_indexes
  `;
  return rows[0];
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !new Set([
      "/state", "/apply", "/run", "/cleanup-schemas", "/live-state",
    ]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_community_social_audit",
    });
    try {
      if (path === "/state") return Response.json(await currentState(db));
      if (path === "/apply") return Response.json(await applyMigration(db));
      if (path === "/cleanup-schemas") return Response.json(await cleanupTemporarySchemas(db));
      if (path === "/live-state") return Response.json(await liveState(db));
      const state = await currentState(db);
      if (!state.migration_valid) throw new Error("community social index migration is not applied");
      const scenario = await runCommunitySocialPostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ state, scenario, after: await currentState(db) });
    } catch (error) {
      console.error("[community-social-audit] failed", error instanceof Error ? error.name : "unknown");
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
