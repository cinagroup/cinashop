<template>
  <view class="scan-page">
    <view class="scan-card">
      <view class="shield">✓</view>
      <view class="title">确认登录请求</view>
      <view class="subtitle">请核对以下信息。若不是你本人刚刚扫码，请立即拒绝。</view>

      <view v-if="status === 'loading'" class="state-box">正在检查一次性登录请求…</view>
      <view v-else-if="status === 'error'" class="state-box error">
        <view>{{ error }}</view>
        <button v-if="canRetryLogin" class="retry-login" @tap="retryLogin">重新登录</button>
      </view>
      <template v-else-if="challenge">
        <view class="target-card">
          <view class="target-row">
            <text>登录目标</text>
            <strong>{{ challenge.target.name }}</strong>
          </view>
          <view class="target-row">
            <text>请求站点</text>
            <strong class="origin">{{ challenge.target.origin }}</strong>
          </view>
          <view class="target-row">
            <text>请求设备</text>
            <strong>{{ challenge.target.device }}</strong>
          </view>
          <view class="target-row">
            <text>剩余时间</text>
            <strong>{{ Math.max(0, challenge.expires_in) }} 秒</strong>
          </view>
        </view>

        <view v-if="status === 'approved' || status === 'rejected'" class="approved-box" :class="{ rejected: status === 'rejected' }">
          {{ status === "approved" ? "已确认。请返回发起登录的浏览器继续操作。" : "已拒绝并撤销本次登录请求。" }}
        </view>
        <view v-else class="actions">
          <button class="approve" :loading="approving" :disabled="approving || rejecting" @tap="approve">
            确认登录
          </button>
          <button class="reject" :loading="rejecting" :disabled="approving || rejecting" @tap="reject">不是本人，拒绝</button>
        </view>
      </template>
    </view>
    <view class="security-note">站点和设备来自发起请求，只用于人工核对，并不能证明对方身份。仅在你刚刚主动发起登录时确认；二维码不会要求密码或验证码。</view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";
import {
  apiApproveLoginCode,
  apiInspectLoginCode,
  apiRejectLoginCode,
  type ScanLoginApproval,
} from "@/api/auth";
import { useAuthStore } from "@/stores/auth";

type PageStatus = "idle" | "loading" | "ready" | "approved" | "rejected" | "error";

const authStore = useAuthStore();
const key = ref("");
const status = ref<PageStatus>("idle");
const error = ref("");
const challenge = ref<ScanLoginApproval | null>(null);
const approving = ref(false);
const rejecting = ref(false);
const canRetryLogin = ref(false);
let requestedLogin = false;

function validKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function inspect() {
  if (
    !key.value
    || status.value === "loading"
    || status.value === "ready"
    || status.value === "approved"
    || status.value === "rejected"
  ) return;
  if (!authStore.isLoggedIn) {
    if (!requestedLogin) {
      requestedLogin = true;
      canRetryLogin.value = false;
      uni.navigateTo({ url: "/pages/auth/login" });
    }
    return;
  }
  requestedLogin = false;
  status.value = "loading";
  error.value = "";
  try {
    challenge.value = await apiInspectLoginCode(key.value);
    status.value = ["approved", "issuing", "delivered"].includes(challenge.value.stage)
      ? "approved"
      : "ready";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "登录请求无效或已过期";
    status.value = "error";
  }
}

function retryLogin() {
  requestedLogin = false;
  canRetryLogin.value = false;
  status.value = "idle";
  error.value = "";
  void inspect();
}

async function approve() {
  if (!challenge.value || approving.value || rejecting.value) return;
  approving.value = true;
  try {
    challenge.value = await apiApproveLoginCode(key.value);
    status.value = "approved";
    uni.showToast({ title: "已确认登录", icon: "success" });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "确认失败";
    status.value = "error";
  } finally {
    approving.value = false;
  }
}

async function reject() {
  if (!challenge.value || approving.value || rejecting.value) return;
  rejecting.value = true;
  try {
    challenge.value = await apiRejectLoginCode(key.value);
    status.value = "rejected";
    uni.showToast({ title: "已拒绝登录", icon: "none" });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "拒绝失败";
    status.value = "error";
  } finally {
    rejecting.value = false;
  }
}

onLoad((options) => {
  const value = String(options?.key ?? "").trim().toLowerCase();
  if (!validKey(value)) {
    status.value = "error";
    error.value = "二维码格式无效，请重新扫描";
    return;
  }
  key.value = value;
});

onShow(() => {
  if (requestedLogin && !authStore.isLoggedIn) {
    requestedLogin = false;
    status.value = "error";
    error.value = "登录后才能确认本次请求";
    canRetryLogin.value = true;
    return;
  }
  void inspect();
});
</script>

<style scoped>
.scan-page { min-height: 100vh; padding: 80rpx 32rpx 48rpx; background: linear-gradient(180deg, #fff5f2 0%, #f5f6f8 58%); }
.scan-card { padding: 48rpx 34rpx 40rpx; border-radius: 28rpx; background: #fff; box-shadow: 0 18rpx 60rpx rgba(44, 34, 31, .08); }
.shield { display: grid; place-items: center; width: 88rpx; height: 88rpx; margin: 0 auto 24rpx; border-radius: 50%; color: #fff; background: #22a866; font-size: 46rpx; font-weight: 800; }
.title { color: #25292c; font-size: 38rpx; font-weight: 800; text-align: center; }
.subtitle { margin: 18rpx auto 36rpx; color: #858b90; font-size: 25rpx; line-height: 1.7; text-align: center; }
.state-box { padding: 34rpx 24rpx; border-radius: 16rpx; color: #667078; background: #f5f7f8; font-size: 27rpx; text-align: center; }
.state-box.error { color: #c23c2f; background: #fff0ed; }
.retry-login { width: 240rpx; height: 72rpx; margin-top: 24rpx; border-radius: 36rpx; color: #fff; background: #e94432; font-size: 25rpx; line-height: 72rpx; }
.target-card { overflow: hidden; border: 2rpx solid #eceff1; border-radius: 18rpx; }
.target-row { display: flex; justify-content: space-between; gap: 24rpx; padding: 26rpx 24rpx; border-bottom: 2rpx solid #f0f2f3; font-size: 26rpx; }
.target-row:last-child { border-bottom: 0; }
.target-row text { flex: 0 0 auto; color: #8b9297; }
.target-row strong { min-width: 0; color: #30363a; font-weight: 700; text-align: right; overflow-wrap: anywhere; }
.target-row .origin { color: #16774b; font-size: 24rpx; }
.actions { display: grid; gap: 20rpx; margin-top: 38rpx; }
.actions button { height: 88rpx; border-radius: 44rpx; font-size: 29rpx; }
.approve { color: #fff; background: #e94432; }
.reject { color: #646d72; background: #f1f3f4; }
.approved-box { margin-top: 34rpx; padding: 28rpx; border-radius: 16rpx; color: #177447; background: #edf9f2; font-size: 27rpx; line-height: 1.65; text-align: center; }
.approved-box.rejected { color: #a33b31; background: #fff0ed; }
.security-note { padding: 28rpx 26rpx 0; color: #969da2; font-size: 23rpx; line-height: 1.65; text-align: center; }
</style>
