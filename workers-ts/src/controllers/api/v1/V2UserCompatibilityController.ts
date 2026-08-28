import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { CapitalFlowService } from "@/services/finance/CapitalFlowService";
import {
  parseLegacyUserLedgerQuery,
  V2UserCompatibilityService,
} from "@/services/user/V2UserCompatibilityService";
import { WechatAuthService } from "@/services/wechat/WechatAuthService";
import { clientIp } from "@/controllers/api/v1/UserBehaviorController";
import { readBoundedJsonObject } from "@/utils/request-body";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_PROFILE_BODY_BYTES = 8 * 1_024;

function service(c: C): V2UserCompatibilityService {
  return new V2UserCompatibilityService(c.get("container"));
}

function uid(c: C): number {
  const value = c.get("uid");
  if (!value) throw new ValidateException("请先登录");
  return value;
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function phpInteger(value: unknown): number {
  const match = String(value ?? "").trim().match(/^[+-]?\d+/);
  return match ? Number(match[0]) : 0;
}

async function response<T>(c: C, operation: () => Promise<T>, message = "ok") {
  noStore(c);
  try {
    return jsonOk(c, await operation(), message);
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}

/** POST /api/v2/user/user_update — Mini Program profile compatibility contract. */
export async function updateRoutineProfile(c: C) {
  return response(c, async () => {
    const body = await readBoundedJsonObject(c.req.raw, MAX_PROFILE_BODY_BYTES);
    const userInfo = objectValue(body.userInfo);
    if (!userInfo) throw new ValidateException("参数有误");
    await service(c).updateRoutineProfile(uid(c), userInfo, clientIp(c));
    return null;
  }, "更新成功");
}

/** GET /api/v2/user/wechat?code= — refresh only the caller's verified official identity. */
export async function refreshWechatProfile(c: C) {
  return response(c, async () => {
    const code = String(c.req.query("code") ?? "").trim();
    if (!code) throw new ValidateException("code 不能为空");
    return new WechatAuthService(c.get("container"), c.env)
      .refreshOfficialProfile(uid(c), code, clientIp(c));
  });
}

/** GET /api/v2/user/money_list/:type — balance, commission, withdrawal and cash ledgers. */
export async function moneyList(c: C) {
  return response(c, async () => {
    const currentUid = uid(c);
    const type = phpInteger(c.req.param("type"));
    const query = c.req.query();
    const compatible = service(c);
    if (type === 0 || type === 1 || type === 2) {
      return compatible.moneyList(currentUid, type, query);
    }
    if (type === 3) return compatible.brokerageList(currentUid, query);
    if (type === 4) return compatible.extractList(currentUid, query);
    if (type === 9) {
      const parsed = parseLegacyUserLedgerQuery(query);
      return new CapitalFlowService(c.get("container")).listForUser(
        currentUid,
        parsed.start,
        parsed.stop,
        parsed.page,
        parsed.limit,
      );
    }
    return [];
  });
}

/** GET /api/v2/agent/agent_user_list/:type — path type is authoritative (PHP bug fix). */
export async function agentUserList(c: C) {
  return response(c, () => service(c).agentUserList(
    uid(c),
    c.req.param("type"),
    c.req.query(),
  ));
}

/** GET /api/v2/agent/agent_info — referral rule, own earnings and bounded carousel. */
export async function agentInfo(c: C) {
  return response(c, () => service(c).agentInfo(uid(c)));
}
