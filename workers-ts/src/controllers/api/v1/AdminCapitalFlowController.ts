import type { Context } from "hono";
import {
  CapitalFlowService,
  type AdminCapitalFlowActor,
  type AdminCapitalFlowQuery,
} from "@/services/finance/CapitalFlowService";
import { jsonOk } from "@/utils/json";
import type { AppVariables, Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function boundedInteger(value: string | undefined, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new ValidateException(`${label}无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

export function parseAdminCapitalFlowQuery(q: Record<string, string>): AdminCapitalFlowQuery {
  const start = boundedInteger(q.start, "开始时间", 0, 2_147_483_647, 0);
  const stop = boundedInteger(q.stop, "结束时间", 0, 2_147_483_647, 0);
  if (start && stop && start > stop) throw new ValidateException("时间范围无效");
  const keywords = q.keywords?.trim() ?? "";
  if (keywords.length > 100 || /[\u0000-\u001f\u007f]/.test(keywords)) {
    throw new ValidateException("搜索词无效");
  }
  const rawIds = q.ids;
  const ids = rawIds === undefined || rawIds === "" ? [] : rawIds.split(",").map((part) =>
    boundedInteger(part.trim(), "流水 ID", 1, 2_147_483_647, 0));
  if (ids.length > 100) throw new ValidateException("流水 ID 数量不能超过100个");
  if (q.export !== undefined && q.export !== "0" && q.export !== "1") {
    throw new ValidateException("导出参数无效");
  }
  return {
    tradingType: boundedInteger(q.trading_type, "交易类型", 0, 8, 0),
    keywords,
    ids,
    start,
    stop,
    page: boundedInteger(q.page, "页码", 1, 10_000, 1),
    limit: boundedInteger(q.limit, "每页条数", 1, 100, 20),
    export: q.export === "1",
  };
}

function actor(c: C): AdminCapitalFlowActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  return {
    id: admin.id,
    name: admin.realName || admin.account,
    ip: (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
      .trim().slice(0, 45),
  };
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

/** GET flow/get_list — platform external cash movement, not user_bill. */
export async function list(c: C) {
  noStore(c);
  const service = new CapitalFlowService(c.get("container"));
  return jsonOk(c, await service.adminList(parseAdminCapitalFlowQuery(c.req.query())));
}

/** POST flow/set_mark/:id. */
export async function setMark(c: C) {
  noStore(c);
  const body = await readBoundedJsonObject(c.req.raw, 2 * 1024);
  if (typeof body.mark !== "string") throw new ValidateException("备注无效");
  const service = new CapitalFlowService(c.get("container"));
  return jsonOk(c, await service.setMark(Number(c.req.param("id")), body.mark, actor(c)), "备注成功");
}
