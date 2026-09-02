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
        title="最多100个显式商品会在一个短事务内完成；任一商品、候选资料或数据库回读失败时整批回滚。"
        type="warning"
        :closable="false"
        show-icon
        class="batch-alert"
      />
      <el-form label-position="top">
        <el-form-item label="操作类型">
          <el-select v-model="batchOperation" class="full-width" @change="resetBatchInputs">
            <el-option label="批量上架" value="show" />
            <el-option label="批量下架" value="hide" />
            <el-option label="替换商品分类" value="category" />
            <el-option label="替换商品标签" value="label" />
            <el-option label="替换配送方式" value="delivery" />
            <el-option label="替换下单赠送" value="reward" />
            <el-option label="替换关联用户标签" value="user-label" />
            <el-option label="替换活动推荐" value="recommend" />
            <el-option label="替换系统表单" value="form" />
            <el-option label="替换运费设置" value="freight" />
            <el-option label="替换商品品牌" value="brand" />
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
        <el-form-item v-if="batchOperation === 'delivery'" label="配送方式">
          <el-checkbox-group v-model="batchDeliveryTypes">
            <el-checkbox :value="1">快递</el-checkbox>
            <el-checkbox :value="2">门店自提</el-checkbox>
            <el-checkbox :value="3">门店配送</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <template v-if="batchOperation === 'reward'">
          <el-form-item label="下单赠送积分">
            <el-input-number v-model="batchGiveIntegral" :min="0" :max="999999999" :precision="2" class="full-width" />
          </el-form-item>
          <el-form-item label="下单赠送优惠券（最多20张）">
            <el-select v-model="batchCouponIds" multiple filterable clearable class="full-width" placeholder="留空会清除现有赠券">
              <el-option v-for="item in batchOptions.gift_coupons" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
        </template>
        <el-form-item v-if="batchOperation === 'user-label'" label="关联用户标签">
          <el-select v-model="batchUserLabelIds" multiple filterable clearable class="full-width" placeholder="留空会清除关联用户标签">
            <el-option v-for="item in batchOptions.user_labels" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="batchOperation === 'recommend'" label="活动推荐">
          <el-checkbox-group v-model="batchRecommendations" class="recommend-grid">
            <el-checkbox value="is_hot">热卖</el-checkbox>
            <el-checkbox value="is_benefit">促销</el-checkbox>
            <el-checkbox value="is_best">精品</el-checkbox>
            <el-checkbox value="is_new">新品</el-checkbox>
            <el-checkbox value="is_good">优品</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item v-if="batchOperation === 'form'" label="系统表单">
          <el-select v-model="batchSystemFormId" filterable class="full-width">
            <el-option label="不使用系统表单" :value="0" />
            <el-option v-for="item in batchOptions.system_forms" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <template v-if="batchOperation === 'freight'">
          <el-form-item label="运费方式">
            <el-radio-group v-model="batchFreight">
              <el-radio-button :value="1">包邮</el-radio-button>
              <el-radio-button :value="2">固定运费</el-radio-button>
              <el-radio-button :value="3">运费模板</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="batchFreight === 2" label="固定运费">
            <el-input-number v-model="batchPostage" :min="0.01" :max="999999999" :precision="2" class="full-width" />
          </el-form-item>
          <el-form-item v-if="batchFreight === 3" label="运费模板">
            <el-select v-model="batchShippingTemplateId" filterable class="full-width" placeholder="请选择可用模板">
              <el-option v-for="item in batchOptions.shipping_templates" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
        </template>
        <el-form-item v-if="batchOperation === 'brand'" label="商品品牌">
          <el-select v-model="batchBrandId" filterable clearable class="full-width" placeholder="留空会清除品牌">
            <el-option v-for="item in batchOptions.brands" :key="item.id" :label="item.name" :value="item.id" />
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
  apiAdminProductBatchOperation,
  apiAdminProductBatchRelations,
  apiAdminProductBatchSetShow,
  apiAdminProductEditorOptions,
  type ProductBatchResult,
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
type BatchOperation =
  | "show"
  | "hide"
  | "category"
  | "label"
  | "delivery"
  | "reward"
  | "user-label"
  | "recommend"
  | "form"
  | "freight"
  | "brand";
