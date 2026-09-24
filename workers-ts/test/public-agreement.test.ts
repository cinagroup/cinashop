import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Container } from "../src/lib/di";
import type { AppVariables, Env } from "../src/env";
import { agreement } from "../src/models/schema";
import { getAgreement } from "../src/controllers/api/v1/PublicController";
import { readVisibleAgreement } from "../src/services/user/PublicAgreementService";
import { financePostgres } from "./helpers/financePostgres";

describe("public PHP agreement contract", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;

  beforeAll(async () => {
    fixture = await financePostgres([agreement]);
    container = { db: fixture.db } as Container;
    await fixture.db.insert(agreement).values([
      { id: 1, type: 1, title: "会员服务协议", content: "<p>会员说明</p>", sort: 5, status: 1, addTime: 1700000000 },
      { id: 2, type: 2, title: "推广协议", content: "<p>推广说明</p>", sort: 2, status: 1, addTime: 1700000001 },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it("routes the public path to the agreement table rather than user_agreement cache", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('v1Routes.get("/agreement/:type", PublicController.getAgreement)');
    expect(routes).toContain('v1Routes.get("/user_agreement/:type", PublicController.getUserAgreement)');
  });

  it("returns only visible exact-type rows with PHP field names and envelope", async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); await next(); });
    app.get("/api/agreement/:type", getAgreement);
    for (const [type, title] of [["1", "会员服务协议"], ["2", "推广协议"]]) {
      const response = await app.request(`http://localhost/api/agreement/${type}`);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.status).toBe(200);
      const data = body.data as Record<string, unknown>;
      expect(Object.keys(data)).toEqual(["member_explain"]);
      const record = data.member_explain as Record<string, unknown>;
      expect(record).toMatchObject({ type: Number(type), title, status: 1 });
      expect(Object.keys(record)).toEqual(["id", "type", "title", "content", "sort", "status", "add_time"]);
      expect(record.content).not.toBe("用户协议");
    }
  });

  it("hides disabled records and fails closed on unsupported or ambiguous types", async () => {
    // The unrelated agent row stays visible: a disabled member row cannot fall back to it.
    await fixture.db.update(agreement).set({ status: 0 }).where(eq(agreement.type, 1));
    expect(await readVisibleAgreement(container, 1)).toEqual([]);
    expect((await readVisibleAgreement(container, 2))).toMatchObject({ type: 2, status: 1 });

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); await next(); });
    app.get("/api/agreement/:type", getAgreement);
    const hidden = await (await app.request("http://localhost/api/agreement/1")).json() as Record<string, unknown>;
    expect(hidden.data).toEqual({ member_explain: [] });
    for (const type of ["0", "3", "01", "payVip", "user"]) {
      const response = await (await app.request(`http://localhost/api/agreement/${type}`)).json() as Record<string, unknown>;
      expect(response.status).toBe(400);
      expect(response.data).toBeNull();
    }
  });
});
