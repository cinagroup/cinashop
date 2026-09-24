/** Enterprise Work authorization stays separate from the shopper session. */
import {
  createWorkContextChallenge,
  exchangeWorkContext,
  getWorkAgentConfig,
  getWorkJsConfig,
  type WorkContextTarget,
} from "@/api/work";

type WorkKind = "client" | "group";
interface ActiveContext {
  target: WorkContextTarget;
  token: string;
  expiresAt: number;
}
interface PendingContext {
  state: string;
  target: WorkContextTarget;
  sdkDiscovered: boolean;
  returnRoute: string;
  expiresAt: number;
}
interface OAuthCallback { code: string; state: string; }
interface WorkSdk {
  config(input: Record<string, unknown>): void;
  ready(callback: () => void): void;
  error(callback: (error: unknown) => void): void;
  agentConfig(input: Record<string, unknown>): void;
  invoke(name: string, input: Record<string, unknown>, callback: (result: Record<string, unknown>) => void): void;
}

const PENDING_KEY = "cinashop_work_oauth_pending";
const allowedPages = new Set([
  "/pages/work/userInfo/index",
  "/pages/work/orderList/index",
  "/pages/work/orderDetail/index",
  "/pages/work/record/index",
  "/pages/work/groupInfo/index",
]);
let active: ActiveContext | null = null;
let callback: OAuthCallback | null = null;
let sdkScripts: Promise<WorkSdk> | null = null;
let sdkConfiguration: { signedUrl: string; expiresAt: number; promise: Promise<WorkSdk> } | null = null;
let backgroundGuardInstalled = false;
const clearedListeners = new Set<(token: string) => void>();

export class WorkAuthorizationRedirect extends Error {
  constructor() { super("正在跳转企业微信授权"); }
}

function browser(): boolean { return typeof window !== "undefined" && typeof document !== "undefined"; }
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}
function validTarget(value: unknown): value is WorkContextTarget {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.target_type === "client"
    ? validId(item.external_userid) && item.chat_id === undefined
    : item.target_type === "group" && validId(item.chat_id) && item.external_userid === undefined;
}
function validRoute(route: string): boolean {
  const path = route.split("?", 1)[0];
  return allowedPages.has(path) && route.length <= 512 && !/[#\u0000-\u001f\u007f]/.test(route);
}
function readPending(): PendingContext | null {
  if (!browser()) return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? "null") as PendingContext | null;
    return value && /^[a-f0-9]{64}$/i.test(value.state) && validTarget(value.target)
      && typeof value.sdkDiscovered === "boolean"
      && validRoute(value.returnRoute) && Number.isFinite(value.expiresAt) ? value : null;
  } catch { return null; }
}
function removePending() {
  if (browser()) window.sessionStorage.removeItem(PENDING_KEY);
}

/** Called before UniApp creates its H5 router: OAuth returns before the hash route. */
export function prepareWorkOAuthRoute() {
  if (!browser()) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("work_oauth") !== "1") return;
  callback = { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" };
  const route = readPending()?.returnRoute ?? "/pages/work/userInfo/index";
  url.searchParams.delete("work_oauth");
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.hash = `#${route}`;
  window.history.replaceState(null, "", url.href);
}

export function currentWorkContext(kind: WorkKind): ActiveContext | null {
  if (active && active.expiresAt <= Date.now()) active = null;
  return active?.target.target_type === kind ? active : null;
}

export function clearWorkContext(expectedToken?: string) {
  if (!active || (expectedToken && active.token !== expectedToken)) return;
  const token = active.token;
  active = null;
  for (const listener of clearedListeners) listener(token);
}

export function onWorkContextCleared(listener: (token: string) => void): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

function installBackgroundGuard() {
  if (backgroundGuardInstalled || !browser()) return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") clearWorkContext();
  });
  window.addEventListener("pagehide", () => clearWorkContext());
  backgroundGuardInstalled = true;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    const timeout = window.setTimeout(() => { element.remove(); reject(new Error("企业微信 SDK 加载超时")); }, 15_000);
    element.src = src;
    element.async = false;
    element.onload = () => { window.clearTimeout(timeout); resolve(); };
    element.onerror = () => { window.clearTimeout(timeout); element.remove(); reject(new Error("企业微信 SDK 加载失败")); };
    document.head.appendChild(element);
  });
}

