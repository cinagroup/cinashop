import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import { KefuVisitorSessionService } from "@/services/kefu/KefuVisitorSessionService";
import { ApiErrorCode, AuthException } from "@/utils/errors";
import { md5 } from "@/utils/jwt";

export function extractVisitorToken(c: Context): string | null {
  const header = c.req.header("X-Visitor-Token")?.trim();
  if (header) return header;
  const protocols = c.req.header("Sec-WebSocket-Protocol")?.split(",") ?? [];
  const protocol = protocols
    .map((value) => value.trim())
    .find((value) => value.startsWith("cinashop-visitor."));
  return protocol ? protocol.slice("cinashop-visitor.".length) : null;
}

export const visitorAuthMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const token = extractVisitorToken(c);
  if (!token || token === "undefined" || token === "null") {
    throw new AuthException("请先创建游客会话", ApiErrorCode.ERR_LOGIN);
  }
  const identity = await new KefuVisitorSessionService(c.get("container"), c.env)
    .authenticate(token);
  c.set("visitorSession", identity);
  c.set("socketTokenKey", md5(token));
  c.set("socketTokenExp", identity.expiresAt);
  c.set("socketAuthId", identity.visitorUid);
  c.set("socketAuthVersion", identity.tokenHash);
  await next();
};
