<template>
  <div class="product-form">
    <el-card shadow="never">
      <template #header>{{ isEdit ? "编辑商品" : "添加商品" }}</template>

      <el-form :model="form" label-width="108px" class="editor-form">
        <el-form-item label="商品名称" required>
          <el-input v-model="form.store_name" placeholder="请输入商品名称" />
        </el-form-item>
        <el-form-item label="商品简介">
          <el-input v-model="form.store_info" placeholder="请输入商品简介" />
        </el-form-item>
        <el-form-item label="主图">
          <el-input v-model="form.image" placeholder="请输入图片 URL" />
        </el-form-item>
        <el-form-item label="价格" required>
          <el-input-number v-model="form.price" :min="0" :precision="2" />
        </el-form-item>
        <el-form-item label="原价">
          <el-input-number v-model="form.ot_price" :min="0" :precision="2" />
        </el-form-item>
        <el-form-item label="库存">
          <el-input-number v-model="form.stock" :min="0" />
        </el-form-item>
        <el-form-item label="单位">
          <div class="field-row">
            <el-select
              v-model="form.unit_name"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入单位"
            >
              <el-option v-for="unit in units" :key="unit.id" :label="unit.name" :value="unit.name" />
            </el-select>
            <el-button @click="$router.push('/product/metadata')">管理单位</el-button>
          </div>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="form.keyword" placeholder="搜索关键词" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.cate_id" placeholder="选择分类" clearable>
            <el-option
              v-for="cat in categories"
              :key="cat.id"
              :label="cat.name"
              :value="String(cat.id)"
            />
          </el-select>
        </el-form-item>
        <el-divider content-position="left">商品关联资料</el-divider>
        <el-alert
          title="保障、品牌、标签和参数会与商品在同一事务保存；数据库回读不一致时不会产生半成品。"
          type="info"
          :closable="false"
          show-icon
          class="association-alert"
        />
        <el-form-item label="品牌">
          <div class="field-row">
            <el-select v-model="form.brand_id" filterable clearable placeholder="选择商品品牌">
              <el-option
                v-for="item in editorOptions.brands"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
            <el-button @click="$router.push('/brand')">管理品牌</el-button>
          </div>
        </el-form-item>
        <el-form-item label="商品标签">
          <div class="field-row">
            <el-select
              v-model="form.store_label_id"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="可多选商品标签"
            >
              <el-option
                v-for="item in editorOptions.product_labels"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
            <el-button @click="$router.push('/label')">管理标签</el-button>
          </div>
        </el-form-item>
        <el-form-item label="保障服务">
          <div class="field-row">
            <el-select
              v-model="form.ensure_id"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="可多选保障条款"
            >
              <el-option
                v-for="item in editorOptions.ensures"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
            <el-button @click="$router.push('/product/metadata')">管理保障</el-button>
          </div>
        </el-form-item>
        <el-form-item label="参数模板">
          <div class="field-row">
            <el-select
              v-model="form.specs_id"
              clearable
              filterable
              placeholder="选择参数模板"
              @change="applyParameterTemplate"
            >
              <el-option
                v-for="item in editorOptions.parameter_templates"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
            <el-button @click="$router.push('/product/metadata')">管理模板</el-button>
          </div>
        </el-form-item>
        <el-form-item v-if="form.specs.length" label="参数快照">
          <div class="parameter-snapshot">
            <div v-for="(item, index) in form.specs" :key="`${item.name}-${index}`" class="parameter-row">
              <span class="parameter-name">{{ item.name }}</span>
              <el-input v-model="item.value" maxlength="255" placeholder="请输入参数值" />
            </div>
            <el-text type="info">
              保存后保留当前参数值快照；以后修改模板不会静默改写历史商品。
            </el-text>
          </div>
        </el-form-item>
        <el-divider content-position="left">SKU规格与库存</el-divider>
        <el-alert
          title="SKU与商品主表、规格维度、库存流水在同一事务保存并回读。历史身份不能删除、重命名或改唯一标识；停用请使用可恢复退役。"
          type="warning"
          :closable="false"
          show-icon
          class="association-alert"
        />
        <el-form-item label="规格类型">
          <el-radio-group v-model="form.spec_type" @change="changeSpecType">
            <el-radio-button :value="0">单规格</el-radio-button>
            <el-radio-button :value="1">多规格</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.spec_type === 1" label="规格模板">
          <div class="field-row">
            <el-select v-model="form.sku_rule_id" filterable clearable placeholder="选择SKU规格模板">
              <el-option
                v-for="item in editorOptions.sku_rule_templates"
                :key="item.id"
                :label="item.name"
                :value="item.id"
              />
            </el-select>
            <el-button type="primary" plain @click="applySkuRuleTemplate">套用并生成</el-button>
            <el-button @click="$router.push('/product/metadata')">管理规格</el-button>
          </div>
        </el-form-item>
        <el-form-item v-if="form.items.length" label="规格维度">
          <div class="sku-dimensions">
            <div v-for="dimension in form.items" :key="dimension.value" class="sku-dimension">
              <strong>{{ dimension.value }}</strong>
              <el-tag v-for="value in dimension.detail" :key="value" size="small">{{ value }}</el-tag>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="SKU明细" required>
          <div class="sku-table-shell">
            <el-table :data="form.attrs" border size="small" class="sku-table" @selection-change="selectActiveSkus">
              <el-table-column v-if="isEdit" type="selection" width="48" :selectable="selectableHistoricalSku" />
              <el-table-column prop="suk" label="组合" fixed min-width="130" />
              <el-table-column label="图片URL" min-width="150">
                <template #default="{ row }"><el-input v-model="row.image" /></template>
              </el-table-column>
              <el-table-column v-if="form.spec_type === 1" label="售价" min-width="120">
                <template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="2" controls-position="right" /></template>
              </el-table-column>
              <el-table-column v-if="form.spec_type === 1" label="原价" min-width="120">
                <template #default="{ row }"><el-input-number v-model="row.ot_price" :min="0" :precision="2" controls-position="right" /></template>
              </el-table-column>
              <el-table-column label="成本价" min-width="120">
                <template #default="{ row }"><el-input-number v-model="row.cost" :min="0" :precision="2" controls-position="right" /></template>
              </el-table-column>
              <el-table-column v-if="form.spec_type === 1" label="会员价" min-width="120">
                <template #default="{ row }"><el-input-number v-model="row.vip_price" :min="0" :precision="2" controls-position="right" /></template>
              </el-table-column>
              <el-table-column v-if="form.spec_type === 1" label="库存" min-width="110">
                <template #default="{ row }"><el-input-number v-model="row.stock" :min="0" controls-position="right" /></template>
              </el-table-column>
              <el-table-column label="条码" min-width="130">
                <template #default="{ row }"><el-input v-model="row.bar_code" maxlength="50" /></template>
              </el-table-column>
              <el-table-column label="编码" min-width="130">
                <template #default="{ row }"><el-input v-model="row.code" maxlength="50" /></template>
              </el-table-column>
              <el-table-column v-if="isEdit" prop="unique" label="唯一标识" min-width="100" />
            </el-table>
            <el-text type="info">
              单规格的售价、原价、库存和会员价使用上方主字段；多规格的商品汇总值由SKU自动计算。
            </el-text>
            <div v-if="isEdit" class="sku-lifecycle-actions">
              <el-button
                type="danger"
                plain
                :disabled="!selectedActiveSkuIds.length"
                :loading="skuActionLoading"
                @click="changeSkuLifecycle('retire')"
              >退役选中历史SKU</el-button>
              <el-text type="info">有未结购物车、未支付订单、活动、促销、抽奖或门店引用时会拒绝；剩余组合必须保持完整。</el-text>
            </div>
          </div>
        </el-form-item>
        <el-form-item v-if="isEdit && retiredAttrs.length" label="已退役SKU">
          <div class="sku-table-shell">
            <el-table :data="retiredAttrs" border size="small" class="sku-table" @selection-change="selectRetiredSkus">
              <el-table-column type="selection" width="48" />
              <el-table-column prop="suk" label="历史组合" min-width="150" />
              <el-table-column prop="unique" label="唯一标识" min-width="110" />
              <el-table-column prop="stock" label="保留库存" min-width="100" />
              <el-table-column prop="sales" label="历史销量" min-width="100" />
            </el-table>
            <div class="sku-lifecycle-actions">
              <el-button
                type="success"
                plain
                :disabled="!selectedRetiredSkuIds.length"
                :loading="skuActionLoading"
                @click="changeSkuLifecycle('restore')"
              >恢复选中SKU</el-button>
              <el-text type="info">恢复也必须形成完整规格组合，操作原因和数据库回读结果会留档。</el-text>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :max="999" />
        </el-form-item>
        <el-form-item label="会员专享">
          <el-switch v-model="form.is_vip" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item v-if="form.is_vip" label="会员价">
          <el-input-number v-model="form.vip_price" :min="0" :precision="2" />
        </el-form-item>
        <el-form-item label="是否上架">
          <el-switch v-model="form.is_show" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
          <el-button v-if="!isEdit" :loading="draftSaving" @click="clearDraft">删除草稿</el-button>
          <el-button @click="$router.back()">取消</el-button>
          <el-text v-if="!isEdit && draftStatus" type="info">{{ draftStatus }}</el-text>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onBeforeUnmount, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminProductCreate,
  apiAdminProductUpdate,
  apiAdminProductDetail,
  apiAdminProductEditorOptions,
  apiAdminProductDraft,
  apiAdminProductDraftDelete,
  apiAdminProductDraftSave,
  apiAdminProductSkuRestore,
  apiAdminProductSkuRetire,
  type ProductEditorOptions,
  type ProductEditorParameter,
  type ProductSkuDimension,
  type ProductSkuRow,
} from "@/api/product";
import { apiProductUnitList, type ProductUnit } from "@/api/productMetadata";

