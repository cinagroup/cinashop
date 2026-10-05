import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryResult, TransferDeliveryEvent } from "../src/do/ChatRoomDO";
import type { ChatSocketSession, PersistedRealtimeMessage } from "../src/services/kefu/KefuRealtimeService";
import type { ChatMessage, SessionPage, SessionRecord } from "../../view/kefu-ts/src/types/kefu";
import { isConfiguredKefuWorkBenchTarget, kefuWorkBenchOrigin, legacyKefuWorkBenchTarget } from "../src/services/kefu/KefuWorkBenchEntry";

// Execute the real DO methods. Only the platform base class and the socket /
// credential transport are substituted; no source-string assertions or copied
// delivery algorithm. This is not native Cloudflare hibernation or PG evidence.
type Room = {
  deliver(message: PersistedRealtimeMessage): Promise<DeliveryResult>;
  deliverTransfer(event: TransferDeliveryEvent): Promise<number>;
};
let roomPrototype: object;

beforeAll(async () => {
  const result = await build({
    entryPoints: [resolve("src/do/ChatRoomDO.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    tsconfig: resolve("tsconfig.json"),
    plugins: [{
      name: "independent-do-platform-boundary",
      setup(plugin) {
        plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: "durable-object-platform", namespace: "independent-do",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "independent-do" }, () => ({
          contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
          loader: "js",
        }));
      },
    }],
  });
  const compiled = { exports: {} as { ChatRoomDO?: { prototype: object } } };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    compiled, compiled.exports, createRequire(import.meta.url),
  );
  if (!compiled.exports.ChatRoomDO) throw new Error("Actual ChatRoomDO export was not compiled");
  roomPrototype = compiled.exports.ChatRoomDO.prototype;
}, 30_000);

