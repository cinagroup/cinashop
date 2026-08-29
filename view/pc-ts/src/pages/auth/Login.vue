<template>
  <div class="login-page">
    <div class="login-box">
      <h1 class="title">CinaShop 登录</h1>
      <el-alert
        v-if="oauthCallbackLoading"
        title="正在安全校验微信授权…"
        type="info"
        :closable="false"
        show-icon
        class="callback-alert"
      />
      <el-tabs v-model="tab">
        <el-tab-pane label="账号登录" name="account">
          <el-form :model="form" label-position="top">
            <el-form-item label="手机号">
              <el-input v-model="form.account" placeholder="请输入手机号" size="large" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input
                v-model="form.password"
                type="password"
                placeholder="请输入密码"
                size="large"
                show-password
                @keyup.enter="handleLogin"
              />
            </el-form-item>
            <el-button type="primary" size="large" class="submit-btn" :loading="loading" @click="handleLogin">
              登录
            </el-button>
            <div class="password-help"><router-link to="/forgot-password">忘记密码?</router-link></div>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="手机号登录" name="mobile">
          <el-form :model="form" label-position="top">
            <el-form-item label="手机号">
              <el-input v-model="form.phone" placeholder="请输入手机号" size="large" />
            </el-form-item>
            <el-form-item label="验证码">
              <div class="code-row">
                <el-input v-model="form.captcha" placeholder="请输入验证码" size="large" />
                <el-button size="large" :loading="codeSending" :disabled="countdown > 0" @click="sendCode">
                  {{ countdown > 0 ? `${countdown}s 后重试` : "获取验证码" }}
                </el-button>
              </div>
            </el-form-item>
            <el-button type="primary" size="large" class="submit-btn" :loading="loading" @click="handleMobileLogin">
              登录/注册
            </el-button>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="扫码登录" name="scan">
          <div class="scan-panel" aria-live="polite">
            <div v-if="scanLoading" class="scan-placeholder">正在创建一次性登录二维码…</div>
            <img
              v-else-if="scanQrDataUrl"
              :src="scanQrDataUrl"
              class="scan-qr"
              alt="CinaShop 一次性登录二维码"
            />
            <div v-else class="scan-placeholder">二维码尚未生成</div>
            <p class="scan-status" :class="{ scanned: scanStage === 'scanned' }">{{ scanStatus }}</p>
            <p class="scan-help">使用已登录的 CinaShop 移动端扫描，并核对站点和设备后确认。</p>
            <el-button :loading="scanLoading" @click="startScanChallenge">刷新二维码</el-button>
          </div>
        </el-tab-pane>
      </el-tabs>

      <div class="wechat-login">
        <div class="divider"><span>其他登录方式</span></div>
        <el-button
          class="wechat-button"
          size="large"
          :loading="oauthStarting"
          :disabled="!wechatAvailable || oauthCallbackLoading"
          @click="startWechatLogin"
        >
          微信开放平台登录
        </el-button>
        <p v-if="configLoaded && !wechatAvailable" class="config-note">
          微信开放平台尚未配置，当前保持安全关闭。
        </p>
      </div>

      <div class="to-register">没有账号? <router-link to="/register">立即注册</router-link></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import QRCode from "qrcode";
import { onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  apiCreatePcOauthState,
  apiCreatePcScanChallenge,
  apiPcAppConfig,
  apiPcWechatAuth,
  apiPollPcScanChallenge,
  apiRequestCode,
} from "@/api/auth";
import { requestSmsChallenge } from "@/composables/smsChallenge";
import { useAuthStore } from "@/stores/auth";

type LoginTab = "account" | "mobile" | "scan";
type ScanStage = "idle" | "pending" | "scanned" | "expired";

const OAUTH_REDIRECT_KEY = "cinashop_pc_oauth_redirect";
const DEFAULT_SCAN_URL = "https://cinashop-h5.pages.dev/#/pages/auth/scanLogin";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const tab = ref<LoginTab>("account");
const loading = ref(false);
const countdown = ref(0);
const codeSending = ref(false);
const oauthStarting = ref(false);
const oauthCallbackLoading = ref(false);
const appid = ref("");
const configLoaded = ref(false);
const wechatAvailable = ref(false);
const scanLoading = ref(false);
const scanQrDataUrl = ref("");
const scanStatus = ref("打开此标签后生成一次性二维码");
const scanStage = ref<ScanStage>("idle");

