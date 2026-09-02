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
import { ElMessage } from "element-plus";
import {
  apiAdminProductCreate,
  apiAdminProductUpdate,
  apiAdminProductDetail,
  apiAdminProductEditorOptions,
  apiAdminProductDraft,
  apiAdminProductDraftDelete,
  apiAdminProductDraftSave,
  type ProductEditorOptions,
  type ProductEditorParameter,
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
  ensures: [],
  parameter_templates: [],
});
const categories = computed(() => editorOptions.categories);
const units = ref<ProductUnit[]>([]);

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
  sort: 0,
  is_vip: 0,
  vip_price: 0,
  is_show: 1,
});

async function submit() {
  if (!form.store_name) return ElMessage.error("请输入商品名称");
  if (form.price <= 0) return ElMessage.error("请输入价格");

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
      form.sort = detail.sort ?? 0;
      form.is_vip = detail.is_vip ?? 0;
      form.vip_price = Number(detail.vip_price ?? 0);
      form.is_show = detail.is_show;
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : "加载失败");
    }
  } else {
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
