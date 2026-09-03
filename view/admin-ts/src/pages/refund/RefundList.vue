<template>
  <div class="refund-list">
    <el-card shadow="never">
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column prop="orderId" label="退款单号" min-width="160" />
        <el-table-column label="退款类型" width="100">
          <template #default="{ row }">{{ applyTypeText(row.applyType) }}</template>
        </el-table-column>
        <el-table-column label="退款金额" width="110">
          <template #default="{ row }">¥{{ row.refundPrice }}</template>
        </el-table-column>
        <el-table-column prop="refundReason" label="退款原因" min-width="140" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusType(row.refundType)">{{ statusText(row.refundType) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="申请时间" width="160">
          <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <template v-if="row.refundType === 0">
              <el-button link type="success" @click="agree(row)">同意</el-button>
              <el-button link type="danger" @click="refuse(row)">拒绝</el-button>
            </template>
            <el-button link type="primary" @click="viewDetail(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 详情弹窗 -->
    <el-dialog v-model="detailDialog.show" title="退款详情" width="520px">
      <el-descriptions :column="2" border v-if="detailDialog.data">
        <el-descriptions-item label="退款单号">{{ detailDialog.data.orderId }}</el-descriptions-item>
        <el-descriptions-item label="退款金额">¥{{ detailDialog.data.refundPrice }}</el-descriptions-item>
        <el-descriptions-item label="退款类型">{{ applyTypeText(detailDialog.data.applyType) }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusType(detailDialog.data.refundType)">{{ statusText(detailDialog.data.refundType) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="退款原因">{{ detailDialog.data.refundReason }}</el-descriptions-item>
        <el-descriptions-item label="退款说明">{{ detailDialog.data.refundExplain || "-" }}</el-descriptions-item>
        <el-descriptions-item label="申请用户">UID: {{ detailDialog.data.uid }}</el-descriptions-item>
        <el-descriptions-item label="申请时间">{{ formatTime(detailDialog.data.addTime) }}</el-descriptions-item>
        <el-descriptions-item v-if="(detailDialog.data as any).refuseReason" label="拒绝原因">
          <span class="danger-text">{{ (detailDialog.data as any).refuseReason }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="(detailDialog.data as any).refundedPrice && Number((detailDialog.data as any).refundedPrice) > 0" label="已退款">
          ¥{{ (detailDialog.data as any).refundedPrice }}
        </el-descriptions-item>
        <template v-if="hasReturnContact(detailDialog.data)">
          <el-descriptions-item label="退货收货人">{{ detailDialog.data.returnContact?.name || "-" }}</el-descriptions-item>
          <el-descriptions-item label="退货电话">{{ detailDialog.data.returnContact?.phone || "-" }}</el-descriptions-item>
          <el-descriptions-item label="退货地址" :span="2">
            <span class="return-address">{{ detailDialog.data.returnContact?.address || "-" }}</span>
          </el-descriptions-item>
        </template>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminRefundList,
  apiAdminRefundDetail,
  apiAdminRefundAgree,
  apiAdminRefundRefuse,
  type AdminRefund,
} from "@/api/refund";
import dayjs from "dayjs";

const list = ref<AdminRefund[]>([]);
const loading = ref(false);
const detailDialog = reactive({ show: false, data: null as AdminRefund | null });

function applyTypeText(type: number): string {
  switch (type) {
    case 1: return "仅退款";
    case 2: return "退货退款";
    default: return `类型${type}`;
  }
}

function statusText(type: number): string {
  switch (type) {
    case 0: return "待处理";
    case 3: return "已拒绝";
    case 4: return "同意退货";
    case 5: return "已退货";
    case 6: return "已退款";
    default: return `状态${type}`;
  }
}

function statusType(type: number): "warning" | "danger" | "success" | "info" {
  switch (type) {
    case 0: return "warning";
    case 3: return "danger";
    case 6: return "success";
    default: return "info";
  }
}

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

function hasReturnContact(row: AdminRefund): boolean {
  const contact = row.returnContact;
  return Boolean(contact && (contact.name || contact.phone || contact.address));
}

async function fetch() {
  loading.value = true;
  try {
    list.value = await apiAdminRefundList();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

async function agree(row: AdminRefund) {
  try {
    await ElMessageBox.confirm(
      `确认同意退款 ¥${row.refundPrice} 给用户?`,
      "退款确认",
    );
  } catch {
    return;
  }
  try {
    await apiAdminRefundAgree(row.id);
    ElMessage.success("退款成功");
    fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "退款失败");
  }
}

async function refuse(row: AdminRefund) {
  try {
    const { value } = await ElMessageBox.prompt("请输入拒绝原因", "拒绝退款", {
      inputValue: "不满足退款条件",
    });
    await apiAdminRefundRefuse(row.id, value);
    ElMessage.success("已拒绝");
    fetch();
  } catch (e) {
    if (e !== "cancel") {
      ElMessage.error(e instanceof Error ? e.message : "操作失败");
    }
  }
}

async function viewDetail(row: AdminRefund) {
  detailDialog.show = true;
  try {
    detailDialog.data = await apiAdminRefundDetail(row.id);
  } catch {
    detailDialog.data = row;
  }
}

onMounted(fetch);
</script>
<style scoped>
.danger-text {
  color: #e64340;
}

.return-address {
  overflow-wrap: anywhere;
}
</style>
