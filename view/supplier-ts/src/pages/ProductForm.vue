<script setup lang="ts">
import { prepareSupplierProductRuleApplication } from '@/utils/productRules';
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
import ProductVideoUploader from '@/components/ProductVideoUploader.vue';
import { videoPreviewSource } from '@/api/productVideoUpload';
import SupplierProductLabelPicker from '@/components/SupplierProductLabelPicker.vue';
import SupplierProductBrandPicker from '@/components/SupplierProductBrandPicker.vue';
import type { SupplierProductBrandSelection } from '@/types/productBrands';
import { productBrandDetail, productBrandPath, productBrandPayload } from '@/utils/productBrands';
import type { SupplierAttachment } from '@/api/attachments';
import { escapeProductText, formatProductDescription, productDescriptionPreview, productImagePreview, type ProductMediaPreview } from '@/utils/productMedia';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { productScheduleEditor, productSchedulePayload } from '@/utils/productSchedule';
import { useAuthStore } from "@/stores/auth";
import { getProductCopySeed, parsePendingProductCopy, productCopyPayload, recoverProductCopy, saveProductCopy,
  type PendingProductCopy, type ProductCopyContext, type ProductCopyReceipt } from '@/api/productCopy';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const copyActor = computed(() => auth.user ?? (previewMode ? { id: 1, supplier_id: 1 } : null));
