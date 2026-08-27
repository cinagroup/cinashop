<template>
  <div class="supplier-extract-page">
    <div class="summary-grid">
      <el-card shadow="never"><span>待审核金额</span><strong>¥{{ statistics.pending_review }}</strong></el-card>
      <el-card shadow="never"><span>待转账金额</span><strong>¥{{ statistics.pending_transfer }}</strong></el-card>
      <el-card shadow="never"><span>累计已转账</span><strong class="success">¥{{ statistics.paid }}</strong></el-card>
      <el-card shadow="never"><span>已拒绝金额</span><strong class="danger">¥{{ statistics.rejected }}</strong></el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div><strong>供应商提现</strong><p>审核和实际转账分为两个独立、可审计步骤</p></div>
          <el-radio-group v-model="stage" size="small" @change="load(1)">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="review">待审核</el-radio-button>
            <el-radio-button value="transfer">待转账</el-radio-button>
            <el-radio-button value="paid">已转账</el-radio-button>
            <el-radio-button value="rejected">已拒绝</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <div class="filters">
        <el-input v-model="keyword" clearable placeholder="申请编号、供应商、联系人或手机号" @keyup.enter="load(1)" />
        <el-select v-model="extractType" clearable placeholder="提现方式" @change="load(1)">
          <el-option label="银行卡" value="bank" />
          <el-option label="支付宝" value="alipay" />
          <el-option label="微信" value="weixin" />
        </el-select>
        <el-button type="primary" @click="load(1)">查询</el-button>
      </div>

      <el-table :data="list" v-loading="loading" stripe row-key="id">
        <el-table-column prop="id" label="申请编号" width="100" />
        <el-table-column label="供应商" min-width="190">
          <template #default="{ row }"><strong>{{ row.supplierName }}</strong><div class="sub-text">{{ row.contactName }} · {{ row.phone }}</div></template>
        </el-table-column>
        <el-table-column label="收款信息" min-width="230">
          <template #default="{ row }"><div>{{ typeText(row.extractType) }}</div><div class="sub-text recipient">{{ recipientText(row) }}</div><el-link v-if="row.qrcodeUrl" :href="row.qrcodeUrl" target="_blank" type="primary">查看收款码</el-link></template>
        </el-table-column>
        <el-table-column label="提现金额" width="130"><template #default="{ row }"><span class="price">¥{{ row.extractPrice }}</span><div class="sub-text">申请后余额 ¥{{ row.balance }}</div></template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag :type="statusInfo(row).tone">{{ statusInfo(row).label }}</el-tag></template></el-table-column>
        <el-table-column label="申请说明" min-width="150"><template #default="{ row }">{{ row.supplierMark || "-" }}</template></el-table-column>
        <el-table-column label="处理信息" min-width="180"><template #default="{ row }"><div>{{ row.adminName || "-" }}</div><div v-if="row.failMsg" class="sub-text danger">{{ row.failMsg }}</div><div v-else-if="row.voucherTitle" class="sub-text">{{ row.voucherTitle }}</div></template></el-table-column>
        <el-table-column label="申请时间" width="165"><template #default="{ row }">{{ formatTime(row.addTime) }}</template></el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 0">
              <el-button type="success" size="small" @click="approve(row)">通过</el-button>
              <el-button type="danger" size="small" plain @click="openReject(row)">拒绝</el-button>
            </template>
            <el-button v-else-if="row.status === 1 && row.payStatus === 0" type="primary" size="small" @click="openTransfer(row)">登记转账</el-button>
            <el-link v-else-if="row.payStatus === 1 && row.voucherImage" :href="row.voucherImage" target="_blank" type="primary">查看凭证</el-link>
            <span v-else class="sub-text">无需操作</span>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="20" :current-page="page" @current-change="load" />
    </el-card>

    <el-dialog v-model="rejectVisible" title="拒绝供应商提现" width="440px">
      <p class="dialog-note">拒绝后该金额会立即从预占提现中释放，重新计入供应商可提现余额。</p>
      <el-input v-model="rejectReason" type="textarea" :rows="4" maxlength="128" show-word-limit placeholder="请填写供应商可见的拒绝原因" />
      <template #footer><el-button @click="rejectVisible = false">取消</el-button><el-button type="danger" :loading="submitting" @click="confirmReject">确认拒绝</el-button></template>
    </el-dialog>

    <el-dialog v-model="transferVisible" title="登记实际转账" width="480px">
      <p class="dialog-note">请在银行或支付平台完成转账后再登记。系统不会自动发起资金划转。</p>
      <el-form label-position="top">
        <el-form-item label="转账说明"><el-input v-model="transferForm.voucher_title" maxlength="256" placeholder="例如：招商银行转账回单 20260809" /></el-form-item>
        <el-form-item label="凭证地址"><el-input v-model="transferForm.voucher_image" maxlength="256" placeholder="https://..." /></el-form-item>
      </el-form>
      <template #footer><el-button @click="transferVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="confirmTransfer">确认已转账</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminSupplierExtractList,
  apiAdminSupplierExtractReview,
  apiAdminSupplierExtractTransfer,
  type SupplierExtractItem,
  type SupplierExtractStatistics,
} from "@/api/finance";

