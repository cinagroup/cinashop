import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AuthException, ValidateException } from "@/utils/errors";

export type ChatRole = 1 | 2;

type ChatContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export function chatPrincipalName(role: ChatRole, uid: number): string {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("聊天身份无效");
  return role === 2 ? `kefu:${uid}` : `user:${uid}`;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidateException(`${label}无效`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ValidateException(`${label}无效`);
  return parsed;
}

function websocketHeaders(c: ChatContext): Headers {
  const headers = new Headers();
  for (const name of [
    "Upgrade",
    "Connection",
    "Sec-WebSocket-Key",
    "Sec-WebSocket-Version",
    "Sec-WebSocket-Extensions",
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const protocols = c.req.header("Sec-WebSocket-Protocol")?.split(",") ?? [];
  if (protocols.some((value) => value.trim() === "cinashop")) {
    // Do not forward cinashop-auth.<raw JWT> into the Durable Object.
    headers.set("Sec-WebSocket-Protocol", "cinashop");
  }
  return headers;
}

export async function upgradeChatSocket(
  c: ChatContext,
  input: { role: ChatRole; principalUid: number; toUid?: unknown },
): Promise<Response> {
  if (c.req.method !== "GET" || c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const principalUid = positiveInteger(input.principalUid, "聊天身份");
  const toUid = nonNegativeInteger(input.toUid ?? 0, "会话用户");
  if (toUid === principalUid) throw new ValidateException("不能和自己聊天");
  const tokenKey = c.get("socketTokenKey") ?? "";
  const tokenExp = c.get("socketTokenExp") ?? 0;
  const authId = c.get("socketAuthId") ?? 0;
  const authVersion = c.get("socketAuthVersion") ?? "";
  if (!tokenKey || !tokenExp || !authId || !authVersion) {
    throw new AuthException("聊天登录状态无效");
  }

  const headers = websocketHeaders(c);
  headers.set("X-Chat-Principal-Uid", String(principalUid));
  headers.set("X-Chat-Role", String(input.role));
  headers.set("X-Chat-To-Uid", String(toUid));
  headers.set("X-Chat-Auth-Id", String(authId));
  headers.set("X-Chat-Token-Key", tokenKey);
  headers.set("X-Chat-Token-Exp", String(tokenExp));
  headers.set("X-Chat-Auth-Version", authVersion);

  const stub = c.env.CHAT_ROOM.getByName(chatPrincipalName(input.role, principalUid));
  return stub.fetch(new Request("https://chat.internal/connect", { method: "GET", headers }));
}
