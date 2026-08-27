import {
  cleanupMembershipAudit,
  runMembershipAudit,
  setupMembershipAudit,
  verifyMembershipAudit,
} from "./AdminPaidMembershipPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_SCHEMA: string;
  AUDIT_KEY: string;
  AUDIT_TOKEN_SHA256: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) return json({ error: "forbidden" }, 403);
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/setup") {
        return json(await setupMembershipAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "POST" && path === "/run") {
        return json(await runMembershipAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "GET" && path === "/verify") {
        return json(await verifyMembershipAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      if (request.method === "POST" && path === "/cleanup") {
        return json(await cleanupMembershipAudit(
          env.HYPERDRIVE.connectionString,
          env.AUDIT_SCHEMA,
          env.AUDIT_KEY,
        ));
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
} satisfies ExportedHandler<AuditEnv>;