async function loadSdk(): Promise<WorkSdk> {
  if (!browser()) throw new Error("企业微信工作台仅支持 H5");
  if (!sdkScripts) sdkScripts = (async () => {
    await loadScript("https://res.wx.qq.com/open/js/jweixin-1.2.0.js");
    await loadScript("https://open.work.weixin.qq.com/wwopen/js/jwxwork-1.0.0.js");
    const sdk = (window as unknown as { jWeixin?: WorkSdk }).jWeixin;
    if (!sdk?.config || !sdk?.agentConfig || !sdk?.invoke) throw new Error("企业微信 SDK 不可用");
    return sdk;
  })().catch((error) => { sdkScripts = null; throw error; });
  return sdkScripts;
}

async function configuredSdk(): Promise<WorkSdk> {
  const signedUrl = window.location.href.split("#", 1)[0];
  if (sdkConfiguration?.signedUrl === signedUrl && sdkConfiguration.expiresAt > Date.now()) {
    return sdkConfiguration.promise;
  }
  const promise = (async () => {
    const sdk = await loadSdk();
    const [company, agent] = await Promise.all([
      getWorkJsConfig(signedUrl), getWorkAgentConfig(signedUrl),
    ]);
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("企业微信 SDK 配置超时")), 10_000);
      sdk.ready(() => { window.clearTimeout(timeout); resolve(); });
      sdk.error(() => { window.clearTimeout(timeout); reject(new Error("企业微信 SDK 签名无效")); });
      sdk.config({ beta: true, debug: false, appId: company.appId, timestamp: company.timestamp,
        nonceStr: company.nonceStr, signature: company.signature, jsApiList: company.jsApiList });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("企业微信应用配置超时")), 10_000);
      sdk.agentConfig({ corpid: agent.corpid, agentid: agent.agentid, timestamp: agent.timestamp,
        nonceStr: agent.nonceStr, signature: agent.signature, jsApiList: agent.jsApiList,
        success: () => { window.clearTimeout(timeout); resolve(); },
        fail: () => { window.clearTimeout(timeout); reject(new Error("企业微信应用配置失败")); } });
    });
    return sdk;
  })().catch((error) => {
    if (sdkConfiguration?.promise === promise) sdkConfiguration = null;
    throw error;
  });
  sdkConfiguration = { signedUrl, expiresAt: Date.now() + 4 * 60_000, promise };
  return promise;
}

function invoke(sdk: WorkSdk, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("企业微信当前会话读取超时")), 10_000);
    sdk.invoke(name, input, (result) => {
      window.clearTimeout(timeout);
      if (result?.err_msg !== `${name}:ok`) reject(new Error("无法读取企业微信当前会话"));
      else resolve(result);
    });
  });
}

async function discoverTarget(kind: WorkKind, configured?: WorkSdk): Promise<WorkContextTarget> {
  const sdk = configured ?? await configuredSdk();
  const context = await invoke(sdk, "getContext", {});
  if (kind === "client") {
    if (context.entry !== "single_chat_tools" && context.entry !== "contact_profile") {
      throw new Error("请从企业微信客户会话侧边栏打开");
    }
    const result = await invoke(sdk, "getCurExternalContact", { entry: context.entry });
    if (!validId(result.userId)) throw new Error("企业微信客户身份无效");
    return { target_type: "client", external_userid: result.userId };
  }
  if (context.entry !== "group_chat_tools") throw new Error("请从企业微信群会话侧边栏打开");
  const result = await invoke(sdk, "getCurExternalChat", { entry: context.entry });
  if (!validId(result.chatId)) throw new Error("企业微信群身份无效");
  return { target_type: "group", chat_id: result.chatId };
}

function sameTarget(left: WorkContextTarget, right: WorkContextTarget): boolean {
  return left.target_type === right.target_type && (left.target_type === "client"
    ? right.target_type === "client" && left.external_userid === right.external_userid
    : right.target_type === "group" && left.chat_id === right.chat_id);
}

function targetChangedError() {
  return new Error("企业微信当前会话已切换，请重新授权");
}