const batchOperation = ref<BatchOperation>("show");
const batchRelationIds = ref<number[]>([]);
const batchDeliveryTypes = ref<number[]>([]);
const batchGiveIntegral = ref(0);
const batchCouponIds = ref<number[]>([]);
const batchUserLabelIds = ref<number[]>([]);
const batchRecommendations = ref<string[]>([]);
const batchSystemFormId = ref(0);
const batchFreight = ref<1 | 2 | 3>(1);
const batchPostage = ref(0.01);
const batchShippingTemplateId = ref<number>();
const batchBrandId = ref<number>();
const batchOptionsLoaded = ref(false);
const batchOptions = reactive<{
  categories: ProductEditorOption[];
  product_labels: ProductEditorOption[];
  brands: ProductEditorOption[];
  user_labels: ProductEditorOption[];
  gift_coupons: ProductEditorOption[];
  system_forms: ProductEditorOption[];
  shipping_templates: ProductEditorOption[];
}>({
  categories: [],
  product_labels: [],
  brands: [],
  user_labels: [],
  gift_coupons: [],
  system_forms: [],
  shipping_templates: [],
});

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
  if (!batchOptionsLoaded.value) {
    try {
      const options = await apiAdminProductEditorOptions();
      batchOptions.categories = options.categories;
      batchOptions.product_labels = options.product_labels;
      batchOptions.brands = options.brands;
      batchOptions.user_labels = options.user_labels;
      batchOptions.gift_coupons = options.gift_coupons;
      batchOptions.system_forms = options.system_forms;
      batchOptions.shipping_templates = options.shipping_templates;
      batchOptionsLoaded.value = true;
    } catch (e) {
      return ElMessage.error(e instanceof Error ? e.message : "加载批量候选失败");
    }
  }
  batchOperation.value = "show";
  resetBatchInputs();
  batchDialogVisible.value = true;
}

function resetBatchInputs() {
  batchRelationIds.value = [];
  batchDeliveryTypes.value = [];
  batchGiveIntegral.value = 0;
  batchCouponIds.value = [];
  batchUserLabelIds.value = [];
  batchRecommendations.value = [];
  batchSystemFormId.value = 0;
  batchFreight.value = 1;
  batchPostage.value = 0.01;
  batchShippingTemplateId.value = undefined;
  batchBrandId.value = undefined;
}

async function applyBatch() {
  const ids = selectedRows.value.map((row) => row.id);
  if (!ids.length) return ElMessage.warning("请选择商品");
  if (batchOperation.value === "category" && !batchRelationIds.value.length) {
    return ElMessage.warning("请至少选择一个商品分类");
  }
  if (batchOperation.value === "delivery" && !batchDeliveryTypes.value.length) {
    return ElMessage.warning("请至少选择一种配送方式");
  }
  if (batchOperation.value === "freight" && batchFreight.value === 3 && !batchShippingTemplateId.value) {
    return ElMessage.warning("请选择运费模板");
  }
  batchSubmitting.value = true;
  try {
    let result: ProductBatchResult;
    switch (batchOperation.value) {
      case "show":
      case "hide":
        result = await apiAdminProductBatchSetShow(ids, batchOperation.value === "show" ? 1 : 0);
        break;
      case "category":
      case "label":
        result = await apiAdminProductBatchRelations(
          batchOperation.value === "category" ? 1 : 2,
          ids,
          batchRelationIds.value,
        );
        break;
      case "delivery":
        result = await apiAdminProductBatchOperation(3, ids, { delivery_type: batchDeliveryTypes.value });
        break;
      case "reward":
        result = await apiAdminProductBatchOperation(4, ids, {
          give_integral: batchGiveIntegral.value,
          coupon_ids: batchCouponIds.value,
        });
        break;
      case "user-label":
        result = await apiAdminProductBatchOperation(5, ids, { label_id: batchUserLabelIds.value });
        break;
      case "recommend":
        result = await apiAdminProductBatchOperation(6, ids, { recommend: batchRecommendations.value });
        break;
      case "form":
        result = await apiAdminProductBatchOperation(7, ids, { system_form_id: batchSystemFormId.value });
        break;
      case "freight":
        result = await apiAdminProductBatchOperation(8, ids, {
          freight: batchFreight.value,
          postage: batchFreight.value === 2 ? batchPostage.value : 0,
          temp_id: batchFreight.value === 3 ? batchShippingTemplateId.value ?? 0 : 0,
        });
        break;
      case "brand":
        result = await apiAdminProductBatchOperation(9, ids, {
          brand_id: batchBrandId.value ? [batchBrandId.value] : [],
        });
        break;
    }
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
.recommend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
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
