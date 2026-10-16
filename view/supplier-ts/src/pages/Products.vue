<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Box, Delete, Edit, Plus, Search, Setting, WarningFilled } from "@element-plus/icons-vue";
import {
  adjustProductStock,
  batchSetProductShow,
  deleteProductCategory,
  getProductCategories,
  getProductCategoryDetail,
  getProductDetail,
  getProducts,
  recycleProduct,
  saveProductCategory,
  setProductCategoryShow,
  setProductShow,
  previewMode,
} from "@/api/supplier";
import type { ProductCategory, ProductCategoryPayload, ProductRow, ProductSku } from "@/types";
import { formatMoney, formatTime } from "@/utils/format";
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { productImagePreview } from '@/utils/productMedia';
import ProductBatchDialog from '@/components/ProductBatchDialog.vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const loading = ref(false);
const rows = ref<ProductRow[]>([]);
const total = ref(0);
const productWriting = ref(false), productFresh = ref(false);
let productReadGeneration = 0;
const selected = ref<ProductRow[]>([]);
const batchVisible = ref(false);
const filters = reactive({ page: 1, limit: 20, store_name: "", is_show: "", is_verify: "" });

const categoryVisible = ref(false);
const categoryLoading = ref(false);
const categories = ref<ProductCategory[]>([]);
const categoryFormVisible = ref(false);
const categoryFormLoading = ref(false), categoryWriting = ref(false), categoryFresh = ref(false);
const categoryError = ref(''), categoryInvalidated = ref(false);
const failedCategoryImages = ref(new Set<string>());
const blankCategory = () => ({ id: 0, pid: 0, cate_name: '', pic: '', big_pic: '', sort: 0, is_show: 1, expected_revision: '' });
const categoryForm = reactive(blankCategory());
let categoryReadGeneration = 0, categoryFormGeneration = 0, categoryWriteGeneration = 0, categoryContextGeneration = 0;
const categorySession = createSupplierSessionScope(() => {
  categoryInvalidated.value = true;
  clearCategoryContext();
  rows.value = []; selected.value = []; total.value = 0; productFresh.value = false; productWriting.value = false; productReadGeneration++;
}, previewMode);
const canViewCategories = computed(() => !categoryInvalidated.value && auth.can('supplier.product.view'));
const canManageCategories = computed(() => !categoryInvalidated.value && auth.can('supplier.product.manage'));
const categoryControlsDisabled = computed(() => categoryLoading.value || categoryFormLoading.value || categoryWriting.value || !categoryFresh.value);

