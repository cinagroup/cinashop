<template>
  <div class="full-discounts-form">
    <header class="heading"><div><el-button link @click="back">← 返回满减满折</el-button><h2>{{ discountId ? '编辑满减满折' : '添加满减满折' }}</h2></div></header>
    <el-alert v-if="!canManage" title="当前账号没有满减满折管理权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="loadDetail">重新读取详情</el-button></template></el-alert>
      <el-alert v-if="saveError" :title="saveError" :type="uncertain ? 'warning' : 'error'" :closable="false" show-icon class="notice"><template v-if="uncertain" #default><el-button link @click="acknowledge">已人工核对，允许再次保存</el-button></template></el-alert>
      <el-card v-loading="loading" shadow="never">
        <el-tabs v-model="tab">
          <el-tab-pane label="基础设置" name="base">
            <el-form v-if="form" label-position="top" :disabled="saving || loading">
              <el-form-item label="活动名称" required><el-input v-model="form.name" aria-label="活动名称" maxlength="255" show-word-limit placeholder="请输入活动名称" /></el-form-item>
              <el-form-item label="活动时间" required><el-date-picker v-model="form.section_time" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" :default-time="defaultTimes" start-placeholder="开始时间" end-placeholder="结束时间" range-separator="至" popper-class="full-discount-date-popper" aria-label="活动时间" /><p class="hint">按整天选择时，结束默认到当天 23:59:59；也可手动设置精确时间。</p></el-form-item>
              <el-form-item label="优惠门槛类型" required><el-radio-group v-model="form.threshold_type" aria-label="优惠门槛类型" @change="changeThresholdType"><el-radio :value="1">满 N 元</el-radio><el-radio :value="2">满 N 件</el-radio></el-radio-group></el-form-item>
              <el-form-item label="优惠方式" required><el-radio-group v-model="form.promotions_cate" aria-label="优惠方式" @change="changeCategory"><el-radio :value="1">阶梯满减满折（取最高符合层级）</el-radio><el-radio :value="2">循环满减（按门槛倍数减）</el-radio></el-radio-group></el-form-item>
              <el-form-item label="优惠规则" required><div class="rules"><div v-for="(rule, index) in form.promotions" :key="index" class="rule"><div class="rule-head"><strong>{{ form.promotions_cate === 1 ? `第 ${index + 1} 级优惠` : '循环优惠' }}</strong><el-button v-if="form.promotions_cate === 1 && index > 0" link type="danger" :disabled="saving" @click="removeRule(index)">删除层级</el-button></div><div class="rule-fields"><span>{{ form.promotions_cate === 2 ? '每满' : '满' }}</span><el-input-number v-model="rule.threshold" :min="form.threshold_type === 1 ? 0.01 : 1" :max="999999" :precision="form.threshold_type === 1 ? 2 : 0" :controls="false" :aria-label="`第 ${index + 1} 级优惠门槛`" /><span>{{ form.threshold_type === 1 ? '元' : '件' }}</span><el-select v-model="rule.discount_type" :disabled="form.promotions_cate === 2" :aria-label="`第 ${index + 1} 级优惠类型`"><el-option label="减金额" :value="1" /><el-option v-if="form.promotions_cate === 1" label="打折" :value="2" /></el-select><el-input-number v-model="rule.discount" :min="rule.discount_type === 1 ? 0.01 : 0" :max="rule.discount_type === 1 ? 999999 : 100" :precision="rule.discount_type === 1 ? 2 : 0" :controls="false" :aria-label="`第 ${index + 1} 级优惠值`" /><span>{{ rule.discount_type === 1 ? '元' : '%' }}</span></div><p v-if="rule.discount_type === 2" class="hint">折扣输入成交价百分比；90% 即九折，0% 表示免费。</p></div><el-button v-if="form.promotions_cate === 1" :disabled="saving || form.promotions.length >= 100" @click="addRule">添加优惠层级</el-button><p class="hint">阶梯门槛须逐级递增；循环优惠只设一层，且只支持减金额。</p></div></el-form-item>
              <el-form-item label="关联用户标签"><el-switch v-model="labelEnabled" active-text="支付完成后给参与用户打标签" inactive-text="不打标签" /><div v-if="labelEnabled" class="selected-tags"><el-button @click="openPicker('user-labels')">选择用户标签</el-button><el-tag v-for="label in pickedUserLabels" :key="label.id" closable @close="removePicked('user-labels', label.id)">{{ label.label_name }} #{{ label.id }}</el-tag></div><p class="hint">此标签是支付后的打标动作，不限制谁能参与活动。</p></el-form-item>
              <el-form-item label="优惠叠加"><el-switch v-model="overlayEnabled" active-text="允许叠加所选活动" inactive-text="不叠加其他营销活动" /><el-checkbox-group v-if="overlayEnabled" v-model="form.overlay" class="overlay-choices"><el-checkbox :value="5">优惠券</el-checkbox><el-checkbox :value="2">第 N 件 N 折</el-checkbox><el-checkbox :value="1">限时折扣</el-checkbox></el-checkbox-group></el-form-item>
              <el-form-item label="是否开启"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" inline-prompt active-text="开启" inactive-text="关闭" /></el-form-item>
              <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="32767" :precision="0" :controls="false" aria-label="满减满折排序" /></el-form-item>
            </el-form>
          </el-tab-pane>
          <el-tab-pane label="参与商品" name="scope">
            <template v-if="form"><el-radio-group v-model="form.product_partake_type" :disabled="loading || saving" aria-label="商品参与范围" class="scope-choice"><el-radio :value="1">全部商品参与</el-radio><el-radio :value="2">指定商品与规格参与</el-radio><el-radio :value="3">指定商品与规格不参与（扩展）</el-radio><el-radio :value="4">指定品牌参与</el-radio><el-radio :value="5">指定商品标签参与</el-radio></el-radio-group>
              <p v-if="form.product_partake_type === 1" class="hint">活动会覆盖符合上架条件的全部商品。</p>
              <template v-if="form.product_partake_type === 2 || form.product_partake_type === 3"><div class="scope-toolbar"><el-button type="primary" :disabled="loading || saving" @click="openPicker('products')">{{ form.product_partake_type === 3 ? '选择不参与的商品规格' : '添加参与商品规格' }}</el-button><span class="hint">已选 {{ form.product_id.length }} 个父商品，具体 SKU 可在选择弹窗中调整；跨页选择会保留。</span></div>
                <el-table :data="pickedProducts" row-key="id" border :empty-text="form.product_partake_type === 3 ? '请选择不参与的商品规格' : '请选择参与的商品规格'"><el-table-column prop="id" label="商品 ID" width="100" /><el-table-column label="商品信息" min-width="210"><template #default="{ row }"><div class="product"><el-image v-if="safeImage(row.image)" :src="safeImage(row.image)" fit="cover" /><span>{{ row.store_name }}</span></div></template></el-table-column><el-table-column prop="cate_name" label="商品分类" min-width="120" /><el-table-column label="已选规格与售价" min-width="240"><template #default="{ row }"><div v-for="sku in selectedSkus(row)" :key="sku.unique">{{ sku.suk || sku.unique }}：{{ sku.price }} 元</div></template></el-table-column><el-table-column label="操作" width="85"><template #default="{ row }"><el-button link type="danger" :disabled="saving" @click="removePicked('products', row.id)">移除</el-button></template></el-table-column></el-table>
              </template>
              <template v-if="form.product_partake_type === 4"><div class="scope-toolbar"><el-button type="primary" :disabled="loading || saving" @click="openPicker('brands')">选择品牌</el-button><span class="hint">已选 {{ form.brand_id.length }} 个品牌</span></div><div class="selected-tags"><el-tag v-for="brand in pickedBrands" :key="brand.id" closable @close="removePicked('brands', brand.id)">{{ brand.brand_name }} #{{ brand.id }}</el-tag></div></template>
              <template v-if="form.product_partake_type === 5"><div class="scope-toolbar"><el-button type="primary" :disabled="loading || saving" @click="openPicker('labels')">选择商品标签</el-button><span class="hint">已选 {{ form.store_label_id.length }} 个标签</span></div><div class="selected-tags"><el-tag v-for="label in pickedLabels" :key="label.id" closable @close="removePicked('labels', label.id)">{{ label.label_name }} #{{ label.id }}</el-tag></div></template>
            </template>
          </el-tab-pane>
        </el-tabs>
        <div class="footer"><el-button :disabled="saving" @click="back">取消</el-button><el-button v-if="tab === 'base'" :disabled="loading || saving || !form" @click="nextStep">下一步</el-button><el-button v-else :disabled="loading || saving || !form" @click="tab = 'base'">上一步</el-button><el-button v-if="tab === 'scope'" type="primary" :loading="saving" :disabled="loading || !form || !!uncertain || !!loadError" @click="save">保存并发布</el-button></div>
      </el-card>
    </template>

    <el-dialog v-model="pickerVisible" :title="pickerTitle" width="min(920px, calc(100vw - 24px))" append-to-body :close-on-click-modal="false" @closed="pickerClosed">
      <div class="picker-search"><el-input v-model="pickerKeyword" :aria-label="`${pickerTitle}搜索`" :placeholder="`输入${pickerTitle}名称或 ID`" maxlength="100" clearable @keyup.enter="loadOptions(1)" /><el-button :disabled="pickerLoading" @click="loadOptions(1)">查询</el-button></div>
      <el-alert v-if="pickerError" :title="pickerError" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="loadOptions()">重新读取</el-button></template></el-alert>
      <div class="table-scroll"><el-table :data="pickerRows" v-loading="pickerLoading" row-key="id" border :empty-text="pickerLoading ? '正在加载…' : '暂无选项'"><el-table-column label="选择" width="75"><template #default="{ row }"><el-checkbox :model-value="pickerChoices.has(row.id)" :disabled="pickerLoading" :aria-label="`选择 ${optionName(row)}`" @change="toggleChoice(row, $event)" /></template></el-table-column><el-table-column prop="id" label="ID" width="90" /><el-table-column :label="pickerType === 'products' ? '商品' : pickerType === 'brands' ? '品牌' : '标签'" min-width="200"><template #default="{ row }"><div class="product"><el-image v-if="'image' in row && safeImage(row.image)" :src="safeImage(row.image)" fit="cover" /><span>{{ optionName(row) }}</span></div></template></el-table-column><el-table-column v-if="pickerType === 'products'" label="选择具体规格" min-width="280"><template #default="{ row }"><div v-if="'attrValue' in row" class="sku-choices"><el-checkbox v-for="sku in row.attrValue" :key="sku.unique" :model-value="pickerUniques.get(row.id)?.has(sku.unique) ?? false" :disabled="!pickerChoices.has(row.id) || pickerLoading" :aria-label="`选择规格 ${sku.suk || sku.unique}`" @change="toggleSku(row.id, sku.unique, $event)">{{ sku.suk || sku.unique }} · {{ sku.price }} 元 · 库存 {{ sku.stock }}</el-checkbox></div></template></el-table-column></el-table></div>
      <el-pagination :current-page="pickerPage" :page-size="15" :total="pickerCount" layout="total, prev, pager, next" :disabled="pickerLoading" @current-change="loadOptions" class="pagination" />
      <p class="hint">跨页已选 {{ pickerChoices.size }} 项；商品还须逐项勾选具体 SKU，系统不会自动选全规格。</p><div class="selected-tags"><el-tag v-for="row in [...pickerChoices.values()]" :key="row.id" closable @close="removeChoice(row.id)">{{ optionName(row) }} #{{ row.id }}{{ pickerType === 'products' ? `（${pickerUniques.get(row.id)?.size ?? 0} 个规格）` : '' }}</el-tag></div>
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
import { apiFullDiscountDetail, apiFullDiscountSave, apiFullDiscountProducts, apiFullDiscountBrands, apiFullDiscountLabels, apiFullDiscountUserLabels, normalizeFullDiscount,
  type FullDiscountInput, type FullDiscountProduct, type FullDiscountBrand, type FullDiscountLabel, type FullDiscountSku } from '@/api/fullDiscount';

