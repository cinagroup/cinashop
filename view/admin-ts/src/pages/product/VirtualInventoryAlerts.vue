<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { ArrowLeft, Refresh, WarningFilled } from "@element-plus/icons-vue";
import {
  apiAdminVirtualInventoryAlerts,
  type VirtualInventoryAlertRow,
  type VirtualInventoryAlertView,
} from "@/api/product";

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
    const result = await apiAdminVirtualInventoryAlerts({
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
  <section class="alert-page" v-loading="loading">
    <header class="page-heading">
      <div class="heading-title">
        <el-button circle plain :icon="ArrowLeft" aria-label="返回商品列表" @click="router.push('/product')" />
        <div>
          <h1>卡密库存预警</h1>
          <p>跨平台与供应商商品汇总一次性卡密覆盖情况，不展示卡号或密码</p>
        </div>
      </div>
    </header>

    <el-alert
      title="预警口径"
      type="warning"
      :closable="false"
      show-icon
      description="未分配卡密少于可售库存时为库存缺口；覆盖库存后剩余卡密不超过阈值时为缓冲偏低。固定虚拟内容 SKU 不参与统计。"
    />

    <div class="summary-grid">
      <el-card shadow="never"><span>预警商品</span><strong>{{ summary.alert_products }}</strong><small>已扫描 {{ summary.products_scanned }} 件</small></el-card>
      <el-card shadow="never" class="critical"><span>库存缺口 SKU</span><strong>{{ summary.shortage_skus }}</strong><small>可能超卖，优先补充</small></el-card>
      <el-card shadow="never" class="warning"><span>缓冲偏低 SKU</span><strong>{{ summary.low_buffer_skus }}</strong><small>阈值内需关注</small></el-card>
      <el-card shadow="never"><span>预警 SKU</span><strong>{{ summary.alert_skus }}</strong><small>已扫描 {{ summary.skus_scanned }} 个</small></el-card>
    </div>

    <el-card shadow="never" class="list-card">
      <div class="toolbar">
        <div class="filter-control">
          <span>安全缓冲阈值</span>
          <el-input-number v-model="filters.threshold" :min="0" :max="1000" controls-position="right" />
        </div>
        <el-select v-model="filters.level" class="level-select" aria-label="预警级别">
          <el-option label="全部预警" value="all" />
          <el-option label="仅库存缺口" value="shortage" />
          <el-option label="仅缓冲偏低" value="low_buffer" />
        </el-select>
        <el-button type="primary" :icon="Refresh" @click="load()">刷新预警</el-button>
      </div>

      <el-table :data="rows" row-key="sku_id" empty-text="当前阈值下没有卡密库存预警">
        <el-table-column label="商品 / SKU" min-width="260">
          <template #default="scope">
            <div class="product-cell"><strong>{{ scope.row.store_name }}</strong><span>{{ scope.row.suk || scope.row.attr_unique }} · #{{ scope.row.product_id }}</span></div>
          </template>
        </el-table-column>
        <el-table-column label="归属" width="130">
          <template #default="scope">{{ scope.row.owner_type === 2 ? `供应商 #${scope.row.owner_id}` : "平台自营" }}</template>
        </el-table-column>
        <el-table-column prop="sellable_stock" label="可售库存" width="100" />
        <el-table-column prop="available_cards" label="未分配卡" width="105" />
        <el-table-column label="差额" width="90">
          <template #default="scope"><strong :class="scope.row.buffer < 0 ? 'negative' : 'low'">{{ scope.row.buffer > 0 ? `+${scope.row.buffer}` : scope.row.buffer }}</strong></template>
        </el-table-column>
        <el-table-column label="级别" width="120">
          <template #default="scope"><el-tag :type="scope.row.risk_level === 'shortage' ? 'danger' : 'warning'" effect="light"><el-icon><WarningFilled /></el-icon>{{ levelLabel(scope.row) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="scope"><el-button link type="primary" @click="router.push(`/product/virtual/${scope.row.product_id}`)">补充卡密</el-button></template>
        </el-table-column>
      </el-table>

      <div class="mobile-list">
        <article v-for="row in rows" :key="row.sku_id" class="mobile-alert" :class="row.risk_level">
          <div><strong>{{ row.store_name }}</strong><el-tag :type="row.risk_level === 'shortage' ? 'danger' : 'warning'">{{ levelLabel(row) }}</el-tag></div>
          <p>{{ row.suk || row.attr_unique }} · 可售 {{ row.sellable_stock }} / 未分配 {{ row.available_cards }} / 差额 {{ row.buffer }}</p>
          <el-button link type="primary" @click="router.push(`/product/virtual/${row.product_id}`)">补充卡密</el-button>
        </article>
        <el-empty v-if="!rows.length" :image-size="70" description="当前阈值下没有预警" />
      </div>
      <div class="load-more"><el-button v-if="nextCursor" @click="load(false)">加载更多</el-button></div>
    </el-card>
  </section>
</template>

<style scoped>
.alert-page { display: grid; min-width: 0; gap: 16px; }
.page-heading, .heading-title, .toolbar, .filter-control { display: flex; align-items: center; }
.heading-title { min-width: 0; gap: 12px; }
.heading-title > div { min-width: 0; }
.heading-title h1 { margin: 0 0 4px; }
.heading-title p { margin: 0; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.alert-page > :deep(.el-alert__content) { min-width: 0; }
.alert-page > :deep(.el-alert__description) { overflow-wrap: anywhere; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.summary-grid :deep(.el-card__body) { display: grid; gap: 7px; }
.summary-grid span, .summary-grid small { color: var(--el-text-color-secondary); }
.summary-grid strong { font-size: 28px; }
.summary-grid .critical strong, .negative { color: var(--el-color-danger); }
.summary-grid .warning strong, .low { color: var(--el-color-warning-dark-2); }
.list-card { min-width: 0; }
.toolbar { flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.filter-control { gap: 9px; color: var(--el-text-color-secondary); font-size: 14px; }
.level-select { width: 160px; }
.product-cell { display: grid; gap: 5px; }
.product-cell span { color: var(--el-text-color-secondary); font-size: 12px; }
.mobile-list { display: none; }
.load-more { display: flex; justify-content: center; margin-top: 16px; }
@media (max-width: 900px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .heading-title { align-items: flex-start; }
  .summary-grid { grid-template-columns: 1fr 1fr; }
  .summary-grid strong { font-size: 24px; }
  .toolbar { align-items: stretch; flex-direction: column; }
  .filter-control { justify-content: space-between; }
  .filter-control :deep(.el-input-number), .level-select, .toolbar > .el-button { width: 100%; }
  .list-card :deep(.el-table) { display: none; }
  .mobile-list { display: grid; gap: 10px; }
  .mobile-alert { padding: 14px; border: 1px solid var(--el-border-color); border-left: 4px solid var(--el-color-warning); border-radius: 8px; }
  .mobile-alert.shortage { border-left-color: var(--el-color-danger); }
  .mobile-alert > div { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .mobile-alert p { margin: 9px 0 4px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.5; }
}
</style>
