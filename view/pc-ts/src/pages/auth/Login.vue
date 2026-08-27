<template>
  <div class="login-page">
    <div class="login-box">
      <h1 class="title">CinaShop 登录</h1>
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
            <el-button
              type="primary"
              size="large"
              class="submit-btn"
              :loading="loading"
              @click="handleLogin"
            >
              登录
            </el-button>
            <div class="password-help">
              <router-link to="/forgot-password">忘记密码?</router-link>
            </div>
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
            <el-button
              type="primary"
              size="large"
              class="submit-btn"
              :loading="loading"
              @click="handleMobileLogin"
            >
              登录/注册
            </el-button>
          </el-form>
        </el-tab-pane>
      </el-tabs>
      <div class="to-register">
        没有账号? <router-link to="/register">立即注册</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { apiRequestCode } from "@/api/auth";
import { requestSmsChallenge } from "@/composables/smsChallenge";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const tab = ref("account");
const loading = ref(false);
const countdown = ref(0);
const codeSending = ref(false);
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const form = reactive({
  account: "",
  password: "",
  phone: "",
  captcha: "",
});

function redirectAfterLogin() {
  const redirect = (route.query.redirect as string) || "/";
  router.push(redirect);
}

async function handleLogin() {
  if (!form.account) return ElMessage.error("请输入手机号");
  if (!form.password) return ElMessage.error("请输入密码");
  loading.value = true;
  try {
    await authStore.login(form.account, form.password);
    ElMessage.success("登录成功");
    redirectAfterLogin();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "登录失败");
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
    redirectAfterLogin();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "登录失败");
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
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "验证码发送失败");
  } finally {
    codeSending.value = false;
  }
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});
</script>

<style scoped>
.login-page {
  min-height: calc(100vh - 150px);
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f6f6f6 0%, #fff 100%);
}

.login-box {
  width: 400px;
  background: #fff;
  border-radius: 12px;
  padding: 40px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08);
}

.title {
  text-align: center;
  font-size: 22px;
  margin-bottom: 24px;
}

.submit-btn {
  width: 100%;
  margin-top: 8px;
}

.code-row {
  display: flex;
  gap: 10px;
  width: 100%;
}

.to-register {
  text-align: center;
  margin-top: 16px;
  font-size: 14px;
  color: #666;
}

.to-register a {
  color: #e64340;
  text-decoration: none;
}

.password-help {
  margin-top: 12px;
  text-align: right;
  font-size: 14px;
}

.password-help a {
  color: #777;
  text-decoration: none;
}
</style>
