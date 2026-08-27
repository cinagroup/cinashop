<template>
  <div class="phone-page container">
    <el-card class="phone-card" shadow="never" v-loading="profileLoading">
      <template #header>
        <div class="header">
          <div>
            <h1>手机号管理</h1>
            <p>{{ hasPhone ? "验证新手机号后完成更换" : "绑定手机号后可使用短信登录和找回密码" }}</p>
          </div>
          <router-link to="/user">返回用户中心</router-link>
        </div>
      </template>

      <el-descriptions v-if="hasPhone" :column="1" border class="current-phone">
        <el-descriptions-item label="当前手机号">{{ maskedPhone }}</el-descriptions-item>
      </el-descriptions>
      <el-alert
        :title="hasPhone ? '验证码将发送到新手机号；更换后请使用新手机号登录。' : '当前账号尚未绑定手机号。'"
        type="info"
        :closable="false"
        show-icon
      />

      <el-form label-position="top" class="phone-form" @submit.prevent="submit">
        <el-form-item :label="hasPhone ? '新手机号' : '手机号'">
          <el-input v-model.trim="phone" maxlength="11" size="large" placeholder="请输入 11 位手机号" />
        </el-form-item>
        <el-form-item label="短信验证码">
          <div class="code-row">
            <el-input v-model.trim="captcha" maxlength="6" size="large" placeholder="请输入 6 位验证码" />
            <el-button
              size="large"
              :loading="codeSending"
              :disabled="profileLoading || countdown > 0"
              @click="sendCode"
            >
              {{ countdown > 0 ? `${countdown}s 后重试` : "获取验证码" }}
            </el-button>
          </div>
        </el-form-item>
        <el-button type="primary" size="large" class="submit" :loading="saving" @click="submit">
          {{ hasPhone ? "确认更换" : "确认绑定" }}
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiBindPhone, apiRequestCode, apiUpdatePhone } from "@/api/auth";
import { apiUserInfo, type UserInfo } from "@/api/user";
import { requestSmsChallenge } from "@/composables/smsChallenge";

const profile = ref<UserInfo | null>(null);
const phone = ref("");
const captcha = ref("");
const profileLoading = ref(true);
const codeSending = ref(false);
const saving = ref(false);
const countdown = ref(0);
let countdownTimer: ReturnType<typeof setInterval> | undefined;

const currentPhone = computed(() => String(profile.value?.phone ?? "").trim());
const hasPhone = computed(() => /^1\d{10}$/.test(currentPhone.value));
const maskedPhone = computed(() => hasPhone.value
  ? `${currentPhone.value.slice(0, 3)}****${currentPhone.value.slice(-4)}`
  : "未绑定");

async function loadProfile(): Promise<void> {
  profileLoading.value = true;
  try {
    profile.value = await apiUserInfo();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "用户信息加载失败");
  } finally {
    profileLoading.value = false;
  }
}

function validatePhone(): boolean {
  if (!/^1\d{10}$/.test(phone.value)) {
    ElMessage.warning("请输入正确的手机号");
    return false;
  }
  if (hasPhone.value && phone.value === currentPhone.value) {
    ElMessage.warning("新手机号不能与当前手机号相同");
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
  if (profileLoading.value || countdown.value > 0 || codeSending.value || !validatePhone()) return;
  codeSending.value = true;
  try {
    const type = hasPhone.value ? "update_phone" : "binding";
    const key = await requestSmsChallenge(phone.value, type);
    await apiRequestCode(phone.value, type, key);
    ElMessage.success("验证码任务已提交");
    startCountdown();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "验证码发送失败");
  } finally {
    codeSending.value = false;
  }
}

async function submit(): Promise<void> {
  if (profileLoading.value || !validatePhone()) return;
  if (!/^\d{6}$/.test(captcha.value)) return void ElMessage.warning("请输入 6 位验证码");
  saving.value = true;
  try {
    if (hasPhone.value) await apiUpdatePhone(phone.value, captcha.value);
    else await apiBindPhone(phone.value, captcha.value);
    ElMessage.success(hasPhone.value ? "手机号已更换" : "手机号已绑定");
    phone.value = "";
    captcha.value = "";
    await loadProfile();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "手机号修改失败");
  } finally {
    saving.value = false;
  }
}

onMounted(loadProfile);
onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});
</script>

<style scoped>
.phone-page {
  padding-top: 28px;
  padding-bottom: 48px;
}

.phone-card {
  width: min(100%, 620px);
  margin: 0 auto;
  border-radius: 14px;
}

.header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
}

.header h1 {
  margin: 0;
  font-size: 22px;
}

.header p {
  margin: 8px 0 0;
  color: #888;
  font-size: 14px;
}

.header a {
  flex-shrink: 0;
  color: #e64340;
  font-size: 14px;
  text-decoration: none;
}

.current-phone {
  margin-bottom: 16px;
}

.phone-form {
  margin-top: 24px;
}

.code-row {
  display: flex;
  gap: 10px;
  width: 100%;
}

.code-row .el-button {
  min-width: 132px;
}

.submit {
  width: 100%;
}

@media (max-width: 560px) {
  .code-row {
    flex-direction: column;
  }

  .code-row .el-button {
    width: 100%;
  }
}
</style>