const route = useRoute();
const router = useRouter();
const submitting = ref(false);
const draftSaving = ref(false);
const draftStatus = ref("");
const draftReady = ref(false);
let draftTimer: ReturnType<typeof setTimeout> | null = null;
const editorOptions = reactive<ProductEditorOptions>({
  categories: [],
  brands: [],
  product_labels: [],
  user_labels: [],
  gift_coupons: [],
  system_forms: [],
  shipping_templates: [],
  ensures: [],
  parameter_templates: [],
  sku_rule_templates: [],
});
const categories = computed(() => editorOptions.categories);
const units = ref<ProductUnit[]>([]);
const retiredAttrs = ref<ProductSkuRow[]>([]);
const selectedActiveSkuIds = ref<number[]>([]);
const selectedRetiredSkuIds = ref<number[]>([]);
const skuActionLoading = ref(false);

const isEdit = computed(() => !!route.params.id);
const form = reactive({
  store_name: "",
  store_info: "",
  image: "",
  price: 0,
  ot_price: 0,
  stock: 0,
  unit_name: "件",
  keyword: "",
  cate_id: "",
  brand_id: undefined as number | undefined,
  store_label_id: [] as number[],
  ensure_id: [] as number[],
  specs_id: undefined as number | undefined,
  specs: [] as ProductEditorParameter[],
  spec_type: 0 as 0 | 1,
  sku_rule_id: undefined as number | undefined,
  items: [{ value: "规格", detail: ["默认"] }] as ProductSkuDimension[],
  attrs: [] as ProductSkuRow[],
  sort: 0,
  is_vip: 0,
  vip_price: 0,
  is_show: 1,
});

