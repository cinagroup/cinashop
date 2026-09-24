<template>
  <div class="integral-log">
    <el-card shadow="never">
      <template #header>
        <div class="heading">
          <div>
            <strong>积分日志</strong>
            <p class="hint">按会员、流水类型和时间查看积分变动。</p>
          </div>
          <el-button v-if="canView" :loading="listLoading || statLoading" @click="refresh">刷新</el-button>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有积分日志查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="filters">
          <label class="filter-field">
            <span>搜索</span>
            <el-input v-model="draftKeyword" aria-label="用户 ID、标题、昵称或手机号" clearable maxlength="100" placeholder="用户 ID / 标题 / 昵称 / 手机号" @keyup.enter="search" />
          </label>
          <label class="filter-field type-field">
            <span>流水类型</span>
            <el-input v-model="draftType" aria-label="流水类型" clearable maxlength="64" placeholder="类型代码，如 sign" @keyup.enter="search" />
          </label>
          <label class="filter-field time-field">
            <span>添加时间（北京时间）</span>
            <el-date-picker v-model="draftRange" aria-label="添加时间范围" type="datetimerange" format="YYYY/MM/DD HH:mm" value-format="YYYY-MM-DD HH:mm" start-placeholder="开始时间" end-placeholder="结束时间" range-separator="至" clearable />
          </label>
          <div class="filter-actions">
            <el-button type="primary" :loading="listLoading || statLoading" @click="search">查询</el-button>
            <el-button :disabled="listLoading || statLoading" @click="reset">重置</el-button>
          </div>
        </div>

        <el-alert v-if="statError" :title="statError" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="loadStats">重试统计</el-button></template>
        </el-alert>
        <div class="stats" v-loading="statLoading" aria-label="积分统计">
          <div v-for="card in cards" :key="card.label" class="stat-card">
            <span class="stat-label">{{ card.label }}</span>
            <strong>{{ card.value }}</strong>
          </div>
        </div>

        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="loadList(page)">重试列表</el-button></template>
        </el-alert>
        <div class="table-scroll">
          <el-table :data="list" v-loading="listLoading" stripe row-key="id" empty-text="暂无积分记录">
            <el-table-column prop="id" label="ID" width="100" />
            <el-table-column prop="title" label="标题" min-width="160" />
            <el-table-column prop="balance" label="变动后积分" min-width="120" />
            <el-table-column label="积分变动" min-width="115">
              <template #default="{ row }"><span :class="row.pm === 1 ? 'income' : 'expense'">{{ row.pm === 1 ? '+' : '-' }}{{ row.number }}</span></template>
            </el-table-column>
            <el-table-column prop="mark" label="备注" min-width="180" show-overflow-tooltip />
            <el-table-column label="用户微信昵称" min-width="155">
              <template #default="{ row }">{{ row.nickname || `用户 #${row.uid}` }}</template>
            </el-table-column>
            <el-table-column label="添加时间" min-width="160">
              <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination :current-page="page" :page-size="PAGE_SIZE" :total="count" :disabled="listLoading" layout="total, prev, pager, next" class="pager" @current-change="loadList" />
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { capitalFlowRange } from "@/pages/finance/capitalFlowRange";
import {
  apiAdminIntegralLogs,
  apiAdminIntegralStatistics,
  type IntegralLogQuery,
  type IntegralLogRow,
  type IntegralLogStats,
} from "@/api/integralLog";

