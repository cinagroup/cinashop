<template>
  <div class="extract-list">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>提现审核</span>
          <el-radio-group v-model="statusFilter" size="small" @change="load(1)">
            <el-radio-button :value="undefined">全部</el-radio-button>
            <el-radio-button :value="0">待审核</el-radio-button>
            <el-radio-button :value="1">已通过</el-radio-button>
            <el-radio-button :value="2">已拒绝</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="用户" width="130">
          <template #default="{ row }">
            <div>{{ row.nickname || row.account || `用户#${row.uid}` }}</div>
          </template>
        </el-table-column>
        <el-table-column label="提现方式" width="110">
          <template #default="{ row }">{{ typeText(row.extractType) }}</template>
        </el-table-column>
        <el-table-column label="收款信息" min-width="200">
          <template #default="{ row }">
            <div>{{ row.bankName }} · {{ row.realName }}</div>
            <div class="sub-text">{{ row.extractNumber }}</div>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="110">
          <template #default="{ row }">
            <span class="price">¥{{ row.extractPrice }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="申请时间" width="160">
          <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 0">
              <el-button type="success" size="small" @click="audit(row, 1)">通过</el-button>
              <el-button type="danger" size="small" @click="openReject(row)">拒绝</el-button>
            </template>
            <span v-else-if="row.status === 2" class="sub-text">{{ row.failMsg || "已拒绝" }}</span>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pager"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="20"
        :current-page="page"
        @current-change="load"
      />
    </el-card>

    <!-- 拒绝弹窗 -->
    <el-dialog v-model="rejectVisible" title="拒绝提现" width="420px">
      <el-form label-width="90px">
        <el-form-item label="拒绝原因">
          <el-input
            v-model="rejectReason"
            type="textarea"
            :rows="3"
            placeholder="请填写拒绝原因（将展示给用户）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" @click="confirmReject">确认拒绝</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminExtractList,
  apiAdminExtractStatus,
  type ExtractItem,
} from "@/api/finance";

const list = ref<ExtractItem[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const statusFilter = ref<number | undefined>(undefined);
const rejectVisible = ref(false);
const rejectReason = ref("");
const currentRow = ref<ExtractItem | null>(null);

function typeText(t: string) {
  return { bank: "银行卡", alipay: "支付宝", weixin: "微信" }[t] || t || "银行";
}

function statusText(s: number) {
  return { 0: "待审核", 1: "已通过", 2: "已拒绝" }[s] || "未知";
}

function statusTagType(s: number) {
  return { 0: "warning", 1: "success", 2: "danger" }[s] || "info";
}

function formatTime(ts: number) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const result = await apiAdminExtractList({
      status: statusFilter.value,
      page: p,
      limit: 20,
    });
    list.value = result.list;
    total.value = result.total;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function audit(row: ExtractItem, status: number) {
  try {
    await ElMessageBox.confirm(
      `确认通过用户「${row.nickname || row.account || row.uid}」的 ¥${row.extractPrice} 提现申请？`,
      "提现审核",
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await apiAdminExtractStatus(row.id, { status });
    ElMessage.success("已通过");
    load(page.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "操作失败");
  }
}

function openReject(row: ExtractItem) {
  currentRow.value = row;
  rejectReason.value = "";
  rejectVisible.value = true;
}

async function confirmReject() {
  if (!currentRow.value) return;
  try {
    await apiAdminExtractStatus(currentRow.value.id, {
      status: 2,
      fail_msg: rejectReason.value || "审核拒绝",
    });
    ElMessage.success("已拒绝");
    rejectVisible.value = false;
    load(page.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "操作失败");
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.price {
  color: #e93323;
  font-weight: 600;
}

.sub-text {
  color: #999;
  font-size: 12px;
}

.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
