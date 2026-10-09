import postgres from "postgres";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
  AUDIT_EXPIRES_AT: string;
  RUN_MARKER: string;
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

interface IdentityChecks {
  database_ok: boolean;
  current_role_ok: boolean;
  session_role_ok: boolean;
  backend_login_ok: boolean;
  pg16_ok: boolean;
  read_only_ok: boolean;
  repeatable_read_ok: boolean;
}

const DUPLICATE_KEY_ALLOWLIST = new Set([
  "record_No", "sign_give_point", "sign_status", "site_url",
  "system_comment_time", "system_delivery_time",
]);
const MAX_CONFIG_ROWS = 1024;
const EXPECTED_DATABASE = "postgres";
const EXPECTED_ROLE = "cinashop_app_v1";

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorize(request: Request, env: AuditEnv): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  const expiry = Number(env.AUDIT_EXPIRES_AT);
  if (!token || !/^[a-f0-9]{64}$/i.test(env.AUDIT_TOKEN_SHA256 ?? "")
    || !/^[a-f0-9]{64}$/i.test(env.RUN_MARKER ?? "")
    || !/^\d{13}$/.test(env.AUDIT_EXPIRES_AT ?? "")
    || !Number.isSafeInteger(expiry) || Date.now() > expiry) return false;
  const actual = await sha256(token);
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.AUDIT_TOKEN_SHA256)),
  ]);
  const actualBytes = new Uint8Array(actualHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let i = 0; i < actualBytes.length; i++) difference |= actualBytes[i] ^ expectedBytes[i];
  return difference === 0;
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
    if (!(await authorize(request, env))) return response({ error: "forbidden" }, 403);
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/audit" || url.search) {
      return response({ error: "not found" }, 404);
    }

    const client = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 1,
      connection: { application_name: "cinashop_system_config_duplicate_audit" },
    });
    try {
      const report = await client.begin(async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        await tx`SET LOCAL search_path = public, pg_temp`;
        await tx`SET LOCAL lock_timeout = '1s'`;
        await tx`SET LOCAL statement_timeout = '15s'`;
        await tx`SET LOCAL idle_in_transaction_session_timeout = '20s'`;
        const identity = (await tx<IdentityChecks[]>`
          SELECT
            current_database() = ${EXPECTED_DATABASE} AS database_ok,
            current_user = ${EXPECTED_ROLE} AS current_role_ok,
            session_user = ${EXPECTED_ROLE} AS session_role_ok,
            EXISTS (
              SELECT 1
              FROM pg_stat_activity AS activity
              JOIN pg_roles AS backend_role ON backend_role.oid = activity.usesysid
              WHERE activity.pid = pg_backend_pid()
                AND activity.usename = ${EXPECTED_ROLE}
                AND activity.backend_type = 'client backend'
                AND backend_role.rolname = ${EXPECTED_ROLE}
                AND backend_role.rolcanlogin
                AND NOT backend_role.rolsuper
                AND NOT backend_role.rolreplication
                AND NOT backend_role.rolbypassrls
            ) AS backend_login_ok,
            current_setting('server_version_num')::integer >= 160000
              AND current_setting('server_version_num')::integer < 170000 AS pg16_ok,
            current_setting('transaction_read_only') = 'on' AS read_only_ok,
            current_setting('transaction_isolation') = 'repeatable read' AS repeatable_read_ok
        `)[0];
        if (!identity?.database_ok || !identity.current_role_ok || !identity.session_role_ok
          || !identity.backend_login_ok || !identity.pg16_ok || !identity.read_only_ok
          || !identity.repeatable_read_ok) {
          throw new Error("Unexpected database identity");
        }
        const allRows = await tx<ConfigRow[]>`
          SELECT c.id, c.is_store, c.menu_name, c.type, c.input_type, c.config_tab_id,
            c.parameter, c.upload_type, c.required, c.width, c.high, c.value,
            c.info, c."desc" AS description, c.sort, c.status
          FROM public.system_config c
          ORDER BY c.id
          LIMIT ${MAX_CONFIG_ROWS + 1}
        `;
        if (allRows.length > MAX_CONFIG_ROWS) throw new Error("Configuration row cap exceeded");
        const referencingForeignKeys = (await tx<{ count: number }[]>`
          SELECT count(*)::integer AS count
          FROM pg_constraint
          WHERE contype = 'f'
            AND confrelid = 'public.system_config'::regclass
        `)[0]?.count ?? 0;
        const grouped = new Map<string, ConfigRow[]>();
        for (const row of allRows) {
          if (row.is_store !== 0) continue;
          grouped.set(row.menu_name, [...(grouped.get(row.menu_name) ?? []), row]);
        }

        const duplicateGroups = [];
        const keys = [...grouped.keys()].filter((key) => (grouped.get(key)?.length ?? 0) > 1)
          .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        if (keys.some((key) => !DUPLICATE_KEY_ALLOWLIST.has(key))) {
          throw new Error("Unexpected duplicate key");
        }
        for (const key of keys) {
          const groupRows = grouped.get(key)!;
          groupRows.sort((a, b) => b.sort - a.sort || b.id - a.id);
          const winner = groupRows[0];
          if (!winner) continue;
          const values = await Promise.all(groupRows.map(async (row) => ({
            row,
            valueDigest: await sha256(row.value),
            typeDigest: await sha256(row.type),
            inputTypeDigest: await sha256(row.input_type),
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
            values_identical: new Set(values.map((item) => item.valueDigest)).size === 1,
            payloads_identical_except_id: new Set(values.map((item) => item.payloadDigest)).size === 1,
            rows: values.map(({ row, valueDigest, typeDigest, inputTypeDigest, payloadDigest }) => ({
              id: row.id,
              sort: row.sort,
              status: row.status,
              config_tab_id: row.config_tab_id,
              type_sha256: typeDigest,
              input_type_sha256: inputTypeDigest,
              value_kind: valueKind(row.value),
              value_length: row.value.length,
              value_sha256: valueDigest,
              payload_sha256: payloadDigest,
              selected_by_runtime: row.id === winner.id,
              same_value_as_runtime: row.value === winner.value,
              matches_expected_site_url: key === "site_url" && row.value === "https://cinashop-pc.pages.dev",
              matches_placeholder_site_url: key === "site_url" && row.value === "https://cinashop.example.com",
            })),
          });
        }

        return {
          generated_at: new Date().toISOString(),
          run_marker: env.RUN_MARKER,
          identity: {
            expected_role: EXPECTED_ROLE,
            database_ok: identity.database_ok,
            current_role_ok: identity.current_role_ok,
            session_role_ok: identity.session_role_ok,
            backend_login_ok: identity.backend_login_ok,
            pg16_ok: identity.pg16_ok,
            read_only_ok: identity.read_only_ok,
            repeatable_read_ok: identity.repeatable_read_ok,
          },
          table_rows: allRows.length,
          table_sha256: await sha256(JSON.stringify(allRows)),
          duplicate_keys: duplicateGroups.length,
          duplicate_rows: duplicateGroups.reduce((sum, group) => sum + group.row_count, 0),
          extra_rows: duplicateGroups.reduce((sum, group) => sum + group.extra_rows, 0),
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
