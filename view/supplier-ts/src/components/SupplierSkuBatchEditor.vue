<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import ProductImagePicker from './ProductImagePicker.vue';
import { previewMode } from '@/api/supplier';
import type { SupplierAttachment } from '@/api/attachments';
import type { ProductDimension, ProductSku } from '@/types';
import type { SupplierSkuBatchFilters, SupplierSkuBatchIntent } from '@/types/skuBatch';
import { emptySupplierSkuBatchDraft, prepareSupplierSkuBatch, supplierSkuBatchGraph, supplierSkuBatchTargets } from '@/utils/skuBatch';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { productImagePreview, type ProductMediaPreview } from '@/utils/productMedia';
import { classifyProductMediaReference } from '../../../common/productMediaReference';
import { useAuthStore } from '@/stores/auth';
const props = defineProps<{ items: ProductDimension[]; skus: ProductSku[]; context: string; disabled?: boolean; allowMedia?: boolean }>();
const emit = defineEmits<{ apply: [intent: SupplierSkuBatchIntent, previews: Record<string, ProductMediaPreview>] }>();
const auth = useAuthStore(), draft = reactive(emptySupplierSkuBatchDraft()), filters = ref<SupplierSkuBatchFilters>({}), invalid = ref(false);
const pickerOpen = ref(false), pickerGeneration = ref(0), failedImage = ref(false), previews = ref<Record<string, ProductMediaPreview>>({});
const graph = computed(() => {
  try { return { ...supplierSkuBatchGraph(props.items, props.skus), error: '' }; }
  catch (cause) { return { items: [] as ProductDimension[], signature: '', error: cause instanceof Error ? cause.message : '请重新生成完整SKU' }; }
});
function cancelPicker() { pickerOpen.value = false; pickerGeneration.value++; }
function reset() { cancelPicker(); Object.assign(draft, emptySupplierSkuBatchDraft()); filters.value = {}; previews.value = {}; failedImage.value = false; }
function invalidate() { invalid.value = true; reset(); }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && !graph.value.error && (previewMode || auth.can('supplier.product.manage')));
const canPick = computed(() => canEdit.value && props.allowMedia && auth.can('supplier.attachment.view') && Number.isSafeInteger(auth.user?.supplier_id) && Number(auth.user?.supplier_id) > 0);
const pickerContext = computed(() => `${props.context}:sku-fill:${pickerGeneration.value}`);
const matching = computed(() => { try { return supplierSkuBatchTargets(props.items, props.skus, filters.value).indices.length; } catch { return 0; } });
const preview = computed(() => failedImage.value ? null : productImagePreview(draft.image, previews.value));
function changeFilter(name: string, value: unknown) {
  if (!canEdit.value || !Array.isArray(value) || value.some(item => typeof item !== 'string')) return;
  const next = { ...filters.value, [name]: [...value] };
  try { supplierSkuBatchTargets(props.items, props.skus, next); cancelPicker(); filters.value = next; }
  catch (cause) { ElMessage.warning(cause instanceof Error ? cause.message : '规格选择无效'); }
}
function clear() { if (canEdit.value) reset(); }
function openPicker() { if (canPick.value) { cancelPicker(); pickerOpen.value = true; } }
function receiveImage(images: SupplierAttachment[], context: string) {
  if (!pickerOpen.value || !canPick.value || context !== pickerContext.value || images.length !== 1) return;
  const image = images[0]!, parsed = classifyProductMediaReference(image.canonicalUrl);
  if (parsed.kind === 'invalid' || parsed.reference.length > 128 || parsed.kind === 'asset' && parsed.id !== image.id) return;
  const expires = image.previewUrl.startsWith('/api/assets/') ? Number(new URL(image.previewUrl, 'https://supplier.invalid').searchParams.get('expires')) : null;
  previews.value = { [parsed.reference]: { status: 'ready', src: image.previewUrl, expires_at: expires } };
  draft.image = parsed.reference; cancelPicker();
}
function apply() {
  if (!canEdit.value) return;
  const intent: SupplierSkuBatchIntent = { context: props.context, signature: graph.value.signature, filters: Object.fromEntries(Object.entries(filters.value).map(([name, values]) => [name, [...values]])), draft: { ...draft } };
  try { prepareSupplierSkuBatch(props.items, props.skus, intent); cancelPicker(); emit('apply', intent, { ...previews.value }); }
  catch (cause) { ElMessage.warning(cause instanceof Error ? cause.message : '批量填充失败'); }
}
watch(() => graph.value.signature, reset, { flush: 'sync' });
watch(() => props.skus, reset, { flush: 'sync' });
watch(() => props.context, reset, { flush: 'sync' });
watch(() => draft.image, () => { failedImage.value = false; cancelPicker(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.manage')}:${auth.can('supplier.attachment.view')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onBeforeUnmount(() => { cancelPicker(); session.dispose(); });
</script>
<template>
  <section class="sku-batch-editor" aria-label="多SKU批量填充">
    <h3>批量填充 SKU</h3>
    <p>选择规格后填写要更新的内容，应用后核对商品表格，再保存商品。未选规格代表全部；数值0和空白保留原值。</p>
    <div class="batch-filters">
      <label v-for="item in graph.items" :key="item.value"><span>{{ item.value }}</span><el-select :model-value="filters[item.value] ?? []" :aria-label="`批量规格 ${item.value}`" multiple clearable :disabled="!canEdit" placeholder="全部规格值" @update:model-value="changeFilter(item.value, $event)"><el-option v-for="value in item.detail" :key="value" :value="value" :label="value" /></el-select></label>
    </div>
    <p role="status">匹配 {{ matching }} / {{ skus.length }} 个SKU</p>
    <div class="batch-fields">
      <label><span>结算价</span><el-input v-model="draft.settle_price" aria-label="批量结算价" :disabled="!canEdit" inputmode="decimal" placeholder="留空保留原值" /></label>
      <label><span>库存</span><el-input v-model="draft.stock" aria-label="批量库存" :disabled="!canEdit" inputmode="numeric" placeholder="留空保留原值" /></label>
      <label><span>SKU条码</span><el-input v-model="draft.bar_code" aria-label="批量SKU条码" :disabled="!canEdit" maxlength="50" placeholder="留空保留原值" /></label>
      <label><span>SKU编号</span><el-input v-model="draft.code" aria-label="批量SKU编号" :disabled="!canEdit" maxlength="50" placeholder="留空保留原值" /></label>
      <label><span>重量（KG）</span><el-input v-model="draft.weight" aria-label="批量重量" :disabled="!canEdit" inputmode="decimal" placeholder="留空保留原值" /></label>
      <label><span>体积（m³）</span><el-input v-model="draft.volume" aria-label="批量体积" :disabled="!canEdit" inputmode="decimal" placeholder="留空保留原值" /></label>
    </div>
    <label class="batch-image"><span>图片稳定引用或HTTPS地址</span><el-input v-model="draft.image" aria-label="批量图片引用" :disabled="!canEdit" maxlength="4096" placeholder="留空保留原图片" /></label>
    <div class="batch-actions"><el-button v-if="canPick" :disabled="!canEdit" @click="openPicker">选择批量图片</el-button><img v-if="preview" :src="preview" alt="批量图片预览" referrerpolicy="no-referrer" @error="failedImage = true" /><span v-else-if="draft.image">当前图片无可用预览，保存后可重新读取。</span></div>
    <div class="batch-actions"><el-button type="primary" plain :disabled="!canEdit || !matching" @click="apply">应用到匹配SKU</el-button><el-button :disabled="!canEdit" @click="clear">清空批量填写</el-button></div>
    <p>清空仅重置本区填写和规格选择，商品表格保持原样；售价、成本和佣金也保持不变。</p>
    <p v-if="graph.error" role="alert">{{ graph.error }}</p><p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
    <ProductImagePicker v-if="pickerOpen && canPick" :key="pickerContext" v-model="pickerOpen" :supplier-id="auth.user!.supplier_id" :context-key="pickerContext" :limit="1" @selected="receiveImage" />
  </section>
</template>
<style scoped>
.sku-batch-editor { margin: 16px 0; padding: 16px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
h3 { margin: 0; font-size: 15px; }
p { color: var(--muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.batch-filters, .batch-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 12px; }
label { display: grid; gap: 6px; min-width: 0; font-size: 12px; }
.batch-filters :deep(.el-select) { width: 100%; }
.batch-image { margin-top: 12px; }
.batch-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.batch-actions :deep(.el-button) { margin-left: 0; }
.batch-actions img { width: 56px; height: 56px; object-fit: contain; }
.batch-actions span { color: var(--muted); font-size: 12px; }
</style>
