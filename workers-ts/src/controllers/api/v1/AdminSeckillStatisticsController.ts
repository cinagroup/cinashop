import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminSeckillStatisticsService, parseSeckillStatisticsId, parseSeckillStatisticsQuery } from "@/services/admin/AdminSeckillStatisticsService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function privateRead(c: C) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  return {
    id: parseSeckillStatisticsId(c.req.param("id")),
    service: new AdminSeckillStatisticsService(c.get("container")),
  };
}

export async function head(c: C) {
  const { id, service } = privateRead(c);
  return jsonOk(c, await service.head(id));
}

export async function people(c: C) {
  const { id, service } = privateRead(c);
  return jsonOk(c, await service.people(id, parseSeckillStatisticsQuery(c.req.query())));
}

export async function orders(c: C) {
  const { id, service } = privateRead(c);
  return jsonOk(c, await service.orders(id, parseSeckillStatisticsQuery(c.req.query())));
}
