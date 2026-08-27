<template>
  <div class="runtime-page">
    <el-alert
      title="这里展示迁移自 PHP 的运行历史，不是 Cloudflare 的任务控制台"
      description="queue_list / queue_auxiliary 仅用于追溯旧批处理；system_timer 仅保留原任务目录。当前 Worker 任务由 Cloudflare Queues 与 scheduled handler 驱动，本页不会重试、停止或启停外部任务。"
      type="warning"
      show-icon
      :closable="false"
    />

    <div class="summary-grid">
      <el-card shadow="never"><span>定时目录</span><strong>{{ timerCount }}</strong></el-card>
      <el-card shadow="never"><span>Worker 已实现</span><strong class="success">{{ implementedCount }}</strong></el-card>
      <el-card shadow="never"><span>部分迁移 / 待迁移</span><strong class="warning">{{ Math.max(0, timerCount - implementedCount) }}</strong></el-card>
      <el-card shadow="never"><span>历史批处理</span><strong>{{ queueCount }}</strong></el-card>
    </div>

    <el-card shadow="never">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="定时任务目录" name="timers">
          <div class="toolbar">
            <div>
              <strong>PHP 定时任务迁移映射</strong>
              <p>“源开关/周期”只反映迁移数据；绿色项目由 Worker 独立实现。</p>
            </div>
            <el-input v-model="timerKeyword" clearable placeholder="搜索名称或标识" aria-label="搜索定时任务" @keyup.enter="loadTimers">
              <template #append><el-button @click="loadTimers">查询</el-button></template>
            </el-input>
          </div>

          <div class="desktop-table">
            <el-table :data="timers" v-loading="timerLoading" stripe row-key="id" empty-text="暂无迁移定时任务">
              <el-table-column label="任务" min-width="210">
                <template #default="{ row }"><strong>{{ row.name }}</strong><div class="sub-text mono">{{ row.mark }}</div></template>
              </el-table-column>
              <el-table-column label="源配置" min-width="190">
                <template #default="{ row }"><el-tag :type="row.is_open ? 'success' : 'info'" effect="plain">{{ row.is_open ? '源端开启' : '源端关闭' }}</el-tag><div class="sub-text">{{ row.execution_cycle }}</div></template>
              </el-table-column>
              <el-table-column label="Worker 状态" min-width="220">
                <template #default="{ row }"><el-tag :type="timerTone(row.runtime_status)">{{ timerStatusText(row.runtime_status) }}</el-tag><div class="sub-text mono">{{ row.worker_job || 'no consumer' }}</div></template>
              </el-table-column>
              <el-table-column label="边界说明" min-width="360"><template #default="{ row }"><span class="note">{{ row.runtime_note }}</span></template></el-table-column>
              <el-table-column label="历史执行" width="185"><template #default="{ row }">{{ formatTime(row.last_execution_time) }}</template></el-table-column>
            </el-table>
          </div>

          <div class="mobile-list">
            <article v-for="row in timers" :key="row.id" class="mobile-card">
              <div class="mobile-title"><div><strong>{{ row.name }}</strong><span class="mono">{{ row.mark }}</span></div><el-tag :type="timerTone(row.runtime_status)">{{ timerStatusText(row.runtime_status) }}</el-tag></div>
              <p>{{ row.execution_cycle }} · {{ row.is_open ? '源端开启' : '源端关闭' }}</p>
              <p>{{ row.runtime_note }}</p>
            </article>
          </div>
        </el-tab-pane>

        <el-tab-pane label="历史批处理" name="queues">
          <div class="toolbar queue-toolbar">
            <div><strong>旧系统批处理记录</strong><p>只读保留任务头、进度和逐项结果，不提供伪重试按钮。</p></div>
            <div class="filters">
              <el-select v-model="queueType" clearable placeholder="全部类型" aria-label="筛选任务类型" @change="resetQueues">
                <el-option v-for="item in queueTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <el-select v-model="queueStatus" clearable placeholder="全部状态" aria-label="筛选任务状态" @change="resetQueues">
                <el-option label="未处理" :value="0" /><el-option label="正在处理" :value="1" /><el-option label="完成" :value="2" /><el-option label="失败" :value="3" />
              </el-select>
            </div>
          </div>

          <div class="desktop-table">
            <el-table :data="queues" v-loading="queueLoading" stripe row-key="id" empty-text="暂无旧批处理记录">
              <el-table-column prop="id" label="任务 ID" width="90" />
              <el-table-column label="批处理" min-width="225"><template #default="{ row }"><strong>{{ row.type_cn }}</strong><div class="sub-text mono">{{ row.execute_key }}</div></template></el-table-column>
              <el-table-column label="状态" width="115"><template #default="{ row }"><el-tag :type="queueTone(row.status)">{{ row.status_cn }}</el-tag></template></el-table-column>
              <el-table-column label="历史进度" min-width="230"><template #default="{ row }"><el-progress :percentage="queueProgress(row)" :status="row.status === 3 ? 'exception' : row.status === 2 ? 'success' : undefined" /><div class="sub-text">成功 {{ row.success_num }} / 总计 {{ row.total_num }}，剩余 {{ row.surplus_num }}</div></template></el-table-column>
              <el-table-column label="来源 / 创建时间" min-width="210"><template #default="{ row }"><span>{{ row.source }}</span><div class="sub-text">{{ formatTime(row.add_time) }}</div></template></el-table-column>
              <el-table-column label="操作" width="105" fixed="right"><template #default="{ row }"><el-button v-if="row.is_show_log" link type="primary" @click="openLogs(row)">查看明细</el-button><span v-else class="sub-text">只读</span></template></el-table-column>
            </el-table>
          </div>

          <div class="mobile-list">
            <article v-for="row in queues" :key="row.id" class="mobile-card">
              <div class="mobile-title"><div><strong>#{{ row.id }} {{ row.type_cn }}</strong><span>{{ formatTime(row.add_time) }}</span></div><el-tag :type="queueTone(row.status)">{{ row.status_cn }}</el-tag></div>
              <el-progress :percentage="queueProgress(row)" :status="row.status === 3 ? 'exception' : row.status === 2 ? 'success' : undefined" />
              <p>成功 {{ row.success_num }} / 总计 {{ row.total_num }}，剩余 {{ row.surplus_num }}</p>
              <el-button v-if="row.is_show_log" plain size="small" @click="openLogs(row)">查看逐项结果</el-button>
            </article>
          </div>

          <el-pagination class="pager" background layout="prev, pager, next" :current-page="queuePage" :page-size="20" :total="queueCount" @current-change="changeQueuePage" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-drawer v-model="logDrawer" :title="logTitle" size="min(720px, 92vw)">
      <el-alert title="逐项结果同样是旧系统快照；查看不会触发发货、短信、微信或其他外部调用。" type="info" :closable="false" show-icon />
      <el-table :data="logs" v-loading="logLoading" stripe empty-text="暂无逐项结果">
        <el-table-column prop="relation_id" label="关联 ID" width="110" />
        <el-table-column label="结果" width="100"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : row.status === 2 ? 'danger' : 'info'">{{ row.status_cn }}</el-tag></template></el-table-column>
        <el-table-column label="历史数据" min-width="330"><template #default="{ row }"><code>{{ row.other || '-' }}</code></template></el-table-column>
        <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatTime(row.update_time || row.add_time) }}</template></el-table-column>
      </el-table>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiLegacyQueueLogs, apiLegacyQueues, apiLegacyTimers, type LegacyQueueItem, type LegacyQueueLogItem, type LegacyTimerItem } from "@/api/legacyRuntime";

