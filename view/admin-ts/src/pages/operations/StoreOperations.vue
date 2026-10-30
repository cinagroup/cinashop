<template>
  <div class="store-operations">
    <div class="summary-grid">
      <el-card v-for="item in summary" :key="item.label" shadow="never">
        <span>{{ item.label }}</span><strong>{{ item.value }}</strong>
      </el-card>
    </div>

    <el-tabs v-model="activeTab" class="content-card">
      <el-tab-pane label="门店" name="stores">
        <StoreCatalogAuthor :active="activeTab === 'stores'" @changed="refreshStoreReferences" />
      </el-tab-pane>

      <el-tab-pane label="店员与核销" name="staff">
        <StaffCatalogAuthor :active="activeTab === 'staff'" @changed="refreshHeader" />
      </el-tab-pane>

      <el-tab-pane label="配送员" name="delivery">
        <DeliveryCatalogAuthor :active="activeTab === 'delivery'" @page-active-count="deliveryCount = $event" />
      </el-tab-pane>
    </el-tabs>

  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import StaffCatalogAuthor from "@/pages/operations/StaffCatalogAuthor.vue";
import StoreCatalogAuthor from "@/pages/operations/StoreCatalogAuthor.vue";
import DeliveryCatalogAuthor from '@/pages/operations/DeliveryCatalogAuthor.vue';
import { apiStoreHeader } from '@/api/store';

const route = useRoute();
const staffAlias = "/admin/setting/merchant/system_store_staff/index";
const activeTab = ref(route.path === staffAlias ? "staff" : "stores");
watch(() => route.path, path => { activeTab.value = path === staffAlias ? "staff" : "stores"; }, { flush: "sync" });
const storeHeader = ref({ show: { num: 0 }, hide: { num: 0 }, recycle: { num: 0 } });
const summary = computed(() => [
  { label: "营业中门店", value: storeHeader.value.show.num },
  { label: "已停业门店", value: storeHeader.value.hide.num },
  { label: "回收站", value: storeHeader.value.recycle.num },
  { label: "当前页有效配送员", value: deliveryCount.value },
]);

const deliveryCount = ref(0);
async function refreshHeader() { storeHeader.value = (await apiStoreHeader()).count; }
async function refreshStoreReferences() { await refreshHeader(); }
onMounted(() => { void refreshHeader(); });
</script>

<style scoped>
.store-operations { display: flex; flex-direction: column; gap: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 12px; }
.summary-grid :deep(.el-card__body) { display: flex; flex-direction: column; gap: 8px; }
.summary-grid span { color: #64748b; font-size: 13px; }.summary-grid strong { color: #0f172a; font-size: 25px; }
.content-card { background: #fff; border-radius: 8px; padding: 8px 18px 18px; }
.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 8px 0 16px; }
.keyword { width: 260px; }.short-select { width: 180px; }.pager { justify-content: flex-end; margin-top: 16px; }
.muted { color: #8a94a5; font-size: 12px; margin-top: 4px; }.spaced-table { margin-top: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }.form-grid .full { grid-column: 1 / -1; }.suffix { margin-left: 6px; color: #64748b; }
@media (max-width: 820px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid { grid-template-columns: 1fr; }
  .form-grid .full { grid-column: auto; }
  .keyword, .short-select { width: 100%; }
  :deep(.operations-dialog) {
    width: calc(100vw - 24px) !important;
    max-height: calc(100vh - 24px);
    margin: 12px auto !important;
    display: flex;
    flex-direction: column;
  }
  :deep(.operations-dialog .el-dialog__body) {
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
}
</style>
