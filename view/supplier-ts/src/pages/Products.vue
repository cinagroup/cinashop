<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Box, Delete, Edit, Plus, Search, Setting, WarningFilled } from "@element-plus/icons-vue";
import {
  adjustProductStock,
  batchSetProductShow,
  deleteProductCategory,
  getProductCategories,
  getProductDetail,
  getProducts,
  recycleProduct,
  saveProductCategory,
  setProductShow,
} from "@/api/supplier";
import type { ProductCategory, ProductRow, ProductSku } from "@/types";
import { formatMoney, formatTime } from "@/utils/format";

const router = useRouter();
const loading = ref(false);
const rows = ref<ProductRow[]>([]);
const total = ref(0);
const selected = ref<ProductRow[]>([]);
const filters = reactive({ page: 1, limit: 20, store_name: "", is_show: "", is_verify: "" });

const categoryVisible = ref(false);
const categoryLoading = ref(false);
const categories = ref<ProductCategory[]>([]);
const categoryFormVisible = ref(false);
const categoryForm = reactive({ id: 0, pid: 0, cate_name: "", sort: 0, is_show: 1 });

const stockVisible = ref(false);
const stockLoading = ref(false);
const stockProduct = ref<ProductRow | null>(null);
const stockRows = ref<Array<ProductSku & { pm: 0 | 1; change: number }>>([]);

const flatCategories = computed(() => {
  const result: Array<ProductCategory & { label: string }> = [];
  const walk = (items: ProductCategory[]) => {
    for (const item of items) {
      result.push({ ...item, label: `${"— ".repeat(item.level)}${item.cate_name}` });
      walk(item.children ?? []);
    }
  };
  walk(categories.value);
  return result;
});

function errorMessage(error: unknown, fallback: string) {
  ElMessage.error(error instanceof Error ? error.message : fallback);
}

async function load() {
  loading.value = true;
  try {
    const result = await getProducts(filters);
    rows.value = result.list;
    total.value = result.count;
    selected.value = [];
  } catch (error) {
    errorMessage(error, "商品加载失败");
  } finally {
    loading.value = false;
  }
}

async function toggleShow(row: ProductRow) {
  const next = row.is_show ? 0 : 1;
  try {
    await setProductShow(row.id, next);
    row.is_show = next;
    ElMessage.success(next ? "商品已上架" : "商品已下架");
  } catch (error) {
    errorMessage(error, "状态更新失败");
  }
}

async function removeProduct(row: ProductRow) {
  try {
    await ElMessageBox.confirm(
      `“${row.store_name}”将下架并移入回收站，购物车中的该商品也会失效。`,
      "确认回收商品",
      { type: "warning", confirmButtonText: "移入回收站" },
    );
    await recycleProduct(row.id);
    ElMessage.success("商品已移入回收站");
    await load();
  } catch (error) {
    if (error !== "cancel" && error !== "close") errorMessage(error, "商品回收失败");
  }
}

async function applyBatch(isShow: number) {
  if (!selected.value.length) return ElMessage.warning("请先选择商品");
  try {
    const result = await batchSetProductShow(selected.value.map((item) => item.id), isShow);
    if (result.skipped_count) {
      ElMessage.warning(`已更新 ${result.updated} 件，另有 ${result.skipped_count} 件因未审核通过等原因跳过`);
    } else {
      ElMessage.success(`已${isShow ? "上架" : "下架"} ${result.updated} 件商品`);
    }
    await load();
  } catch (error) {
    errorMessage(error, "批量操作失败");
  }
}

async function openStock(row: ProductRow) {
  stockProduct.value = row;
  stockVisible.value = true;
  stockLoading.value = true;
  try {
    const detail = await getProductDetail(row.id);
    stockRows.value = detail.attrs.map((item) => ({ ...item, pm: 1, change: 0 }));
  } catch (error) {
    stockVisible.value = false;
    errorMessage(error, "SKU库存加载失败");
  } finally {
    stockLoading.value = false;
  }
}

async function submitStock() {
  if (!stockProduct.value) return;
  const attrs = stockRows.value
    .filter((item) => item.change > 0 && item.unique)
    .map((item) => ({ unique: item.unique!, pm: item.pm, stock: item.change }));
  if (!attrs.length) return ElMessage.warning("请至少填写一项大于0的调整数量");
  try {
    const result = await adjustProductStock(stockProduct.value.id, attrs);
    const adjustedProductId = stockProduct.value.id;
    stockVisible.value = false;
    await load();
    const refreshedRow = rows.value.find((item) => item.id === adjustedProductId);
    if (refreshedRow) refreshedRow.stock = result.stock;
    ElMessage.success(`库存调整成功，当前总库存 ${result.stock}`);
  } catch (error) {
    errorMessage(error, "库存调整失败");
  }
}

