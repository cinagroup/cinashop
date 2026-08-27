<template>
  <div class="outbox-page">
    <el-card class="section-switch" shadow="never">
      <div>
        <strong>任务运维</strong>
        <span>区分业务 outbox 重试与 Cloudflare Queue 死信处置</span>
      </div>
      <el-radio-group v-model="activeSection" aria-label="选择任务运维视图">
        <el-radio-button value="outbox">支付后置任务</el-radio-button>
        <el-radio-button value="dead-letter">Queue 死信</el-radio-button>
      </el-radio-group>
    </el-card>

    <template v-if="activeSection === 'outbox'">
      <el-alert
        title="渠道支付成功不等于所有后置任务都已完成"
        description="优惠券核销、支付次数、订单状态与推广佣金由事务型 outbox 可靠处理。系统会自动重试；排除业务数据问题后，可在此人工重放失败事件。"
        type="warning"
        show-icon
        :closable="false"
      />

      <div class="summary-grid">
        <el-card v-for="card in summaryCards" :key="card.label" shadow="never">
          <span>{{ card.label }}</span>
          <strong :class="card.tone">{{ card.value }}</strong>
        </el-card>
      </div>

      <el-card shadow="never">
        <template #header>
          <div class="card-header">
            <div>
              <strong>支付后置任务</strong>
              <p>按事件查看自动投递、处理与人工重放记录</p>
            </div>
            <el-select
              v-model="status"
              clearable
              placeholder="全部状态"
              aria-label="按任务状态筛选"
              @change="resetAndLoad"
            >
              <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </div>
        </template>

        <el-table :data="list" v-loading="loading" stripe row-key="id" empty-text="暂无后置任务">
          <el-table-column prop="id" label="事件 ID" width="90" />
          <el-table-column label="订单 / 事件键" min-width="235">
            <template #default="{ row }">
              <strong>{{ row.payload.orderNo }}</strong>
              <div class="sub-text mono">{{ row.eventKey }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="statusInfo(row.status).tone" effect="light">{{ statusInfo(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="处理计数" width="145">
            <template #default="{ row }">
              <div>尝试 {{ row.attemptCount }} 次</div>
              <div class="sub-text">投递 {{ row.dispatchCount }} · 重放 {{ row.replayCount }}</div>
            </template>
          </el-table-column>
          <el-table-column label="最近错误" min-width="260">
            <template #default="{ row }">
              <span v-if="row.lastError" class="error-text">{{ row.lastError }}</span>
              <span v-else class="sub-text">无</span>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="185">
            <template #default="{ row }">
              <div>更新 {{ formatTime(row.updateTime) }}</div>
              <div class="sub-text">创建 {{ formatTime(row.addTime) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="canReplay(row.status)"
                type="primary"
                plain
                size="small"
                :loading="replayingId === row.id"
                @click="replay(row)"
              >
                重放
              </el-button>
              <span v-else class="sub-text">自动处理</span>
            </template>
          </el-table-column>
        </el-table>

        <div class="cursor-pager">
          <span>第 {{ pageNumber }} 页</span>
          <el-button :disabled="loading || cursorHistory.length === 0" @click="previousPage">上一页</el-button>
          <el-button type="primary" plain :disabled="loading || nextCursor === null" @click="nextPage">下一页</el-button>
        </div>
      </el-card>
    </template>

    <QueueDeadLetterPanel v-else />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminOrderOutboxList,
  apiAdminOrderOutboxReplay,
  type OrderOutboxItem,
  type OrderOutboxStatus,
} from "@/api/operations";
import QueueDeadLetterPanel from "@/pages/operations/QueueDeadLetterPanel.vue";

const statusOptions: Array<{ label: string; value: OrderOutboxStatus }> = [
  { label: "待投递", value: "PENDING" },
  { label: "投递中", value: "ENQUEUING" },
  { label: "已入队", value: "ENQUEUED" },
  { label: "处理中", value: "PROCESSING" },
  { label: "已完成", value: "COMPLETED" },
  { label: "等待重试", value: "FAILED" },
  { label: "已停止", value: "DEAD" },
];

const activeSection = ref<"outbox" | "dead-letter">("outbox");
const list = ref<OrderOutboxItem[]>([]);
const loading = ref(false);
const replayingId = ref<number | null>(null);
const status = ref<OrderOutboxStatus | "">("");
const currentCursor = ref<number | undefined>();
const nextCursor = ref<number | null>(null);
const cursorHistory = ref<Array<number | undefined>>([]);
const pageNumber = computed(() => cursorHistory.value.length + 1);

const summaryCards = computed(() => {
  const count = (statuses: OrderOutboxStatus[]) => list.value.filter((row) => statuses.includes(row.status)).length;
  return [
    { label: "已停止", value: count(["DEAD"]), tone: "danger" },
    { label: "等待重试", value: count(["FAILED"]), tone: "warning" },
    { label: "进行中", value: count(["PENDING", "ENQUEUING", "ENQUEUED", "PROCESSING"]), tone: "primary" },
    { label: "已完成", value: count(["COMPLETED"]), tone: "success" },
  ];
});

function statusInfo(value: OrderOutboxStatus): {
  label: string;
  tone: "success" | "warning" | "danger" | "primary" | "info";
} {
  const option = statusOptions.find((item) => item.value === value);
  if (value === "COMPLETED") return { label: option?.label ?? value, tone: "success" };
  if (value === "DEAD") return { label: option?.label ?? value, tone: "danger" };
  if (value === "FAILED") return { label: option?.label ?? value, tone: "warning" };
  if (["ENQUEUING", "ENQUEUED", "PROCESSING"].includes(value)) return { label: option?.label ?? value, tone: "primary" };
  return { label: option?.label ?? value, tone: "info" };
}

function canReplay(value: OrderOutboxStatus) {
  return value === "FAILED" || value === "DEAD";
}

function formatTime(timestamp: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false });
}

async function load() {
  loading.value = true;
  try {
    const result = await apiAdminOrderOutboxList({
      status: status.value || undefined,
      after_id: currentCursor.value,
      limit: 20,
    });
    list.value = result.list;
    nextCursor.value = result.next_cursor;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "后置任务加载失败");
  } finally {
    loading.value = false;
  }
}

async function resetAndLoad() {
  currentCursor.value = undefined;
  cursorHistory.value = [];
  await load();
}

async function nextPage() {
  if (nextCursor.value === null) return;
  cursorHistory.value.push(currentCursor.value);
  currentCursor.value = nextCursor.value;
  await load();
}

async function previousPage() {
  if (!cursorHistory.value.length) return;
  currentCursor.value = cursorHistory.value.pop();
  await load();
}

async function replay(row: OrderOutboxItem) {
  try {
    await ElMessageBox.confirm(
      `确认重放订单 ${row.payload.orderNo} 的支付后置任务？请先确认导致失败的业务数据已经修复。`,
      "重放支付后置任务",
      { type: "warning", confirmButtonText: "确认重放", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  replayingId.value = row.id;
  try {
    const result = await apiAdminOrderOutboxReplay(row.id);
    await load();
    ElMessage.success(result.enqueued > 0 ? "事件已重放并进入队列" : "事件已进入补偿队列");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "事件重放失败");
  } finally {
    replayingId.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.outbox-page { display: grid; gap: 16px; }
.section-switch :deep(.el-card__body) { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.section-switch :deep(.el-card__body) > div:first-child { display: grid; gap: 5px; }
.section-switch span { color: #7a8495; font-size: 12px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.summary-grid span { color: #7a8495; font-size: 13px; }
.summary-grid strong { display: block; margin-top: 10px; color: #172b4d; font-size: 26px; font-variant-numeric: tabular-nums; }
.summary-grid .danger, .error-text { color: #d93026; }
.summary-grid .warning { color: #d07a12; }
.summary-grid .primary { color: #2f6fed; }
.summary-grid .success { color: #14875d; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.card-header p { margin: 6px 0 0; color: #8a94a5; font-size: 12px; font-weight: 400; }
.card-header .el-select { width: 160px; }
.sub-text { margin-top: 5px; color: #8a94a5; font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.error-text { line-height: 1.5; overflow-wrap: anywhere; }
.cursor-pager { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 18px; color: #7a8495; font-size: 13px; }
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .card-header { align-items: flex-start; flex-direction: column; }
}
@media (max-width: 767px) {
  .section-switch :deep(.el-card__body) { align-items: stretch; flex-direction: column; }
  .section-switch :deep(.el-radio-group) { display: grid; grid-template-columns: 1fr 1fr; }
  .section-switch :deep(.el-radio-button__inner) { width: 100%; }
}
</style>
