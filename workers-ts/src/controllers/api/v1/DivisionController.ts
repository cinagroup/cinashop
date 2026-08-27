import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { DivisionManagementService } from "@/services/division/DivisionManagementService";
import { WechatMiniProgramCodeService } from "@/services/wechat/WechatMiniProgramCodeService";
import { ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

async function withValidation<T>(c: C, fn: () => Promise<T>, message = "ok") {
  try {
    return jsonOk(c, await fn(), message);
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

function uid(c: C): number {
  const value = c.get("uid") ?? 0;
  if (!value) throw new ValidateException("请先登录");
  return value;
}

export async function applyInfo(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.applicationInfo(uid(c)));
}

export async function applyAgent(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    division_name?: string;
    name?: string;
    phone?: string;
    division_invite?: number;
    images?: unknown[];
  };
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    () =>
      service.submitApplication({
        uid: uid(c),
        id: Number(c.req.param("id") ?? 0) || undefined,
        divisionName: body.division_name ?? "",
        name: body.name ?? "",
        phone: body.phone ?? "",
        divisionInvite: Number(body.division_invite ?? 0),
        images: body.images,
      }),
    "申请提交成功",
  );
}

export async function staffList(c: C) {
  const q = c.req.query();
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () =>
    service.staffList({
      agentUid: uid(c),
      keyword: q.keyword,
      page: Number(q.page ?? 1),
      limit: Number(q.limit ?? 20),
    }),
  );
}

export async function staffPercent(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    uid?: number;
    division_percent?: number;
  };
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    async () => {
      await service.updateStaffPercent(uid(c), Number(body.uid ?? 0), body.division_percent);
      return null;
    },
    "设置成功",
  );
}

export async function delStaff(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    async () => {
      await service.removeStaff(uid(c), Number(c.req.param("uid") ?? 0));
      return null;
    },
    "删除成功",
  );
}

export async function agentSpread(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as { agent_id?: number; agent_code?: number };
  const service = new DivisionManagementService(c.get("container"));
  const agentUid = Number(body.agent_id ?? 0) || Number(body.agent_code ?? 0);
  return withValidation(c, () => service.bindStaff(uid(c), agentUid), "绑定成功");
}

export async function agentSpreadCode(c: C) {
  const service = new WechatMiniProgramCodeService(c.get("container"), c.env);
  return withValidation(c, () => service.createAgentInviteUrl(uid(c), c.req.url));
}

export async function agentSpreadCodeImage(c: C) {
  const service = new WechatMiniProgramCodeService(c.get("container"), c.env);
  return service.renderAgentInviteCode(
    Number(c.req.param("uid") ?? 0),
    Number(c.req.query("expires") ?? 0),
    c.req.query("signature") ?? "",
  );
}
