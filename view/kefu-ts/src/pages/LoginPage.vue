<script setup lang="ts">
import QRCode from "qrcode";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { kefuApi } from "@/api/kefu";
import UiIcon from "@/components/UiIcon.vue";
import { useAuthStore } from "@/stores/auth";

type LoginMode = "password" | "scan";
type ScanStage = "idle" | "pending" | "scanned" | "expired";

const DEFAULT_SCAN_URL = "https://cinashop-h5.pages.dev/#/pages/auth/scanLogin";
const OAUTH_REDIRECT_KEY = "cinashop_kefu_oauth_redirect";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const mode = ref<LoginMode>("password");
const account = ref("");
const password = ref("");
const loading = ref(false);
const error = ref("");
const appid = ref("");
const configLoaded = ref(false);
const oauthStarting = ref(false);
const oauthCallbackLoading = ref(false);
const scanLoading = ref(false);
const scanQrDataUrl = ref("");
const scanStatus = ref("切换到扫码登录后生成一次性二维码");
const scanStage = ref<ScanStage>("idle");

let scanPollTimer: ReturnType<typeof setTimeout> | undefined;
let scanGeneration = 0;
let scanKey = "";
let scanPollToken = "";
let scanExpiresAt = 0;

function textQuery(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeRedirect(value: unknown): string {
  const candidate = textQuery(value).trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/workbench";
  try {
    const target = new URL(candidate, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname === "/login") return "/workbench";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/workbench";
  }
}

const requestedRedirect = safeRedirect(route.query.redirect);

async function finishLogin(fromOauth = false) {
  const stored = fromOauth ? sessionStorage.getItem(OAUTH_REDIRECT_KEY) : null;
  sessionStorage.removeItem(OAUTH_REDIRECT_KEY);
  await router.replace(safeRedirect(stored ?? requestedRedirect));
}

async function submit() {
  if (!account.value.trim() || !password.value) {
    error.value = "请输入客服账号和密码";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    await auth.login(account.value, password.value);
    await finishLogin();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "登录失败";
  } finally {
    loading.value = false;
  }
}

function scanApprovalUrl(key: string): string {
  const base = String(import.meta.env.VITE_SCAN_LOGIN_URL || DEFAULT_SCAN_URL).trim();
  return `${base}${base.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
}

function stopScan(clearDisplay = true) {
  scanGeneration += 1;
  if (scanPollTimer) clearTimeout(scanPollTimer);
  scanPollTimer = undefined;
  scanKey = "";
  scanPollToken = "";
  scanExpiresAt = 0;
  scanLoading.value = false;
  if (clearDisplay) {
    scanQrDataUrl.value = "";
    scanStage.value = "idle";
    scanStatus.value = "切换到扫码登录后生成一次性二维码";
  }
}

function schedulePoll(generation: number, delay = 1800) {
  if (generation !== scanGeneration || mode.value !== "scan") return;
  scanPollTimer = setTimeout(() => void pollScan(generation), delay);
}

async function pollScan(generation: number) {
  if (generation !== scanGeneration || mode.value !== "scan" || !scanKey || !scanPollToken) return;
  if (Date.now() >= scanExpiresAt) {
    scanStage.value = "expired";
    scanStatus.value = "二维码已过期，请刷新";
    stopScan(false);
    return;
  }
  try {
    const result = await kefuApi.pollScanChallenge(scanKey, scanPollToken);
    if (generation !== scanGeneration) return;
    if (result.status === 3) {
      auth.applyLogin(result);
      scanStatus.value = "已确认，正在进入工作台…";
      stopScan(false);
      await finishLogin();
      return;
    }
    if (result.status === 1) {
      scanStage.value = "scanned";
      scanStatus.value = "已扫码，请在手机端核对并确认";
    } else if (result.status === 2) {
      scanStage.value = "pending";
      scanStatus.value = "等待手机扫码";
    } else {
      scanStage.value = "expired";
      scanStatus.value = "二维码无效或已过期，请刷新";
      stopScan(false);
      return;
    }
  } catch {
    if (generation !== scanGeneration) return;
    scanStatus.value = "网络暂时不可用，正在重试";
  }
  schedulePoll(generation);
}

async function startScan() {
  stopScan();
  const generation = scanGeneration;
  scanLoading.value = true;
  error.value = "";
  scanStatus.value = "正在创建一次性登录二维码…";
  try {
    const challenge = await kefuApi.createScanChallenge();
    if (generation !== scanGeneration || mode.value !== "scan") return;
    scanKey = challenge.key;
    // Browser capability stays only in this closure; the QR contains the public key only.
    scanPollToken = challenge.poll_token;
    scanExpiresAt = challenge.time * 1000;
    scanQrDataUrl.value = await QRCode.toDataURL(scanApprovalUrl(challenge.key), {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    if (generation !== scanGeneration) return;
    scanStage.value = "pending";
    scanStatus.value = "等待手机扫码";
    schedulePoll(generation, 300);
  } catch (cause) {
    if (generation === scanGeneration) {
      scanStage.value = "expired";
      scanStatus.value = cause instanceof Error ? cause.message : "二维码创建失败";
    }
  } finally {
    if (generation === scanGeneration) scanLoading.value = false;
  }
}

async function loadConfig() {
  try {
    const config = await kefuApi.config();
    appid.value = /^wx[a-zA-Z0-9]{6,64}$/.test(config.appid.trim()) ? config.appid.trim() : "";
  } catch {
    appid.value = "";
  } finally {
    configLoaded.value = true;
  }
}

async function startWechatLogin() {
  if (!appid.value || oauthStarting.value) return;
  oauthStarting.value = true;
  error.value = "";
  try {
    const { state } = await kefuApi.createOauthState();
    sessionStorage.setItem(OAUTH_REDIRECT_KEY, requestedRedirect);
    const callback = new URL("/login", window.location.origin).toString();
    const authorization = new URL("https://open.weixin.qq.com/connect/qrconnect");
    authorization.searchParams.set("appid", appid.value);
    authorization.searchParams.set("redirect_uri", callback);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "snsapi_login");
    authorization.searchParams.set("state", state);
    authorization.hash = "wechat_redirect";
    window.location.assign(authorization.toString());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "微信授权启动失败";
    oauthStarting.value = false;
  }
}

async function handleOauthCallback() {
  const code = textQuery(route.query.code);
  const state = textQuery(route.query.state);
  if (!code && !state) return;
  const query = { ...route.query };
  delete query.code;
  delete query.state;
  await router.replace({ path: route.path, query, hash: route.hash });
  if (!code || !state) {
    error.value = "微信授权回调缺少安全参数，请重新发起登录";
    return;
  }
  oauthCallbackLoading.value = true;
  error.value = "";
  try {
    auth.applyLogin(await kefuApi.wechatLogin(code, state));
    await finishLogin(true);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "微信登录失败";
  } finally {
    oauthCallbackLoading.value = false;
  }
}

watch(mode, (value) => {
  if (value === "scan") void startScan();
  else stopScan();
});

onMounted(() => {
  if (route.query.logout === "local-only") {
    error.value = "本机已退出，但服务器会话撤销未确认；旧会话可能持续到过期，请联系管理员禁用账号或重置密码";
  }
  void loadConfig();
  void handleOauthCallback();
});

onUnmounted(() => stopScan());
</script>

<template>
  <main class="login-page">
    <section class="login-brand" aria-label="CinaShop 客服工作台">
      <div class="brand-mark">C</div>
      <div>
        <p class="eyebrow">CINASHOP SERVICE</p>
        <h1>让每一次响应<br />都有清晰上下文</h1>
        <p class="brand-copy">独立客服安全域，连接实时会话、客户资料与标准话术。</p>
      </div>
      <div class="brand-signal"><span></span>实时服务通道</div>
    </section>

    <section class="login-panel">
      <div class="login-card">
        <div class="mobile-brand"><span class="brand-mark small">C</span>CinaShop</div>
        <p class="eyebrow accent">客服工作台</p>
        <h2>欢迎回来</h2>
        <p class="login-intro">每次扫码都绑定当前浏览器，手机端会显示目标站点与设备。</p>

        <div class="login-modes" role="tablist" aria-label="登录方式">
          <button :class="{ active: mode === 'password' }" type="button" @click="mode = 'password'">账号密码</button>
          <button :class="{ active: mode === 'scan' }" type="button" @click="mode = 'scan'">安全扫码</button>
        </div>

        <form v-if="mode === 'password'" @submit.prevent="submit">
          <label>
            <span>客服账号</span>
            <input v-model="account" name="account" autocomplete="username" placeholder="请输入账号" />
          </label>
          <label>
            <span>密码</span>
            <input v-model="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
          </label>
          <button class="primary-button login-submit" type="submit" :disabled="loading || oauthCallbackLoading">
            <UiIcon name="message" />{{ loading ? "正在登录…" : "进入工作台" }}
          </button>
        </form>

        <div v-else class="scan-login" aria-live="polite">
          <div v-if="scanLoading" class="scan-placeholder">正在创建二维码…</div>
          <img v-else-if="scanQrDataUrl" :src="scanQrDataUrl" alt="客服工作台一次性登录二维码" />
          <div v-else class="scan-placeholder">二维码尚未生成</div>
          <strong :class="{ scanned: scanStage === 'scanned' }">{{ scanStatus }}</strong>
          <small>请在移动端核对“客服工作台”、站点域名和设备，再确认登录。</small>
          <button class="secondary-button" type="button" :disabled="scanLoading" @click="startScan">刷新二维码</button>
        </div>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>

        <div class="oauth-row">
          <span>或</span>
          <button type="button" :disabled="!appid || oauthStarting || oauthCallbackLoading" @click="startWechatLogin">
            {{ oauthCallbackLoading ? "正在校验微信授权…" : "微信开放平台登录" }}
          </button>
          <small v-if="configLoaded && !appid">开放平台未配置，当前安全关闭</small>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.login-modes { display: grid; grid-template-columns: 1fr 1fr; margin-bottom: 18px; border-bottom: 1px solid var(--line); }
.login-modes button { height: 42px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font-weight: 750; }
.login-modes button.active { border-bottom-color: var(--accent); color: var(--accent); }
.scan-login { display: grid; justify-items: center; gap: 12px; min-height: 350px; text-align: center; }
.scan-login img, .scan-placeholder { width: 220px; height: 220px; border: 1px solid var(--line); border-radius: 7px; }
.scan-placeholder { display: grid; place-items: center; color: var(--muted); background: var(--soft); font-size: 13px; }
.scan-login strong { color: #59646a; font-size: 13px; }
.scan-login strong.scanned { color: var(--green); }
.scan-login small { max-width: 310px; color: var(--muted); line-height: 1.6; }
.scan-login .secondary-button { margin-top: 2px; }
.oauth-row { display: grid; justify-items: center; gap: 8px; margin-top: 22px; }
.oauth-row > span { color: #a0a8ac; font-size: 11px; }
.oauth-row > button { width: 100%; height: 44px; border: 1px solid #b9dfc9; border-radius: 6px; color: #188b53; background: #f5fcf8; font-weight: 750; }
.oauth-row small { color: #9aa2a6; font-size: 11px; }
</style>
