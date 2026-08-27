<template>
  <section class="discount-manager">
    <div class="toolbar">
      <el-form :inline="true" :model="filters">
        <el-form-item label="套餐名称">
          <el-input v-model="filters.title" clearable placeholder="名称关键字" @keyup.enter="search" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="filters.type" clearable placeholder="全部" style="width: 130px">
            <el-option label="固定套餐" :value="0" />
            <el-option label="搭配套餐" :value="1" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 120px">
            <el-option label="启用" :value="1" />
            <el-option label="停用" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="search">查询</el-button>
          <el-button @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>
      <el-button type="primary" @click="openCreate">＋ 新增优惠套餐</el-button>
    </div>

    <el-alert
      title="套餐价格和库存由后台依据基础商品 SKU 校验；已过期、必选商品失效或库存不足时，前台不会展示。"
      type="info"
      :closable="false"
      show-icon
      class="notice"
    />

    <el-table :data="rows" v-loading="loading" border class="desktop-table">
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column label="套餐" min-width="260">
        <template #default="{ row }">
          <div class="package-cell">
            <el-image :src="row.image" fit="cover" class="package-image" />
            <div>
              <strong>{{ row.title }}</strong>
              <small>{{ row.type === 0 ? "固定套餐" : "搭配套餐" }} · {{ row.product_count }} 件商品</small>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="必选最低价" width="120">
        <template #default="{ row }">¥{{ row.min_price }}</template>
      </el-table-column>
      <el-table-column label="剩余套餐量" width="120">
        <template #default="{ row }">{{ row.is_limit ? row.limit_num : "不限" }}</template>
      </el-table-column>
      <el-table-column label="配置状态" min-width="170">
        <template #default="{ row }">
          <el-tag :type="row.status === 1 ? 'success' : 'info'">
            {{ row.status === 1 ? "已启用" : "已停用" }}
          </el-tag>
          <el-tag v-if="row.status === 1 && !row.available" type="danger" class="state-tag">
            {{ row.invalid_reason }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="210">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row.id)">编辑</el-button>
          <el-button
            link
            :type="row.status === 1 ? 'warning' : 'success'"
            @click="toggleStatus(row)"
          >
            {{ row.status === 1 ? "停用" : "启用" }}
          </el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-loading="loading" class="mobile-package-list">
      <el-card v-for="row in rows" :key="row.id" shadow="never" class="mobile-package-card">
        <div class="package-cell">
          <el-image :src="row.image" fit="cover" class="package-image" />
          <div>
            <strong>{{ row.title }}</strong>
            <small>{{ row.type === 0 ? "固定套餐" : "搭配套餐" }} · {{ row.product_count }} 件商品</small>
          </div>
        </div>
        <div class="mobile-package-meta">
          <span>必选最低价 <b>¥{{ row.min_price }}</b></span>
          <span>剩余 {{ row.is_limit ? row.limit_num : "不限" }}</span>
        </div>
        <div class="mobile-package-state">
          <el-tag :type="row.status === 1 ? 'success' : 'info'">
            {{ row.status === 1 ? "已启用" : "已停用" }}
          </el-tag>
          <el-tag v-if="row.status === 1 && !row.available" type="danger">{{ row.invalid_reason }}</el-tag>
        </div>
        <div class="mobile-package-actions">
          <el-button link type="primary" @click="openEdit(row.id)">编辑</el-button>
          <el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleStatus(row)">
            {{ row.status === 1 ? "停用" : "启用" }}
          </el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </div>
      </el-card>
    </div>
    <el-empty v-if="!loading && !rows.length" description="暂无优惠套餐" />
    <el-pagination
      v-if="total > filters.limit"
      v-model:current-page="filters.page"
      v-model:page-size="filters.limit"
      :total="total"
      layout="total, prev, pager, next"
      class="pagination"
      @current-change="load"
    />

    <el-dialog
      v-model="dialogVisible"
      :title="form.id ? '编辑优惠套餐' : '新增优惠套餐'"
      width="min(1080px, 94vw)"
      destroy-on-close
      @closed="resetForm"
    >
      <el-form :model="form" label-width="112px" class="package-form">
        <div class="form-grid">
          <el-form-item label="套餐名称" required>
            <el-input v-model="form.title" maxlength="255" show-word-limit />
          </el-form-item>
          <el-form-item label="套餐图片" required>
            <el-input v-model="form.image" maxlength="500" placeholder="HTTPS 或素材中心图片地址" />
          </el-form-item>
          <el-form-item label="套餐类型" required>
            <el-radio-group v-model="form.type" @change="onTypeChange">
              <el-radio-button :value="0">固定套餐</el-radio-button>
              <el-radio-button :value="1">搭配套餐</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="排序">
            <el-input-number v-model="form.sort" :min="0" :max="2147483647" />
          </el-form-item>
          <el-form-item label="限量">
            <el-switch v-model="form.isLimit" />
            <el-input-number
              v-if="form.isLimit"
              v-model="form.limitNum"
              :min="1"
              :max="2147483647"
              class="inline-number"
            />
          </el-form-item>
          <el-form-item label="有效期">
            <el-switch v-model="form.isTime" />
            <el-date-picker
              v-if="form.isTime"
              v-model="form.time"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              class="date-range"
            />
          </el-form-item>
          <el-form-item label="用户标签">
            <el-select v-model="form.linkIds" multiple collapse-tags clearable placeholder="全部用户可见">
              <el-option v-for="label in labels" :key="label.id" :label="label.name" :value="label.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="销售选项">
            <el-checkbox v-model="form.freeShipping">套餐包邮</el-checkbox>
            <el-checkbox v-model="form.supportRefund">支持退款</el-checkbox>
            <el-checkbox v-model="form.status">立即启用</el-checkbox>
          </el-form-item>
        </div>

        <el-divider content-position="left">套餐商品与规格</el-divider>
        <el-form-item label="选择商品" required>
          <el-select
            v-model="selectedProductIds"
            multiple
            filterable
            remote
            reserve-keyword
            :remote-method="loadProductOptions"
            :loading="productLoading"
            placeholder="输入商品名称或 ID，至少选择两个"
            class="product-select"
            @change="onProductSelection"
          >
            <el-option
              v-for="product in productOptions"
              :key="product.id"
              :label="`${product.store_name}（ID ${product.id}，库存 ${product.stock}）`"
              :value="product.id"
            />
          </el-select>
        </el-form-item>

        <div v-for="product in selectedProducts" :key="product.productId" class="product-card">
          <div class="product-head">
            <div class="package-cell">
              <el-image :src="product.image" fit="cover" class="package-image" />
              <div>
                <strong>{{ product.storeName }}</strong>
                <small>ID {{ product.productId }} · 商品库存 {{ product.stock }}</small>
              </div>
            </div>
            <el-radio
              v-if="form.type === 1"
              v-model="requiredProductId"
              :value="product.productId"
            >
              主商品（必选）
            </el-radio>
            <el-tag v-else type="info">固定套餐必选</el-tag>
          </div>
          <el-table :data="product.skus" size="small" border>
            <el-table-column label="选择" width="70">
              <template #default="{ row }"><el-checkbox v-model="row.selected" /></template>
            </el-table-column>
            <el-table-column prop="suk" label="规格" min-width="180" />
            <el-table-column label="基础售价" width="110">
              <template #default="{ row }">¥{{ row.basePrice }}</template>
            </el-table-column>
            <el-table-column prop="stock" label="库存" width="90" />
            <el-table-column label="套餐价" width="180">
              <template #default="{ row }">
                <el-input v-model="row.packagePrice" :disabled="!row.selected" placeholder="0.00">
                  <template #prepend>¥</template>
                </el-input>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存套餐</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiDiscountPackageDelete,
  apiDiscountPackageDetail,
  apiDiscountPackageLabels,
  apiDiscountPackageList,
  apiDiscountPackageProducts,
  apiDiscountPackageSave,
  apiDiscountPackageStatus,
  type DiscountPackageListItem,
  type DiscountPackagePayload,
  type DiscountPackageProductOption,
} from "@/api/discountPackage";

