<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  applyExtract,
  getExtracts,
  getFinanceFlows,
  getFinanceInfo,
  getFinanceSummary,
  updateFinanceInfo,
} from "@/api/supplier";
import type { FinanceFlow, FinanceInfo, FinanceSummary, SupplierExtract } from "@/types";
import { formatMoney, formatTime, payType } from "@/utils/format";

const loading = ref(false);
const activeTab = ref("flows");
const summary = ref<FinanceSummary>({
  available: "0.00",
  pending_settlement: "0.00",
  total_income: "0.00",
  total_refund: "0.00",
  pending_extract: "0.00",
  paid_extract: "0.00",
});
const financeInfo = reactive<FinanceInfo>({
  bank_code: "",
  bank_address: "",
  alipay_account: "",
  alipay_qrcode_url: "",
  wechat: "",
  wechat_qrcode_url: "",
});
const flows = ref<FinanceFlow[]>([]);
const flowTotal = ref(0);
const flowFilters = reactive({ page: 1, limit: 20, keyword: "", type: "" });
const extracts = ref<SupplierExtract[]>([]);
const extractTotal = ref(0);
const extractFilters = reactive({ page: 1, limit: 20, status: "", pay_status: "", extract_type: "" });
const extractDialogOpen = ref(false);
const extractSubmitting = ref(false);
const extractForm = reactive({ extract_type: "bank", money: "", mark: "" });
const infoSaving = ref(false);

function flowType(type: number) {
  return type === 1 ? "支付订单" : type === 2 ? "退款订单" : "其他";
}

function flowState(row: FinanceFlow) {
  if (row.status === -1) return { label: "无效", tone: "danger" };
  if (row.status === 0) return { label: "待结算", tone: "warning" };
  return { label: "已结算", tone: "success" };
}

function extractState(row: SupplierExtract) {
  if (row.status === -1) return { label: "已拒绝", tone: "danger" };
  if (row.status === 0) return { label: "审核中", tone: "warning" };
  if (row.payStatus === 1) return { label: "已转账", tone: "success" };
  return { label: "待转账", tone: "primary" };
}

function extractType(type: string) {
  return type === "bank" ? "银行卡" : type === "alipay" ? "支付宝" : type === "weixin" ? "微信" : type;
}

async function loadSummaryAndInfo() {
  const [summaryData, infoData] = await Promise.all([getFinanceSummary(), getFinanceInfo()]);
  summary.value = summaryData;
  Object.assign(financeInfo, infoData);
}

async function loadFlows() {
  const result = await getFinanceFlows(flowFilters);
  flows.value = result.list;
  flowTotal.value = result.count;
}

async function loadExtracts() {
  const result = await getExtracts(extractFilters);
  extracts.value = result.list;
  extractTotal.value = result.count;
  summary.value = result.extract_statistics;
}

async function loadAll() {
  loading.value = true;
  try {
    await Promise.all([loadSummaryAndInfo(), loadFlows(), loadExtracts()]);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "财务数据加载失败");
  } finally {
    loading.value = false;
  }
}

async function saveFinanceInfo() {
  infoSaving.value = true;
  try {
    await updateFinanceInfo({ ...financeInfo });
    ElMessage.success("收款信息已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "收款信息保存失败");
  } finally {
    infoSaving.value = false;
  }
}

function openExtractDialog() {
  extractForm.extract_type = "bank";
  extractForm.money = "";
  extractForm.mark = "";
  extractDialogOpen.value = true;
}

async function submitExtract() {
  if (!/^\d+(?:\.\d{1,2})?$/.test(extractForm.money) || Number(extractForm.money) <= 0) {
    ElMessage.warning("请输入正确的提现金额");
    return;
  }
  extractSubmitting.value = true;
  try {
    await applyExtract(extractForm.extract_type, extractForm.money, extractForm.mark);
    extractDialogOpen.value = false;
    await Promise.all([loadExtracts(), loadSummaryAndInfo()]);
    ElMessage.success("提现申请已提交");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "提现申请失败");
  } finally {
    extractSubmitting.value = false;
  }
}

onMounted(loadAll);
</script>

