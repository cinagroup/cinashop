<template>
  <el-dialog :model-value="modelValue" title="添加自评" width="min(860px, 96vw)" :before-close="beforeClose"
    :close-on-click-modal="!busy" :close-on-press-escape="!busy" @update:model-value="onVisibleChange">
    <el-alert title="此操作添加管理员自评，不关联真实顾客或订单。" type="info" :closable="false" />
    <el-alert v-if="formError || error" :title="formError || error" type="error" :closable="false" class="notice" />
    <el-alert v-if="uncertain || blocked" title="添加结果尚未确认，请刷新评价列表核对，确认前不能重复添加。" type="warning" :closable="false" class="notice" />
    <div class="selector">
      <el-form inline @submit.prevent="searchProducts">
        <el-form-item label="选择商品"><el-input v-model="keyword" placeholder="搜索商品名称、关键词或ID" clearable :disabled="!canSelect || busy || uncertain || blocked" /></el-form-item>
        <el-form-item label="新品"><el-select v-model="isNew" aria-label="自评商品新品筛选" :disabled="!canSelect || busy || uncertain || blocked"><el-option label="全部" value="" /><el-option label="仅新品" :value="1" /></el-select></el-form-item>
        <el-form-item><el-button :disabled="!canSelect || busy || uncertain || blocked" @click="searchProducts">查询商品</el-button></el-form-item>
      </el-form>
      <p class="hint">可选择已审核且未删除的商品；平台、门店、供应商商品及下架商品均可选择。</p>
      <el-alert v-if="!canSelect" title="选择商品需要商品查看权限" type="warning" :closable="false" />
      <el-alert v-if="productError" :title="productError" type="error" :closable="false" />
      <div class="product-scroll"><el-table :data="products" v-loading="productLoading" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="商品" min-width="190"><template #default="{ row }"><div class="product-name"><el-image v-if="preview(row.image)" :src="preview(row.image)" fit="cover" class="thumb" /><span>{{ row.store_name }}</span></div></template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }">{{ row.is_show === 0 ? "下架" : "上架" }}</template></el-table-column>
        <el-table-column label="操作" width="110"><template #default="{ row }"><el-button link type="primary" :disabled="busy || productLoading || uncertain || blocked || !row.attrValue.length || selected?.id === row.id && formReady" @click="chooseProduct(row)">{{ !row.attrValue.length ? "暂无有效规格" : selected?.id === row.id ? (formReady ? "已选商品" : "重新读取商品") : "选择商品" }}</el-button></template></el-table-column>
      </el-table></div>
      <el-empty v-if="!productLoading && !products.length && !productError" description="暂无可选商品" />
      <el-pagination class="pager" :current-page="productPage" :page-size="10" :total="productCount" layout="total, prev, pager, next" :disabled="productLoading || busy || uncertain || blocked" @current-change="loadProducts" />
    </div>
    <el-form class="editor" label-width="110px" @submit.prevent="save">
      <el-form-item label="当前商品"><strong>{{ selected ? `${selected.store_name}（#${selected.id}）` : "请从上方选择商品" }}</strong></el-form-item>
      <el-form-item label="商品规格" required><el-select v-model="skuUnique" aria-label="自评商品规格" placeholder="请选择当前商品规格" :disabled="!selected || formLoading || busy || uncertain || blocked" @change="changeSku"><el-option v-for="sku in selected?.attrValue || []" :key="sku.unique" :label="sku.suk || '默认规格'" :value="sku.unique" /></el-select><el-image v-if="selectedSku && preview(selectedSku.image)" :src="preview(selectedSku.image)" class="thumb sku-thumb" fit="cover" /></el-form-item>
      <el-form-item label="用户头像" required><div class="media-editor"><div class="media-input"><el-input v-model="form.avatar" placeholder="头像稳定图片地址" :disabled="editorDisabled" /><CombinationImagePicker title="选择自评头像" :disabled="editorDisabled" :editor-key="mediaKey" :limit="1" @choose="chooseAvatar" /></div><el-image v-if="avatarImage" :src="avatarImage" class="thumb" fit="cover" /></div></el-form-item>
      <el-form-item label="用户名称" required><el-input v-model="form.nickname" placeholder="请输入自评用户名称" :disabled="editorDisabled" /><span class="hint count">{{ [...form.nickname].length }}/64 个字符</span></el-form-item>
      <el-form-item label="评价文字" required><el-input v-model="form.comment" type="textarea" :rows="3" placeholder="请输入自评评价文字" :disabled="editorDisabled" /><span class="hint count">{{ [...form.comment].length }}/512 个字符</span></el-form-item>
      <el-form-item label="商品评价" required><el-select v-model="form.reply_score" aria-label="自评好中差评" :disabled="editorDisabled"><el-option label="好评" value="3" /><el-option label="中评" value="2" /><el-option label="差评" value="1" /></el-select></el-form-item>
      <el-form-item label="商品质量" required><el-rate v-model="form.product_score" :disabled="editorDisabled" :allow-half="false" aria-label="自评商品质量" /></el-form-item>
      <el-form-item label="服务态度" required><el-rate v-model="form.service_score" :disabled="editorDisabled" :allow-half="false" aria-label="自评服务态度" /></el-form-item>
      <el-form-item label="物流服务" required><el-rate v-model="form.delivery_score" :disabled="editorDisabled" :allow-half="false" aria-label="自评物流服务" /></el-form-item>
      <el-form-item label="评价图片"><div class="media-editor"><div v-for="(picture, index) in form.pics" :key="index" class="media-input"><el-image v-if="pictureImage(picture)" :src="pictureImage(picture)" class="thumb" fit="cover" /><el-input v-model="form.pics[index]" :placeholder="`评价图片地址 ${index + 1}`" :disabled="editorDisabled" /><el-button :disabled="editorDisabled" @click="removePicture(index)">移除图片</el-button></div><div class="picture-actions"><CombinationImagePicker title="选择自评评价图片" :disabled="editorDisabled || form.pics.length >= 8" :editor-key="mediaKey" :limit="8 - form.pics.length" @choose="choosePictures" /><el-button :disabled="editorDisabled || form.pics.length >= 8" @click="addPicture">添加图片地址</el-button><span class="hint">{{ form.pics.length }}/8 张</span></div></div></el-form-item>
      <el-form-item label="评价时间（上海）"><el-date-picker v-model="form.add_time" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" placeholder="留空使用添加时的上海时间" :disabled="editorDisabled" /></el-form-item>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="close">取消自评</el-button><el-button v-if="uncertain || blocked" :disabled="busy" @click="verify">刷新评价核对</el-button><el-button type="primary" :loading="busy" :disabled="editorDisabled || !formReady" @click="save">添加自评并保存</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import CombinationImagePicker from '@/pages/activity/CombinationImagePicker.vue';
