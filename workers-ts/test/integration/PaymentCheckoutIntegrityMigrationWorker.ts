import postgres from "postgres";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

const EXPECTED_INDEXES = ["ur_order_id_lookup", "ur_uid", "ur_uid_paid_time"] as const;

async function indexSnapshot(client: postgres.Sql, auditNonce = crypto.randomUUID()) {
  return client<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'user_recharge'
      AND indexname IN ('ur_order_id_lookup', 'ur_uid', 'ur_uid_paid_time')
      AND ${auditNonce} = ${auditNonce}
    ORDER BY indexname
  `;
}

async function snapshot(client: postgres.Sql) {
  const auditNonce = crypto.randomUUID();
  const [rechargeRows, indexRows, catalogRows] = await Promise.all([
    client<{
      total: string;
      paid: string;
      duplicate_order_ids: string;
      total_price: string;
      total_give_price: string;
    }[]>`
      SELECT
        count(*)::text AS total,
        count(*) FILTER (WHERE paid = 1)::text AS paid,
        (count(*) - count(DISTINCT order_id))::text AS duplicate_order_ids,
        coalesce(sum(price), 0)::text AS total_price,
        coalesce(sum(give_price), 0)::text AS total_give_price
      FROM public.user_recharge
      WHERE ${auditNonce} = ${auditNonce}
    `,
    indexSnapshot(client, auditNonce),
    client<{ schema_name: string; relation_name: string; relation_kind: string }[]>`
      SELECT n.nspname AS schema_name, c.relname AS relation_name, c.relkind::text AS relation_kind
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname IN ('ur_order_id_lookup', 'ur_uid', 'ur_uid_paid_time')
        AND ${auditNonce} = ${auditNonce}
      ORDER BY n.nspname, c.relname
    `,
  ]);
  return { recharge: rechargeRows[0], indexes: indexRows, catalog: catalogRows };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const url = new URL(request.url);
    if (!(["GET", "POST"].includes(request.method))) {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    if (url.pathname !== "/status" && url.pathname !== "/apply") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.pathname === "/apply" && request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    const client = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 1,
      connection: { application_name: "cinashop_payment_integrity_migration" },
    });
    try {
      const before = await snapshot(client);
      let transactionIndexes: { indexname: string; indexdef: string }[] = [];
      if (url.pathname === "/apply") {
        await client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '2s'`;
          await tx`SET LOCAL statement_timeout = '10s'`;
          await tx`CREATE INDEX IF NOT EXISTS ur_order_id_lookup ON public.user_recharge (order_id)`;
          await tx`CREATE INDEX IF NOT EXISTS ur_uid ON public.user_recharge (uid)`;
          await tx`CREATE INDEX IF NOT EXISTS ur_uid_paid_time ON public.user_recharge (uid, paid, add_time, id)`;
          transactionIndexes = await tx<{ indexname: string; indexdef: string }[]>`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'user_recharge'
              AND indexname IN ('ur_order_id_lookup', 'ur_uid', 'ur_uid_paid_time')
            ORDER BY indexname
          `;
          if (transactionIndexes.length !== EXPECTED_INDEXES.length) {
            throw new Error("充值索引在提交前不可见，事务已回滚");
          }
        });
      }
      const after = await snapshot(client);
      const exactIndexSet = EXPECTED_INDEXES.every((name) =>
        after.indexes.some((index) => index.indexname === name),
      ) && after.indexes.length === EXPECTED_INDEXES.length;
      return Response.json({
        applied: url.pathname === "/apply",
        before,
        after,
        transaction_indexes: transactionIndexes,
        business_snapshot_unchanged:
          JSON.stringify(before.recharge) === JSON.stringify(after.recharge),
        exact_index_set_present: exactIndexSet,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
