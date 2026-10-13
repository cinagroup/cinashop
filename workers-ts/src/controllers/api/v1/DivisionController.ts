import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { DivisionManagementService } from "@/services/division/DivisionManagementService";
import * as DivisionStaff from './DivisionStaffController';
import { SmsVerificationService } from "@/services/message/SmsVerificationService";
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
    code?: string;
    division_invite?: number;
    images?: unknown[];
  };
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    async () => {
      const applicantUid = uid(c);
      const applicationId = Number(c.req.param("id") ?? 0);
      const input = {
        uid: applicantUid,
        id: applicationId === 0 ? undefined : applicationId,
        divisionName: body.division_name ?? "",
        name: body.name ?? "",
        phone: body.phone ?? "",
        divisionInvite: Number(body.division_invite ?? 0),
        images: body.images,
      };
      await service.prevalidateApplication(input);
      await new SmsVerificationService(c.get("container"), c.env)
        .consumeUserCode("user_division_application", body.phone, body.code);
      return service.submitApplication(input);
    },
    "申请提交成功",
  );
}

export async function staffList(c: C) {
  return DivisionStaff.staffList(c);
}

export async function staffPercent(c: C) {
  return DivisionStaff.staffPercent(c);
}

export async function delStaff(c: C) {
  return DivisionStaff.delStaff(c);
}

export async function agentSpread(c: C) {
  return DivisionStaff.agentSpread(c);
}

export async function agentSpreadCode(c: C) {
  return DivisionStaff.agentSpreadCode(c);
}

export async function agentSpreadCodeImage(c: C) {
  return DivisionStaff.agentSpreadCodeImage(c);
}
