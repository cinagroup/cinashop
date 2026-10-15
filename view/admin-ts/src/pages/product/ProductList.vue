<template>
  <div class="product-list">
    <el-alert v-if="!canView" title="没有商品查看权限" type="warning" :closable="false" />
    <el-alert v-if="readError" :title="readError" type="error" :closable="false" />
    <el-alert v-if="headerError" :title="headerError" type="warning" :closable="false" />
    <el-alert v-if="stockGuardError" :title="stockGuardError" type="warning" :closable="false" />
    <div v-if="canView" class="catalog-states">
      <el-button v-for="item in headers" :key="item.type" :type="query.type === item.type ? 'primary' : 'default'" @click="chooseType(item.type)">
        {{ item.name }} ({{ item.count }})
      </el-button>
    </div>
    <!-- 搜索栏 -->
    <el-card v-if="canView" shadow="never" class="filter-card">
      <el-form inline class="catalog-filter-form" @submit.prevent>
        <el-form-item label="商品分类">
          <el-cascader v-model="query.cate_id" :options="filterOptions.categories" :props="categoryFilterProps"
            placeholder="请选择商品分类" filterable clearable collapse-tags :max-collapse-tags="2" :disabled="filterLoading.categories" @change="reload" />
        </el-form-item>
        <el-form-item label="供应商">
          <el-select v-model="query.supplier_id" placeholder="请选择供应商" filterable clearable :disabled="filterLoading.suppliers" @change="reload">
            <el-option v-for="item in filterOptions.suppliers" :key="item.id" :label="item.supplier_name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="商品品牌">
          <el-cascader v-model="query.brand_id" :options="filterOptions.brands" :props="brandFilterProps"
            placeholder="请选择商品品牌" filterable clearable :disabled="filterLoading.brands" @change="reload" />
        </el-form-item>
        <el-form-item label="商品标签">
          <el-select v-model="query.store_label_id" multiple :multiple-limit="100" placeholder="请选择商品标签" filterable clearable collapse-tags :max-collapse-tags="2" :disabled="filterLoading.labels" @change="reload">
            <el-option v-for="item in filterOptions.labels" :key="item.id" :label="`${item.group_name} / ${item.label_name}`" :value="item.id" />
          </el-select>
        </el-form-item>
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
      <div v-if="filterError" class="catalog-filter-error">
        <el-alert :title="filterError" type="warning" :closable="false" />
        <el-button plain @click="loadFilterOptions">重试筛选资料</el-button>
      </div>
    </el-card>

    <!-- 工具栏 -->
    <el-card v-if="canView" shadow="never">
      <div class="toolbar">
        <el-button v-if="canManage" plain @click="$router.push('/product/metadata')">
          商品基础资料
        </el-button>
        <el-button v-if="canManage" type="warning" plain @click="$router.push('/product/virtual-alerts')">
          卡密预警
        </el-button>
        <el-button v-if="canManage" type="primary" @click="$router.push('/product/create')">
          添加商品
        </el-button>
      </div>

      <div v-if="canMutateState" class="batch-toolbar">
        <el-text :type="selectedRows.length ? 'primary' : 'info'">
          已选择 {{ selectedRows.length }} 项（单次最多100项）
        </el-text>
        <el-button type="primary" plain :disabled="!selectedRows.length" @click="openBatch">
          批量操作
        </el-button>
      </div>

      <!-- 表格 -->
      <el-table :data="list" v-loading="loading" @selection-change="handleSelectionChange">
        <el-table-column v-if="canMutateState" type="selection" width="48" />
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
        <el-table-column label="库存" width="80"><template #default="{ row }">{{ row.stock === null ? "—" : row.stock }}</template></el-table-column>
        <el-table-column prop="sales" label="销量" width="80" />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="row.is_show === 1 ? 'success' : 'info'">
              {{ row.is_show === 1 ? "上架" : "下架" }}
            </el-tag>
            <p v-if="row.is_verify !== 1">{{ row.is_verify === 0 ? '待审核' : row.is_verify === -1 ? '审核未通过' : '强制下架' }}</p>
            <p v-if="row.auto_on_time">定时上架：{{ scheduleTime(row.auto_on_time) }}</p>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="290">
          <template #default="{ row }">
            <el-button
              v-if="canMutateState && row.product_type === 1"
              link
              type="primary"
              @click="$router.push(`/product/virtual/${row.id}`)"
            >
              卡密库存
            </el-button>
            <el-button v-if="canMutateState" link type="primary" @click="$router.push(`/product/edit/${row.id}`)">
              编辑
            </el-button>
            <el-button v-if="canManage && [0, 1, 3, 4].includes(row.product_type)" link type="primary" @click="copyProduct(row)">复制商品</el-button>
            <el-button v-if="canAdjustStock && row.product_type !== 1" link type="primary" @click="openStock(row)">库存管理</el-button>
            <el-button v-if="canMutateState" link :type="row.is_show === 1 ? 'warning' : 'success'" @click="toggleShow(row)">
              {{ row.is_show === 1 ? "下架" : "上架" }}
            </el-button>
            <el-button v-if="canManage && [0,1].includes(row.is_del)" link :type="row.is_del === 1 ? 'primary' : 'danger'" @click="openRecycle(row)">{{ row.is_del === 1 ? '恢复' : '移入回收站' }}</el-button>
            <el-button v-if="canManage && query.type === 0" link type="primary" @click="openModeration(row, 'verify')">审核</el-button>
            <el-button v-if="canManage && row.is_verify === 1 && row.is_del === 0" link type="danger" @click="openModeration(row, 'remove')">强制下架</el-button>
            <el-button v-if="canReplyView" link type="primary" @click="viewReplies(row)">查看评价</el-button>
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

    <ProductRecycleDialog v-if="recycleProduct" v-model="recycleVisible" :product="recycleProduct" :can-manage="canManage" :context-key="stockContext" @saved="stockSaved" @refresh="stockSaved" />

    <ProductModerationDialog v-if="moderationProduct" v-model="moderationVisible" :product="moderationProduct" :mode="moderationMode"
      :can-manage="canManage" :context-key="stockContext" @saved="stockSaved" @refresh="stockSaved" />

    <ProductStockDialog v-model="stockVisible" :product-id="stockProduct?.id ?? 0" :product-name="stockProduct?.store_name ?? ''"
      :spec-type="Number(stockProduct?.spec_type ?? 0)" :can-view="canView" :can-manage="canAdjustStock" :context-key="stockContext" @saved="stockSaved" />

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
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { getToken, getAdminSession } from "@/utils/auth";
import ProductStockDialog from './ProductStockDialog.vue';
import ProductRecycleDialog from './ProductRecycleDialog.vue';
import ProductModerationDialog from './ProductModerationDialog.vue';
import type { ProductModerationMode } from '@/api/productModeration';
import { apiAdminStockErpEnabled } from '@/api/productStock';
import { ElMessage } from "element-plus";
import { apiCatalogFilterCategories, apiCatalogFilterBrands, apiCatalogFilterLabels, apiCatalogFilterSuppliers,
  type CatalogFilterNode, type CatalogFilterLabel, type CatalogFilterSupplier } from '@/api/productCatalogFilters';
