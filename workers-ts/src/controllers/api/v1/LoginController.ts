/**
 * 登录控制器
 *
 * 对应 PHP app/controller/api/v1/Login.php
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { LoginService } from "@/services/user/LoginService";
import { SmsVerificationService } from "@/services/message/SmsVerificationService";
import { WechatAuthService } from "@/services/wechat/WechatAuthService";
import { extractToken } from "@/middleware/auth";
import { clearToken } from "@/utils/cache";
import { md5 } from "@/utils/jwt";
import { readBoundedJsonObject } from "@/utils/request-body";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables & { container: import("@/lib/di").Container } }>;
const MAX_AUTH_BODY_BYTES = 4 * 1024;

async function readJsonObject(c: C): Promise<Record<string, unknown>> {
  return readBoundedJsonObject(c.req.raw, MAX_AUTH_BODY_BYTES);
}

/** 提取客户端真实 IP (穿过 CF 代理头) */
function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ??
    c.req.header("X-Real-IP") ??
    "0.0.0.0"
  );
}

function spreadUid(value: unknown): number {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  return Number.parseInt(String(value ?? "0"), 10) || 0;
}

function password(value: unknown, label = "密码"): string {
  const result = String(value ?? "");
  if (result.length < 6 || result.length > 16) {
    throw new ValidateException(`${label}必须是在6到16位之间`);
  }
  if (result === "123456") throw new ValidateException("密码太过简单，请输入较为复杂的密码");
  return result;
}

function userType(c: C): string {
  return (c.req.header("Form-type") ?? "h5").trim() || "h5";
}

function challengeUrl(c: C, key: string): string {
  let origin = new URL(c.req.url).origin;
  try {
    origin = new URL(c.env.INTERNAL_API_URL).origin;
  } catch {
    // Local and preview environments may omit or override INTERNAL_API_URL.
  }
  const url = new URL("/api/turnstile/challenge", origin);
  url.searchParams.set("key", key);
  return url.toString();
}