const productId = computed(() => Number(route.params.id ?? 0));
const editing = computed(() => Number.isInteger(productId.value) && productId.value > 0);
const formRouteError = computed(() => {
  const id = route.params.id;
  if (['/products/new', '/products/copy-result'].includes(route.path)) return id === undefined ? '' : '商品入口无效，请从商品列表重新进入';
  return typeof id === 'string' && /^[1-9]\d{0,9}$/.test(id) && Number(id) <= 2147483647 && route.path === `/products/${id}/edit`
    ? '' : '商品入口无效，请从商品列表重新进入';
});
const copyEntry = computed(() => {
  if (route.query.copy === undefined) return { source: 0, error: '' };
  const raw = route.query.copy;
  if (editing.value || typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647)
    return { source: 0, error: '复制入口无效，请从商品列表重新进入' };
  return { source: Number(raw), error: '' };
});
const formEntry = computed(() => `${route.path}:${JSON.stringify(route.query.copy)}`);
const copying = computed(() => copyEntry.value.source > 0);
const recoveryOnly = computed(() => route.path === '/products/copy-result');
const copyContext = ref<ProductCopyContext | null>(null), copyReady = ref(false), copyError = ref('');
const pendingCopy = ref<PendingProductCopy | null>(null), copyRecovering = ref(false), copyNotice = ref(''), copyStorageError = ref('');
const copyBlocked = computed(() => !!pendingCopy.value || !!copyStorageError.value || !!copyEntry.value.error || copying.value && !copyReady.value);
const canManageProducts = computed(() => auth.can("supplier.product.manage"));
const videoUploaderOpen = ref(false), videoPreviewUrl = ref(''), videoGeneration = ref(0);
const videoContext = computed(() => `${auth.user?.supplier_id ?? 0}:${formEntry.value}:${videoGeneration.value}`);
const videoDisabled = computed(() => loading.value || saving.value || copyBlocked.value || mediaInvalidated.value || !canManageProducts.value);
const loading = ref(false);
const saving = ref(false);
const schedule = reactive(productScheduleEditor());
const productReadReady = ref(false), productReadError = ref('');
let formReadRequest: AbortController | undefined, formSaveRequest: AbortController | undefined;
function cancelFormRequests() { formReadRequest?.abort(); formSaveRequest?.abort(); }
function scheduleChanged(field: 'on' | 'off' | 'both' = 'both') {
  schedule.changed = true;
  if (field !== 'off') schedule.onChanged = true;
  if (field !== 'on') schedule.offChanged = true;
}
const skuActionLoading = ref(false);
const retiredAttrs = ref<ProductSku[]>([]);
const selectedActiveSkuIds = ref<number[]>([]);
const selectedRetiredSkuIds = ref<number[]>([]);
const categories = ref<ProductCategory[]>([]);
const selectedLabelIds = ref<number[]>([]), labelsChanged = ref(false);
const selectedBrandPath = ref<number[]>([]), brandSelection = ref<SupplierProductBrandSelection | null>(null), brandChanged = ref(false);
const brandAvailability = ref({ ready: false, valid: false });
function changeBrand(value: number[]) {
  if (loading.value || saving.value || !productReadReady.value || mediaInvalidated.value || !mediaSession.isCurrent() || !canManageProducts.value || copying.value) return;
  try { selectedBrandPath.value = productBrandPath(value); brandChanged.value = true; }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '品牌选择无效'); }
}
const labelAvailability = ref({ ids: [] as number[], ready: false });
const ruleTemplates = ref<ProductRuleTemplate[]>([]);
const selectedRuleId = ref<number | null>(null);
const mediaPickerOpen = ref(false), mediaGeneration = ref(0), showDescriptionPreview = ref(false);
const mediaTarget = ref<{ kind: 'slider' | 'sku' | 'sku-batch' | 'description'; sku?: ProductSku; skus?: ProductSku[] } | null>(null);
const mediaPreviews = ref<Record<string, ProductMediaPreview>>({});
const failedPreviewSources = ref(new Set<string>());
const mediaReading = ref(false), mediaInvalidated = ref(false);
const mediaContext = computed(() => `${formEntry.value}:${mediaGeneration.value}`);
const mediaLimit = computed(() => mediaTarget.value?.kind === 'slider' ? 20 - form.slider_image.filter(item => item.trim()).length : mediaTarget.value?.kind === 'description' ? 20 : 1);
const canChooseMedia = computed(() => canManageProducts.value && !copyBlocked.value && auth.can('supplier.attachment.view') && Number.isSafeInteger(auth.user?.supplier_id) && Number(auth.user?.supplier_id) > 0 && !mediaInvalidated.value);
const descriptionInput = ref<{ textarea?: HTMLTextAreaElement }>();
const descriptionCursor = ref({ start: 0, end: 0 });
let mediaReadGeneration = 0, formReadGeneration = 0, formSaveGeneration = 0, skuActionGeneration = 0;
const mediaSession = createSupplierSessionScope(() => {
  cancelFormRequests();
  mediaInvalidated.value = true; videoUploaderOpen.value = false; videoPreviewUrl.value = ''; mediaPickerOpen.value = false; mediaTarget.value = null;
  mediaPreviews.value = {}; showDescriptionPreview.value = false; mediaReadGeneration += 1;
  failedPreviewSources.value = new Set(); skuActionGeneration += 1; skuActionLoading.value = false; mediaReading.value = false;
  formReadGeneration += 1; formSaveGeneration += 1; resetProductForm(); saving.value = false;
  copyContext.value = null; copyReady.value = false; pendingCopy.value = null; copyRecovering.value = false; copyNotice.value = ''; copyError.value = '';
  categories.value = []; ruleTemplates.value = []; retiredAttrs.value = []; selectedActiveSkuIds.value = []; selectedRetiredSkuIds.value = []; selectedRuleId.value = null; loading.value = false;
}, previewMode);
onBeforeUnmount(() => { cancelFormRequests(); mediaReadGeneration += 1; formReadGeneration += 1; formSaveGeneration += 1; skuActionGeneration += 1; mediaSession.dispose(); });

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
  Object.assign(schedule, productScheduleEditor()); productReadReady.value = false; productReadError.value = '';
  videoUploaderOpen.value = false; videoPreviewUrl.value = ''; videoGeneration.value++;
  selectedLabelIds.value = []; labelsChanged.value = false;
  selectedBrandPath.value = []; brandSelection.value = null; brandChanged.value = false; brandAvailability.value = { ready: false, valid: false };
  labelAvailability.value = { ids: [], ready: false };
  for (const key of Object.keys(form)) Reflect.deleteProperty(form, key);
  Object.assign(form, initialForm());
}
const isCardProduct = computed(() => form.product_type === 1);
const isManualVirtualProduct = computed(() => form.product_type === 3);
const isPhysicalProduct = computed(() => form.product_type === 0);