import {
  apiAdminProductList,
  apiAdminProductTypeHeader,
  type AdminProductCatalogItem,
  type AdminProductCatalogHeader,
  type AdminProductCatalogQuery,
  apiAdminProductSetShow,
  apiAdminProductBatchOperation,
  apiAdminProductBatchRelations,
  apiAdminProductBatchSetShow,
  apiAdminProductEditorOptions,
  type ProductBatchResult,
  type ProductEditorOption,
} from "@/api/product";

const list = ref<AdminProductCatalogItem[]>([]);
const loading = ref(false);
const total = ref(0);
const query = reactive<{ page: number; limit: number; store_name: string; type: number | ""; cate_id: number[]; brand_id: number[]; store_label_id: number[]; supplier_id: number | "" | undefined }>({ page: 1, limit: 10, store_name: "", type: 1, cate_id: [], brand_id: [], store_label_id: [], supplier_id: "" });
const headers = ref<AdminProductCatalogHeader[]>([]), readError = ref(""), headerError = ref("");
const route = useRoute(), router = useRouter(), auth = useAuthStore();
let alive = false, syncing = false, readTurn = 0, batchRun = 0, abort: AbortController | null = null, stored = localStorage.getItem("admin_session");
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
function permission(key: string): boolean {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") && !!auth.userInfo && !!session &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || auth.uniqueAuth.includes(key) && session.uniqueAuth.includes(key));
}
const canView = computed(() => permission("product.view")), canManage = computed(() => canView.value && permission("product.manage"));
const canReplyView = computed(() => canView.value && (permission("reply.view") || permission("reply.manage")));
const canMutateState = computed(() => canManage.value && [1, 2].includes(Number(query.type)));
function copyProduct(row: AdminProductCatalogItem): void {
  if (!canManage.value || !list.value.includes(row) || ![0, 1, 3, 4].includes(row.product_type) || !Number.isSafeInteger(row.id) || row.id < 1) return;
  void router.push(`/admin/product/add_product?copy=${row.id}`);
}
const categoryFilterProps = { emitPath: false, multiple: true, checkStrictly: true }, brandFilterProps = { emitPath: true, checkStrictly: true };
const filterOptions = reactive<{ categories: CatalogFilterNode[]; brands: CatalogFilterNode[]; labels: CatalogFilterLabel[]; suppliers: CatalogFilterSupplier[] }>({ categories: [], brands: [], labels: [], suppliers: [] });
const filterLoading = reactive({ categories: false, brands: false, labels: false, suppliers: false });
const filterErrors = reactive({ categories: '', brands: '', labels: '', suppliers: '' });
const filterError = computed(() => Object.values(filterErrors).filter(Boolean).join('；'));
let filterTurn = 0, filterAbort: AbortController | null = null;
function clearFilterOptions(): void {
  filterTurn++; filterAbort?.abort(); filterAbort = null;
  filterOptions.categories = []; filterOptions.brands = []; filterOptions.labels = []; filterOptions.suppliers = [];
  for (const key of ['categories', 'brands', 'labels', 'suppliers'] as const) { filterLoading[key] = false; filterErrors[key] = ''; }
}
async function loadFilterOptions(): Promise<void> {
  if (!alive || !canView.value) return;
  filterAbort?.abort(); const controller = new AbortController(); filterAbort = controller;
  const turn = ++filterTurn, owner = identity.value, token = auth.token, session = stored;
  const active = () => turn === filterTurn && current(owner, token, session);
  async function read<K extends keyof typeof filterOptions>(key: K, readOptions: (signal?: AbortSignal) => Promise<(typeof filterOptions)[K]>, label: string) {
    filterLoading[key] = true; filterErrors[key] = '';
    try { const rows = await readOptions(controller.signal); if (active()) filterOptions[key] = rows; }
    catch (error) { if (active()) { filterOptions[key] = [];
      filterErrors[key] = `${label}筛选资料读取失败：${error instanceof Error ? error.message : '请重试'}`; } }
    finally { if (active()) filterLoading[key] = false; }
  }
  await Promise.all([read('categories', apiCatalogFilterCategories, '分类'), read('brands', apiCatalogFilterBrands, '品牌'),
    read('labels', apiCatalogFilterLabels, '标签'), read('suppliers', apiCatalogFilterSuppliers, '供应商')]);
  if (active()) filterAbort = null;
}
function current(value: string, token: string, session: string | null): boolean {
  return alive && canView.value && identity.value === value && getToken() === token && auth.token === token && stored === session && localStorage.getItem("admin_session") === session;
}
function clearReads(resetBatch = true): void { readTurn++; if (resetBatch) { batchRun++; batchSubmitting.value = false; } stockVisible.value = false; stockProduct.value = null; moderationVisible.value = false; moderationProduct.value = null; recycleVisible.value = false; recycleProduct.value = null; stockGeneration.value++; erpEnabled.value = null; stockGuardError.value = ''; abort?.abort(); abort = null; list.value = []; total.value = 0; headers.value = []; readError.value = headerError.value = ""; loading.value = false; selectedRows.value = []; batchDialogVisible.value = false; batchOptionsLoaded.value = false; }
type MutationScope = { owner: string; token: string; session: string | null; turn: number; type: number | ""; ids: number[] };
function mutationScope(ids: number[]): MutationScope { return { owner: identity.value, token: auth.token, session: stored, turn: readTurn, type: query.type, ids: [...ids] }; }
function activeMutation(scope: MutationScope, selected = false): boolean {
  return canMutateState.value && current(scope.owner, scope.token, scope.session) && readTurn === scope.turn && query.type === scope.type &&
    scope.ids.every(id => list.value.some(row => row.id === id)) && (!selected || scope.ids.join(",") === selectedRows.value.map(row => row.id).join(","));
}
function catalogType(value: unknown): number | "" {
  if (value === undefined) return 1;
  if (value === "") return "";
  if (typeof value !== "string" || !/^(?:-2|-1|[0-7])$/.test(value)) throw Error("商品状态格式错误");
  return Number(value);
}
function viewReplies(row: AdminProductCatalogItem): void {
  if (!canReplyView.value || !list.value.some(item => item.id === row.id) || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > 2_147_483_647) return;
  void router.push({ path: "/reply", query: { product_id: String(row.id) } });
}

