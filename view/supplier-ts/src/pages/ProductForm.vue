<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeft, Delete, Plus } from "@element-plus/icons-vue";
import {
  getProductCategories,
  getProductDetail,
  getProductRuleTemplates,
  restoreProductSkus,
  retireProductSkus,
  saveProduct,
  previewMode,
} from "@/api/supplier";
import type { ProductCategory, ProductDetail, ProductDimension, ProductRuleTemplate, ProductSku } from "@/types";
import ShippingTemplatePicker from '@/components/ShippingTemplatePicker.vue';
import ProductImagePicker from '@/components/ProductImagePicker.vue';
import type { SupplierAttachment } from '@/api/attachments';
import { escapeProductText, formatProductDescription, productDescriptionPreview, productImagePreview, type ProductMediaPreview } from '@/utils/productMedia';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const productId = computed(() => Number(route.params.id ?? 0));
const editing = computed(() => Number.isInteger(productId.value) && productId.value > 0);
const canManageProducts = computed(() => auth.can("supplier.product.manage"));
const loading = ref(false);
const saving = ref(false);
const skuActionLoading = ref(false);
const retiredAttrs = ref<ProductSku[]>([]);
const selectedActiveSkuIds = ref<number[]>([]);
const selectedRetiredSkuIds = ref<number[]>([]);
const categories = ref<ProductCategory[]>([]);
const ruleTemplates = ref<ProductRuleTemplate[]>([]);
const selectedRuleId = ref<number | null>(null);
const mediaPickerOpen = ref(false), mediaGeneration = ref(0), showDescriptionPreview = ref(false);
const mediaTarget = ref<{ kind: 'slider' | 'sku' | 'sku-batch' | 'description'; sku?: ProductSku; skus?: ProductSku[] } | null>(null);
const mediaPreviews = ref<Record<string, ProductMediaPreview>>({});
const failedPreviewSources = ref(new Set<string>());
const mediaReading = ref(false), mediaInvalidated = ref(false);
const mediaContext = computed(() => `${productId.value}:${mediaGeneration.value}`);
const mediaLimit = computed(() => mediaTarget.value?.kind === 'slider' ? 20 - form.slider_image.filter(item => item.trim()).length : mediaTarget.value?.kind === 'description' ? 20 : 1);
const canChooseMedia = computed(() => canManageProducts.value && auth.can('supplier.attachment.view') && Number.isSafeInteger(auth.user?.supplier_id) && Number(auth.user?.supplier_id) > 0 && !mediaInvalidated.value);
const descriptionInput = ref<{ textarea?: HTMLTextAreaElement }>();
const descriptionCursor = ref({ start: 0, end: 0 });
let mediaReadGeneration = 0, formReadGeneration = 0, formSaveGeneration = 0, skuActionGeneration = 0;
const mediaSession = createSupplierSessionScope(() => {
  mediaInvalidated.value = true; mediaPickerOpen.value = false; mediaTarget.value = null;
  mediaPreviews.value = {}; showDescriptionPreview.value = false; mediaReadGeneration += 1;
  failedPreviewSources.value = new Set(); skuActionGeneration += 1; skuActionLoading.value = false; mediaReading.value = false;
  formReadGeneration += 1; formSaveGeneration += 1; resetProductForm(); saving.value = false;
  categories.value = []; ruleTemplates.value = []; retiredAttrs.value = []; selectedActiveSkuIds.value = []; selectedRetiredSkuIds.value = []; selectedRuleId.value = null; loading.value = false;
}, previewMode);
onBeforeUnmount(() => { mediaReadGeneration += 1; formReadGeneration += 1; formSaveGeneration += 1; skuActionGeneration += 1; mediaSession.dispose(); });

function blankSku(detail: Record<string, string>, previous?: ProductSku): ProductSku {
  const suk = Object.values(detail).join(",");
  return {
    id: previous?.id,
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
    sumStock: previous?.sumStock,
    is_retired: previous?.is_retired ?? 0,
    bar_code: previous?.bar_code ?? "",
    weight: previous?.weight ?? "0.00",
    volume: previous?.volume ?? "0.00",
    brokerage: previous?.brokerage ?? "0.00",
    brokerage_two: previous?.brokerage_two ?? "0.00",
    code: previous?.code ?? "",
    disk_info: previous?.disk_info ?? "",
    delivery_mode: previous?.delivery_mode ?? (previous?.disk_info?.trim() ? "fixed" : "card"),
    original_disk_info: previous?.original_disk_info ?? previous?.disk_info ?? "",
  };
}

