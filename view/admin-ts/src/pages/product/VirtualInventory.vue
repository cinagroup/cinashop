<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeft, Download, Upload } from "@element-plus/icons-vue";
import {
  apiAdminVirtualInventory,
  apiAdminVirtualInventoryConsumeExportTicket,
  apiAdminVirtualInventoryCreateExportTicket,
  apiAdminVirtualInventoryImport,
  type VirtualInventoryExportResult,
  type VirtualInventoryCard,
  type VirtualInventoryView,
} from "@/api/product";

const route = useRoute();
const router = useRouter();
const productId = Number(route.params.id ?? 0);
const loading = ref(false);
const importing = ref(false);
const exporting = ref(false);
const inventory = ref<VirtualInventoryView | null>(null);
const cards = ref<VirtualInventoryCard[]>([]);
const selectedSku = ref("");
const status = ref("all");
const nextCursor = ref<number | null>(null);
const importText = ref("");

const selectedSkuInfo = computed(() =>
  inventory.value?.skus.find((item) => item.unique === selectedSku.value),
);

async function load(reset = true) {
  loading.value = true;
  try {
    const result = await apiAdminVirtualInventory(productId, {
      attr_unique: selectedSku.value || undefined,
      status: status.value,
      cursor: reset ? undefined : nextCursor.value ?? undefined,
      limit: 30,
    });
    inventory.value = result;
    selectedSku.value = result.selected_attr_unique;
    cards.value = reset ? result.list : [...cards.value, ...result.list];
    nextCursor.value = result.next_cursor;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "卡密库存加载失败");
  } finally {
    loading.value = false;
  }
}

function parseCards() {
  const lines = importText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("请粘贴至少一行卡密");
  if (lines.length > 1_000) throw new Error("单次最多导入 1000 行");
  return lines.map((line, index) => {
    const columns = line.split("\t");
    if (columns.length === 1) return { card_no: "", card_pwd: columns[0] };
    if (columns.length !== 2 || !columns[1].trim()) {
      throw new Error(`第 ${index + 1} 行应为“卡号 + Tab + 密码”，或仅密码`);
    }
    return { card_no: columns[0], card_pwd: columns[1] };
  });
}

async function submitImport() {
  if (!selectedSku.value) return ElMessage.warning("请选择SKU");
  if (selectedSkuInfo.value?.disk_info_configured) {
    return ElMessage.warning("固定虚拟内容SKU不能导入一次性卡密");
  }
  let parsed: Array<{ card_no: string; card_pwd: string }>;
  try {
    parsed = parseCards();
  } catch (error) {
    return ElMessage.warning(error instanceof Error ? error.message : "导入格式错误");
  }
  importing.value = true;
  try {
    const result = await apiAdminVirtualInventoryImport(productId, {
      attr_unique: selectedSku.value,
      cards: parsed,
    });
    importText.value = "";
    ElMessage.success(
      `新增 ${result.inserted} 条，已有 ${result.skipped_existing} 条，请求内重复 ${result.skipped_request_duplicates} 条`,
    );
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "卡密导入失败");
  } finally {
    importing.value = false;
  }
}

