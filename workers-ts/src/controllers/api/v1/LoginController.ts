/**
 * 登录控制器
 *
 * 对应 PHP app/controller/api/v1/Login.php
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { LoginService } from "@/services/user/LoginService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables & { container: import("@/lib/di").Container } }>;

/** 提取客户端真实 IP (穿过 CF 代理头) */
function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ??
    c.req.header("X-Real-IP") ??
    "0.0.0.0"
  );
}

/**
 * POST /api/login
 * body: { account, password, spread_spid }
 *
 * 对应 PHP Login::login
 */
export async function login(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    account?: string;
    password?: string;
    spread_spid?: string | number;
  };

  const account = (body.account ?? "").trim();
  const password = body.password ?? "";
  const spreadUid =
    typeof body.spread_spid === "number"
      ? body.spread_spid
      : Number.parseInt(body.spread_spid ?? "0", 10) || 0;

  const svc = new LoginService(c.get("container"), c.env);
  try {
    const result = await svc.loginByPassword(account, password, spreadUid, clientIp(c));
    return jsonOk(c, result, "登录成功");
  } catch (e) {
    if (e instanceof ValidateException) {
      return jsonFail(c, e.message);
    }
    throw e;
  }
}

/**
 * GET /api/logout
 * 对应 PHP Login::logout —— 清除 token bucket
 */
export async function logout(c: C) {
  // TODO(M2): 清 Upstash token bucket + DO revoke
  return jsonOk(c, null, "退出成功");
}

/** POST /api/register — 用户注册 (手机号+密码) */
export async function register(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    account?: string;
    password?: string;
    confirm_password?: string;
    spread_spid?: string | number;
  };
  const account = (body.account ?? "").trim();
  const password = body.password ?? "";
  if (!/^1\d{10}$/.test(account)) return jsonFail(c, "请输入正确的手机号");
  if (password.length < 6) return jsonFail(c, "密码至少 6 位");
  if (body.confirm_password && password !== body.confirm_password) {
    return jsonFail(c, "两次密码不一致");
  }
  const spreadUid =
    typeof body.spread_spid === "number"
      ? body.spread_spid
      : Number.parseInt(body.spread_spid ?? "0", 10) || 0;

  const svc = new LoginService(c.get("container"), c.env);
  try {
    const result = await svc.register(account, password, spreadUid);
    return jsonOk(c, result, "注册成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/user/change_password — 修改密码 (旧密码+新密码) */
export async function changePassword(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    old_password?: string;
    new_password?: string;
  };
  const oldPwd = body.old_password ?? "";
  const newPwd = body.new_password ?? "";
  if (newPwd.length < 6) return jsonFail(c, "新密码至少 6 位");
  const svc = new LoginService(c.get("container"), c.env);
  try {
    await svc.changePassword(uid, oldPwd, newPwd);
    return jsonOk(c, null, "密码修改成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