function clearCategoryContext() {
  productReadGeneration++; productFresh.value = false; productWriting.value = false; rows.value = []; selected.value = []; total.value = 0;
  categoryContextGeneration += 1; categoryReadGeneration += 1; categoryFormGeneration += 1; categoryWriteGeneration += 1;
  categoryVisible.value = false; categoryFormVisible.value = false;
  categoryLoading.value = false; categoryFormLoading.value = false; categoryWriting.value = false;
  loading.value = false;
  categories.value = []; categoryFresh.value = false; categoryError.value = ''; failedCategoryImages.value = new Set();
  Object.assign(categoryForm, blankCategory());
}
function categoryContext() { return { generation: categoryContextGeneration, url: route.fullPath }; }
function categoryCurrent(context: ReturnType<typeof categoryContext>, manage = false) {
  return categorySession.isCurrent() && context.generation === categoryContextGeneration && context.url === route.fullPath
    && (manage ? canManageCategories.value : canViewCategories.value);
}
function copyProduct(row: ProductRow) {
  if (!categoryCurrent(categoryContext(), true) || !productFresh.value || loading.value || productWriting.value
    || ![0, 1, 3].includes(row.product_type) || !rows.value.some(current => current.id === row.id)
    || !Number.isSafeInteger(row.id) || row.id <= 0) return;
  void router.push({ path: '/products/new', query: { copy: String(row.id) } });
}
watch(() => route.fullPath, clearCategoryContext, { flush: 'sync' });
watch(categoryVisible, visible => {
  if (!visible) { categoryReadGeneration += 1; categoryFormGeneration += 1; categoryFormVisible.value = false; categoryLoading.value = false; }
}, { flush: 'sync' });
watch(categoryFormVisible, visible => {
  if (!visible) { categoryFormGeneration += 1; categoryFormLoading.value = false; Object.assign(categoryForm, blankCategory()); }
}, { flush: 'sync' });
watch(() => [categoryForm.pic, categoryForm.big_pic], () => { failedCategoryImages.value = new Set(); });
onBeforeUnmount(() => { clearCategoryContext(); categorySession.dispose(); });

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
const categoryParentOptions = computed(() => {
  const descendants = new Set<number>();
  let subtreeHeight = 0;
  const selected = flatCategories.value.find(item => item.id === categoryForm.id);
  const walk = (item: ProductCategory, depth: number) => {
    descendants.add(item.id); subtreeHeight = Math.max(subtreeHeight, depth);
    for (const child of item.children ?? []) walk(child, depth + 1);
  };
  if (selected) walk(selected, 0);
  return flatCategories.value.filter(item => !descendants.has(item.id) && item.level + 1 + subtreeHeight <= 2);
});
function categoryPreview(reference: string) {
  if (!categorySession.isCurrent() || !canViewCategories.value) return null;
  const source = productImagePreview(reference, {});
  return source && !failedCategoryImages.value.has(source) ? source : null;
}
function categoryImageFailed(event: Event) {
  if (!categorySession.isCurrent()) return;
  const source = (event.currentTarget as HTMLImageElement | null)?.getAttribute('src');
  if (source) failedCategoryImages.value = new Set([...failedCategoryImages.value, source]);
}

function errorMessage(error: unknown, fallback: string) {
  ElMessage.error(error instanceof Error ? error.message : fallback);
}

