<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { apiRequest, queryString } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useNoticeStore } from "@/stores/notices";
import StaffNoticeStatus from "@/components/StaffNoticeStatus.vue";
import { createInboxGuard, parseInboxMessage, parseInboxPage, type InboxMessage } from "@/services/inbox";

const router = useRouter(), auth = useAuthStore(), guard = createInboxGuard();
const listGuard = createInboxGuard(), notices = useNoticeStore();
const preview = import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "1";
const rows = ref<InboxMessage[]>([]), selected = ref<InboxMessage | null>(null);
const unread = ref<number | null>(null), cursor = ref<number | null>(null), unreadOnly = ref(false);
const actionLoading = ref(false), listLoading = ref(false), error = ref(""), updated = ref("");
const loading = computed(() => actionLoading.value || listLoading.value);
let generation = 0, refreshPending = false, disposed = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
// Component-scoped preview state. Never shared across sessions or sent to a backend.
const samples: InboxMessage[] = [
  { id: 102, title: "客服专属：提现申请", content: "预览用户申请提现20.00元。此消息仅为申请提醒，不代表审核或到账。", mark: "kefu_send_extract_application", look: 0, add_time: 1788588000 },
  { id: 101, title: "已读申请提醒", content: "历史预览用户申请提现10.00元。", mark: "kefu_send_extract_application", look: 1, add_time: 1788584400 },
];

function clear() { rows.value = []; selected.value = null; unread.value = null; cursor.value = null; updated.value = ""; }
function reset() { generation++; guard.invalidate(); listGuard.invalidate(); refreshPending = false; actionLoading.value = listLoading.value = false; clear(); }
function fail() { clear(); actionLoading.value = listLoading.value = false; error.value = "提醒加载失败或通知权限已关闭，请重试或联系管理员。"; }
function drain(current: number) {
  if (!disposed && generation === current && refreshPending && !loading.value) { refreshPending = false; void load(false, true); }
}
function time(value: number) { return new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }); }
async function load(more = false, preserveDetail = false) {
  if (disposed || (!preview && (!auth.token || notices.state === 'denied'))) return;
  if (loading.value) { if (!more) refreshPending = true; return; }
  const current = generation;
  listLoading.value = true; error.value = ""; if (!preserveDetail) selected.value = null;
  const after = more ? cursor.value : null;
  await listGuard.run(async () => {
    const data: unknown = preview
      ? { list: samples.filter((row) => (!unreadOnly.value || row.look === 0) && (!after || row.id < after)).map((row) => ({ ...row })), unread_count: samples.filter((row) => row.look === 0).length, next_cursor: null }
      : await apiRequest<unknown>(`/kefuapi/messages${queryString({ cursor: after ?? undefined, unread: unreadOnly.value ? 1 : 0, limit: 20 })}`);
    return parseInboxPage(data);
  }, (page) => {
    rows.value = more ? [...rows.value, ...page.list.filter((row) => !rows.value.some((old) => old.id === row.id))] : page.list;
    unread.value = page.unread_count; cursor.value = page.next_cursor; listLoading.value = false;
    updated.value = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }, fail);
  drain(current);
}
async function open(row: InboxMessage) {
  if (loading.value) return;
  const current = generation;
  selected.value = null; actionLoading.value = true; error.value = "";
  await guard.run(async () => parseInboxMessage(preview ? { ...samples.find((item) => item.id === row.id) }
    : await apiRequest<unknown>(`/kefuapi/messages/${row.id}`)), (message) => { selected.value = message; actionLoading.value = false; }, fail);
  drain(current);
}
async function markRead() {
  const id = selected.value?.id;
  if (!id || loading.value) return;
  const current = generation;
  actionLoading.value = true;
  await guard.run(async () => {
    if (preview) { const row = samples.find((item) => item.id === id); if (row) row.look = 1; }
    else await apiRequest<unknown>(`/kefuapi/messages/${id}/read`, { method: "POST" });
  }, () => { actionLoading.value = false; void load(); notices.refresh(); }, fail);
  drain(current);
}
function refreshVisible() { if (!document.hidden) void load(false, true); }
function expire() { reset(); void router.replace("/login"); }
watch(unreadOnly, () => { void load(); });
watch(() => auth.token, () => { reset(); if (!preview && auth.token) void load(); }, { flush: 'sync' });
watch(() => notices.version, () => {
  if (notices.state === 'denied') { reset(); fail(); } else refreshVisible();
}, { immediate: true });
onMounted(() => {
  document.title = "系统提醒 - CinaShop 客服";
  window.addEventListener("kefu-auth-expired", expire);
  window.addEventListener("focus", refreshVisible);
  document.addEventListener("visibilitychange", refreshVisible);
  refreshTimer = setInterval(refreshVisible, 30000); void load();
});
onBeforeUnmount(() => {
  disposed = true; generation++; guard.dispose(); listGuard.dispose(); clearInterval(refreshTimer);
  window.removeEventListener("kefu-auth-expired", expire); window.removeEventListener("focus", refreshVisible);
  document.removeEventListener("visibilitychange", refreshVisible);
});
</script>