function editableSku(sku: ProductSku, productType: ProductDetail['product_type']): ProductSku {
  const diskInfo = sku.disk_info ?? "";
  const card = productType === 1;
  return {
    ...sku,
    disk_info: card ? diskInfo : "",
    delivery_mode: card ? (diskInfo.trim() ? "fixed" : "card") : undefined,
    original_disk_info: card ? diskInfo : "",
  };
}

function applyProductDetail(detail: ProductDetail) {
  const brand = productBrandDetail(detail);
  Object.assign(schedule, productScheduleEditor(detail));
  selectedBrandPath.value = brand.path; brandSelection.value = brand.selection; brandChanged.value = false;
  videoUploaderOpen.value = false; videoGeneration.value++;
  invalidateMediaTarget();
  const { video_preview_url: preview, ...editable } = detail as ProductDetail & { video_preview_url?: unknown };
  Object.assign(form, { ...editable, attrs: detail.attrs.map(sku => editableSku(sku, detail.product_type)) });
  videoPreviewUrl.value = videoPreviewSource(form.video_link, preview);
  const labels = Array.isArray(detail.store_label_id) ? detail.store_label_id : String(detail.store_label_id ?? '').split(',').filter(Boolean).map(Number);
  selectedLabelIds.value = [...new Set(labels.filter(id => Number.isSafeInteger(id) && id > 0))]; labelsChanged.value = false;
  retiredAttrs.value = (detail.retired_attrs ?? []).map(sku => editableSku(sku, detail.product_type));
  mediaPreviews.value = detail.media?.version === 1 ? detail.media.previews : {};
  failedPreviewSources.value = new Set();
}

function openVideoUpload() {
  if (videoDisabled.value || !mediaSession.isCurrent() || !auth.can('supplier.attachment.manage')) return;
  videoUploaderOpen.value = true;
}
function useUploadedVideo(value: { url: string; src: string }) {
  if (videoDisabled.value || !videoUploaderOpen.value || !mediaSession.isCurrent() || !/^\/api\/assets\/[1-9]\d{0,9}$/.test(value.url)) return;
  form.video_link = value.url; videoPreviewUrl.value = videoPreviewSource(value.url, value.src); videoUploaderOpen.value = false;
}
function removeVideo() {
  if (videoDisabled.value || !mediaSession.isCurrent()) return;
  form.video_link = ''; videoPreviewUrl.value = '';
}
watch(() => form.video_link, (value, previous) => { if (value !== previous && !videoPreviewSource(value, videoPreviewUrl.value)) videoPreviewUrl.value = ''; });
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
    if (generation === mediaReadGeneration && context === mediaContext.value && mediaSession.isCurrent()) {
      if (detail.video_link === form.video_link) videoPreviewUrl.value = videoPreviewSource(form.video_link, (detail as ProductDetail & { video_preview_url?: unknown }).video_preview_url);
      if (detail.media?.version === 1) { mediaPreviews.value = { ...mediaPreviews.value, ...detail.media.previews }; failedPreviewSources.value = new Set(); }
    }
  } catch { if (generation === mediaReadGeneration && mediaSession.isCurrent()) ElMessage.error('未能重读图片预览，当前商品编辑保持不变'); }
  finally { if (generation === mediaReadGeneration) mediaReading.value = false; }
}
watch(formEntry, () => {
  cancelFormRequests();
  skuActionGeneration += 1; skuActionLoading.value = false; formSaveGeneration += 1; saving.value = false;
  selectedActiveSkuIds.value = []; selectedRetiredSkuIds.value = []; retiredAttrs.value = []; failedPreviewSources.value = new Set();
  invalidateMediaTarget(); mediaPreviews.value = {}; resetProductForm();
  copyContext.value = null; copyReady.value = false; copyRecovering.value = false; copyError.value = ''; copyNotice.value = '';
  void load();
}, { flush: 'sync' });

