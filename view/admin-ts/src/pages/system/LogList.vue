<template>
  <el-card shadow="never">
    <template #header>操作日志</template>
    <el-alert v-if="!canView" title="当前账号没有操作日志查看权限" type="warning" show-icon :closable="false" />
    <template v-else>
    <el-form :inline="true" class="filters" @submit.prevent="load(1)">
      <el-form-item label="操作时间">
        <el-date-picker v-model="filters.timeRange" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss"
          format="YYYY-MM-DD HH:mm:ss" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间" clearable />
      </el-form-item>
      <el-form-item label="名称">
        <el-select v-model="filters.adminId" placeholder="全部管理员" clearable filterable style="width: 180px">
          <el-option v-for="admin in admins" :key="admin.id" :label="admin.real_name" :value="admin.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="链接">
        <el-input v-model="filters.path" placeholder="请输入链接" clearable maxlength="128" style="width: 220px" />
      </el-form-item>
      <el-form-item label="IP">
        <el-input v-model="filters.ip" placeholder="请输入 IP" clearable maxlength="45" style="width: 160px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" native-type="submit" :loading="loading">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>
    <el-table :data="list" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column label="ID/名称" min-width="140">
        <template #default="{ row }">{{ row.admin_id }} / {{ row.admin_name }}</template>
      </el-table-column>
      <el-table-column prop="path" label="链接" min-width="240" show-overflow-tooltip />
      <el-table-column label="行为" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ row.page || row.action || "-" }}</template>
      </el-table-column>
      <el-table-column prop="ip" label="操作 IP" min-width="145" />
      <el-table-column prop="type" label="类型" min-width="100" />
      <el-table-column label="操作时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
      </el-table-column>
    </el-table>
    <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="20"
      :current-page="page" @current-change="load" />
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiSystemLogAdmins, apiSystemLogs, type SystemLogQuery, type SystemLogRow } from "@/api/systemLog";

const auth = useAuthStore();
const list = ref<SystemLogRow[]>([]);
const admins = ref<Array<{ id: number; real_name: string }>>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const filters = reactive<{ adminId: number | ""; path: string; ip: string; timeRange: [string, string] | null }>({
  adminId: "", path: "", ip: "", timeRange: null,
});
let alive = false;
let syncing = false;
let stored = localStorage.getItem("admin_session");
let requestSequence = 0;
let optionsSequence = 0;
let listAbort: AbortController | null = null;
let optionsAbort: AbortController | null = null;
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") &&
    !!session && !!auth.userInfo && session.userInfo.id === auth.userInfo.id &&
    session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes("log.view") && session.uniqueAuth.includes("log.view")));
});
type Scope = { identity: string; stored: string | null };
function scope(): Scope { return { identity: identity.value, stored }; }
function current(stamp: Scope): boolean {
  return alive && canView.value && stamp.identity === identity.value && stamp.stored === stored &&
    stored === localStorage.getItem("admin_session") && auth.token === getToken();
}

function clear() {
  requestSequence++;
  optionsSequence++;
  listAbort?.abort();
  optionsAbort?.abort();
  listAbort = optionsAbort = null;
  list.value = [];
  admins.value = [];
  total.value = 0;
  page.value = 1;
  loading.value = false;
  filters.adminId = "";
  filters.path = "";
  filters.ip = "";
  filters.timeRange = null;
}

function shanghaiSecond(value: string): number {
  const time = Date.parse(`${value.replace(" ", "T")}+08:00`);
  if (!Number.isFinite(time)) throw new Error("操作时间格式错误");
  return Math.floor(time / 1000);
}

function formatTime(value: number): string {
  if (!value) return "-";
  const date = new Date((value + 8 * 3600) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

function queryForPage(nextPage: number): SystemLogQuery {
  const query: SystemLogQuery = { page: nextPage, limit: 20 };
  if (filters.adminId !== "") query.admin_id = filters.adminId;
  if (filters.path.trim()) query.path = filters.path.trim();
  if (filters.ip.trim()) query.ip = filters.ip.trim();
  if (filters.timeRange?.length === 2) {
    query.start_time = shanghaiSecond(filters.timeRange[0]);
    query.end_time = shanghaiSecond(filters.timeRange[1]);
    if (query.start_time > query.end_time) throw new Error("操作时间范围错误");
  }
  return query;
}

async function load(nextPage = 1) {
  if (!alive || !canView.value || !Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > 1001) return;
  const stamp = scope();
  const sequence = ++requestSequence;
  listAbort?.abort();
  const controller = new AbortController();
  listAbort = controller;
  loading.value = true;
  list.value = [];
  total.value = 0;
  try {
    const result = await apiSystemLogs(queryForPage(nextPage), controller.signal);
    if (!current(stamp) || sequence !== requestSequence || listAbort !== controller) return;
    list.value = result.list;
    total.value = result.total;
    page.value = nextPage;
  } catch (error) {
    if (!current(stamp) || sequence !== requestSequence || listAbort !== controller) return;
    ElMessage.error(error instanceof Error ? error.message : "日志加载失败");
  } finally {
    if (listAbort === controller) { listAbort = null; loading.value = false; }
  }
}

async function loadOptions() {
  if (!alive || !canView.value) return;
  const stamp = scope();
  const sequence = ++optionsSequence;
  optionsAbort?.abort();
  const controller = new AbortController();
  optionsAbort = controller;
  try {
    const result = await apiSystemLogAdmins(controller.signal);
    if (current(stamp) && sequence === optionsSequence && optionsAbort === controller) admins.value = result.info;
  } catch (error) {
    if (current(stamp) && sequence === optionsSequence && optionsAbort === controller)
      ElMessage.error(error instanceof Error ? error.message : "管理员列表加载失败");
  } finally {
    if (optionsAbort === controller) optionsAbort = null;
  }
}

function reset() {
  filters.adminId = "";
  filters.path = "";
  filters.ip = "";
  filters.timeRange = null;
  void load(1);
}

function syncSession() {
  syncing = true;
  clear();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session");
  sessionVersion.value++;
  syncing = false;
  if (canView.value) { void loadOptions(); void load(1); }
}
function syncStorage(event: StorageEvent) {
  if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession();
}
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
onMounted(() => {
  alive = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", syncStorage);
  syncSession();
});
onBeforeUnmount(() => {
  alive = false;
  clear();
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", syncStorage);
});
</script>

<style scoped>
.filters { margin-bottom: 8px; }
.pager { margin-top: 16px; justify-content: flex-end; }
</style>
