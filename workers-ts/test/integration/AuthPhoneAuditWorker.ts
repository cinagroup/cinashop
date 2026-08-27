import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import { runAuthPhonePostgresScenario } from "./AuthPhonePostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
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

async function state(db: DbClient) {
  const rows = await db.$client<{
    server_version: string;
    user_rows: number;
    active_duplicate_phone_groups: number;
    temporary_schemas: number;
    audit_fixture_rows: number;
    audit_wechat_rows: number;
  }[]>`
    SELECT current_setting('server_version') AS server_version,
      (SELECT count(*)::int FROM public."user") AS user_rows,
      (SELECT count(*)::int FROM (
        SELECT phone FROM public."user"
        WHERE is_del = 0 AND phone <> ''
        GROUP BY phone HAVING count(*) > 1
      ) duplicate_phones) AS active_duplicate_phone_groups,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_auth_phone_%')
        AS temporary_schemas,
      (SELECT count(*)::int FROM public."user"
        WHERE uid = ANY(ARRAY[1801000001,1801000002,1801000003,1801000004,1801000005,1801000006,1801000007,1801000008,1801000014,1801000015])
          AND nickname = 'audit-' || uid::text
          AND pwd = md5('audit-Password-9')) AS audit_fixture_rows,
      (SELECT count(*)::int FROM public.wechat_user
        WHERE openid LIKE 'audit-%-openid' OR unionid = 'audit-union-1') AS audit_wechat_rows
  `;
  if (!rows[0]) throw new Error("auth phone state returned no row");
  return rows[0];
}

async function cleanup(db: DbClient) {
  const rows = await db.$client<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'codex_auth_phone_%'
    ORDER BY nspname
  `;
  for (const row of rows) {
    if (!/^codex_auth_phone_[a-z0-9_]+$/.test(row.nspname)) {
      throw new Error("temporary schema cleanup guard rejected a name");
    }
  }
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    for (const row of rows) await tx.unsafe(`DROP SCHEMA "${row.nspname}" CASCADE`);
  });
  return { removed: rows.map((row) => row.nspname), remaining: (await state(db)).temporary_schemas };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !new Set([
      "/state", "/run", "/cleanup-schemas",
    ]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_auth_phone_audit",
    });
    try {
      if (path === "/state") return Response.json(await state(db));
      if (path === "/cleanup-schemas") return Response.json(await cleanup(db));
      return Response.json({
        before: await state(db),
        scenario: await runAuthPhonePostgresScenario(env.HYPERDRIVE.connectionString),
        after: await state(db),
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "auth phone audit failed",
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