const route = useRoute(), router = useRouter(), auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('full_discount.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('full_discount.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const defaultTimes = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59)];
const discountId = computed(() => Number(route.params.id ?? 0));
const tab = ref<'base' | 'scope'>('base');
const form = ref<FullDiscountInput | null>(null), revision = ref('');
const pickedProducts = ref<FullDiscountProduct[]>([]), pickedBrands = ref<FullDiscountBrand[]>([]), pickedLabels = ref<FullDiscountLabel[]>([]), pickedUserLabels = ref<FullDiscountLabel[]>([]);
const labelEnabled = ref(false), overlayEnabled = ref(false);
const loading = ref(false), saving = ref(false), loadError = ref(''), saveError = ref(''), uncertain = ref(false);
type PickerType = 'products' | 'brands' | 'labels' | 'user-labels';
type PickerRow = FullDiscountProduct | FullDiscountBrand | FullDiscountLabel;
const pickerVisible = ref(false), pickerType = ref<PickerType>('products'), pickerRows = ref<PickerRow[]>([]), pickerChoices = ref<Map<number, PickerRow>>(new Map());
const pickerUniques = ref<Map<number, Set<string>>>(new Map());
const pickerLoading = ref(false), pickerError = ref(''), pickerKeyword = ref(''), pickerPage = ref(1), pickerCount = ref(0);
const pickerTitle = computed(() => pickerType.value === 'products' ? '选择商品与具体规格' : pickerType.value === 'brands' ? '选择品牌' : pickerType.value === 'labels' ? '选择商品标签' : '选择用户标签');
let alive = false, syncing = false, epoch = 0, formGeneration = 0, pickerGeneration = 0, optionRequest = 0, saveRequest = 0;
let detailAbort: AbortController | null = null, pickerAbort: AbortController | null = null, saveAbort: AbortController | null = null;
let storedSession = localStorage.getItem('admin_session');
type Stamp = { epoch: number; session: string; stored: string | null };
function stamp(): Stamp { return { epoch, session: sessionKey.value, stored: storedSession }; }
function current(value: Stamp) { return alive && canManage.value && auth.token === getToken() && value.epoch === epoch && value.session === sessionKey.value && value.stored === storedSession && value.stored === localStorage.getItem('admin_session'); }
function newForm(): FullDiscountInput { return { name: '', section_time: ['', ''], promotions_cate: 1, threshold_type: 1,
  promotions: [{ threshold: 0, discount_type: 1, discount: 0 }], is_label: 0, label_id: [], is_overlay: 0, overlay: [],
  product_partake_type: 1, product_id: [], brand_id: [], store_label_id: [], status: 1, sort: 0 }; }
