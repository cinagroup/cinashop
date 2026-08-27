import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AgentLevelTaskService } from "@/services/agent/AgentLevelTaskService";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function levelList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await new AgentLevelTaskService(c.get("container")).userLevelList(uid));
}

export async function levelTaskList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const levelId = c.req.query("id") ?? c.req.query("level_id");
  return jsonOk(
    c,
    await new AgentLevelTaskService(c.get("container")).userTaskList(uid, levelId),
  );
}