interface EditableSku {
  unique: string;
  suk: string;
  basePrice: string;
  stock: number;
  selected: boolean;
  packagePrice: string;
}

interface EditableProduct {
  productId: number;
  storeName: string;
  image: string;
  stock: number;
  skus: EditableSku[];
}

const loading = ref(false);
const rows = ref<DiscountPackageListItem[]>([]);
const total = ref(0);
const filters = reactive<{ page: number; limit: number; title: string; type: number | ""; status: number | "" }>({
  page: 1,
  limit: 20,
  title: "",
  type: "",
  status: "",
});

const dialogVisible = ref(false);
const saving = ref(false);
const labels = ref<Array<{ id: number; name: string }>>([]);
const productLoading = ref(false);
const productOptions = ref<DiscountPackageProductOption[]>([]);
const selectedProductIds = ref<number[]>([]);
const selectedProducts = ref<EditableProduct[]>([]);
const requiredProductId = ref(0);
const form = reactive({
  id: 0,
  title: "",
  image: "",
  type: 0,
  isLimit: false,
  limitNum: 1,
  isTime: false,
  time: [] as string[],
  linkIds: [] as number[],
  sort: 0,
  freeShipping: true,
  supportRefund: true,
  status: true,
});

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function load() {
  loading.value = true;
  try {
    const data = await apiDiscountPackageList(filters);
    rows.value = data.list;
    total.value = data.count;
  } catch (error) {
    ElMessage.error(message(error, "加载优惠套餐失败"));
  } finally {
    loading.value = false;
  }
}

