import { createDbFromConnectionString } from "@/lib/di";
import {
  AGREEMENT_CACHE_KEYS,
  KF_ADV_CACHE_KEY,
  OPEN_ADV_CACHE_KEY,
  UNI_APP_URL_CACHE_KEY,
} from "@/services/system/LegacyContentService";
import { runLegacyContentPostgresScenario } from "./LegacyContentPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

interface CacheRow {
  key: string;
  result: string | null;
  expire_time: number;
  add_time: number;
}

function jsonValid(value: string | null): boolean {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
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

async function currentState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_legacy_content_current_audit",
  });
  try {
    const now = Math.floor(Date.now() / 1_000);
    const fixedKeys = [
      KF_ADV_CACHE_KEY,
      OPEN_ADV_CACHE_KEY,
      UNI_APP_URL_CACHE_KEY,
      ...AGREEMENT_CACHE_KEYS,
      "newcomer_agreement",
    ];
    const [version, fixed, drafts, uploadRows, groups] = await Promise.all([
      db.$client<{ server_version: string }[]>`
        SELECT current_setting('server_version') AS server_version
      `,
      db.$client<CacheRow[]>`
        SELECT key, result, expire_time, add_time
        FROM cache
        WHERE key = ANY(${fixedKeys})
        ORDER BY key
      `,
      db.$client<CacheRow[]>`
        SELECT key, result, expire_time, add_time
        FROM cache
        WHERE key ~ '^[0-9]+_product_data$'
        ORDER BY key
      `,
      db.$client<Array<{ expire_time: number; result_bytes: number }>>`
        SELECT expire_time, octet_length(COALESCE(result, ''))::int AS result_bytes
        FROM cache
        WHERE key = 'scan_upload' OR key LIKE '%\_supplier\_scan\_upload' ESCAPE '\'
      `,
      db.$client<Array<{ status: number; value: string | null }>>`
        SELECT d.status, d.value
        FROM system_group g
        LEFT JOIN system_group_data d ON d.gid = g.id
        WHERE g.config_name = 'uni_app_link'
        ORDER BY d.sort DESC, d.id
      `,
    ]);

    const byKey = new Map(fixed.map((row) => [row.key, row]));
    const fixedMetadata = fixedKeys.map((key) => {
      const row = byKey.get(key);
      return {
        key,
        present: Boolean(row),
        json_valid: row ? jsonValid(row.result) : null,
        result_bytes: row ? new TextEncoder().encode(row.result ?? "").byteLength : 0,
        expiry: !row ? "missing" : row.expire_time === 0 ? "permanent" : row.expire_time >= now ? "active" : "expired",
      };
    });
    const summarizeRows = (rows: CacheRow[]) => ({
      rows: rows.length,
      active_rows: rows.filter((row) => row.expire_time === 0 || row.expire_time >= now).length,
      expired_rows: rows.filter((row) => row.expire_time !== 0 && row.expire_time < now).length,
      valid_json_rows: rows.filter((row) => jsonValid(row.result)).length,
      total_result_bytes: rows.reduce(
        (total, row) => total + new TextEncoder().encode(row.result ?? "").byteLength,
        0,
      ),
    });
    return {
      server_version: version[0]?.server_version ?? "unknown",
      fixed_cache_metadata: fixedMetadata,
      product_drafts: summarizeRows(drafts),
      legacy_scan_upload: {
        rows: uploadRows.length,
        active_rows: uploadRows.filter((row) => row.expire_time === 0 || row.expire_time >= now).length,
        expired_rows: uploadRows.filter((row) => row.expire_time !== 0 && row.expire_time < now).length,
        total_result_bytes: uploadRows.reduce((total, row) => total + row.result_bytes, 0),
      },
      uni_app_link_group: {
        group_present: groups.length > 0,
        data_rows: groups.filter((row) => row.value !== null).length,
        active_rows: groups.filter((row) => row.value !== null && row.status === 1).length,
        valid_json_rows: groups.filter((row) => row.value !== null && jsonValid(row.value)).length,
      },
    };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const current = await currentState(env.HYPERDRIVE.connectionString);
      const scenario = await runLegacyContentPostgresScenario(env.HYPERDRIVE.connectionString);
      return Response.json({ current, scenario });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
