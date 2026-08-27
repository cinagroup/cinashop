<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { ArrowLeft, Refresh, WarningFilled } from "@element-plus/icons-vue";
import { getVirtualInventoryAlerts } from "@/api/supplier";
import type { VirtualInventoryAlertRow, VirtualInventoryAlertView } from "@/types";

const router = useRouter();
const loading = ref(false);
const rows = ref<VirtualInventoryAlertRow[]>([]);
const nextCursor = ref<number | null>(null);
const summary = ref<VirtualInventoryAlertView["summary"]>({
  products_scanned: 0,
  skus_scanned: 0,
  alert_products: 0,
  alert_skus: 0,
  shortage_skus: 0,
  low_buffer_skus: 0,
});
const filters = reactive<{
  threshold: number;
  level: "all" | "shortage" | "low_buffer";
}>({ threshold: 5, level: "all" });

async function load(reset = true) {
  loading.value = true;
  try {
    const result = await getVirtualInventoryAlerts({
      threshold: filters.threshold,
      level: filters.level,
      cursor: reset ? undefined : nextCursor.value ?? undefined,
      limit: 30,
    });
    summary.value = result.summary;
    rows.value = reset ? result.list : [...rows.value, ...result.list];
    nextCursor.value = result.next_cursor;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "卡密库存预警加载失败");
  } finally {
    loading.value = false;
  }
}

function levelLabel(row: VirtualInventoryAlertRow) {
  return row.risk_level === "shortage" ? "库存缺口" : "缓冲偏低";
}

onMounted(() => void load());
</script>

<template>
  <section class="page-section inventory-alert-page" v-loading="loading">
    <header class="page-heading alert-heading">
      <div class="heading-title">
        <el-button circle plain :icon="ArrowLeft" aria-label="返回商品列表" @click="router.push('/products')" />
        <div><h1>卡密库存预警</h1><p>只统计当前供应商的一次性卡密商品，完整卡号与密码不会出现在预警响应中</p></div>
      </div>
    </header>

    <el-alert
      title="未分配卡密必须覆盖可售库存"
      type="warning"
      :closable="false"
      show-icon
      description="负数差额表示存在超卖风险；正数差额不超过安全缓冲阈值时提醒提前补充。固定虚拟内容 SKU 不参与统计。"
    />

    <div class="alert-metrics">
      <article class="surface metric"><span>预警商品</span><strong>{{ summary.alert_products }}</strong><small>扫描 {{ summary.products_scanned }} 件</small></article>
      <article class="surface metric danger"><span>库存缺口 SKU</span><strong>{{ summary.shortage_skus }}</strong><small>优先补充</small></article>
      <article class="surface metric warning"><span>缓冲偏低 SKU</span><strong>{{ summary.low_buffer_skus }}</strong><small>阈值内关注</small></article>
      <article class="surface metric"><span>预警 SKU</span><strong>{{ summary.alert_skus }}</strong><small>扫描 {{ summary.skus_scanned }} 个</small></article>
    </div>

    <div class="surface list-surface alert-list-surface">
      <div class="filter-row alert-filter-row">
        <label class="threshold-control"><span>安全缓冲阈值</span><el-input-number v-model="filters.threshold" :min="0" :max="1000" controls-position="right" /></label>
        <el-select v-model="filters.level" class="state-select" aria-label="预警级别">
          <el-option label="全部预警" value="all" />
          <el-option label="仅库存缺口" value="shortage" />
          <el-option label="仅缓冲偏低" value="low_buffer" />
        </el-select>
        <el-button type="primary" :icon="Refresh" @click="load()">刷新预警</el-button>
      </div>

      <el-table :data="rows" row-key="sku_id" class="alert-table" empty-text="当前阈值下没有卡密库存预警">
        <el-table-column label="商品 / SKU" min-width="280">
          <template #default="scope"><div class="product-cell"><div class="product-thumb">{{ scope.row.store_name.slice(0, 1) }}</div><div><strong>{{ scope.row.store_name }}</strong><span>{{ scope.row.suk || scope.row.attr_unique }} · ID {{ scope.row.product_id }}</span></div></div></template>
        </el-table-column>
        <el-table-column prop="sellable_stock" label="可售库存" width="100" />
        <el-table-column prop="available_cards" label="未分配卡" width="105" />
        <el-table-column label="差额" width="90"><template #default="scope"><strong :class="scope.row.buffer < 0 ? 'negative' : 'low'">{{ scope.row.buffer > 0 ? `+${scope.row.buffer}` : scope.row.buffer }}</strong></template></el-table-column>
        <el-table-column label="级别" width="120"><template #default="scope"><span class="risk-chip" :class="scope.row.risk_level"><el-icon><WarningFilled /></el-icon>{{ levelLabel(scope.row) }}</span></template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right"><template #default="scope"><el-button link type="primary" @click="router.push(`/products/${scope.row.product_id}/virtual-inventory`)">补充卡密</el-button></template></el-table-column>
      </el-table>

      <div class="mobile-alert-list">
        <article v-for="row in rows" :key="row.sku_id" class="mobile-alert" :class="row.risk_level">
          <div><strong>{{ row.store_name }}</strong><span class="risk-chip" :class="row.risk_level">{{ levelLabel(row) }}</span></div>
          <p>{{ row.suk || row.attr_unique }} · 可售 {{ row.sellable_stock }} / 未分配 {{ row.available_cards }} / 差额 {{ row.buffer }}</p>
          <el-button link type="primary" @click="router.push(`/products/${row.product_id}/virtual-inventory`)">补充卡密</el-button>
        </article>
        <div v-if="!rows.length" class="mobile-empty">当前阈值下没有预警</div>
      </div>
      <div class="pagination-row"><span>当前展示 {{ rows.length }} 个预警 SKU</span><el-button v-if="nextCursor" @click="load(false)">加载更多</el-button></div>
    </div>
  </section>