const activeTab = ref("timers");
const timers = ref<LegacyTimerItem[]>([]);
const timerCount = ref(0);
const timerKeyword = ref("");
const timerLoading = ref(false);
const queues = ref<LegacyQueueItem[]>([]);
const queueCount = ref(0);
const queuePage = ref(1);
const queueType = ref<number | "">("");
const queueStatus = ref<number | "">("");
const queueLoading = ref(false);
const logs = ref<LegacyQueueLogItem[]>([]);
const logDrawer = ref(false);
const logLoading = ref(false);
const logTitle = ref("旧批处理逐项结果");

const implementedCount = computed(() => timers.value.filter((row) => row.runtime_status === "implemented_independently").length);
const queueTypeOptions = Object.entries({ 1: "批量发放优惠券", 2: "批量设置用户分组", 3: "批量设置用户标签", 4: "批量下架商品", 5: "批量删除商品规格", 6: "批量删除订单", 7: "批量手动发货", 8: "批量打印电子面单", 9: "批量配送", 10: "批量虚拟发货" }).map(([value, label]) => ({ value: Number(value), label }));

function formatTime(timestamp: number) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function queueProgress(row: LegacyQueueItem) {
  return row.total_num > 0 ? Math.min(100, Math.max(0, Math.round((row.success_num / row.total_num) * 100))) : 0;
}

