<template>
  <div class="activity-frame-form">
    <header class="heading"><div><el-button link @click="back">← 返回活动边框</el-button><h2>{{ frameId ? '编辑活动边框' : '添加活动边框' }}</h2></div></header>
    <el-alert v-if="!canManage" title="当前账号没有活动边框管理权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="loadDetail">重新读取详情</el-button></template></el-alert>
      <el-alert v-if="saveError" :title="saveError" :type="uncertain ? 'warning' : 'error'" :closable="false" show-icon class="notice"><template v-if="uncertain" #default><el-button link @click="acknowledge">已人工核对，允许再次保存</el-button></template></el-alert>
      <el-card v-loading="loading" shadow="never">
        <el-tabs v-model="tab">
          <el-tab-pane label="基础设置" name="base">
            <el-form v-if="form" label-position="top" :disabled="saving || loading">
              <el-form-item label="活动名称" required><el-input v-model="form.name" aria-label="活动名称" maxlength="255" show-word-limit placeholder="请输入活动名称" /></el-form-item>
              <el-form-item label="活动时间" required><el-date-picker v-model="form.section_time" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" start-placeholder="开始时间" end-placeholder="结束时间" range-separator="至" aria-label="活动时间" /></el-form-item>
              <el-form-item label="活动边框图" required><div class="image-field"><el-input v-model="form.image" aria-label="活动边框图地址" maxlength="255" placeholder="从图库选择图片" /><SeckillActivityImagePicker :disabled="!canManage || saving || loading" :editor-key="`${sessionKey}:${epoch}:${formGeneration}`" @choose="chooseImage" /><el-image v-if="safeImage(form.image)" :src="safeImage(form.image)" :preview-src-list="[safeImage(form.image)]" preview-teleported fit="contain" /></div><p class="hint">建议 750 × 750 像素。选择图库中的稳定图片地址。</p></el-form-item>
              <el-form-item label="是否开启"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" inline-prompt active-text="开启" inactive-text="关闭" /></el-form-item>
              <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="32767" :precision="0" :controls="false" aria-label="活动边框排序" /></el-form-item>
            </el-form>
          </el-tab-pane>
          <el-tab-pane label="参与商品" name="scope">
            <template v-if="form"><el-radio-group v-model="form.product_partake_type" :disabled="loading || saving" aria-label="商品参与范围" class="scope-choice"><el-radio :value="1">全部商品参与</el-radio><el-radio :value="2">指定商品参与</el-radio><el-radio :value="3">指定商品不参与</el-radio><el-radio :value="4">指定品牌参与</el-radio><el-radio :value="5">指定商品标签参与</el-radio></el-radio-group>
              <p v-if="form.product_partake_type === 1" class="hint">活动会覆盖符合上架条件的全部商品。</p>
              <template v-if="form.product_partake_type === 2 || form.product_partake_type === 3"><div class="scope-toolbar"><el-button type="primary" :disabled="loading || saving" @click="openPicker('products')">{{ form.product_partake_type === 3 ? '选择不参与商品' : '添加参与商品' }}</el-button><span class="hint">已选 {{ form.product_id.length }} 个商品；跨页选择会保留。</span></div>
                <el-table :data="pickedProducts" row-key="id" border :empty-text="form.product_partake_type === 3 ? '请选择不参与商品' : '请选择参与商品'"><el-table-column prop="id" label="商品 ID" width="100" /><el-table-column label="商品信息" min-width="210"><template #default="{ row }"><div class="product"><el-image v-if="safeImage(row.image)" :src="safeImage(row.image)" fit="cover" /><span>{{ row.store_name }}</span></div></template></el-table-column><el-table-column prop="cate_name" label="商品分类" min-width="130" /><el-table-column prop="price" label="售价" width="105" /><el-table-column prop="stock" label="库存" width="90" /><el-table-column label="操作" width="85"><template #default="{ row }"><el-button link type="danger" :disabled="saving" @click="removePicked('products', row.id)">移除</el-button></template></el-table-column></el-table>
              </template>
              <template v-if="form.product_partake_type === 4"><div class="scope-toolbar"><el-button type="primary" :disabled="loading || saving" @click="openPicker('brands')">选择品牌</el-button><span class="hint">已选 {{ form.brand_id.length }} 个品牌</span></div><div class="selected-tags"><el-tag v-for="brand in pickedBrands" :key="brand.id" closable @close="removePicked('brands', brand.id)">{{ brand.brand_name }} #{{ brand.id }}</el-tag></div></template>
              <template v-if="form.product_partake_type === 5"><div class="scope-toolbar"><el-button type="primary" :disabled="loading || saving" @click="openPicker('labels')">选择商品标签</el-button><span class="hint">已选 {{ form.store_label_id.length }} 个标签</span></div><div class="selected-tags"><el-tag v-for="label in pickedLabels" :key="label.id" closable @close="removePicked('labels', label.id)">{{ label.label_name }} #{{ label.id }}</el-tag></div></template>
            </template>
          </el-tab-pane>
        </el-tabs>
        <div class="footer"><el-button :disabled="saving" @click="back">取消</el-button><el-button v-if="tab === 'base'" :disabled="loading || saving || !form" @click="tab = 'scope'">下一步</el-button><el-button v-else :disabled="loading || saving || !form" @click="tab = 'base'">上一步</el-button><el-button type="primary" :loading="saving" :disabled="loading || !form || !!uncertain" @click="save">保存并发布</el-button></div>
      </el-card>
    </template>

    <el-dialog v-model="pickerVisible" :title="pickerTitle" width="min(920px, calc(100vw - 24px))" append-to-body :close-on-click-modal="false" @closed="pickerClosed">
      <div class="picker-search"><el-input v-model="pickerKeyword" :aria-label="`${pickerTitle}搜索`" :placeholder="`输入${pickerTitle}名称或 ID`" maxlength="100" clearable @keyup.enter="loadOptions(1)" /><el-button :disabled="pickerLoading" @click="loadOptions(1)">查询</el-button></div>
      <el-alert v-if="pickerError" :title="pickerError" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="loadOptions()">重新读取</el-button></template></el-alert>
      <div class="table-scroll"><el-table :data="pickerRows" v-loading="pickerLoading" row-key="id" border :empty-text="pickerLoading ? '正在加载…' : '暂无选项'"><el-table-column label="选择" width="75"><template #default="{ row }"><el-checkbox :model-value="pickerChoices.has(row.id)" :disabled="pickerLoading" :aria-label="`选择 ${optionName(row)}`" @change="toggleChoice(row, $event)" /></template></el-table-column><el-table-column prop="id" label="ID" width="90" /><el-table-column :label="pickerType === 'products' ? '商品' : pickerType === 'brands' ? '品牌' : '标签'" min-width="210"><template #default="{ row }"><div class="product"><el-image v-if="'image' in row && safeImage(row.image)" :src="safeImage(row.image)" fit="cover" /><span>{{ optionName(row) }}</span></div></template></el-table-column><el-table-column v-if="pickerType === 'products'" label="售价 / 库存" width="145"><template #default="{ row }">{{ 'price' in row ? row.price : '' }} / {{ 'stock' in row ? row.stock : '' }}</template></el-table-column></el-table></div>
      <el-pagination :current-page="pickerPage" :page-size="15" :total="pickerCount" layout="total, prev, pager, next" :disabled="pickerLoading" @current-change="loadOptions" class="pagination" />
      <p class="hint">跨页已选 {{ pickerChoices.size }} 项；本页以外的选择也会保留。</p><div class="selected-tags"><el-tag v-for="row in [...pickerChoices.values()]" :key="row.id" closable @close="removeChoice(row.id)">{{ optionName(row) }} #{{ row.id }}</el-tag></div>
      <template #footer><el-button @click="closePicker">取消</el-button><el-button type="primary" :disabled="pickerLoading" @click="applyPicker">应用选择（{{ pickerChoices.size }}）</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import { apiActivityFrameDetail, apiActivityFrameSave, apiActivityFrameProducts, apiActivityFrameBrands, apiActivityFrameLabels, normalizeActivityFrame,
  type ActivityFrameInput, type ActivityFrameProduct, type ActivityFrameBrand, type ActivityFrameLabel } from '@/api/activityFrame';

