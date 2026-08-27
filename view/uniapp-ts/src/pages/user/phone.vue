<template>
  <view class="phone-page">
    <view class="status-card">
      <view class="status-label">当前状态</view>
      <view class="status-value">{{ hasPhone ? maskedPhone : "未绑定手机号" }}</view>
      <view class="status-tip">
        {{ hasPhone ? "验证码将发送到新手机号，更换后请使用新手机号登录" : "绑定后可使用短信登录和找回密码" }}
      </view>
    </view>

    <view class="form-card">
      <view class="form-label">{{ hasPhone ? "新手机号" : "手机号" }}</view>
      <view class="form-item">
        <input v-model="phone" class="input" type="number" maxlength="11" placeholder="请输入 11 位手机号" />
      </view>
      <view class="form-label">短信验证码</view>
      <view class="form-item code-row">
        <input v-model="captcha" class="input code-input" type="number" maxlength="6" placeholder="请输入 6 位验证码" />
        <view :class="['code-button', { disabled: countdown > 0 || codeSending || loading }]" @tap="sendCode">
          {{ countdown > 0 ? `${countdown}s` : (codeSending ? "提交中" : "获取验证码") }}
        </view>
      </view>
      <view :class="['submit', { disabled: saving || loading }]" @tap="submit">
        {{ saving ? "提交中" : (hasPhone ? "确认更换" : "确认绑定") }}
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { apiBindPhone, apiRequestCode, apiUpdatePhone } from "@/api/auth";
import { http } from "@/utils/request";
import { requestSmsChallenge, resumePendingSmsChallenge } from "@/utils/smsChallenge";

interface UserPhoneInfo {
  phone?: string;
}

const currentPhone = ref("");
const phone = ref("");
const captcha = ref("");
const loading = ref(true);
const codeSending = ref(false);
const saving = ref(false);
const countdown = ref(0);
let countdownTimer: ReturnType<typeof setInterval> | undefined;

const hasPhone = computed(() => /^1\d{10}$/.test(currentPhone.value));
const maskedPhone = computed(() => hasPhone.value
  ? `${currentPhone.value.slice(0, 3)}****${currentPhone.value.slice(-4)}`
  : "未绑定手机号");

async function loadProfile(): Promise<void> {
  loading.value = true;
  try {
    const result = await http.get<UserPhoneInfo>("/user/info");
    currentPhone.value = String(result.phone ?? "").trim();
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "用户信息加载失败", icon: "none" });
  } finally {
    loading.value = false;
  }
}

function validatePhone(): boolean {
  if (!/^1\d{10}$/.test(phone.value)) {
    uni.showToast({ title: "请输入正确的手机号", icon: "none" });
    return false;
  }
  if (hasPhone.value && phone.value === currentPhone.value) {
    uni.showToast({ title: "新手机号不能与当前手机号相同", icon: "none" });
    return false;
  }
  return true;
}

function startCountdown(): void {
  countdown.value = 60;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
  }, 1000);
}

async function sendCode(): Promise<void> {
  if (loading.value || codeSending.value || countdown.value > 0 || !validatePhone()) return;
  codeSending.value = true;
  try {
    const type = hasPhone.value ? "update_phone" : "binding";
    const key = await requestSmsChallenge(phone.value, type);
    await apiRequestCode(phone.value, type, key);
    uni.showToast({ title: "验证码任务已提交", icon: "success" });
    startCountdown();
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "验证码发送失败", icon: "none" });
  } finally {
    codeSending.value = false;
  }
}

async function submit(): Promise<void> {
  if (loading.value || saving.value || !validatePhone()) return;
  if (!/^\d{6}$/.test(captcha.value)) return uni.showToast({ title: "请输入 6 位验证码", icon: "none" });
  saving.value = true;
  try {
    if (hasPhone.value) await apiUpdatePhone(phone.value, captcha.value);
    else await apiBindPhone(phone.value, captcha.value);
    uni.showToast({ title: hasPhone.value ? "手机号已更换" : "手机号已绑定", icon: "success" });
    phone.value = "";
    captcha.value = "";
    await loadProfile();
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "手机号修改失败", icon: "none" });
  } finally {
    saving.value = false;
  }
}

onShow(() => {
  void loadProfile();
  void resumePendingSmsChallenge();
});
onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});
</script>

<style scoped>
.phone-page {
  min-height: 100vh;
  padding: 28rpx;
  box-sizing: border-box;
  background: #f6f6f6;
}

.status-card,
.form-card {
  padding: 32rpx;
  border-radius: 18rpx;
  background: #fff;
}

.status-card {
  margin-bottom: 24rpx;
  background: linear-gradient(135deg, #e93323, #ff795d);
  color: #fff;
}

.status-label {
  font-size: 24rpx;
  opacity: 0.8;
}

.status-value {
  margin-top: 12rpx;
  font-size: 38rpx;
  font-weight: 700;
  letter-spacing: 2rpx;
}

.status-tip {
  margin-top: 16rpx;
  font-size: 24rpx;
  line-height: 1.5;
  opacity: 0.88;
}

.form-label {
  margin: 8rpx 0 14rpx;
  color: #555;
  font-size: 26rpx;
}

.form-item {
  margin-bottom: 28rpx;
  padding: 24rpx 26rpx;
  border-radius: 14rpx;
  background: #f7f7f7;
}

.input {
  font-size: 28rpx;
}

.code-row {
  display: flex;
  align-items: center;
}

.code-input {
  flex: 1;
}

.code-button {
  flex-shrink: 0;
  padding-left: 22rpx;
  color: #e93323;
  font-size: 25rpx;
}

.code-button.disabled,
.submit.disabled {
  opacity: 0.55;
}

.submit {
  margin-top: 34rpx;
  padding: 24rpx;
  border-radius: 42rpx;
  background: #e93323;
  color: #fff;
  font-size: 30rpx;
  text-align: center;
}
</style>