async function load() {
  const context = categoryContext(), generation = ++productReadGeneration;
  loading.value = true; productFresh.value = false;
  try {
    const result = await getProducts({ ...filters });
    if (!categoryCurrent(context) || generation !== productReadGeneration) return;
    productFresh.value = true;
    rows.value = result.list;
    total.value = result.count;
    selected.value = [];
  } catch (error) {
    if (categoryCurrent(context) && generation === productReadGeneration) errorMessage(error, "商品加载失败");
  } finally {
    if (categoryCurrent(context) && generation === productReadGeneration) loading.value = false;
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
  const context = categoryContext(), generation = productReadGeneration, query = JSON.stringify(filters);
  if (!categoryCurrent(context, true) || productWriting.value || !productFresh.value || !rows.value.some(item => item.id === row.id)) return;
  productWriting.value = true;
  let sent = false;
  try {
    await ElMessageBox.confirm(
      `“${row.store_name}”将下架并移入回收站，购物车中的该商品也会失效。`,
      "确认回收商品",
      { type: "warning", confirmButtonText: "移入回收站" },
    );
    if (!categoryCurrent(context, true) || generation !== productReadGeneration || query !== JSON.stringify(filters)) return;
    sent = true; productFresh.value = false;
    const result = await recycleProduct(row.id) as { id?: number; operation?: string; is_del?: number } | null;
    if (!categoryCurrent(context, true)) return;
    if (result?.id !== row.id || result.operation !== 'recycle' || result.is_del !== 1) throw new Error('回收回执不完整，请刷新列表或回收站核对');
    ElMessage.success("商品已移入回收站");
    await load();
  } catch (error) {
    if (categoryCurrent(context, true) && error !== "cancel" && error !== "close") {
      errorMessage(error, sent ? "回收结果未确认，请查询商品列表或回收站核对后再操作" : "商品回收失败");
    }
  } finally { if (categoryCurrent(context)) productWriting.value = false; }
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
  const context = categoryContext(), generation = ++categoryReadGeneration;
  if (!categoryCurrent(context) || !categoryVisible.value) return false;
  categoryLoading.value = true;
  categoryError.value = '';
  try {
    const result = await getProductCategories();
    if (!categoryCurrent(context) || generation !== categoryReadGeneration || !categoryVisible.value) return false;
    categories.value = result; categoryFresh.value = true; failedCategoryImages.value = new Set();
    return true;
  } catch (error) {
    if (categoryCurrent(context) && generation === categoryReadGeneration) {
      categoryError.value = error instanceof Error ? error.message : '分类加载失败'; categoryFresh.value = false;
      errorMessage(error, "分类加载失败");
    }
    return false;
  } finally {
    if (categoryCurrent(context) && generation === categoryReadGeneration) categoryLoading.value = false;
  }
}

async function openCategories() {
  if (!categorySession.isCurrent() || !canViewCategories.value) return;
  categoryVisible.value = true;
  categoryFresh.value = false;
  await loadCategories();
}

async function editCategory(category?: ProductCategory, parentId = 0) {
  const context = categoryContext();
  if (!categoryCurrent(context, true) || categoryControlsDisabled.value || !categoryVisible.value) return;
  const parent = flatCategories.value.find(item => item.id === parentId);
  if (parentId && (!parent || parent.level >= 2)) return;
  const generation = ++categoryFormGeneration;
  Object.assign(categoryForm, blankCategory(), { pid: parentId });
  categoryFormVisible.value = true;
  if (!category) return;
  categoryFormLoading.value = true;
  try {
    const detail = await getProductCategoryDetail(category.id);
    if (!categoryCurrent(context, true) || generation !== categoryFormGeneration || !categoryFormVisible.value) return;
    if (detail.id !== category.id || !detail.revision) throw new Error('分类版本信息缺失，请刷新后重试');
    Object.assign(categoryForm, { id: detail.id, pid: detail.pid, cate_name: detail.cate_name, pic: detail.pic ?? '',
      big_pic: detail.big_pic ?? '', sort: detail.sort, is_show: detail.is_show, expected_revision: detail.revision });
  } catch (error) {
    if (categoryCurrent(context, true) && generation === categoryFormGeneration) {
      categoryFormVisible.value = false; errorMessage(error, '分类详情加载失败');
    }
  } finally {
    if (generation === categoryFormGeneration) categoryFormLoading.value = false;
  }
}

async function submitCategory() {
  const context = categoryContext(), formGeneration = categoryFormGeneration;
  if (!categoryCurrent(context, true) || categoryControlsDisabled.value || !categoryFormVisible.value) return;
  const name = categoryForm.cate_name.trim();
  if (!name || [...name].length > 30) return ElMessage.warning('分类名称需为1至30个字符');
  if (!Number.isInteger(categoryForm.sort) || categoryForm.sort < 0 || categoryForm.sort > 1_000_000) return ElMessage.warning('排序需为0至1000000的整数');
  if (categoryForm.pid !== 0 && !categoryParentOptions.value.some(item => item.id === categoryForm.pid)) return ElMessage.warning('上级分类不可用，分类最多三级');
  if (categoryForm.is_show && categoryForm.pid && !flatCategories.value.find(item => item.id === categoryForm.pid)?.is_show) return ElMessage.warning('父级分类已停用，不能启用下级分类');
  if (flatCategories.value.some(item => item.id !== categoryForm.id && item.pid === categoryForm.pid && item.cate_name === name)) return ElMessage.warning('同一上级下分类名称不能重复');
  if (![0, 1].includes(categoryForm.is_show)) return ElMessage.warning('分类状态无效');
  for (const [reference, maximum] of [[categoryForm.pic, 512], [categoryForm.big_pic, 255]] as const) {
    if (reference.length > maximum || (reference && !productImagePreview(reference, {}))) return ElMessage.warning('图片地址需为HTTPS或安全公共站内路径，且不能超过字段长度');
  }
  const id = categoryForm.id;
  if (id && !categoryForm.expected_revision) return ElMessage.warning('分类版本信息缺失，请刷新后重试');
  const payload: ProductCategoryPayload = { pid: categoryForm.pid, cate_name: name, pic: categoryForm.pic, big_pic: categoryForm.big_pic,
    sort: categoryForm.sort, is_show: categoryForm.is_show, ...(id ? { expected_revision: categoryForm.expected_revision } : {}) };
  const generation = ++categoryWriteGeneration;
  categoryWriting.value = true;
  try {
    await saveProductCategory(id, payload);
    if (!categoryCurrent(context, true) || generation !== categoryWriteGeneration || formGeneration !== categoryFormGeneration) return;
    categoryFresh.value = false;
    categoryFormVisible.value = false;
    ElMessage.success(id ? "分类已更新" : "分类已创建");
    await loadCategories();
  } catch (error) {
    if (categoryCurrent(context, true) && generation === categoryWriteGeneration && formGeneration === categoryFormGeneration) {
      errorMessage(error, "分类保存失败");
      categoryFresh.value = false;
      categoryError.value = '保存未确认。草稿已保留，请刷新分类并核对结果后再操作。';
    }
  } finally {
    if (generation === categoryWriteGeneration) categoryWriting.value = false;
  }
}

async function removeCategory(category: ProductCategory) {
  await changeCategory(category, 'delete');
}
async function toggleCategoryShow(category: ProductCategory) {
  await changeCategory(category, 'show');
}
async function changeCategory(category: ProductCategory, action: 'delete' | 'show') {
  const context = categoryContext();
  if (!categoryCurrent(context, true) || categoryControlsDisabled.value || !categoryVisible.value) return;
  const row = flatCategories.value.find(item => item.id === category.id);
  if (!row?.revision) return ElMessage.warning('分类版本信息缺失，请刷新后重试');
  if (action === 'delete' && row.children?.length) return ElMessage.warning('请先删除下级分类');
  const generation = ++categoryWriteGeneration, next = row.is_show ? 0 : 1;
  if (action === 'show' && next && row.pid && !flatCategories.value.find(item => item.id === row.pid)?.is_show) return ElMessage.warning('请先启用父级分类');
  categoryWriting.value = true;
  let sent = false;
  try {
    await ElMessageBox.confirm(action === 'delete'
      ? `确认删除分类“${row.cate_name}”？仅没有子级且未被商品、标签或历史分类映射引用的分类可以删除。`
      : `确认${next ? '启用' : '停用'}“${row.cate_name}”？该分类及全部子级将同步${next ? '启用' : '停用'}。`,
    action === 'delete' ? '删除分类' : '调整分类状态', { type: 'warning', confirmButtonText: action === 'delete' ? '确认删除' : '确认调整' });
    if (!categoryCurrent(context, true) || generation !== categoryWriteGeneration || !categoryVisible.value) return;
    sent = true;
    if (action === 'delete') await deleteProductCategory(row.id, row.revision);
    else await setProductCategoryShow(row.id, next, row.revision);
    if (!categoryCurrent(context, true) || generation !== categoryWriteGeneration) return;
    categoryFresh.value = false;
    ElMessage.success(action === 'delete' ? '分类已删除' : `分类及全部子级已${next ? '启用' : '停用'}`);
    await loadCategories();
  } catch (error) {
    if (categoryCurrent(context, true) && generation === categoryWriteGeneration && error !== 'cancel' && error !== 'close') {
      errorMessage(error, action === 'delete' ? '分类删除失败' : '分类状态调整失败');
      if (sent) { categoryFresh.value = false; categoryError.value = '操作未确认，请刷新分类并核对结果后再操作。'; }
    }
  } finally {
    if (generation === categoryWriteGeneration) categoryWriting.value = false;
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
        <el-button v-if="canViewCategories" :icon="Delete" @click="router.push('/products/recycle')">回收站</el-button>
        <el-button v-if="canViewCategories" @click="router.push('/products/copy-result')">复制操作结果</el-button>
        <el-button v-if="canViewCategories" :icon="Setting" @click="openCategories">分类管理</el-button>
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
          <el-button v-if="canManageCategories" :disabled="loading" @click="batchVisible = true">批量设置</el-button>
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
        <el-table-column label="操作" width="400" fixed="right">
          <template #default="scope">
            <el-button v-if="[0, 1, 3].includes(scope.row.product_type)" link type="primary" :icon="Edit" @click="router.push(`/products/${scope.row.id}/edit`)">编辑</el-button>
            <el-button v-if="canManageCategories && [0, 1, 3].includes(scope.row.product_type)" link type="primary" :disabled="!productFresh || productWriting || loading" @click="copyProduct(scope.row)">复制</el-button>
            <el-button
              v-if="scope.row.product_type === 1"
              link
              type="primary"
              :icon="Box"
              @click="router.push(`/products/${scope.row.id}/virtual-inventory`)"
            >卡密库存</el-button>
            <el-button v-if="scope.row.product_type === 0 || scope.row.product_type === 3" link type="primary" :icon="Box" @click="openStock(scope.row)">库存</el-button>
            <el-button v-if="canManageCategories" link type="danger" :icon="Delete" :disabled="productWriting || !productFresh" @click="removeProduct(scope.row)">回收</el-button>
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

    <el-dialog v-if="canViewCategories" v-model="categoryVisible" title="供应商商品分类" width="min(980px, 96vw)" :close-on-click-modal="!categoryWriting" :close-on-press-escape="!categoryWriting" :show-close="!categoryWriting">
      <div class="dialog-toolbar category-toolbar"><p>分类最多三级；只能管理当前供应商的分类。</p><div><el-button :loading="categoryLoading" :disabled="categoryWriting || categoryFormLoading" @click="loadCategories">刷新分类</el-button><el-button v-if="canManageCategories" type="primary" :icon="Plus" :disabled="categoryControlsDisabled" @click="editCategory()">新增一级分类</el-button></div></div>
      <el-alert v-if="previewMode" title="当前为预览模式" description="仅模拟示例分类与商品；真实商品、标签和历史映射的引用检查由服务端执行。" type="info" :closable="false" class="category-alert" />
      <el-alert v-if="categoryError" :title="categoryError" type="warning" :closable="false" class="category-alert" />
      <el-table v-loading="categoryLoading" :data="categories" row-key="id" default-expand-all>
        <el-table-column prop="cate_name" label="分类名称" min-width="220" />
        <el-table-column label="分类图片" width="100"><template #default="scope"><img v-if="categoryPreview(scope.row.pic)" class="category-thumb" :src="categoryPreview(scope.row.pic)!" :alt="`${scope.row.cate_name}分类图片`" referrerpolicy="no-referrer" @error="categoryImageFailed" /><span v-else class="category-image-empty">{{ scope.row.pic ? '图片不可用' : '未设置' }}</span></template></el-table-column>
        <el-table-column label="大图" width="100"><template #default="scope"><img v-if="categoryPreview(scope.row.big_pic)" class="category-thumb" :src="categoryPreview(scope.row.big_pic)!" :alt="`${scope.row.cate_name}分类大图`" referrerpolicy="no-referrer" @error="categoryImageFailed" /><span v-else class="category-image-empty">{{ scope.row.big_pic ? '图片不可用' : '未设置' }}</span></template></el-table-column>
        <el-table-column prop="sort" label="排序" width="90" />
        <el-table-column label="状态" width="95"><template #default="scope"><el-tag :type="scope.row.is_show ? 'success' : 'info'">{{ scope.row.is_show ? "启用" : "停用" }}</el-tag></template></el-table-column>
        <el-table-column v-if="canManageCategories" label="操作" width="300"><template #default="scope"><el-button link type="primary" :disabled="categoryControlsDisabled" @click="editCategory(scope.row)">编辑</el-button><el-button v-if="scope.row.level < 2" link type="primary" :disabled="categoryControlsDisabled" @click="editCategory(undefined, scope.row.id)">新增下级</el-button><el-button link type="warning" :disabled="categoryControlsDisabled" @click="toggleCategoryShow(scope.row)">{{ scope.row.is_show ? '停用' : '启用' }}</el-button><el-button link type="danger" :disabled="categoryControlsDisabled || !!scope.row.children?.length" @click="removeCategory(scope.row)">删除</el-button></template></el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-if="canManageCategories" v-model="categoryFormVisible" :title="categoryForm.id ? '编辑分类' : '新增分类'" width="min(580px, 94vw)" append-to-body :close-on-click-modal="!categoryWriting" :close-on-press-escape="!categoryWriting" :show-close="!categoryWriting">
      <el-form v-loading="categoryFormLoading" class="category-form-fields" label-position="top" :disabled="categoryWriting || categoryFormLoading">
        <el-form-item label="分类名称" required><el-input v-model="categoryForm.cate_name" maxlength="30" show-word-limit /></el-form-item>
        <el-form-item label="上级分类"><el-select v-model="categoryForm.pid" style="width: 100%"><el-option label="一级分类" :value="0" /><el-option v-for="item in categoryParentOptions" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
        <el-form-item label="分类图片地址"><el-input v-model="categoryForm.pic" maxlength="512" clearable placeholder="HTTPS或公共站内图片路径" /><div class="category-preview"><img v-if="categoryPreview(categoryForm.pic)" :src="categoryPreview(categoryForm.pic)!" alt="分类图片预览" referrerpolicy="no-referrer" @error="categoryImageFailed" /><span v-else>{{ categoryForm.pic ? '图片暂不可用' : '未设置分类图片' }}</span></div></el-form-item>
        <el-form-item label="分类大图地址"><el-input v-model="categoryForm.big_pic" maxlength="255" clearable placeholder="HTTPS或公共站内图片路径" /><div class="category-preview"><img v-if="categoryPreview(categoryForm.big_pic)" :src="categoryPreview(categoryForm.big_pic)!" alt="分类大图预览" referrerpolicy="no-referrer" @error="categoryImageFailed" /><span v-else>{{ categoryForm.big_pic ? '图片暂不可用' : '未设置分类大图' }}</span></div></el-form-item>
        <div class="form-grid"><el-form-item label="排序"><el-input-number v-model="categoryForm.sort" :min="0" :max="1000000" :precision="0" /></el-form-item><el-form-item label="状态"><el-switch v-model="categoryForm.is_show" :active-value="1" :inactive-value="0" /></el-form-item></div>
        <el-alert title="修改状态时全部子级也会同步启用或停用" type="info" :closable="false" show-icon />
        <el-alert v-if="categoryError" :title="categoryError" type="warning" :closable="false" class="category-alert" />
      </el-form>
      <template #footer><el-button :disabled="categoryWriting" @click="categoryFormVisible = false">取消</el-button><el-button v-if="categoryError" :loading="categoryLoading" :disabled="categoryWriting" @click="loadCategories">刷新并核对</el-button><el-button type="primary" :loading="categoryWriting" :disabled="categoryControlsDisabled" @click="submitCategory">保存</el-button></template>
    </el-dialog>
    <ProductBatchDialog v-if="batchVisible && canManageCategories" :selected-ids="selected.map(item => item.id)" :filters="{ ...filters }" @close="batchVisible = false" @changed="load" />
  </section>
</template>

<style scoped>
.category-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.category-toolbar p { margin: 0; color: var(--text-muted); }
.category-toolbar > div { display: flex; flex-wrap: wrap; gap: 8px; }
.category-toolbar .el-button + .el-button { margin-left: 0; }
.category-alert { margin-bottom: 14px; }
.category-thumb { width: 46px; height: 46px; object-fit: contain; border-radius: 6px; }
.category-image-empty { color: var(--text-muted); font-size: 12px; }
.category-preview { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 82px; margin-top: 8px; border: 1px dashed var(--border); border-radius: 8px; background: var(--surface); color: var(--text-muted); font-size: 12px; }
.category-preview img { max-width: 100%; max-height: 140px; object-fit: contain; }
@media (max-width: 600px) {
  .category-toolbar { align-items: flex-start; flex-direction: column; }
  .category-form-fields { max-height: calc(70dvh - 110px); overflow-y: auto; padding-right: 4px; }
  .category-preview { min-height: 72px; }
  .category-preview img { max-height: 82px; }
}
</style>
