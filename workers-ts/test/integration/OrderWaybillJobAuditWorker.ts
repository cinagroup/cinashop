import { createDbFromConnectionString } from "@/lib/di";
import {
  productionWaybillState,
  runOrderWaybillJobPostgresScenario,
} from "./OrderWaybillJobPostgresScenario";

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
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !new Set(["/state", "/run"]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      if (path === "/run") {
        return Response.json(await runOrderWaybillJobPostgresScenario(
          env.HYPERDRIVE.connectionString,
        ));
      }
      const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
        applicationName: "cinashop_waybill_audit_state",
      });
      try {
        return Response.json(await productionWaybillState(db));
      } finally {
        await db.$client.end({ timeout: 1 });
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "order_waybill_audit_failed",
        path,
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, {
        status: 500,
      });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
