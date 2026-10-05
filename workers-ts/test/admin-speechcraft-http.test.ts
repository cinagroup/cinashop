import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createContainerFromDb, type Container } from "../src/lib/di";
import { legacyCategory, storeServiceSpeechcraft, systemAdmin, systemLog, systemMenus,
  systemRole } from "../src/models/schema";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("../src/lib/di", async original => ({
  ...await original<typeof import("../src/lib/di")>(),
  createContainer: () => {
    if (!wiring.container) throw Error("Isolated speechcraft fixture unavailable");
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error("Isolated speechcraft fixture unavailable");
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: "local-speechcraft-http-only", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
const password = "speechcraft-role";
const identities = { reader: 9751, manager: 9752, service: 9753, serviceManager: 9754,
  unrelated: 9755 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;

beforeEach(async () => {
  fixture = await financePostgres([legacyCategory, storeServiceSpeechcraft, systemAdmin, systemLog,
    systemMenus, systemRole]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(legacyCategory).values([
    { id: 81, ownerId: 0, type: 0, group: 1, name: "平台售后", sort: 8 },
    { id: 82, ownerId: 1, type: 0, group: 1, name: "客服私人", sort: 9 },
  ]);
  await fixture.db.insert(storeServiceSpeechcraft).values([
    { id: 91, kefuId: 0, cateId: 81, title: "退货", message: "平台退货说明", sort: 8, addTime: 1780000000 },
    { id: 92, kefuId: 1, cateId: 82, title: "私人", message: "客服私人说明", sort: 9, addTime: 1780000001 },
  ]);
  const rules: Record<Identity, string> = { reader: "speechcraft.view", manager: "speechcraft.manage",
    service: "service.view", serviceManager: "service.manage", unrelated: "config.view" };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Speechcraft ${name}`, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `speechcraft-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as Identity, (await createToken(id, "admin", md5(password), env.APP_KEY)).token);
  }
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(base: string, identity: Identity | "anonymous", path: string,
  method = "GET", data?: Record<string, unknown>) {
  const response = await app.request(`${base}/${path}`, {
    method, headers: identity === "anonymous" ? {} : { Authorization: `Bearer ${tokens.get(identity)}`,
      ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { httpStatus: response.status, cache: response.headers.get("Cache-Control"),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(["/adminapi", "/api/admin"])("isolates speechcraft.view from chat and other roles on %s", async base => {
  for (const identity of ["anonymous", "service", "serviceManager", "unrelated"] as const) {
    expect((await request(base, identity, "wechat/speechcraft")).body.status).not.toBe(200);
    expect((await request(base, identity, "wechat/speechcraft/categories")).body.status).not.toBe(200);
    expect((await request(base, identity, "wechat/speechcraft/91")).body.status).not.toBe(200);
  }
  for (const identity of ["reader", "manager"] as const) {
    const list = await request(base, identity, "wechat/speechcraft?page=1&limit=10&cate_id=81");
    expect(list.body).toMatchObject({ status: 200, data: { count: 1, page: 1, limit: 10,
      list: [{ id: 91, kefu_id: 0, cate_id: 81 }] } });
    expect(list.cache).toContain("no-store");
    const categories = await request(base, identity, "wechat/speechcraft/categories");
    expect(categories.body).toMatchObject({ status: 200, data: [{ id: 81, name: "平台售后" }] });
    expect((await request(base, identity, "wechat/speechcraft/92")).body.status).toBe(404);
  }
});

it.each(["/adminapi", "/api/admin"])("restricts both category and phrase writes to speechcraft.manage on %s", async base => {
  const payload = { cate_id: 81, title: "新话术", message: "新的平台话术", sort: 2 };
  for (const identity of ["anonymous", "reader", "service", "serviceManager", "unrelated"] as const) {
    expect((await request(base, identity, "wechat/speechcraft/categories", "POST", { name: "误分类", sort: 1 })).body.status)
      .not.toBe(200);
    expect((await request(base, identity, "wechat/speechcraft/categories/81", "PUT", { name: "越权", sort: 1 })).body.status)
      .not.toBe(200);
    expect((await request(base, identity, "wechat/speechcraft/categories/81", "DELETE")).body.status).not.toBe(200);
    expect((await request(base, identity, "wechat/speechcraft", "POST", payload)).body.status).not.toBe(200);
    expect((await request(base, identity, "wechat/speechcraft/91", "PUT", payload)).body.status).not.toBe(200);
    expect((await request(base, identity, "wechat/speechcraft/91", "DELETE")).body.status).not.toBe(200);
  }
  expect((await request(base, "manager", "wechat/speechcraft/categories/82", "PUT", { name: "越权", sort: 1 })).body.status)
    .toBe(404);
  expect((await request(base, "manager", "wechat/speechcraft/92", "PUT", payload)).body.status).toBe(404);
  expect((await request(base, "manager", "wechat/speechcraft/categories", "POST",
    { name: "\u0000分类", sort: 1 })).body.status).toBe(400);
  expect((await request(base, "manager", "wechat/speechcraft", "POST",
    { ...payload, message: "含\u0000内容" })).body.status).toBe(400);
  const category = await request(base, "manager", "wechat/speechcraft/categories", "POST", { name: "平台新增", sort: 4 });
  expect(category.body).toMatchObject({ status: 200, data: { id: expect.any(Number) } });
  const categoryId = category.body.data.id as number;
  expect((await request(base, "manager", `wechat/speechcraft/categories/${categoryId}`, "PUT",
    { name: "平台新分类", sort: 5 })).body.status).toBe(200);
  const created = await request(base, "manager", "wechat/speechcraft", "POST",
    { ...payload, cate_id: categoryId });
  expect(created.body).toMatchObject({ status: 200, data: { id: expect.any(Number) } });
  const phraseId = created.body.data.id as number;
  expect((await request(base, "manager", `wechat/speechcraft/${phraseId}`, "PUT",
    { ...payload, cate_id: categoryId, title: "改名" })).body.status).toBe(200);
  expect((await request(base, "manager", `wechat/speechcraft/categories/${categoryId}`, "DELETE")).body.status).toBe(200);
  const orphan = await request(base, "reader", `wechat/speechcraft/${phraseId}`);
  expect(orphan.body).toMatchObject({ status: 200, data: { cate_id: categoryId, title: "改名" } });
  expect((await request(base, "manager", `wechat/speechcraft/${phraseId}`, "PUT",
    { ...payload, cate_id: categoryId, title: "孤儿可编辑" })).body.status).toBe(200);
  expect((await request(base, "manager", "wechat/speechcraft", "POST",
    { ...payload, cate_id: categoryId, message: "新内容" })).body.status).not.toBe(200);
  expect((await request(base, "manager", `wechat/speechcraft/${phraseId}`, "DELETE")).body.status).toBe(200);
  expect((await request(base, "reader", `wechat/speechcraft/${phraseId}`)).body.status).toBe(404);
});