function search() {
  filters.page = 1;
  void load();
}

function resetFilters() {
  filters.title = "";
  filters.type = "";
  filters.status = "";
  search();
}

function resetForm() {
  Object.assign(form, {
    id: 0,
    title: "",
    image: "",
    type: 0,
    isLimit: false,
    limitNum: 1,
    isTime: false,
    time: [],
    linkIds: [],
    sort: 0,
    freeShipping: true,
    supportRefund: true,
    status: true,
  });
  selectedProductIds.value = [];
  selectedProducts.value = [];
  requiredProductId.value = 0;
  productOptions.value = [];
}

function editableProduct(option: DiscountPackageProductOption): EditableProduct {
  return {
    productId: option.id,
    storeName: option.store_name,
    image: option.image,
    stock: option.stock,
    skus: option.skus.map((sku) => ({
      unique: sku.unique,
      suk: sku.suk || "默认",
      basePrice: sku.price,
      stock: sku.stock,
      selected: false,
      packagePrice: sku.price,
    })),
  };
}

async function loadProductOptions(keyword = "") {
  productLoading.value = true;
  try {
    const data = await apiDiscountPackageProducts({ page: 1, limit: 100, keyword });
    const retained = productOptions.value.filter((option) => selectedProductIds.value.includes(option.id));
    productOptions.value = [...new Map([...retained, ...data.list].map((option) => [option.id, option])).values()];
  } catch (error) {
    ElMessage.error(message(error, "加载商品失败"));
  } finally {
    productLoading.value = false;
  }
}

function onProductSelection(ids: number[]) {
  const current = new Map(selectedProducts.value.map((product) => [product.productId, product]));
  const options = new Map(productOptions.value.map((option) => [option.id, option]));
  selectedProducts.value = ids.map((id) => current.get(id) ?? (options.has(id) ? editableProduct(options.get(id)!) : null))
    .filter((product): product is EditableProduct => product !== null);
  if (!ids.includes(requiredProductId.value)) requiredProductId.value = ids[0] ?? 0;
}

