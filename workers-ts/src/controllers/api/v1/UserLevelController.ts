/**
 * 会员等级控制器
 *
 * 对应原版端点:
 *   - GET  /api/user/level/grade       等级列表
 *   - GET  /api/user/level/info        我的等级
 *   - POST /api/user/level/activate    激活等级
 *   - GET  /api/user/level/expList     经验明细
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { UserLevelService } from "@/services/user/UserLevelService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** GET /api/user/level/grade — 等级列表 */
export async function levelGrade(c: C) {
  const svc = new UserLevelService(c.get("container"), c.env);
  return jsonOk(c, await svc.gradeList());
}

/** GET /api/user/level/info — 我的等级信息 */
export async function levelInfo(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserLevelService(c.get("container"), c.env);
  return jsonOk(c, await svc.userLevelInfo(uid));
}

/** POST /api/user/level/activate — 激活等级 */
export async function levelActivate(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { levelId?: number };
  if (!body.levelId) return jsonFail(c, "参数错误");
  const svc = new UserLevelService(c.get("container"), c.env);
  try {
    return jsonOk(c, await svc.activateLevel(uid, body.levelId), "激活成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/user/level/expList — 经验明细 */
export async function levelExpList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const q = c.req.query();
  const svc = new UserLevelService(c.get("container"), c.env);
  return jsonOk(
    c,
    await svc.expList(uid, Number(q.page ?? 1), Number(q.limit ?? 10)),
  );
}