const route = useRoute(), router = useRouter(), auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('activity_frame.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('activity_frame.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const frameId = computed(() => Number(route.params.id ?? 0));
const tab = ref<'base' | 'scope'>('base');
const form = ref<ActivityFrameInput | null>(null), revision = ref('');
const pickedProducts = ref<ActivityFrameProduct[]>([]), pickedBrands = ref<ActivityFrameBrand[]>([]), pickedLabels = ref<ActivityFrameLabel[]>([]);
const loading = ref(false), saving = ref(false), loadError = ref(''), saveError = ref(''), uncertain = ref(false);
type PickerType = 'products' | 'brands' | 'labels';
type PickerRow = ActivityFrameProduct | ActivityFrameBrand | ActivityFrameLabel;
const pickerVisible = ref(false), pickerType = ref<PickerType>('products'), pickerRows = ref<PickerRow[]>([]), pickerChoices = ref<Map<number, PickerRow>>(new Map());
const pickerLoading = ref(false), pickerError = ref(''), pickerKeyword = ref(''), pickerPage = ref(1), pickerCount = ref(0);
const pickerTitle = computed(() => pickerType.value === 'products' ? '选择商品' : pickerType.value === 'brands' ? '选择品牌' : '选择商品标签');
let alive = false, syncing = false, epoch = 0, formGeneration = 0, pickerGeneration = 0, optionRequest = 0, saveRequest = 0;
let detailAbort: AbortController | null = null, pickerAbort: AbortController | null = null, saveAbort: AbortController | null = null;
let storedSession = localStorage.getItem('admin_session');
type Stamp = { epoch: number; session: string; stored: string | null };
function stamp(): Stamp { return { epoch, session: sessionKey.value, stored: storedSession }; }
function current(value: Stamp) { return alive && canManage.value && auth.token === getToken() && value.epoch === epoch && value.session === sessionKey.value && value.stored === storedSession && value.stored === localStorage.getItem('admin_session'); }
function newForm(): ActivityFrameInput { return { name: '', image: '', status: 1, product_partake_type: 1, product_id: [], brand_id: [], store_label_id: [], section_time: ['', ''], sort: 0 }; }
function invalidate() { epoch++; formGeneration++; pickerGeneration++; optionRequest++; saveRequest++; detailAbort?.abort(); pickerAbort?.abort(); saveAbort?.abort(); detailAbort = pickerAbort = saveAbort = null; form.value = null; revision.value = ''; pickedProducts.value = []; pickedBrands.value = []; pickedLabels.value = []; loading.value = saving.value = false; loadError.value = saveError.value = ''; uncertain.value = false; closePicker(); }
function back() { if (!saving.value) void router.push('/marketing/activity-frame'); }
function safeImage(value: string) { return /^(https:\/\/|\/(?!\/))/iu.test(value) && !/[\u0000-\u0020\u007f\\]/u.test(value) ? value : ''; }
function chooseImage(reference: string) { if (current(stamp()) && form.value && !saving.value) form.value.image = reference; }
function optionName(row: PickerRow) { return 'store_name' in row ? row.store_name : 'brand_name' in row ? row.brand_name : row.label_name; }
async function loadDetail() {
  if (!alive || !canManage.value) return;
  invalidate(); const id = frameId.value, value = stamp(), generation = formGeneration;
  if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) { loadError.value = '活动边框 ID 无效'; return; }
  if (id === 0) { form.value = newForm(); return; }
  const controller = new AbortController(); detailAbort = controller; loading.value = true;
  try {
    const detail = await apiActivityFrameDetail(id, controller.signal);
    if (!current(value) || generation !== formGeneration || frameId.value !== id) return;
    form.value = { name: detail.name, image: detail.image, status: detail.status, product_partake_type: detail.product_partake_type, product_id: [...detail.product_id], brand_id: [...detail.brand_id], store_label_id: [...detail.store_label_id], section_time: [detail.start_time, detail.stop_time], sort: detail.sort ?? 0 };
    revision.value = detail.revision; pickedProducts.value = detail.products;
    pickedBrands.value = detail.brand_id.map(id => detail.brands.find(item => item.id === id)!);
    pickedLabels.value = detail.store_label_id.map(id => detail.labels.find(item => item.id === id)!);
  } catch (reason) { if (current(value) && generation === formGeneration) loadError.value = reason instanceof Error ? reason.message : '详情读取失败'; }
  finally { if (detailAbort === controller) { detailAbort = null; loading.value = false; } }
}
function closePicker() { pickerGeneration++; optionRequest++; pickerAbort?.abort(); pickerAbort = null; pickerVisible.value = pickerLoading.value = false; pickerRows.value = []; pickerChoices.value = new Map(); pickerError.value = ''; pickerCount.value = 0; }
function pickerClosed() { if (!pickerVisible.value) closePicker(); }
function pickerCurrent(value: Stamp, generation: number) { return current(value) && pickerVisible.value && generation === pickerGeneration && !saving.value; }
async function openPicker(type: PickerType) {
  if (!current(stamp()) || !form.value || loading.value || saving.value) return;
  closePicker(); pickerType.value = type; pickerKeyword.value = ''; pickerPage.value = 1;
  const existing = type === 'products' ? pickedProducts.value : type === 'brands' ? pickedBrands.value : pickedLabels.value;
  pickerChoices.value = new Map(existing.map(row => [row.id, row])); pickerVisible.value = true; await loadOptions(1);
}
async function loadOptions(target = pickerPage.value) {
  if (!pickerVisible.value || !current(stamp()) || !Number.isSafeInteger(target) || target < 1 || target > 66_667) return;
  pickerAbort?.abort(); const value = stamp(), generation = pickerGeneration, requestId = ++optionRequest, controller = new AbortController(); pickerAbort = controller;
  pickerPage.value = target; pickerRows.value = []; pickerLoading.value = true; pickerError.value = '';
  try {
    const query = { page: target, limit: 15, keyword: pickerKeyword.value.trim() };
    const result = pickerType.value === 'products' ? await apiActivityFrameProducts(query, controller.signal) : pickerType.value === 'brands' ? await apiActivityFrameBrands(query, controller.signal) : await apiActivityFrameLabels(query, controller.signal);
    if (pickerCurrent(value, generation) && requestId === optionRequest) { pickerRows.value = result.list; pickerCount.value = result.count; }
  } catch (reason) { if (pickerCurrent(value, generation) && requestId === optionRequest) pickerError.value = reason instanceof Error ? reason.message : '选项读取失败'; }
  finally { if (pickerAbort === controller) { pickerAbort = null; pickerLoading.value = false; } }
}
function toggleChoice(row: PickerRow, selected: unknown) {
  if (!pickerVisible.value || !current(stamp()) || pickerLoading.value || !pickerRows.value.some(item => item.id === row.id)) return;
  const choices = new Map(pickerChoices.value); if (selected === true) choices.set(row.id, row); else choices.delete(row.id); pickerChoices.value = choices;
}
function removeChoice(id: number) { if (!current(stamp()) || !pickerVisible.value) return; const choices = new Map(pickerChoices.value); choices.delete(id); pickerChoices.value = choices; }
function applyPicker() {
  if (!current(stamp()) || !form.value || !pickerVisible.value || pickerLoading.value || saving.value) return;
  const rows = [...pickerChoices.value.values()];
  if (pickerType.value === 'products') { pickedProducts.value = rows as ActivityFrameProduct[]; form.value.product_id = rows.map(row => row.id); }
  else if (pickerType.value === 'brands') { pickedBrands.value = rows as ActivityFrameBrand[]; form.value.brand_id = rows.map(row => row.id); }
  else { pickedLabels.value = rows as ActivityFrameLabel[]; form.value.store_label_id = rows.map(row => row.id); }
  closePicker();
}
function removePicked(type: PickerType, id: number) {
  if (!current(stamp()) || !form.value || saving.value) return;
  if (type === 'products') { pickedProducts.value = pickedProducts.value.filter(row => row.id !== id); form.value.product_id = form.value.product_id.filter(value => value !== id); }
  else if (type === 'brands') { pickedBrands.value = pickedBrands.value.filter(row => row.id !== id); form.value.brand_id = form.value.brand_id.filter(value => value !== id); }
  else { pickedLabels.value = pickedLabels.value.filter(row => row.id !== id); form.value.store_label_id = form.value.store_label_id.filter(value => value !== id); }
}
function acknowledge() { if (!saving.value) { uncertain.value = false; saveError.value = ''; } }
async function save() {
  if (!current(stamp()) || !form.value || loading.value || saving.value || uncertain.value) return;
  let body: ActivityFrameInput;
  try { body = normalizeActivityFrame(form.value); }
  catch (reason) { saveError.value = reason instanceof Error ? reason.message : '活动边框配置无效'; return; }
  const id = frameId.value, value = stamp(), generation = formGeneration, requestId = ++saveRequest, controller = new AbortController(); saveAbort = controller; saving.value = true; saveError.value = '';
  try {
    await apiActivityFrameSave(id, { ...body, request_id: crypto.randomUUID(), ...(id ? { revision: revision.value } : {}) }, controller.signal);
    if (!current(value) || generation !== formGeneration || requestId !== saveRequest) return;
    ElMessage.success('活动边框已保存'); void router.push('/marketing/activity-frame');
  } catch (reason) {
    if (!current(value) || generation !== formGeneration || requestId !== saveRequest) return;
    const rejected = reason instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(reason.status));
    uncertain.value = !rejected;
    saveError.value = `${rejected ? '保存未完成' : '保存结果未确认'}：${reason instanceof Error ? reason.message : '请求失败'}。${rejected ? '请修正后再试。' : '请前往列表核对，避免重复提交。'}`;
  } finally { if (saveAbort === controller) { saveAbort = null; saving.value = false; } }
}
function syncSession() { syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); storedSession = localStorage.getItem('admin_session'); syncing = false; void loadDetail(); }
function storage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(sessionKey, () => { if (alive && !syncing) { invalidate(); void loadDetail(); } }, { flush: 'sync' });
watch(() => route.params.id, () => { if (alive) void loadDetail(); });
onMounted(() => { alive = true; window.addEventListener('storage', storage); window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); syncSession(); });
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('storage', storage); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); });
</script>