const selectedRows = ref<AdminProductCatalogItem[]>([]);
const batchDialogVisible = ref(false);
const batchSubmitting = ref(false);
const stockVisible = ref(false), stockProduct = ref<AdminProductCatalogItem | null>(null), stockGeneration = ref(0);
const recycleVisible = ref(false), recycleProduct = ref<AdminProductCatalogItem | null>(null);
function openRecycle(row: AdminProductCatalogItem) {
  if (!canManage.value || !list.value.includes(row) || ![0,1].includes(row.is_del)) return;
  stockVisible.value = moderationVisible.value = false; stockProduct.value = moderationProduct.value = null; stockGeneration.value++;
  recycleProduct.value = row; recycleVisible.value = true;
}
const moderationVisible = ref(false), moderationProduct = ref<AdminProductCatalogItem | null>(null), moderationMode = ref<ProductModerationMode>('verify');
const scheduleTime = (value: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(value * 1000);
function openModeration(row: AdminProductCatalogItem, mode: ProductModerationMode) {
  if (!canManage.value || !list.value.includes(row) || mode === 'verify' && query.type !== 0 || mode === 'remove' && (row.is_verify !== 1 || row.is_del !== 0)) return;
  recycleVisible.value = false; recycleProduct.value = null; stockVisible.value = false; stockProduct.value = null; stockGeneration.value++;
  moderationProduct.value = row; moderationMode.value = mode; moderationVisible.value = true;
}
const erpEnabled = ref<boolean | null>(null), stockGuardError = ref('');
const canAdjustStock = computed(() => canManage.value && erpEnabled.value === false);
const stockContext = computed(() => `${identity.value}:${stored}:${query.type}:${stockGeneration.value}`);
function openStock(row: AdminProductCatalogItem): void {
  if (!canAdjustStock.value || row.product_type === 1 || !list.value.includes(row)) return;
  moderationVisible.value = false; moderationProduct.value = null; recycleVisible.value = false; recycleProduct.value = null; stockGeneration.value++; stockProduct.value = row; stockVisible.value = true;
}
function stockSaved(): void { if (canView.value) void fetch(); }
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

async function fetch(): Promise<void> {
  if (!alive || !canView.value || !Number.isSafeInteger(query.page) || query.page < 1) return;
  const validIds = (values: unknown): values is number[] => Array.isArray(values) && values.length <= 100 && values.every(id => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647) && new Set(values).size === values.length;
  if ([...query.store_name].length > 128 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(query.store_name)) { clearReads(false); readError.value = "商品关键词格式错误或超过128个字符"; return; }
  // Element Plus clears a single cascader/select to undefined. Empty choices
  // remain absent filters, while a brand's full ancestor path stays an array.
  const categoryIds = query.cate_id ?? [], brandIds = query.brand_id ?? [], labelIds = query.store_label_id ?? [], supplierId = query.supplier_id || '';
  if (!validIds(categoryIds) || !validIds(brandIds) || brandIds.length > 3 || !validIds(labelIds) ||
    supplierId !== '' && (!Number.isSafeInteger(supplierId) || supplierId < 1 || supplierId > 2_147_483_647)) {
    clearReads(false); readError.value = '商品筛选条件格式错误或超过容量'; return;
  }
  abort?.abort(); const controller = new AbortController(); abort = controller;
  const turn = ++readTurn, owner = identity.value, token = auth.token, session = stored;
  const params = { page: query.page, limit: query.limit, store_name: query.store_name, type: query.type,
    cate_id: [...categoryIds], brand_id: [...brandIds], store_label_id: [...labelIds], supplier_id: supplierId } satisfies AdminProductCatalogQuery;
  loading.value = true; readError.value = headerError.value = ""; list.value = []; selectedRows.value = []; batchDialogVisible.value = false;
  stockVisible.value = false; stockProduct.value = null; moderationVisible.value = false; moderationProduct.value = null; recycleVisible.value = false; recycleProduct.value = null; stockGeneration.value++;
  erpEnabled.value = null; stockGuardError.value = '';
  const active = () => current(owner, token, session) && turn === readTurn;
  // Keep the known count during a page switch; Element Plus otherwise clamps
  // page2 back to1. Only the source's count<=limit fallback changes the page.
  const rows = (async () => {
    try { const result = await apiAdminProductList(params, controller.signal); if (!active()) return;
      list.value = result.list; total.value = result.count;
      if (params.page > 1 && result.count <= params.limit) query.page = 1;
    } catch (error) { if (active()) { list.value = []; total.value = 0; readError.value = error instanceof Error ? error.message : "商品列表读取失败"; } }
  })();
  const counts = (async () => {
    try { const result = await apiAdminProductTypeHeader(params, controller.signal); if (active()) headers.value = result; }
    catch (error) { if (active()) { headers.value = []; headerError.value = error instanceof Error ? error.message : "商品状态计数读取失败"; } }
  })();
  const inventory = (async () => {
    if (!canManage.value) return;
    try { const enabled = await apiAdminStockErpEnabled(controller.signal); if (active()) erpEnabled.value = enabled; }
    catch (error) { if (active()) stockGuardError.value = `库存开关读取失败，暂不可调整：${error instanceof Error ? error.message : '请重试'}`; }
  })();
  await Promise.all([rows, counts, inventory]); if (active()) { loading.value = false; abort = null; }
}
function chooseType(type: number): void { if (!canView.value || batchSubmitting.value) return; void router.replace({ path: "/product", query: { ...route.query, type: String(type) }, hash: route.hash }); }
function applyRoute(): void {
  if (!alive || !canView.value) return;
  clearReads();
  try { query.type = catalogType(route.query.type); query.page = 1; void fetch(); }
  catch (error) { readError.value = error instanceof Error ? error.message : "商品状态格式错误"; }
}
function syncSession(): void {
  syncing = true; clearReads(); clearFilterOptions(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session"); sessionVersion.value++; syncing = false;
  query.page = 1; query.store_name = ""; query.cate_id = []; query.brand_id = []; query.store_label_id = []; query.supplier_id = ""; applyRoute(); void loadFilterOptions();
}
function syncStorage(event: StorageEvent): void { if (event.key === null || ["admin_token", "admin_session"].includes(event.key)) syncSession(); }
function stockNotice(event: Event): void {
  if (!canView.value || stockVisible.value || moderationVisible.value || recycleVisible.value) return;
  const product = (event as CustomEvent<{ productId?: number }>).detail?.productId ?? 0;
  if (product === 0 || list.value.some(row => row.id === product)) void fetch();
}
function stockNoticeDenied(): void { if (canView.value) void fetch(); }

function handleSelectionChange(rows: AdminProductCatalogItem[]) {
  selectedRows.value = canMutateState.value ? rows.slice(0, 100) : [];
}

async function openBatch() {
  if (!canMutateState.value || batchSubmitting.value) return;
  if (!selectedRows.value.length) return ElMessage.warning("请先选择商品");
  const scope = mutationScope(selectedRows.value.map(row => row.id));
  if (!batchOptionsLoaded.value) {
    try {
      const options = await apiAdminProductEditorOptions();
      if (!activeMutation(scope, true)) return;
      batchOptions.categories = options.categories;
      batchOptions.product_labels = options.product_labels;
      batchOptions.brands = options.brands;
      batchOptions.user_labels = options.user_labels;
      batchOptions.gift_coupons = options.gift_coupons;
      batchOptions.system_forms = options.system_forms;
      batchOptions.shipping_templates = options.shipping_templates;
      batchOptionsLoaded.value = true;
    } catch (e) {
      if (activeMutation(scope, true)) ElMessage.error(e instanceof Error ? e.message : "加载批量候选失败");
      return;
    }
  }
  if (!activeMutation(scope, true)) return;
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
  if (!canMutateState.value || batchSubmitting.value) return;
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
  const scope = mutationScope(ids);
  const run = ++batchRun;
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
    if (!activeMutation(scope, true)) return;
    if (!result.verified) throw new Error("批量操作数据库回读未通过");
    ElMessage.success(`已处理 ${result.changed} 个商品`);
    batchDialogVisible.value = false;
    await fetch();
  } catch (e) {
    if (activeMutation(scope, true)) ElMessage.error(e instanceof Error ? e.message : "批量操作失败");
  } finally {
    if (run === batchRun) batchSubmitting.value = false;
  }
}

function reload() {
  query.page = 1;
  fetch();
}

function reset() {
  query.store_name = "";
  query.cate_id = []; query.brand_id = []; query.store_label_id = []; query.supplier_id = "";
  reload();
}

async function toggleShow(row: AdminProductCatalogItem) {
  if (!canMutateState.value || !list.value.some(item => item.id === row.id)) return;
  const scope = mutationScope([row.id]);
  try {
    await apiAdminProductSetShow(row.id, row.is_show === 1 ? 0 : 1);
    if (!activeMutation(scope)) return;
    ElMessage.success(row.is_show === 1 ? "已下架" : "已上架");
    fetch();
  } catch (e) {
    if (activeMutation(scope)) ElMessage.error(e instanceof Error ? e.message : "操作失败");
  }
}


watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
watch(() => route.query.type, () => { if (alive) applyRoute(); });
onMounted(() => { alive = true; window.addEventListener("admin-session-changed", syncSession); window.addEventListener("admin-auth-expired", syncSession); window.addEventListener("storage", syncStorage); window.addEventListener('cinashop:product-stock-changed', stockNotice); window.addEventListener('cinashop:product-stock-notice-denied', stockNoticeDenied); syncSession(); });
onBeforeUnmount(() => { alive = false; clearReads(); clearFilterOptions(); window.removeEventListener("admin-session-changed", syncSession); window.removeEventListener("admin-auth-expired", syncSession); window.removeEventListener("storage", syncStorage); window.removeEventListener('cinashop:product-stock-changed', stockNotice); window.removeEventListener('cinashop:product-stock-notice-denied', stockNoticeDenied); });
</script>

<style scoped>
.catalog-states { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.catalog-states :deep(.el-button + .el-button) { margin-left: 0; }
.filter-card {
  margin-bottom: 16px;
}
.catalog-filter-form :deep(.el-select), .catalog-filter-form :deep(.el-cascader) { width: 230px; }
.catalog-filter-error { display: flex; align-items: center; gap: 12px; }

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
  .catalog-filter-form :deep(.el-form-item) { display: flex; margin-right: 0; }
  .catalog-filter-form :deep(.el-form-item__content) { min-width: 0; }
  .catalog-filter-form :deep(.el-select), .catalog-filter-form :deep(.el-cascader), .catalog-filter-form :deep(.el-input) { width: 100%; }
  .catalog-filter-error { flex-wrap: wrap; }
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
