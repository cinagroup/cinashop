import { createDbFromConnectionString } from "@/lib/di";
import { auditProductionObservability } from "@/migrations/auditProductionObservability";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
  AUDIT_EXPIRES_AT: string;
}

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
};

async function authorize(request: Request, env: AuditEnv): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  const expiry = Number(env.AUDIT_EXPIRES_AT);
  const remaining = expiry - Date.now();
  if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256 ?? "")
    || !/^\d{13}$/.test(env.AUDIT_EXPIRES_AT ?? "") || !Number.isSafeInteger(expiry)
    || remaining <= 0 || remaining > 10 * 60_000) return false;
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const expected = Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!, byte => Number.parseInt(byte, 16));
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

type Stage = "connect" | "sample" | "close";

function category(error: unknown): "permission" | "lock" | "timeout" | "connection" | "other" {
  let code: unknown;
  try { code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined; }
  catch { return "other"; }
  if (code === "42501") return "permission";
  if (code === "55P03") return "lock";
  if (code === "57014") return "timeout";
  if (typeof code === "string" && /^08[0-9A-Z]{3}$/.test(code)) return "connection";
  return "other";
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env))) {
      return Response.json({ error: "forbidden" }, { status: 403, headers });
    }
    const url = new URL(request.url);
    if (url.pathname !== "/observability" || url.search || url.hash) {
      return Response.json({ error: "not found" }, { status: 404, headers });
    }
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" },
        { status: 405, headers: { ...headers, Allow: "GET" } });
    }

    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    let stage: Stage = "connect";
    try {
      db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
        applicationName: "cinashop_observability_audit",
      });
      stage = "sample";
      const result = await auditProductionObservability(db.$client,
        { role: "cinashop_app_v1", database: "postgres" });
      stage = "close";
      await db.$client.end({ timeout: 1 });
      db = undefined;
      return Response.json(result, { headers });
    } catch (error) {
      return Response.json({ error: "audit failed", stage, category: category(error) },
        { status: 503, headers });
    } finally {
      if (db) {
        try { await db.$client.end({ timeout: 1 }); }
        catch { /* A failed close is an operational failure; the caller must not publish this receipt. */ }
      }
    }
  },
} satisfies ExportedHandler<AuditEnv>;