function selectableHistoricalSku(row: ProductSku) {
  return editing.value && Number.isSafeInteger(row.id) && Number(row.id) > 0;
}

function selectActiveSkus(rows: ProductSku[]) {
  selectedActiveSkuIds.value = rows.flatMap((row) => row.id ? [row.id] : []);
}

function selectRetiredSkus(rows: ProductSku[]) {
  selectedRetiredSkuIds.value = rows.flatMap((row) => row.id ? [row.id] : []);
}

async function changeSkuLifecycle(action: "retire" | "restore") {
  if (!editing.value || !canManageProducts.value || !mediaSession.isCurrent() || loading.value || saving.value || skuActionLoading.value) return;
  const id = productId.value, generation = ++skuActionGeneration;
  const skuIds = [...(action === "retire" ? selectedActiveSkuIds.value : selectedRetiredSkuIds.value)];
  if (!skuIds.length) return ElMessage.warning("请选择历史SKU");
  const current = () => generation === skuActionGeneration && mediaSession.isCurrent() && productId.value === id;
  skuActionLoading.value = true;
  try {
    const { value } = await ElMessageBox.prompt(
      action === "retire"
        ? "退役会停止该SKU的新交易并重新加载商品资料，未保存编辑会丢失。请填写原因。"
        : "恢复会重新加入可售规格组合并重新加载商品资料。请填写原因。",
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
    if (!current()) return;
    const result = action === "retire"
      ? await retireProductSkus(id, skuIds, value.trim())
      : await restoreProductSkus(id, skuIds, value.trim());
    if (!current()) return;
    if (!result.verified) throw new Error("SKU状态数据库回读未通过");
    const detail = await getProductDetail(id);
    if (!current()) return;
    applyProductDetail(detail); selectedActiveSkuIds.value = []; selectedRetiredSkuIds.value = [];
    ElMessage.success(action === "retire" ? `已退役 ${result.changed} 个SKU` : `已恢复 ${result.changed} 个SKU`);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    if (current()) ElMessage.error(error instanceof Error ? error.message : "SKU状态操作失败");
  } finally {
    if (generation === skuActionGeneration) skuActionLoading.value = false;
  }
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
function resetProductForm() {
  for (const key of Object.keys(form)) Reflect.deleteProperty(form, key);
  Object.assign(form, initialForm());
}
const isCardProduct = computed(() => form.product_type === 1);
const isManualVirtualProduct = computed(() => form.product_type === 3);
const isPhysicalProduct = computed(() => form.product_type === 0);

function editableSku(sku: ProductSku): ProductSku {
  const diskInfo = sku.disk_info ?? "";
  return {
    ...sku,
    disk_info: isCardProduct.value ? diskInfo : "",
    delivery_mode: isCardProduct.value ? (diskInfo.trim() ? "fixed" : "card") : undefined,
    original_disk_info: isCardProduct.value ? diskInfo : "",
  };
}

function applyProductDetail(detail: ProductDetail) {
  invalidateMediaTarget();
  Object.assign(form, { ...detail, attrs: detail.attrs.map(editableSku) });
  retiredAttrs.value = (detail.retired_attrs ?? []).map(editableSku);
  mediaPreviews.value = detail.media?.version === 1 ? detail.media.previews : {};
  failedPreviewSources.value = new Set();
}

function invalidateMediaTarget() {
  mediaPickerOpen.value = false; mediaTarget.value = null; mediaGeneration.value += 1; mediaReadGeneration += 1; mediaReading.value = false;
}
function openMedia(kind: 'slider' | 'sku' | 'sku-batch' | 'description', sku?: ProductSku) {
  if (!canChooseMedia.value || !mediaSession.isCurrent() || loading.value || saving.value) return;
  if (kind === 'slider' && form.slider_image.filter(item => item.trim()).length >= 20) return void ElMessage.warning('轮播图不能超过20张');
  if (kind === 'sku' && (!sku || !form.attrs.includes(sku))) return;
  const skus = kind === 'sku-batch' ? form.attrs.filter(item => selectedActiveSkuIds.value.includes(item.id ?? 0)) : undefined;
  if (kind === 'sku-batch' && !skus?.length) return void ElMessage.warning('请选择需要设置图片的SKU');
  mediaGeneration.value += 1; mediaTarget.value = { kind, sku, skus }; mediaPickerOpen.value = true;
}
function receiveMedia(images: SupplierAttachment[], contextKey = mediaContext.value) {
  const target = mediaTarget.value;
  if (!mediaPickerOpen.value || contextKey !== mediaContext.value || !target || !canChooseMedia.value || !mediaSession.isCurrent() || loading.value || saving.value || !images.length || images.length > mediaLimit.value) return;
  if (target.kind === 'sku' && !form.attrs.includes(target.sku!)) return;
  if (target.kind === 'sku-batch' && target.skus?.some(sku => !form.attrs.includes(sku))) return;
  const previews = { ...mediaPreviews.value };
  for (const image of images) {
    const expires = image.previewUrl.startsWith('/api/assets/') ? Number(new URL(image.previewUrl, 'https://supplier.invalid').searchParams.get('expires')) : null;
    previews[image.canonicalUrl] = { status: 'ready', src: image.previewUrl, expires_at: expires };
  }
  mediaPreviews.value = previews;
  if (target.kind === 'slider') form.slider_image = [...form.slider_image.filter(item => item.trim()), ...images.map(image => image.canonicalUrl)];
  else if (target.kind === 'sku') target.sku!.image = images[0].canonicalUrl;
  else if (target.kind === 'sku-batch') for (const sku of target.skus!) sku.image = images[0].canonicalUrl;
  else {
    const text = /<[a-z][^>]*>/i.test(form.description) ? form.description : escapeProductText(form.description).replaceAll('\n', '<br>');
    const insertion = images.map(image => `<p><img src="${escapeProductText(image.canonicalUrl)}" alt="${escapeProductText(image.name)}"></p>`).join('');
    if (text.length + insertion.length > 200000) return void ElMessage.warning('商品详情不能超过200000个字符');
    form.description = text + insertion; showDescriptionPreview.value = true;
  }
  mediaPickerOpen.value = false; mediaTarget.value = null;
}
function moveSlider(index: number, direction: -1 | 1) {
  if (loading.value || saving.value || index + direction < 0 || index + direction >= form.slider_image.length) return;
  const images = [...form.slider_image]; [images[index], images[index + direction]] = [images[index + direction], images[index]]; form.slider_image = images;
}
function captureDescriptionCursor() {
  const textarea = descriptionInput.value?.textarea;
  if (textarea) descriptionCursor.value = { start: textarea.selectionStart, end: textarea.selectionEnd };
}
function formatDescription(tag: 'p' | 'strong' | 'em' | 'ul') {
  if (!canManageProducts.value || !mediaSession.isCurrent() || saving.value || loading.value) return;
  const next = formatProductDescription(form.description, descriptionCursor.value, tag);
  if (next.length <= 200000) { form.description = next; showDescriptionPreview.value = true; }
}
const descriptionPreview = computed(() => productDescriptionPreview(form.description, mediaPreviews.value));
function previewImage(reference: string) {
  const src = productImagePreview(reference, mediaPreviews.value);
  return src && !failedPreviewSources.value.has(src) ? src : null;
}
function imagePreviewFailed(event: Event) {
  if (mediaInvalidated.value || !mediaSession.isCurrent()) return;
  const src = (event.currentTarget as HTMLImageElement | null)?.getAttribute('src');
  if (src) failedPreviewSources.value = new Set([...failedPreviewSources.value, src]);
}
async function refreshMediaPreview() {
  if (!editing.value || mediaReading.value || !mediaSession.isCurrent()) return;
  const generation = ++mediaReadGeneration, context = mediaContext.value, id = productId.value;
  mediaReading.value = true;
  try {
    const detail = await getProductDetail(id);
    if (generation === mediaReadGeneration && context === mediaContext.value && mediaSession.isCurrent() && detail.media?.version === 1) {
      mediaPreviews.value = { ...mediaPreviews.value, ...detail.media.previews }; failedPreviewSources.value = new Set();
    }
  } catch { if (generation === mediaReadGeneration && mediaSession.isCurrent()) ElMessage.error('未能重读图片预览，当前商品编辑保持不变'); }
  finally { if (generation === mediaReadGeneration) mediaReading.value = false; }
}
watch(productId, () => {
  skuActionGeneration += 1; skuActionLoading.value = false; formSaveGeneration += 1; saving.value = false;
  selectedActiveSkuIds.value = []; selectedRetiredSkuIds.value = []; retiredAttrs.value = []; failedPreviewSources.value = new Set();
  invalidateMediaTarget(); mediaPreviews.value = {}; resetProductForm();
  void load();
});

function cardBackedSku(sku: ProductSku) {
  return isCardProduct.value && sku.delivery_mode !== "fixed";
}

function changeSkuDeliveryMode(sku: ProductSku, mode: "card" | "fixed") {
  sku.delivery_mode = mode;
  if (mode === "card") {
    sku.disk_info = "";
    if (!sku.id || sku.original_disk_info?.trim()) sku.stock = 0;
  }
}

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
  invalidateMediaTarget();
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

watch(
  () => form.product_type,
  (value) => {
    if (editing.value) return;
    if (value === 1) {
      form.freight = 2;
      form.postage = "0.00";
      form.temp_id = 0;
      form.is_postage = 0;
      if (form.unit_name === "件") form.unit_name = "份";
      form.attrs.forEach((sku) => {
        sku.delivery_mode = sku.disk_info?.trim() ? "fixed" : "card";
        if (sku.delivery_mode === "card") sku.stock = 0;
      });
    } else if (value === 3) {
      form.freight = 2;
      form.postage = "0.00";
      form.temp_id = 0;
      form.is_postage = 0;
      if (form.unit_name === "件") form.unit_name = "份";
      form.attrs.forEach((sku) => {
        sku.disk_info = "";
        sku.delivery_mode = undefined;
        sku.original_disk_info = "";
      });
    } else {
      form.freight = 1;
      form.postage = "0.00";
      form.temp_id = 0;
      form.is_postage = 1;
      if (form.unit_name === "份") form.unit_name = "件";
      form.attrs.forEach((sku) => {
        sku.disk_info = "";
        sku.delivery_mode = undefined;
        sku.original_disk_info = "";
      });
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

async function applyProductRule() {
  if (!canManageProducts.value || !mediaSession.isCurrent() || loading.value || saving.value) return;
  const generation = formReadGeneration, id = productId.value;
  const template = ruleTemplates.value.find((item) => item.id === selectedRuleId.value);
  if (!template) return ElMessage.warning("请选择规格模板");
  try {
    await ElMessageBox.confirm(
      `套用“${template.rule_name}”会替换当前规格结构并重新生成 SKU；价格、库存和图片仍需逐项核对。`,
      "套用规格模板",
      { type: "warning", confirmButtonText: "确认套用", cancelButtonText: "取消" },
    );
    if (generation !== formReadGeneration || id !== productId.value || !mediaSession.isCurrent()) return;
    form.spec_type = 1;
    form.items = template.spec.map((dimension) => ({ value: dimension.value, detail: [...dimension.detail] }));
    form.attrs = [];
    regenerateSkus(false);
    ElMessage.success(`已套用“${template.rule_name}”，生成 ${form.attrs.length} 个 SKU`);
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : "规格模板套用失败");
    }
  }
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
    if (isCardProduct.value) {
      if (sku.delivery_mode === "fixed" && !sku.disk_info?.trim()) return `SKU ${sku.suk} 请填写固定交付内容`;
      if (cardBackedSku(sku) && (!sku.id || sku.original_disk_info?.trim()) && sku.stock !== 0) {
        return `SKU ${sku.suk} 切换或新建为卡密库存时，初始库存必须为0`;
      }
    }
  }
  if (isPhysicalProduct.value && form.freight === 2 && (!/^\d{1,10}(?:\.\d{1,2})?$/.test(form.postage) || Number(form.postage) <= 0)) return "固定邮费必须大于0且最多两位小数";
  if (isPhysicalProduct.value && form.freight === 3 && !form.temp_id) return "请选择当前供应商的运费模板";
  return "";
}

async function submit() {
  if (saving.value || loading.value || mediaInvalidated.value || !mediaSession.isCurrent() || !canManageProducts.value) return;
  const validation = validateForm();
  if (validation) return ElMessage.warning(validation);
  saving.value = true;
  invalidateMediaTarget();
  const generation = ++formSaveGeneration, id = editing.value ? productId.value : 0;
  try {
    form.slider_image = form.slider_image.map((item) => item.trim()).filter(Boolean);
    const attrs = form.attrs.map(({ delivery_mode, original_disk_info, ...sku }) => ({
      ...sku,
      disk_info: form.product_type === 1 && delivery_mode === "fixed" ? sku.disk_info?.trim() ?? "" : "",
    }));
    const { media: _preview, ...editableForm } = form;
    const result = await saveProduct(id, { ...editableForm, attrs });
    if (generation !== formSaveGeneration || !mediaSession.isCurrent() || productId.value !== id && id !== 0) return;
    ElMessage.success(`商品 #${result.id} 已保存并进入待审核状态`);
    await router.push(form.product_type === 1 ? `/products/${result.id}/virtual-inventory` : "/products");
  } catch (error) {
    if (generation === formSaveGeneration && mediaSession.isCurrent()) ElMessage.error(error instanceof Error ? error.message : "商品保存失败");
  } finally {
    if (generation === formSaveGeneration) saving.value = false;
  }
}

async function load() {
  if (!mediaSession.isCurrent()) return;
  const generation = ++formReadGeneration, id = productId.value;
  loading.value = true;
  try {
    const [categoryRows, productRuleRows] = await Promise.all([
      getProductCategories(),
      getProductRuleTemplates(),
    ]);
    if (generation !== formReadGeneration || !mediaSession.isCurrent() || id !== productId.value) return;
    categories.value = categoryRows;
    ruleTemplates.value = productRuleRows;
    if (Number.isSafeInteger(id) && id > 0) {
      const detail = await getProductDetail(id);
      if (generation !== formReadGeneration || !mediaSession.isCurrent() || id !== productId.value) return;
      applyProductDetail(detail);
    }
  } catch (error) {
    if (generation === formReadGeneration && mediaSession.isCurrent()) ElMessage.error(error instanceof Error ? error.message : "商品资料加载失败");
  } finally {
    if (generation === formReadGeneration) loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading" class="page-section product-form-page">
    <el-alert v-if="mediaInvalidated" title="登录身份或权限已改变，请重新进入商品页" type="warning" :closable="false" />
    <header class="page-heading product-form-heading">
      <div class="heading-with-back">
        <el-button circle plain :icon="ArrowLeft" aria-label="返回商品列表" @click="router.push('/products')" />
        <div><h1>{{ editing ? `编辑${isCardProduct ? "卡密/固定内容" : isManualVirtualProduct ? "手工虚拟" : "实物"}商品` : "新增商品" }}</h1><p>保存后商品将下架并进入平台待审核状态</p></div>
      </div>
      <el-button type="primary" :loading="saving" @click="submit">保存并提交审核</el-button>
    </header>

    <el-alert
      :title="isCardProduct ? '卡密库存与固定内容已分离管理' : isManualVirtualProduct ? '手工虚拟商品由履约人员填写交付内容' : '支持实物、卡密与手工虚拟商品'"
      type="info"
      show-icon
      :closable="false"
      :description="isCardProduct ? '一次性卡密请先以0库存保存，再到卡密库存页导入；固定内容随订单快照交付。' : isManualVirtualProduct ? '支付后只能整单虚拟交付；交付内容会安全显示在客户订单详情。' : '优惠券和次卡仍未开放创建。'"
    />

    <div class="product-form-layout">
      <main class="product-form-main">
        <article class="surface product-form-card">
          <header><h2>基础信息</h2><p>名称、分类和展示素材</p></header>
          <el-form label-position="top">
            <div class="form-grid">
              <el-form-item class="wide" label="商品类型" required>
                <el-radio-group v-model="form.product_type" :disabled="editing">
                  <el-radio-button :value="0">实物商品</el-radio-button>
                  <el-radio-button :value="1">卡密 / 固定内容</el-radio-button>
                  <el-radio-button :value="3">手工虚拟</el-radio-button>
                </el-radio-group>
                <p v-if="editing" class="security-note">商品创建后不能修改履约类型。</p>
              </el-form-item>
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
          <header class="card-heading-row"><div><h2>轮播图片</h2><p>第一张作为商品主图；最多20张，可从素材选择或填写 HTTPS 地址</p></div><div class="media-actions"><el-button v-if="canChooseMedia" :disabled="loading || saving" @click="openMedia('slider')">从素材选择</el-button><el-button :icon="Plus" @click="addSlider">添加图片地址</el-button><el-button v-if="editing" :loading="mediaReading" @click="refreshMediaPreview">重读已保存图片预览</el-button></div></header>
          <div class="slider-editor">
            <div v-for="(image, index) in form.slider_image" :key="index" class="slider-row">
              <div class="slider-preview"><img v-if="previewImage(image)" :src="previewImage(image)!" alt="商品预览" referrerpolicy="no-referrer" @error="imagePreviewFailed" /><span v-else>{{ image ? '预览不可用' : index + 1 }}</span></div>
              <el-input v-model="form.slider_image[index]" placeholder="https://..." />
              <el-button text :disabled="index === 0 || saving" :aria-label="`前移图片 ${index + 1}`" @click="moveSlider(index, -1)">↑</el-button>
              <el-button text :disabled="index === form.slider_image.length - 1 || saving" :aria-label="`后移图片 ${index + 1}`" @click="moveSlider(index, 1)">↓</el-button>
              <el-button text type="danger" :icon="Delete" aria-label="删除图片" @click="removeSlider(index)" />
            </div>
          </div>
        </article>

        <article class="surface product-form-card">
          <header class="card-heading-row">
            <div><h2>规格与 SKU</h2><p>{{ isCardProduct ? "每个SKU独立选择一次性卡密或固定内容；卡密库存只能从库存页导入" : "价格、结算价和库存均以 SKU 为准" }}；历史SKU只能通过受控操作退役或恢复</p></div>
            <el-button v-if="canChooseMedia && editing" :disabled="!selectedActiveSkuIds.length || loading || saving" @click="openMedia('sku-batch')">给选中SKU设置图片</el-button>
            <el-button
              v-if="editing && canManageProducts"
              type="danger"
              plain
              :loading="skuActionLoading"
              :disabled="!selectedActiveSkuIds.length"
              @click="changeSkuLifecycle('retire')"
            >退役选中历史SKU</el-button>
          </header>
          <el-alert
            v-if="editing"
            title="删除或改名已有SKU会被拒绝"
            type="warning"
            show-icon
            :closable="false"
            description="请先勾选完整规格组合执行退役；购物车、未支付订单、活动、赠品、抽奖或门店仍引用时系统会阻止操作。"
          />
          <el-radio-group v-model="form.spec_type" class="spec-type-group"><el-radio-button :value="0">单规格</el-radio-button><el-radio-button :value="1">多规格</el-radio-button></el-radio-group>
          <div v-if="form.spec_type === 1" class="dimension-editor">
            <div class="rule-template-bar">
              <el-select v-model="selectedRuleId" clearable filterable placeholder="选择当前供应商的规格模板">
                <el-option v-for="template in ruleTemplates" :key="template.id" :label="template.rule_name" :value="template.id" />
              </el-select>
              <el-button type="primary" plain :disabled="!selectedRuleId" @click="applyProductRule">套用模板</el-button>
              <el-button link type="primary" @click="router.push('/product-specifications')">管理模板</el-button>
            </div>
            <div v-for="(dimension, index) in form.items" :key="index" class="dimension-row">
              <el-input v-model="dimension.value" class="dimension-name" maxlength="32" placeholder="规格名称，如颜色" />
              <el-select v-model="dimension.detail" multiple filterable allow-create default-first-option placeholder="输入规格值后回车" class="dimension-values" />
              <el-button text type="danger" :icon="Delete" aria-label="删除规格" @click="removeDimension(index)" />
            </div>
            <div class="dimension-actions"><el-button :icon="Plus" :disabled="form.items.length >= 3" @click="addDimension">添加规格维度</el-button><el-button type="primary" plain @click="regenerateSkus()">生成 / 刷新 SKU</el-button></div>
          </div>
          <div class="sku-table-wrap">
            <el-table :data="form.attrs" row-key="suk" empty-text="请先生成SKU" class="sku-table" @selection-change="selectActiveSkus">
              <el-table-column v-if="editing" type="selection" width="48" :selectable="selectableHistoricalSku" />
              <el-table-column prop="suk" label="规格组合" fixed min-width="145" />
              <el-table-column label="SKU图片" width="175"><template #default="scope"><div class="sku-image"><img v-if="previewImage(scope.row.image)" :src="previewImage(scope.row.image)!" alt="SKU预览" referrerpolicy="no-referrer" @error="imagePreviewFailed" /><span v-else>{{ scope.row.image ? '预览不可用' : '暂无预览' }}</span></div><el-button v-if="canChooseMedia" :disabled="loading || saving" @click="openMedia('sku', scope.row)">选择图片</el-button><el-button v-if="scope.row.image" text :disabled="saving" @click="scope.row.image = ''">清除</el-button></template></el-table-column>
              <el-table-column v-if="isCardProduct" label="交付方式" width="170">
                <template #default="scope">
                  <el-select :model-value="scope.row.delivery_mode" @change="changeSkuDeliveryMode(scope.row, $event)">
                    <el-option label="一次性卡密" value="card" />
                    <el-option label="固定内容" value="fixed" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column v-if="isCardProduct" label="固定交付内容" min-width="290">
                <template #default="scope">
                  <el-input
                    v-if="scope.row.delivery_mode === 'fixed'"
                    v-model="scope.row.disk_info"
                    type="textarea"
                    :rows="2"
                    maxlength="4096"
                    placeholder="下载地址、兑换说明或其他固定交付内容"
                  />
                  <span v-else class="security-note">保存后前往卡密库存安全导入</span>
                </template>
              </el-table-column>
              <el-table-column label="销售价" width="130"><template #default="scope"><el-input v-model="scope.row.price" /></template></el-table-column>
              <el-table-column label="结算价" width="130"><template #default="scope"><el-input v-model="scope.row.settle_price" /></template></el-table-column>
              <el-table-column label="成本价" width="130"><template #default="scope"><el-input v-model="scope.row.cost" /></template></el-table-column>
              <el-table-column label="原价" width="130"><template #default="scope"><el-input v-model="scope.row.ot_price" /></template></el-table-column>
              <el-table-column label="库存" width="145"><template #default="scope"><el-input-number :key="`${scope.row.suk}-${scope.row.delivery_mode ?? 'physical'}`" v-model="scope.row.stock" :disabled="isCardProduct && scope.row.delivery_mode !== 'fixed'" :min="0" :max="2147483647" controls-position="right" /></template></el-table-column>
              <el-table-column label="一级佣金" width="130"><template #default="scope"><el-input v-model="scope.row.brokerage" /></template></el-table-column>
              <el-table-column label="二级佣金" width="130"><template #default="scope"><el-input v-model="scope.row.brokerage_two" /></template></el-table-column>
              <el-table-column label="SKU编码" width="160"><template #default="scope"><el-input v-model="scope.row.code" maxlength="50" /></template></el-table-column>
              <el-table-column v-if="isPhysicalProduct" label="重量" width="120"><template #default="scope"><el-input v-model="scope.row.weight" /></template></el-table-column>
              <el-table-column v-if="isPhysicalProduct" label="体积" width="120"><template #default="scope"><el-input v-model="scope.row.volume" /></template></el-table-column>
            </el-table>
          </div>
          <section v-if="editing && retiredAttrs.length" class="retired-sku-section">
            <header class="card-heading-row">
              <div><h3>已退役 SKU</h3><p>保留原始身份和历史引用，不参与新交易与普通商品保存。</p></div>
              <el-button
                v-if="canManageProducts"
                type="primary"
                plain
                :loading="skuActionLoading"
                :disabled="!selectedRetiredSkuIds.length"
                @click="changeSkuLifecycle('restore')"
              >恢复选中SKU</el-button>
            </header>
            <div class="sku-table-wrap">
              <el-table :data="retiredAttrs" row-key="id" class="sku-table" @selection-change="selectRetiredSkus">
                <el-table-column type="selection" width="48" :selectable="selectableHistoricalSku" />
                <el-table-column prop="suk" label="规格组合" min-width="145" />
                <el-table-column prop="unique" label="稳定标识" min-width="130" />
                <el-table-column prop="price" label="销售价" width="110" />
                <el-table-column prop="stock" label="库存" width="90" />
                <el-table-column prop="sales" label="销量" width="90" />
              </el-table>
            </div>
          </section>
        </article>

        <article class="surface product-form-card">
          <header><h2>商品详情</h2><p>可填写文字或 HTML；预览只显示允许的格式和图片</p></header>
          <div class="media-actions"><el-button @click="formatDescription('p')">段落</el-button><el-button @click="formatDescription('strong')">加粗</el-button><el-button @click="formatDescription('em')">强调</el-button><el-button @click="formatDescription('ul')">列表</el-button><el-button v-if="canChooseMedia" :disabled="loading || saving" @click="openMedia('description')">插入素材图片</el-button><el-button @click="showDescriptionPreview = !showDescriptionPreview">{{ showDescriptionPreview ? '收起预览' : '预览详情' }}</el-button></div>
          <el-input ref="descriptionInput" v-model="form.description" type="textarea" :rows="10" maxlength="200000" show-word-limit placeholder="填写商品详细说明" @click="captureDescriptionCursor" @keyup="captureDescriptionCursor" @input="captureDescriptionCursor" />
          <div v-if="showDescriptionPreview && !mediaInvalidated" class="description-preview" aria-label="安全商品详情预览" v-html="descriptionPreview" />
        </article>
      </main>

      <aside class="product-form-aside">
        <article class="surface product-form-card compact-card">
          <header><h2>配送与售后</h2></header>
          <el-form label-position="top">
            <template v-if="isPhysicalProduct">
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
                <ShippingTemplatePicker v-model="form.temp_id" :disabled="loading || saving" />
                <el-button v-if="auth.can('supplier.shipping.view')" link type="primary" @click="router.push('/shipping-templates')">管理运费模板</el-button>
              </el-form-item>
            </template>
            <el-alert v-else :title="isCardProduct ? '自动交付，无需物流和运费' : '人工虚拟交付，无需物流和运费'" type="success" show-icon :closable="false" />
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

    <footer class="product-form-footer"><span>{{ isCardProduct ? "保存后将进入卡密库存页；一次性卡密不会通过此表单传输。" : "保存会重置为待审核并下架，避免未审核改动直接对外销售。" }}</span><div><el-button @click="router.push('/products')">取消</el-button><el-button type="primary" :loading="saving" @click="submit">保存并提交审核</el-button></div></footer>
    <ProductImagePicker v-if="mediaPickerOpen && canChooseMedia" :key="mediaContext" v-model="mediaPickerOpen" :supplier-id="auth.user!.supplier_id" :context-key="mediaContext" :limit="mediaLimit" @selected="receiveMedia" />
  </section>
</template>

<style scoped>
.card-heading-row { flex-wrap: wrap; }
.card-heading-row > .el-button, .media-actions > .el-button { margin-left: 0; }
.media-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.slider-row { flex-wrap: wrap; }
.slider-row .el-input { flex: 1; min-width: 160px; }
.sku-image { height: 64px; display: flex; align-items: center; justify-content: center; background: var(--el-fill-color-light); margin-bottom: 4px; }
.sku-image img { height: 100%; max-width: 100%; object-fit: contain; }
.description-preview { margin-top: 12px; padding: 12px; border: 1px solid var(--el-border-color); overflow-wrap: anywhere; }
.description-preview :deep(img) { max-width: 100%; height: auto; }
.description-preview :deep(table) { max-width: 100%; }
</style>