</template>

<style scoped>
.inventory-alert-page { display: grid; gap: 14px; min-width: 0; }
.heading-title { display: flex; align-items: center; min-width: 0; gap: 12px; }
.heading-title > div { min-width: 0; }
.heading-title h1 { margin: 0 0 4px; }
.heading-title p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
.inventory-alert-page > :deep(.el-alert__content) { min-width: 0; }
.inventory-alert-page > :deep(.el-alert__description) { overflow-wrap: anywhere; }
.alert-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metric { display: grid; gap: 7px; padding: 18px; }
.metric span, .metric small { color: var(--muted); }
.metric strong { color: #213650; font-size: 28px; }
.metric.danger strong, .negative { color: var(--red); }
.metric.warning strong, .low { color: #c47b0b; }
.alert-list-surface { min-width: 0; }
.alert-filter-row { flex-wrap: wrap; }
.threshold-control { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
.risk-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 999px; color: #9a6100; background: #fff4d8; font-size: 12px; font-weight: 650; }
.risk-chip.shortage { color: #b42318; background: #feeceb; }
.mobile-alert-list { display: none; }
@media (max-width: 980px) { .alert-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .heading-title { align-items: flex-start; }
  .alert-metrics { grid-template-columns: 1fr 1fr; padding: 0 12px; }
  .metric { padding: 15px; }
  .metric strong { font-size: 24px; }
  .alert-filter-row { align-items: stretch; flex-direction: column; }
  .threshold-control { justify-content: space-between; }
  .threshold-control :deep(.el-input-number), .alert-filter-row .state-select, .alert-filter-row > .el-button { width: 100%; }
  .alert-table { display: none; }
  .mobile-alert-list { display: grid; gap: 10px; }
  .mobile-alert { padding: 14px; border: 1px solid var(--border); border-left: 4px solid #e6a23c; border-radius: 8px; }
  .mobile-alert.shortage { border-left-color: var(--red); }
  .mobile-alert > div { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .mobile-alert p { margin: 9px 0 4px; color: var(--muted); font-size: 12px; line-height: 1.5; }
}
</style>