async function loadCategories() {
  categoryLoading.value = true;
  try {
    categories.value = await getProductCategories();
  } catch (error) {
    errorMessage(error, "分类加载失败");
  } finally {
    categoryLoading.value = false;
  }
}

async function openCategories() {
  categoryVisible.value = true;
  await loadCategories();
}

function editCategory(category?: ProductCategory, parentId = 0) {
  Object.assign(categoryForm, {
    id: category?.id ?? 0,
    pid: category?.pid ?? parentId,
    cate_name: category?.cate_name ?? "",
    sort: category?.sort ?? 0,
    is_show: category?.is_show ?? 1,
  });
  categoryFormVisible.value = true;
}

async function submitCategory() {
  if (!categoryForm.cate_name.trim()) return ElMessage.warning("请填写分类名称");
  try {
    await saveProductCategory(categoryForm.id, { ...categoryForm });
    categoryFormVisible.value = false;
    ElMessage.success(categoryForm.id ? "分类已更新" : "分类已创建");
    await loadCategories();
  } catch (error) {
    errorMessage(error, "分类保存失败");
  }
}

async function removeCategory(category: ProductCategory) {
  try {
    await ElMessageBox.confirm(`确认删除分类“${category.cate_name}”？仅空的末级分类可以删除。`, "删除分类", { type: "warning" });
    await deleteProductCategory(category.id);
    ElMessage.success("分类已删除");
    await loadCategories();
  } catch (error) {
    if (error !== "cancel" && error !== "close") errorMessage(error, "分类删除失败");
  }
}

function search() {
  filters.page = 1;
  void load();
}

function verifyLabel(value: number) {
  if (value === 1) return "已通过";
  if (value === -1) return "已拒绝";
  if (value === -2) return "强制下架";
  return "审核中";
}

onMounted(load);
</script>