function onTypeChange() {
  requiredProductId.value = form.type === 1 ? selectedProductIds.value[0] ?? 0 : 0;
}

async function ensureLabels() {
  if (labels.value.length) return;
  labels.value = await apiDiscountPackageLabels();
}

async function openCreate() {
  resetForm();
  dialogVisible.value = true;
  try {
    await Promise.all([ensureLabels(), loadProductOptions()]);
  } catch (error) {
    ElMessage.error(message(error, "加载套餐表单失败"));
  }
}

async function openEdit(id: number) {
  resetForm();
  dialogVisible.value = true;
  productLoading.value = true;
  try {
    const [detail] = await Promise.all([apiDiscountPackageDetail(id), ensureLabels()]);
    Object.assign(form, {
      id: detail.id,
      title: detail.title,
      image: detail.image,
      type: detail.type,
      isLimit: detail.is_limit === 1,
      limitNum: Math.max(1, detail.limit_num),
      isTime: detail.is_time === 1,
      time: detail.time ?? [],
      linkIds: detail.link_id_values ?? [],
      sort: detail.sort,
      freeShipping: detail.free_shipping === 1,
      supportRefund: detail.is_support_refund === 1,
      status: detail.status === 1,
    });
    const editOptions: DiscountPackageProductOption[] = detail.products.map((entry) => ({
      id: entry.product_id,
      product_id: entry.product_id,
      store_name: entry.store_name,
      image: entry.image,
      price: entry.product?.price ?? entry.skus[0]?.p_price ?? "0.00",
      ot_price: entry.product?.otPrice ?? "0.00",
      stock: entry.product?.stock ?? Math.max(0, ...entry.skus.map((sku) => sku.stock)),
      product_type: entry.product_type,
      spec_type: entry.product?.specType ?? 0,
      temp_id: entry.temp_id,
      skus: entry.skus.map((sku) => ({
        unique: sku.base_unique,
        suk: sku.suk,
        price: sku.p_price,
        ot_price: sku.p_price,
        stock: sku.stock,
        image: sku.image,
      })),
    }));
    productOptions.value = editOptions;
    selectedProductIds.value = editOptions.map((option) => option.id);
    selectedProducts.value = editOptions.map((option, index) => {
      const editable = editableProduct(option);
      const selectedByUnique = new Map(detail.products[index].skus.map((sku) => [sku.base_unique, sku]));
      editable.skus.forEach((sku) => {
        const selected = selectedByUnique.get(sku.unique);
        if (selected) {
          sku.selected = true;
          sku.packagePrice = selected.price;
        }
      });
      return editable;
    });
    requiredProductId.value = detail.products.find((entry) => entry.type === 1)?.product_id ?? 0;
    await loadProductOptions();
    // Merge newly fetched base SKUs without losing the saved package prices.
    const fetched = new Map(productOptions.value.map((option) => [option.id, option]));
    selectedProducts.value = selectedProducts.value.map((current) => {
      const option = fetched.get(current.productId);
      if (!option) return current;
      const saved = new Map(current.skus.map((sku) => [sku.unique, sku]));
      const merged = editableProduct(option);
      merged.skus.forEach((sku) => Object.assign(sku, saved.get(sku.unique) ?? {}));
      return merged;
    });
  } catch (error) {
    dialogVisible.value = false;
    ElMessage.error(message(error, "加载套餐详情失败"));
  } finally {
    productLoading.value = false;
  }
}