function downloadExport(result: VirtualInventoryExportResult) {
  const payload = JSON.stringify(result, null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeSku = result.attr_unique.replace(/[^A-Za-z0-9_-]/g, "_");
  anchor.href = url;
  anchor.download = `virtual-cards-${result.product.id}-${safeSku}-${result.export_id}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportAvailableCards() {
  if (!selectedSku.value) return ElMessage.warning("请选择SKU");
  if (selectedSkuInfo.value?.disk_info_configured) {
    return ElMessage.warning("固定虚拟内容SKU不支持卡密导出");
  }
  if (!selectedSkuInfo.value?.available_cards) {
    return ElMessage.warning("当前SKU没有未分配卡密");
  }
  try {
    const { value } = await ElMessageBox.prompt(
      "请填写本次明文导出的业务原因（8–500字）。原因会写入审计记录。",
      "受控敏感导出",
      {
        inputPlaceholder: "例如：供应商库存对账与离线灾备",
        inputValidator: (input) => {
          const length = input.trim().length;
          return (length >= 8 && length <= 500) || "导出原因必须为8至500个字符";
        },
        confirmButtonText: "下一步",
        cancelButtonText: "取消",
      },
    );
    await ElMessageBox.confirm(
      `将一次性下载当前SKU的 ${selectedSkuInfo.value.available_cards} 条未分配卡密。票据60秒失效且不能重放；下载失败也需要重新申请。确认继续？`,
      "最后确认",
      {
        type: "warning",
        confirmButtonText: "创建票据并立即下载",
        cancelButtonText: "取消",
      },
    );
    exporting.value = true;
    const authorization = await apiAdminVirtualInventoryCreateExportTicket(productId, {
      attr_unique: selectedSku.value,
      reason: value.trim(),
      confirm: "EXPORT_AVAILABLE_VIRTUAL_CARDS",
    });
    const result = await apiAdminVirtualInventoryConsumeExportTicket(
      productId,
      authorization.ticket,
    );
    downloadExport(result);
    ElMessage.success(`已一次性导出 ${result.exported_count} 条未分配卡密`);
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : "卡密导出失败");
    }
  } finally {
    exporting.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="inventory-page" v-loading="loading">
    <header class="page-heading">
      <div class="heading-title">
        <el-button circle plain :icon="ArrowLeft" aria-label="返回商品列表" @click="router.push('/product')" />
        <div>
          <h1>卡密库存</h1>
          <p>{{ inventory?.product.store_name ?? `商品 #${productId}` }} · 列表始终隐藏完整卡号与密码</p>
        </div>
      </div>
    </header>

    <el-alert
      title="安全说明"
      type="info"
      :closable="false"
      show-icon
      description="密码只在导入请求与订单自动交付时使用，本页不会回显。导入会按真实新增数量增加可售库存，不会覆盖订单已经预留的库存。"
    />

    <div class="summary-grid">
      <el-card shadow="never"><span>卡密总数</span><strong>{{ inventory?.summary.total_cards ?? 0 }}</strong></el-card>
      <el-card shadow="never"><span>未分配</span><strong>{{ inventory?.summary.available_cards ?? 0 }}</strong></el-card>
      <el-card shadow="never"><span>已交付</span><strong>{{ inventory?.summary.assigned_cards ?? 0 }}</strong></el-card>
    </div>

    <el-card shadow="never" class="section-card">
      <div class="toolbar">
        <el-select v-model="selectedSku" placeholder="选择SKU" @change="load()">
          <el-option
            v-for="sku in inventory?.skus ?? []"
            :key="sku.unique"
            :label="`${sku.suk || sku.unique} · 可售 ${sku.stock} · 未分配卡 ${sku.available_cards}`"
            :value="sku.unique"
          />
        </el-select>
        <el-select v-model="status" class="status-select" @change="load()">
          <el-option label="全部状态" value="all" />
          <el-option label="未分配" value="available" />
          <el-option label="已交付" value="assigned" />
        </el-select>
      </div>
      <el-alert
        v-if="selectedSkuInfo?.disk_info_configured"
        title="当前SKU使用固定虚拟内容，不使用一次性卡密库存。"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-table :data="cards" row-key="id" empty-text="暂无卡密记录">
        <el-table-column prop="id" label="ID" width="90" />
        <el-table-column prop="card_no_masked" label="卡号提示" min-width="180" />
        <el-table-column label="密码" width="100">
          <template #default="scope">{{ scope.row.password_configured ? "已配置" : "缺失" }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="scope">
            <el-tag :type="scope.row.status === 'available' ? 'success' : 'info'">
              {{ scope.row.status === "available" ? "未分配" : "已交付" }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <div class="load-more"><el-button v-if="nextCursor" @click="load(false)">加载更多</el-button></div>
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header><strong>受控导出未分配卡密</strong></template>
      <el-alert
        title="只导出未分配库存，不包含已交付给客户的卡密"
        type="warning"
        :closable="false"
        show-icon
        description="操作需要填写原因并二次确认。服务端创建60秒、绑定当前管理员/商品/SKU的一次性票据；票据只保存摘要，成功消费后立即失效。导出文件含明文秘密，请保存在受控位置并及时清理。"
      />
      <div class="import-actions">
        <el-button
          type="danger"
          plain
          :icon="Download"
          :loading="exporting"
          :disabled="selectedSkuInfo?.disk_info_configured || !selectedSkuInfo?.available_cards"
          @click="exportAvailableCards"
        >导出当前SKU未分配卡密</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header><strong>批量导入一次性卡密</strong></template>
      <p class="hint">每行使用“卡号 + Tab + 密码”；只有密码时可直接粘贴一列。单次最多 1000 行。</p>
      <el-input
        v-model="importText"
        type="textarea"
        :rows="10"
        :disabled="selectedSkuInfo?.disk_info_configured"
        placeholder="CARD-001&#9;PASSWORD-001&#10;PASSWORD-ONLY"
      />
      <div class="import-actions">
        <el-button
          type="primary"
          :icon="Upload"
          :loading="importing"
          :disabled="selectedSkuInfo?.disk_info_configured"
          @click="submitImport"
        >导入卡密</el-button>
      </div>
    </el-card>
  </section>
</template>

<style scoped>
.inventory-page { display: grid; min-width: 0; gap: 16px; }
.page-heading, .heading-title, .toolbar, .import-actions { display: flex; align-items: center; }
.heading-title { min-width: 0; gap: 12px; }
.heading-title > div { min-width: 0; }
.heading-title h1 { margin: 0 0 4px; }
.heading-title p, .hint { margin: 0; color: var(--el-text-color-secondary); line-height: 1.5; overflow-wrap: anywhere; }
.inventory-page > :deep(.el-alert) { min-width: 0; }
.inventory-page > :deep(.el-alert__content) { min-width: 0; }
.inventory-page > :deep(.el-alert__description) { overflow-wrap: anywhere; }
.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.summary-grid :deep(.el-card__body) { display: grid; gap: 8px; }
.summary-grid strong { font-size: 28px; }
.section-card { min-width: 0; }
.toolbar { gap: 12px; margin-bottom: 16px; }
.toolbar .el-select:first-child { min-width: 320px; }
.status-select { width: 150px; }
.load-more, .import-actions { justify-content: flex-end; margin-top: 16px; }
.hint { margin-bottom: 12px; }
@media (max-width: 720px) {
  .heading-title { align-items: flex-start; }
  .summary-grid { grid-template-columns: 1fr; }
  .toolbar { align-items: stretch; flex-direction: column; }
  .toolbar .el-select:first-child, .status-select { min-width: 0; width: 100%; }
}
</style>