<template>
  <section class="page-section products-page">
    <header class="page-heading products-heading">
      <div><h1>商品管理</h1><p>维护当前供应商的实物与卡密商品、SKU 和库存</p></div>
      <div class="heading-actions">
        <el-button type="warning" plain :icon="WarningFilled" @click="router.push('/products/virtual-alerts')">卡密预警</el-button>
        <el-button :icon="Setting" @click="openCategories">分类管理</el-button>
        <el-button type="primary" :icon="Plus" @click="router.push('/products/new')">新增商品</el-button>
      </div>
    </header>
    <div class="surface list-surface">
      <div class="filter-row product-filter-row">
        <el-input v-model="filters.store_name" class="search-input" clearable placeholder="搜索商品名称" @keyup.enter="search">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select v-model="filters.is_show" class="state-select" placeholder="上下架状态" clearable @change="search">
          <el-option label="已上架" value="1" /><el-option label="已下架" value="0" />
        </el-select>
        <el-select v-model="filters.is_verify" class="state-select" placeholder="审核状态" clearable @change="search">
          <el-option label="已通过" value="1" /><el-option label="审核中" value="0" /><el-option label="已拒绝" value="-1" /><el-option label="强制下架" value="-2" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <div class="batch-actions">
          <el-button :disabled="!selected.length" @click="applyBatch(1)">批量上架</el-button>
          <el-button :disabled="!selected.length" @click="applyBatch(0)">批量下架</el-button>
        </div>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id" class="product-table" @selection-change="selected = $event">
        <el-table-column type="selection" width="46" />
        <el-table-column label="商品" min-width="290">
          <template #default="scope">
            <div class="product-cell">
              <img v-if="scope.row.image" class="product-thumb product-image" :src="scope.row.image" alt="" />
              <div v-else class="product-thumb">{{ scope.row.store_name.slice(0, 1) }}</div>
              <div><strong>{{ scope.row.store_name }}</strong><span>ID {{ scope.row.id }}</span></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="价格" width="110"><template #default="scope">{{ formatMoney(scope.row.price) }}</template></el-table-column>
        <el-table-column prop="stock" label="库存" width="90" /><el-table-column prop="sales" label="销量" width="90" />
        <el-table-column label="审核" width="105"><template #default="scope"><span class="status-text" :class="scope.row.is_verify === 1 ? 'success' : scope.row.is_verify < 0 ? 'danger' : 'warning'">{{ verifyLabel(scope.row.is_verify) }}</span></template></el-table-column>
        <el-table-column label="上下架" width="90"><template #default="scope"><el-switch :model-value="Boolean(scope.row.is_show)" @change="toggleShow(scope.row)" /></template></el-table-column>
        <el-table-column label="创建时间" width="165"><template #default="scope">{{ formatTime(scope.row.add_time) }}</template></el-table-column>
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="scope">
            <el-button v-if="scope.row.product_type === 0" link type="primary" :icon="Edit" @click="router.push(`/products/${scope.row.id}/edit`)">编辑</el-button>
            <el-button
              v-if="scope.row.product_type === 1"
              link
              type="primary"
              :icon="Box"
              @click="router.push(`/products/${scope.row.id}/virtual-inventory`)"
            >卡密库存</el-button>
            <el-button v-else link type="primary" :icon="Box" @click="openStock(scope.row)">库存</el-button>
            <el-button link type="danger" :icon="Delete" @click="removeProduct(scope.row)">回收</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ total }} 件商品</span><el-pagination v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" /></div>
    </div>

    <el-dialog v-model="stockVisible" :title="`调整库存 · ${stockProduct?.store_name ?? ''}`" width="min(760px, 94vw)">
      <el-table v-loading="stockLoading" :data="stockRows" max-height="440">
        <el-table-column prop="suk" label="SKU" min-width="150" />
        <el-table-column prop="stock" label="当前库存" width="90" />
        <el-table-column label="方向" width="125"><template #default="scope"><el-select v-model="scope.row.pm"><el-option label="入库" :value="1" /><el-option label="出库" :value="0" /></el-select></template></el-table-column>
        <el-table-column label="数量" width="160"><template #default="scope"><el-input-number v-model="scope.row.change" :min="0" :max="2147483647" controls-position="right" /></template></el-table-column>
      </el-table>
      <p class="security-note">出库不会静默扣成负数；每一次有效调整都会写入库存审计记录。</p>
      <template #footer><el-button @click="stockVisible = false">取消</el-button><el-button type="primary" @click="submitStock">确认调整</el-button></template>
    </el-dialog>

    <el-dialog v-model="categoryVisible" title="供应商商品分类" width="min(860px, 96vw)">
      <div class="dialog-toolbar"><p>分类最多三级，只能选择本供应商自己的分类。</p><el-button type="primary" :icon="Plus" @click="editCategory()">新增一级分类</el-button></div>
      <el-table v-loading="categoryLoading" :data="categories" row-key="id" default-expand-all>
        <el-table-column prop="cate_name" label="分类名称" min-width="220" />
        <el-table-column prop="sort" label="排序" width="90" />
        <el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.is_show ? 'success' : 'info'">{{ scope.row.is_show ? "启用" : "停用" }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="240"><template #default="scope"><el-button link type="primary" @click="editCategory(scope.row)">编辑</el-button><el-button v-if="scope.row.level < 2" link type="primary" @click="editCategory(undefined, scope.row.id)">新增下级</el-button><el-button link type="danger" @click="removeCategory(scope.row)">删除</el-button></template></el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="categoryFormVisible" :title="categoryForm.id ? '编辑分类' : '新增分类'" width="min(520px, 94vw)" append-to-body>
      <el-form label-position="top">
        <el-form-item label="分类名称" required><el-input v-model="categoryForm.cate_name" maxlength="100" show-word-limit /></el-form-item>
        <el-form-item label="上级分类"><el-select v-model="categoryForm.pid" style="width: 100%"><el-option label="一级分类" :value="0" /><el-option v-for="item in flatCategories.filter((item) => item.id !== categoryForm.id && item.level < 2)" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
        <div class="form-grid"><el-form-item label="排序"><el-input-number v-model="categoryForm.sort" :min="0" /></el-form-item><el-form-item label="状态"><el-switch v-model="categoryForm.is_show" :active-value="1" :inactive-value="0" /></el-form-item></div>
      </el-form>
      <template #footer><el-button @click="categoryFormVisible = false">取消</el-button><el-button type="primary" @click="submitCategory">保存</el-button></template>
    </el-dialog>
  </section>
</template>
