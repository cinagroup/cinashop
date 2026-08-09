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
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiRegister } from "@/api/auth";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const form = reactive({ account: "", password: "", confirm: "" });

async function doRegister() {
  if (!/^1\d{10}$/.test(form.account)) return ElMessage.warning("请输入正确的手机号");
  if (form.password.length < 6) return ElMessage.warning("密码至少 6 位");
  if (form.password !== form.confirm) return ElMessage.warning("两次密码不一致");
  loading.value = true;
  try {
    const result = await apiRegister(form.account, form.password, form.confirm);
    authStore.token = result.token;
    localStorage.setItem("pc_token", result.token);
    ElMessage.success("注册成功");
    router.push("/");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "注册失败");
  } finally {
    loading.value = false;
  }
}
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
