export type ConversationDomain = 0 | 1;
export interface ConversationIdentity { uid: number; isTourist: ConversationDomain }
export function conversationKey(value: { to_uid: number; is_tourist: number }): string {
  return `${value.is_tourist === 1 ? "tourist" : "registered"}:${value.to_uid}`;
}
export function parseConversationQuery(query: Record<string, unknown>): ConversationIdentity | null {
  if (query.uid !== undefined && query.toUid !== undefined) return null;
  const uid = query.uid ?? query.toUid;
  const domain = query.is_tourist;
  if (typeof uid !== "string" || !/^[1-9]\d*$/.test(uid) || !Number.isSafeInteger(Number(uid)) || Number(uid) > 2_147_483_647) return null;
  if (domain !== "0" && domain !== "1") return null;
  return { uid: Number(uid), isTourist: domain === "1" ? 1 : 0 };
}
export function safeKefuRedirect(value: unknown, origin: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/workbench";
  try {
    const target = new URL(value, origin);
    const allowed = ["/workbench", "/messages", "/mobile_list", "/mobile_chat", "/kefu/mobile_list", "/kefu/mobile_chat", "/kefu/pc_list"];
    return target.origin === origin && allowed.includes(target.pathname) ? `${target.pathname}${target.search}${target.hash}` : "/workbench";
  } catch { return "/workbench"; }
}
