import type { MiddlewareHandler } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { AppVariables, Env } from "@/env";
import type { Container } from "@/lib/di";
import { systemConfig } from "@/models/schema";
import { legacyStationOpenValue } from "@/middleware/station-open";
import { jsonRaw } from "@/utils/json";

/** Keep presence and raw JSON: cached scalar normalization loses PHP truthiness. */
export async function isCommunityOpen(container: Pick<Container, "db">): Promise<boolean> {
  const rows = await container.db.select({ value: systemConfig.value }).from(systemConfig)
    .where(and(eq(systemConfig.menuName, "community_status"), eq(systemConfig.isStore, 0)))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(1);
  return legacyStationOpenValue(rows[0]?.value);
}

/** PHP request admission, before authentication and any community business I/O. */
export function communityOpenMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    if (!await isCommunityOpen(c.get("container"))) {
      c.header("Cache-Control", "no-store");
      return jsonRaw(c, 410010, "社区暂未开放");
    }
    await next();
  };
}
