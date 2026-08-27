import type { Context } from "hono";
import { CapitalFlowService } from "@/services/finance/CapitalFlowService";
import { jsonOk } from "@/utils/json";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function positiveIntegers(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** GET flow/get_list — platform external cash movement, not user_bill. */
export async function list(c: C) {
  const q = c.req.query();
  const service = new CapitalFlowService(c.get("container"));
  return jsonOk(
    c,
    await service.adminList({
      tradingType: q.trading_type ? Number(q.trading_type) : undefined,
      keywords: q.keywords,
      ids: positiveIntegers(q.ids),
      start: q.start ? Number(q.start) : undefined,
      stop: q.stop ? Number(q.stop) : undefined,
      page: q.page ? Number(q.page) : 1,
      limit: q.limit ? Number(q.limit) : 20,
      export: q.export === "1",
    }),
  );
}

/** POST flow/set_mark/:id. */
export async function setMark(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as { mark?: string };
  const service = new CapitalFlowService(c.get("container"));
  await service.setMark(Number(c.req.param("id")), body.mark ?? "");
  return jsonOk(c, null, "备注成功");
}