<template>
  <section v-loading="loading" class="page-section finance-page">
    <header class="page-heading finance-heading">
      <div><h1>财务结算</h1><p>订单收货后进入可提现余额，退款和提现申请均保留独立流水</p></div>
      <el-button type="primary" @click="openExtractDialog">申请提现</el-button>
    </header>

    <div class="finance-summary-grid" aria-label="供应商财务指标">
      <article class="surface"><span>可提现余额</span><strong>{{ formatMoney(summary.available) }}</strong></article>
      <article class="surface"><span>待结算</span><strong>{{ formatMoney(summary.pending_settlement) }}</strong></article>
      <article class="surface"><span>累计结算收入</span><strong>{{ formatMoney(summary.total_income) }}</strong></article>
      <article class="surface"><span>累计退款</span><strong class="danger-value">{{ formatMoney(summary.total_refund) }}</strong></article>
      <article class="surface"><span>审核中提现</span><strong>{{ formatMoney(summary.pending_extract) }}</strong></article>
    </div>

    <div class="surface finance-tabs-surface">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="资金流水" name="flows">
          <div class="filter-row finance-filter-row">
            <el-input v-model="flowFilters.keyword" class="search-input" clearable placeholder="交易单号或关联订单" @keyup.enter="loadFlows" />
            <el-select v-model="flowFilters.type" class="state-select" clearable placeholder="交易类型" @change="loadFlows">
              <el-option label="支付订单" value="1" /><el-option label="退款订单" value="2" />
            </el-select>
            <el-button type="primary" @click="loadFlows">查询</el-button>
          </div>
          <el-table :data="flows" row-key="id">
            <el-table-column prop="orderId" label="交易单号" min-width="190" />
            <el-table-column prop="linkId" label="关联订单" min-width="180" />
            <el-table-column label="类型" width="110"><template #default="scope">{{ flowType(scope.row.type) }}</template></el-table-column>
            <el-table-column label="支付方式" width="110"><template #default="scope">{{ payType(scope.row.payType) }}</template></el-table-column>
            <el-table-column label="金额" width="130"><template #default="scope"><strong :class="scope.row.pm === 0 ? 'danger-value' : 'income-value'">{{ scope.row.pm === 0 ? "-" : "+" }}{{ formatMoney(scope.row.number) }}</strong></template></el-table-column>
            <el-table-column label="状态" width="110"><template #default="scope"><span class="status-text" :class="flowState(scope.row).tone">{{ flowState(scope.row).label }}</span></template></el-table-column>
            <el-table-column label="交易时间" width="180"><template #default="scope">{{ formatTime(scope.row.tradeTime) }}</template></el-table-column>
          </el-table>
          <div class="pagination-row"><span>共 {{ flowTotal }} 条流水</span><el-pagination v-model:current-page="flowFilters.page" :page-size="flowFilters.limit" :total="flowTotal" layout="prev, pager, next" @current-change="loadFlows" /></div>
        </el-tab-pane>

        <el-tab-pane label="提现记录" name="extracts">
          <div class="filter-row finance-filter-row">
            <el-select v-model="extractFilters.extract_type" class="state-select" clearable placeholder="提现方式" @change="loadExtracts">
              <el-option label="银行卡" value="bank" /><el-option label="支付宝" value="alipay" /><el-option label="微信" value="weixin" />
            </el-select>
            <el-select v-model="extractFilters.status" class="state-select" clearable placeholder="审核状态" @change="loadExtracts">
              <el-option label="已拒绝" value="-1" /><el-option label="审核中" value="0" /><el-option label="已通过" value="1" />
            </el-select>
          </div>
          <el-table :data="extracts" row-key="id">
            <el-table-column prop="id" label="申请编号" width="110" />
            <el-table-column label="提现方式" width="120"><template #default="scope">{{ extractType(scope.row.extractType) }}</template></el-table-column>
            <el-table-column label="提现金额" width="150"><template #default="scope"><strong>{{ formatMoney(scope.row.extractPrice) }}</strong></template></el-table-column>
            <el-table-column label="状态" width="120"><template #default="scope"><span class="status-text" :class="extractState(scope.row).tone">{{ extractState(scope.row).label }}</span></template></el-table-column>
            <el-table-column prop="supplierMark" label="供应商备注" min-width="180" />
            <el-table-column prop="failMsg" label="拒绝原因" min-width="180" />
            <el-table-column label="申请时间" width="180"><template #default="scope">{{ formatTime(scope.row.addTime) }}</template></el-table-column>
          </el-table>
          <div class="pagination-row"><span>共 {{ extractTotal }} 条申请</span><el-pagination v-model:current-page="extractFilters.page" :page-size="extractFilters.limit" :total="extractTotal" layout="prev, pager, next" @current-change="loadExtracts" /></div>
        </el-tab-pane>

        <el-tab-pane label="收款设置" name="settings">
          <div class="finance-settings">
            <section><h2>银行卡</h2><el-form label-position="top"><el-form-item label="银行卡号"><el-input v-model="financeInfo.bank_code" maxlength="32" /></el-form-item><el-form-item label="开户行"><el-input v-model="financeInfo.bank_address" maxlength="256" /></el-form-item></el-form></section>
            <section><h2>支付宝</h2><el-form label-position="top"><el-form-item label="支付宝账号"><el-input v-model="financeInfo.alipay_account" maxlength="64" /></el-form-item><el-form-item label="二维码地址"><el-input v-model="financeInfo.alipay_qrcode_url" maxlength="255" /></el-form-item></el-form></section>
            <section><h2>微信</h2><el-form label-position="top"><el-form-item label="微信号"><el-input v-model="financeInfo.wechat" maxlength="15" /></el-form-item><el-form-item label="二维码地址"><el-input v-model="financeInfo.wechat_qrcode_url" maxlength="255" /></el-form-item></el-form></section>
          </div>
          <div class="finance-settings-actions"><el-button type="primary" :loading="infoSaving" @click="saveFinanceInfo">保存收款信息</el-button></div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="extractDialogOpen" title="申请提现" width="min(480px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="提现方式"><el-select v-model="extractForm.extract_type" style="width:100%"><el-option label="银行卡" value="bank" /><el-option label="支付宝" value="alipay" /><el-option label="微信" value="weixin" /></el-select></el-form-item>
        <el-form-item label="提现金额"><el-input v-model="extractForm.money" inputmode="decimal" placeholder="0.00"><template #prefix>¥</template></el-input></el-form-item>
        <el-form-item label="备注"><el-input v-model="extractForm.mark" type="textarea" :rows="3" maxlength="512" show-word-limit /></el-form-item>
      </el-form>
      <p class="security-note">申请提交后即预占可提现余额；审核拒绝后金额自动释放。</p>
      <template #footer><el-button @click="extractDialogOpen = false">取消</el-button><el-button type="primary" :loading="extractSubmitting" @click="submitExtract">提交申请</el-button></template>
    </el-dialog>
  </section>
</template>
