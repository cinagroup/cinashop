<template>
  <div class="login-page">
    <div class="login-box">
      <img src="/logo.png" alt="CinaShop" class="login-logo" />
      <h1 class="title">CinaShop 管理后台</h1>
      <el-form :model="form" @keyup.enter="handleLogin">
        <el-form-item>
          <el-input v-model="form.account" placeholder="账号" size="large">
            <template #prefix><el-icon><User /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.pwd"
            type="password"
            placeholder="密码"
            size="large"
            show-password
          >
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
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
      </el-form>
      <p class="hint">管理员账号由部署负责人安全初始化</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const form = reactive({ account: "", pwd: "" });

async function handleLogin() {
  if (!form.account || !form.pwd) return ElMessage.error("请输入账号和密码");
  loading.value = true;
  try {
    await authStore.login(form.account, form.pwd);
    ElMessage.success("登录成功");
    router.push("/dashboard");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "登录失败");
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1e3c72, #2a5298);
}

.login-box {
  width: 380px;
  background: #fff;
  border-radius: 12px;
  padding: 40px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
}

.title {
  text-align: center;
  font-size: 22px;
  margin-bottom: 32px;
  color: #333;
}

.login-logo {
  display: block;
  width: 120px;
  height: 120px;
  object-fit: contain;
  margin: 0 auto 16px;
}

.submit-btn {
  width: 100%;
}

.hint {
  text-align: center;
  color: #999;
  font-size: 13px;
  margin-top: 16px;
}
</style>