function identity(overrides: Partial<ChatSocketSession> = {}): ChatSocketSession {
  return {
    principalUid: 1001,
    role: 2,
    isTourist: 0,
    toUid: 42,
    authId: 7,
    tokenKey: "0123456789abcdef0123456789abcdef",
    authVersion: "independent-fixture-version",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    connectedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function socket(initial: ChatSocketSession, failSend = false) {
  let current = { ...initial };
  return {
    sent: [] as Array<{ type: string; data: Record<string, unknown> }>,
    closed: [] as Array<{ code: number; reason: string }>,
    deserializeAttachment: () => current,
    serializeAttachment: (next: ChatSocketSession) => { current = { ...next }; },
    send(value: string) {
      if (failSend) throw new Error("deterministic transport failure");
      this.sent.push(JSON.parse(value));
    },
    close(code: number, reason: string) { this.closed.push({ code, reason }); },
  };
}

function room(sockets: ReturnType<typeof socket>[], revoked = false) {
  const assertSession = vi.fn(async () => {
    if (revoked) throw new Error("deterministic credential revocation");
  });
  const assignments = new Map<string, number>([["42:0", 71], ["42:1", 71]]);
  const canDeliverConversation = vi.fn(async (_session: ChatSocketSession, uid: unknown, domain: unknown, id?: unknown) => {
    const assigned = assignments.get(`${uid}:${domain}`); return assigned !== undefined && (id === undefined || assigned === id);
  });
  const instance = Object.create(roomPrototype) as Room;
  Object.assign(instance, {
    ctx: { getWebSockets: () => sockets },
    service: () => ({ assertSession, canDeliverConversation }),
  });
  return { instance, assertSession, assignments, canDeliverConversation };
}

function message(isTourist: 0 | 1): PersistedRealtimeMessage {
  return {
    id: 81,
    uid: 42,
    to_uid: 1001,
    msn: "independent fixture message",
    msn_type: 1,
    add_time: 1700000000,
    is_tourist: isTourist,
    type: 0,
    nickname: isTourist ? "visitor" : "registered",
    avatar: "",
    sender_role: isTourist ? 3 : 1,
    recored: {
      id: 71,
      user_id: 1001,
      to_uid: 42,
      nickname: isTourist ? "visitor" : "registered",
      avatar: "",
      is_tourist: isTourist,
      online: 1,
      type: isTourist ? 3 : 1,
      add_time: 1700000000,
      update_time: 1700000000,
      mssage_num: 4,
      message: "independent fixture message",
      message_type: 1,
    },
  };
}

const requestKey = "12345678-1234-4234-9234-123456789abc";

describe("independent complete Kefu mobile delivery contract", () => {
  it("continues visitor notices while the same numeric registered UID is being viewed", async () => {
    const registered = socket(identity());
    const visitor = socket(identity({ isTourist: 1 }));
    const { instance } = room([registered, visitor]);
    expect(await instance.deliver(message(1))).toEqual({ connected: 2, viewing: 1 });
    expect(registered.sent).toMatchObject([{ type: "mssage_num", data: { uid: 42, is_tourist: 1, num: 4, message_id: 81 } }]);
    expect(visitor.sent).toMatchObject([{ type: "reply", data: { id: 81, is_tourist: 1 } }]);
  });

  it("background list subscription receives both identity domains without clearing either unread count", async () => {
    const background = socket(identity({ toUid: 0 }));
    const { instance } = room([background]);
    expect(await instance.deliver(message(0))).toEqual({ connected: 1, viewing: 0 });
    expect(await instance.deliver(message(1))).toEqual({ connected: 1, viewing: 0 });
    expect(background.sent.map((event) => [event.type, event.data.is_tourist, event.data.num]))
      .toEqual([["mssage_num", 0, 4], ["mssage_num", 1, 4]]);
  });

  it("customer sockets keep their domain boundary even when numeric UID and peer match", async () => {
    const customer = socket(identity({ role: 1, authId: 1001 }));
    const { instance } = room([customer]);
    expect(await instance.deliver(message(1))).toEqual({ connected: 0, viewing: 0 });
    expect(customer.sent).toEqual([]);
  });

  it("a socket send failure cannot cause a message to be counted as viewed", async () => {
    const failedViewer = socket(identity(), true);
    const { instance } = room([failedViewer]);
    expect(await instance.deliver(message(0))).toEqual({ connected: 0, viewing: 0 });
    expect(failedViewer.sent).toEqual([]);
  });

  it("receives opposite-domain transfers without changing the active registered conversation", async () => {
    const registered = socket(identity());
    const { instance } = room([registered]);
    const event: TransferDeliveryEvent = {
      type: "transfer",
      data: {
        request_key: requestKey,
        is_tourist: 1,
        recored: message(1).recored,
        kefuInfo: { uid: 1002, nickname: "source agent", avatar: "" },
      },
    };
    expect(await instance.deliverTransfer(event)).toBe(1);
    expect(registered.sent).toMatchObject([{ type: "transfer", data: { is_tourist: 1 } }]);
    expect(registered.deserializeAttachment()).toMatchObject({ isTourist: 0, toUid: 42 });
  });

  it("transfer-out cancels viewing only for the exact active UID and domain", async () => {
    const registered = socket(identity());
    const visitor = socket(identity({ isTourist: 1 }));
    const { instance, assignments } = room([registered, visitor]);
    assignments.delete("42:1");
    await instance.deliverTransfer({
      type: "transfer_out",
      data: { request_key: requestKey, uid: 42, toUid: 1002, is_tourist: 1, nickname: "target", avatar: "" },
    });
    expect(registered.sent).toMatchObject([{ type: "transfer_out", data: { is_tourist: 1 } }]);
    expect(registered.deserializeAttachment()).toMatchObject({ toUid: 42, isTourist: 0 });
    expect(visitor.deserializeAttachment()).toMatchObject({ toUid: 0, isTourist: 1 });
  });

  it("rechecks revoked credentials before message or transfer delivery", async () => {
    const revoked = socket(identity());
    const { instance, assertSession } = room([revoked], true);
    expect(await instance.deliver(message(0))).toEqual({ connected: 0, viewing: 0 });
    expect(await instance.deliverTransfer({
      type: "transfer_out",
      data: { request_key: requestKey, uid: 42, toUid: 1002, is_tourist: 0, nickname: "target", avatar: "" },
    })).toBe(0);
    expect(assertSession).toHaveBeenCalledTimes(2);
    expect(revoked.sent).toEqual([]);
    expect(revoked.closed).toEqual([
      { code: 4001, reason: "Session revoked" },
      { code: 4001, reason: "Session revoked" },
    ]);
  });

  it("rejects malformed transfer or message payloads before reading any socket", async () => {
    const { instance, assertSession } = room([socket(identity())]);
    await expect(instance.deliver({ ...message(0), is_tourist: 2 } as never)).rejects.toThrow("invalid delivery payload");
    await expect(instance.deliverTransfer({
      type: "transfer_out",
      data: { request_key: "not-a-request-key", uid: 42, toUid: 1002, is_tourist: 0, nickname: "target", avatar: "" },
    })).rejects.toThrow("invalid transfer delivery payload");
    expect(assertSession).not.toHaveBeenCalled();
  });

  it("drops a persisted message whose delivery arrives after that identity was transferred out", async () => {
    const source = socket(identity({ toUid: 0 }));
    const { instance, assignments } = room([source]);
    assignments.delete("42:1");
    await instance.deliverTransfer({ type: "transfer_out", data: { request_key: requestKey, uid: 42, toUid: 1002, is_tourist: 1, nickname: "target", avatar: "" } });
    source.sent.length = 0;
    expect(await instance.deliver(message(1))).toEqual({ connected: 0, viewing: 0 });
    expect(source.sent).toEqual([]);
    expect(source.closed).toEqual([]);
  });

  it("drops an old transfer-in delivery after a later transfer-out of the same identity", async () => {
    const source = socket(identity({ toUid: 0 }));
    const { instance, assignments } = room([source]);
    assignments.delete("42:1");
    await instance.deliverTransfer({ type: "transfer_out", data: { request_key: requestKey, uid: 42, toUid: 1002, is_tourist: 1, nickname: "target", avatar: "" } });
    source.sent.length = 0;
    expect(await instance.deliverTransfer({ type: "transfer", data: { request_key: requestKey, is_tourist: 1, recored: message(1).recored, kefuInfo: { uid: 1002, nickname: "source agent", avatar: "" } } })).toBe(0);
    expect(source.sent).toEqual([]);
    expect(source.closed).toEqual([]);
  });

  it("authorizes the delivery payload identity rather than the staff socket viewing identity", async () => {
    const registered = socket(identity());
    const { instance, assignments, canDeliverConversation } = room([registered]);
    assignments.delete("42:1");
    expect(await instance.deliver(message(1))).toEqual({ connected: 0, viewing: 0 });
    expect(canDeliverConversation).toHaveBeenCalledWith(expect.objectContaining({ isTourist: 0 }), 42, 1, 71);
    expect(registered.sent).toEqual([]);
    expect(await instance.deliver(message(0))).toEqual({ connected: 1, viewing: 1 });
  });

  it("drops an old record delivery after the identity is newly assigned back with a different record", async () => {
    const staff = socket(identity());
    const { instance, assignments } = room([staff]); assignments.set("42:0", 72);
    expect(await instance.deliver(message(0))).toEqual({ connected: 0, viewing: 0 });
    expect(staff.sent).toEqual([]);
    const current = { ...message(0), recored: { ...message(0).recored, id: 72 } };
    expect(await instance.deliver(current)).toEqual({ connected: 1, viewing: 1 });
    expect(staff.closed).toEqual([]);
  });

  it("does not apply a delayed transfer-out after current ownership has returned", async () => {
    const staff = socket(identity()); const { instance } = room([staff]);
    expect(await instance.deliverTransfer({ type: "transfer_out", data: { request_key: requestKey, uid: 42, toUid: 1002, is_tourist: 0, nickname: "target", avatar: "" } })).toBe(0);
    expect(staff.sent).toEqual([]); expect(staff.deserializeAttachment().toUid).toBe(42);
    expect(staff.closed).toEqual([]);
  });
});

type ConversationApi = {
  sessions(input: { nickname?: string; cursor?: string; is_tourist: number; limit: number }): Promise<SessionPage>;
  history(uid: number, input: { upperId?: number; is_tourist: number; limit: number }): Promise<ChatMessage[]>;
};
type Value<T> = { value: T };
type ConversationController = {
  sessions: Value<SessionRecord[]>;
  selected: Value<SessionRecord | null>;
  messages: Value<ChatMessage[]>;
  error: Value<string>;
  listLoading: Value<boolean>;
  historyLoading: Value<boolean>;
  hasSessions: Value<boolean>;
  hasHistory: Value<boolean>;
  cursors: Value<Record<0 | 1, string | null>>;
  loadSessions(search?: string, more?: boolean): Promise<void>;
  select(session: SessionRecord): Promise<boolean>;
  loadHistory(): Promise<boolean>;
  reset(): void;
  clearSelection(): void;
  remove(uid: number, domain: number): void;
  acceptSession(row: SessionRecord): boolean;
};
let createConversationController: (api: ConversationApi) => ConversationController;
let announceKefuSessionChange: () => void;
let parseConversationQuery: (query: Record<string, unknown>) => { uid: number; isTourist: 0 | 1 } | null;
let safeKefuRedirect: (value: unknown, origin: string) => string;

class TestStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
function deferred<T>() {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolveValue = resolvePromise; rejectValue = rejectPromise; });
  return { promise, resolve: resolveValue, reject: rejectValue };
}
function record(uid: number, domain: 0 | 1, id = uid): SessionRecord {
  return { ...message(domain).recored, id, to_uid: uid, phone: "", is_tourist: domain };
}
function historyMessage(id: number, uid: number, domain: 0 | 1): ChatMessage {
  return { id, uid, to_uid: 1001, is_tourist: domain, msn: `history-${id}`, add_time: 1700000000 + id, type: 0, msn_type: 1 };
}

