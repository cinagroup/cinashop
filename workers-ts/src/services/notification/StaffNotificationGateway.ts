import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AuthException } from "@/utils/errors";
import { StaffNotificationAuthService } from "./StaffNotificationAuthService";
import { parseStaffSession, staffPrincipalName, type StaffAudience } from "./StaffNotificationProtocol";

export async function upgradeStaffNotification(c: Context<{ Bindings: Env; Variables: AppVariables }>, audience: StaffAudience) {
  if (c.req.method !== "GET" || c.req.header("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
  const origin = c.req.header("Origin");
  const allowed = (audience === "admin" ? c.env.AUTH_ALLOWED_ORIGINS : c.env.KEFU_AUTH_ALLOWED_ORIGINS)?.split(",").map((o) => o.trim()) ?? [];
  if (!origin || !allowed.includes(origin) || origin === "null") throw new AuthException("通知连接来源未授权");
  const session = parseStaffSession({ audience, id: audience === "admin" ? c.get("adminId") : c.get("kefuUid"),
    authId: c.get("socketAuthId"), tokenKey: c.get("socketTokenKey"), authVersion: c.get("socketAuthVersion"), expiresAt: c.get("socketTokenExp") });
  await new StaffNotificationAuthService(c.get("container"), c.env).assertSession(session);
  // Only trusted context metadata crosses the binding. No URL token, cookies, or raw JWT.
  const headers = new Headers({ Upgrade: "websocket", "X-Staff-Session": JSON.stringify(session) });
  for (const name of ["Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"]) {
    const value = c.req.header(name); if (value) headers.set(name, value);
  }
  if (c.req.header("Sec-WebSocket-Protocol")?.split(",").some((p) => p.trim() === "cinashop")) headers.set("Sec-WebSocket-Protocol", "cinashop");
  return c.env.STAFF_NOTICE.getByName(staffPrincipalName(session)).fetch(new Request("https://staff-notice.internal/connect", { headers }));
}
