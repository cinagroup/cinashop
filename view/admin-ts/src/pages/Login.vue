<template>
  <div class="login-page">
    <div class="login-shell" :class="{ 'no-slides': !slides.length }">
      <section v-if="slides.length" class="login-visual" aria-label="品牌轮播图">
        <el-carousel height="100%" :interval="5000" arrow="never">
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
          <p class="hint">请使用管理员账号登录</p>
        </div>
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
/* Adapt the original PHP account layout to the current Vue 3 form. */
.login-page {
  min-height:100vh;
  min-height:100dvh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:40px 24px;
  background:#0c164f url('/php-assets/admin/login-bg.jpg') center/cover no-repeat;
}
.login-shell {
  display:flex;
  width:930px;
  max-width:100%;
  min-height:420px;
  overflow:hidden;
  background:#fff;
  border:1px solid rgba(255,255,255,.32);
  border-radius:8px;
  box-shadow:0 24px 72px rgba(5,12,58,.22);
}
.login-shell.no-slides {
  max-width:400px;
}
.login-visual {
  position:relative;
  flex:0 0 510px;
  width:55%;
  min-width:0;
  overflow:hidden;
}
.login-visual :deep(.el-carousel) {
  position: absolute;
  inset: 0;
}
.login-visual img {
  width:100%;
  height:100%;
  object-fit:cover;
}
.visual-shade {
  position:absolute;
  inset:0;
  z-index:2;
  display:flex;
  flex-direction:column;
  justify-content:flex-end;
  gap:12px;
  padding:36px;
  color:white;
  pointer-events:none;
  background:linear-gradient(180deg,rgba(8,23,52,.02),rgba(8,23,52,.74));
}
.visual-shade span {
  font-size:11px;
  font-weight:600;
  letter-spacing:2px;
}
.visual-shade strong {
  font-size:30px;
  line-height:1.35;
  overflow-wrap:anywhere;
}
.login-panel {
  flex:1;
  display:flex;
  align-items:center;
  justify-content:center;
  min-width:0;
  padding:32px 38px;
  background:#fff;
}
.login-box {
  width:320px;
  max-width:100%;
}
.login-logo {
  display:block;
  width:auto;
  max-width:180px;
  height:75px;
  object-fit:contain;
  margin:0 auto 18px;
}
.title {
  margin:0 0 30px;
  color:#17233d;
  font-size:21px;
  font-weight:600;
  text-align:center;
  overflow-wrap:anywhere;
}
.login-box :deep(.el-form-item) {
  margin-bottom:20px;
}
.login-box :deep(.el-input__wrapper) {
  min-height:44px;
  padding:1px 12px;
  border-radius:4px;
  box-shadow:0 0 0 1px #dcdee2 inset;
}
.login-box :deep(.el-input__wrapper.is-focus) {
  box-shadow:0 0 0 1px #0e73e8 inset,0 0 0 3px rgba(25,180,241,.12);
}
.login-box :deep(.el-input__prefix) {
  margin-right:4px;
  color:#808695;
}
.submit-btn {
  width:100%;
  min-height:44px;
  border:0;
  border-radius:4px;
  color:#fff;
  background:linear-gradient(90deg,#0874bc,#0e73e8);
  font-weight:600;
}
.submit-btn:hover {
  filter:brightness(1.05);
}
.submit-btn:focus-visible {
  outline:3px solid #19b4f1;
  outline-offset:3px;
}
.hint {
  margin-top:22px;
  color:#808695;
  font-size:12px;
  line-height:1.6;
  text-align:center;
}
@media (max-width:980px) {
  .login-visual {
    flex-basis:50%;
    width:50%;
  }
  .login-panel {
    padding:32px;
  }
  .visual-shade {
    padding:28px;
  }
}
@media (max-width:720px) {
  .login-page {
    padding:24px 16px;
    background:#f5f7f9;
  }
  .login-shell {
    width:400px;
    min-height:0;
    border-color:#e8eaec;
    box-shadow:0 12px 40px rgba(23,35,61,.06);
  }
  .login-visual {
    display:none;
  }
  .login-panel {
    padding:36px 28px;
  }
  .title {
    font-size:20px;
  }
}
</style>