describe("independent real frontend conversation controller negatives", () => {
  let storage: TestStorage;
  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: 'export { createConversationController } from "./services/conversations"; export { announceKefuSessionChange } from "./services/session"; export { parseConversationQuery, safeKefuRedirect } from "./router/kefu-navigation";',
        resolveDir: resolve("../view/kefu-ts/src"), sourcefile: "independent-kefu-entry.ts", loader: "ts",
      },
      bundle: true, write: false, platform: "node", format: "cjs", target: "node22",
      tsconfig: resolve("../view/kefu-ts/tsconfig.json"),
      define: { "import.meta.env": '{"DEV":false,"VITE_API_BASE":""}' },
    });
    const compiled = { exports: {} as {
      createConversationController?: typeof createConversationController;
      announceKefuSessionChange?: typeof announceKefuSessionChange;
      parseConversationQuery?: typeof parseConversationQuery;
      safeKefuRedirect?: typeof safeKefuRedirect;
    } };
    new Function("module", "exports", "require", result.outputFiles[0].text)(compiled, compiled.exports, createRequire(import.meta.url));
    if (!compiled.exports.createConversationController || !compiled.exports.announceKefuSessionChange || !compiled.exports.parseConversationQuery || !compiled.exports.safeKefuRedirect) throw new Error("Real frontend contract exports were not compiled");
    createConversationController = compiled.exports.createConversationController;
    announceKefuSessionChange = compiled.exports.announceKefuSessionChange;
    parseConversationQuery = compiled.exports.parseConversationQuery;
    safeKefuRedirect = compiled.exports.safeKefuRedirect;
  }, 30_000);
  beforeEach(() => {
    storage = new TestStorage(); storage.setItem("cinashop_kefu_token", "independent-session-A");
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("localStorage", new TestStorage());
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("loads the second cursor in each domain and searches the server beyond the initial page", async () => {
    const sessions = vi.fn<ConversationApi["sessions"]>(async input => {
      if (input.nickname) return { list: [record(999, input.is_tourist as 0 | 1)], next_cursor: null };
      return { list: [record(input.cursor ? 61 : 1, input.is_tourist as 0 | 1)], next_cursor: input.cursor ? null : "1700000000:1" };
    });
    const controller = createConversationController({ sessions, history: async () => [] });
    await controller.loadSessions(); expect(controller.hasSessions.value).toBe(true);
    await controller.loadSessions("", true);
    expect(controller.sessions.value.map(row => [row.to_uid, row.is_tourist])).toEqual([[61, 0], [61, 1], [1, 0], [1, 1]]);
    expect(sessions.mock.calls.slice(2).map(([input]) => [input.is_tourist, input.cursor])).toEqual([[0, "1700000000:1"], [1, "1700000000:1"]]);
    expect(controller.hasSessions.value).toBe(false);
    await controller.loadSessions("customer-beyond-sixty");
    expect(sessions.mock.calls.slice(-2).every(([input]) => input.nickname === "customer-beyond-sixty" && input.cursor === undefined)).toBe(true);
    expect(controller.sessions.value).toHaveLength(2);
    expect(controller.sessions.value.every(row => row.to_uid === 999)).toBe(true);
  });

  it("suppresses a late history success after switching to the same numeric UID in the other domain", async () => {
    const first = deferred<ChatMessage[]>();
    const controller = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: async (_uid, input) => input.is_tourist === 0 ? first.promise : [historyMessage(202, 42, 1)] });
    const stale = controller.select(record(42, 0));
    await expect(controller.select(record(42, 1))).resolves.toBe(true);
    first.resolve([historyMessage(101, 42, 0)]);
    await expect(stale).resolves.toBe(false);
    expect(controller.selected.value).toMatchObject({ to_uid: 42, is_tourist: 1 });
    expect(controller.messages.value.map(row => [row.id, row.is_tourist])).toEqual([[202, 1]]);
  });

  it("suppresses a late error from a no-longer-selected conversation", async () => {
    const first = deferred<ChatMessage[]>();
    const controller = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: async uid => uid === 42 ? first.promise : [historyMessage(202, 43, 0)] });
    const stale = controller.select(record(42, 0));
    await controller.select(record(43, 0)); first.reject(new Error("old-conversation-error")); await stale;
    expect(controller.error.value).toBe(""); expect(controller.historyLoading.value).toBe(false);
    expect(controller.messages.value[0].uid).toBe(43);
  });

  it("loads upperId history, deduplicates IDs and terminates an older short page", async () => {
    const history = vi.fn<ConversationApi["history"]>(async (_uid, input) => input.upperId
      ? [historyMessage(99, 42, 0), historyMessage(99, 42, 0), historyMessage(100, 42, 0)]
      : Array.from({ length: 60 }, (_, index) => historyMessage(100 + index, 42, 0)));
    const controller = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history });
    await controller.select(record(42, 0)); expect(controller.hasHistory.value).toBe(true);
    await controller.loadHistory();
    expect(history.mock.calls[1]).toMatchObject([42, { upperId: 100, is_tourist: 0 }]);
    expect(controller.messages.value.map(row => row.id)).toEqual([99, ...Array.from({ length: 60 }, (_, index) => 100 + index)]);
    expect(controller.hasHistory.value).toBe(false);
  });

  it("token replacement invalidates late list results without leaking prior-customer rows", async () => {
    const pending = deferred<SessionPage>();
    const controller = createConversationController({ sessions: async () => pending.promise, history: async () => [] });
    const load = controller.loadSessions(); storage.setItem("cinashop_kefu_token", "independent-session-B");
    pending.resolve({ list: [record(42, 0)], next_cursor: null }); await load;
    expect(controller.sessions.value).toEqual([]); expect(controller.messages.value).toEqual([]);
    expect(controller.error.value).toBe("");
    controller.reset(); expect(controller.listLoading.value).toBe(false);
  });

  it("transfer removal invalidates an already-requested history response", async () => {
    const pending = deferred<ChatMessage[]>();
    const controller = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: async () => pending.promise });
    controller.acceptSession(record(42, 1));
    const select = controller.select(record(42, 1)); controller.remove(42, 1);
    pending.resolve([historyMessage(101, 42, 1)]); await expect(select).resolves.toBe(false);
    expect(controller.sessions.value).toEqual([]); expect(controller.selected.value).toBeNull(); expect(controller.messages.value).toEqual([]);
  });

  it("does not resurrect a transferred identity from a late unread or transfer-in summary", () => {
    const controller = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: async () => [] });
    controller.acceptSession(record(42, 0, 1)); controller.acceptSession(record(42, 1, 2));
    controller.remove(42, 1);
    controller.acceptSession({ ...record(42, 1, 2), mssage_num: 9 });
    expect(controller.sessions.value.map(row => [row.to_uid, row.is_tourist])).toEqual([[42, 0]]);
  });

  it("permits a transferred identity again only after a current ownership-scoped list confirms it", async () => {
    let restored = false;
    const controller = createConversationController({ sessions: async input => ({ list: restored && input.is_tourist === 1 ? [record(42, 1, 3)] : [], next_cursor: null }), history: async () => [] });
    controller.remove(42, 1); expect(controller.acceptSession(record(42, 1, 2))).toBe(false);
    await controller.loadSessions(); expect(controller.acceptSession(record(42, 1, 2))).toBe(false);
    restored = true; await controller.loadSessions(); expect(controller.acceptSession(record(42, 1, 4))).toBe(true);
    expect(controller.sessions.value).toHaveLength(1); expect(controller.sessions.value[0].is_tourist).toBe(1);
  });

  it("coalesces different record IDs for one identity while retaining the other domain", () => {
    const controller = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: async () => [] });
    controller.acceptSession({ ...record(42, 0, 1), update_time: 10 });
    controller.acceptSession({ ...record(42, 0, 2), update_time: 20 });
    controller.acceptSession({ ...record(42, 1, 3), update_time: 15 });
    expect(controller.sessions.value.map(row => [row.id, row.to_uid, row.is_tourist])).toEqual([[2, 42, 0], [3, 42, 1]]);
  });

  it("invalidates stale history when credentials are replaced by the same token at a new login revision", async () => {
    const pending = deferred<ChatMessage[]>();
    const controller = createConversationController({ sessions: async () => ({ list: [], next_cursor: null }), history: async () => pending.promise });
    const selection = controller.select(record(42, 1));
    announceKefuSessionChange();
    pending.resolve([historyMessage(101, 42, 1)]); await expect(selection).resolves.toBe(false);
    expect(controller.messages.value).toEqual([]);
    controller.reset(); expect(controller.selected.value).toBeNull();
  });

  it("accepts only an explicit positive conversation UID and valid domain in mobile queries", () => {
    expect(parseConversationQuery({ toUid: "42", is_tourist: "1" })).toEqual({ uid: 42, isTourist: 1 });
    expect(parseConversationQuery({ uid: "42", is_tourist: "0" })).toEqual({ uid: 42, isTourist: 0 });
    for (const invalid of [
      { toUid: "0", is_tourist: "1" }, { toUid: "42", is_tourist: "2" },
      { toUid: "42" }, { toUid: ["42"], is_tourist: "1" }, { uid: "9007199254740993", is_tourist: "0" },
    ]) expect(parseConversationQuery(invalid)).toBeNull();
  });

  it("preserves local mobile targets after login and rejects external or invalid redirect targets", () => {
    const origin = "https://owned-kefu.example.test";
    expect(safeKefuRedirect("/kefu/mobile_chat?toUid=42&is_tourist=1", origin)).toBe("/kefu/mobile_chat?toUid=42&is_tourist=1");
    expect(safeKefuRedirect("/mobile_list", origin)).toBe("/mobile_list");
    for (const invalid of ["//external.example.test/chat", "https://external.example.test/chat", "/\\external.example.test", "/login", "/admin", "/mobile_list\u0000"]) {
      expect(safeKefuRedirect(invalid, origin)).toBe("/workbench");
    }
  });
});