async function submit() {
  if (!form.store_name) return ElMessage.error("请输入商品名称");
  if (!form.items.length || !form.attrs.length) return ElMessage.error("请先生成商品SKU");
  prepareSkuPayload();
  if (form.price <= 0 || form.attrs.some((row) => Number(row.price) <= 0)) {
    return ElMessage.error("请填写每个SKU的有效售价");
  }

  submitting.value = true;
  try {
    if (isEdit.value) {
      await apiAdminProductUpdate(Number(route.params.id), { ...form });
    } else {
      await apiAdminProductCreate({ ...form });
      draftReady.value = false;
      if (draftTimer) clearTimeout(draftTimer);
      await apiAdminProductDraftDelete().catch(() => null);
    }
    ElMessage.success("保存成功");
    router.push("/product");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "保存失败");
  } finally {
    submitting.value = false;
  }
}

function selectableHistoricalSku(row: ProductSkuRow) {
  return Number.isSafeInteger(row.id) && Number(row.id) > 0;
}

function selectActiveSkus(rows: ProductSkuRow[]) {
  selectedActiveSkuIds.value = rows.flatMap((row) => row.id ? [row.id] : []);
}

function selectRetiredSkus(rows: ProductSkuRow[]) {
  selectedRetiredSkuIds.value = rows.flatMap((row) => row.id ? [row.id] : []);
}

