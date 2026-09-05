export interface InboxMessage { id: number; title: string; content: string | null; mark: string; look: 0 | 1; add_time: number }
export interface InboxPage { list: InboxMessage[]; unread_count: number; next_cursor: number | null }

const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
export function parseInboxMessage(value: unknown): InboxMessage {
  if (!value || typeof value !== "object") throw new Error("提醒内容格式无效");
  const row = value as Record<string, unknown>;
  if (!integer(row.id, 1) || typeof row.title !== "string" || typeof row.mark !== "string"
    || (row.content !== null && typeof row.content !== "string") || ![0, 1].includes(Number(row.look))
    || typeof row.look !== "number" || !integer(row.add_time)) throw new Error("提醒内容格式无效");
  return { id: row.id, title: row.title, mark: row.mark, content: row.content, look: row.look as 0 | 1, add_time: row.add_time };
}
export function parseInboxPage(value: unknown): InboxPage {
  if (!value || typeof value !== "object") throw new Error("提醒列表格式无效");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.list) || page.list.length > 50 || !integer(page.unread_count)
    || (page.next_cursor !== null && !integer(page.next_cursor, 1))) throw new Error("提醒列表格式无效");
  const list = page.list.map(parseInboxMessage);
  if (list.some((item, index) => index > 0 && item.id >= list[index - 1].id)
    || (page.next_cursor !== null && page.next_cursor !== list.at(-1)?.id)) throw new Error("提醒分页顺序无效");
  return { list, unread_count: page.unread_count, next_cursor: page.next_cursor };
}

/** A logout/unmount invalidates all earlier responses, including late errors. */
export function createInboxGuard() {
  let version = 0, disposed = false;
  return {
    invalidate() { version++; },
    dispose() { disposed = true; version++; },
    async run<T>(load: () => Promise<T>, publish: (value: T) => void, fail: () => void) {
      const current = ++version;
      if (disposed) return;
      try { const value = await load(); if (!disposed && version === current) publish(value); }
      catch { if (!disposed && version === current) fail(); }
    },
  };
}