describe("independent dedicated Kefu entry methods", () => {
  const origin = "https://kefu.example.test";
  const env = { PUBLIC_KEFU_ORIGIN: origin, KEFU_AUTH_ALLOWED_ORIGINS: origin, ALLOWED_ORIGINS: origin };

  it("requires an explicitly configured canonical origin and both allowlists", () => {
    expect(kefuWorkBenchOrigin(env)).toBe(origin);
    for (const invalid of [
      { ...env, PUBLIC_KEFU_ORIGIN: undefined }, { ...env, KEFU_AUTH_ALLOWED_ORIGINS: "" },
      { ...env, ALLOWED_ORIGINS: "" }, { ...env, PUBLIC_KEFU_ORIGIN: `${origin}/` },
      { ...env, PUBLIC_KEFU_ORIGIN: ` ${origin}` }, { ...env, PUBLIC_KEFU_ORIGIN: "http://kefu.example.test" },
    ]) expect(kefuWorkBenchOrigin(invalid)).toBe("");
  });

  it("carries only peer selection across the dedicated app entry, never a credential or callback", () => {
    expect(legacyKefuWorkBenchTarget("/kefu/mobile_chat?toUid=42&is_tourist=1", origin)).toBe(`${origin}/mobile_chat?uid=42&is_tourist=1`);
    expect(legacyKefuWorkBenchTarget("/kefu/mobile_list", origin)).toBe(`${origin}/mobile_list`);
    for (const invalid of ["/kefu/mobile_chat?uid=42&is_tourist=1&token=secret", "/kefu/mobile_list?token=secret", "/kefu/mobile_chat?uid=42&is_tourist=1&redirect=https://external.test", "/kefu/mobile_chat?uid=42&uid=43", "/kefu/mobile_chat?uid=0&is_tourist=0", "/kefu/mobile_chat?uid=42&is_tourist=2"]) expect(legacyKefuWorkBenchTarget(invalid, origin)).toBe("");
  });

  it("recognizes equivalent configured app targets for role filtering regardless of item placement", () => {
    for (const path of ["/mobile_list", "/mobile_chat?uid=42&is_tourist=1", "/kefu/mobile_list", "/kefu/mobile_chat?toUid=42&is_tourist=0", "/workbench"]) expect(isConfiguredKefuWorkBenchTarget(`${origin}${path}`, origin)).toBe(true);
    for (const inactiveDeclaration of [`${origin}/`, `${origin}/login`]) {
      expect(kefuWorkBenchOrigin({ ...env, PUBLIC_KEFU_ORIGIN: inactiveDeclaration })).toBe("");
      expect(isConfiguredKefuWorkBenchTarget(`${origin}/workbench`, inactiveDeclaration)).toBe(true);
    }
    expect(isConfiguredKefuWorkBenchTarget("https://other.example.test/workbench", origin)).toBe(false);
  });
});