async function reloadSkuState() {
  const detail = await apiAdminProductDetail(Number(route.params.id));
  form.items = detail.items.map((item) => ({ ...item, detail: [...item.detail] }));
  form.attrs = restoreSkuRows(detail.attrs);
  retiredAttrs.value = restoreSkuRows(detail.retired_attrs ?? []);
  form.stock = detail.stock;
  form.price = Number(detail.price);
  form.ot_price = Number(detail.ot_price);
  form.vip_price = Number(detail.vip_price ?? 0);
  selectedActiveSkuIds.value = [];
  selectedRetiredSkuIds.value = [];
}

async function changeSkuLifecycle(action: "retire" | "restore") {
  const skuIds = action === "retire" ? selectedActiveSkuIds.value : selectedRetiredSkuIds.value;
  if (!skuIds.length) return ElMessage.warning("请选择历史SKU");
  try {
    const { value } = await ElMessageBox.prompt(
      action === "retire"
        ? "退役不会删除历史记录，但会停止新交易。请填写原因。"
        : "恢复会重新加入可售规格组合。请填写原因。",
      action === "retire" ? "确认退役SKU" : "确认恢复SKU",
      {
        confirmButtonText: "确认执行",
        cancelButtonText: "取消",
        inputPlaceholder: "2至255字",
        inputValidator: (input) => {
          const length = input.trim().length;
          return length >= 2 && length <= 255 ? true : "请填写2至255字的操作原因";
        },
      },
    );
    skuActionLoading.value = true;
    const result = action === "retire"
      ? await apiAdminProductSkuRetire(Number(route.params.id), skuIds, value.trim())
      : await apiAdminProductSkuRestore(Number(route.params.id), skuIds, value.trim());
    if (!result.verified) throw new Error("SKU退役状态数据库回读未通过");
    await reloadSkuState();
    ElMessage.success(action === "retire" ? `已退役 ${result.changed} 个SKU` : `已恢复 ${result.changed} 个SKU`);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "SKU状态操作失败");
  } finally {
    skuActionLoading.value = false;
  }
}

function newSkuRow(detail: Record<string, string>): ProductSkuRow {
  return {
    suk: Object.values(detail).join(","),
    detail,
    image: "",
    price: form.price,
    settle_price: 0,
    cost: 0,
    ot_price: form.ot_price,
    vip_price: form.vip_price,
    stock: form.stock,
    bar_code: "",
    weight: 0,
    volume: 0,
    brokerage: 0,
    brokerage_two: 0,
    code: "",
  };
}

function skuCombinations(dimensions: ProductSkuDimension[]): Array<Record<string, string>> {
  let rows: Array<Record<string, string>> = [{}];
  for (const dimension of dimensions) {
    rows = rows.flatMap((row) => dimension.detail.map((value) => ({ ...row, [dimension.value]: value })));
    if (rows.length > 200) return [];
  }
  return rows;
}

function regenerateSkuRows(dimensions: ProductSkuDimension[]) {
  const current = new Map(form.attrs.map((row) => [row.suk, row]));
  const combinations = skuCombinations(dimensions);
  if (!combinations.length) {
    ElMessage.error("SKU组合不能为空且不能超过200项");
    return;
  }
  form.items = dimensions.map((dimension) => ({ ...dimension, detail: [...dimension.detail] }));
  form.attrs = combinations.map((detail) => {
    const suk = form.items.map((dimension) => detail[dimension.value]).join(",");
    const existing = current.get(suk);
    return existing ? { ...existing, detail: { ...detail }, suk } : newSkuRow(detail);
  });
}

function changeSpecType(value: unknown) {
  form.spec_type = Number(value) === 1 ? 1 : 0;
  form.sku_rule_id = undefined;
  if (form.spec_type === 0) {
    regenerateSkuRows([{ value: "规格", detail: ["默认"] }]);
  } else {
    form.items = [];
    form.attrs = [];
  }
}

function applySkuRuleTemplate() {
  const template = editorOptions.sku_rule_templates.find((item) => item.id === form.sku_rule_id);
  if (!template) return ElMessage.error("请选择SKU规格模板");
  form.spec_type = 1;
  regenerateSkuRows(template.dimensions);
}

