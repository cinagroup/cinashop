<template>
  <main class="exception-page">
    <section class="exception-card" aria-labelledby="exception-title">
      <p class="exception-code">{{ copy.code }}</p>
      <div class="exception-content">
        <p class="eyebrow">CinaShop 管理后台</p>
        <h1 id="exception-title">{{ copy.title }}</h1>
        <p class="description">{{ copy.description }}</p>
        <p v-if="navigationError" role="alert" class="navigation-error">{{ navigationError }}</p>
        <button v-for="control in controls" :key="control.key" type="button" :disabled="leaving" @click="control.back">返回首页</button>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { isNavigationFailure, NavigationFailureType, useRoute, useRouter } from 'vue-router';
import { ADMIN_EXCEPTION_COPY, adminExceptionHome, type AdminExceptionKind } from '@/utils/adminException';

const route = useRoute(), router = useRouter();
const copy = computed(() => {
  const kind = route.meta.exceptionKind;
  return typeof kind === 'string' && Object.hasOwn(ADMIN_EXCEPTION_COPY, kind) ? ADMIN_EXCEPTION_COPY[kind as AdminExceptionKind] : ADMIN_EXCEPTION_COPY['404'];
});
const leaving = ref(false), navigationError = ref('');
let alive = true;
const generation = ref(0);
watch(() => route.fullPath, () => { generation.value++; leaving.value = false; navigationError.value = ''; }, { flush: 'sync' });
onBeforeUnmount(() => { alive = false; generation.value++; });
const controls = computed(() => { const stamp = generation.value; return [{ key: stamp, back: () => returnHome(stamp) }]; });
async function returnHome(stamp: number) {
  const current = () => alive && stamp === generation.value;
  if (!current() || leaving.value) return;
  leaving.value = true; navigationError.value = '';
  try {
    let token: string | null = null, session: unknown = null;
    try { token = localStorage.getItem('admin_token'); session = JSON.parse(localStorage.getItem('admin_session') ?? 'null'); } catch { /* Use the fixed login/dashboard fallback. */ }
    const result = await router.push(adminExceptionHome(token, session, router.getRoutes()));
    if (current() && isNavigationFailure(result, NavigationFailureType.aborted)) navigationError.value = '页面跳转失败，请稍后重试。';
  } catch { if (current()) navigationError.value = '页面跳转失败，请稍后重试。'; }
  finally { if (current()) leaving.value = false; }
}
</script>

<style scoped>
.exception-page{min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px;background:#f0f2f5;color:#303133}.exception-card{display:flex;align-items:center;gap:56px;width:min(760px,100%);padding:48px;border:1px solid #e4e7ed;border-radius:8px;background:#fff}.exception-code{flex:0 0 auto;font-size:112px;line-height:1;font-weight:700;letter-spacing:-6px;color:#cdd9e5}.exception-content{min-width:0}.eyebrow{font-size:12px;color:#909399;letter-spacing:1px}h1{margin:14px 0;font-size:28px;line-height:1.4}.description{font-size:15px;line-height:1.8;color:#606266;overflow-wrap:anywhere}button{margin-top:28px;padding:11px 22px;border:1px solid #409eff;border-radius:4px;background:#409eff;color:#fff;font:inherit;font-size:14px;cursor:pointer}button:hover{background:#337ecc;border-color:#337ecc}button:focus-visible{outline:3px solid #79bbff;outline-offset:4px}button:disabled{cursor:wait;opacity:.65}.navigation-error{margin-top:16px;color:#b42318;font-size:14px;line-height:1.6}@media(max-width:600px){.exception-page{padding:20px}.exception-card{flex-direction:column;gap:28px;padding:36px 24px;text-align:center}.exception-code{font-size:88px;letter-spacing:-4px}h1{font-size:24px}.description{font-size:14px}}
</style>
