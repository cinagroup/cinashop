import {
  type ChatSocketSession,
  parseChatRole,
} from "@/services/kefu/KefuRealtimeService";

const MAX_CHAT_FRAME_BYTES = 8 * 1024;
export const CHAT_TOKEN_KEY_PATTERN = /^[a-f0-9]{32}$/;

export interface ChatEnvelope {
  type: "chat" | "to_chat" | "online" | "ping";
  data: Record<string, unknown>;
}

function parseInteger(value: string | null, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error("invalid chat session");
  return parsed;
}

export function parseChatEnvelope(message: string | ArrayBuffer): ChatEnvelope {
  const bytes = typeof message === "string"
    ? new TextEncoder().encode(message).byteLength
    : message.byteLength;
  if (bytes < 1 || bytes > MAX_CHAT_FRAME_BYTES) throw new Error("invalid chat frame size");
  const text = typeof message === "string" ? message : new TextDecoder().decode(message);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid chat envelope");
  }
  const record = parsed as Record<string, unknown>;
  if (!["chat", "to_chat", "online", "ping"].includes(String(record.type ?? ""))) {
    throw new Error("unsupported chat event");
  }
  const data = record.data;
  if (data !== undefined && (!data || typeof data !== "object" || Array.isArray(data))) {
    throw new Error("invalid chat event data");
  }
  return {
    type: record.type as ChatEnvelope["type"],
    data: (data as Record<string, unknown> | undefined) ?? {},
  };
}

export function parseChatSessionRequest(request: Request): ChatSocketSession {
  const principalUid = parseInteger(request.headers.get("X-Chat-Principal-Uid"), 1);
  const role = parseChatRole(request.headers.get("X-Chat-Role"));
  const toUid = parseInteger(request.headers.get("X-Chat-To-Uid"), 0);
  const isTourist = parseInteger(request.headers.get("X-Chat-Is-Tourist"), 0);
  const authId = parseInteger(request.headers.get("X-Chat-Auth-Id"), 1);
  const expiresAt = parseInteger(request.headers.get("X-Chat-Token-Exp"), 1);
  const tokenKey = request.headers.get("X-Chat-Token-Key") ?? "";
  const authVersion = request.headers.get("X-Chat-Auth-Version") ?? "";
  if (
    !CHAT_TOKEN_KEY_PATTERN.test(tokenKey) || !authVersion || principalUid === toUid
    || isTourist > 1 || (role === 1 && isTourist !== 0) || (role === 3 && isTourist !== 1)
  ) {
    throw new Error("invalid chat session");
  }
  return {
    principalUid,
    role,
    isTourist: isTourist as 0 | 1,
    toUid,
    authId,
    tokenKey,
    expiresAt,
    authVersion,
    connectedAt: Math.floor(Date.now() / 1000),
  };
}