function prepareSkuPayload() {
  if (form.spec_type === 0) {
    const row = form.attrs[0] ?? newSkuRow({ 规格: "默认" });
    form.items = [{ value: "规格", detail: ["默认"] }];
    form.attrs = [{
      ...row,
      suk: "默认",
      detail: { 规格: "默认" },
      price: form.price,
      ot_price: form.ot_price,
      vip_price: form.vip_price,
      stock: form.stock,
    }];
    return;
  }
  form.stock = form.attrs.reduce((sum, row) => sum + Number(row.stock || 0), 0);
  form.price = Math.min(...form.attrs.map((row) => Number(row.price || 0)));
  form.ot_price = Math.min(...form.attrs.map((row) => Number(row.ot_price || 0)));
  form.vip_price = Math.min(...form.attrs.map((row) => Number(row.vip_price || 0)));
}

function applyParameterTemplate(value: unknown) {
  const id = Number(value ?? 0);
  form.specs_id = Number.isSafeInteger(id) && id > 0 ? id : undefined;
  const template = editorOptions.parameter_templates.find((item) => item.id === form.specs_id);
  form.specs = template
    ? template.specs.filter((item) => item.status === 1).map((item) => ({ ...item }))
    : [];
}

function restoreDraft(value: Record<string, unknown>) {
  const stringFields = ["store_name", "store_info", "image", "unit_name", "keyword", "cate_id"] as const;
  const numberFields = ["price", "ot_price", "stock", "sort", "is_vip", "vip_price", "is_show"] as const;
  for (const key of stringFields) {
    if (typeof value[key] === "string") form[key] = value[key];
  }
  for (const key of numberFields) {
    const parsed = Number(value[key]);
    if (Number.isFinite(parsed)) form[key] = parsed;
  }
  const specType = Number(value.spec_type);
  if (specType === 0 || specType === 1) form.spec_type = specType;
  for (const key of ["store_label_id", "ensure_id"] as const) {
    if (Array.isArray(value[key])) {
      form[key] = value[key]
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    }
  }
  const brandId = Number(value.brand_id);
  if (Number.isSafeInteger(brandId) && brandId > 0) form.brand_id = brandId;
  const specsId = Number(value.specs_id);
  if (Number.isSafeInteger(specsId) && specsId > 0) form.specs_id = specsId;
  if (Array.isArray(value.specs)) {
    form.specs = value.specs.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (typeof row.name !== "string" || typeof row.value !== "string") return [];
      return [{
        id: Number(row.id) || 0,
        name: row.name,
        value: row.value,
        sort: Number(row.sort) || 0,
        status: Number(row.status) === 0 ? 0 : 1,
      }];
    });
  }
  const skuRuleId = Number(value.sku_rule_id);
  if (Number.isSafeInteger(skuRuleId) && skuRuleId > 0) form.sku_rule_id = skuRuleId;
  if (Array.isArray(value.items)) {
    form.items = value.items.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (typeof row.value !== "string" || !Array.isArray(row.detail)) return [];
      const detail = row.detail.filter((entry): entry is string => typeof entry === "string");
      return detail.length ? [{ value: row.value, detail }] : [];
    });
  }
  if (Array.isArray(value.attrs)) form.attrs = restoreSkuRows(value.attrs);
}

function restoreSkuRows(value: unknown[]): ProductSkuRow[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.suk !== "string") return [];
    const detail = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
      ? Object.fromEntries(Object.entries(row.detail).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return [{
      id: Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0 ? Number(row.id) : undefined,
      unique: typeof row.unique === "string" ? row.unique : undefined,
      suk: row.suk,
      detail,
      image: typeof row.image === "string" ? row.image : "",
      price: Number(row.price ?? 0),
      settle_price: Number(row.settle_price ?? 0),
      cost: Number(row.cost ?? 0),
      ot_price: Number(row.ot_price ?? 0),
      vip_price: Number(row.vip_price ?? 0),
      stock: Number(row.stock ?? 0),
      sales: Number(row.sales ?? 0),
      sumStock: Number(row.sumStock ?? row.sum_stock ?? 0),
      bar_code: typeof row.bar_code === "string" ? row.bar_code : "",
      weight: Number(row.weight ?? 0),
      volume: Number(row.volume ?? 0),
      brokerage: Number(row.brokerage ?? 0),
      brokerage_two: Number(row.brokerage_two ?? 0),
      code: typeof row.code === "string" ? row.code : "",
      is_retired: Number(row.is_retired) === 1 ? 1 : 0,
    }];
  });
}

