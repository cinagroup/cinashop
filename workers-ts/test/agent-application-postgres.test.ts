import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppVariables, Env } from "@/env";
import { createContainerFromDb } from "@/lib/di";
import { agreement, divisionApply, promoterApply, user } from "@/models/schema";
import { applyAgent } from "@/controllers/api/v1/DivisionController";
import { applyPromoter } from "@/controllers/api/v1/PromoterApplicationController";
import { financePostgres } from "./helpers/financePostgres";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";
import { DivisionManagementService } from "@/services/division/DivisionManagementService";

const state = vi.hoisted(() => ({
  codes: new Map<string, { uid: number; purpose: string; code: string }>(),
  locks: new Map<string, string>(),
}));

vi.mock("@/utils/cache", () => ({
  getRedis: () => ({
    set: async (key: string, token: string, options: { nx?: boolean }) => {
      if (options.nx && state.locks.has(key)) return null;
      state.locks.set(key, token);
      return "OK";
    },
    eval: async (_script: string, keys: string[], args: string[]) => {
      if (state.locks.get(keys[0]) === args[0]) { state.locks.delete(keys[0]); return 1; }
      return 0;
    },
  }),
  cacheGet: async (key: string) => state.codes.get(key) ?? null,
  cacheDelete: async (key: string) => { state.codes.delete(key); return true; },
}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("agent application route on isolated PostgreSQL 16", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  const env = { UPSTASH_REDIS_URL: "https://redis.example.test", UPSTASH_REDIS_TOKEN: "isolated",
    CONFIG_KV: { get: async (key: string) => ["cfg_brokerage_func_status", "cfg_store_brokerage_statu"].includes(key) ? "1" : null,
      put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  const divisionKey = "user_verification_code_user_division_application_13800138000";
  const promoterKey = "user_verification_code_user_promoter_application_13800138000";
  const body = { division_name: "青山代理商", name: "Alice", phone: "13800138000",
    code: "998877", division_invite: 123456, images: ["/assets/one"] };

  beforeEach(async () => {
    state.codes.clear(); state.locks.clear();
    fixture = await financePostgres([user, divisionApply, promoterApply, agreement]);
    await fixture.db.insert(user).values([
      { uid: 10, account: "local-division", divisionType: 1, divisionStatus: 1,
        divisionInvite: 123456, divisionEndTime: 0, status: 1 },
      { uid: 11, account: "local-applicant", phone: "13800138000", divisionType: 0, status: 1 },
    ]);
    await fixture.db.insert(agreement).values({ type: 2, title: "本地代理协议", content: "<p>仅隔离测试</p>", status: 1 });
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); c.set("uid", 11); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.post("/api/division/agent/apply/:id", applyAgent);
    app.post("/api/user/promoter/apply/:id", applyPromoter);
  }, 60_000);
  afterEach(async () => { await fixture?.close(); }, 60_000);

  it("prevalidates, consumes only its own purpose once, and commits the applicant row", async () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
    const original = subtle.timingSafeEqual;
    if (!original) subtle.timingSafeEqual = (a, b) => {
      const left = new Uint8Array(a instanceof ArrayBuffer ? a : a.buffer, a instanceof ArrayBuffer ? 0 : a.byteOffset, a instanceof ArrayBuffer ? undefined : a.byteLength);
      const right = new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer, b instanceof ArrayBuffer ? 0 : b.byteOffset, b instanceof ArrayBuffer ? undefined : b.byteLength);
      return left.length === right.length && left.every((byte, index) => byte === right[index]);
    };
    const post = async (input: typeof body) => {
      const response = await app.request("/api/division/agent/apply/0", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      }, env);
      return response.json() as Promise<{ status: number; msg: string; data: { id: number } | null }>;
    };
    try {
      state.codes.set(divisionKey, { uid: 0, purpose: "user_division_application", code: body.code });
      await fixture.db.update(agreement).set({ status: 0 }).where(eq(agreement.type, 2));
      const disabledAgreement = await post(body);
      expect(disabledAgreement.status).not.toBe(200);
      expect(disabledAgreement.msg).toContain("代理商协议尚未启用");
      expect(state.codes.has(divisionKey)).toBe(true);
      expect(await fixture.db.select().from(divisionApply)).toHaveLength(0);
      await fixture.db.update(agreement).set({ status: 1 }).where(eq(agreement.type, 2));
      const badInvite = await post({ ...body, division_invite: 999999 });
      expect(badInvite.status).not.toBe(200);
      expect(badInvite.msg).toContain("事业部不存在");
      expect(state.codes.has(divisionKey)).toBe(true);
      const wrongPhone = await post({ ...body, phone: "13900139000" });
      expect(wrongPhone.status).not.toBe(200);
      expect(wrongPhone.msg).toContain("已绑定手机号");
      expect(state.codes.has(divisionKey)).toBe(true);
      state.codes.delete(divisionKey);
      state.codes.set(promoterKey, { uid: 0, purpose: "user_promoter_application", code: body.code });
      const wrongPurpose = await post(body);
      expect(wrongPurpose.status).not.toBe(200);
      expect(wrongPurpose.msg).toContain("验证码错误或已过期");
      expect(state.codes.has(promoterKey)).toBe(true);
      expect(await fixture.db.select().from(divisionApply)).toHaveLength(0);
      state.codes.set(divisionKey, { uid: 0, purpose: "user_division_application", code: body.code });
      const success = await post(body);
      expect(success.status, success.msg).toBe(200);
      expect(success.data?.id).toBeGreaterThan(0);
      expect(state.codes.has(divisionKey)).toBe(false);
      const rows = await fixture.db.select().from(divisionApply).where(eq(divisionApply.uid, 11));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ uid: 11, divisionName: body.division_name, name: body.name,
        phone: body.phone, divisionId: 10, divisionInvite: body.division_invite, images: '["/assets/one"]', status: 0 });
      const replay = await post(body);
      expect(replay.status).not.toBe(200);
      expect(replay.msg).toContain("验证码错误或已过期");
      expect(await fixture.db.select().from(divisionApply).where(eq(divisionApply.uid, 11))).toEqual(rows);
    } finally { subtle.timingSafeEqual = original; }
  });

  it("keeps the promoter and division SMS purposes separate at the actual promoter write route", async () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
    const original = subtle.timingSafeEqual;
    if (!original) subtle.timingSafeEqual = (a, b) => {
      const left = new Uint8Array(a instanceof ArrayBuffer ? a : a.buffer, a instanceof ArrayBuffer ? 0 : a.byteOffset, a instanceof ArrayBuffer ? undefined : a.byteLength);
      const right = new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer, b instanceof ArrayBuffer ? 0 : b.byteOffset, b instanceof ArrayBuffer ? undefined : b.byteLength);
      return left.length === right.length && left.every((byte, index) => byte === right[index]);
    };
    const input = { nickname: "Alice", real_name: "Alice Chen", phone: "13800138000", code: "042731" };
    const post = async () => {
      const response = await app.request("/api/user/promoter/apply/0", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      }, env);
      return response.json() as Promise<{ status: number; msg: string; data: { id: number } | null }>;
    };
    try {
      state.codes.set(divisionKey, { uid: 0, purpose: "user_division_application", code: input.code });
      const wrongPurpose = await post();
      expect(wrongPurpose.status).not.toBe(200);
      expect(wrongPurpose.msg).toContain("验证码错误或已过期");
      expect(state.codes.has(divisionKey)).toBe(true);
      expect(await fixture.db.select().from(promoterApply)).toHaveLength(0);
      state.codes.set(promoterKey, { uid: 0, purpose: "user_promoter_application", code: input.code });
      const success = await post();
      expect(success.status, success.msg).toBe(200);
      expect(success.data?.id).toBeGreaterThan(0);
      expect(state.codes.has(promoterKey)).toBe(false);
      const rows = await fixture.db.select().from(promoterApply).where(eq(promoterApply.uid, 11));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ uid: 11, nickname: input.nickname, realName: input.real_name,
        phone: input.phone, status: 0, isDel: 0 });
      const replay = await post();
      expect(replay.status).not.toBe(200);
      expect(replay.msg).toContain("验证码错误或已过期");
      expect(await fixture.db.select().from(promoterApply).where(eq(promoterApply.uid, 11))).toEqual(rows);
    } finally { subtle.timingSafeEqual = original; }
  });

  it("serializes agent resubmission after admin review via the applicant advisory lock", async () => {
    const [application] = await fixture.db.insert(divisionApply).values({ uid: 11, divisionId: 10,
      divisionName: body.division_name, name: body.name, phone: body.phone, divisionInvite: body.division_invite,
      images: JSON.stringify(body.images) }).returning({ id: divisionApply.id });
    await withFinancePeers(fixture.db, async ([blocker, adminPeer, applicantPeer]) => {
      await blocker.exec("BEGIN");
      try {
        await blocker.exec("SELECT pg_advisory_xact_lock(1147879249, 11)");
        const admin = new DivisionManagementService(createContainerFromDb(adminPeer.db));
        const applicant = new DivisionManagementService(createContainerFromDb(applicantPeer.db));
        const reviewed = outcome(admin.reviewApplication({ id: application.id, approved: true,
          divisionPercent: 0, divisionEndTime: 0, scope: { level: 0, divisionId: 0 } }));
        await waitForFinanceBlock(fixture.db, adminPeer.pid, blocker.pid);
        const resubmitted = outcome(applicant.submitApplication({ uid: 11, id: application.id,
          divisionName: body.division_name, name: body.name, phone: body.phone,
          divisionInvite: body.division_invite, images: body.images }));
        await waitForFinanceBlock(fixture.db, applicantPeer.pid, blocker.pid);
        await blocker.exec("COMMIT");
        const [reviewResult, submitResult] = await Promise.all([reviewed, resubmitted]);
        expect(reviewResult.ok, reviewResult.ok ? undefined : String(reviewResult.error)).toBe(true);
        expect(submitResult.ok).toBe(false);
        if (!submitResult.ok) expect(String(submitResult.error)).toContain("已经拥有事业部角色");
      } finally { await blocker.exec("ROLLBACK"); }
    });
  });

  it("serializes agent resubmission with role removal without a row/advisory deadlock", async () => {
    await fixture.db.update(user).set({ divisionType: 2, divisionStatus: 1, divisionId: 10,
      agentId: 11, divisionPercent: 0 }).where(eq(user.uid, 11));
    await fixture.db.insert(divisionApply).values({ uid: 11, divisionId: 10,
      divisionName: body.division_name, name: body.name, phone: body.phone, divisionInvite: body.division_invite,
      images: JSON.stringify(body.images) });
    await withFinancePeers(fixture.db, async ([blocker, adminPeer, applicantPeer]) => {
      await blocker.exec("BEGIN");
      try {
        await blocker.exec("SELECT pg_advisory_xact_lock(1147879249, 11)");
        const admin = new DivisionManagementService(createContainerFromDb(adminPeer.db));
        const applicant = new DivisionManagementService(createContainerFromDb(applicantPeer.db));
        const removed = outcome(admin.deleteRole(11, { level: 0, divisionId: 0 }));
        await waitForFinanceBlock(fixture.db, adminPeer.pid, blocker.pid);
        const submitted = outcome(applicant.submitApplication({ uid: 11,
          divisionName: body.division_name, name: body.name, phone: body.phone,
          divisionInvite: body.division_invite, images: body.images }));
        await waitForFinanceBlock(fixture.db, applicantPeer.pid, blocker.pid);
        await blocker.exec("COMMIT");
        const [removeResult, submitResult] = await Promise.all([removed, submitted]);
        expect(removeResult.ok, removeResult.ok ? undefined : String(removeResult.error)).toBe(true);
        expect(submitResult.ok, submitResult.ok ? undefined : String(submitResult.error)).toBe(true);
        const active = await fixture.db.select().from(divisionApply).where(eq(divisionApply.isDel, 0));
        expect(active).toHaveLength(1);
        expect(active[0].uid).toBe(11);
      } finally { await blocker.exec("ROLLBACK"); }
    });
  });
});
