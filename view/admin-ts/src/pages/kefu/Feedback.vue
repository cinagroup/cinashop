<template>
  <div class="feedback-page">
    <div class="heading"><div><h2>用户留言</h2><p class="hint">匿名或原用户已删除的历史留言仍按原记录展示。</p></div>
      <el-button v-if="canView" :loading="loading" @click="load(page)">刷新</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有留言查看权限" type="warning" show-icon :closable="false" />
    <template v-else>
      <el-card shadow="never" class="section">
        <div class="filters">
          <label class="field"><span>留言信息</span><el-input v-model="draftTitle" clearable maxlength="100"
            placeholder="姓名、电话、内容或 UID" @keyup.enter="search" /></label>
          <label class="field"><span>处理状态</span><el-select v-model="draftStatus">
            <el-option label="全部" value="" /><el-option label="未处理" :value="0" /><el-option label="已处理" :value="1" />
          </el-select></label>
          <label class="field"><span>留言时间（上海时间）</span><el-select v-model="draftPreset" @change="choosePreset">
            <el-option label="全部" value="" /><el-option label="今天" value="today" />
            <el-option label="昨天" value="yesterday" /><el-option label="最近7天" value="lately7" />
            <el-option label="最近30天" value="lately30" /><el-option label="本月" value="month" />
            <el-option label="本年" value="year" />
          </el-select></label>
          <label class="field dates"><span>自定义日期</span><el-date-picker v-model="draftDates" type="daterange"
            value-format="YYYY/MM/DD" format="YYYY/MM/DD" range-separator="至"
            start-placeholder="开始日期" end-placeholder="结束日期" @change="chooseDates" /></label>
          <div class="actions"><el-button type="primary" @click="search">查询</el-button>
            <el-button @click="reset">重置</el-button></div>
        </div>
        <p class="hint">自定义区间沿用旧页边界：结束日的次日 00:00:00 也计入。</p>
        <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon />
      </el-card>
      <el-card shadow="never" class="section">
        <p class="hint">匹配 {{ count }} 条；每页 15 条，按留言 ID 降序。</p>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon>
          <el-button link type="primary" @click="load(page)">重试</el-button></el-alert>
        <div class="table-scroll"><el-table :data="list" v-loading="loading" border row-key="id"
          :empty-text="loading ? '读取中…' : '暂无留言'">
          <el-table-column prop="id" label="ID" width="80" />
          <el-table-column prop="rela_name" label="姓名" min-width="120" />
          <el-table-column prop="phone" label="电话" min-width="125" />
          <el-table-column label="内容" min-width="300"><template #default="{ row }">{{ feedbackText(row.content) }}</template></el-table-column>
          <el-table-column label="状态" width="95"><template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'warning'" size="small">{{ row.status === 1 ? '已处理' : '未处理' }}</el-tag>
          </template></el-table-column>
          <el-table-column label="留言时间" min-width="165"><template #default="{ row }">{{ feedbackTime(row.add_time) }}</template></el-table-column>
          <el-table-column label="操作" width="150"><template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">{{ canManage ? '处理/备注' : '查看' }}</el-button>
            <el-button v-if="canManage" link type="danger" @click="remove(row)">删除</el-button>
          </template></el-table-column>
        </el-table></div>
        <el-pagination class="pager" :current-page="page" :page-size="15" :total="count"
          layout="total, prev, pager, next" @current-change="load" />
      </el-card>
      <el-dialog v-model="detailVisible" title="留言详情" width="min(640px, calc(100vw - 24px))" @closed="closeDetail">
        <div v-loading="detailLoading">
          <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon>
            <el-button link type="primary" @click="reloadDetail">重试</el-button></el-alert>
          <template v-else-if="detail">
            <el-descriptions :column="1" border>
              <el-descriptions-item label="留言 ID">{{ detail.id }}</el-descriptions-item>
              <el-descriptions-item label="关联 UID">{{ detail.uid || '匿名/无关联' }}</el-descriptions-item>
              <el-descriptions-item label="姓名">{{ detail.rela_name }}</el-descriptions-item>
              <el-descriptions-item label="电话">{{ detail.phone }}</el-descriptions-item>
              <el-descriptions-item label="时间">{{ feedbackTime(detail.add_time) }}</el-descriptions-item>
              <el-descriptions-item label="内容"><span class="message-text">{{ feedbackText(detail.content) }}</span></el-descriptions-item>
              <el-descriptions-item label="状态">{{ detail.status === 1 ? '已处理' : '未处理' }}</el-descriptions-item>
            </el-descriptions>
            <label class="remark"><span>处理备注</span>
              <el-input v-model="draftMake" type="textarea" :rows="4" maxlength="255" show-word-limit :disabled="!canManage || saving" /></label>
            <el-checkbox v-if="canManage && detail.status === 0" v-model="markProcessed" :disabled="saving">标记为已处理</el-checkbox>
          </template>
        </div>
        <el-alert v-if="mutationError" :title="mutationError" type="error" :closable="false" show-icon />
        <template #footer><el-button @click="detailVisible = false">关闭</el-button>
          <el-button v-if="canManage && detail" type="primary" :loading="saving" @click="save">保存</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiFeedbackDelete, apiFeedbackDetail, apiFeedbackList, apiFeedbackUpdate,
  feedbackText, feedbackTime, normalizeFeedbackQuery, type FeedbackPreset,
  type FeedbackQuery, type FeedbackRow } from "@/api/feedback";