function buildPayload(): DiscountPackagePayload | null {
  if (!form.title.trim()) return ElMessage.error("请输入套餐名称"), null;
  if (!form.image.trim()) return ElMessage.error("请输入套餐图片"), null;
  if (form.isTime && form.time.length !== 2) return ElMessage.error("请选择完整有效期"), null;
  if (selectedProducts.value.length < 2) return ElMessage.error("套餐内商品不能少于2个"), null;
  if (form.type === 1 && !selectedProductIds.value.includes(requiredProductId.value)) {
    return ElMessage.error("请选择搭配套餐主商品"), null;
  }
  const products = [] as DiscountPackagePayload["products"];
  const money = /^\d{1,10}(?:\.\d{1,2})?$/;
  for (const product of selectedProducts.value) {
    const selected = product.skus.filter((sku) => sku.selected);
    if (!selected.length) return ElMessage.error(`请为「${product.storeName}」选择至少一个规格`), null;
    if (selected.some((sku) => !money.test(sku.packagePrice.trim()))) {
      return ElMessage.error(`请检查「${product.storeName}」的套餐价`), null;
    }
    products.push({
      product_id: product.productId,
      type: form.type === 1 && requiredProductId.value === product.productId ? 1 : 0,
      skus: selected.map((sku) => ({ base_unique: sku.unique, price: sku.packagePrice.trim() })),
    });
  }
  return {
    id: form.id || undefined,
    title: form.title.trim(),
    image: form.image.trim(),
    type: form.type,
    is_limit: form.isLimit ? 1 : 0,
    limit_num: form.isLimit ? form.limitNum : 0,
    link_ids: form.linkIds,
    is_time: form.isTime ? 1 : 0,
    time: form.isTime ? form.time : [],
    sort: form.sort,
    free_shipping: form.freeShipping ? 1 : 0,
    status: form.status ? 1 : 0,
    is_support_refund: form.supportRefund ? 1 : 0,
    products,
  };
}

async function save() {
  const payload = buildPayload();
  if (!payload) return;
  saving.value = true;
  try {
    await apiDiscountPackageSave(payload);
    ElMessage.success("套餐保存成功");
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(message(error, "保存套餐失败"));
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row: DiscountPackageListItem) {
  try {
    await apiDiscountPackageStatus(row.id, row.status === 1 ? 0 : 1);
    ElMessage.success("操作成功");
    await load();
  } catch (error) {
    ElMessage.error(message(error, "操作失败"));
  }
}

async function remove(row: DiscountPackageListItem) {
  try {
    await ElMessageBox.confirm(`确认删除套餐「${row.title}」？`, "删除确认", { type: "warning" });
    await apiDiscountPackageDelete(row.id);
    ElMessage.success("套餐已删除");
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(message(error, "删除失败"));
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.toolbar :deep(.el-form-item) {
  margin-bottom: 12px;
}

.notice {
  margin-bottom: 16px;
}

.package-cell,
.product-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.package-cell strong,
.package-cell small {
  display: block;
}

.package-cell small {
  margin-top: 4px;
  color: #8b93a5;
}

.package-image {
  width: 52px;
  height: 52px;
  flex: none;
  border-radius: 8px;
  background: #f1f3f7;
}

.state-tag {
  margin-left: 6px;
}

.pagination {
  justify-content: flex-end;
  margin-top: 18px;
}

.mobile-package-list {
  display: none;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 20px;
}

.inline-number {
  width: 150px;
  margin-left: 12px;
}

.date-range {
  width: 320px;
  margin-left: 12px;
}

.product-select {
  width: 100%;
}

.product-card {
  margin: 0 0 16px 112px;
  padding: 14px;
  border: 1px solid #e5e8ef;
  border-radius: 10px;
}

.product-head {
  justify-content: space-between;
  margin-bottom: 12px;
}

@media (max-width: 860px) {
  .desktop-table {
    display: none;
  }

  .mobile-package-list {
    display: grid;
    gap: 12px;
  }

  .mobile-package-card :deep(.el-card__body) {
    display: grid;
    gap: 12px;
  }

  .mobile-package-meta,
  .mobile-package-state,
  .mobile-package-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .mobile-package-meta {
    justify-content: space-between;
    color: #677086;
    font-size: 13px;
  }

  .mobile-package-meta b {
    color: #303643;
  }

  .toolbar,
  .product-head {
    align-items: stretch;
    flex-direction: column;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .product-card {
    margin-left: 0;
  }
}
</style>