const list = ref<SupplierExtractItem[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const submitting = ref(false);
const stage = ref("all");
const keyword = ref("");
const extractType = ref("");
const statistics = reactive<SupplierExtractStatistics>({ pending_review: "0.00", pending_transfer: "0.00", paid: "0.00", rejected: "0.00" });
const rejectVisible = ref(false);
const rejectReason = ref("");
const transferVisible = ref(false);
const current = ref<SupplierExtractItem | null>(null);
const transferForm = reactive({ voucher_title: "", voucher_image: "" });

function stageParams() {
  if (stage.value === "review") return { status: 0 };
  if (stage.value === "transfer") return { status: 1, pay_status: 0 };
  if (stage.value === "paid") return { status: 1, pay_status: 1 };
  if (stage.value === "rejected") return { status: -1 };
  return {};
}

function typeText(type: string) {
  return type === "bank" ? "银行卡" : type === "alipay" ? "支付宝" : type === "weixin" ? "微信" : type;
}

function recipientText(row: SupplierExtractItem) {
  if (row.extractType === "bank") return `${row.bankAddress} · ${row.bankCode}`;
  if (row.extractType === "alipay") return row.alipayAccount;
  return row.wechat;
}

function statusInfo(row: SupplierExtractItem): { label: string; tone: "success" | "warning" | "danger" | "primary" | "info" } {
  if (row.status === -1) return { label: "已拒绝", tone: "danger" };
  if (row.status === 0) return { label: "待审核", tone: "warning" };
  if (row.payStatus === 1) return { label: "已转账", tone: "success" };
  return { label: "待转账", tone: "primary" };
}

function formatTime(timestamp: number) {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false });
}

async function load(targetPage = 1) {
  loading.value = true;
  page.value = targetPage;
  try {
    const result = await apiAdminSupplierExtractList({ ...stageParams(), keyword: keyword.value, extract_type: extractType.value, page: targetPage, limit: 20 });
    list.value = result.list;
    total.value = result.count;
    Object.assign(statistics, result.extract_statistics);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "供应商提现加载失败");
  } finally {
    loading.value = false;
  }
}

async function approve(row: SupplierExtractItem) {
  try {
    await ElMessageBox.confirm(`确认通过「${row.supplierName}」的 ¥${row.extractPrice} 提现申请？通过后仍需单独登记实际转账。`, "审核供应商提现", { type: "warning", confirmButtonText: "审核通过", cancelButtonText: "取消" });
  } catch { return; }
  submitting.value = true;
  try {
    await apiAdminSupplierExtractReview(row.id, { type: 1 });
    await load(page.value);
    ElMessage.success("审核已通过，等待实际转账");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "审核失败");
  } finally { submitting.value = false; }
}

function openReject(row: SupplierExtractItem) {
  current.value = row;
  rejectReason.value = "";
  rejectVisible.value = true;
}

async function confirmReject() {
  if (!current.value || !rejectReason.value.trim()) { ElMessage.warning("请填写拒绝原因"); return; }
  submitting.value = true;
  try {
    await apiAdminSupplierExtractReview(current.value.id, { type: 0, message: rejectReason.value });
    rejectVisible.value = false;
    await load(page.value);
    ElMessage.success("已拒绝，预占余额已释放");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "拒绝失败");
  } finally { submitting.value = false; }
}

function openTransfer(row: SupplierExtractItem) {
  current.value = row;
  transferForm.voucher_title = "";
  transferForm.voucher_image = "";
  transferVisible.value = true;
}

async function confirmTransfer() {
  if (!current.value || !transferForm.voucher_title.trim() || !transferForm.voucher_image.trim()) { ElMessage.warning("请填写转账说明和凭证地址"); return; }
  submitting.value = true;
  try {
    await apiAdminSupplierExtractTransfer(current.value.id, { ...transferForm });
    transferVisible.value = false;
    await load(page.value);
    ElMessage.success("实际转账已登记");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "转账登记失败");
  } finally { submitting.value = false; }
}

onMounted(() => load(1));
</script>

<style scoped>
.supplier-extract-page { display: grid; gap: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.summary-grid span { color: #7a8495; font-size: 13px; }
.summary-grid strong { display: block; margin-top: 12px; color: #172b4d; font-size: 24px; font-variant-numeric: tabular-nums; }
.summary-grid strong.success { color: #13a468; }
.summary-grid strong.danger, .danger { color: #e93323; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.card-header p { margin: 6px 0 0; color: #8a94a5; font-size: 12px; font-weight: 400; }
.filters { display: flex; gap: 10px; margin-bottom: 16px; }
.filters .el-input { width: 320px; }
.filters .el-select { width: 150px; }
.price { color: #e93323; font-size: 15px; font-weight: 650; }
.sub-text { margin-top: 5px; color: #8a94a5; font-size: 12px; }
.recipient { overflow-wrap: anywhere; }
.pager { margin-top: 18px; justify-content: flex-end; }
.dialog-note { margin: 0 0 16px; padding: 10px 12px; border-left: 3px solid #e6a23c; color: #765c2f; background: #fff8e8; font-size: 12px; line-height: 1.6; }
@media (max-width: 1100px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .card-header { align-items: flex-start; flex-direction: column; } }
</style>
