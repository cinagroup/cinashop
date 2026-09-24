<template>
  <div class="capital-flow-page">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div>
            <strong>平台资金流水</strong>
            <div class="subtitle">订单收付款记录；用户余额明细请查看财务流水。</div>
          </div>
          <el-button :loading="loading" @click="load(page)">刷新</el-button>
        </div>
      </template>

      <div class="filters">
        <label class="filter-field">
          <span>交易类型</span>
          <el-select v-model="tradingType" aria-label="交易类型" @change="search">
            <el-option label="全部类型" :value="0" />
            <el-option
              v-for="(name, index) in typeOptions.slice(1)"
              :key="index"
              :label="name"
              :value="index + 1"
            />
          </el-select>
        </label>
        <label class="filter-field">
          <span>订单搜索</span>
          <el-input
            v-model="keywords"
            aria-label="订单号、昵称、电话或用户 ID"
            maxlength="100"
            clearable
            placeholder="订单号 / 昵称 / 电话 / 用户 ID"
            @keyup.enter="search"
          />
        </label>
        <label class="filter-field time-field">
          <span>创建时间（北京时间）</span>
          <el-date-picker
            v-model="timeRange"
            type="datetimerange"
            aria-label="创建时间范围"
            format="YYYY/MM/DD HH:mm"
            value-format="YYYY-MM-DD HH:mm"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            range-separator="至"
            clearable
          />
        </label>
        <div class="filter-actions">
          <el-button type="primary" :loading="loading" @click="search">查询</el-button>
          <el-button :disabled="loading" @click="reset">重置</el-button>
        </div>
      </div>

      <div class="table-scroll">
        <el-table :data="list" v-loading="loading" stripe empty-text="暂无资金流水">
          <el-table-column prop="flow_id" label="交易单号" min-width="170" />
          <el-table-column prop="order_id" label="关联订单" min-width="165" />
          <el-table-column label="交易金额" min-width="110">
            <template #default="{ row }">
              <span :class="Number(row.price) < 0 ? 'outflow' : 'inflow'">¥{{ row.price }}</span>
            </template>
          </el-table-column>
          <el-table-column label="交易用户" min-width="145">
            <template #default="{ row }">
              <div>{{ row.uid ? row.nickname || `用户 #${row.uid}` : "游客" }}</div>
              <div v-if="row.phone" class="sub-text">{{ row.phone }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="add_time" label="交易时间" min-width="170" />
          <el-table-column prop="trading_type" label="交易类型" min-width="120" />
          <el-table-column prop="pay_type" label="支付方式" min-width="105" />
          <el-table-column label="备注" min-width="175" show-overflow-tooltip>
            <template #default="{ row }">{{ row.mark || "—" }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="105" fixed="right">
            <template #default="{ row }">
              <el-button v-if="canManage" link type="primary" @click="openRemark(row)">备注</el-button>
              <span v-else class="sub-text">仅查看</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-pagination
        class="pager"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="20"
        :current-page="page"
        @current-change="load"
      />
    </el-card>

    <el-dialog
      v-model="remarkVisible"
      title="修改资金流水备注"
      width="min(440px, calc(100vw - 32px))"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <p v-if="editingRow" class="dialog-context">交易单号：{{ editingRow.flow_id }}</p>
      <el-input
        v-model="remarkDraft"
        type="textarea"
        :rows="4"
        maxlength="200"
        show-word-limit
        aria-label="资金流水备注"
        placeholder="请输入备注（最多 200 字）"
      />
      <template #footer>
        <el-button :disabled="saving" @click="remarkVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveRemark">保存备注</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import {
  apiAdminCapitalFlowList,
  apiAdminCapitalFlowSetMark,
  type CapitalFlowItem,
} from "@/api/finance";
import { capitalFlowRange } from "./capitalFlowRange";

const auth = useAuthStore();
const canManage = computed(() => auth.userInfo?.level === 0 || auth.uniqueAuth.includes("capital_flow.manage"));
const list = ref<CapitalFlowItem[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const typeOptions = ref<string[]>([]);
const tradingType = ref(0);
const keywords = ref("");
const timeRange = ref<string[] | null>(null);
const remarkVisible = ref(false);
const editingRow = ref<CapitalFlowItem | null>(null);
const remarkDraft = ref("");
const saving = ref(false);
let loadGeneration = 0;

async function load(targetPage = 1): Promise<boolean> {
  const generation = ++loadGeneration;
  let range: { start?: number; stop?: number };
  try {
    if (keywords.value.length > 100 || /[\u0000-\u001f\u007f]/.test(keywords.value)) {
      throw new Error("搜索内容不能超过 100 字且不能含控制字符");
    }
    range = capitalFlowRange(timeRange.value);
  } catch (error) {
    loading.value = false;
    ElMessage.error(error instanceof Error ? error.message : "时间范围无效");
    return false;
  }
  loading.value = true;
  try {
    const result = await apiAdminCapitalFlowList({
      trading_type: tradingType.value || undefined,
      keywords: keywords.value.trim() || undefined,
      ...range,
      page: targetPage,
      limit: 20,
    });
    if (generation !== loadGeneration) return false;
    list.value = result.list;
    total.value = result.count;
    typeOptions.value = result.status;
    page.value = targetPage;
    return true;
  } catch (error) {
    if (generation === loadGeneration) ElMessage.error(error instanceof Error ? error.message : "加载资金流水失败");
    return false;
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function search() {
  void load(1);
}

function reset() {
  tradingType.value = 0;
  keywords.value = "";
  timeRange.value = null;
  void load(1);
}

function openRemark(row: CapitalFlowItem) {
  if (!canManage.value) return;
  editingRow.value = row;
  remarkDraft.value = row.mark ?? "";
  remarkVisible.value = true;
}

async function saveRemark() {
  const row = editingRow.value;
  if (!row || !canManage.value || saving.value) return;
  if (remarkDraft.value.length > 200) {
    ElMessage.error("备注不能超过 200 字");
    return;
  }
  saving.value = true;
  try {
    const committed = await apiAdminCapitalFlowSetMark(row.id, remarkDraft.value);
    if (committed.id !== row.id || typeof committed.mark !== "string") {
      throw new Error("备注保存结果与当前流水不一致");
    }
    const visibleRow = list.value.find((item) => item.id === committed.id);
    if (visibleRow) visibleRow.mark = committed.mark;
    remarkVisible.value = false;
    if (await load(page.value)) ElMessage.success("备注已保存");
    else ElMessage.warning("备注已提交，列表刷新失败，请手动刷新核对");
  } catch (error) {
    ElMessage.error(`${error instanceof Error ? error.message : "保存备注失败"}；请刷新列表核对后再重试`);
  } finally {
    saving.value = false;
  }
}

onMounted(() => { void load(1); });
</script>

<style scoped>
.capital-flow-page { min-width: 0; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.subtitle, .sub-text, .dialog-context { color: #737985; font-size: 12px; }
.subtitle { margin-top: 4px; }
.filters { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.filter-field { display: flex; flex: 1 1 180px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.time-field { flex-basis: 330px; }
.filter-field :deep(.el-select), .filter-field :deep(.el-input), .filter-field :deep(.el-date-editor) { width: 100%; }
.filter-actions { display: flex; gap: 8px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.pager { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; }
.inflow { color: #d74732; font-weight: 600; }
.outflow { color: #32936d; font-weight: 600; }
.dialog-context { margin: 0 0 12px; overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .filters { display: grid; grid-template-columns: minmax(0, 1fr); }
  .filter-actions { justify-content: flex-start; }
  .pager { justify-content: center; }
}
</style>
