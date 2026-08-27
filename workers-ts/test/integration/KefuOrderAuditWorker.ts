import {
  applyKefuOrderIndexes,
  runKefuOrderPostgresScenario,
} from "./KefuOrderPostgresScenario";

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

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const pathname = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/run", "/apply-indexes"].includes(pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      return Response.json(pathname === "/apply-indexes"
        ? await applyKefuOrderIndexes(env.HYPERDRIVE.connectionString)
        : await runKefuOrderPostgresScenario(env.HYPERDRIVE.connectionString));
    } catch (error) {
      console.error(JSON.stringify({
        event: "kefu_order_audit_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
