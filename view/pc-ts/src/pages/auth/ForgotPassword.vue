<template>
  <div class="auth-page">
    <el-card class="auth-card" shadow="hover">
      <template #header>
        <div class="card-header">
          <div>
            <h1>找回密码</h1>
            <p>验证注册手机号后设置新密码</p>
          </div>
          <router-link to="/login">返回登录</router-link>
        </div>
      </template>

      <el-form label-position="top" @submit.prevent="submitReset">
        <el-form-item label="手机号">
          <el-input v-model.trim="form.account" maxlength="11" placeholder="请输入注册手机号" size="large" />
        </el-form-item>
        <el-form-item label="短信验证码">
          <div class="code-row">
            <el-input v-model.trim="form.captcha" maxlength="6" placeholder="请输入 6 位验证码" size="large" />
            <el-button
              size="large"
              :loading="codeSending"
              :disabled="countdown > 0"
              @click="sendCode"
            >
              {{ countdown > 0 ? `${countdown}s 后重试` : "获取验证码" }}
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="form.password" type="password" maxlength="16" show-password size="large" placeholder="6–16 位，不能使用 123456" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="form.confirm" type="password" maxlength="16" show-password size="large" placeholder="请再次输入新密码" @keyup.enter="submitReset" />
        </el-form-item>
        <el-button class="submit" type="primary" size="large" :loading="submitting" @click="submitReset">
          确认重置
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiRequestCode, apiResetPassword } from "@/api/auth";
import { requestSmsChallenge } from "@/composables/smsChallenge";

const router = useRouter();
const codeSending = ref(false);
const submitting = ref(false);
const countdown = ref(0);
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const form = reactive({ account: "", captcha: "", password: "", confirm: "" });

function validatePhone(): boolean {
  if (/^1\d{10}$/.test(form.account)) return true;
  ElMessage.warning("请输入正确的手机号");
  return false;
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
  if (countdown.value > 0 || codeSending.value || !validatePhone()) return;
  codeSending.value = true;
  try {
    const key = await requestSmsChallenge(form.account, "reset");
    await apiRequestCode(form.account, "reset", key);
    ElMessage.success("验证码任务已提交");
    startCountdown();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "验证码发送失败");
  } finally {
    codeSending.value = false;
  }
}

async function submitReset(): Promise<void> {
  if (!validatePhone()) return;
  if (!/^\d{6}$/.test(form.captcha)) return void ElMessage.warning("请输入 6 位验证码");
  if (form.password.length < 6 || form.password.length > 16) return void ElMessage.warning("密码必须为 6–16 位");
  if (form.password === "123456") return void ElMessage.warning("密码太过简单，请重新设置");
  if (form.password !== form.confirm) return void ElMessage.warning("两次密码不一致");
  submitting.value = true;
  try {
    await apiResetPassword(form.account, form.captcha, form.password);
    ElMessage.success("密码已重置，请重新登录");
    await router.replace("/login");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "密码重置失败");
  } finally {
    submitting.value = false;
  }
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});
</script>

<style scoped>
.auth-page {
  min-height: calc(100vh - 150px);
  display: grid;
  place-items: center;
  padding: 32px 16px;
  background: linear-gradient(135deg, #fff7f6, #f7f8fa);
}

.auth-card {
  width: min(100%, 480px);
  border-radius: 14px;
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.card-header h1 {
  margin: 0;
  font-size: 22px;
}

.card-header p {
  margin: 8px 0 0;
  color: #888;
  font-size: 14px;
}

.card-header a {
  flex-shrink: 0;
  color: #e64340;
  font-size: 14px;
  text-decoration: none;
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

@media (max-width: 520px) {
  .code-row {
    align-items: stretch;
    flex-direction: column;
  }

  .code-row .el-button {
    width: 100%;
  }
}
</style>
