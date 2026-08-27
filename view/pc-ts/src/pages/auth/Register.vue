<template>
  <div class="register-page">
    <div class="register-box">
      <div class="logo">
        <img src="/logo.png" alt="CinaShop" class="logo-img" />
      </div>
      <h1 class="title">注册新账号</h1>

      <el-form :model="form" label-width="0" @submit.prevent>
        <el-form-item>
          <el-input v-model="form.account" placeholder="请输入手机号" :maxlength="11" />
        </el-form-item>
        <el-form-item>
          <div class="code-row">
            <el-input v-model="form.captcha" placeholder="请输入 6 位验证码" :maxlength="6" />
            <el-button :loading="codeSending" :disabled="countdown > 0" @click="sendCode">
              {{ countdown > 0 ? `${countdown}s 后重试` : "获取验证码" }}
            </el-button>
          </div>
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="请输入密码 (至少6位)" show-password />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.confirm" type="password" placeholder="确认密码" show-password />
        </el-form-item>
        <el-button type="danger" size="large" style="width: 100%" :loading="loading" @click="doRegister">
          注册
        </el-button>
      </el-form>

      <div class="to-login">
        已有账号? <router-link to="/login">立即登录</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiRegister, apiRequestCode } from "@/api/auth";
import { requestSmsChallenge } from "@/composables/smsChallenge";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const codeSending = ref(false);
const countdown = ref(0);
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const form = reactive({ account: "", captcha: "", password: "", confirm: "" });

async function sendCode() {
  if (!/^1\d{10}$/.test(form.account)) return ElMessage.warning("请输入正确的手机号");
  codeSending.value = true;
  try {
    const key = await requestSmsChallenge(form.account, "register");
    await apiRequestCode(form.account, "register", key);
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
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "验证码发送失败");
  } finally {
    codeSending.value = false;
  }
}

async function doRegister() {
  if (!/^1\d{10}$/.test(form.account)) return ElMessage.warning("请输入正确的手机号");
  if (!/^\d{6}$/.test(form.captcha)) return ElMessage.warning("请输入 6 位验证码");
  if (form.password.length < 6) return ElMessage.warning("密码至少 6 位");
  if (form.password !== form.confirm) return ElMessage.warning("两次密码不一致");
  loading.value = true;
  try {
    const result = await apiRegister(form.account, form.captcha, form.password, form.confirm);
    authStore.applyLogin(result);
    ElMessage.success("注册成功");
    router.push("/");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "注册失败");
  } finally {
    loading.value = false;
  }
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});
</script>

<style scoped>
.register-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
}

.register-box {
  width: 420px;
  background: #fff;
  border-radius: 12px;
  padding: 40px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.logo {
  text-align: center;
  margin-bottom: 16px;
}

.logo-img {
  width: 120px;
  height: 50px;
}

.code-row {
  display: flex;
  gap: 10px;
  width: 100%;
}

.title {
  text-align: center;
  font-size: 20px;
  margin-bottom: 24px;
  color: #333;
}

.to-login {
  text-align: center;
  margin-top: 20px;
  font-size: 14px;
  color: #666;
}

.to-login a {
  color: #e64340;
  text-decoration: none;
}
</style>