// Execute the actual Workbench SFC setup. Vue reactivity, conversation controller,
// session epochs and realtime client stay real. HTTP responses, router navigation,
// lifecycle registration and browser socket transport are controlled boundaries.
// These are page-method/wiring assertions, not rendered DOM or native WS evidence.
describe("independent actual Workbench SFC event and async negatives", () => {
  let pageCode = "";
  const frontendRequire = createRequire(resolve("../view/kefu-ts/package.json"));
  const vue = frontendRequire("vue") as typeof import("../../view/kefu-ts/node_modules/vue");
  beforeAll(async () => {
    const compiler = frontendRequire("@vue/compiler-sfc");
    const path = resolve("../view/kefu-ts/src/pages/WorkbenchPage.vue");
    const descriptor = compiler.parse(await readFile(path, "utf8"), { filename: path }).descriptor;
    const compiled = compiler.compileScript(descriptor, { id: "independent-mobile-page" }).content;
    const result = await build({
      stdin: { contents: compiled, loader: "ts", resolveDir: resolve("../view/kefu-ts/src/pages"), sourcefile: "independent-real-workbench.ts" },
      bundle: true, write: false, platform: "node", format: "cjs", target: "node22",
      define: { "import.meta.env": '{"DEV":false,"VITE_API_BASE":""}' },
      plugins: [{ name: "independent-sfc-controlled-boundaries", setup(plugin) {
        plugin.onResolve({ filter: /^vue$|^vue-router$|^@\/api\/kefu$|^@\/stores\/auth$|^@\/components\// }, args => ({ path: args.path, namespace: "independent-sfc" }));
        plugin.onLoad({ filter: /.*/, namespace: "independent-sfc" }, args => ({ loader: "js", contents:
          args.path === "vue" ? "module.exports=globalThis.__independentKefuPage.vue;"
          : args.path === "vue-router" ? "export const useRoute=()=>globalThis.__independentKefuPage.route;export const useRouter=()=>globalThis.__independentKefuPage.router;"
          : args.path === "@/api/kefu" ? "export const kefuApi=globalThis.__independentKefuPage.api;"
          : args.path === "@/stores/auth" ? "export const useAuthStore=()=>globalThis.__independentKefuPage.auth;" : "export default {};" }));
        plugin.onResolve({ filter: /^@\// }, args => ({ path: resolve("../view/kefu-ts/src", args.path.slice(2)) + ".ts" }));
      } }],
    });
    pageCode = result.outputFiles[0].text;
  }, 30_000);
  afterEach(() => vi.unstubAllGlobals());

  async function settlePage() { await vue.nextTick(); await new Promise<void>(done => setImmediate(done)); await vue.nextTick(); }
  async function pageFixture(overrides: Record<string, unknown> = {}) {
    const releases: Array<() => void> = [], sockets: Array<FixtureSocket> = [];
    const browser = Object.assign(new EventTarget(), { location: { origin: "https://kefu.example.test", search: "" }, setTimeout, clearTimeout, setInterval, clearInterval, matchMedia: () => ({ matches: false }) });
    const storage = new TestStorage(); storage.setItem("cinashop_kefu_token", "independent-real-page");
    vi.stubGlobal("window", browser); vi.stubGlobal("sessionStorage", storage); vi.stubGlobal("localStorage", new TestStorage());
    class FixtureSocket extends EventTarget {
      static OPEN = 1; static CONNECTING = 0;
      readyState = 0; sent: Array<{ type: string; data: Record<string, unknown> }> = [];
      constructor() { super(); sockets.push(this); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event("open")); } }); }
      send(value: string) { this.sent.push(JSON.parse(value)); }
      close(code = 1000) { this.readyState = 3; const event = Object.assign(new Event("close"), { code }); this.dispatchEvent(event); }
    }
    vi.stubGlobal("WebSocket", FixtureSocket);
    const route = vue.reactive({ path: "/mobile_list", fullPath: "/mobile_list", query: {}, meta: { mobileMode: "list" } });
    const router = { async push(value: string | { path: string; query?: Record<string, string> }) { const next = typeof value === "string" ? { path: value, query: {} } : value; route.path = next.path; route.query = next.query ?? {}; route.meta.mobileMode = next.path.includes("mobile_chat") ? "chat" : "list"; route.fullPath = next.path + "?" + new URLSearchParams(next.query).toString(); }, async replace(value: string) { await this.push(value); } };
    const customer = { uid: 42, nickname: "registered", phone: "", labels: [], labelNames: [], user_type: "h5" };
    const api = { sessions: async (input: { is_tourist: 0 | 1 }) => ({ list: [record(42, input.is_tourist)], next_cursor: null }), history: async (_uid: number, input: { is_tourist: 0 | 1 }) => [historyMessage(100, 42, input.is_tourist)], groups: async () => [], userInfo: async () => customer, userLabels: async () => [], customerOrders: async () => [], purchasedProducts: async () => [], visitedProducts: async () => [], hotProducts: async () => [], speechcraftCategories: async () => [], speechcraft: async () => [], uploadImage: async () => ({ url: "/api/assets/1" }), ...overrides };
    const auth = vue.reactive({ token: "independent-real-page", generation: 0, identity: { uid: 1001, online: 1 }, refreshIdentity: async () => {} });
    vi.stubGlobal("__independentKefuPage", { api, auth, route, router, vue: { ...vue, onMounted: () => {}, onBeforeUnmount: (handler: () => void) => releases.push(handler) } });
    const loaded = { exports: {} as { default: { setup: (props: unknown, context: unknown) => Record<string, any> } } };
    new Function("module", "exports", "require", pageCode)(loaded, loaded.exports, frontendRequire);
    const scope = vue.effectScope(); const state = scope.run(() => loaded.exports.default.setup({}, { expose() {} }))!;
    await state.initialize(); await settlePage();
    return { state, api, sockets, cleanup() { releases.forEach(release => release()); scope.stop(); } };
  }

  it("keeps server unread during pending history and accepts only the server zero acknowledgement", async () => {
    const pending = deferred<ChatMessage[]>(), fixture = await pageFixture({ history: () => pending.promise });
    try {
      const open = fixture.state.openSession(record(42, 0));
      fixture.state.handleRealtimeEvent({ type: "mssage_num", data: { uid: 42, is_tourist: 0, num: 7 } });
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).mssage_num).toBe(7);
      pending.resolve([historyMessage(101, 42, 0)]); await open;
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).mssage_num).toBe(7);
      fixture.state.handleRealtimeEvent({ type: "mssage_num", data: { uid: 42, is_tourist: 0, num: 0 } });
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).mssage_num).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it("rejects late unread and transfer-in summaries after transfer-out through real SFC wiring", async () => {
    const fixture = await pageFixture();
    try {
      await fixture.state.openSession(record(42, 1));
      fixture.api.sessions = async input => ({ list: input.is_tourist === 0 ? [record(42, 0)] : [], next_cursor: null });
      fixture.state.handleRealtimeEvent({ type: "transfer_out", data: { uid: 42, is_tourist: 1 } }); await settlePage();
      fixture.state.handleRealtimeEvent({ type: "mssage_num", data: { uid: 42, is_tourist: 1, num: 9, recored: record(42, 1, 9) } });
      fixture.state.handleRealtimeEvent({ type: "transfer", data: { recored: record(42, 1, 10) } }); await settlePage();
      expect(fixture.state.sessions.value.map((row: SessionRecord) => [row.to_uid, row.is_tourist])).toEqual([[42, 0]]);
      expect(fixture.state.selected.value).toBeNull(); expect(fixture.state.messages.value).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  it("does not send an upload completed after selecting the same numeric peer in another domain", async () => {
    const upload = deferred<{ url: string }>(), fixture = await pageFixture({ uploadImage: () => upload.promise });
    try {
      await fixture.state.openSession(record(42, 1));
      const pending = fixture.state.sendSelectedImage({ currentTarget: { value: "selected", files: [new File([new Uint8Array([1])], "image.png", { type: "image/png" })] } });
      await fixture.state.openSession(record(42, 0)); upload.resolve({ url: "/api/assets/5" }); await pending;
      expect(fixture.sockets.flatMap(socket => socket.sent).filter(event => event.type === "chat" && event.data.msn_type === 3)).toEqual([]);
      expect(fixture.state.uploadingImage.value).toBe(false);
    } finally { fixture.cleanup(); }
  });

  it("keeps the latest same-second message summary when an older message arrives afterward", async () => {
    const fixture = await pageFixture();
    try {
      fixture.state.handleRealtimeEvent({ type: "reply", data: { ...historyMessage(202, 42, 0), add_time: 1800000000, msn: "new-summary" } });
      fixture.state.handleRealtimeEvent({ type: "reply", data: { ...historyMessage(201, 42, 0), add_time: 1800000000, msn: "old-summary" } });
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).message).toBe("new-summary");
      expect(fixture.state.sessions.value.filter((row: SessionRecord) => row.to_uid === 42)).toHaveLength(2);
      // Use actual DO list-delivery frames, including its real message identity.
      // The DTO record ID remains unchanged across these same-second messages.
      const background = socket(identity({ toUid: 0 })), backend = room([background]);
      const deliverSummary = async (id: number, domain: 0 | 1, time: number, content: string, type = 1, unread = 4) => {
        const value = message(domain); value.id = id; value.msn = content; value.msn_type = type; value.add_time = time;
        value.recored.message = content; value.recored.message_type = type; value.recored.update_time = time; value.recored.mssage_num = unread;
        await backend.instance.deliver(value); fixture.state.handleRealtimeEvent(background.sent.at(-1));
      };
      await deliverSummary(301, 0, 1800000001, "background-first", 1, 1);
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).message).toBe("background-first");
      await deliverSummary(303, 0, 1800000001, "background-newer", 1, 3);
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).message).toBe("background-newer");
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).mssage_num).toBe(3);
      await deliverSummary(302, 0, 1800000001, "background-late", 1, 2);
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).mssage_num).toBe(3);
      await deliverSummary(300, 0, 1800000000, "background-older-time", 1, 1);
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).message).toBe("background-newer");
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).mssage_num).toBe(3);
      fixture.state.handleRealtimeEvent({ type: "mssage_num", data: { uid: 42, is_tourist: 0, num: 0, recored: {} } });
      expect(fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 0).mssage_num).toBe(0);
      await deliverSummary(401, 1, 1800000002, "cross-domain-private-text", 3);
      const tourist = fixture.state.sessions.value.find((row: SessionRecord) => row.is_tourist === 1);
      expect(tourist.message).toBe(""); expect(tourist.message_type).toBe(3);
      expect(fixture.state.sessionMessagePreview(tourist.message, tourist.message_type)).toBe("[图片]");
      expect(fixture.state.sessions.value[0].is_tourist).toBe(1);
      expect(fixture.state.sessions.value.filter((row: SessionRecord) => row.to_uid === 42)).toHaveLength(2);
    } finally { fixture.cleanup(); }
  });
});
