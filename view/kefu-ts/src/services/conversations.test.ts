import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationController, mergeSessionRecords, type ConversationApi } from "./conversations";
import { announceKefuSessionChange, KEFU_TOKEN_KEY } from "./session";
import type { ChatMessage, SessionRecord } from "@/types/kefu";
function storage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) }; }
const row = (uid: number, domain = 0, id = uid): SessionRecord => ({ id, to_uid: uid, is_tourist: domain, user_id: 1, nickname: `客户${uid}`, phone: "", avatar: "", online: 0, type: 0, add_time: 1, update_time: id, mssage_num: 2, message: "消息", message_type: 1 });
const message = (id: number, domain = 0): ChatMessage => ({ id, uid: 9, to_uid: 1, is_tourist: domain, msn: `消息${id}`, msn_type: 1, add_time: id, type: 0 });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void; return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject }; }
beforeEach(() => { vi.stubGlobal("sessionStorage", storage()); vi.stubGlobal("window", new EventTarget()); sessionStorage.setItem(KEFU_TOKEN_KEY, "agent"); });
afterEach(() => vi.unstubAllGlobals());
describe("rendered workbench conversation controller", () => {
  it("searches both domains on the server and consumes their independent cursors", async () => {
    const calls: unknown[] = [];
    const api: ConversationApi = { history: async () => [], sessions: async input => { calls.push(input); return { list: [row(input.cursor ? 10 : 9, input.is_tourist)], next_cursor: input.cursor ? null : `${input.is_tourist}:9` }; } };
    const state = createConversationController(api); await state.loadSessions("needle"); await state.loadSessions("needle", true);
    expect(calls).toEqual([{ nickname: "needle", is_tourist: 0, cursor: undefined, limit: 60 }, { nickname: "needle", is_tourist: 1, cursor: undefined, limit: 60 }, { nickname: "needle", is_tourist: 0, cursor: "0:9", limit: 60 }, { nickname: "needle", is_tourist: 1, cursor: "1:9", limit: 60 }]);
    expect(state.sessions.value).toHaveLength(4); expect(state.hasSessions.value).toBe(false);
  });
  it("does not let delayed registered history replace the same numeric tourist UID", async () => {
    const first = deferred<ChatMessage[]>();
    const api: ConversationApi = { sessions: async () => ({ list: [], next_cursor: null }), history: (_uid, input) => input.is_tourist === 0 ? first.promise : Promise.resolve([message(70, 1)]) };
    const state = createConversationController(api), old = state.select(row(9)); await state.select(row(9, 1)); first.resolve([message(1)]); await old;
    expect(state.messages.value.map(item => item.id)).toEqual([70]); expect(state.selected.value?.is_tourist).toBe(1);
  });
  it("ignores delayed errors after replacement and after reset", async () => {
    const pending = deferred<ChatMessage[]>(), state = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: () => pending.promise });
    const run = state.select(row(9)); state.reset(); pending.reject(Error("old private error")); await run;
    expect(state.error.value).toBe(""); expect(state.selected.value).toBeNull(); expect(state.messages.value).toEqual([]);
  });
  it("paginates history using the oldest ID and stops on exhaustion without duplicating messages", async () => {
    const calls: unknown[] = [];
    const state = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: async (_uid, input) => { calls.push(input); return input.upperId ? [message(1), message(2)] : Array.from({ length: 60 }, (_value, i) => message(i + 3)); } });
    await state.select(row(9)); expect(state.hasHistory.value).toBe(true); state.messages.value.push(message(63)); await state.loadHistory();
    expect(calls[1]).toEqual({ upperId: 3, is_tourist: 0, limit: 60 }); expect(state.messages.value.map(item => item.id)).toEqual(Array.from({ length: 63 }, (_value, i) => i + 1)); expect(state.hasHistory.value).toBe(false);
  });
  it("invalidates same-token ABA identity changes and transfer removals", async () => {
    const pending = deferred<ChatMessage[]>(), state = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: () => pending.promise });
    const run = state.select(row(9)); announceKefuSessionChange(); pending.resolve([message(1)]); await run; expect(state.messages.value).toEqual([]);
    state.acceptSession(row(9)); state.acceptSession(row(9, 1)); state.remove(9, 0); expect(state.selected.value).toBeNull(); expect(state.sessions.value.map(item => item.is_tourist)).toEqual([1]);
  });
  it("deduplicates transferred records by UID/domain even when their record IDs differ", () => {
    expect(mergeSessionRecords([row(9, 0, 1), row(9, 0, 3), row(9, 1, 2)]).map(item => [item.id, item.is_tourist])).toEqual([[3, 0], [2, 1]]);
  });
  it("rejects late source summaries after transfer and reinstates only server-confirmed ownership", async () => {
    let assigned = false;
    const state = createConversationController({ sessions: async input => ({ list: assigned && input.is_tourist === 0 ? [row(9, 0, 5)] : [], next_cursor: null }), history: async () => [] });
    state.acceptSession(row(9)); state.remove(9, 0);
    expect(state.acceptSession(row(9, 0, 4))).toBe(false); expect(state.sessions.value).toEqual([]);
    await state.loadSessions(); expect(state.acceptSession(row(9))).toBe(false);
    assigned = true; await state.loadSessions(); expect(state.sessions.value[0].id).toBe(5); expect(state.acceptSession(row(9, 0, 6))).toBe(true);
  });
});
