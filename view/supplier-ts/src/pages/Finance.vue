<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  applyExtract,
  getFinanceInfo,
  getFinanceSummary,
  updateFinanceInfo,
} from "@/api/supplier";
import type { FinanceInfo, FinanceSummary } from "@/types";
import { useAuthStore } from "@/stores/auth";
import { formatMoney } from "@/utils/format";
import FinanceFlows from '@/pages/FinanceFlows.vue';
import FinanceExtracts from '@/pages/FinanceExtracts.vue';

const auth = useAuthStore();
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
const extractRefresh = ref(0);
const extractDialogOpen = ref(false);
const extractSubmitting = ref(false);
const extractForm = reactive({ extract_type: "bank", money: "", mark: "" });
const infoSaving = ref(false);
const canManageFinance = computed(() => auth.can("supplier.finance.manage"));

async function loadSummaryAndInfo() {
  const [summaryData, infoData] = await Promise.all([getFinanceSummary(), getFinanceInfo()]);
  summary.value = summaryData;
  Object.assign(financeInfo, infoData);
}

async function loadAll() {
  loading.value = true;
  try {
    await loadSummaryAndInfo();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "财务数据加载失败");
  } finally {
    loading.value = false;
  }
}

async function saveFinanceInfo() {
  if (!canManageFinance.value) return;
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
  if (!canManageFinance.value) return;
  extractForm.extract_type = "bank";
  extractForm.money = "";
  extractForm.mark = "";
  extractDialogOpen.value = true;
}

async function submitExtract() {
  if (!canManageFinance.value) return;
  if (!/^\d+(?:\.\d{1,2})?$/.test(extractForm.money) || Number(extractForm.money) <= 0) {
    ElMessage.warning("请输入正确的提现金额");
    return;
  }
  extractSubmitting.value = true;
  try {
    await applyExtract(extractForm.extract_type, extractForm.money, extractForm.mark);
    extractDialogOpen.value = false;
    extractRefresh.value++;
    await loadSummaryAndInfo();
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
      <el-button v-if="canManageFinance" type="primary" @click="openExtractDialog">申请提现</el-button>
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
          <FinanceFlows embedded />
        </el-tab-pane>

        <el-tab-pane label="提现记录" name="extracts">
          <FinanceExtracts v-if="activeTab === 'extracts'" embedded :refresh-key="extractRefresh" />
        </el-tab-pane>

        <el-tab-pane label="收款设置" name="settings">
          <div class="finance-settings">
            <section><h2>银行卡</h2><el-form label-position="top"><el-form-item label="银行卡号"><el-input v-model="financeInfo.bank_code" maxlength="32" :disabled="!canManageFinance" /></el-form-item><el-form-item label="开户行"><el-input v-model="financeInfo.bank_address" maxlength="256" :disabled="!canManageFinance" /></el-form-item></el-form></section>
            <section><h2>支付宝</h2><el-form label-position="top"><el-form-item label="支付宝账号"><el-input v-model="financeInfo.alipay_account" maxlength="64" :disabled="!canManageFinance" /></el-form-item><el-form-item label="二维码地址"><el-input v-model="financeInfo.alipay_qrcode_url" maxlength="255" :disabled="!canManageFinance" /></el-form-item></el-form></section>
            <section><h2>微信</h2><el-form label-position="top"><el-form-item label="微信号"><el-input v-model="financeInfo.wechat" maxlength="15" :disabled="!canManageFinance" /></el-form-item><el-form-item label="二维码地址"><el-input v-model="financeInfo.wechat_qrcode_url" maxlength="255" :disabled="!canManageFinance" /></el-form-item></el-form></section>
          </div>
          <div v-if="canManageFinance" class="finance-settings-actions"><el-button type="primary" :loading="infoSaving" @click="saveFinanceInfo">保存收款信息</el-button></div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-if="canManageFinance" v-model="extractDialogOpen" title="申请提现" width="min(480px, 92vw)">
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
