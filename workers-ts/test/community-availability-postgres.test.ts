import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import { createContainerFromDb, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { community, communityComment, communityRelevance, communityTopic, communityUser, storeProduct,
  storeProductLog, systemAttachment, systemAttachmentCategory, systemConfig, systemLog, systemUserLevel,
  user, userFriends, userRelation } from "@/models/schema";
import { AdminCommunitySettingsService, COMMUNITY_SETTING_KEYS, type CommunitySettings } from "@/services/community/AdminCommunitySettingsService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { isCommunityOpen } from "@/middleware/community-open";
import { createToken, md5 } from "@/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";
import { communityAvailabilityRoutes } from "./helpers/communityAvailabilityRoutes";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned availability SQL"); return wiring.container; },
}));
type Row = Record<string, any>;
type Snapshot = Record<string, Row[]>;
const stable = (row: Row) => JSON.stringify(row);
const canonical = (state: Snapshot): Snapshot => Object.fromEntries(Object.entries(state).map(([key, rows]) =>
  [key, rows.slice().sort((a, b) => stable(a).localeCompare(stable(b)))]));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const closedMessage = { station: "站点升级中，请稍候访问", community: "社区暂未开放" } as const;

// Admission is checked on real raw SQL. It is not a global configuration/business
// commit lock: requests already admitted may finish after a later close commits.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native PHP community availability admission", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, container: Container, env: Env, token: string;
  const cache = new Map<string, string>();
  const kv = { get: vi.fn(async (key: string) => cache.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
    delete: vi.fn(async (key: string) => { cache.delete(key); }) };
  const bucket = { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const app = createApp();
  const tables = ["community", "community_comment", "community_relevance", "community_topic", "community_user",
    "store_product", "store_product_log", "system_attachment", "system_attachment_category", "system_config",
    "system_log", "system_user_level", "user", "user_friends", "user_relation"];
  beforeAll(async () => {
    f = await financePostgres([community, communityComment, communityRelevance, communityTopic, communityUser,
      storeProduct, storeProductLog, systemAttachment, systemAttachmentCategory, systemConfig, systemLog,
      systemUserLevel, user, userFriends, userRelation], { namespace: "public" });
    container = createContainerFromDb(f.db); wiring.container = container;
    env = { APP_KEY: "owned-community-availability", NODE_ENV: "test", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "",
      CONFIG_KV: kv, ASSETS_BUCKET: bucket, ORDER_QUEUE: { send: vi.fn(async () => {}) } } as unknown as Env;
    token = (await createToken(11, "api", md5("synthetic-availability-password"), env.APP_KEY)).token;
  }, 30_000);
  afterAll(async () => { wiring.container = undefined; await f?.close(); });
  beforeEach(async () => {
    await f.reset(); cache.clear();
    kv.get.mockReset().mockImplementation(async key => cache.get(key) ?? null);
    kv.put.mockReset().mockImplementation(async (key, value) => { cache.set(key, value); });
    kv.delete.mockReset().mockImplementation(async key => { cache.delete(key); });
    for (const mock of Object.values(bucket)) mock.mockClear();
    wiring.container = container;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Availability fixtures forbid provider I/O"));
    await f.db.insert(user).values([11, 22].map(uid => ({ uid, account: `availability-${uid}`,
      pwd: "synthetic-availability-password", nickname: `作者${uid}`, status: 1 })));
    await f.db.insert(communityUser).values({ id: 220, type: 2, relationId: 22, likeNum: 7 });
    await f.db.insert(community).values({ id: 1, type: 2, relationId: 22, title: "开关准入主帖", status: 1, isVerify: 1,
      likeNum: 7, playNum: 2, shareNum: 3 });
    await f.db.insert(communityTopic).values({ id: 9, name: "开关话题", status: 1 });
    await f.db.insert(communityComment).values({ id: 1, communityId: 1, type: 2, uid: 22, content: "已有评论", isVerify: 1, isShow: 1 });
    await f.db.insert(communityRelevance).values({ leftId: 1, rightId: 9, type: "community_topic" });
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); for (const mock of Object.values(bucket)) expect(mock).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function snapshot(db: DbClient = f.db): Promise<Snapshot> {
    const state: Snapshot = {};
    for (const name of tables) {
      const rows = await db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`);
      state[name] = rows.map(row => row.row);
    }
    state.__sequences = await db.execute(sql`SELECT sequencename AS name, last_value::text AS last FROM pg_sequences
      WHERE schemaname='public' ORDER BY sequencename`);
    return canonical(state);
  }
  async function setting(name: string, value: string) {
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, name));
    await f.db.insert(systemConfig).values({ menuName: name, value });
  }
  async function request(path: string, method = "GET", viewer: "anonymous" | "valid" | "stale" = "anonymous", body?: string) {
    const response = await app.request(path, { method,
      headers: { "content-type": "application/json", ...(viewer === "anonymous" ? {} : { Authorization: `Bearer ${viewer === "valid" ? token : "stale-fixture-token"}` }) },
      ...(body === undefined ? {} : { body }) }, env);
    return { response, body: await response.json() as Row };
  }
  function rejected(result: Awaited<ReturnType<typeof request>>, domain: keyof typeof closedMessage) {
    expect(result.response.status).toBe(200); expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toEqual({ status: 410010, msg: closedMessage[domain], data: null });
  }
  it.each(communityAvailabilityRoutes.flatMap(route => (["station", "community"] as const).map(domain => ({ ...route, domain }))))(
    "$domain closed rejects $method $path before auth/body/business I/O", async ({ method, path, domain }) => {
      await setting(domain === "station" ? "station_open" : "community_status", "0");
      cache.set("cfg_community_status", "1"); cache.set("cfg_station_open", "1");
      const before = await snapshot();
      for (const viewer of ["anonymous", "valid", "stale"] as const) {
        rejected(await request(path.replace(/:[A-Za-z]+/g, "1"), method, viewer,
          method === "GET" ? undefined : "{"), domain);
      }
      expect(await snapshot()).toEqual(before); expect(kv.get).not.toHaveBeenCalled(); expect(kv.put).not.toHaveBeenCalled();
    });
  it("keeps config public and no-store even when both gates are closed and gives station precedence", async () => {
    await setting("station_open", "0"); await setting("community_status", "0");
    const before = await snapshot(); const result = await request("/api/community/config", "GET", "stale");
    expect(result.response.status).toBe(200); expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toEqual({ status: 200, msg: "ok", data: { community_status: 0, community_comment_status: 1, community_comment_add: 1 } });
    rejected(await request("/api/community/state/1"), "station"); expect(await snapshot()).toEqual(before);
  });
  it.each([
    { raw: undefined, open: true },
    ...["0", "false", "null", '\"\"', '\"0\"', "[]", "{}", "not-json", ""].map(raw => ({ raw, open: false })),
    ...["1", "-1", '\"false\"', '\"00\"', '\" \"', "[0]", '{\"enabled\":0}'].map(raw => ({ raw, open: true })),
  ])("reads raw community JSON $raw with presence and reports open=$open consistently without writes", async ({ raw, open }) => {
    if (raw !== undefined) await setting("community_status", raw);
    cache.set("cfg_community_status", open ? "0" : "1");
    const before = await snapshot(); expect(await isCommunityOpen(container)).toBe(open);
    const config = await request("/api/community/config"); expect(config.body.data.community_status).toBe(open ? 1 : 0);
    const topics = await request("/api/community/topic");
    if (open) expect(topics.body).toMatchObject({ status: 200, data: [{ id: 9, name: "开关话题" }] });
    else rejected(topics, "community");
    expect(kv.get.mock.calls.some(([key]) => key === "cfg_community_status")).toBe(false);
    expect(kv.put.mock.calls.some(([key]) => key === "cfg_community_status")).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  it("chooses platform sort then latest id, ignoring store rows without changing duplicate history", async () => {
    await f.db.insert(systemConfig).values([
      { menuName: "community_status", value: "0", sort: 10 },
      { menuName: "community_status", value: "1", sort: 9 },
      { menuName: "community_status", value: "0", sort: 10 },
      { menuName: "community_status", value: "1", sort: 999, isStore: 1 },
    ]);
    const before = await snapshot(); expect(await isCommunityOpen(container)).toBe(false);
    rejected(await request("/api/community/topic"), "community"); expect(await snapshot()).toEqual(before);
    await f.db.insert(systemConfig).values({ menuName: "community_status", value: "1", sort: 10 });
    const reopened = await snapshot(); expect(await isCommunityOpen(container)).toBe(true);
    expect((await request("/api/community/state/1")).body.status).toBe(200); expect(await snapshot()).toEqual(reopened);
  });
  it("restores original required/optional authentication when both switches are open", async () => {
    await setting("station_open", "1"); await setting("community_status", "1"); const before = await snapshot();
    for (const route of communityAvailabilityRoutes.filter(row => row.auth === "required")) {
      expect((await request(route.path.replace(/:[A-Za-z]+/g, "1"), route.method, "anonymous",
        route.method === "GET" ? undefined : "{")).body.status).toBe(410000);
    }
    expect((await request("/api/community/state/1")).body.status).toBe(200);
    expect((await request("/api/community/state/1", "GET", "valid")).body.status).toBe(200);
    expect((await request("/api/community/user_info/22", "GET", "valid")).body.status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  const settings: CommunitySettings = { community_status: 1, community_verify: 1, community_video_verify: 1,
    community_comment_status: 1, community_comment_add: 1, community_comment_verify: 0 };
  const actor = { id: 7, name: "owned-auditor", ip: "127.0.0.1" };
  async function seedSettings() { await f.db.insert(systemConfig).values(COMMUNITY_SETTING_KEYS.map(menuName => ({ menuName, value: String(settings[menuName]) }))); }
  function expectCloseReceipt(before: Snapshot, after: Snapshot, started: number) {
    const expected = structuredClone(before); expected.system_config = expected.system_config.map(row => row.menu_name === "community_status" ? { ...row, value: "0" } : row);
    expect(after.system_log).toHaveLength(1); const log = after.system_log[0];
    expect(log).toEqual({ id: log.id, store_id: 0, admin_id: 7, admin_name: actor.name, path: "/adminapi/community/settings", page: "/community",
      method: "POST", action: "community.settings.update;enabled=4", ip: actor.ip, type: "community", add_time: log.add_time, merchant_id: 0 });
    expect(log.add_time).toBeGreaterThanOrEqual(started); expect(log.add_time).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const seq = expected.__sequences.find(row => row.name === "system_log_id_seq")!;
    expect(log.id).toBe(seq.last === null ? 1 : Number(seq.last) + 1); seq.last = String(log.id); expected.system_log = [log];
    expect(after).toEqual(canonical(expected));
  }
  it("uses the real six-key Admin save with an exact config/audit receipt and ignores a late old KV refill", async () => {
    await seedSettings(); const before = await snapshot(), started = Math.floor(Date.now() / 1000);
    const pendingPut = deferred(), releasePut = deferred();
    kv.put.mockImplementation(async (key, value) => { if (key === "cfg_community_status") { pendingPut.resolve(); await releasePut.promise; } cache.set(key, value); });
    const oldRead = new SystemConfigService(container, env).get("community_status");
    try {
      await pendingPut.promise;
      const result = await new AdminCommunitySettingsService(container, env).save({ ...settings, community_status: 0 }, actor);
      expect(result).toMatchObject({ settings: { community_status: 0 }, verified: true });
      expectCloseReceipt(before, await snapshot(), started);
      expect(kv.delete.mock.calls.map(([key]) => key).sort()).toEqual(COMMUNITY_SETTING_KEYS.map(key => "cfg_" + key).sort());
    } finally { releasePut.resolve(); }
    expect(await oldRead).toBe("1"); expect(cache.get("cfg_community_status")).toBe("1");
    const closed = await snapshot(); rejected(await request("/api/community/state/1", "GET", "valid"), "community");
    expect((await request("/api/community/config")).body.data.community_status).toBe(0); expect(await snapshot()).toEqual(closed);
  });
  it("keeps a committed close authoritative when post-commit cache invalidation fails and does not replay the save", async () => {
    await seedSettings(); const before = await snapshot(), started = Math.floor(Date.now() / 1000);
    kv.delete.mockRejectedValue(Error("owned KV deletion unavailable"));
    await expect(new AdminCommunitySettingsService(container, env).save({ ...settings, community_status: 0 }, actor)).rejects.toThrow("owned KV deletion unavailable");
    expectCloseReceipt(before, await snapshot(), started);
    kv.get.mockRejectedValue(Error("owned KV read unavailable")); kv.put.mockRejectedValue(Error("owned KV write unavailable"));
    const closed = await snapshot(); rejected(await request("/api/community/state/1", "GET", "valid"), "community");
    expect(await isCommunityOpen(container)).toBe(false); expect(await snapshot()).toEqual(closed);
  });
  it("allows an already admitted real write to finish after a close, then rejects the next intent without any write", async () => {
    await seedSettings();
    await withFinancePeers(f.db, async ([holder, waiting, admin]) => {
      await holder.exec("BEGIN; SELECT id FROM community WHERE id=1 FOR UPDATE");
      wiring.container = createContainerFromDb(waiting.db);
      const work = outcome(request("/api/community/share/1", "GET", "valid"));
      try {
        await waitForFinanceBlock(f.db, waiting.pid, holder.pid);
        await new AdminCommunitySettingsService(createContainerFromDb(admin.db), env).save({ ...settings, community_status: 0 }, actor);
        const closed = await snapshot(); await holder.exec("COMMIT");
        const result = await work; expect(result.ok).toBe(true); if (!result.ok) throw result.error;
        expect(result.value.body).toMatchObject({ status: 200, data: { shareNum: 4 } });
        const expected = structuredClone(closed); expected.community = expected.community.map(row => row.id === 1 ? { ...row, share_num: 4 } : row);
        expect(await snapshot()).toEqual(canonical(expected));
      } finally { await holder.exec("ROLLBACK"); wiring.container = container; await work; }
    });
    const closed = await snapshot(); rejected(await request("/api/community/share/1", "GET", "valid"), "community"); expect(await snapshot()).toEqual(closed);
  });
  it("preserves a real database failure as an error instead of issuing a definitive closed receipt", async () => {
    const before = await snapshot(); await f.db.execute(sql`ALTER TABLE system_config RENAME TO unavailable_community_config`);
    try { const result = await request("/api/community/state/1", "GET", "valid"); expect(result.body.status).toBe(500); }
    finally { await f.db.execute(sql`ALTER TABLE unavailable_community_config RENAME TO system_config`); }
    expect(await snapshot()).toEqual(before);
  });
});
