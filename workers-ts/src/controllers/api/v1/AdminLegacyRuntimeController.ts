import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { LegacyRuntimeCatalogService } from "@/services/system/LegacyRuntimeCatalogService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new LegacyRuntimeCatalogService(c.get("container"));
}

export async function timerTasks(c: C) {
  return jsonOk(c, service(c).taskNames());
}

export async function timerList(c: C) {
  return jsonOk(c, await service(c).timerList(c.req.query()));
}

export async function timerDetail(c: C) {
  return jsonOk(c, await service(c).timerDetail(c.req.param("id") ?? ""));
}

export async function queueList(c: C) {
  return jsonOk(c, await service(c).queueHistory(c.req.query()));
}

export async function queueDeliveryLog(c: C) {
  return jsonOk(
    c,
    await service(c).queueDeliveryLog(
      c.req.param("id") ?? "",
      c.req.param("type") ?? "",
      c.req.query(),
    ),
  );
}
