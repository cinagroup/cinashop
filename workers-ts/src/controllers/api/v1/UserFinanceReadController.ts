import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { jsonFail, jsonOk } from "@/utils/json";
import { UserFinanceReadService } from "@/services/user/UserFinanceReadService";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Operation = (service: UserFinanceReadService, uid: number) => Promise<unknown>;

async function read(c: C, operation: Operation) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await operation(new UserFinanceReadService(c.get("container"), c.env), uid));
}

export const integralList = (c: C) => read(c, (s, uid) => s.integralList(uid, c.req.query()));
export const extractBank = (c: C) => read(c, (s, uid) => s.extractBank(uid));
export const spreadCount = (c: C) => read(c, (s, uid) => s.spreadCount(uid, c.req.param("type") ?? ""));
export const brokerageRank = (c: C) => read(c, (s, uid) => s.brokerageRank(uid, c.req.query()));
export const spreadRank = (c: C) => read(c, (s, uid) => s.spreadRank(uid, c.req.query()));
export const spreadOrder = (c: C) => read(c, async (s, uid) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  return s.spreadOrder(uid, raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {});
});
