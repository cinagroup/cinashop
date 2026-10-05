import { computed, ref } from "vue";
import type { ChatMessage, SessionPage, SessionRecord } from "@/types/kefu";
import { conversationKey, type ConversationDomain } from "@/router/kefu-navigation";
import { captureKefuSession, isCurrentKefuSession } from "@/services/session";
import { upsertMessage } from "@/services/realtime";

export interface ConversationApi {
  sessions(input: { nickname?: string; cursor?: string; is_tourist: number; limit: number }): Promise<SessionPage>;
  history(uid: number, input: { upperId?: number; is_tourist: number; limit: number }): Promise<ChatMessage[]>;
}
export function mergeSessionRecords(rows: SessionRecord[]): SessionRecord[] {
  const merged = new Map<string, SessionRecord>();
  for (const row of rows) {
    const key = conversationKey(row), previous = merged.get(key);
    if (!previous || row.update_time > previous.update_time || (row.update_time === previous.update_time && row.id >= previous.id)) merged.set(key, { ...row, phone: row.phone ?? "" });
  }
  return [...merged.values()].sort((a, b) => b.update_time - a.update_time || b.id - a.id);
}
/** Real controller shared by the rendered workbench and runtime tests. */
export function createConversationController(api: ConversationApi, preview = false) {
  const sessions = ref<SessionRecord[]>([]), selected = ref<SessionRecord | null>(null), messages = ref<ChatMessage[]>([]);
  const listLoading = ref(false), historyLoading = ref(false), hasHistory = ref(false), error = ref("");
  const cursors = ref<Record<ConversationDomain, string | null>>({ 0: null, 1: null });
  const hasSessions = computed(() => Boolean(cursors.value[0] || cursors.value[1]));
  let generation = 0, listRequest = 0, selectionRequest = 0, historyRequest = 0, keyword = "";
  const transferred = new Set<string>();
  const stamp = () => ({ generation, session: captureKefuSession() });
  const current = (value: ReturnType<typeof stamp>) => value.generation === generation && (preview || isCurrentKefuSession(value.session));
  function clearSelection() { selectionRequest++; historyRequest++; selected.value = null; messages.value = []; hasHistory.value = false; historyLoading.value = false; }
  function reset() { generation++; listRequest++; listLoading.value = false; transferred.clear(); clearSelection(); sessions.value = []; cursors.value = { 0: null, 1: null }; error.value = ""; }
  async function loadSessions(search = "", more = false) {
    if (more && (listLoading.value || !hasSessions.value)) return;
    const request = ++listRequest, value = stamp(); keyword = search.trim();
    if (!more) { sessions.value = []; cursors.value = { 0: null, 1: null }; }
    listLoading.value = true; error.value = "";
    const domains: ConversationDomain[] = more ? ([0, 1] as ConversationDomain[]).filter(domain => cursors.value[domain]) : [0, 1];
    try {
      const pages = await Promise.all(domains.map(async domain => ({ domain, page: await api.sessions({ nickname: keyword || undefined, is_tourist: domain, cursor: more ? cursors.value[domain] ?? undefined : undefined, limit: 60 }) })));
      if (!current(value) || request !== listRequest) return;
      const confirmed = pages.flatMap(({ domain, page }) => page.list.filter(row => row.is_tourist === domain));
      // Only an authenticated ownership-scoped list may reinstate a transferred peer.
      for (const row of confirmed) transferred.delete(conversationKey(row));
      sessions.value = mergeSessionRecords([...sessions.value, ...confirmed]);
      for (const { domain, page } of pages) cursors.value[domain] = page.next_cursor;
    } catch (cause) { if (current(value) && request === listRequest) error.value = cause instanceof Error ? cause.message : "会话列表加载失败"; }
    finally { if (current(value) && request === listRequest) listLoading.value = false; }
  }
  async function select(session: SessionRecord): Promise<boolean> {
    clearSelection(); selected.value = session;
    const request = selectionRequest, value = stamp(), key = conversationKey(session);
    historyLoading.value = true; error.value = "";
    try {
      const rows = await api.history(session.to_uid, { is_tourist: session.is_tourist === 1 ? 1 : 0, limit: 60 });
      if (!current(value) || request !== selectionRequest || !selected.value || conversationKey(selected.value) !== key) return false;
      for (const row of rows.filter(row => row.is_tourist === session.is_tourist)) messages.value = upsertMessage(messages.value, row);
      hasHistory.value = rows.length === 60;
      return true;
    } catch (cause) { if (current(value) && request === selectionRequest) error.value = cause instanceof Error ? cause.message : "会话加载失败"; return false; }
    finally { if (current(value) && request === selectionRequest) historyLoading.value = false; }
  }
  async function loadHistory(): Promise<boolean> {
    const session = selected.value, upperId = messages.value[0]?.id;
    if (!session || !upperId || !hasHistory.value || historyLoading.value) return false;
    const request = ++historyRequest, value = stamp(), selection = selectionRequest;
    historyLoading.value = true; error.value = "";
    try {
      const rows = await api.history(session.to_uid, { upperId, is_tourist: session.is_tourist === 1 ? 1 : 0, limit: 60 });
      if (!current(value) || request !== historyRequest || selection !== selectionRequest) return false;
      const older = rows.filter(row => row.id < upperId && row.is_tourist === session.is_tourist);
      for (const row of older) messages.value = upsertMessage(messages.value, row);
      hasHistory.value = rows.length === 60 && older.length > 0;
      return true;
    } catch (cause) { if (current(value) && request === historyRequest && selection === selectionRequest) error.value = cause instanceof Error ? cause.message : "历史消息加载失败"; return false; }
    finally { if (current(value) && request === historyRequest && selection === selectionRequest) historyLoading.value = false; }
  }
  function acceptSession(row: SessionRecord) {
    if (transferred.has(conversationKey(row))) return false;
    if (keyword && !`${row.nickname} ${row.phone ?? ""}`.toLowerCase().includes(keyword.toLowerCase())) return false;
    sessions.value = mergeSessionRecords([...sessions.value, row]);
    return true;
  }
  function remove(uid: number, domain: number) { transferred.add(conversationKey({ to_uid: uid, is_tourist: domain })); listRequest++; listLoading.value = false; sessions.value = sessions.value.filter(row => row.to_uid !== uid || row.is_tourist !== domain); if (selected.value?.to_uid === uid && selected.value.is_tourist === domain) clearSelection(); }
  return { sessions, selected, messages, listLoading, historyLoading, hasHistory, hasSessions, error, cursors, loadSessions, select, loadHistory, reset, clearSelection, acceptSession, remove };
}
