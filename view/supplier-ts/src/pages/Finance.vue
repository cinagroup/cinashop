<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { getFinanceSummary } from "@/api/supplier";
import type { FinanceSummary } from "@/types";
import { useAuthStore } from "@/stores/auth";
import { formatMoney } from "@/utils/format";
import FinanceFlows from '@/pages/FinanceFlows.vue';
import FinanceExtracts from '@/pages/FinanceExtracts.vue';
import FinanceAccounts from '@/pages/FinanceAccounts.vue';
import { createSupplierSessionScope } from '@/utils/supplierSession';

const auth = useAuthStore(), router = useRouter(), route = useRoute();
const loading = ref(false);
const activeTab = ref("flows");
const emptySummary = (): FinanceSummary => ({
  available: "0.00",
  pending_settlement: "0.00",
  total_income: "0.00",
  total_refund: "0.00",
  pending_extract: "0.00",
  paid_extract: "0.00",
});
const summary = ref(emptySummary());
const canManageFinance = computed(() => auth.can("supplier.finance.manage"));
let alive = true, invalidated = false, generation = 0, controller: AbortController | undefined;
let session: ReturnType<typeof createSupplierSessionScope> | undefined;
function invalidate() {
  invalidated = true; generation++; controller?.abort(); summary.value = emptySummary(); loading.value = false;
}
try { session = createSupplierSessionScope(invalidate); } catch { invalidate(); }
function current() { try { return alive && !invalidated && !!session?.isCurrent() && route.path === '/finance' && auth.can('supplier.finance.view'); } catch { invalidate(); return false; } }
watch(() => route.fullPath, invalidate);
watch(() => JSON.stringify([auth.token, auth.user?.id, auth.user?.supplier_id, auth.permissions, auth.permissionsLoaded]), invalidate);

async function loadAll() {
  if (!current()) return;
  const id = ++generation; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  loading.value = true;
  try {
    const value = await getFinanceSummary(signal);
    if (current() && id === generation && !signal.aborted) summary.value = value;
  } catch (error) {
    if (current() && id === generation && !signal.aborted) ElMessage.error(error instanceof Error ? error.message : "财务数据加载失败");
  } finally {
    if (current() && id === generation) loading.value = false;
  }
}
onMounted(loadAll);
onBeforeUnmount(() => { alive = false; invalidate(); session?.dispose(); });
</script>

<template>
  <section v-loading="loading" class="page-section finance-page">
    <header class="page-heading finance-heading">
      <div><h1>财务结算</h1><p>订单收货后进入可提现余额，退款和提现申请均保留独立流水</p></div>
      <el-button v-if="canManageFinance" type="primary" @click="router.push('/finance/apply')">申请提现</el-button>
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
          <FinanceExtracts v-if="activeTab === 'extracts'" embedded />
        </el-tab-pane>

        <el-tab-pane label="收款设置" name="settings">
          <FinanceAccounts v-if="activeTab === 'settings'" embedded />
        </el-tab-pane>
      </el-tabs>
    </div>

  </section>
</template>