const auth = useAuthStore();
const draftTitle = ref(""), draftStatus = ref<"" | 0 | 1>(""), draftPreset = ref<FeedbackPreset>("");
const draftDates = ref<[string, string] | null>(null);
const applied = ref<Omit<FeedbackQuery, "page" | "limit">>({ title: "", time: "", status: "" });
const page = ref(1), count = ref(0), list = ref<FeedbackRow[]>([]), loading = ref(false);
const listError = ref(""), filterError = ref("");
const detailVisible = ref(false), detailId = ref(0), detail = ref<FeedbackRow | null>(null);
const detailLoading = ref(false), detailError = ref(""), draftMake = ref(""), markProcessed = ref(false);
const mutationError = ref(""), saving = ref(false);
let alive = false, syncing = false, generation = 0, detailGeneration = 0;
let stored = localStorage.getItem("admin_session");
let listAbort: AbortController | null = null, detailAbort: AbortController | null = null;
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
function hasPermission(key: string): boolean {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") &&
    !!auth.userInfo && !!session && session.userInfo.id === auth.userInfo.id &&
    session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes(key) && session.uniqueAuth.includes(key)));
}
const canView = computed(() => hasPermission("feedback.view") || hasPermission("feedback.manage"));
const canManage = computed(() => hasPermission("feedback.manage"));
type Scope = { identity: string; stored: string | null; generation: number };
function scope(): Scope { return { identity: identity.value, stored, generation }; }
function current(value: Scope): boolean { return alive && canView.value && value.identity === identity.value &&
  value.stored === stored && stored === localStorage.getItem("admin_session") && value.generation === generation && auth.token === getToken(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "请求失败"; }
function clearDetail(): void {
  detailGeneration++; detailAbort?.abort(); detailAbort = null; detailVisible.value = false;
  detailId.value = 0; detail.value = null; detailLoading.value = false; detailError.value = "";
  draftMake.value = ""; markProcessed.value = false; mutationError.value = "";
}
function closeDetail(): void { if (!detailVisible.value) clearDetail(); }
function clear(): void {
  generation++; listAbort?.abort(); listAbort = null; clearDetail();
  list.value = []; count.value = 0; page.value = 1; loading.value = false;
  listError.value = filterError.value = ""; draftTitle.value = ""; draftStatus.value = "";
  draftPreset.value = ""; draftDates.value = null; applied.value = { title: "", time: "", status: "" };
}
async function load(target = page.value): Promise<void> {
  if (!current(scope()) || !Number.isSafeInteger(target) || target < 1 || (target - 1) * 15 > 10_000) return;
  listAbort?.abort(); const stamp = scope(), controller = new AbortController(); listAbort = controller;
  page.value = target; loading.value = true; listError.value = ""; list.value = []; count.value = 0;
  try {
    const result = await apiFeedbackList({ ...applied.value, page: target, limit: 15 }, controller.signal);
    if (current(stamp) && listAbort === controller) { list.value = result.data; count.value = result.count; }
  } catch (error) { if (current(stamp) && listAbort === controller) listError.value = errorMessage(error); }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search(): void {
  if (!current(scope())) return;
  try {
    const query = normalizeFeedbackQuery({ page: 1, limit: 15, title: draftTitle.value,
      status: draftStatus.value, time: draftDates.value ? draftDates.value.join("-") : draftPreset.value });
    applied.value = { title: query.title, time: query.time, status: query.status };
    filterError.value = ""; void load(1);
  } catch (error) { filterError.value = errorMessage(error); }
}
function choosePreset(): void { draftDates.value = null; search(); }
function chooseDates(): void { if (draftDates.value?.length) draftPreset.value = ""; }
function reset(): void { draftTitle.value = ""; draftStatus.value = ""; draftPreset.value = "";
  draftDates.value = null; search(); }
async function openDetail(row: FeedbackRow): Promise<void> {
  if (!current(scope()) || !list.value.some(item => item.id === row.id)) return;
  clearDetail(); detailId.value = row.id; detailVisible.value = true; await reloadDetail();
}
async function reloadDetail(): Promise<void> {
  if (!detailVisible.value || !detailId.value || !current(scope())) return;
  detailGeneration++; detailAbort?.abort(); const version = detailGeneration;
  const stamp = scope(), controller = new AbortController(); detailAbort = controller;
  detailLoading.value = true; detailError.value = ""; detail.value = null; mutationError.value = "";
  try {
    const row = await apiFeedbackDetail(detailId.value, controller.signal);
    if (current(stamp) && detailVisible.value && detailGeneration === version && detailAbort === controller) {
      detail.value = row; draftMake.value = row.make; markProcessed.value = false;
    }
  } catch (error) { if (current(stamp) && detailGeneration === version && detailAbort === controller)
    detailError.value = errorMessage(error); }
  finally { if (detailAbort === controller) { detailAbort = null; detailLoading.value = false; } }
}
async function save(): Promise<void> {
  if (!canManage.value || !detail.value || saving.value || !current(scope()) ||
    detail.value.id !== detailId.value) return;
  const stamp = scope(), id = detail.value.id;
  saving.value = true; mutationError.value = "";
  try {
    await apiFeedbackUpdate(id, draftMake.value, detail.value.status === 0 && markProcessed.value);
    if (current(stamp) && detailVisible.value && detailId.value === id) {
      ElMessage.success("留言已更新"); detailVisible.value = false; clearDetail(); await load(page.value);
    }
  } catch (error) { if (current(stamp)) mutationError.value = `${errorMessage(error)}；请刷新详情确认结果后再操作`; }
  finally { saving.value = false; }
}
async function remove(row: FeedbackRow): Promise<void> {
  if (!canManage.value || !current(scope()) || !list.value.some(item => item.id === row.id) || saving.value) return;
  const stamp = scope();
  try { await ElMessageBox.confirm(`确认删除留言 #${row.id}？此操作不能撤销。`, "删除留言", { type: "warning" }); }
  catch { return; }
  if (!current(stamp) || !canManage.value || !list.value.some(item => item.id === row.id)) return;
  saving.value = true;
  try { await apiFeedbackDelete(row.id);
    if (current(stamp)) { ElMessage.success("留言已删除"); await load(page.value); }
  } catch (error) { if (current(stamp)) listError.value = `${errorMessage(error)}；请刷新列表确认结果后再操作`; }
  finally { saving.value = false; }
}
function syncSession(): void {
  syncing = true; clear(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session"); sessionVersion.value++; syncing = false;
  if (canView.value) void load(1);
}
function syncStorage(event: StorageEvent): void {
  if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession();
}
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
watch(detailVisible, visible => { if (!visible) clearDetail(); }, { flush: "sync" });
onMounted(() => { alive = true; window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession); window.addEventListener("storage", syncStorage);
  syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession); window.removeEventListener("storage", syncStorage); });
</script>

<style scoped>
.feedback-page { min-width: 0; }.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.heading h2 { margin: 0 0 6px; font-size: 20px; }.hint { color: var(--el-text-color-secondary); font-size: 13px; }
.section { margin-top: 16px; }.filters { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 155px; font-size: 13px; }
.field:first-child { flex: 1 1 220px; }.dates { flex: 1 1 290px; }
.field :deep(.el-select), .field :deep(.el-date-editor), .field :deep(.el-input) { width: 100%; }
.actions { display: flex; gap: 8px; }.actions :deep(.el-button + .el-button) { margin-left: 0; }
.table-scroll { width: 100%; overflow-x: auto; }.pager { margin-top: 16px; justify-content: flex-end; }
.remark { display: grid; gap: 7px; margin: 16px 0; font-size: 13px; }.message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 650px) { .field, .dates { flex: 1 1 100%; } }
</style>
