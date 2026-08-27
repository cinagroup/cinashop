<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import UiIcon from "@/components/UiIcon.vue";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const account = ref("");
const password = ref("");
const loading = ref(false);
const error = ref("");

async function submit() {
  if (!account.value.trim() || !password.value) {
    error.value = "请输入客服账号和密码";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    await auth.login(account.value, password.value);
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/workbench";
    await router.replace(redirect);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "登录失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-brand" aria-label="CinaShop 客服工作台">
      <div class="brand-mark">C</div>
      <div>
        <p class="eyebrow">CINASHOP SERVICE</p>
        <h1>让每一次响应<br />都有清晰上下文</h1>
        <p class="brand-copy">独立客服安全域，连接实时会话、客户资料与标准话术。</p>
      </div>
      <div class="brand-signal"><span></span>实时服务通道</div>
    </section>

    <section class="login-panel">
      <form class="login-card" @submit.prevent="submit">
        <div class="mobile-brand"><span class="brand-mark small">C</span>CinaShop</div>
        <p class="eyebrow accent">客服工作台</p>
        <h2>欢迎回来</h2>
        <p class="login-intro">使用已启用并绑定用户身份的客服账号登录。</p>
        <label>
          <span>客服账号</span>
          <input v-model="account" name="account" autocomplete="username" placeholder="请输入账号" />
        </label>
        <label>
          <span>密码</span>
          <input v-model="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
        </label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary-button login-submit" type="submit" :disabled="loading">
          <UiIcon name="message" />{{ loading ? "正在登录…" : "进入工作台" }}
        </button>
        <p class="login-note">二维码及微信授权登录将在一次性挑战校验完成后开放。</p>
      </form>
    </section>
  </main>
</template>