function queueTone(status: number): "success" | "warning" | "danger" | "primary" | "info" {
  if (status === 2) return "success";
  if (status === 3) return "danger";
  if (status === 1) return "primary";
  return "info";
}

function timerTone(status: LegacyTimerItem["runtime_status"]): "success" | "warning" | "info" {
  if (status === "implemented_independently") return "success";
  if (status === "partially_implemented") return "warning";
  return "info";
}

function timerStatusText(status: LegacyTimerItem["runtime_status"]): string {
  if (status === "implemented_independently") return "已独立实现";
  if (status === "partially_implemented") return "部分迁移";
  return "尚未迁移";
}

async function loadTimers() {
  timerLoading.value = true;
  try {
    const result = await apiLegacyTimers({ page: 1, limit: 100, keyword: timerKeyword.value || undefined });
    timers.value = result.list;
    timerCount.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "定时任务目录加载失败");
  } finally {
    timerLoading.value = false;
  }
}

async function loadQueues() {
  queueLoading.value = true;
  try {
    const result = await apiLegacyQueues({ page: queuePage.value, limit: 20, type: queueType.value === "" ? undefined : queueType.value, status: queueStatus.value === "" ? undefined : queueStatus.value });
    queues.value = result.list;
    queueCount.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "历史批处理加载失败");
  } finally {
    queueLoading.value = false;
  }
}

async function resetQueues() { queuePage.value = 1; await loadQueues(); }
async function changeQueuePage(page: number) { queuePage.value = page; await loadQueues(); }

async function openLogs(row: LegacyQueueItem) {
  logDrawer.value = true;
  logTitle.value = `#${row.id} ${row.type_cn} · 逐项结果`;
  logLoading.value = true;
  logs.value = [];
  try {
    const result = await apiLegacyQueueLogs(row.id, row.cache_type);
    logs.value = result.list;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "逐项结果加载失败");
  } finally {
    logLoading.value = false;
  }
}

onMounted(() => Promise.all([loadTimers(), loadQueues()]));
</script>

<style scoped>
.runtime-page { display: grid; gap: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.summary-grid span { color: #7a8495; font-size: 13px; }
.summary-grid strong { display: block; margin-top: 10px; color: #172b4d; font-size: 26px; font-variant-numeric: tabular-nums; }
.summary-grid .success { color: #14875d; }
.summary-grid .warning { color: #d07a12; }
.toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.toolbar p { margin: 6px 0 0; color: #8a94a5; font-size: 12px; }
.toolbar > .el-input { width: 300px; }
.filters { display: flex; gap: 10px; }
.filters .el-select { width: 170px; }
.sub-text { margin-top: 5px; color: #8a94a5; font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.note { color: #556176; font-size: 13px; line-height: 1.55; }
.pager { justify-content: flex-end; margin-top: 18px; }
code { color: #445168; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
.mobile-list { display: none; }
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .toolbar { flex-direction: column; }
  .toolbar > .el-input, .filters { width: 100%; }
  .filters .el-select { flex: 1; }
}
@media (max-width: 720px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .summary-grid strong { font-size: 22px; }
  .desktop-table { display: none; }
  .mobile-list { display: grid; gap: 10px; }
  .mobile-card { padding: 14px; border: 1px solid #e7eaf0; border-radius: 10px; background: #fff; }
  .mobile-card p { margin: 10px 0 0; color: #6f7a8e; font-size: 12px; line-height: 1.55; }
  .mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .mobile-title strong, .mobile-title span { display: block; }
  .mobile-title span { margin-top: 4px; color: #8a94a5; font-size: 11px; }
  .filters { flex-direction: column; }
  .filters .el-select { width: 100%; }
  .pager { justify-content: center; }
}
</style>
