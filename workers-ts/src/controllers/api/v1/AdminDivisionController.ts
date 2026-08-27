import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  DivisionManagementService,
  parseDivisionDateRange,
  type DivisionAdminScope,
  type DivisionRoleType,
} from "@/services/division/DivisionManagementService";
import { ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Body = Record<string, unknown>;

function scope(c: C): DivisionAdminScope {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("请先登录");
  return { level: admin.level, divisionId: admin.divisionId };
}

function numberValue(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  return Number(value);
}

function imageUid(body: Body): number {
  const image = body.image;
  if (image && typeof image === "object" && "uid" in image) {
    return numberValue((image as { uid?: unknown }).uid);
  }
  return 0;
}

function parseRoleBody(body: Body, roleType: DivisionRoleType) {
  const roles = body.roles;
  return {
    uid: numberValue(body.uid) || imageUid(body),
    roleType,
    parentUid:
      roleType === 2
        ? numberValue(body.division_id ?? body.parent_uid)
        : roleType === 3
          ? numberValue(body.agent_id ?? body.parent_uid)
          : undefined,
    divisionName: String(body.division_name ?? ""),
    divisionPercent: numberValue(body.division_percent),
    divisionEndTime: body.division_end_time as number | string | undefined,
    divisionStatus: numberValue(body.division_status, 1),
    adminAccount: body.account === undefined ? undefined : String(body.account),
    adminPhone: body.phone === undefined ? undefined : String(body.phone),
    adminPassword: body.pwd === undefined ? undefined : String(body.pwd),
    adminPasswordConfirm: body.conf_pwd === undefined ? undefined : String(body.conf_pwd),
    adminRoles: Array.isArray(roles)
      ? roles.map(Number)
      : roles === undefined
        ? undefined
        : String(roles),
  };
}

async function withValidation<T>(c: C, fn: () => Promise<T>, message = "ok") {
  try {
    return jsonOk(c, await fn(), message);
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

function timeRange(value: string | undefined): { start?: number; endExclusive?: number } {
  if (!value?.trim()) return {};
  const match = /^\s*(\d{4}-\d{2}-\d{2})\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(value);
  if (!match) throw new ValidateException("时间范围格式应为 YYYY-MM-DD - YYYY-MM-DD");
  const range = parseDivisionDateRange(match[1], match[2]);
  return { start: range.start, endExclusive: range.endExclusive };
}

/** GET /adminapi/agent/division/list */
export async function divisionList(c: C) {
  const q = c.req.query();
  const roleType = numberValue(q.division_type ?? q.role_type) as DivisionRoleType;
  if (![1, 2, 3].includes(roleType)) return jsonFail(c, "角色类型错误");
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () =>
    service.listRoles({
      roleType,
      keyword: q.keyword ?? q.division_name ?? q.nickname,
      parentUid: numberValue(q.parent_uid ?? q.uid ?? q.division_id ?? q.agent_id),
      page: numberValue(q.page, 1),
      limit: numberValue(q.limit, 20),
      scope: scope(c),
    }),
  );
}

/** GET /adminapi/agent/division/detail/:uid */
export async function divisionDetail(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.getRole(numberValue(c.req.param("uid")), scope(c)));
}

export async function saveDivision(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as Body;
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.saveRole(parseRoleBody(body, 1), scope(c)), "事业部保存成功");
}

export async function saveAgent(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as Body;
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.saveRole(parseRoleBody(body, 2), scope(c)), "代理商保存成功");
}

export async function saveStaff(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as Body;
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.saveRole(parseRoleBody(body, 3), scope(c)), "员工保存成功");
}

export async function deleteDivisionRole(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    async () => {
      await service.deleteRole(numberValue(c.req.param("uid")), scope(c));
      return null;
    },
    "删除成功",
  );
}

export async function setDivisionStatus(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    async () => {
      await service.setRoleStatus(
        numberValue(c.req.param("uid")),
        numberValue(c.req.param("status")),
        scope(c),
      );
      return null;
    },
    "状态设置成功",
  );
}

export async function divisionOptions(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.options(1, undefined, scope(c)));
}

export async function agentOptions(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () =>
    service.options(2, numberValue(c.req.param("divisionId") ?? c.req.query("division_id")), scope(c)),
  );
}

export async function divisionOrders(c: C) {
  const q = c.req.query();
  const range = timeRange(q.time);
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () =>
    service.orderList({
      divisionId: numberValue(q.division_id),
      agentId: numberValue(q.division_agent_id ?? q.agent_id),
      keyword: q.keyword ?? q.real_name ?? q.field_key,
      ...range,
      page: numberValue(q.page, 1),
      limit: numberValue(q.limit, 20),
      scope: scope(c),
    }),
  );
}

export async function divisionStatistics(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.statistics(scope(c)));
}

export async function divisionTrend(c: C) {
  const q = c.req.query();
  let start = q.start ?? "";
  let end = q.end ?? "";
  if ((!start || !end) && q.time) {
    const match = /^\s*(\d{4}-\d{2}-\d{2})\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(q.time);
    if (!match) return jsonFail(c, "时间范围格式应为 YYYY-MM-DD - YYYY-MM-DD");
    start = match[1];
    end = match[2];
  }
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.trend(start, end, scope(c)));
}

export async function divisionRanking(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () => service.ranking(scope(c)));
}

export async function applicationList(c: C) {
  const q = c.req.query();
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(c, () =>
    service.listApplications({
      status: q.status === undefined || q.status === "" ? undefined : numberValue(q.status),
      keyword: q.keyword,
      page: numberValue(q.page, 1),
      limit: numberValue(q.limit, 20),
      scope: scope(c),
    }),
  );
}

export async function applicationReview(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as Body;
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    () =>
      service.reviewApplication({
        id: numberValue(body.id),
        approved: numberValue(body.type) === 1,
        divisionPercent: numberValue(body.division_percent),
        divisionEndTime: body.division_end_time as number | string | undefined,
        divisionStatus: numberValue(body.division_status, 1),
        refusalReason: String(body.refusal_reason ?? ""),
        scope: scope(c),
      }),
    numberValue(body.type) === 1 ? "审核通过" : "拒绝成功",
  );
}

export async function applicationDelete(c: C) {
  const service = new DivisionManagementService(c.get("container"));
  return withValidation(
    c,
    async () => {
      await service.deleteApplication(numberValue(c.req.param("id")), scope(c));
      return null;
    },
    "删除成功",
  );
}