let countdownTimer: ReturnType<typeof setInterval> | undefined;
let scanPollTimer: ReturnType<typeof setTimeout> | undefined;
let scanGeneration = 0;
let scanKey = "";
let scanPollToken = "";
let scanExpiresAt = 0;

const form = reactive({ account: "", password: "", phone: "", captcha: "" });

function queryText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeRedirect(value: unknown): string {
  const candidate = queryText(value).trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/";
  try {
    const resolved = new URL(candidate, window.location.origin);
    if (resolved.origin !== window.location.origin || resolved.pathname === "/login") return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

const requestedRedirect = safeRedirect(route.query.redirect);

async function redirectAfterLogin(fromOauth = false) {
  const stored = fromOauth ? sessionStorage.getItem(OAUTH_REDIRECT_KEY) : null;
  sessionStorage.removeItem(OAUTH_REDIRECT_KEY);
  await router.replace(safeRedirect(stored ?? requestedRedirect));
}

async function handleLogin() {
  if (!form.account) return ElMessage.error("请输入手机号");
  if (!form.password) return ElMessage.error("请输入密码");
  loading.value = true;
  try {
    await authStore.login(form.account, form.password);
    ElMessage.success("登录成功");
    await redirectAfterLogin();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "登录失败");
  } finally {
    loading.value = false;
  }
}

async function handleMobileLogin() {
  if (!/^1\d{10}$/.test(form.phone)) return ElMessage.warning("请输入正确的手机号");
  if (!/^\d{6}$/.test(form.captcha)) return ElMessage.warning("请输入 6 位验证码");
  loading.value = true;
  try {
    await authStore.mobileLogin(form.phone, form.captcha);
    ElMessage.success("登录成功");
    await redirectAfterLogin();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "登录失败");
  } finally {
    loading.value = false;
  }
}

async function sendCode() {
  if (!/^1\d{10}$/.test(form.phone)) return ElMessage.warning("请输入正确的手机号");
  codeSending.value = true;
  try {
    const key = await requestSmsChallenge(form.phone, "mobile");
    await apiRequestCode(form.phone, "mobile", key);
    ElMessage.success("验证码任务已提交");
    countdown.value = 60;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0 && countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = undefined;
      }
    }, 1000);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "验证码发送失败");
  } finally {
    codeSending.value = false;
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
  if (clearDisplay) {
    scanQrDataUrl.value = "";
    scanStage.value = "idle";
    scanStatus.value = "打开此标签后生成一次性二维码";
  }
}

function scheduleScanPoll(generation: number, delay = 1800) {
  if (generation !== scanGeneration || tab.value !== "scan") return;
  scanPollTimer = setTimeout(() => void pollScanChallenge(generation), delay);
}