<style scoped>
.activity-frame-form { min-width: 0; }.heading { margin-bottom: 14px; }.heading h2 { font-size: 18px; margin: 7px 0 0; }.notice { margin-bottom: 12px; }.hint { color: #737985; font-size: 12px; line-height: 1.6; margin: 7px 0; }.image-field { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; width: 100%; }.image-field :deep(.el-input) { width: min(450px, 100%); }.image-field :deep(.el-image) { width: 120px; height: 95px; }.scope-choice { display: flex; flex-wrap: wrap; gap: 8px 18px; }.scope-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 16px 0; }.product { display: flex; align-items: center; gap: 9px; }.product :deep(.el-image) { width: 40px; height: 40px; flex: 0 0 40px; }.selected-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }.footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; margin-top: 24px; }.picker-search { display: flex; gap: 8px; margin-bottom: 12px; }.picker-search :deep(.el-input) { flex: 1; }.table-scroll { overflow-x: auto; }.pagination { display: flex; justify-content: flex-end; margin-top: 12px; }
@media (max-width: 700px) {
  .picker-search { flex-wrap: wrap; }.pagination { justify-content: center; }
  :deep(.el-date-editor.el-range-editor) { width: 100%; height: auto; min-height: 86px; display: grid; grid-template-columns: 16px minmax(0, 1fr) 16px; grid-template-rows: 24px 18px 24px; }
  :deep(.el-range__icon) { grid-column: 1; grid-row: 1; }
  :deep(.el-range-input) { width: 100%; min-width: 0; grid-column: 2; font-size: 12px; }
  :deep(.el-range-input:first-of-type) { grid-row: 1; }
  :deep(.el-range-input:last-of-type) { grid-row: 3; }
  :deep(.el-range-separator) { width: 100%; grid-column: 2; grid-row: 2; line-height: 18px; }
  :deep(.el-range__close-icon) { grid-column: 3; grid-row: 1; }
}
</style>