/** Fail closed when a no-hint page no longer belongs to the SDK's current chat. */
export async function assertCurrentWorkTarget(kind: WorkKind, expectedToken: string): Promise<void> {
  const context = currentWorkContext(kind);
  if (!context || context.token !== expectedToken) throw new Error("企业微信授权已过期，请重新授权");
  let observed: WorkContextTarget;
  try { observed = await discoverTarget(kind); }
  catch (cause) {
    clearWorkContext(expectedToken);
    throw cause;
  }
  if (!sameTarget(context.target, observed) || currentWorkContext(kind)?.token !== expectedToken) {
    clearWorkContext(expectedToken);
    throw targetChangedError();
  }
}

export async function ensureWorkContext(kind: WorkKind, returnRoute: string, hint?: string): Promise<ActiveContext> {
  if (!browser()) throw new Error("企业微信工作台仅支持 H5");
  installBackgroundGuard();
  if (!validRoute(returnRoute)) throw new Error("企业微信回跳页面无效");
  if (callback) {
    const result = callback;
    callback = null;
    const pending = readPending();
    removePending();
    if (!pending || pending.expiresAt <= Date.now() || pending.state !== result.state
      || pending.target.target_type !== kind || !result.code) throw new Error("企业微信授权已失效，请重试");
    if (pending.sdkDiscovered && !sameTarget(pending.target, await discoverTarget(kind))) {
      throw targetChangedError();
    }
    const exchanged = await exchangeWorkContext(result.state, result.code, pending.target);
    if (!exchanged.token || exchanged.target.type !== kind || exchanged.expires_in <= 0) {
      throw new Error("企业微信授权响应无效");
    }
    if (pending.sdkDiscovered && !sameTarget(pending.target, await discoverTarget(kind))) {
      throw targetChangedError();
    }
    clearWorkContext();
    active = { target: pending.target, token: exchanged.token,
      expiresAt: Date.now() + exchanged.expires_in * 1_000 };
    return active;
  }
  if (hint !== undefined && !validId(hint)) throw new Error("企业微信目标身份无效");
  const target: WorkContextTarget = hint
    ? kind === "client" ? { target_type: "client", external_userid: hint } : { target_type: "group", chat_id: hint }
    : await discoverTarget(kind);
  const cached = currentWorkContext(kind);
  if (cached && sameTarget(cached.target, target)) return cached;
  if (cached) clearWorkContext(cached.token);
  const redirectUri = `${window.location.origin}${window.location.pathname}?work_oauth=1`;
  const challenge = await createWorkContextChallenge(redirectUri);
  if (!/^[a-f0-9]{64}$/i.test(challenge.state) || challenge.expires_in <= 0) {
    throw new Error("企业微信授权挑战无效");
  }
  const authorization = new URL(challenge.authorization_url);
  if (authorization.protocol !== "https:" || authorization.hostname !== "open.weixin.qq.com") {
    throw new Error("企业微信授权地址无效");
  }
  const pending: PendingContext = { state: challenge.state, target, sdkDiscovered: hint === undefined, returnRoute,
    expiresAt: Date.now() + challenge.expires_in * 1_000 };
  window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  window.location.assign(authorization.href);
  throw new WorkAuthorizationRedirect();
}

export async function sendWorkProduct(product: { id: number; store_name: string; image: string }, expectedToken: string) {
  if (!Number.isSafeInteger(product.id) || product.id <= 0) throw new Error("商品 ID 无效");
  const current = currentWorkContext("client");
  if (!current || current.token !== expectedToken) throw new Error("企业微信客户授权已过期");
  const sdk = await configuredSdk();
  const observed = await discoverTarget("client", sdk);
  if (!sameTarget(current.target, observed) || currentWorkContext("client")?.token !== expectedToken) {
    clearWorkContext(expectedToken);
    throw new Error("企业微信当前会话已切换，请重新授权后推送");
  }
  const link = `${window.location.origin}${window.location.pathname}#/pages/goods/detail?id=${product.id}`;
  await invoke(sdk, "sendChatMessage", {
    msgtype: "news", enterChat: true,
    news: { link, title: product.store_name.slice(0, 100), desc: "", imgUrl: product.image },
  });
}