function invalidate() { epoch++; formGeneration++; pickerGeneration++; optionRequest++; saveRequest++; detailAbort?.abort(); pickerAbort?.abort(); saveAbort?.abort(); detailAbort = pickerAbort = saveAbort = null; form.value = null; revision.value = ''; pickedProducts.value = []; pickedBrands.value = []; pickedLabels.value = []; pickedUserLabels.value = []; labelEnabled.value = overlayEnabled.value = false; loading.value = saving.value = false; loadError.value = saveError.value = ''; uncertain.value = false; closePicker(); }
function back() { if (!saving.value) void router.push('/marketing/full-discounts'); }
function safeImage(value: string) { return /^(https:\/\/|\/(?!\/))/iu.test(value) && !/[\u0000-\u0020\u007f\\]/u.test(value) ? value : ''; }
function selectedSkus(row: FullDiscountProduct): FullDiscountSku[] { const selected = form.value?.product_id.find(item => item.product_id === row.id)?.unique ?? []; return row.attrValue.filter(sku => selected.includes(sku.unique)); }
function optionName(row: PickerRow) { return 'store_name' in row ? row.store_name : 'brand_name' in row ? row.brand_name : row.label_name; }
function changeCategory() { if (form.value) form.value.promotions = [{ threshold: 0, discount_type: 1, discount: 0 }]; }
function changeThresholdType() { if (form.value) form.value.promotions.forEach(rule => { rule.threshold = 0; }); }
function addRule() { if (form.value?.promotions_cate === 1 && form.value.promotions.length < 100) form.value.promotions.push({ threshold: 0, discount_type: 1, discount: 0 }); }
function removeRule(index: number) { if (form.value?.promotions_cate === 1 && index > 0) form.value.promotions.splice(index, 1); }
function inputBody(): FullDiscountInput { if (!form.value) throw Error('表单尚未加载'); return { ...form.value,
  is_label: labelEnabled.value ? 1 : 0, label_id: labelEnabled.value ? form.value.label_id : [],
  is_overlay: overlayEnabled.value ? 1 : 0, overlay: overlayEnabled.value ? form.value.overlay : [] }; }