function htmlJson(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function turnstileChallengeHtml(
  key: string,
  siteKey: string,
  action: string,
  nonce: string,
): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>安全验证</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f8fa; color: #1f2937; }
    main { width: min(92vw, 390px); padding: 28px 20px; box-sizing: border-box; text-align: center; background: #fff; border-radius: 16px; box-shadow: 0 12px 32px rgba(15,23,42,.08); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 20px; color: #64748b; font-size: 14px; line-height: 1.6; }
    #widget { min-height: 70px; display: grid; place-items: center; }
    #status[data-state="error"] { color: #b91c1c; }
    #status[data-state="success"] { color: #047857; }
    button { display: none; margin: 16px auto 0; border: 0; border-radius: 10px; padding: 10px 18px; background: #2563eb; color: #fff; font-size: 15px; }
    button.visible { display: block; }
  </style>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" defer></script>
</head>
<body>
  <main>
    <h1>安全验证</h1>
    <p id="status">请完成下方验证，验证结果不会包含您的手机号。</p>
    <div id="widget" aria-label="Cloudflare Turnstile 人机验证"></div>
    <button id="return" type="button">返回应用</button>
  </main>
  <script nonce="${nonce}">
    (() => {
      "use strict";
      const key = ${htmlJson(key)};
      const sitekey = ${htmlJson(siteKey)};
      const action = ${htmlJson(action)};
      const status = document.getElementById("status");
      const returnButton = document.getElementById("return");
      const message = { type: "cinashop:turnstile:complete", key };

      if (/miniProgram/i.test(navigator.userAgent) && /micromessenger/i.test(navigator.userAgent)) {
        const bridge = document.createElement("script");
        bridge.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
        document.head.appendChild(bridge);
      }

      function notifyHost() {
        if (window.parent && window.parent !== window) window.parent.postMessage(message, "*");
        try {
          if (window.uni && typeof window.uni.postMessage === "function") {
            window.uni.postMessage({ data: message });
            if (typeof window.uni.navigateBack === "function") {
              setTimeout(() => window.uni.navigateBack({ delta: 1 }), 350);
            }
          }
        } catch {}
        try {
          if (window.wx && window.wx.miniProgram) {
            window.wx.miniProgram.postMessage({ data: message });
            setTimeout(() => window.wx.miniProgram.navigateBack({ delta: 1 }), 350);
          }
        } catch {}
      }

      async function complete(token) {
        status.textContent = "正在确认验证结果…";
        try {
          const response = await fetch("/api/verify_code/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, turnstile_token: token }),
            credentials: "omit",
          });
          const body = await response.json();
          if (!response.ok || !body || body.status !== 200 || body.data?.verified !== true) {
            throw new Error(body?.msg || "验证失败，请重试");
          }
          status.dataset.state = "success";
          status.textContent = "验证完成，正在返回应用；若未自动返回，请点击下方按钮。";
          returnButton.classList.add("visible");
          notifyHost();
        } catch (error) {
          status.dataset.state = "error";
          status.textContent = error instanceof Error ? error.message : "验证失败，请重试";
          if (window.turnstile) window.turnstile.reset();
        }
      }

      returnButton.addEventListener("click", notifyHost);
      window.addEventListener("load", () => {
        if (!window.turnstile) {
          status.dataset.state = "error";
          status.textContent = "验证组件加载失败，请检查网络后刷新。";
          return;
        }
        window.turnstile.render("#widget", {
          sitekey,
          action,
          cData: key,
          callback: complete,
          "error-callback": () => {
            status.dataset.state = "error";
            status.textContent = "验证组件暂时不可用，请刷新后重试。";
          },
          "expired-callback": () => {
            status.dataset.state = "error";
            status.textContent = "验证已过期，请重新完成验证。";
          },
        });
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * POST /api/login
 * body: { account, password, spread_spid }
 *
 * 对应 PHP Login::login
 */
export async function login(c: C) {
  const body = await readJsonObject(c);

  const account = String(body.account ?? "").trim();
  const loginPassword = String(body.password ?? "");

  const svc = new LoginService(c.get("container"), c.env);
  try {
    const result = await svc.loginByPassword(
      account,
      loginPassword,
      spreadUid(body.spread_spid),
      clientIp(c),
    );
    return jsonOk(c, result, "登录成功");
  } catch (e) {
    if (e instanceof ValidateException) {
      return jsonFail(c, e.message);
    }
    throw e;
  }
}

/** POST /api/verify_code — 创建绑定手机号和用途的一次性 Turnstile 挑战。 */
export async function verifyCode(c: C) {
  const body = await readJsonObject(c);
  try {
    const result = await new SmsVerificationService(c.get("container"), c.env)
      .createPublicChallenge(body.phone, body.type, clientIp(c));
    c.header("Cache-Control", "no-store, max-age=0");
    return jsonOk(
      c,
      { ...result, challenge_url: challengeUrl(c, result.key) },
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/verify_code/complete — Siteverify 后将挑战标记为已验证。 */
export async function completeVerifyCode(c: C) {
  const body = await readJsonObject(c);
  try {
    const result = await new SmsVerificationService(c.get("container"), c.env)
      .completePublicChallenge(body.key, body.turnstile_token ?? body.token, clientIp(c));
    c.header("Cache-Control", "no-store, max-age=0");
    return jsonOk(c, result, "人机验证完成");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/verify_code/status — 供 App/小程序 WebView 返回后确认服务端状态。 */
export async function verifyCodeStatus(c: C) {
  try {
    const result = await new SmsVerificationService(c.get("container"), c.env)
      .publicChallengeStatus(c.req.query("key"), clientIp(c));
    c.header("Cache-Control", "no-store, max-age=0");
    return jsonOk(c, result);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/turnstile/challenge — browser/WebView-only Turnstile host page. */
export async function turnstileChallenge(c: C) {
  try {
    const result = await new SmsVerificationService(c.get("container"), c.env)
      .publicChallengePage(c.req.query("key"));
    const nonce = crypto.randomUUID().replace(/-/g, "");
    return new Response(
      turnstileChallengeHtml(result.key, result.siteKey, result.action, nonce),
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, max-age=0",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Content-Security-Policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}' https://challenges.cloudflare.com https://res.wx.qq.com`,
            "frame-src https://challenges.cloudflare.com",
            "connect-src 'self' https://challenges.cloudflare.com",
            "img-src data: https://challenges.cloudflare.com",
            "style-src 'unsafe-inline'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors *",
          ].join("; "),
        },
      },
    );
  } catch (e) {
    if (e instanceof ValidateException) {
      return new Response("人机验证挑战无效或已过期，请返回应用重试。", {
        status: 400,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    throw e;
  }
}

/** POST /api/register/verify — 验证挑战并提交短信队列。 */
export async function requestCode(c: C) {
  const body = await readJsonObject(c);
  try {
    const result = await new SmsVerificationService(c.get("container"), c.env)
      .requestUserCode(body.phone, body.type, body.key, clientIp(c));
    return jsonOk(c, result, "验证码任务已提交");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/**
 * GET /api/logout
 * 对应 PHP Login::logout —— 清除 token bucket
 */
export async function logout(c: C) {
  const token = extractToken(c);
  if (token) await clearToken(md5(token), c.env);
  return jsonOk(c, null, "退出成功");
}

/** POST /api/register — 用户注册 (手机号+密码) */
export async function register(c: C) {
  const body = await readJsonObject(c);
  const account = String(body.account ?? "").trim();
  if (!/^1\d{10}$/.test(account)) return jsonFail(c, "请输入正确的手机号");
  let registerPassword: string;
  try {
    registerPassword = password(body.password);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
  if (body.confirm_password && registerPassword !== String(body.confirm_password)) {
    return jsonFail(c, "两次密码不一致");
  }

  const svc = new LoginService(c.get("container"), c.env);
  try {
    await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_register", account, body.captcha);
    const result = await svc.register(
      account,
      registerPassword,
      spreadUid(body.spread_spid),
      clientIp(c),
      userType(c),
    );
    return jsonOk(c, result, "注册成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/login/mobile — 验证码登录；手机号不存在时安全创建账号。 */
export async function mobile(c: C) {
  const body = await readJsonObject(c);
  const phone = String(body.phone ?? "").trim();
  const svc = new LoginService(c.get("container"), c.env);
  try {
    await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_login", phone, body.captcha);
    const result = await svc.loginByMobile(
      phone,
      spreadUid(body.spread_spid),
      clientIp(c),
      userType(c),
    );
    return jsonOk(c, result, "登录成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/register/reset — 用短信验证码重置密码。 */
export async function reset(c: C) {
  const body = await readJsonObject(c);
  const account = String(body.account ?? "").trim();
  try {
    const newPassword = password(body.password);
    await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_password_reset", account, body.captcha);
    await new LoginService(c.get("container"), c.env)
      .resetPassword(account, newPassword);
    return jsonOk(c, null, "修改成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/user/updatePhone — 已登录用户更换手机号。 */
export async function updatePhone(c: C) {
  const uid = c.get("uid");
  const body = await readJsonObject(c);
  const phone = String(body.phone ?? "").trim();
  try {
    await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_phone_update", phone, body.captcha);
    await new LoginService(c.get("container"), c.env).updatePhone(uid, phone);
    return jsonOk(c, null, "修改成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/user/binding — 仅为尚无手机号的当前账号绑定新手机号。 */
export async function bindPhone(c: C) {
  const uid = c.get("uid");
  const body = await readJsonObject(c);
  const phone = String(body.phone ?? "").trim();
  try {
    await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_phone_binding", phone, body.captcha);
    await new LoginService(c.get("container"), c.env).bindPhone(uid, phone);
    return jsonOk(c, null, "绑定成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/**
 * POST /api/binding — complete a provider-verified pending social identity.
 * This is intentionally distinct from authenticated /user/binding.
 */
export async function bindPendingSocialIdentity(c: C) {
  const body = await readJsonObject(c);
  const phone = String(body.phone ?? "").trim();
  const key = String(body.key ?? "").trim();
  const social = new WechatAuthService(c.get("container"), c.env);
  try {
    // Check the bearer capability before consuming a separately scoped SMS
    // code. Atomic GETDEL happens only after SMS validation succeeds.
    await social.assertPendingIdentity(key);
    await new SmsVerificationService(c.get("container"), c.env)
      .consumeUserCode("user_social_binding", phone, body.captcha);
    const result = await social.completePendingPhoneBinding(key, phone, clientIp(c));
    return jsonOk(c, result, "绑定成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/user/change_password — 修改密码 (旧密码+新密码) */
export async function changePassword(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readJsonObject(c);
  const oldPwd = String(body.old_password ?? "");
  const svc = new LoginService(c.get("container"), c.env);
  try {
    const newPwd = password(body.new_password, "新密码");
    await svc.changePassword(uid, oldPwd, newPwd);
    return jsonOk(c, null, "密码修改成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
