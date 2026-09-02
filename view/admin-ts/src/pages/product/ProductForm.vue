<template>
  <div class="product-form">
    <el-card shadow="never">
      <template #header>{{ isEdit ? "编辑商品" : "添加商品" }}</template>

      <el-form :model="form" label-width="100px" style="max-width: 640px">
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
              :label="cat.cateName"
              :value="String(cat.id)"
            />
          </el-select>
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
  apiAdminProductDraft,
  apiAdminProductDraftDelete,
  apiAdminProductDraftSave,
} from "@/api/product";
import { apiAdminCategoryList, type CategoryItem } from "@/api/category";
import { apiProductUnitList, type ProductUnit } from "@/api/productMetadata";

const route = useRoute();
const router = useRouter();
const submitting = ref(false);
const draftSaving = ref(false);
const draftStatus = ref("");
const draftReady = ref(false);
let draftTimer: ReturnType<typeof setTimeout> | null = null;
const categories = ref<CategoryItem[]>([]);
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
  const [categoryResult, unitResult] = await Promise.allSettled([
    apiAdminCategoryList(),
    apiProductUnitList({ page: 1, limit: 100 }),
  ]);
  if (categoryResult.status === "fulfilled") categories.value = categoryResult.value;
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
      form.cate_id = String(detail.cate_id ?? "");
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
  max-width: 800px;
}
.field-row {
  display: flex;
  width: 100%;
  gap: 8px;
}
.field-row .el-select {
  flex: 1;
}
</style>
