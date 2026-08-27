import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { TurnstileService } from "@/services/auth/TurnstileService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

interface ProductionState {
  server_version: string;
  user_rows: number;
  sms_record_rows: number;
  active_duplicate_phone_groups: number;
  temporary_schemas: number;
  user_fingerprint: string;
  sms_record_fingerprint: string;
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

async function state(db: DbClient): Promise<ProductionState> {
  const rows = await db.$client<ProductionState[]>`
    SELECT current_setting('server_version') AS server_version,
      (SELECT count(*)::int FROM public."user") AS user_rows,
      (SELECT count(*)::int FROM public.sms_record) AS sms_record_rows,
      (SELECT count(*)::int FROM (
        SELECT phone FROM public."user"
        WHERE is_del = 0 AND phone <> ''
        GROUP BY phone HAVING count(*) > 1
      ) duplicate_phones) AS active_duplicate_phone_groups,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_turnstile_%')
        AS temporary_schemas,
      (SELECT md5(coalesce(string_agg(
        uid::text || ':' || md5(coalesce(account, '') || ':' || coalesce(phone, '')) || ':' ||
        status::text || ':' || is_del::text,
        '|' ORDER BY uid
      ), '')) FROM public."user") AS user_fingerprint,
      (SELECT md5(coalesce(string_agg(
        id::text || ':' || uid || ':' || md5(coalesce(phone, '')) || ':' ||
        add_time::text || ':' || resultcode::text,
        '|' ORDER BY id
      ), '')) FROM public.sms_record) AS sms_record_fingerprint
  `;
  if (!rows[0]) throw new Error("production Turnstile state returned no row");
  return rows[0];
}

function sameState(left: ProductionState, right: ProductionState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function probeSiteverifyTransport(): Promise<Record<string, unknown>> {
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: "1x0000000000000000000000000000000AA",
        response: "XXXX.DUMMY.TOKEN.XXXX",
        remoteip: "192.0.2.1",
        idempotency_key: crypto.randomUUID(),
      }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text.slice(0, 16 * 1_024)) as Record<string, unknown>;
    } catch {
      // The probe reports only structure, never the provider body.
    }
    return {
      http_status: response.status,
      response_bytes: new TextEncoder().encode(text).byteLength,
      success: parsed.success === true,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : null,
      has_action: typeof parsed.action === "string",
      has_cdata: typeof parsed.cdata === "string",
      has_challenge_time: typeof parsed.challenge_ts === "string",
    };
  } catch (error) {
    return {
      transport_error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
    };
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/audit") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_turnstile_read_only_audit",
    });
    try {
      const before = await state(db);
      let missingConfigError = "";
      try {
        new TurnstileService({} as Env).publicConfig();
      } catch (error) {
        missingConfigError = error instanceof Error ? error.message : String(error);
      }

      const siteverifyProbe = await probeSiteverifyTransport();

      let strictMetadataError = "";
      try {
        await new TurnstileService({
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_EXPECTED_HOSTNAMES: "example.com",
        } as Env).verify(
          "XXXX.DUMMY.TOKEN.XXXX",
          "192.0.2.1",
          "sms_send",
          "0ad785b4-b75f-4cf8-8d5f-5ba0a78db8f3",
        );
      } catch (error) {
        strictMetadataError = error instanceof Error ? error.message : String(error);
      }
      const after = await state(db);
      return Response.json({
        before,
        checks: {
          missing_config_failed_closed: missingConfigError === "人机验证尚未配置",
          siteverify_transport_reached: strictMetadataError === "人机验证用途不匹配，请重试",
          missing_config_error: missingConfigError,
          strict_metadata_error: strictMetadataError,
          production_state_unchanged: sameState(before, after),
        },
        siteverify_probe: siteverifyProbe,
        after,
      }, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "Turnstile production audit failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json({ error: "audit failed" }, { status: 500 });
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
