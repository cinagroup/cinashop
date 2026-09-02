<template>
  <div class="product-list">
    <!-- 搜索栏 -->
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="商品名称">
          <el-input
            v-model="query.store_name"
            placeholder="请输入商品名称"
            clearable
            @keyup.enter="reload"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">搜索</el-button>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 工具栏 -->
    <el-card shadow="never">
      <div class="toolbar">
        <el-button plain @click="$router.push('/product/metadata')">
          商品基础资料
        </el-button>
        <el-button type="warning" plain @click="$router.push('/product/virtual-alerts')">
          卡密预警
        </el-button>
        <el-button type="primary" @click="$router.push('/product/create')">
          添加商品
        </el-button>
      </div>

      <div class="batch-toolbar">
        <el-text :type="selectedRows.length ? 'primary' : 'info'">
          已选择 {{ selectedRows.length }} 项（单次最多100项）
        </el-text>
        <el-button type="primary" plain :disabled="!selectedRows.length" @click="openBatch">
          批量操作
        </el-button>
      </div>

      <!-- 表格 -->
      <el-table :data="list" v-loading="loading" @selection-change="handleSelectionChange">
        <el-table-column type="selection" width="48" />
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="商品" min-width="240">
          <template #default="{ row }">
            <div class="product-cell">
              <el-image
                v-if="row.image"
                :src="row.image"
                class="thumb"
                fit="cover"
                :preview-src-list="[row.image]"
              />
              <span class="name">{{ row.store_name }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="price" label="价格" width="100">
          <template #default="{ row }">¥{{ row.price }}</template>
        </el-table-column>
        <el-table-column prop="stock" label="库存" width="80" />
        <el-table-column prop="sales" label="销量" width="80" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.is_show === 1 ? 'success' : 'info'">
              {{ row.is_show === 1 ? "上架" : "下架" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260">
          <template #default="{ row }">
            <el-button
              v-if="row.product_type === 1"
              link
              type="primary"
              @click="$router.push(`/product/virtual/${row.id}`)"
            >
              卡密库存
            </el-button>
            <el-button v-if="row.product_type !== 1" link type="primary" @click="$router.push(`/product/edit/${row.id}`)">
              编辑
            </el-button>
            <el-button link :type="row.is_show === 1 ? 'warning' : 'success'" @click="toggleShow(row)">
              {{ row.is_show === 1 ? "下架" : "上架" }}
            </el-button>
            <el-button link type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.limit"
        :total="total"
        layout="total, prev, pager, next"
        class="pagination"
        @current-change="fetch"
      />
    </el-card>

    <el-dialog v-model="batchDialogVisible" title="批量操作商品" width="min(520px, 94vw)">
      <el-alert
        title="所选商品会在一个短事务内完成；任一商品或关系校验失败时整批回滚。"
        type="warning"
        :closable="false"
        show-icon
        class="batch-alert"
      />
      <el-form label-position="top">
        <el-form-item label="操作类型">
          <el-select v-model="batchOperation" class="full-width" @change="batchRelationIds = []">
            <el-option label="批量上架" value="show" />
            <el-option label="批量下架" value="hide" />
            <el-option label="替换商品分类" value="category" />
            <el-option label="替换商品标签" value="label" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="batchOperation === 'category'" label="商品分类">
          <el-select v-model="batchRelationIds" multiple filterable class="full-width" placeholder="至少选择一个分类">
            <el-option v-for="item in batchOptions.categories" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="batchOperation === 'label'" label="商品标签">
          <el-select v-model="batchRelationIds" multiple filterable clearable class="full-width" placeholder="留空会清除现有商品标签">
            <el-option v-for="item in batchOptions.product_labels" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="batchSubmitting" @click="applyBatch">确认执行</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminProductList,
  apiAdminProductSetShow,
  apiAdminProductDel,
  apiAdminProductBatchRelations,
  apiAdminProductBatchSetShow,
  apiAdminProductEditorOptions,
  type ProductEditorOption,
} from "@/api/product";
import type { AdminProduct } from "@/types/admin";

const list = ref<AdminProduct[]>([]);
const loading = ref(false);
const total = ref(0);
const query = reactive({ page: 1, limit: 10, store_name: "" });
const selectedRows = ref<AdminProduct[]>([]);
const batchDialogVisible = ref(false);
const batchSubmitting = ref(false);
const batchOperation = ref<"show" | "hide" | "category" | "label">("show");
const batchRelationIds = ref<number[]>([]);
const batchOptions = reactive<{
  categories: ProductEditorOption[];
  product_labels: ProductEditorOption[];
}>({ categories: [], product_labels: [] });

async function fetch() {
  loading.value = true;
  try {
    const result = await apiAdminProductList({
      page: query.page,
      limit: query.limit,
      store_name: query.store_name || undefined,
    });
    list.value = result.list;
    selectedRows.value = [];
    total.value = result.list.length < query.limit ? (query.page - 1) * query.limit + result.list.length : query.page * query.limit + 1;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function handleSelectionChange(rows: AdminProduct[]) {
  selectedRows.value = rows.slice(0, 100);
}

async function openBatch() {
  if (!selectedRows.value.length) return ElMessage.warning("请先选择商品");
  if (!batchOptions.categories.length && !batchOptions.product_labels.length) {
    try {
      const options = await apiAdminProductEditorOptions();
      batchOptions.categories = options.categories;
      batchOptions.product_labels = options.product_labels;
    } catch (e) {
      return ElMessage.error(e instanceof Error ? e.message : "加载批量候选失败");
    }
  }
  batchOperation.value = "show";
  batchRelationIds.value = [];
  batchDialogVisible.value = true;
}

async function applyBatch() {
  const ids = selectedRows.value.map((row) => row.id);
  if (!ids.length) return ElMessage.warning("请选择商品");
  if (batchOperation.value === "category" && !batchRelationIds.value.length) {
    return ElMessage.warning("请至少选择一个商品分类");
  }
  batchSubmitting.value = true;
  try {
    const result = batchOperation.value === "show" || batchOperation.value === "hide"
      ? await apiAdminProductBatchSetShow(ids, batchOperation.value === "show" ? 1 : 0)
      : await apiAdminProductBatchRelations(
        batchOperation.value === "category" ? 1 : 2,
        ids,
        batchRelationIds.value,
      );
    if (!result.verified) throw new Error("批量操作数据库回读未通过");
    ElMessage.success(`已处理 ${result.changed} 个商品`);
    batchDialogVisible.value = false;
    await fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "批量操作失败");
  } finally {
    batchSubmitting.value = false;
  }
}

function reload() {
  query.page = 1;
  fetch();
}

function reset() {
  query.store_name = "";
  reload();
}

async function toggleShow(row: AdminProduct) {
  try {
    await apiAdminProductSetShow(row.id, row.is_show === 1 ? 0 : 1);
    ElMessage.success(row.is_show === 1 ? "已下架" : "已上架");
    fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "操作失败");
  }
}

async function del(row: AdminProduct) {
  try {
    await ElMessageBox.confirm(`确定删除商品「${row.store_name}」?`, "确认");
  } catch {
    return;
  }
  try {
    await apiAdminProductDel(row.id);
    ElMessage.success("已删除");
    fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "删除失败");
  }
}

onMounted(fetch);
</script>

<style scoped>
.filter-card {
  margin-bottom: 16px;
}

.toolbar {
  margin-bottom: 16px;
}
.batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}
.batch-alert {
  margin-bottom: 16px;
}
.full-width {
  width: 100%;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.thumb {
  width: 56px;
  height: 56px;
  border-radius: 4px;
  flex-shrink: 0;
}

.name {
  font-size: 14px;
}

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
@media (max-width: 640px) {
  .toolbar,
  .batch-toolbar {
    flex-wrap: wrap;
  }
  .toolbar :deep(.el-button),
  .batch-toolbar :deep(.el-button) {
    margin-left: 0;
  }
}
</style>