const PAGE_SIZE = 15;
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("integral_log.view")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.uniqueAuth.join(",")}`);
const draftKeyword = ref("");
const draftType = ref("");
const draftRange = ref<string[] | null>(null);
const filters = ref<Omit<IntegralLogQuery, "page" | "limit">>({});
const list = ref<IntegralLogRow[]>([]);
const count = ref(0);
const page = ref(1);
const listLoading = ref(false);
const listError = ref("");
const stats = ref<IntegralLogStats | null>(null);
const statLoading = ref(false);
const statError = ref("");
const cards = computed(() => [
  { label: "总积分(个)", value: stats.value?.total_integral ?? "—" },
  { label: "客户签到次数(次)", value: stats.value?.sign_count ?? "—" },
  { label: "签到送出积分(个)", value: stats.value?.sign_integral ?? "—" },
  { label: "使用积分(个)", value: stats.value?.used_integral ?? "—" },
]);
let mounted = false;
let listGeneration = 0;
let statGeneration = 0;
let listAbort: AbortController | null = null;
let statAbort: AbortController | null = null;

function active(stamp: string): boolean {
  return mounted && canView.value && sessionKey.value === stamp && auth.token === getToken();
}

function discard() {
  listGeneration++;
  statGeneration++;
  listAbort?.abort();
  statAbort?.abort();
  listAbort = null;
  statAbort = null;
  list.value = [];
  count.value = 0;
  stats.value = null;
  listLoading.value = false;
  statLoading.value = false;
  listError.value = "";
  statError.value = "";
}

async function loadList(targetPage = page.value): Promise<void> {
  if (!mounted || !canView.value) return;
  const stamp = sessionKey.value;
  const generation = ++listGeneration;
  listAbort?.abort();
  const controller = new AbortController();
  listAbort = controller;
  listLoading.value = true;
  listError.value = "";
  list.value = [];
  count.value = 0;
  try {
    const result = await apiAdminIntegralLogs({ ...filters.value, page: targetPage, limit: PAGE_SIZE }, controller.signal);
    if (!active(stamp) || generation !== listGeneration) return;
    if (result.page !== targetPage || result.limit !== PAGE_SIZE) throw new Error("积分日志分页结果与请求不一致");
    list.value = result.list;
    count.value = result.count;
    page.value = targetPage;
  } catch (error) {
    if (active(stamp) && generation === listGeneration && !controller.signal.aborted) {
      listError.value = error instanceof Error ? error.message : "加载积分日志失败";
    }
  } finally {
    if (generation === listGeneration) {
      listAbort = null;
      listLoading.value = false;
    }
  }
}

async function loadStats(): Promise<void> {
  if (!mounted || !canView.value) return;
  const stamp = sessionKey.value;
  const generation = ++statGeneration;
  statAbort?.abort();
  const controller = new AbortController();
  statAbort = controller;
  statLoading.value = true;
  statError.value = "";
  stats.value = null;
  try {
    const result = await apiAdminIntegralStatistics(filters.value, controller.signal);
    if (active(stamp) && generation === statGeneration) stats.value = result;
  } catch (error) {
    if (active(stamp) && generation === statGeneration && !controller.signal.aborted) {
      statError.value = error instanceof Error ? error.message : "加载积分统计失败";
    }
  } finally {
    if (generation === statGeneration) {
      statAbort = null;
      statLoading.value = false;
    }
  }
}

function refresh() {
  void loadList(page.value);
  void loadStats();
}

function search() {
  const type = draftType.value.trim();
  if (type && !/^[A-Za-z0-9_-]{1,64}$/u.test(type)) {
    ElMessage.error("请输入有效的流水类型代码");
    return;
  }
  let range: { start?: number; stop?: number };
  try { range = capitalFlowRange(draftRange.value); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "时间范围无效"); return; }
  filters.value = { keyword: draftKeyword.value.trim(), type, ...range };
  void loadList(1);
  void loadStats();
}

function reset() {
  draftKeyword.value = "";
  draftType.value = "";
  draftRange.value = null;
  filters.value = {};
  void loadList(1);
  void loadStats();
}

function formatTime(seconds: number): string {
  if (!seconds) return "—";
  return new Date((seconds + 8 * 60 * 60) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function syncSession() {
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}

watch(sessionKey, () => {
  discard();
  if (mounted && canView.value) { void loadList(1); void loadStats(); }
});
onMounted(() => {
  mounted = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value && canView.value) { void loadList(1); void loadStats(); }
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  discard();
});
</script>

<style scoped>
.integral-log { min-width: 0; }
.heading, .filters { display: flex; gap: 12px; flex-wrap: wrap; }
.heading { align-items: center; justify-content: space-between; }
.hint { margin: 4px 0 0; color: #737985; font-size: 12px; }
.filters { align-items: end; margin-bottom: 18px; }
.filter-field { display: flex; flex: 1 1 210px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.type-field { flex-basis: 150px; }
.time-field { flex-basis: 320px; }
.filter-field :deep(.el-input), .filter-field :deep(.el-date-editor) { width: 100%; }
.filter-actions { display: flex; gap: 8px; }
.notice { margin-bottom: 14px; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat-card { min-width: 0; padding: 14px 16px; border: 1px solid #e8ebf0; border-radius: 6px; background: #fafbfd; display: flex; flex-direction: column; gap: 6px; }
.stat-label { color: #737985; font-size: 12px; }
.stat-card strong { font-size: 22px; overflow-wrap: anywhere; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.income { color: #32936d; font-weight: 600; }
.expense { color: #d74732; font-weight: 600; }
.pager { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 800px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); } .pager { justify-content: center; } }
</style>
