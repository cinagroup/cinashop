<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { ArrowLeft, Delete, Plus } from "@element-plus/icons-vue";
import { getProductCategories, getProductDetail, getShippingTemplates, saveProduct } from "@/api/supplier";
import type { ProductCategory, ProductDetail, ProductDimension, ProductSku, ShippingTemplateRow } from "@/types";

const route = useRoute();
const router = useRouter();
const productId = computed(() => Number(route.params.id ?? 0));
const editing = computed(() => Number.isInteger(productId.value) && productId.value > 0);
const loading = ref(false);
const saving = ref(false);
const categories = ref<ProductCategory[]>([]);
const shippingTemplates = ref<ShippingTemplateRow[]>([]);

function blankSku(detail: Record<string, string>, previous?: ProductSku): ProductSku {
  const suk = Object.values(detail).join(",");
  return {
    unique: previous?.unique,
    suk,
    detail,
    image: previous?.image ?? "",
    price: previous?.price ?? "0.00",
    settle_price: previous?.settle_price ?? "0.00",
    cost: previous?.cost ?? "0.00",
    ot_price: previous?.ot_price ?? "0.00",
    vip_price: previous?.vip_price ?? "0.00",
    stock: previous?.stock ?? 0,
    sales: previous?.sales ?? 0,
    bar_code: previous?.bar_code ?? "",
    weight: previous?.weight ?? "0.00",
    volume: previous?.volume ?? "0.00",
    brokerage: previous?.brokerage ?? "0.00",
    brokerage_two: previous?.brokerage_two ?? "0.00",
    code: previous?.code ?? "",
  };
}

function initialForm(): ProductDetail {
  return {
    id: 0,
    product_type: 0,
    store_name: "",
    store_info: "",
    keyword: "",
    unit_name: "件",
    bar_code: "",
    cate_id: [],
    slider_image: [""],
    description: "",
    spec_type: 0,
    items: [{ value: "规格", detail: ["默认"] }],
    attrs: [blankSku({ 规格: "默认" })],
    freight: 1,
    postage: "0.00",
    temp_id: 0,
    is_postage: 1,
    is_support_refund: 1,
    is_limit: 0,
    limit_type: 1,
    limit_num: 1,
    sort: 0,
    ficti: 0,
    video_link: "",
  };
}

const form = reactive<ProductDetail>(initialForm());

const treeProps = { label: "cate_name", children: "children", value: "id" };

function cartesian(dimensions: ProductDimension[]) {
  let result: Array<Record<string, string>> = [{}];
  for (const dimension of dimensions) {
    result = result.flatMap((current) =>
      dimension.detail.map((detail) => ({ ...current, [dimension.value.trim()]: detail.trim() })),
    );
  }
  return result;
}

function regenerateSkus(showMessage = true) {
  if (form.spec_type === 0) {
    const previous = form.attrs.find((item) => item.suk === "默认") ?? form.attrs[0];
    form.items = [{ value: "规格", detail: ["默认"] }];
    form.attrs = [blankSku({ 规格: "默认" }, previous)];
    return;
  }
  if (!form.items.length || form.items.some((item) => !item.value.trim() || !item.detail.length || item.detail.some((value) => !value.trim()))) {
    if (showMessage) ElMessage.warning("请先完整填写每个规格名称和规格值");
    return;
  }
  const names = form.items.map((item) => item.value.trim());
  if (new Set(names).size !== names.length) return void ElMessage.warning("规格名称不能重复");
  const combinations = cartesian(form.items);
  if (combinations.length > 200) return void ElMessage.warning("SKU组合不能超过200项");
  const bySuk = new Map(form.attrs.map((item) => [item.suk, item]));
  form.attrs = combinations.map((detail) => {
    const suk = Object.values(detail).join(",");
    return blankSku(detail, bySuk.get(suk));
  });
  if (showMessage) ElMessage.success(`已生成 ${form.attrs.length} 个 SKU`);
}

watch(
  () => form.spec_type,
  (value) => {
    if (value === 0) regenerateSkus(false);
    else if (form.items.length === 1 && form.items[0].value === "规格") {
      form.items = [{ value: "颜色", detail: [] }];
      form.attrs = [];
    }
  },
);

function addDimension() {
  if (form.items.length >= 3) return ElMessage.warning("最多支持3个规格维度");
  form.items.push({ value: "", detail: [] });
}

function removeDimension(index: number) {
  form.items.splice(index, 1);
  form.attrs = [];
}

function addSlider() {
  if (form.slider_image.length >= 20) return ElMessage.warning("轮播图不能超过20张");
  form.slider_image.push("");
}

function removeSlider(index: number) {
  form.slider_image.splice(index, 1);
  if (!form.slider_image.length) form.slider_image.push("");
}

