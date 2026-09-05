import postgres from "postgres";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

interface ConfigRow {
  id: number;
  is_store: number;
  menu_name: string;
  type: string;
  input_type: string;
  config_tab_id: number;
  parameter: string;
  upload_type: number;
  required: string;
  width: number;
  high: number;
  value: string;
  info: string;
  description: string;
  sort: number;
  status: number;
}

const SAFE_DISPLAY_KEYS = new Set(["site_url", "sign_give_point", "sign_status"]);
const SECRET_LIKE_KEY = /(secret|token|password|private|api[_-]?key|app[_-]?id|appid|mchid|certificate|cert)/i;

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const actual = await sha256(token);
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

function valueKind(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "empty";
  if (/^(?:0|1|true|false)$/i.test(trimmed)) return "boolean_like";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return "number_like";
  if (/^https:\/\//i.test(trimmed)) return "https_url";
  if (/^[\[{]/.test(trimmed)) return "json_like";
  return "text";
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) return response({ error: "forbidden" }, 403);
    if (request.method !== "GET" || new URL(request.url).pathname !== "/audit") {
      return response({ error: "not found" }, 404);
    }

    const client = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 1,
      connection: { application_name: "cinashop_system_config_duplicate_audit" },
    });
    try {
      const report = await client.begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        await tx`SET LOCAL statement_timeout = '15s'`;
        const rows = await tx<ConfigRow[]>`
          WITH duplicate_keys AS (
            SELECT menu_name
            FROM system_config
            WHERE is_store = 0
            GROUP BY menu_name
            HAVING count(*) > 1
          )
          SELECT c.id, c.is_store, c.menu_name, c.type, c.input_type, c.config_tab_id,
            c.parameter, c.upload_type, c.required, c.width, c.high, c.value,
            c.info, c."desc" AS description, c.sort, c.status
          FROM system_config c
          INNER JOIN duplicate_keys d ON d.menu_name = c.menu_name
          WHERE c.is_store = 0
          ORDER BY c.menu_name, c.sort DESC, c.id DESC
        `;
        const referencingForeignKeys = (await tx<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM pg_constraint
          WHERE contype = 'f'
            AND confrelid = 'public.system_config'::regclass
        `)[0]?.count ?? 0;
        const grouped = new Map<string, ConfigRow[]>();
        for (const row of rows) grouped.set(row.menu_name, [...(grouped.get(row.menu_name) ?? []), row]);

        const duplicateGroups = [];
        for (const [key, groupRows] of grouped) {
          const winner = groupRows[0];
          if (!winner) continue;
          const values = await Promise.all(groupRows.map(async (row) => ({
            row,
            valueDigest: await sha256(row.value),
            payloadDigest: await sha256(JSON.stringify({
              is_store: row.is_store,
              menu_name: row.menu_name,
              type: row.type,
              input_type: row.input_type,
              config_tab_id: row.config_tab_id,
              parameter: row.parameter,
              upload_type: row.upload_type,
              required: row.required,
              width: row.width,
              high: row.high,
              value: row.value,
              info: row.info,
              description: row.description,
              sort: row.sort,
              status: row.status,
            })),
          })));
          duplicateGroups.push({
            key,
            row_count: groupRows.length,
            extra_rows: groupRows.length - 1,
            runtime_selected_id: winner.id,
            runtime_selection_rule: "sort DESC, id DESC",
            secret_like_key: SECRET_LIKE_KEY.test(key),
            values_identical: new Set(values.map((item) => item.valueDigest)).size === 1,
            payloads_identical_except_id: new Set(values.map((item) => item.payloadDigest)).size === 1,
            rows: values.map(({ row, valueDigest, payloadDigest }) => ({
              id: row.id,
              sort: row.sort,
              status: row.status,
              config_tab_id: row.config_tab_id,
              type: row.type,
              input_type: row.input_type,
              value_kind: valueKind(row.value),
              value_length: row.value.length,
              value_sha256: valueDigest,
              payload_sha256: payloadDigest,
              selected_by_runtime: row.id === winner.id,
              same_value_as_runtime: row.value === winner.value,
              display_value: SAFE_DISPLAY_KEYS.has(key) ? row.value.slice(0, 512) : null,
            })),
          });
        }

        return {
          generated_at: new Date().toISOString(),
          database: (await tx<{ version: string }[]>`SELECT current_setting('server_version') AS version`)[0]?.version,
          duplicate_keys: duplicateGroups.length,
          duplicate_rows: rows.length,
          extra_rows: rows.length - duplicateGroups.length,
          referencing_foreign_keys: referencingForeignKeys,
          duplicate_groups: duplicateGroups,
        };
      });
      return response(report);
    } catch {
      return response({ error: "system config duplicate audit failed" }, 500);
    } finally {
      await client.end({ timeout: 5 });
    }
  },
};
