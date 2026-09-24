import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminPointStatisticService, parsePointStatisticRange } from "@/services/admin/AdminPointStatisticService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function read(c: C, projection: "basic" | "trend" | "channel" | "type") {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const range = parsePointStatisticRange(c.req.query("time"));
  return new AdminPointStatisticService(c.get("container"))[projection](range).then((result) => jsonOk(c, result));
}

export const basic = (c: C) => read(c, "basic");
export const trend = (c: C) => read(c, "trend");
export const channel = (c: C) => read(c, "channel");
export const type = (c: C) => read(c, "type");
