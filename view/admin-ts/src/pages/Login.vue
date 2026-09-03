<template>
  <div class="login-page">
    <section v-if="slides.length" class="login-visual" aria-label="品牌轮播图">
      <el-carousel height="100vh" :interval="5000" arrow="never">
        <el-carousel-item v-for="(slide, index) in slides" :key="`${slide}-${index}`">
          <img :src="slide" alt="" />
        </el-carousel-item>
      </el-carousel>
      <div class="visual-shade">
        <span>SECURE COMMERCE OPERATIONS</span>
        <strong>{{ siteName }} 管理中心</strong>
      </div>
    </section>
    <div class="login-panel">
      <div class="login-box">
        <img :src="loginLogo" :alt="siteName" class="login-logo" />
        <h1 class="title">{{ siteName }} 管理后台</h1>
        <el-form :model="form" @keyup.enter="handleLogin">
          <el-form-item>
            <el-input v-model="form.account" placeholder="账号" size="large" maxlength="64">
              <template #prefix><el-icon><User /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-form-item>
            <el-input
              v-model="form.pwd"
              type="password"
              placeholder="密码"
              size="large"
              maxlength="256"
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
        <p class="hint">管理员账号由部署负责人安全初始化 · 登录尝试受限流保护</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, reactive } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { apiPublicBranding, applyFavicon } from "@/api/publicBranding";

const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const form = reactive({ account: "", pwd: "" });
const slides = ref<string[]>([]);
const siteName = ref("CinaShop");
const loginLogo = ref("/logo.png");

onMounted(async () => {
  try {
    const branding = await apiPublicBranding();
    slides.value = branding.admin_login_slide.slice(0, 5);
    siteName.value = branding.site_name || "CinaShop";
    loginLogo.value = branding.login_logo || branding.site_logo_square || "/logo.png";
    applyFavicon(branding.ico_path);
  } catch {
    // 品牌素材失败不能阻断管理员登录。
  }
});

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
  min-height: 100vh;
  display: flex;
  background: linear-gradient(135deg, #0b2c29, #17695f);
}

.login-visual {
  position: relative;
  width: 56%;
  min-height: 100vh;
  overflow: hidden;
}

.login-visual img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.visual-shade {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  justify-content: flex-end;
  flex-direction: column;
  gap: 12px;
  padding: 64px;
  color: white;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(8, 34, 31, 0.08), rgba(8, 34, 31, 0.76));
}

.visual-shade span { font-size: 12px; font-weight: 700; letter-spacing: 3px; }
.visual-shade strong { font-size: clamp(28px, 3vw, 46px); }

.login-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 440px;
  padding: 36px;
  background: #f7faf9;
}

.login-box {
  width: 380px;
  max-width: 100%;
  background: #fff;
  border: 1px solid #e5ece9;
  border-radius: 18px;
  padding: 44px;
  box-shadow: 0 20px 60px rgba(16, 61, 55, 0.12);
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

@media (max-width: 900px) {
  .login-visual { width: 42%; }
  .login-panel { min-width: 420px; }
  .visual-shade { padding: 36px; }
}

@media (max-width: 720px) {
  .login-visual { display: none; }
  .login-panel { min-width: 0; padding: 20px; }
  .login-box { padding: 32px 24px; }
}
</style>