function nextStep() {
  if (!current(stamp()) || !form.value || loading.value || saving.value) return;
  try { normalizeFullDiscount({ ...inputBody(), product_partake_type: 1, product_id: [], brand_id: [], store_label_id: [] });
    saveError.value = ''; tab.value = 'scope'; }
  catch (reason) { saveError.value = reason instanceof Error ? reason.message : '请完善基础设置'; }
}
async function loadDetail() {
  if (!alive || !canManage.value) return;
  invalidate(); const id = discountId.value, value = stamp(), generation = formGeneration;
  if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) { loadError.value = '满减满折 ID 无效'; return; }
  if (id === 0) { form.value = newForm(); return; }
  const controller = new AbortController(); detailAbort = controller; loading.value = true;
  try {
    const detail = await apiFullDiscountDetail(id, controller.signal);
    if (!current(value) || generation !== formGeneration || discountId.value !== id) return;
    form.value = { name: detail.name, section_time: [detail.start_time, detail.stop_time], promotions_cate: detail.promotions_cate,
      threshold_type: detail.threshold_type, promotions: detail.promotions.map(rule => ({ ...rule })),
      is_label: detail.is_label, label_id: [...detail.label_id], is_overlay: detail.is_overlay, overlay: [...detail.overlay],
      product_partake_type: detail.product_partake_type, product_id: detail.product_id.map(item => ({ product_id: item.product_id, unique: [...item.unique] })),
      brand_id: [...detail.brand_id], store_label_id: [...detail.store_label_id], status: detail.status, sort: detail.sort };
    revision.value = detail.revision; pickedProducts.value = detail.products;
    pickedBrands.value = detail.brand_id.map(id => detail.brands.find(item => item.id === id)!);
    pickedLabels.value = detail.store_label_id.map(id => detail.labels.find(item => item.id === id)!);
    pickedUserLabels.value = detail.label_id.map(id => detail.user_labels.find(item => item.id === id)!);
    labelEnabled.value = detail.is_label === 1; overlayEnabled.value = detail.is_overlay === 1;
  } catch (reason) { if (current(value) && generation === formGeneration) loadError.value = reason instanceof Error ? reason.message : '详情读取失败'; }
  finally { if (detailAbort === controller) { detailAbort = null; loading.value = false; } }
}
function closePicker() { pickerGeneration++; optionRequest++; pickerAbort?.abort(); pickerAbort = null; pickerVisible.value = pickerLoading.value = false; pickerRows.value = []; pickerChoices.value = new Map(); pickerUniques.value = new Map(); pickerError.value = ''; pickerCount.value = 0; }
function pickerClosed() { if (!pickerVisible.value) closePicker(); }
function pickerCurrent(value: Stamp, generation: number) { return current(value) && pickerVisible.value && generation === pickerGeneration && !saving.value; }
async function openPicker(type: PickerType) {
  if (!current(stamp()) || !form.value || loading.value || saving.value) return;
  closePicker(); pickerType.value = type; pickerKeyword.value = ''; pickerPage.value = 1;
  const existing = type === 'products' ? pickedProducts.value : type === 'brands' ? pickedBrands.value : type === 'labels' ? pickedLabels.value : pickedUserLabels.value;
  pickerChoices.value = new Map(existing.map(row => [row.id, row]));
  if (type === 'products') pickerUniques.value = new Map(form.value.product_id.map(item => [item.product_id, new Set(item.unique)]));
  pickerVisible.value = true; await loadOptions(1);
}
async function loadOptions(target = pickerPage.value) {
  if (!pickerVisible.value || !current(stamp()) || !Number.isSafeInteger(target) || target < 1 || target > 66_667) return;
  pickerAbort?.abort(); const value = stamp(), generation = pickerGeneration, requestId = ++optionRequest, controller = new AbortController(); pickerAbort = controller;
  pickerPage.value = target; pickerRows.value = []; pickerLoading.value = true; pickerError.value = '';
  try {
    const query = { page: target, limit: 15, keyword: pickerKeyword.value.trim() };
    const result = pickerType.value === 'products' ? await apiFullDiscountProducts(query, controller.signal)
      : pickerType.value === 'brands' ? await apiFullDiscountBrands(query, controller.signal)
        : pickerType.value === 'labels' ? await apiFullDiscountLabels(query, controller.signal)
          : await apiFullDiscountUserLabels(query, controller.signal);
    if (pickerCurrent(value, generation) && requestId === optionRequest) {
      pickerRows.value = result.list; pickerCount.value = result.count;
      if (pickerType.value === 'products') {
        const choices = new Map(pickerChoices.value);
        for (const row of result.list) if (choices.has(row.id)) choices.set(row.id, row);
        pickerChoices.value = choices;
      }
    }
  } catch (reason) { if (pickerCurrent(value, generation) && requestId === optionRequest) pickerError.value = reason instanceof Error ? reason.message : '选项读取失败'; }
  finally { if (pickerAbort === controller) { pickerAbort = null; pickerLoading.value = false; } }
}
function toggleChoice(row: PickerRow, selected: unknown) {
  if (!pickerVisible.value || !current(stamp()) || pickerLoading.value || !pickerRows.value.some(item => item.id === row.id)) return;
  const choices = new Map(pickerChoices.value), uniques = new Map(pickerUniques.value);
  if (selected === true) { choices.set(row.id, row); if (pickerType.value === 'products' && !uniques.has(row.id)) uniques.set(row.id, new Set()); }
  else { choices.delete(row.id); uniques.delete(row.id); }
  pickerChoices.value = choices; pickerUniques.value = uniques;
}
function toggleSku(productId: number, unique: string, checked: unknown) {
  if (!current(stamp()) || !pickerVisible.value || pickerType.value !== 'products' || pickerLoading.value || !pickerChoices.value.has(productId)) return;
  const product = pickerRows.value.find(row => row.id === productId);
  if (!product || !('attrValue' in product) || !product.attrValue.some(sku => sku.unique === unique)) return;
  const uniques = new Map(pickerUniques.value), selected = new Set(uniques.get(productId) ?? []);
  if (checked === true) selected.add(unique); else selected.delete(unique);
  uniques.set(productId, selected); pickerUniques.value = uniques;
}
function removeChoice(id: number) { if (!current(stamp()) || !pickerVisible.value) return; const choices = new Map(pickerChoices.value), uniques = new Map(pickerUniques.value); choices.delete(id); uniques.delete(id); pickerChoices.value = choices; pickerUniques.value = uniques; }
function applyPicker() {
  if (!current(stamp()) || !form.value || !pickerVisible.value || pickerLoading.value || saving.value) return;
  const rows = [...pickerChoices.value.values()];
  if (pickerType.value === 'user-labels' && rows.length > 100) { pickerError.value = '用户标签最多选择100个，请先取消多余标签'; return; }
  if (pickerType.value === 'products') {
    for (const row of rows) {
      if (!('attrValue' in row)) { pickerError.value = '商品规格身份不完整'; return; }
      const selected = pickerUniques.value.get(row.id);
      if (!selected?.size || [...selected].some(unique => !row.attrValue.some(sku => sku.unique === unique && sku.is_retired !== 1))) {
        pickerError.value = `请为商品 #${row.id} 逐项选择当前可用规格`; return;
      }
    }
    pickedProducts.value = rows as FullDiscountProduct[];
    form.value.product_id = rows.map(row => ({ product_id: row.id, unique: [...pickerUniques.value.get(row.id)!] }));
  }
  else if (pickerType.value === 'brands') { pickedBrands.value = rows as FullDiscountBrand[]; form.value.brand_id = rows.map(row => row.id); }
  else if (pickerType.value === 'labels') { pickedLabels.value = rows as FullDiscountLabel[]; form.value.store_label_id = rows.map(row => row.id); }
  else { pickedUserLabels.value = rows as FullDiscountLabel[]; form.value.label_id = rows.map(row => row.id); }
  closePicker();
}
function removePicked(type: PickerType, id: number) {
  if (!current(stamp()) || !form.value || saving.value) return;
  if (type === 'products') { pickedProducts.value = pickedProducts.value.filter(row => row.id !== id); form.value.product_id = form.value.product_id.filter(value => value.product_id !== id); }
  else if (type === 'brands') { pickedBrands.value = pickedBrands.value.filter(row => row.id !== id); form.value.brand_id = form.value.brand_id.filter(value => value !== id); }
  else if (type === 'labels') { pickedLabels.value = pickedLabels.value.filter(row => row.id !== id); form.value.store_label_id = form.value.store_label_id.filter(value => value !== id); }
  else { pickedUserLabels.value = pickedUserLabels.value.filter(row => row.id !== id); form.value.label_id = form.value.label_id.filter(value => value !== id); }
}
function acknowledge() { if (!saving.value) { uncertain.value = false; saveError.value = ''; } }
function sameIds(ids: number[], rows: { id: number }[]) { return ids.length === rows.length && ids.every(id => rows.some(row => row.id === id)); }
function selectedIdentityValid(value: FullDiscountInput) {
  if ([2, 3].includes(value.product_partake_type)) {
    if (!sameIds(value.product_id.map(item => item.product_id), pickedProducts.value)) return false;
    for (const choice of value.product_id) {
      const product = pickedProducts.value.find(item => item.id === choice.product_id);
      if (!product || choice.unique.some(unique => !product.attrValue.some(sku => sku.unique === unique && sku.is_retired !== 1))) return false;
    }
  }
  if (value.product_partake_type === 4 && !sameIds(value.brand_id, pickedBrands.value)) return false;
  if (value.product_partake_type === 5 && !sameIds(value.store_label_id, pickedLabels.value)) return false;
  return !labelEnabled.value || sameIds(value.label_id, pickedUserLabels.value);
}
async function save() {
  if (!current(stamp()) || !form.value || loading.value || saving.value || uncertain.value || loadError.value) return;
  let body: FullDiscountInput;
  try {
    body = normalizeFullDiscount(inputBody());
    if (!selectedIdentityValid(body)) throw Error('商品规格、品牌或标签身份已变化，请重新选择后保存');
  }
  catch (reason) { saveError.value = reason instanceof Error ? reason.message : '满减满折配置无效'; return; }
  const id = discountId.value, value = stamp(), generation = formGeneration, requestId = ++saveRequest, controller = new AbortController(); saveAbort = controller; saving.value = true; saveError.value = '';
  try {
    await apiFullDiscountSave(id, { ...body, request_id: crypto.randomUUID(), ...(id ? { revision: revision.value } : {}) }, controller.signal);
    if (!current(value) || generation !== formGeneration || requestId !== saveRequest) return;
    ElMessage.success('满减满折已保存'); void router.push('/marketing/full-discounts');
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
.full-discounts-form { min-width: 0; }.heading { margin-bottom: 14px; }.heading h2 { font-size: 18px; margin: 7px 0 0; }.notice { margin-bottom: 12px; }.hint { color: #737985; font-size: 12px; line-height: 1.6; margin: 7px 0; }.unit { margin: 0 10px; }.overlay-choices, .sku-choices { display: flex; flex-wrap: wrap; gap: 6px 14px; }.scope-choice { display: flex; flex-wrap: wrap; gap: 8px 18px; }.scope-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 16px 0; }.product { display: flex; align-items: center; gap: 9px; }.product :deep(.el-image) { width: 40px; height: 40px; flex: 0 0 40px; }.selected-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }.footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; margin-top: 24px; }.picker-search { display: flex; gap: 8px; margin-bottom: 12px; }.picker-search :deep(.el-input) { flex: 1; }.table-scroll { overflow-x: auto; }.pagination { display: flex; justify-content: flex-end; margin-top: 12px; }.rules { width: 100%; }.rule { border: 1px solid var(--el-border-color-light); border-radius: 6px; padding: 12px; margin: 0 0 12px; }.rule-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }.rule-fields { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.rule-fields :deep(.el-input-number) { width: 140px; }.rule-fields :deep(.el-select) { width: 112px; }
@media (max-width: 700px) {
  .picker-search { flex-wrap: wrap; }.pagination { justify-content: center; }
  .rule-fields :deep(.el-input-number) { width: min(150px, calc(50vw - 55px)); }
  .rule-fields :deep(.el-select) { width: 108px; }
  :deep(.el-date-editor.el-range-editor) { width: 100%; height: auto; min-height: 86px; display: grid; grid-template-columns: 16px minmax(0, 1fr) 16px; grid-template-rows: 24px 18px 24px; }
  :deep(.el-range__icon) { grid-column: 1; grid-row: 1; }
  :deep(.el-range-input) { width: 100%; min-width: 0; grid-column: 2; font-size: 12px; }
  :deep(.el-range-input:first-of-type) { grid-row: 1; }
  :deep(.el-range-input:last-of-type) { grid-row: 3; }
  :deep(.el-range-separator) { width: 100%; grid-column: 2; grid-row: 2; line-height: 18px; }
  :deep(.el-range__close-icon) { grid-column: 3; grid-row: 1; }
  :global(.full-discount-date-popper.el-popper) { box-sizing: border-box; width: calc(100vw - 16px) !important; max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); overflow-x: hidden; overflow-y: auto; }
  :global(.full-discount-date-popper .el-date-range-picker) { box-sizing: border-box; width: 100% !important; }
  :global(.full-discount-date-popper .el-picker-panel__body) { min-width: 0; }
  :global(.full-discount-date-popper .el-date-range-picker__content) { box-sizing: border-box; display: block; width: 100%; padding: 8px; }
  :global(.full-discount-date-popper .el-date-range-picker__content.is-left) { border-right: 0; border-bottom: 1px solid var(--el-border-color-light); }
  :global(.full-discount-date-popper .el-date-range-picker__time-header) { display: flex; flex-wrap: wrap; gap: 4px; }
  :global(.full-discount-date-popper .el-date-range-picker__time-header > .el-icon-arrow-right) { display: none; }
  :global(.full-discount-date-popper .el-date-range-picker__editors-wrap) { display: flex; flex: 1 1 100%; min-width: 0; }
  :global(.full-discount-date-popper .el-date-range-picker__time-picker-wrap) { display: block; flex: 1 1 50%; min-width: 0; }
  :global(.full-discount-date-popper .el-date-range-picker__time-picker-wrap .el-input) { width: 100%; }
}
</style>

