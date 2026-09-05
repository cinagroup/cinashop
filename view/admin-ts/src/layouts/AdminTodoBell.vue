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
      <p v-if="state.error" role="status">待办加载失败，请刷新重试。</p>
      <p v-else-if="!state.snapshot" role="status">正在加载待办…</p>
      <template v-else>
        <p class="todo-hint">当前权限范围 · 共 {{ state.snapshot.msgcount }} 项</p>
        <button v-for="item in visibleItems" :key="item.key" type="button" class="todo-item" @click="openItem(item.path, item.query)">
          <span>{{ item.label }}</span><strong>{{ state.snapshot[item.key] }}</strong>
        </button>
        <p v-if="!visibleItems.length" class="todo-hint">暂无可访问的业务待办</p>
        <p class="todo-hint">{{ sampledTime }} 更新 · 每 30 秒检查</p>
      </template>
    </section>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiNewPush } from "@/api/auth";
import { useAuthStore } from "@/stores/auth";
import { createAdminTodoLoader, type AdminTodoState } from "@/utils/admin-todos";

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const opened = ref(false);
const state = ref<AdminTodoState>({ snapshot: null, loading: false, error: false });
const loader = createAdminTodoLoader(apiNewPush, (next) => { state.value = next; });
const items = [
  { key: "ordernum", label: "待发货订单", permission: "order.view", path: "/order", query: {} },
  { key: "inventory", label: "库存预警", permission: "product.view", path: "/product", query: {} },
  { key: "commentnum", label: "待回复评价", permission: "reply.view", path: "/reply", query: {} },
  { key: "reflectnum", label: "待审核提现", permission: "extract.view", path: "/finance/extract", query: { status: "0" } },
] as const;
const visibleItems = computed(() => items.filter((item) => preview || auth.userInfo?.level === 0 || auth.uniqueAuth.includes(item.permission)));
const label = computed(() => state.value.error ? "管理待办，加载失败" : state.value.snapshot ? `管理待办，共 ${state.value.snapshot.msgcount} 项` : "管理待办，正在加载");
const sampledTime = computed(() => new Date((state.value.snapshot?.sampled_at ?? 0) * 1000).toLocaleTimeString("zh-CN", { hour12: false }));
function refresh() { return loader.refresh(); }
function refreshVisible() { if (!document.hidden) void refresh(); }
function openItem(path: string, query: Record<string, string>) {
  opened.value = false;
  void router.push({ path, query: { ...query, ...(preview ? { preview: "1" } : {}) } });
}
let timer: ReturnType<typeof setInterval> | undefined;
watch(() => route.fullPath, refreshVisible);
onMounted(() => {
  refreshVisible();
  timer = setInterval(refreshVisible, 30_000);
  window.addEventListener("focus", refreshVisible);
  window.addEventListener("cinashop:admin-todos-changed", refreshVisible);
  document.addEventListener("visibilitychange", refreshVisible);
});
onUnmounted(() => {
  loader.dispose();
  clearInterval(timer);
  window.removeEventListener("focus", refreshVisible);
  window.removeEventListener("cinashop:admin-todos-changed", refreshVisible);
  document.removeEventListener("visibilitychange", refreshVisible);
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
