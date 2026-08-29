import type { MiddlewareHandler } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { AppVariables, Env } from "@/env";
import { systemConfig } from "@/models/schema";
import { jsonRaw } from "@/utils/json";

/** PHP json_decode(..., true) followed by PHP boolean coercion. */
export function legacyStationOpenValue(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    decoded = null;
  }
  if (decoded === null || decoded === false) return false;
  if (typeof decoded === "number") return Number.isFinite(decoded) && decoded !== 0;
  if (typeof decoded === "string") return decoded !== "" && decoded !== "0";
  if (Array.isArray(decoded)) return decoded.length > 0;
  if (typeof decoded === "object") return Object.keys(decoded).length > 0;
  return Boolean(decoded);
}

/** PHP StationOpenMiddleware: an absent value defaults open; only 0/empty closes. */
export function stationOpenMiddleware(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    // Read presence as well as value. SystemConfigService intentionally maps a
    // missing key to "", while PHP distinguishes missing (default open) from
    // a deliberately empty value (closed).
    const rows = await c.get("container").db.select({ value: systemConfig.value })
      .from(systemConfig)
      .where(and(eq(systemConfig.menuName, "station_open"), eq(systemConfig.isStore, 0)))
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id))
      .limit(1);
    if (!legacyStationOpenValue(rows[0]?.value)) {
      c.header("Cache-Control", "no-store");
      return jsonRaw(c, 410010, "站点升级中，请稍候访问");
    }
    await next();
  };
}
