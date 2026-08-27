<template>
  <div class="dead-letter-panel">
    <el-alert
      title="死信不是可直接重试的普通失败任务"
      description="消息只有先脱敏并持久归档后才会从 Cloudflare DLQ 确认。系统仅允许重放当前仍受支持且具备幂等消费者的消息；短信验证码、旧版动作和未知消息必须人工核对后处置。"
      type="error"
      show-icon
      :closable="false"
    />

    <div class="summary-grid">
      <el-card shadow="never">
        <span>待处理</span>
        <strong class="danger">{{ alert.openCount }}</strong>
      </el-card>
      <el-card shadow="never">
        <span>重放中</span>
        <strong class="primary">{{ alert.replayingCount }}</strong>
      </el-card>
      <el-card shadow="never">
        <span>禁止重放</span>
        <strong class="warning">{{ alert.blockedCount }}</strong>
      </el-card>
      <el-card shadow="never">
        <span>最早待处理</span>
        <strong class="oldest-time">{{ formatTime(alert.oldestOpenTime) }}</strong>
      </el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div>
            <strong>Queue 死信归档</strong>
            <p>正文已经服务端脱敏；操作记录永久保存管理员、原因和时间</p>
          </div>
          <div class="filters">
            <el-select
              v-model="status"
              clearable
              placeholder="全部状态"
              aria-label="按死信状态筛选"
              @change="resetAndLoad"
            >
              <el-option
                v-for="option in statusOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
            <el-input
              v-model.trim="messageType"
              clearable
              maxlength="64"
              placeholder="消息类型"
              aria-label="按消息类型筛选"
              @keyup.enter="resetAndLoad"
              @clear="resetAndLoad"
            />
            <el-button :loading="loading" @click="resetAndLoad">查询</el-button>
          </div>
        </div>
      </template>

      <el-table
        class="desktop-table"
        :data="list"
        v-loading="loading"
        stripe
        row-key="id"
        empty-text="暂无死信归档"
      >
        <el-table-column prop="id" label="ID" width="72" />
        <el-table-column label="消息" min-width="245">
          <template #default="{ row }">
            <strong>{{ row.messageType }}</strong>
            <div class="sub-text mono">{{ row.queueName }}</div>
            <div class="sub-text mono message-id">{{ row.messageId }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态 / 策略" width="138">
          <template #default="{ row }">
            <el-tag :type="statusInfo(row.status).tone" effect="light">
              {{ statusInfo(row.status).label }}
            </el-tag>
            <div class="policy-line">
              <el-tag :type="policyInfo(row.replayPolicy).tone" effect="plain" size="small">
                {{ policyInfo(row.replayPolicy).label }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="计数" width="132">
          <template #default="{ row }">
            <div>DLQ 投递 {{ row.dlqAttempts }}</div>
            <div class="sub-text">出现 {{ row.occurrenceCount }} · 重放 {{ row.replayCount }}</div>
          </template>
        </el-table-column>
        <el-table-column label="最近错误" min-width="245">
          <template #default="{ row }">
            <span v-if="row.lastError" class="error-text">{{ row.lastError }}</span>
            <span v-else class="sub-text">无</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="178">
          <template #default="{ row }">
            <div>发现 {{ formatTime(row.firstSeenTime) }}</div>
            <div class="sub-text">更新 {{ formatTime(row.updateTime) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="178" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" @click="showDetail(row)">查看</el-button>
              <el-button
                v-if="canReplay(row)"
                link
                type="primary"
                @click="openOperation(row, 'replay')"
              >
                重放
              </el-button>
              <el-button
                v-if="canResolve(row)"
                link
                type="danger"
                @click="openOperation(row, 'resolve')"
              >
                处置
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div v-loading="loading" class="mobile-list">
        <el-empty v-if="!loading && list.length === 0" description="暂无死信归档" />
        <article v-for="row in list" :key="row.id" class="mobile-card">
          <div class="mobile-title">
            <div>
              <span class="sub-text">#{{ row.id }}</span>
              <strong>{{ row.messageType }}</strong>
            </div>
            <el-tag :type="statusInfo(row.status).tone" effect="light">
              {{ statusInfo(row.status).label }}
            </el-tag>
          </div>
          <div class="mobile-policy">
            <el-tag :type="policyInfo(row.replayPolicy).tone" effect="plain" size="small">
              {{ policyInfo(row.replayPolicy).label }}
            </el-tag>
            <span>出现 {{ row.occurrenceCount }} · 重放 {{ row.replayCount }}</span>
          </div>
          <p v-if="row.lastError" class="error-text">{{ row.lastError }}</p>
          <p v-else class="sub-text">最近错误：无</p>
          <div class="mobile-meta">
            <span>{{ row.queueName }}</span>
            <span>{{ formatTime(row.firstSeenTime) }}</span>
          </div>
          <div class="mobile-actions">
            <el-button plain @click="showDetail(row)">查看脱敏正文</el-button>
            <el-button
              v-if="canReplay(row)"
              type="primary"
              plain
              @click="openOperation(row, 'replay')"
            >
              受控重放
            </el-button>
            <el-button
              v-if="canResolve(row)"
              type="danger"
              plain
              @click="openOperation(row, 'resolve')"
            >
              人工处置
            </el-button>
          </div>
        </article>
      </div>

      <div class="cursor-pager">
        <span>第 {{ pageNumber }} 页</span>
        <el-button :disabled="loading || cursorHistory.length === 0" @click="previousPage">
          上一页
        </el-button>
        <el-button
          type="primary"
          plain
          :disabled="loading || nextCursor === null"
          @click="nextPage"
        >
          下一页
        </el-button>
      </div>
    </el-card>

    <el-drawer
      v-model="detailVisible"
      title="死信归档详情"
      size="min(680px, 94vw)"
      append-to-body
    >
      <template v-if="selected">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="归档 ID">{{ selected.id }}</el-descriptions-item>
          <el-descriptions-item label="消息类型">{{ selected.messageType }}</el-descriptions-item>
          <el-descriptions-item label="接收 Queue">{{ selected.queueName }}</el-descriptions-item>
          <el-descriptions-item label="消息 ID">
            <span class="mono break-all">{{ selected.messageId }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            {{ statusInfo(selected.status).label }} / {{ policyInfo(selected.replayPolicy).label }}
          </el-descriptions-item>
          <el-descriptions-item label="计数">
            DLQ 投递 {{ selected.dlqAttempts }}，出现 {{ selected.occurrenceCount }}，重放 {{ selected.replayCount }}
          </el-descriptions-item>
          <el-descriptions-item label="首次发现">{{ formatTime(selected.firstSeenTime) }}</el-descriptions-item>
          <el-descriptions-item label="正文摘要">
            <span class="mono break-all">SHA-256 {{ selected.bodySha256 }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="selected.replayReason" label="重放记录">
            Admin #{{ selected.replayRequestedBy }}：{{ selected.replayReason }}
          </el-descriptions-item>
          <el-descriptions-item v-if="selected.resolutionReason" label="处置记录">
            Admin #{{ selected.resolvedBy }}：{{ selected.resolutionReason }}
          </el-descriptions-item>
        </el-descriptions>

        <section class="payload-section">
          <div class="payload-heading">
            <strong>脱敏后的归档正文</strong>
            <el-tag type="warning" effect="plain">不代表可安全重放</el-tag>
          </div>
          <pre>{{ prettyBody(selected.body) }}</pre>
        </section>
      </template>
    </el-drawer>

    <el-dialog
      v-model="operationVisible"
      :title="operationKind === 'replay' ? '受控重放死信' : '人工处置死信'"
      width="min(560px, 92vw)"
      append-to-body
      :close-on-click-modal="false"
      @closed="resetOperation"
    >
      <template v-if="operationRow">
        <el-alert
          :type="operationKind === 'replay' ? 'warning' : 'error'"
          :title="operationKind === 'replay' ? '确认故障根因已修复，并接受 Queue 至少一次投递' : '处置不会重新执行消息，必须说明人工核对结果'"
          :closable="false"
          show-icon
        />
        <div class="operation-target">
          <strong>#{{ operationRow.id }} {{ operationRow.messageType }}</strong>
          <span class="mono">{{ operationRow.messageId }}</span>
        </div>
        <el-form label-position="top">
          <el-form-item :label="operationKind === 'replay' ? '重放原因' : '处置说明'" required>
            <el-input
              v-model="operationReason"
              type="textarea"
              :rows="4"
              maxlength="500"
              show-word-limit
              placeholder="至少 8 个可见字符，说明故障修复或人工核对依据"
            />
            <div v-if="operationReason && !validReason" class="reason-error">
              请输入 8～500 个可见字符，不能包含控制字符
            </div>
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button :disabled="operationLoading" @click="operationVisible = false">取消</el-button>
        <el-button
          :type="operationKind === 'replay' ? 'primary' : 'danger'"
          :loading="operationLoading"
          :disabled="!validReason"
          @click="submitOperation"
        >
          {{ operationKind === "replay" ? "确认重放" : "确认处置" }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  apiAdminQueueDeadLetterList,
  apiAdminQueueDeadLetterReplay,
  apiAdminQueueDeadLetterResolve,
  type QueueDeadLetterAlertSummary,
  type QueueDeadLetterItem,
  type QueueDeadLetterReplayPolicy,
  type QueueDeadLetterStatus,
} from "@/api/operations";

const statusOptions: Array<{ label: string; value: QueueDeadLetterStatus }> = [
  { label: "待处理", value: "OPEN" },
  { label: "重放中", value: "REPLAYING" },
  { label: "已重放", value: "REPLAYED" },
  { label: "已处置", value: "RESOLVED" },
];

const emptyAlert: QueueDeadLetterAlertSummary = {
  openCount: 0,
  replayingCount: 0,
  blockedCount: 0,
  oldestOpenTime: 0,
};

const list = ref<QueueDeadLetterItem[]>([]);
const alert = ref<QueueDeadLetterAlertSummary>({ ...emptyAlert });
const loading = ref(false);
const status = ref<QueueDeadLetterStatus | "">("");
const messageType = ref("");
const currentCursor = ref<number | undefined>();
const nextCursor = ref<number | null>(null);
const cursorHistory = ref<Array<number | undefined>>([]);
const detailVisible = ref(false);
const selected = ref<QueueDeadLetterItem | null>(null);
const operationVisible = ref(false);
const operationRow = ref<QueueDeadLetterItem | null>(null);
const operationKind = ref<"replay" | "resolve">("replay");
const operationReason = ref("");
const operationLoading = ref(false);

const pageNumber = computed(() => cursorHistory.value.length + 1);
const validReason = computed(() => {
  const reason = operationReason.value.trim();
  const length = [...reason].length;
  return length >= 8 && length <= 500 && !/[\u0000-\u001f\u007f]/.test(reason);
});

function statusInfo(value: QueueDeadLetterStatus): {
  label: string;
  tone: "success" | "warning" | "danger" | "primary" | "info";
} {
  if (value === "OPEN") return { label: "待处理", tone: "danger" };
  if (value === "REPLAYING") return { label: "重放中", tone: "warning" };
  if (value === "REPLAYED") return { label: "已重放", tone: "success" };
  return { label: "已处置", tone: "info" };
}

function policyInfo(value: QueueDeadLetterReplayPolicy): {
  label: string;
  tone: "success" | "warning" | "danger" | "info";
} {
  if (value === "ALLOW") return { label: "允许重放", tone: "success" };
  if (value === "BLOCK_SENSITIVE") return { label: "敏感消息", tone: "danger" };
  return { label: "类型不支持", tone: "warning" };
}

function canReplay(row: QueueDeadLetterItem) {
  return row.status === "OPEN" && row.replayPolicy === "ALLOW";
}

function canResolve(row: QueueDeadLetterItem) {
  return row.status === "OPEN";
}

function formatTime(timestamp: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false });
}

function prettyBody(body: unknown) {
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return "[归档正文无法序列化]";
  }
}

async function load() {
  loading.value = true;
  try {
    const result = await apiAdminQueueDeadLetterList({
      status: status.value || undefined,
      message_type: messageType.value || undefined,
      after_id: currentCursor.value,
      limit: 20,
    });
    list.value = result.list;
    nextCursor.value = result.nextAfterId;
    alert.value = result.alert;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "死信归档加载失败");
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

function showDetail(row: QueueDeadLetterItem) {
  selected.value = row;
  detailVisible.value = true;
}

function openOperation(row: QueueDeadLetterItem, kind: "replay" | "resolve") {
  operationRow.value = row;
  operationKind.value = kind;
  operationReason.value = "";
  operationVisible.value = true;
}

function resetOperation() {
  operationRow.value = null;
  operationReason.value = "";
  operationLoading.value = false;
}

async function submitOperation() {
  const row = operationRow.value;
  if (!row || !validReason.value || operationLoading.value) return;
  operationLoading.value = true;
  try {
    if (operationKind.value === "replay") {
      await apiAdminQueueDeadLetterReplay(row.id, operationReason.value.trim());
      ElMessage.success("死信已受控重放并重新进入业务 Queue");
    } else {
      await apiAdminQueueDeadLetterResolve(row.id, operationReason.value.trim());
      ElMessage.success("死信已记录人工处置结果");
    }
    operationVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "死信操作失败");
  } finally {
    operationLoading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.dead-letter-panel { display: grid; gap: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.summary-grid span { color: #7a8495; font-size: 13px; }
.summary-grid strong { display: block; margin-top: 10px; color: #172b4d; font-size: 26px; font-variant-numeric: tabular-nums; }
.summary-grid .danger, .error-text { color: #d93026; }
.summary-grid .warning { color: #d07a12; }
.summary-grid .primary { color: #2f6fed; }
.summary-grid .oldest-time { font-size: 15px; line-height: 1.7; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.card-header p { margin: 6px 0 0; color: #8a94a5; font-size: 12px; font-weight: 400; }
.filters { display: flex; align-items: center; gap: 10px; }
.filters .el-select { width: 140px; }
.filters .el-input { width: 220px; }
.sub-text { margin-top: 5px; color: #8a94a5; font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.message-id { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.policy-line { margin-top: 8px; }
.error-text { line-height: 1.5; overflow-wrap: anywhere; }
.row-actions { display: flex; flex-wrap: wrap; }
.cursor-pager { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 18px; color: #7a8495; font-size: 13px; }
.mobile-list { display: none; }
.break-all { overflow-wrap: anywhere; word-break: break-all; }
.payload-section { margin-top: 22px; }
.payload-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.payload-section pre { max-height: 420px; margin: 0; padding: 16px; overflow: auto; border: 1px solid #e2e7ef; border-radius: 8px; background: #f7f9fc; color: #26364d; font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.operation-target { display: grid; gap: 6px; margin: 18px 0; padding: 12px; border-radius: 8px; background: #f7f9fc; }
.operation-target span { overflow-wrap: anywhere; color: #7a8495; font-size: 12px; }
.reason-error { margin-top: 6px; color: #d93026; font-size: 12px; }

@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .card-header { align-items: flex-start; flex-direction: column; }
}

@media (max-width: 767px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .summary-grid :deep(.el-card__body) { padding: 14px; }
  .summary-grid strong { font-size: 22px; }
  .summary-grid .oldest-time { font-size: 12px; }
  .filters { width: 100%; align-items: stretch; flex-direction: column; }
  .filters .el-select, .filters .el-input, .filters .el-button { width: 100%; }
  .desktop-table { display: none; }
  .mobile-list { display: grid; gap: 12px; min-height: 80px; }
  .mobile-card { padding: 14px; border: 1px solid #e2e7ef; border-radius: 10px; background: #fff; }
  .mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .mobile-title > div { display: grid; min-width: 0; gap: 4px; }
  .mobile-title strong { overflow-wrap: anywhere; }
  .mobile-policy { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; color: #7a8495; font-size: 12px; }
  .mobile-card .error-text { margin: 12px 0 0; }
  .mobile-meta { display: grid; gap: 4px; margin-top: 12px; color: #8a94a5; font-size: 12px; overflow-wrap: anywhere; }
  .mobile-actions { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 14px; }
  .mobile-actions .el-button { width: 100%; margin-left: 0; }
  .cursor-pager { justify-content: space-between; }
}
</style>