import { apiAdminProductReplyFictitiousForm, apiAdminProductReplySaveFictitious, apiAdminReplyProductSelector,
  type AdminFictitiousReplyInput, type AdminReplyProduct, type AdminReplyProductQuery } from '@/api/reply';

const props = defineProps<{ modelValue: boolean; canManage: boolean; canSelect: boolean; blocked: boolean; contextKey: string; initialProductId: number }>();
const emit = defineEmits<{ 'update:modelValue': [visible: boolean]; busy: [busy: boolean]; uncertain: []; created: []; verify: [] }>();
const products = ref<AdminReplyProduct[]>([]), productPage = ref(1), productCount = ref(0), productLoading = ref(false), productError = ref('');
const selected = ref<AdminReplyProduct | null>(null), skuUnique = ref(''), keyword = ref(''), isNew = ref<'' | 0 | 1>('');
const formLoading = ref(false), formReady = ref(false), formError = ref(''), error = ref(''), uncertain = ref(false), busy = ref(false), mediaGeneration = ref(0);
const emptyForm = () => ({ avatar: '', nickname: '', comment: '', product_score: 0, service_score: 0, delivery_score: 0, reply_score: '3' as '1' | '2' | '3', pics: [] as string[], add_time: '' });
const form = reactive(emptyForm());
const avatarSelection = ref<{ reference: string; preview: string } | null>(null), picturePreviews = ref<Record<string, string>>({});
const avatarImage = computed(() => avatarSelection.value?.reference === form.avatar ? preview(avatarSelection.value.preview) : preview(form.avatar, 255));
const pictureImage = (reference: string) => preview(picturePreviews.value[reference]) || preview(reference);
const selectedSku = computed(() => selected.value?.attrValue.find(sku => sku.unique === skuUnique.value));
const editorDisabled = computed(() => !props.canManage || !props.canSelect || !selected.value || !selectedSku.value || formLoading.value || busy.value || uncertain.value || props.blocked);
const mediaKey = computed(() => `${props.contextKey}:${epoch}:${selected.value?.id ?? 0}:${skuUnique.value}:${mediaGeneration.value}:${props.modelValue}`);
let alive = true, epoch = 0, productRequest = 0, formRequest = 0;
let productAbort: AbortController | null = null, formAbort: AbortController | null = null;
type Stamp = { epoch: number; context: string; token: string | null; stored: string | null };
const stamp = (): Stamp => ({ epoch, context: props.contextKey, token: getToken(), stored: localStorage.getItem('admin_session') });
let visibleScope: Stamp | null = null;
function current(value: Stamp): boolean { return alive && props.modelValue && props.canManage && !!visibleScope && !!value.token && value.epoch === epoch && value.context === props.contextKey && value.token === getToken() && value.stored === localStorage.getItem('admin_session') && value.stored === visibleScope.stored; }
const errorText = (value: unknown) => value instanceof Error ? value.message : '请求失败';
const invalidCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u;
function text(value: unknown, maximum: number, title: string, multiline = false): string {
  if (typeof value !== 'string') throw Error(`${title}格式错误`);
  if (!value.trim() || [...value].length > maximum || invalidCharacters.test(value) || !multiline && /[\n\r\t]/u.test(value)) throw Error(`${title}须为1至${maximum}个字符且不含非法字符`);
  return value;
}
function imageAddress(value: unknown, maximum: number): string {
  const reference = text(value, maximum, '图片地址');
  if (/[\s\\]/u.test(reference) || !/^(?:https?:\/\/|\/(?!\/)|uploads\/)/iu.test(reference)) throw Error('请选择稳定的 HTTP、HTTPS 或本站图片地址');
  let url: URL; try { url = new URL(reference, 'https://admin-reply.invalid'); } catch { throw Error('图片地址格式错误'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.pathname === '/') throw Error('图片地址格式错误或包含账号信息');
  try { if (/[\u0000-\u0020\u007f-\u009f\\]/u.test(decodeURIComponent(url.pathname))) throw Error(); } catch { throw Error('图片地址格式错误'); }
  return reference;
}
/** Persist canonical references; expiring attachment signatures are display-only. */
function imageReference(value: unknown, maximum = 2048): string {
  const reference = imageAddress(value, maximum), url = new URL(reference, 'https://admin-reply.invalid');
  const temporaryKeys = new Set(['token', 'expires', 'signature', 'x-amz-signature', 'x-goog-signature']);
  if ([...url.searchParams.keys()].some(key => temporaryKeys.has(key.toLowerCase()))) throw Error('请选择稳定的图片地址，不能使用临时签名地址');
  return reference;
}
function preview(value: unknown, maximum = 2048): string { try { const reference = imageAddress(value, maximum); return reference.startsWith('uploads/') ? `/${reference}` : reference; } catch { return ''; } }
function clearForm(): void { mediaGeneration.value++; Object.assign(form, emptyForm()); avatarSelection.value = null; picturePreviews.value = {}; error.value = ''; }
function clearSelection(): void { formRequest++; formAbort?.abort(); formAbort = null; selected.value = null; skuUnique.value = ''; formReady.value = formLoading.value = false; formError.value = ''; clearForm(); }
function reset(): void {
  epoch++; productRequest++; productAbort?.abort(); formAbort?.abort(); productAbort = formAbort = null; visibleScope = null;
  clearSelection(); products.value = []; productCount.value = 0; productPage.value = 1; productLoading.value = false; productError.value = '';
  keyword.value = ''; isNew.value = ''; uncertain.value = false; busy.value = false; emit('busy', false);
}
function close(): void { if (busy.value) return; reset(); emit('update:modelValue', false); }
function beforeClose(done: () => void): void { if (!busy.value) { reset(); emit('update:modelValue', false); done(); } }
function onVisibleChange(visible: boolean): void { if (!visible) close(); }
function verify(): void { if (!busy.value && current(stamp())) { close(); emit('verify'); } }
async function loadDefinition(id: number): Promise<void> {
  if (!current(stamp())) return;
  formAbort?.abort(); const scope = stamp(), request = ++formRequest, controller = new AbortController(); formAbort = controller;
  formLoading.value = true; formReady.value = false; formError.value = '';
  try {
    const result = await apiAdminProductReplyFictitiousForm(id, controller.signal);
    if (!current(scope) || request !== formRequest || (selected.value?.id ?? 0) !== id) return;
    if (!result || result.method !== 'POST' || result.action.replace(/^\/?adminapi\//u, '').replace(/^\//u, '') !== 'product/reply/save_fictitious_reply' || !Array.isArray(result.rules)) throw Error('自评表单配置无效，请刷新后重试');
    const hidden = result.rules.find(rule => rule.field === 'product_id');
    if (id && (!hidden || Number(hidden.value) !== id)) throw Error('商品表单与当前选择不一致，请重新选择');
    formReady.value = true;
  } catch (reason) { if (current(scope) && request === formRequest) formError.value = errorText(reason); }
  finally { if (formAbort === controller) { formAbort = null; formLoading.value = false; } }
}
function validateProducts(result: { list: AdminReplyProduct[]; count: number }): void {
  if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0 || result.list.length > 10 || result.list.length > result.count || new Set(result.list.map(row => row.id)).size !== result.list.length) throw Error('商品分页响应无效');
  for (const row of result.list) {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > 2_147_483_647 || typeof row.store_name !== 'string' || typeof row.image !== 'string' || !Array.isArray(row.attrValue) || new Set(row.attrValue.map(sku => sku.unique)).size !== row.attrValue.length) throw Error('商品或规格响应无效');
    for (const sku of row.attrValue) if (!sku || typeof sku.unique !== 'string' || !sku.unique || [...sku.unique].length > 8 || invalidCharacters.test(sku.unique) || typeof sku.suk !== 'string' || [...sku.suk].length > 255 || invalidCharacters.test(sku.suk) || sku.product_id !== undefined && sku.product_id !== row.id || sku.type !== undefined && sku.type !== 0 || sku.is_retired !== undefined && sku.is_retired !== 0) throw Error('商品规格已失效，请刷新商品列表');
  }
}
async function loadProducts(target = productPage.value): Promise<void> {
  if (!current(stamp()) || !props.canSelect || busy.value || uncertain.value || props.blocked || !Number.isSafeInteger(target) || target < 1 || (target - 1) * 10 > 2_147_483_647) return;
  let name: string; try { name = keyword.value.trim(); if ([...name].length > 128 || invalidCharacters.test(name) || /[\n\r\t]/u.test(name) || !['', 0, 1].includes(isNew.value)) throw Error('商品筛选格式错误或超过128个字符'); } catch (reason) { productError.value = errorText(reason); return; }
  productAbort?.abort(); const scope = stamp(), request = ++productRequest, controller = new AbortController(); productAbort = controller;
  productPage.value = target; productLoading.value = true; productError.value = ''; products.value = [];
  const query: AdminReplyProductQuery = { store_name: name, cate_id: '', store_label_id: '', is_new: isNew.value, is_integral: 1, page: target, limit: 10 };
  try {
    const result = await apiAdminReplyProductSelector(query, controller.signal);
    if (!current(scope) || !props.canSelect || request !== productRequest) return;
    validateProducts(result);
    if (target > 1 && !result.list.length) { await loadProducts(Math.max(1, Math.ceil(result.count / 10))); return; }
    products.value = result.list; productCount.value = result.count;
  } catch (reason) { if (current(scope) && request === productRequest) { products.value = []; productCount.value = 0; productError.value = errorText(reason); } }
  finally { if (productAbort === controller) { productAbort = null; productLoading.value = false; } }
}
async function searchProducts(): Promise<void> { if (props.canSelect && !busy.value && !uncertain.value && !props.blocked) { clearSelection(); await Promise.all([loadDefinition(0), loadProducts(1)]); } }
async function chooseProduct(row: AdminReplyProduct): Promise<void> {
  if (!current(stamp()) || !props.canSelect || productLoading.value || busy.value || uncertain.value || props.blocked || !products.value.includes(row) || !row.attrValue.length || selected.value?.id === row.id && formReady.value) return;
  clearSelection(); selected.value = { ...row, attrValue: row.attrValue.map(sku => ({ ...sku })) }; await loadDefinition(row.id);
}
function changeSku(): void { if (!current(stamp()) || busy.value || uncertain.value || props.blocked) return; clearForm(); }
function addPicture(): void { if (!editorDisabled.value && form.pics.length < 8) form.pics.push(''); }
function removePicture(index: number): void { if (!editorDisabled.value && Number.isInteger(index) && index >= 0 && index < form.pics.length) form.pics.splice(index, 1); }
function chooseAvatar(images: { reference: string; preview: string }[]): void {
  if (!current(stamp()) || editorDisabled.value || images.length !== 1) return;
  try { form.avatar = imageReference(images[0]?.reference, 255); avatarSelection.value = { reference: form.avatar, preview: preview(images[0]?.preview) || preview(form.avatar, 255) }; error.value = ''; } catch (reason) { error.value = errorText(reason); }
}
function choosePictures(images: { reference: string; preview: string }[]): void {
  if (!current(stamp()) || editorDisabled.value) return;
  try { const references = images.map(item => imageReference(item.reference)); const merged = [...new Set([...form.pics.filter(Boolean), ...references])]; if (merged.length > 8) throw Error('评价图片最多8张'); form.pics = merged; for (const item of images) picturePreviews.value[item.reference] = preview(item.preview) || preview(item.reference); error.value = ''; } catch (reason) { error.value = errorText(reason); }
}
function payload(): AdminFictitiousReplyInput {
  if (!selected.value || !selectedSku.value || !formReady.value) throw Error('请选择当前商品及有效规格');
  const nickname = text(form.nickname, 64, '用户名称'), comment = text(form.comment, 512, '评价文字', true), avatar = imageReference(form.avatar, 255);
  if (![form.product_score, form.service_score, form.delivery_score].every(score => Number.isInteger(score) && score >= 1 && score <= 5)) throw Error('商品、服务和物流评分须为1至5之间的整数');
  if (!['1', '2', '3'].includes(form.reply_score)) throw Error('请选择有效的好评、中评或差评');
  if (form.pics.length > 8) throw Error('评价图片最多8张'); const pics = form.pics.map(value => imageReference(value));
  if (new Set(pics).size !== pics.length) throw Error('评价图片不能重复');
  const addTime = typeof form.add_time === 'string' ? form.add_time : '';
  if (form.add_time !== null && typeof form.add_time !== 'string') throw Error('评价时间格式错误');
  if (addTime) {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(addTime);
    if (!match) throw Error('请选择有效的上海评价时间');
    const [, year, month, day, hour, minute, second] = match.map(Number), calendar = new Date(0);
    calendar.setUTCFullYear(year!, month! - 1, day!); calendar.setUTCHours(hour!, minute!, second!, 0);
    if (year! < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) throw Error('请选择有效的上海评价时间');
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const part = (type: string) => parts.find(value => value.type === type)?.value;
    if (addTime > `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`) throw Error('评价时间不能晚于当前上海时间');
  }
  return { image: { product_id: selected.value.id, image: selected.value.image }, unique: selectedSku.value.unique, nickname, avatar, comment,
    product_score: form.product_score, service_score: form.service_score, delivery_score: form.delivery_score, reply_score: form.reply_score, pics, add_time: addTime };
}
async function save(): Promise<void> {
  if (!current(stamp()) || editorDisabled.value || !formReady.value) return;
  let input: AdminFictitiousReplyInput; try { input = payload(); } catch (reason) { error.value = errorText(reason); return; }
  const scope = stamp(); busy.value = true; emit('busy', true); error.value = '';
  try {
    await apiAdminProductReplySaveFictitious(input);
    if (!current(scope)) return;
    busy.value = false; emit('busy', false); ElMessage.success('自评已添加'); close(); emit('created');
  } catch (reason) {
    if (!current(scope)) return;
    const rejected = reason instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(reason.status));
    error.value = `${rejected ? '添加未完成' : '添加结果未确认'}：${errorText(reason)}`;
    if (!rejected) { uncertain.value = true; emit('uncertain'); }
    if (rejected && Number((reason as AdminResponseError).status) === 409) { const notice = error.value; clearSelection(); error.value = notice; }
  } finally { if (current(scope)) { busy.value = false; emit('busy', false); } }
}
watch(() => [props.modelValue, props.canManage, props.contextKey] as const, (value, previous) => {
  if (!value[0] || !value[1] || previous && value[2] !== previous[2]) { reset(); if (value[0]) emit('update:modelValue', false); return; }
  if (!previous || !previous[0]) { reset(); visibleScope = stamp(); keyword.value = props.initialProductId ? String(props.initialProductId) : ''; void loadDefinition(0); void loadProducts(1); }
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { alive = false; reset(); });
</script>

<style scoped>
.notice { margin-top: 10px; }.selector { margin: 16px 0 20px; }.selector :deep(.el-form-item) { margin-bottom: 10px; }.selector :deep(.el-select) { width: 110px; }.hint { font-size: 12px; color: var(--el-text-color-secondary); }
.product-scroll { overflow-x: auto; }.product-name { display: flex; gap: 10px; align-items: center; }.product-name span { overflow-wrap: anywhere; }.thumb { flex: 0 0 42px; width: 42px; height: 42px; border-radius: 4px; }.sku-thumb { margin-left: 10px; }.pager { justify-content: flex-end; margin-top: 12px; }
.editor :deep(.el-select) { min-width: 180px; }.editor :deep(.el-input), .editor :deep(.el-textarea) { width: 100%; }.media-editor { width: 100%; }.media-input, .picture-actions { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }.media-input :deep(.el-input) { flex: 1; min-width: 0; }.picture-actions { flex-wrap: wrap; }.count { display: block; text-align: right; width: 100%; }
@media (max-width: 600px) { .selector :deep(.el-form-item), .selector :deep(.el-form-item__content) { width: 100%; margin-right: 0; }.selector :deep(.el-select) { width: 100%; }.editor :deep(.el-form-item__label) { width: 100% !important; justify-content: flex-start; }.editor :deep(.el-form-item) { flex-direction: column; }.editor :deep(.el-form-item__content) { width: 100%; margin-left: 0 !important; }.media-input { flex-wrap: wrap; }.media-input :deep(.el-input) { flex-basis: 100%; }.editor :deep(.el-date-editor), .editor :deep(.el-select) { width: 100%; min-width: 0; } }
</style>
