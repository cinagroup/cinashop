<template>
  <el-popover v-model:visible="opened" trigger="click" placement="bottom-end" :width="280" @show="refresh">
    <template #reference>
      <button class="todo-trigger" type="button" :aria-label="label" :aria-expanded="opened">
        <el-badge :value="state.snapshot?.msgcount ?? '!'" :hidden="!state.error && !state.snapshot?.msgcount">
          <el-icon :size="20"><Bell /></el-icon>
        </el-badge>
      </button>
    </template>
    <section aria-label="管理待办">
      <div class="todo-header"><strong>管理待办</strong><el-button text size="small" :loading="state.loading" @click="refresh">刷新待办</el-button></div>
      <p v-if="noticeState === 'denied'" role="status">通知权限或登录状态已失效，请重新验证权限。</p>
      <p v-else-if="state.error" role="status">待办加载失败，请刷新重试。</p>
      <p v-else-if="!state.snapshot" role="status">正在加载待办…</p>
      <template v-else>
        <p class="todo-hint">当前权限范围 · 共 {{ state.snapshot.msgcount }} 项</p>
        <button v-for="item in visibleItems" :key="item.key" type="button" class="todo-item" @click="openItem(item.path, item.query)">
          <span>{{ item.label }}</span><strong>{{ state.snapshot[item.key] }}</strong>
        </button>
        <p v-if="!visibleItems.length" class="todo-hint">暂无可访问的业务待办</p>
        <p class="todo-hint">{{ sampledTime }} 更新 · 每 30 秒检查兜底</p>
      </template>
      <p v-if="noticeState !== 'denied'" class="todo-hint" role="status">{{ preview ? '预览数据 · 未连接通知' : noticeStateText[noticeState] }}</p>
      <el-button v-if="!preview && ['retrying', 'denied'].includes(noticeState)" text size="small" @click="retryNotice">重连通知</el-button>
    </section>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiNewPush } from "@/api/auth";
import { useAuthStore } from "@/stores/auth";
import { createAdminTodoLoader, type AdminTodoState } from "@/utils/admin-todos";
import { getToken, getAdminSession } from "@/utils/auth";
import { StaffNoticeClient, bindNoticeLifecycle, noticeStateText, type NoticeState } from "../../../common/staff-notifications";

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const opened = ref(false);
const state = ref<AdminTodoState>({ snapshot: null, loading: false, error: false });
const loader = createAdminTodoLoader(apiNewPush, (next) => { state.value = next; });
const noticeState = ref<NoticeState>("idle");
const notice = new StaffNoticeClient({
  url: () => { const url = new URL('/adminapi/extract/notifications/socket', location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; return url.toString(); },
  onState: (next) => { noticeState.value = next; },
  onRefresh: () => { if (!document.hidden) void loader.refresh(true); },
  onDenied: () => { loader.invalidate(); opened.value = false; },
});
let releaseNotice: (() => void) | undefined;
const canNotify = computed(() => auth.userInfo?.level === 0 || auth.uniqueAuth.includes('extract.view') || auth.uniqueAuth.includes('extract.manage'));
const items = [
  { key: "ordernum", label: "待发货订单", permission: "order.view", path: "/order", query: {} },
  { key: "inventory", label: "库存预警", permission: "product.view", path: "/product", query: {} },
  { key: "commentnum", label: "待回复评价", permission: "reply.view", path: "/reply", query: {} },
  { key: "reflectnum", label: "待审核提现", permission: "extract.view", path: "/finance/extract", query: { status: "0" } },
] as const;
const visibleItems = computed(() => items.filter((item) => preview || auth.userInfo?.level === 0 || auth.uniqueAuth.includes(item.permission)));
const label = computed(() => noticeState.value === 'denied' ? '管理待办，通知权限或登录状态已失效' : state.value.error ? "管理待办，加载失败" : state.value.snapshot ? `管理待办，共 ${state.value.snapshot.msgcount} 项` : "管理待办，正在加载");
const sampledTime = computed(() => new Date((state.value.snapshot?.sampled_at ?? 0) * 1000).toLocaleTimeString("zh-CN", { hour12: false }));
function refresh() { if (preview || auth.token) return loader.refresh(); return Promise.resolve(); }
function refreshVisible() { if (!document.hidden && noticeState.value !== 'denied') void refresh(); }
function retryNotice() { notice.retry(); void loader.refresh(true); }
function syncStoredSession() {
  const token = getToken() ?? '', session = getAdminSession();
  auth.$patch({ token, userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
function expire() { auth.logout(); loader.invalidate(); notice.setSession(''); void router.replace('/login'); }
function openItem(path: string, query: Record<string, string>) {
  opened.value = false;
  void router.push({ path, query: { ...query, ...(preview ? { preview: "1" } : {}) } });
}
let timer: ReturnType<typeof setInterval> | undefined;
watch(() => route.fullPath, refreshVisible);
watch(() => [auth.token, auth.userInfo?.id, canNotify.value, auth.uniqueAuth.join(',')], () => {
  loader.invalidate(); opened.value = false;
  notice.setSession(!preview && canNotify.value ? auth.token : '');
  refreshVisible();
}, { flush: 'pre' }); // Observe the complete Pinia session patch, not intermediate identity/role fields.
onMounted(() => {
  releaseNotice = bindNoticeLifecycle(notice, window, document, () => navigator.onLine);
  notice.setSession(!preview && canNotify.value ? auth.token : '');
  refreshVisible();
  timer = setInterval(refreshVisible, 30_000);
  window.addEventListener("focus", refreshVisible);
  window.addEventListener("cinashop:admin-todos-changed", refreshVisible);
  document.addEventListener("visibilitychange", refreshVisible);
  window.addEventListener('storage', syncStoredSession);
  window.addEventListener('admin-auth-expired', expire);
});
onUnmounted(() => {
  loader.dispose();
  releaseNotice?.();
  clearInterval(timer);
  window.removeEventListener("focus", refreshVisible);
  window.removeEventListener("cinashop:admin-todos-changed", refreshVisible);
  document.removeEventListener("visibilitychange", refreshVisible);
  window.removeEventListener('storage', syncStoredSession);
  window.removeEventListener('admin-auth-expired', expire);
});
</script>

<style scoped>
.todo-trigger { display: flex; align-items: center; border: 0; background: none; cursor: pointer; padding: 8px; color: inherit; }
.todo-trigger:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.todo-header, .todo-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.todo-item { width: 100%; border: 0; border-top: 1px solid #eef0f3; background: #fff; padding: 12px 0; text-align: left; cursor: pointer; color: #303133; }
.todo-item:hover, .todo-item:focus-visible { color: #409eff; }
.todo-hint { color: #73767a; font-size: 12px; }
</style>