<template>
  <main class="inbox-page">
    <header class="inbox-heading">
      <div><p>客服工作台 / 系统提醒</p><h1>系统提醒 <span v-if="unread !== null">{{ unread }} 条未读</span></h1></div>
      <RouterLink :to="preview ? '/workbench?preview=1' : '/workbench'">返回会话</RouterLink>
    </header>
    <p v-if="preview" class="inbox-banner">本地模拟收件箱，不连接生产、不发送通知、不执行提现审核或付款。</p>
    <StaffNoticeStatus />
    <div class="inbox-toolbar">
      <label><input v-model="unreadOnly" type="checkbox" :disabled="loading"> 仅看未读</label>
      <button :disabled="loading" @click="load()">刷新提醒</button>
      <span v-if="updated">{{ updated }} 更新 · 可见列表每 30 秒检查</span>
    </div>
    <p v-if="error" role="alert" class="inbox-error">{{ error }}</p>
    <p v-if="loading" role="status">正在加载提醒…</p>
    <section class="inbox-content" aria-label="客服系统提醒">
      <div class="inbox-list">
        <p v-if="!rows.length && !loading && !error" class="inbox-empty">{{ unreadOnly ? '暂无未读提醒' : '暂无系统提醒' }}</p>
        <button v-for="row in rows" :key="row.id" class="inbox-row" :class="{ unread: row.look === 0 }" :disabled="loading" @click="open(row)">
          <strong>{{ row.title || '系统提醒' }}</strong><span>{{ row.look === 0 ? '未读' : '已读' }}</span>
          <time>{{ time(row.add_time) }}</time>
        </button>
        <button v-if="cursor" :disabled="loading" @click="load(true)">加载更早提醒</button>
      </div>
      <article v-if="selected" class="inbox-detail" aria-label="提醒详情">
        <header><h2>{{ selected.title || '系统提醒' }}</h2><button @click="selected = null">关闭详情</button></header>
        <time>{{ time(selected.add_time) }}</time>
        <p class="inbox-text">{{ selected.content || '暂无正文' }}</p>
        <p class="inbox-note">此处只处理提醒的已读状态，不改变提现、审核或资金状态。</p>
        <button v-if="selected.look === 0" :disabled="loading" @click="markRead">标为已读</button><span v-else>已读</span>
      </article>
      <p v-else-if="!loading" class="inbox-hint">选择一条提醒查看详情，查看不会自动标为已读。</p>
    </section>
  </main>
</template>

<style scoped>
.inbox-page { height: 100dvh; overflow: auto; padding: 32px; color: #172b39; background: #f4f7f8; }
.inbox-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.inbox-heading p, time, .inbox-toolbar span { font-size: 13px; color: #5b6e78; }
h1 { font-size: 26px; margin: 8px 0 24px; } h1 span { font-size: 14px; margin-left: 12px; color: #267a70; }
.inbox-heading a { color: #207367; flex-shrink: 0; }
.inbox-banner, .inbox-note { background: #e6f2ef; padding: 12px 16px; border-radius: 8px; font-size: 13px; line-height: 1.6; }
.inbox-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; margin: 20px 0; }
.inbox-toolbar label { display: flex; align-items: center; gap: 8px; }
button { padding: 9px 14px; border: 1px solid #c6d7d4; border-radius: 8px; background: white; color: #215f56; cursor: pointer; }
button:disabled { cursor: wait; opacity: .6; } button:focus-visible, a:focus-visible { outline: 3px solid #3c988c; outline-offset: 3px; }
.inbox-content { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(0, 1.6fr); gap: 24px; align-items: start; }
.inbox-list { display: grid; gap: 12px; min-width: 0; }
.inbox-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; text-align: left; padding: 20px; color: #344751; }
.inbox-row strong { overflow-wrap: anywhere; font-weight: 500; }.inbox-row time { grid-column: 1 / -1; }
.inbox-row.unread { border-left: 4px solid #278977; }.inbox-row.unread strong { font-weight: 700; }
.inbox-row span { font-size: 12px; }.inbox-detail { background: white; border: 1px solid #dce6e4; padding: 24px; border-radius: 12px; min-width: 0; }
.inbox-detail header { display: flex; justify-content: space-between; align-items: start; gap: 16px; }.inbox-detail h2 { font-size: 20px; margin: 0 0 16px; overflow-wrap: anywhere; }.inbox-detail header button { flex-shrink: 0; }
.inbox-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin: 24px 0; }.inbox-note { margin-bottom: 20px; }
.inbox-hint, .inbox-empty { padding: 24px; color: #617680; }.inbox-error { color: #9d342c; background: #fff0ec; padding: 16px; border-radius: 8px; }
@media (max-width: 700px) { .inbox-page { padding: 20px 16px; }.inbox-content { grid-template-columns: 1fr; gap: 16px; }.inbox-detail { padding: 18px; } h1 { font-size: 23px; } h1 span { display: block; margin: 8px 0 0; }.inbox-heading { align-items: start; }.inbox-toolbar span { width: 100%; } }
</style>
