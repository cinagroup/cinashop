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
          <el-input v-model="form.unit_name" placeholder="如: 件" />
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
          <el-button @click="$router.back()">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  apiAdminProductCreate,
  apiAdminProductUpdate,
  apiAdminProductDetail,
} from "@/api/product";
import { apiAdminCategoryList, type CategoryItem } from "@/api/category";

const route = useRoute();
const router = useRouter();
const submitting = ref(false);
const categories = ref<CategoryItem[]>([]);

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
    }
    ElMessage.success("保存成功");
    router.push("/product");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "保存失败");
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    categories.value = await apiAdminCategoryList();
  } catch {
    // ignore
  }
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
  }
});
</script>

<style scoped>
.product-form {
  max-width: 800px;
}
</style>