function cardBackedSku(sku: ProductSku) {
  return isCardProduct.value && sku.delivery_mode !== "fixed";
}

function changeSkuDeliveryMode(sku: ProductSku, mode: "card" | "fixed") {
  if (copying.value) return;
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

function changeSpecType(value: unknown) {
  if (!canManageProducts.value || !mediaSession.isCurrent() || loading.value || saving.value || (value !== 0 && value !== 1)) return;
  form.spec_type = value;
  if (value === 0) regenerateSkus(false);
  else if (form.items.length === 1 && form.items[0].value === '规格' && form.items[0].detail.length === 1 && form.items[0].detail[0] === '默认') {
      invalidateMediaTarget();
      form.items = [{ value: "颜色", detail: [] }];
      form.attrs = [];
  }
}

watch(
  () => form.product_type,
  (value) => {
    if (editing.value || copying.value || recoveryOnly.value) return;
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
    const candidate = prepareSupplierProductRuleApplication(template.spec);
    const attrs = candidate.details.map((detail) => blankSku(detail));
    invalidateMediaTarget();
    form.items = candidate.items;
    form.attrs = attrs;
    form.spec_type = 1;
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
  if (!productReadReady.value) return '请先成功读取完整商品资料';
  if (!copying.value) try { productSchedulePayload(schedule); } catch (error) { return error instanceof Error ? error.message : '上下架计划无效'; }
  if (!copying.value && brandChanged.value && selectedBrandPath.value.length && (!brandAvailability.value.ready || !brandAvailability.value.valid)) return '请刷新品牌并重新选择完整品牌路径，或清空品牌选择';
  if (labelsChanged.value && !labelAvailability.value.ready) return '请刷新商品标签后再保存标签修改';
  if (labelsChanged.value && labelAvailability.value.ids.length) return '请先移除暂不可选的原标签，再保存标签修改';
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
  if (formRouteError.value || recoveryOnly.value || saving.value || loading.value || !productReadReady.value || copyBlocked.value || mediaInvalidated.value || !mediaSession.isCurrent() || !canManageProducts.value) return;
  const validation = validateForm();
  if (validation) return ElMessage.warning(validation);
  saving.value = true;
  invalidateMediaTarget();
  const generation = ++formSaveGeneration, id = editing.value ? productId.value : 0, entry = formEntry.value;
  const current = () => generation === formSaveGeneration && mediaSession.isCurrent() && formEntry.value === entry;
  try {
    form.slider_image = form.slider_image.map((item) => item.trim()).filter(Boolean);
    const attrs = form.attrs.map(({ delivery_mode, original_disk_info, ...sku }) => ({
      ...sku,
      disk_info: form.product_type === 1 && delivery_mode === "fixed" ? sku.disk_info?.trim() ?? "" : "",
    }));
    const { media: _preview, store_label_id: _originalLabels, video_preview_url: _videoPreview, retired_attrs: _retired,
      auto_on_time: _autoOn, auto_off_time: _autoOff, brand_id: _originalBrand, brand_selection: _brandSelection, ...editableForm } = form as ProductDetail & { video_preview_url?: unknown };
    const payload = { ...editableForm, attrs, ...(labelsChanged.value ? { store_label_id: [...selectedLabelIds.value] } : {}),
      ...(!copying.value ? { ...productSchedulePayload(schedule), ...productBrandPayload(selectedBrandPath.value, brandChanged.value) } : {}) };
    if (copying.value) {
      if (!copyContext.value || copyContext.value.source_id !== copyEntry.value.source) throw Error('请重新读取复制来源');
      // Persist only the recovery identity before the first POST. Product text,
      // signed media URLs and delivery content never enter this marker.
      const pending = parsePendingProductCopy({ operation_id: crypto.randomUUID(), actor_id: copyActor.value?.id,
        supplier_id: copyActor.value?.supplier_id, source_id: copyEntry.value.source }, Number(copyActor.value?.id), Number(copyActor.value?.supplier_id));
      sessionStorage.setItem(copyStorageKey(), JSON.stringify(pending)); pendingCopy.value = pending;
      const receipt = await saveProductCopy(pending, copyContext.value, productCopyPayload(payload, labelsChanged.value ? [...selectedLabelIds.value] : undefined));
      if (current()) await acceptCopyReceipt(receipt, pending);
      return;
    }
    formSaveRequest?.abort(); const request = new AbortController(); formSaveRequest = request;
    const result = await saveProduct(id, payload, request.signal);
    if (!current()) return;
    ElMessage.success(`商品 #${result.id} 已保存并进入待审核状态`);
    await router.push(form.product_type === 1 ? `/products/${result.id}/virtual-inventory` : "/products");
  } catch (error) {
    if (current()) {
      if (pendingCopy.value) copyNotice.value = '复制请求结果待确认，请查询或确认原事务结果后继续。';
      ElMessage.error(error instanceof Error ? error.message : "商品保存失败");
    }
  } finally {
    if (generation === formSaveGeneration) saving.value = false;
  }
}

function copyStorageKey() { return `supplier_product_copy_pending_v1:${copyActor.value?.supplier_id}:${copyActor.value?.id}`; }
function readPendingCopy() {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(copyStorageKey());
    pendingCopy.value = raw ? parsePendingProductCopy(JSON.parse(raw), Number(copyActor.value?.id), Number(copyActor.value?.supplier_id)) : null;
    copyStorageError.value = '';
  } catch { copyStorageError.value = '本窗口的未确认复制记录无法读取，请保留窗口并核对原操作。'; }
}
async function acceptCopyReceipt(receipt: ProductCopyReceipt, pending: PendingProductCopy) {
  if (pendingCopy.value?.operation_id !== pending.operation_id || !mediaSession.isCurrent()) return;
  if (receipt.state === 'unknown') { copyNotice.value = '原操作尚无确定回执，请稍后查询，或确认原事务结果。'; return; }
  // Removing the marker is part of recovery. A failed storage write keeps the
  // editor blocked even when the server already confirmed the operation.
  sessionStorage.removeItem(copyStorageKey()); pendingCopy.value = null;
  if (receipt.state === 'not_applied') { copyNotice.value = '原操作已确认未提交，可保留草稿后重新保存。'; return; }
  copyReady.value = false; copyContext.value = null;
  ElMessage.success(`新商品 #${receipt.result!.id} 已复制并进入待审核状态`);
  await router.push('/products');
}
async function recoverCopy(resolve = false) {
  if (!pendingCopy.value || copyRecovering.value || saving.value || !mediaSession.isCurrent()) return;
  const pending = pendingCopy.value, generation = formSaveGeneration, entry = formEntry.value;
  copyRecovering.value = true;
  try {
    const receipt = await recoverProductCopy(pending, resolve);
    if (generation === formSaveGeneration && entry === formEntry.value && mediaSession.isCurrent()) await acceptCopyReceipt(receipt, pending);
  } catch (error) {
    if (generation === formSaveGeneration && mediaSession.isCurrent()) copyNotice.value = error instanceof Error ? error.message : '原复制结果尚未核对成功';
  } finally { if (generation === formSaveGeneration) copyRecovering.value = false; }
}
async function reloadCopy() {
  if (!copying.value || pendingCopy.value || saving.value || loading.value || !canManageProducts.value || !mediaSession.isCurrent()) return;
  const entry = formEntry.value, generation = formReadGeneration;
  try { await ElMessageBox.confirm('重新载入会替换当前复制草稿。请先保留需要的编辑内容。', '重新载入复制来源', { type: 'warning' }); }
  catch { return; }
  if (entry !== formEntry.value || generation !== formReadGeneration || pendingCopy.value || !mediaSession.isCurrent()) return;
  resetProductForm(); copyNotice.value = ''; await load();
}

async function load() {
  if (!mediaSession.isCurrent()) return;
  const generation = ++formReadGeneration, id = productId.value, entry = formEntry.value;
  formReadRequest?.abort(); const request = new AbortController(); formReadRequest = request;
  productReadReady.value = false; productReadError.value = '';
  if (formRouteError.value) { productReadError.value = formRouteError.value; loading.value = false; return; }
  readPendingCopy(); copyReady.value = false; copyContext.value = null; copyError.value = copyEntry.value.error;
  if (recoveryOnly.value) { loading.value = false; return; }
  if (copyError.value || copying.value && !canManageProducts.value) {
    copyError.value ||= '当前账号没有复制商品权限'; loading.value = false; return;
  }
  const current = () => generation === formReadGeneration && mediaSession.isCurrent() && entry === formEntry.value;
  loading.value = true;
  try {
    const [categoryRows, productRuleRows] = await Promise.all([
      getProductCategories(),
      getProductRuleTemplates(),
    ]);
    if (!current()) return;
    categories.value = categoryRows;
    ruleTemplates.value = productRuleRows;
    if (copying.value) {
      const seed = await getProductCopySeed(copyEntry.value.source, Number(copyActor.value?.supplier_id));
      if (!current()) return;
      applyProductDetail(seed.product); copyContext.value = seed.copy; copyReady.value = true;
    } else if (Number.isSafeInteger(id) && id > 0) {
      const detail = await getProductDetail(id, request.signal);
      if (!current()) return;
      applyProductDetail(detail);
    }
    if (current()) productReadReady.value = true;
  } catch (error) {
    if (current()) {
      if (copying.value) copyError.value = error instanceof Error ? error.message : '复制来源读取失败，保存已禁用';
      productReadError.value = error instanceof Error ? error.message : '商品资料读取失败，保存已暂停';
      ElMessage.error(error instanceof Error ? error.message : "商品资料加载失败");
    }
  } finally {
    if (generation === formReadGeneration) loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-loading="loading" class="page-section product-form-page">
    <el-alert v-if="mediaInvalidated" title="登录身份或权限已改变，请重新进入商品页" type="warning" :closable="false" />
    <el-alert v-if="copyError || copyStorageError" :title="copyError || copyStorageError" type="error" :closable="false" />
    <div v-if="productReadError && !mediaInvalidated" role="alert"><p>{{ productReadError }}</p><el-button :disabled="loading || saving" @click="load">重新读取商品资料</el-button></div>
    <div v-if="pendingCopy" class="surface product-form-card" role="status">
      <h2>复制结果待确认</h2><p>来源商品 #{{ pendingCopy.source_id }} · 操作 {{ pendingCopy.operation_id }}。请先核对原请求，当前窗口已暂停保存。</p>
      <el-button :disabled="saving || copyRecovering" :loading="copyRecovering" @click="recoverCopy(false)">查询复制结果</el-button>
      <el-button :disabled="saving || copyRecovering" @click="recoverCopy(true)">确认原事务结果</el-button>
    </div>
    <el-alert v-if="copyNotice" :title="copyNotice" type="info" :closable="false" />
    <template v-if="recoveryOnly">
      <header class="page-heading"><div><h1>复制操作结果</h1><p>核对当前账号在本窗口提交的原复制请求</p></div><el-button @click="router.push('/products')">返回商品列表</el-button></header>
      <el-alert v-if="!pendingCopy && !copyStorageError && !copyNotice" title="本窗口没有待确认的复制操作" type="info" :closable="false" />
    </template>
    <template v-else>
    <header class="page-heading product-form-heading">
      <div class="heading-with-back">
        <el-button circle plain :icon="ArrowLeft" aria-label="返回商品列表" @click="router.push('/products')" />
        <div><h1>{{ copying ? `复制商品 #${copyEntry.source}` : editing ? `编辑${isCardProduct ? "卡密/固定内容" : isManualVirtualProduct ? "手工虚拟" : "实物"}商品` : "新增商品" }}</h1><p>保存后商品将下架并进入平台待审核状态</p></div>
      </div>
      <div class="heading-actions">
        <el-button v-if="copying && canManageProducts" :disabled="!!pendingCopy || saving || loading || mediaInvalidated" @click="reloadCopy">重新载入来源</el-button>
        <el-button v-if="canManageProducts" type="primary" :disabled="copyBlocked || loading || !productReadReady || mediaInvalidated" :loading="saving" @click="submit">保存并提交审核</el-button>
      </div>
    </header>

    <el-alert v-if="copying" title="新建独立商品，保留来源配置" type="info" show-icon :closable="false"
      description="品牌、赠券、保障、参数和其他未展示配置将随来源完整保留；来源变化时会要求重新载入。卡密与固定交付内容请在新商品中重新配置。" />

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
                <el-radio-group v-model="form.product_type" :disabled="editing || copying">
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
              <el-form-item v-if="!copying" label="商品品牌"><SupplierProductBrandPicker :model-value="selectedBrandPath" :selection="brandSelection" :changed="brandChanged" :context="formEntry" :disabled="loading || saving || !productReadReady || mediaInvalidated" @update:model-value="changeBrand" @availability="brandAvailability = $event" /></el-form-item>
              <p v-else class="brand-copy-note">复制保留来源的品牌，创建后可在编辑页调整。</p>
              <el-form-item class="wide" label="商品标签"><SupplierProductLabelPicker :model-value="selectedLabelIds" :context="copyEntry.source || productId" :disabled="loading || saving || copyBlocked || !canManageProducts" @update:model-value="selectedLabelIds = $event; labelsChanged = true" @availability="labelAvailability = $event" /></el-form-item>
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
          <header class="card-heading-row"><div><h2>商品视频</h2><p>支持100 MiB以内的MP4；上传完成后明确选择使用，再保存商品。</p></div><el-button v-if="auth.can('supplier.attachment.manage')" :disabled="videoDisabled" @click="openVideoUpload">上传商品视频</el-button></header>
          <p v-if="form.video_link" class="video-reference">{{ form.video_link }}</p><p v-else>尚未设置商品视频</p>
          <video v-if="videoPreviewUrl && !mediaInvalidated" :src="videoPreviewUrl" controls preload="metadata" aria-label="商品视频预览" />
          <p v-else-if="form.video_link">视频引用已保留；可重读已保存预览。</p>
          <div class="media-actions"><el-button v-if="editing && form.video_link" :disabled="videoDisabled" :loading="mediaReading" @click="refreshMediaPreview">重读已保存视频预览</el-button><el-button v-if="form.video_link" :disabled="videoDisabled" @click="removeVideo">移除商品视频</el-button></div>
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
          <el-radio-group :model-value="form.spec_type" :disabled="loading || saving || !canManageProducts" class="spec-type-group" @change="changeSpecType"><el-radio-button :value="0">单规格</el-radio-button><el-radio-button :value="1">多规格</el-radio-button></el-radio-group>
          <div v-if="form.spec_type === 1" class="dimension-editor">
            <div class="rule-template-bar">
              <el-select v-model="selectedRuleId" clearable filterable placeholder="选择当前供应商的规格模板">
                <el-option v-for="template in ruleTemplates" :key="template.id" :label="template.rule_name" :value="template.id" />
              </el-select>
              <el-button type="primary" plain :disabled="!selectedRuleId" @click="applyProductRule">套用模板</el-button>
              <el-button link type="primary" @click="router.push('/product-specifications')">管理模板</el-button>
            </div>
            <div v-for="(dimension, index) in form.items" :key="index" class="dimension-row">
              <el-input v-model="dimension.value" class="dimension-name" placeholder="规格名称，如颜色" />
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
                  <el-select :model-value="scope.row.delivery_mode" :disabled="copying" @change="changeSkuDeliveryMode(scope.row, $event)">
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
        <article v-if="!copying" class="surface product-form-card compact-card schedule-card">
          <header><h2>定时上下架</h2></header>
          <p>按北京时间填写，保存后仍下架并重新待审核；计划不会自动通过审核。</p>
          <el-checkbox v-model="schedule.onEnabled" :disabled="loading || saving || !productReadReady" @change="scheduleChanged('on')">启用定时上架</el-checkbox>
          <label v-if="schedule.onEnabled" class="schedule-time">定时上架时间（北京时间）<input v-model="schedule.onTime" aria-label="定时上架时间（北京时间）" type="datetime-local" step="1" :disabled="loading || saving || !productReadReady" @input="scheduleChanged('on')" /></label>
          <el-checkbox v-model="schedule.offEnabled" :disabled="loading || saving || !productReadReady" @change="scheduleChanged('off')">启用定时下架</el-checkbox>
          <label v-if="schedule.offEnabled" class="schedule-time">定时下架时间（北京时间）<input v-model="schedule.offTime" aria-label="定时下架时间（北京时间）" type="datetime-local" step="1" :disabled="loading || saving || !productReadReady" @input="scheduleChanged('off')" /></label>
          <p>关闭并保存可取消对应计划。已到期时间交由定时任务处理；实际购买仍需审核通过。</p>
        </article>
        <p v-else class="schedule-copy-note">复制保留来源的上下架计划，创建后可在编辑页调整。</p>
        <article v-if="editing" class="surface review-card">
          <span>当前审核状态</span>
          <strong :class="form.is_verify === 1 ? 'success' : form.is_verify && form.is_verify < 0 ? 'danger' : 'warning'">{{ form.is_verify === 1 ? "已通过" : form.is_verify === -1 ? "已拒绝" : form.is_verify === -2 ? "强制下架" : "审核中" }}</strong>
          <p v-if="form.refusal">{{ form.refusal }}</p>
        </article>
      </aside>
    </div>

    <footer class="product-form-footer"><span>{{ copying ? "复制会创建新商品，来源商品保持原状；交付内容保存后另行配置。" : isCardProduct ? "保存后将进入卡密库存页；一次性卡密不会通过此表单传输。" : "保存会重置为待审核并下架，避免未审核改动直接对外销售。" }}</span><div><el-button @click="router.push('/products')">取消</el-button><el-button v-if="canManageProducts" type="primary" :disabled="copyBlocked || loading || !productReadReady || mediaInvalidated" :loading="saving" @click="submit">保存并提交审核</el-button></div></footer>
    <ProductVideoUploader v-if="auth.user?.supplier_id" v-model:open="videoUploaderOpen" :supplier-id="auth.user.supplier_id" :context-key="videoContext" :disabled="videoDisabled" @use="useUploadedVideo" />
    <ProductImagePicker v-if="mediaPickerOpen && canChooseMedia" :key="mediaContext" v-model="mediaPickerOpen" :supplier-id="auth.user!.supplier_id" :context-key="mediaContext" :limit="mediaLimit" @selected="receiveMedia" />
    </template>
  </section>
</template>

<style scoped>
.brand-copy-note { color: var(--muted); font-size: 12px; line-height: 1.6; }
.schedule-card p, .schedule-copy-note { color: var(--muted); font-size: 12px; line-height: 1.6; }
.schedule-card > .el-checkbox { display: flex; margin: 10px 0; }
.schedule-time { display: grid; gap: 6px; margin: 8px 0 16px; font-size: 12px; }
.schedule-time input { width: 100%; min-width: 0; box-sizing: border-box; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 4px; color: inherit; background: var(--el-bg-color); font: inherit; }
.card-heading-row { flex-wrap: wrap; }
.video-reference { overflow-wrap: anywhere; }
.product-form-card video { display: block; width: 100%; max-height: 360px; background: #111; }
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