async function pollScanChallenge(generation: number) {
  if (generation !== scanGeneration || tab.value !== "scan" || !scanKey || !scanPollToken) return;
  if (Date.now() >= scanExpiresAt) {
    scanStage.value = "expired";
    scanStatus.value = "二维码已过期，请刷新";
    stopScan(false);
    return;
  }
  try {
    const result = await apiPollPcScanChallenge(scanKey, scanPollToken);
    if (generation !== scanGeneration) return;
    if (result.status === 3) {
      authStore.applyLogin({ token: result.token, expires_time: result.exp_time });
      scanStatus.value = "已确认，正在登录…";
      stopScan(false);
      ElMessage.success("扫码登录成功");
      await redirectAfterLogin();
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
  scheduleScanPoll(generation);
}

async function startScanChallenge() {
  stopScan();
  const generation = scanGeneration;
  scanLoading.value = true;
  scanStatus.value = "正在创建一次性登录二维码…";
  try {
    const challenge = await apiCreatePcScanChallenge();
    if (generation !== scanGeneration || tab.value !== "scan") return;
    scanKey = challenge.key;
    // Closure only: never QR, URL, DOM, logs, or persistent storage.
    scanPollToken = challenge.poll_token;
    scanExpiresAt = challenge.time * 1000;
    scanQrDataUrl.value = await QRCode.toDataURL(scanApprovalUrl(challenge.key), {
      width: 232,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    if (generation !== scanGeneration) return;
    scanStage.value = "pending";
    scanStatus.value = "等待手机扫码";
    scheduleScanPoll(generation, 300);
  } catch (error) {
    if (generation === scanGeneration) {
      scanStage.value = "expired";
      scanStatus.value = error instanceof Error ? error.message : "二维码创建失败";
    }
  } finally {
    if (generation === scanGeneration) scanLoading.value = false;
  }
}

async function loadPcConfig() {
  try {
    const config = await apiPcAppConfig();
    appid.value = config.appid.trim();
    wechatAvailable.value = /^wx[a-zA-Z0-9]{6,64}$/.test(appid.value);
  } catch {
    appid.value = "";
    wechatAvailable.value = false;
  } finally {
    configLoaded.value = true;
  }
}

async function startWechatLogin() {
  if (!wechatAvailable.value || oauthStarting.value) return;
  oauthStarting.value = true;
  try {
    const { state } = await apiCreatePcOauthState();
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
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "微信授权启动失败");
    oauthStarting.value = false;
  }
}

async function handleOauthCallback() {
  const code = queryText(route.query.code);
  const state = queryText(route.query.state);
  if (!code && !state) return;
  const cleanQuery = { ...route.query };
  delete cleanQuery.code;
  delete cleanQuery.state;
  await router.replace({ path: route.path, query: cleanQuery, hash: route.hash });
  if (!code || !state) {
    ElMessage.error("微信授权回调缺少安全参数，请重新发起登录");
    return;
  }
  oauthCallbackLoading.value = true;
  try {
    const result = await apiPcWechatAuth(code, state);
    authStore.applyLogin({ token: result.token, expires_time: result.exp_time });
    ElMessage.success("微信登录成功");
    await redirectAfterLogin(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "微信登录失败");
  } finally {
    oauthCallbackLoading.value = false;
  }
}

watch(tab, (value) => {
  if (value === "scan") void startScanChallenge();
  else stopScan();
});

onMounted(() => {
  void loadPcConfig();
  void handleOauthCallback();
});

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
  stopScan();
});
</script>

<style scoped>
.login-page {
  min-height: calc(100vh - 150px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: linear-gradient(135deg, #f6f6f6 0%, #fff 100%);
}
.login-box { width: min(440px, 100%); background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08); }
.title { text-align: center; font-size: 22px; margin: 0 0 24px; }
.callback-alert { margin-bottom: 16px; }
.submit-btn { width: 100%; margin-top: 8px; }
.code-row { display: flex; gap: 10px; width: 100%; }
.to-register { text-align: center; margin-top: 16px; font-size: 14px; color: #666; }
.to-register a, .password-help a { color: #e64340; text-decoration: none; }
.password-help { margin-top: 12px; text-align: right; font-size: 14px; }
.scan-panel { min-height: 340px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.scan-qr { width: 232px; height: 232px; border: 1px solid #ececec; border-radius: 8px; }
.scan-placeholder { width: 232px; height: 232px; display: grid; place-items: center; color: #888; background: #f7f7f7; border-radius: 8px; }
.scan-status { margin: 14px 0 4px; color: #555; font-weight: 600; }
.scan-status.scanned { color: #16a267; }
.scan-help { margin: 0 0 14px; color: #999; font-size: 13px; line-height: 1.6; }
.wechat-login { margin-top: 8px; text-align: center; }
.divider { display: flex; align-items: center; gap: 12px; margin: 12px 0; color: #aaa; font-size: 12px; }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #eee; }
.wechat-button { width: 100%; color: #158f55; border-color: #b8e4cb; }
.config-note { margin: 8px 0 0; color: #999; font-size: 12px; }
@media (max-width: 520px) { .login-box { padding: 28px 22px; } }
</style>
