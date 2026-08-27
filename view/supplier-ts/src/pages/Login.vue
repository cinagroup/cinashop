<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Goods, Lock, User } from "@element-plus/icons-vue";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const formRef = ref<FormInstance>();
const loading = ref(false);
const form = reactive({ account: "", password: "" });
const rules: FormRules = {
  account: [{ required: true, message: "请输入供应商账号", trigger: "blur" }],
  password: [{ required: true, message: "请输入密码", trigger: "blur" }],
};

async function submit() {
  await formRef.value?.validate();
  loading.value = true;
  try {
    await auth.signIn(form.account, form.password);
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/dashboard";
    await router.replace(redirect);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "登录失败");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-intro">
      <div class="login-mark"><el-icon><Goods /></el-icon></div>
      <h1>CinaShop 供应商中心</h1>
      <p>管理供应商商品、订单与经营数据。</p>
      <div class="login-lines" aria-hidden="true"><span /><span /><span /></div>
    </section>
    <section class="login-panel">
      <div class="login-form-wrap">
        <h2>登录供应商后台</h2>
        <p>使用平台分配的供应商账号登录</p>
        <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
          <el-form-item label="账号" prop="account">
            <el-input v-model="form.account" size="large" autocomplete="username" placeholder="供应商账号">
              <template #prefix><el-icon><User /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              size="large"
              type="password"
              show-password
              autocomplete="current-password"
              placeholder="登录密码"
              @keyup.enter="submit"
            >
              <template #prefix><el-icon><Lock /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-button class="login-submit" type="primary" size="large" :loading="loading" @click="submit">
            登录
          </el-button>
        </el-form>
        <div class="login-security">账号权限由平台管理员配置，请勿与他人共享。</div>
      </div>
    </section>
  </main>
</template>
