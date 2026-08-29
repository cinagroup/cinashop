import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

const port = Number(process.env.CINASHOP_LOGIN_MOCK_PORT || 4310);
const pcKey = "11111111-1111-4111-8111-111111111111";
const kefuKey = "22222222-2222-4222-8222-222222222222";
const pcPollToken = "a".repeat(64);
const kefuPollToken = "b".repeat(64);
const challengeTtlSeconds = 600;
const oauthTtlSeconds = 900;
const challenges = new Map();
const oauthStates = new Map();

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const apiToken = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ jti: { id: 7, type: "api" } })}.mock`;
const kefuToken = "mock-kefu-token";
const kefuInfo = {
  id: 9,
  uid: 7,
  account: "service-7",
  avatar: "",
  nickname: "测试客服",
  phone: "13900000007",
  online: 0,
};

const audienceConfig = {
  pc_user: {
    key: pcKey,
    pollToken: pcPollToken,
    token: apiToken,
    target: {
      name: "CinaShop PC 商城",
      origin: "https://cinashop-pc.pages.dev",
      device: "Windows · Chrome",
    },
  },
  kefu_agent: {
    key: kefuKey,
    pollToken: kefuPollToken,
    token: kefuToken,
    target: {
      name: "CinaShop 客服工作台",
      origin: "https://service.cinashop.example",
      device: "Windows · Chrome",
    },
  },
};

function send(response, data, status = 200, msg = status === 200 ? "ok" : "请求失败") {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ status, msg, data }));
}

function fail(response, status, msg) {
  return send(response, null, status, msg);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function createChallenge(audience) {
  const config = audienceConfig[audience];
  const challenge = {
    audience,
    key: config.key,
    pollToken: config.pollToken,
    token: config.token,
    tokenExpiresAt: nowSeconds() + 3600,
    stage: "pending",
    expiresAt: nowSeconds() + challengeTtlSeconds,
    target: config.target,
  };
  challenges.set(challenge.key, challenge);
  return challenge;
}

function liveChallenge(key) {
  const challenge = challenges.get(key);
  if (!challenge) return null;
  if (challenge.expiresAt <= nowSeconds()) {
    challenges.delete(key);
    return null;
  }
  return challenge;
}

function publicChallenge(challenge, stage = challenge.stage) {
  return {
    audience: challenge.audience,
    stage,
    expires_in: Math.max(0, challenge.expiresAt - nowSeconds()),
    target: challenge.target,
  };
}

function pollChallenge(key, pollToken, audience) {
  const challenge = liveChallenge(key);
  if (!challenge || challenge.audience !== audience || challenge.pollToken !== pollToken) {
    return { status: 0 };
  }
  if (challenge.stage === "pending") {
    return { status: 2, audience, expiresAt: challenge.expiresAt };
  }
  if (challenge.stage === "scanned") {
    return { status: 1, audience, expiresAt: challenge.expiresAt };
  }
  if (challenge.stage === "approved" || challenge.stage === "delivered") {
    challenge.stage = "delivered";
    return {
      status: 3,
      token: challenge.token,
      exp_time: challenge.tokenExpiresAt,
      ...(audience === "kefu_agent" ? { kefuInfo } : {}),
    };
  }
  return { status: 0 };
}

function parseCookies(request) {
  const cookies = new Map();
  for (const pair of String(request.headers.cookie || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function oauthCookieName(audience, state) {
  const surface = audience === "pc_user" ? "pc" : "kefu";
  return `__Host-cinashop-${surface}-oauth-${state}`;
}

function createOauthState(response, audience) {
  const state = randomUUID().toLowerCase();
  const verifier = randomBytes(24).toString("base64url");
  const cookieName = oauthCookieName(audience, state);
  oauthStates.set(`${audience}:${state}`, {
    audience,
    state,
    verifier,
    expiresAt: nowSeconds() + oauthTtlSeconds,
  });
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=${verifier}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${oauthTtlSeconds}`,
  );
  return send(response, { state, expires_in: oauthTtlSeconds });
}

