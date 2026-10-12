import postgres from "postgres";
import { readSystemConfigCatalog } from "./SystemConfigCatalogRead";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
  AUDIT_EXPIRES_AT: string;
  RUN_MARKER: string;
};

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorized(request: Request, env: AuditEnv): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  const expiry = Number(env.AUDIT_EXPIRES_AT);
  const remainingMs = expiry - Date.now();
  if (!/^[a-f0-9]{64}$/i.test(token)
    || !/^[a-f0-9]{64}$/i.test(env.AUDIT_TOKEN_SHA256 ?? "")
    || !/^[a-f0-9]{64}$/i.test(env.RUN_MARKER ?? "")
    || !/^\d{13}$/.test(env.AUDIT_EXPIRES_AT ?? "")
    || !Number.isSafeInteger(expiry) || remainingMs <= 0 || remainingMs > 600_000) return false;
  const actual = await sha256(token);
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.AUDIT_TOKEN_SHA256)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

const IDENTITY_NAMES = ["database", "currentRole", "sessionRole", "backendLogin",
  "postgres16", "readOnly", "repeatableRead", "primary", "databaseOidPresent"] as const;
const CATALOG_NAMES = ["ordinaryPersistentTable", "exactSixteenColumns", "ownerIsNotApp",
  "noRowSecurity", "noTriggers", "noRules", "noInheritance", "noInboundForeignKeys",
  "idSequenceOwned", "appSelectOnly", "maintenanceCatalogDelete"] as const;

/** Exact public projection; a future query field cannot accidentally escape. */
function safeReport(report: Awaited<ReturnType<typeof readSystemConfigCatalog>>, marker: string) {
  if (report.catalogSafe !== true || report.columnCount !== 16
    || !/^[1-9]\d{0,9}$/.test(report.databaseOid)
    || !/^[a-f0-9]{64}$/.test(report.catalogSha256)
    || typeof report.controlSystemAclExecutable !== "boolean"
    || report.originIdentityVerified !== false || report.readyForDml !== false
    || IDENTITY_NAMES.some((name) => report.identityChecks[name] !== true)
    || CATALOG_NAMES.some((name) => report.checks[name] !== true)) {
    throw new Error("Catalog projection gate failed");
  }
  return {
    runMarker: marker,
    databaseOid: report.databaseOid,
    catalogSha256: report.catalogSha256,
    columnCount: 16,
    identityChecks: Object.fromEntries(IDENTITY_NAMES.map((name) => [name, true])),
    checks: Object.fromEntries(CATALOG_NAMES.map((name) => [name, true])),
    catalogSafe: true,
    controlSystemAclExecutable: report.controlSystemAclExecutable,
    originIdentityVerified: false,
    readyForDml: false,
  };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorized(request, env))) return reply({ error: "forbidden" }, 403);
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/audit" || url.search) {
      return reply({ error: "not found" }, 404);
    }

    let client: ReturnType<typeof postgres> | undefined;
    let report: Awaited<ReturnType<typeof readSystemConfigCatalog>> | undefined;
    let failed = false;
    try {
      client = postgres(env.HYPERDRIVE.connectionString, {
        prepare: false, max: 1,
        connection: { application_name: "cinashop_system_config_catalog_audit" },
      });
      report = await client.begin(async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        await tx`SET LOCAL search_path = pg_catalog, pg_temp`;
        await tx`SET LOCAL lock_timeout = '1s'`;
        await tx`SET LOCAL statement_timeout = '5s'`;
        await tx`SET LOCAL idle_in_transaction_session_timeout = '10s'`;
        return readSystemConfigCatalog(
          async (statement, parameters) => {
            const rows = await tx.unsafe(statement, parameters ? [...parameters] : []);
            return rows as Record<string, unknown>[];
          },
          "postgres", "cinashop_app_v1", "postgres",
        );
      });
    } catch {
      failed = true;
    } finally {
      if (client) {
        try { await client.end({ timeout: 5 }); }
        catch { failed = true; }
      }
    }
    if (failed || !report) return reply({ error: "catalog audit failed" }, 500);
    if (!report.catalogSafe) return reply({ error: "catalog gate failed" }, 409);
    try { return reply(safeReport(report, env.RUN_MARKER)); }
    catch { return reply({ error: "catalog projection failed" }, 500); }
  },
};