async function saveDraft() {
  if (isEdit.value || !draftReady.value) return;
  draftSaving.value = true;
  try {
    await apiAdminProductDraftSave({ ...form });
    draftStatus.value = `草稿已自动保存 ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch {
    draftStatus.value = "草稿自动保存失败";
  } finally {
    draftSaving.value = false;
  }
}

async function clearDraft() {
  if (draftTimer) clearTimeout(draftTimer);
  draftSaving.value = true;
  try {
    await apiAdminProductDraftDelete();
    draftStatus.value = "服务器草稿已删除，当前表单内容保留";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "删除草稿失败");
  } finally {
    draftSaving.value = false;
  }
}

watch(form, () => {
  if (isEdit.value || !draftReady.value) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void saveDraft(), 1_000);
}, { deep: true });

onMounted(async () => {
  const [optionsResult, unitResult] = await Promise.allSettled([
    apiAdminProductEditorOptions(),
    apiProductUnitList({ page: 1, limit: 100 }),
  ]);
  if (optionsResult.status === "fulfilled") Object.assign(editorOptions, optionsResult.value);
  if (unitResult.status === "fulfilled") units.value = unitResult.value.list;
  if (isEdit.value) {
    try {
      const detail = await apiAdminProductDetail(Number(route.params.id));
      form.store_name = detail.store_name;
      form.store_info = detail.store_info;
      form.image = detail.image;
      form.price = Number(detail.price);
      form.ot_price = Number(detail.ot_price);
      form.stock = detail.stock;
      form.unit_name = detail.unit_name;
      form.keyword = detail.keyword;
      form.cate_id = String(detail.cate_id[0] ?? "");
      form.brand_id = detail.brand_id.at(-1);
      form.store_label_id = [...detail.store_label_id];
      form.ensure_id = [...detail.ensure_id];
      form.specs_id = detail.specs_id || undefined;
      form.specs = detail.specs.map((item) => ({ ...item }));
      form.spec_type = detail.spec_type;
      form.items = detail.items.map((item) => ({ ...item, detail: [...item.detail] }));
      form.attrs = restoreSkuRows(detail.attrs);
      retiredAttrs.value = restoreSkuRows(detail.retired_attrs ?? []);
      if (!form.attrs.length && form.spec_type === 0) {
        form.attrs = [newSkuRow({ 规格: "默认" })];
      }
      form.sort = detail.sort ?? 0;
      form.is_vip = detail.is_vip ?? 0;
      form.vip_price = Number(detail.vip_price ?? 0);
      form.is_show = detail.is_show;
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : "加载失败");
    }
  } else {
    form.attrs = [newSkuRow({ 规格: "默认" })];
    try {
      const cached = await apiAdminProductDraft();
      if (!Array.isArray(cached.info) && Object.keys(cached.info).length) {
        restoreDraft(cached.info);
        draftStatus.value = "已恢复服务器草稿";
      }
    } catch {
      draftStatus.value = "草稿读取失败";
    } finally {
      draftReady.value = true;
    }
  }
});

onBeforeUnmount(() => {
  if (draftTimer) clearTimeout(draftTimer);
});
</script>

<style scoped>
.product-form {
  max-width: 980px;
}
.editor-form {
  max-width: 820px;
}
.field-row {
  display: flex;
  width: 100%;
  gap: 8px;
}
.field-row .el-select {
  flex: 1;
}
.association-alert {
  margin-bottom: 18px;
}
.parameter-snapshot {
  display: grid;
  width: 100%;
  gap: 10px;
}
.parameter-row {
  display: grid;
  grid-template-columns: minmax(96px, 180px) minmax(180px, 1fr);
  align-items: center;
  gap: 10px;
}
.parameter-name {
  overflow: hidden;
  color: var(--el-text-color-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sku-dimensions {
  display: grid;
  width: 100%;
  gap: 8px;
}
.sku-dimension {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.sku-dimension strong {
  min-width: 72px;
}
.sku-table-shell {
  width: 100%;
  min-width: 0;
  overflow: hidden;
}
.sku-table {
  width: 100%;
  margin-bottom: 8px;
}
.sku-table :deep(.el-input-number) {
  width: 100%;
}
.sku-lifecycle-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
@media (max-width: 640px) {
  .product-form {
    max-width: 100%;
  }
  .editor-form :deep(.el-form-item) {
    display: block;
  }
  .editor-form :deep(.el-form-item__label) {
    width: auto !important;
    height: auto;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .editor-form :deep(.el-form-item__content) {
    margin-left: 0 !important;
  }
  .field-row {
    align-items: stretch;
    flex-direction: column;
  }
  .parameter-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