function consumeOauthState(request, response, url, audience) {
  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim().toLowerCase();
  if (!code || !state) return fail(response, 400, "OAuth code 和 state 不能为空");

  const recordKey = `${audience}:${state}`;
  const record = oauthStates.get(recordKey);
  if (!record || record.expiresAt <= nowSeconds()) {
    oauthStates.delete(recordKey);
    return fail(response, 400, "OAuth state 无效、已过期或已使用");
  }

  const cookieName = oauthCookieName(audience, state);
  if (parseCookies(request).get(cookieName) !== record.verifier) {
    return fail(response, 403, "OAuth 浏览器校验失败");
  }

  oauthStates.delete(recordKey);
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
  return send(response, audience === "pc_user"
    ? { token: apiToken, exp_time: nowSeconds() + 3600 }
    : { token: kefuToken, exp_time: nowSeconds() + 3600, kefuInfo });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === "/api/pc/get_appid") return send(response, { appid: "wxmock12345678", version: "mock" });
  if (url.pathname === "/api/pc/key" && ["GET", "POST"].includes(request.method || "")) {
    const challenge = createChallenge("pc_user");
    return send(response, {
      key: challenge.key,
      poll_token: challenge.pollToken,
      time: challenge.expiresAt,
      expires_in: challengeTtlSeconds,
      audience: challenge.audience,
    });
  }
  if (url.pathname.startsWith("/api/pc/scan/") && request.method === "GET") {
    return send(response, pollChallenge(
      decodeURIComponent(url.pathname.split("/").at(-1) || ""),
      String(request.headers["x-scan-poll-token"] || ""),
      "pc_user",
    ));
  }
  if (url.pathname === "/api/pc/oauth_state" && request.method === "POST") {
    return createOauthState(response, "pc_user");
  }
  if (url.pathname === "/api/pc/wechat_auth" && request.method === "GET") {
    return consumeOauthState(request, response, url, "pc_user");
  }

  if (url.pathname === "/kefuapi/config") return send(response, { appid: "wxmock12345678", site_name: "CinaShop", version: "mock" });
  if (url.pathname === "/kefuapi/key" && ["GET", "POST"].includes(request.method || "")) {
    const challenge = createChallenge("kefu_agent");
    return send(response, {
      key: challenge.key,
      poll_token: challenge.pollToken,
      time: challenge.expiresAt,
      expires_in: challengeTtlSeconds,
      audience: challenge.audience,
    });
  }
  if (url.pathname.startsWith("/kefuapi/scan/") && request.method === "GET") {
    return send(response, pollChallenge(
      decodeURIComponent(url.pathname.split("/").at(-1) || ""),
      String(request.headers["x-scan-poll-token"] || ""),
      "kefu_agent",
    ));
  }
  if (url.pathname === "/kefuapi/oauth_state" && request.method === "POST") {
    return createOauthState(response, "kefu_agent");
  }
  if (url.pathname === "/kefuapi/wechat" && request.method === "GET") {
    return consumeOauthState(request, response, url, "kefu_agent");
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    return send(response, { token: apiToken, expires_time: nowSeconds() + 3600 });
  }
  if (url.pathname === "/api/user/code" && request.method === "GET") {
    const key = String(url.searchParams.get("key") || url.searchParams.get("code") || "").trim().toLowerCase();
    const challenge = liveChallenge(key);
    if (!challenge) return fail(response, 404, "扫码登录请求不存在或已过期");
    if (challenge.stage === "rejected") return fail(response, 409, "扫码登录请求已被拒绝");
    if (challenge.stage === "pending") challenge.stage = "scanned";
    return send(response, publicChallenge(challenge));
  }
  if (url.pathname === "/api/user/code" && request.method === "POST") {
    const payload = await readJson(request);
    if (!payload || typeof payload !== "object") return fail(response, 400, "请求 JSON 无效");
    const key = String(payload.key || payload.code || "").trim().toLowerCase();
    const action = String(payload.action || "approve").trim().toLowerCase();
    const challenge = liveChallenge(key);
    if (!challenge) return fail(response, 404, "扫码登录请求不存在或已过期");
    if (action === "reject") {
      if (challenge.stage !== "scanned") return fail(response, 409, "仅已扫描的请求可以拒绝");
      challenge.stage = "rejected";
      return send(response, publicChallenge(challenge, "rejected"));
    }
    if (action !== "approve") return fail(response, 400, "扫码登录操作无效");
    if (!["scanned", "approved", "delivered"].includes(challenge.stage)) {
      return fail(response, 409, "请先扫描二维码再确认登录");
    }
    if (challenge.stage === "scanned") challenge.stage = "approved";
    return send(response, publicChallenge(challenge));
  }

  return fail(response, 404, "接口不存在");
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`login-flow mock listening on http://127.0.0.1:${port}\n`);
});