function validateForm() {
  if (!form.store_name.trim()) return "请填写商品名称";
  if (!form.cate_id.length) return "请选择商品分类";
  if (!form.slider_image.some((item) => item.trim())) return "请至少填写一张商品图片地址";
  if (!form.attrs.length) return "请生成SKU";
  for (const sku of form.attrs) {
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(sku.price) || Number(sku.price) <= 0) return `SKU ${sku.suk} 的销售价格式错误`;
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(sku.settle_price) || Number(sku.settle_price) <= 0) return `SKU ${sku.suk} 的结算价格式错误`;
    if (Number(sku.brokerage || 0) + Number(sku.brokerage_two || 0) > Number(sku.price)) return `SKU ${sku.suk} 的佣金之和不能超过销售价`;
  }
  if (form.freight === 2 && (!/^\d{1,10}(?:\.\d{1,2})?$/.test(form.postage) || Number(form.postage) <= 0)) return "固定邮费必须大于0且最多两位小数";
  if (form.freight === 3 && !form.temp_id) return "请选择当前供应商的运费模板";
  return "";
}

async function submit() {
  const validation = validateForm();
  if (validation) return ElMessage.warning(validation);
  saving.value = true;
  try {
    form.slider_image = form.slider_image.map((item) => item.trim()).filter(Boolean);
    const result = await saveProduct(editing.value ? productId.value : 0, { ...form });
    ElMessage.success(`商品 #${result.id} 已保存并进入待审核状态`);
    await router.push("/products");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "商品保存失败");
  } finally {
    saving.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    const [categoryRows, templateResult] = await Promise.all([
      getProductCategories(),
      getShippingTemplates({ page: 1, limit: 100 }),
    ]);
    categories.value = categoryRows;
    shippingTemplates.value = templateResult.data;
    if (editing.value) Object.assign(form, await getProductDetail(productId.value));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "商品资料加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading" class="page-section product-form-page">
    <header class="page-heading product-form-heading">
      <div class="heading-with-back">
        <el-button circle plain :icon="ArrowLeft" aria-label="返回商品列表" @click="router.push('/products')" />
        <div><h1>{{ editing ? "编辑实物商品" : "新增实物商品" }}</h1><p>保存后商品将下架并进入平台待审核状态</p></div>
      </div>
      <el-button type="primary" :loading="saving" @click="submit">保存并提交审核</el-button>
    </header>

    <el-alert title="当前仅开放实物商品" type="info" show-icon :closable="false" description="卡密、优惠券、虚拟商品和次卡的履约链路尚未迁移完成，暂不允许创建。" />

    <div class="product-form-layout">
      <main class="product-form-main">
        <article class="surface product-form-card">
          <header><h2>基础信息</h2><p>名称、分类和展示素材</p></header>
          <el-form label-position="top">
            <div class="form-grid">
              <el-form-item class="wide" label="商品名称" required><el-input v-model="form.store_name" maxlength="256" show-word-limit /></el-form-item>
              <el-form-item class="wide" label="商品简介"><el-input v-model="form.store_info" maxlength="256" show-word-limit /></el-form-item>
              <el-form-item label="商品分类" required>
                <el-tree-select v-model="form.cate_id" :data="categories" :props="treeProps" multiple check-strictly show-checkbox clearable style="width: 100%" placeholder="选择本供应商分类" />
              </el-form-item>
              <el-form-item label="计量单位"><el-input v-model="form.unit_name" maxlength="32" /></el-form-item>
              <el-form-item label="搜索关键词"><el-input v-model="form.keyword" maxlength="256" placeholder="多个关键词可用逗号分隔" /></el-form-item>
              <el-form-item label="商品条码"><el-input v-model="form.bar_code" maxlength="15" /></el-form-item>
            </div>
          </el-form>
        </article>

        <article class="surface product-form-card">
          <header class="card-heading-row"><div><h2>轮播图片</h2><p>填写可公开访问的 HTTPS 图片地址，第一张作为商品主图</p></div><el-button :icon="Plus" @click="addSlider">添加图片</el-button></header>
          <div class="slider-editor">
            <div v-for="(image, index) in form.slider_image" :key="index" class="slider-row">
              <div class="slider-preview"><img v-if="image" :src="image" alt="商品预览" /><span v-else>{{ index + 1 }}</span></div>
              <el-input v-model="form.slider_image[index]" placeholder="https://..." />
              <el-button text type="danger" :icon="Delete" aria-label="删除图片" @click="removeSlider(index)" />
            </div>
          </div>
        </article>

        <article class="surface product-form-card">
          <header><h2>规格与 SKU</h2><p>价格、结算价和库存均以 SKU 为准</p></header>
          <el-radio-group v-model="form.spec_type" class="spec-type-group"><el-radio-button :value="0">单规格</el-radio-button><el-radio-button :value="1">多规格</el-radio-button></el-radio-group>
          <div v-if="form.spec_type === 1" class="dimension-editor">
            <div v-for="(dimension, index) in form.items" :key="index" class="dimension-row">
              <el-input v-model="dimension.value" class="dimension-name" maxlength="32" placeholder="规格名称，如颜色" />
              <el-select v-model="dimension.detail" multiple filterable allow-create default-first-option placeholder="输入规格值后回车" class="dimension-values" />
              <el-button text type="danger" :icon="Delete" aria-label="删除规格" @click="removeDimension(index)" />
            </div>
            <div class="dimension-actions"><el-button :icon="Plus" :disabled="form.items.length >= 3" @click="addDimension">添加规格维度</el-button><el-button type="primary" plain @click="regenerateSkus()">生成 / 刷新 SKU</el-button></div>
          </div>
          <div class="sku-table-wrap">
            <el-table :data="form.attrs" row-key="suk" empty-text="请先生成SKU" class="sku-table">
              <el-table-column prop="suk" label="规格组合" fixed min-width="145" />
              <el-table-column label="销售价" width="130"><template #default="scope"><el-input v-model="scope.row.price" /></template></el-table-column>
              <el-table-column label="结算价" width="130"><template #default="scope"><el-input v-model="scope.row.settle_price" /></template></el-table-column>
              <el-table-column label="成本价" width="130"><template #default="scope"><el-input v-model="scope.row.cost" /></template></el-table-column>
              <el-table-column label="原价" width="130"><template #default="scope"><el-input v-model="scope.row.ot_price" /></template></el-table-column>
              <el-table-column label="库存" width="145"><template #default="scope"><el-input-number v-model="scope.row.stock" :min="0" :max="2147483647" controls-position="right" /></template></el-table-column>
              <el-table-column label="一级佣金" width="130"><template #default="scope"><el-input v-model="scope.row.brokerage" /></template></el-table-column>
              <el-table-column label="二级佣金" width="130"><template #default="scope"><el-input v-model="scope.row.brokerage_two" /></template></el-table-column>
              <el-table-column label="SKU编码" width="160"><template #default="scope"><el-input v-model="scope.row.code" maxlength="50" /></template></el-table-column>
              <el-table-column label="重量" width="120"><template #default="scope"><el-input v-model="scope.row.weight" /></template></el-table-column>
              <el-table-column label="体积" width="120"><template #default="scope"><el-input v-model="scope.row.volume" /></template></el-table-column>
            </el-table>
          </div>
        </article>

        <article class="surface product-form-card">
          <header><h2>商品详情</h2><p>当前使用安全的纯文本详情；可填写退换货、材质和使用说明</p></header>
          <el-input v-model="form.description" type="textarea" :rows="10" maxlength="200000" show-word-limit placeholder="填写商品详细说明" />
        </article>
      </main>

      <aside class="product-form-aside">
        <article class="surface product-form-card compact-card">
          <header><h2>配送与售后</h2></header>
          <el-form label-position="top">
            <el-form-item label="配送方式"><el-input model-value="快递配送" disabled /></el-form-item>
            <el-form-item label="运费设置">
              <el-radio-group v-model="form.freight">
                <el-radio :value="1">包邮</el-radio>
                <el-radio :value="2">固定邮费</el-radio>
                <el-radio :value="3">运费模板</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="form.freight === 2" label="固定邮费（元）"><el-input v-model="form.postage" /></el-form-item>
            <el-form-item v-if="form.freight === 3" label="运费模板">
              <el-select v-model="form.temp_id" clearable filterable placeholder="选择当前供应商模板" style="width: 100%">
                <el-option v-for="item in shippingTemplates" :key="item.id" :label="`${item.name}（${item.type}）`" :value="item.id" />
              </el-select>
              <el-button link type="primary" @click="router.push('/shipping-templates')">管理运费模板</el-button>
            </el-form-item>
            <el-form-item><el-checkbox v-model="form.is_support_refund" :true-value="1" :false-value="0">支持退款退货</el-checkbox></el-form-item>
          </el-form>
        </article>
        <article class="surface product-form-card compact-card">
          <header><h2>销售设置</h2></header>
          <el-form label-position="top">
            <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="1000000" /></el-form-item>
            <el-form-item label="虚拟销量"><el-input-number v-model="form.ficti" :min="0" :max="2147483647" /></el-form-item>
            <el-form-item><el-checkbox v-model="form.is_limit" :true-value="1" :false-value="0">启用限购</el-checkbox></el-form-item>
            <template v-if="form.is_limit">
              <el-form-item label="限购范围"><el-radio-group v-model="form.limit_type"><el-radio :value="1">每单</el-radio><el-radio :value="2">终身</el-radio></el-radio-group></el-form-item>
              <el-form-item label="限购数量"><el-input-number v-model="form.limit_num" :min="1" /></el-form-item>
            </template>
          </el-form>
        </article>
        <article v-if="editing" class="surface review-card">
          <span>当前审核状态</span>
          <strong :class="form.is_verify === 1 ? 'success' : form.is_verify && form.is_verify < 0 ? 'danger' : 'warning'">{{ form.is_verify === 1 ? "已通过" : form.is_verify === -1 ? "已拒绝" : form.is_verify === -2 ? "强制下架" : "审核中" }}</strong>
          <p v-if="form.refusal">{{ form.refusal }}</p>
        </article>
      </aside>
    </div>

    <footer class="product-form-footer"><span>保存会重置为待审核并下架，避免未审核改动直接对外销售。</span><div><el-button @click="router.push('/products')">取消</el-button><el-button type="primary" :loading="saving" @click="submit">保存并提交审核</el-button></div></footer>
  </section>
</template>
