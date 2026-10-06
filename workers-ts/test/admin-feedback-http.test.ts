import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createContainerFromDb, type Container } from "../src/lib/di";
import { storeServiceFeedback, systemAdmin, systemLog, systemMenus, systemRole } from "../src/models/schema";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("../src/lib/di", async original => ({
  ...await original<typeof import("../src/lib/di")>(),
  createContainer: () => {
    if (!wiring.container) throw Error("Isolated feedback fixture unavailable");
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error("Isolated feedback fixture unavailable");
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: "local-feedback-http-only", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
const password = "feedback-role";
const identities = { reader: 9701, manager: 9702, service: 9703, unrelated: 9704,
  serviceManager: 9705 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;

beforeEach(async () => {
  fixture = await financePostgres([storeServiceFeedback, systemAdmin, systemLog, systemMenus, systemRole]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(storeServiceFeedback).values([
    { id: 71, uid: 0, relaName: "匿名", phone: "13800000001", content: "&lt;反馈&gt;", addTime: 1789819200 },
    { id: 72, uid: 99888, relaName: "历史用户", phone: "13800000002", content: "删除用", addTime: 1789819300 },
  ]);
  const rules: Record<Identity, string> = { reader: "feedback.view", manager: "feedback.manage",
    service: "service.view", serviceManager: "service.manage", unrelated: "config.view" };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Feedback ${name}`, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `feedback-${name}`, pwd: password, roles: String(id), level: 1,
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

it.each(["/adminapi", "/api/admin"])("isolates feedback.view from service and other Admin roles on %s", async base => {
  for (const identity of ["anonymous", "service", "serviceManager", "unrelated"] as const) {
    expect((await request(base, identity, "feedback")).body.status).not.toBe(200);
    expect((await request(base, identity, "feedback/71")).body.status).not.toBe(200);
  }
  for (const identity of ["reader", "manager"] as const) {
    const list = await request(base, identity, "feedback?page=1&limit=15&title=%E5%8C%BF%E5%90%8D");
    expect(list.body).toMatchObject({ status: 200, data: { count: 1, data: [{ id: 71, uid: 0 }] } });
    expect(list.cache).toContain("no-store");
    const detail = await request(base, identity, "feedback/72");
    expect(detail.body).toMatchObject({ status: 200, data: { id: 72, uid: 99888 } });
  }
});

it.each(["/adminapi", "/api/admin"])("allows only feedback.manage to note/process/delete on %s", async base => {
  for (const identity of ["anonymous", "reader", "service", "serviceManager", "unrelated"] as const) {
    expect((await request(base, identity, "feedback/71", "PUT", { make: "误操作", status: 1 })).body.status).not.toBe(200);
    expect((await request(base, identity, "feedback/72", "DELETE")).body.status).not.toBe(200);
  }
  expect((await request(base, "manager", "feedback/71", "PUT", { make: "已回复", status: 1 })).body.status).toBe(200);
  expect((await request(base, "manager", "feedback/71")).body.data).toMatchObject({ status: 1, make: "已回复" });
  expect((await request(base, "manager", "feedback/72", "DELETE")).body.status).toBe(200);
  expect((await request(base, "manager", "feedback/72")).body.status).toBe(404);
});
