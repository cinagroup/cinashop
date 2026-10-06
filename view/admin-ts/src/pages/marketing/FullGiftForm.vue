<template>
  <div class="full-gifts-form">
    <header class="heading"><div><el-button link @click="back">← 返回满送活动</el-button><h2>{{ discountId ? '编辑满送活动' : '添加满送活动' }}</h2></div></header>
    <el-alert v-if="!canManage" title="当前账号没有满送活动管理权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="loadDetail">重新读取详情</el-button></template></el-alert>
      <el-alert v-if="saveError" :title="saveError" :type="uncertain ? 'warning' : 'error'" :closable="false" show-icon class="notice"><template v-if="uncertain" #default><el-button link @click="acknowledge">已人工核对，允许再次保存</el-button></template></el-alert>
      <el-card v-loading="loading" shadow="never">
        <el-tabs v-model="tab">
          <el-tab-pane label="基础设置" name="base">
            <el-form v-if="form" label-position="top" :disabled="saving || loading">
              <el-form-item label="活动名称" required><el-input v-model="form.name" aria-label="活动名称" maxlength="255" show-word-limit placeholder="请输入活动名称" /></el-form-item>
              <el-form-item label="活动时间" required><el-date-picker v-model="form.section_time" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" :default-time="defaultTimes" start-placeholder="开始时间" end-placeholder="结束时间" range-separator="至" popper-class="full-gift-date-popper" aria-label="活动时间" /><p class="hint">按整天选择时，结束默认到当天 23:59:59；也可手动设置精确时间。</p></el-form-item>
              <el-form-item label="优惠门槛类型" required><el-radio-group v-model="form.threshold_type" aria-label="优惠门槛类型" @change="changeThresholdType"><el-radio :value="1">满 N 元</el-radio><el-radio :value="2">满 N 件</el-radio></el-radio-group></el-form-item>
              <el-form-item label="赠送方式" required><el-radio-group v-model="form.promotions_cate" aria-label="赠送方式" @change="changeCategory"><el-radio :value="1">阶梯满送（只享最高符合层级）</el-radio><el-radio :value="2">循环满送（每达门槛赠一次）</el-radio></el-radio-group><p class="hint">循环赠送次数不设上限，请核对赠品及优惠券的活动池总量。</p></el-form-item>
              <el-form-item label="赠送规则" required><div class="rules"><div v-for="(rule, index) in form.promotions" :key="index" class="rule">
                <div class="rule-head"><strong>{{ form.promotions_cate === 1 ? `第 ${index + 1} 级赠送` : '循环赠送' }}</strong><el-button v-if="form.promotions_cate === 1 && index > 0" link type="danger" :disabled="saving" @click="removeRule(index)">删除层级</el-button></div>
                <div class="rule-fields"><span>{{ form.promotions_cate === 2 ? '每满' : '满' }}</span><el-input-number v-model="rule.threshold" :min="form.threshold_type === 1 ? 0.01 : 1" :max="999999" :precision="form.threshold_type === 1 ? 2 : 0" :controls="false" :aria-label="`第 ${index + 1} 级赠送门槛`" /><span>{{ form.threshold_type === 1 ? '元' : '件' }}</span></div>
                <div class="rule-fields gift-field"><span>额外赠送</span><el-input-number v-model="rule.give_integral" :min="0" :max="999999" :precision="0" :controls="false" :aria-label="`第 ${index + 1} 级赠送积分`" /><span>积分（0 为不赠送）</span></div>
                <div class="gift-block"><div class="rule-head"><strong>赠送优惠券</strong><el-button :disabled="saving" @click="openPicker('coupons', index)">选择优惠券</el-button></div><p class="hint">每种券每次赠送 1 张；数量是整场活动的赠券池总上限，必须大于 0。</p>
                  <div v-for="item in rule.give_coupon_id" :key="item.give_coupon_id" class="gift-line"><span>{{ couponName(index, item.give_coupon_id) }} #{{ item.give_coupon_id }}</span><el-input-number v-model="item.give_coupon_num" :min="1" :max="99999999" :precision="0" :controls="false" :aria-label="`第 ${index + 1} 级优惠券 ${item.give_coupon_id} 总数量`" /><span>张总量</span><el-button link type="danger" @click="removeGiftCoupon(index, item.give_coupon_id)">移除</el-button></div>
                </div>
                <div class="gift-block"><div class="rule-head"><strong>赠送商品规格</strong><el-button :disabled="saving" @click="openPicker('gift-products', index)">选择赠品规格</el-button></div><p class="hint">每种规格每次赠送 1 件；数量是整场活动的赠品池总上限。已赠出的数量会保留，新增加的可赠量不得超过当前库存。</p>
                  <div v-for="item in rule.give_product_id" :key="`${item.give_product_id}:${item.unique}`" class="gift-line"><span>{{ giftName(index, item.give_product_id, item.unique) }} #{{ item.give_product_id }} · {{ item.unique }}</span><el-input-number v-model="item.give_product_num" :min="1" :max="99999999" :precision="0" :controls="false" :aria-label="`第 ${index + 1} 级赠品 ${item.give_product_id} ${item.unique} 总数量`" /><span>件总量</span><el-button link type="danger" @click="removeGiftProduct(index, item.give_product_id, item.unique)">移除</el-button></div>
                </div>
              </div><el-button v-if="form.promotions_cate === 1" :disabled="saving || form.promotions.length >= 100" @click="addRule">添加赠送层级</el-button><p class="hint">每级至少赠送积分、券或赠品之一。阶梯门槛逐级递增，达到高层后不再领取低层奖励；循环只设一层。</p></div></el-form-item>
              <el-form-item label="关联用户标签"><el-switch v-model="labelEnabled" active-text="支付完成后给参与用户打标签" inactive-text="不打标签" /><div v-if="labelEnabled" class="selected-tags"><el-button @click="openPicker('user-labels')">选择用户标签</el-button><el-tag v-for="label in pickedUserLabels" :key="label.id" closable @close="removePicked('user-labels', label.id)">{{ label.label_name }} #{{ label.id }}</el-tag></div><p class="hint">此标签是支付后的打标动作，不限制谁能参与活动。</p></el-form-item>
              <el-form-item label="是否开启"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" inline-prompt active-text="开启" inactive-text="关闭" /></el-form-item>
              <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="32767" :precision="0" :controls="false" aria-label="满送活动排序" /></el-form-item>
            </el-form>
          </el-tab-pane>
          <el-tab-pane label="参与商品" name="scope">
            <template v-if="form"><el-radio-group v-model="form.product_partake_type" :disabled="loading || saving" aria-label="商品参与范围" class="scope-choice"><el-radio :value="1">全部商品参与</el-radio><el-radio :value="2">指定商品与规格参与</el-radio><el-radio :value="4">指定品牌参与</el-radio><el-radio :value="5">指定商品标签参与</el-radio></el-radio-group>
              <p v-if="form.product_partake_type === 1" class="hint">活动会覆盖符合上架条件的全部商品。</p>
              <template v-if="form.product_partake_type === 2"><div class="scope-toolbar"><el-button type="primary" :disabled="loading || saving" @click="openPicker('products')">添加参与商品规格</el-button><span class="hint">已选 {{ form.product_id.length }} 个父商品，具体 SKU 可在选择弹窗中调整；跨页选择会保留。</span></div>
                <el-table :data="pickedProducts" row-key="id" border empty-text="请选择参与的商品规格"><el-table-column prop="id" label="商品 ID" width="100" /><el-table-column label="商品信息" min-width="210"><template #default="{ row }"><div class="product"><el-image v-if="safeImage(row.image)" :src="safeImage(row.image)" fit="cover" /><span>{{ row.store_name }}</span></div></template></el-table-column><el-table-column prop="cate_name" label="商品分类" min-width="120" /><el-table-column label="已选规格与售价" min-width="240"><template #default="{ row }"><div v-for="sku in selectedSkus(row)" :key="sku.unique">{{ sku.suk || sku.unique }}：{{ sku.price }} 元</div></template></el-table-column><el-table-column label="操作" width="85"><template #default="{ row }"><el-button link type="danger" :disabled="saving" @click="removePicked('products', row.id)">移除</el-button></template></el-table-column></el-table>
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
      <div class="table-scroll"><el-table :data="pickerRows" v-loading="pickerLoading" row-key="id" border :empty-text="pickerLoading ? '正在加载…' : '暂无选项'"><el-table-column label="选择" width="75"><template #default="{ row }"><el-checkbox :model-value="pickerChoices.has(row.id)" :disabled="pickerLoading || (pickerType === 'gift-products' && row.gift_eligible !== 1 && !pickerChoices.has(row.id))" :aria-label="`选择 ${optionName(row)}`" @change="toggleChoice(row, $event)" /></template></el-table-column><el-table-column prop="id" label="ID" width="90" /><el-table-column :label="pickerType === 'products' || pickerType === 'gift-products' ? '商品' : pickerType === 'coupons' ? '优惠券' : pickerType === 'brands' ? '品牌' : '标签'" min-width="200"><template #default="{ row }"><div class="product"><el-image v-if="'image' in row && safeImage(row.image)" :src="safeImage(row.image)" fit="cover" /><span>{{ optionName(row) }}<small v-if="pickerType === 'gift-products' && 'gift_eligible' in row && row.gift_eligible === 0" class="hint">（非可赠实物）</small></span></div></template></el-table-column><el-table-column v-if="pickerType === 'products' || pickerType === 'gift-products'" label="选择具体规格" min-width="280"><template #default="{ row }"><div v-if="'attrValue' in row" class="sku-choices"><el-checkbox v-for="sku in row.attrValue" :key="sku.unique" :model-value="pickerUniques.get(row.id)?.has(sku.unique) ?? false" :disabled="!pickerChoices.has(row.id) || pickerLoading || (pickerType === 'gift-products' && row.gift_eligible !== 1)" :aria-label="`选择规格 ${sku.suk || sku.unique}`" @change="toggleSku(row.id, sku.unique, $event)">{{ sku.suk || sku.unique }} · {{ sku.price }} 元 · 库存 {{ sku.stock }}</el-checkbox></div></template></el-table-column><el-table-column v-if="pickerType === 'coupons'" label="面值与剩余" min-width="170"><template #default="{ row }"><span v-if="'coupon_price' in row">{{ row.coupon_type === 1 ? `${row.coupon_price} 元` : `${row.coupon_price}% 折扣` }} · 剩余 {{ row.is_permanent ? '不限量' : row.remain_count }}</span></template></el-table-column></el-table></div>
      <el-pagination :current-page="pickerPage" :page-size="15" :total="pickerCount" layout="total, prev, pager, next" :disabled="pickerLoading" @current-change="loadOptions" class="pagination" />
      <p class="hint">跨页已选 {{ pickerChoices.size }} 项；商品还须逐项勾选具体 SKU，系统不会自动选全规格。</p><div class="selected-tags"><el-tag v-for="row in [...pickerChoices.values()]" :key="row.id" closable @close="removeChoice(row.id)">{{ optionName(row) }} #{{ row.id }}{{ pickerType === 'products' || pickerType === 'gift-products' ? `（${pickerUniques.get(row.id)?.size ?? 0} 个规格）` : '' }}</el-tag></div>
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
import { apiFullGiftDetail, apiFullGiftSave, apiFullGiftProducts, apiFullGiftBrands, apiFullGiftLabels, apiFullGiftUserLabels, apiFullGiftCoupons, normalizeFullGift, fullGiftAvailablePool,
  type FullGiftInput, type FullGiftProduct, type FullGiftBrand, type FullGiftLabel, type FullGiftSku, type FullGiftCoupon, type FullGiftRuleDetail } from '@/api/fullGift';

const route = useRoute(), router = useRouter(), auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('full_gift.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('full_gift.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const defaultTimes = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59)];
const discountId = computed(() => Number(route.params.id ?? 0));
const tab = ref<'base' | 'scope'>('base');
const form = ref<FullGiftInput | null>(null), revision = ref('');
const pickedProducts = ref<FullGiftProduct[]>([]), pickedBrands = ref<FullGiftBrand[]>([]), pickedLabels = ref<FullGiftLabel[]>([]), pickedUserLabels = ref<FullGiftLabel[]>([]);
const pickedGiftProducts = ref<FullGiftProduct[][]>([]), pickedGiftCoupons = ref<FullGiftCoupon[][]>([]);
type Pool = { limit: number; surplus: number };
type TierPools = { coupons: Map<number, Pool>; products: Map<string, Pool> };
const originalPools = ref<TierPools[]>([]);
function emptyPools(): TierPools { return { coupons: new Map(), products: new Map() }; }
const labelEnabled = ref(false);
const loading = ref(false), saving = ref(false), loadError = ref(''), saveError = ref(''), uncertain = ref(false);
type PickerType = 'products' | 'gift-products' | 'coupons' | 'brands' | 'labels' | 'user-labels';
type PickerRow = FullGiftProduct | FullGiftBrand | FullGiftLabel | FullGiftCoupon;
const pickerVisible = ref(false), pickerType = ref<PickerType>('products'), pickerRuleIndex = ref(-1), pickerRows = ref<PickerRow[]>([]), pickerChoices = ref<Map<number, PickerRow>>(new Map());
const pickerUniques = ref<Map<number, Set<string>>>(new Map());
const pickerLoading = ref(false), pickerError = ref(''), pickerKeyword = ref(''), pickerPage = ref(1), pickerCount = ref(0);
const pickerTitle = computed(() => pickerType.value === 'products' ? '选择参与商品与规格' : pickerType.value === 'gift-products' ? '选择赠品规格'
  : pickerType.value === 'coupons' ? '选择赠送优惠券' : pickerType.value === 'brands' ? '选择品牌' : pickerType.value === 'labels' ? '选择商品标签' : '选择用户标签');
let alive = false, syncing = false, epoch = 0, formGeneration = 0, pickerGeneration = 0, optionRequest = 0, saveRequest = 0;
let detailAbort: AbortController | null = null, pickerAbort: AbortController | null = null, saveAbort: AbortController | null = null;
let storedSession = localStorage.getItem('admin_session');
type Stamp = { epoch: number; session: string; stored: string | null };
function stamp(): Stamp { return { epoch, session: sessionKey.value, stored: storedSession }; }
function current(value: Stamp) { return alive && canManage.value && auth.token === getToken() && value.epoch === epoch && value.session === sessionKey.value && value.stored === storedSession && value.stored === localStorage.getItem('admin_session'); }
function blankRule(id?: number) { return { ...(id === undefined ? {} : { id }), threshold: 0, give_integral: 0, give_coupon_id: [], give_product_id: [] }; }
function newForm(): FullGiftInput { return { name: '', section_time: ['', ''], promotions_cate: 1, threshold_type: 1,
  promotions: [blankRule()], is_label: 0, label_id: [],
  product_partake_type: 1, product_id: [], brand_id: [], store_label_id: [], status: 1, sort: 0 }; }
function invalidate() { epoch++; formGeneration++; pickerGeneration++; optionRequest++; saveRequest++; detailAbort?.abort(); pickerAbort?.abort(); saveAbort?.abort(); detailAbort = pickerAbort = saveAbort = null; form.value = null; revision.value = ''; pickedProducts.value = []; pickedBrands.value = []; pickedLabels.value = []; pickedUserLabels.value = []; pickedGiftProducts.value = []; pickedGiftCoupons.value = []; originalPools.value = []; labelEnabled.value = false; loading.value = saving.value = false; loadError.value = saveError.value = ''; uncertain.value = false; closePicker(); }
function back() { if (!saving.value) void router.push('/marketing/full-gifts'); }
function safeImage(value: string) { return /^(https:\/\/|\/(?!\/))/iu.test(value) && !/[\u0000-\u0020\u007f\\]/u.test(value) ? value : ''; }
function selectedSkus(row: FullGiftProduct): FullGiftSku[] { const selected = form.value?.product_id.find(item => item.product_id === row.id)?.unique ?? []; return row.attrValue.filter(sku => selected.includes(sku.unique)); }
function optionName(row: PickerRow) { return 'store_name' in row ? row.store_name : 'coupon_title' in row ? row.coupon_title : 'brand_name' in row ? row.brand_name : row.label_name; }
function changeCategory() { if (form.value) { const id = form.value.promotions[0]?.id, pools = originalPools.value[0] ?? emptyPools(); form.value.promotions = [blankRule(id)]; pickedGiftProducts.value = [[]]; pickedGiftCoupons.value = [[]]; originalPools.value = [pools]; } }
function changeThresholdType() { if (form.value) form.value.promotions.forEach(rule => { rule.threshold = 0; }); }
function addRule() { if (form.value?.promotions_cate === 1 && form.value.promotions.length < 100) { form.value.promotions.push(blankRule()); pickedGiftProducts.value.push([]); pickedGiftCoupons.value.push([]); originalPools.value.push(emptyPools()); } }
function removeRule(index: number) { if (form.value?.promotions_cate === 1 && index > 0) { form.value.promotions.splice(index, 1); pickedGiftProducts.value.splice(index, 1); pickedGiftCoupons.value.splice(index, 1); originalPools.value.splice(index, 1); } }
function inputBody(): FullGiftInput { if (!form.value) throw Error('表单尚未加载'); return { ...form.value,
  is_label: labelEnabled.value ? 1 : 0, label_id: labelEnabled.value ? form.value.label_id : [] }; }
function couponName(index: number, id: number) { return pickedGiftCoupons.value[index]?.find(row => row.id === id)?.coupon_title ?? '已失效优惠券'; }
function giftName(index: number, id: number, unique: string) {
  const row = pickedGiftProducts.value[index]?.find(item => item.id === id), sku = row?.attrValue.find(item => item.unique === unique);
  return row && sku ? `${row.store_name} · ${sku.suk || unique}` : '已失效赠品规格';
}
function removeGiftCoupon(index: number, id: number) {
  if (!current(stamp()) || !form.value || saving.value) return;
  form.value.promotions[index].give_coupon_id = form.value.promotions[index].give_coupon_id.filter(item => item.give_coupon_id !== id);
  pickedGiftCoupons.value[index] = pickedGiftCoupons.value[index].filter(row => row.id !== id);
}
function removeGiftProduct(index: number, id: number, unique: string) {
  if (!current(stamp()) || !form.value || saving.value) return;
  form.value.promotions[index].give_product_id = form.value.promotions[index].give_product_id.filter(item => item.give_product_id !== id || item.unique !== unique);
  const parent = pickedGiftProducts.value[index].find(item => item.id === id);
  if (parent) parent.attrValue = parent.attrValue.filter(item => item.unique !== unique);
  pickedGiftProducts.value[index] = pickedGiftProducts.value[index].filter(item => item.attrValue.length);
}
function giftRows(rule: FullGiftRuleDetail): FullGiftProduct[] {
  const parents = new Map<number, FullGiftProduct>();
  for (const gift of rule.giveProducts) {
    let parent = parents.get(gift.product_id);
    if (!parent) { parent = { id: gift.product_id, store_name: gift.store_name, image: gift.image,
      price: '0', stock: gift.stock, cate_name: '', pid: 0, is_show: 1, is_del: 0, is_verify: 1, gift_eligible: 1, attrValue: [] };
      parents.set(gift.product_id, parent); }
    parent.attrValue.push({ id: gift.sku.id, unique: gift.unique, suk: gift.sku.suk,
      price: '0', stock: gift.sku.stock, is_retired: gift.sku.is_retired });
  }
  return [...parents.values()];
}
function availableFor(index: number, kind: 'coupons' | 'products', key: number | string, limit: number) {
  const previous = kind === 'coupons' ? originalPools.value[index]?.coupons.get(key as number)
    : originalPools.value[index]?.products.get(key as string);
  return fullGiftAvailablePool(limit, previous?.limit ?? 0, previous?.surplus ?? 0);
}
function validateGiftCapacity(value: FullGiftInput) {
  for (let index = 0; index < value.promotions.length; index++) {
    const rule = value.promotions[index];
    for (const item of rule.give_coupon_id) {
      const coupon = pickedGiftCoupons.value[index]?.find(row => row.id === item.give_coupon_id);
      if (!coupon) throw Error('赠券身份已变化');
      const available = availableFor(index, 'coupons', item.give_coupon_id, item.give_coupon_num);
      if (coupon.is_permanent === 0 && available > coupon.remain_count) throw Error(`优惠券 #${item.give_coupon_id} 新增可赠量超过发行剩余量`);
    }
    for (const item of rule.give_product_id) {
      const product = pickedGiftProducts.value[index]?.find(row => row.id === item.give_product_id);
      const sku = product?.attrValue.find(row => row.unique === item.unique);
      if (!product || !sku) throw Error('赠品规格身份已变化');
      const available = availableFor(index, 'products', `${item.give_product_id}:${item.unique}`, item.give_product_num);
      if (available > Math.min(product.stock, sku.stock)) throw Error(`赠品 #${item.give_product_id} ${item.unique} 新增可赠量超过当前库存`);
    }
  }
}
function nextStep() {
  if (!current(stamp()) || !form.value || loading.value || saving.value) return;
  try { normalizeFullGift({ ...inputBody(), product_partake_type: 1, product_id: [], brand_id: [], store_label_id: [] });
    saveError.value = ''; tab.value = 'scope'; }
  catch (reason) { saveError.value = reason instanceof Error ? reason.message : '请完善基础设置'; }
}
async function loadDetail() {
  if (!alive || !canManage.value) return;
  invalidate(); const id = discountId.value, value = stamp(), generation = formGeneration;
  if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) { loadError.value = '满送活动 ID 无效'; return; }
  if (id === 0) { form.value = newForm(); pickedGiftProducts.value = [[]]; pickedGiftCoupons.value = [[]]; originalPools.value = [emptyPools()]; return; }
  const controller = new AbortController(); detailAbort = controller; loading.value = true;
  try {
    const detail = await apiFullGiftDetail(id, controller.signal);
    if (!current(value) || generation !== formGeneration || discountId.value !== id) return;
    form.value = { name: detail.name, section_time: [detail.start_time, detail.stop_time], promotions_cate: detail.promotions_cate,
      threshold_type: detail.threshold_type, promotions: detail.promotions.map(rule => ({ id: rule.id,
        threshold: rule.threshold, give_integral: rule.give_integral,
        give_coupon_id: rule.give_coupon_id.map(item => ({ ...item })),
        give_product_id: rule.give_product_id.map(item => ({ ...item })) })),
      is_label: detail.is_label, label_id: [...detail.label_id],
      product_partake_type: detail.product_partake_type, product_id: detail.product_id.map(item => ({ product_id: item.product_id, unique: [...item.unique] })),
      brand_id: [...detail.brand_id], store_label_id: [...detail.store_label_id], status: detail.status, sort: detail.sort };
    revision.value = detail.revision; pickedProducts.value = detail.products;
    pickedGiftProducts.value = detail.promotions.map(giftRows);
    pickedGiftCoupons.value = detail.promotions.map(rule => rule.giveCoupon.map(item => ({ ...item, id: item.coupon_id })));
    originalPools.value = detail.promotions.map(rule => ({
      coupons: new Map(rule.giveCoupon.map(item => [item.coupon_id, { limit: item.limit_num, surplus: item.surplus_num }])),
      products: new Map(rule.giveProducts.map(item => [`${item.product_id}:${item.unique}`, { limit: item.limit_num, surplus: item.surplus_num }])),
    }));
    pickedBrands.value = detail.brand_id.map(id => detail.brands.find(item => item.id === id)!);
    pickedLabels.value = detail.store_label_id.map(id => detail.labels.find(item => item.id === id)!);
    pickedUserLabels.value = detail.label_id.map(id => detail.user_labels.find(item => item.id === id)!);
    labelEnabled.value = detail.is_label === 1;
  } catch (reason) { if (current(value) && generation === formGeneration) loadError.value = reason instanceof Error ? reason.message : '详情读取失败'; }
  finally { if (detailAbort === controller) { detailAbort = null; loading.value = false; } }
}
function closePicker() { pickerGeneration++; optionRequest++; pickerAbort?.abort(); pickerAbort = null; pickerVisible.value = pickerLoading.value = false; pickerRows.value = []; pickerChoices.value = new Map(); pickerUniques.value = new Map(); pickerError.value = ''; pickerCount.value = 0; }
function pickerClosed() { if (!pickerVisible.value) closePicker(); }
function pickerCurrent(value: Stamp, generation: number) { return current(value) && pickerVisible.value && generation === pickerGeneration && !saving.value; }
async function openPicker(type: PickerType, ruleIndex = -1) {
  if (!current(stamp()) || !form.value || loading.value || saving.value) return;
  if ((type === 'gift-products' || type === 'coupons') && (!Number.isSafeInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= form.value.promotions.length)) return;
  closePicker(); pickerType.value = type; pickerRuleIndex.value = ruleIndex; pickerKeyword.value = ''; pickerPage.value = 1;
  const existing = type === 'products' ? pickedProducts.value : type === 'gift-products' ? pickedGiftProducts.value[ruleIndex]
    : type === 'coupons' ? pickedGiftCoupons.value[ruleIndex] : type === 'brands' ? pickedBrands.value : type === 'labels' ? pickedLabels.value : pickedUserLabels.value;
  pickerChoices.value = new Map(existing.map(row => [row.id, row]));
  if (type === 'products') pickerUniques.value = new Map(form.value.product_id.map(item => [item.product_id, new Set(item.unique)]));
  if (type === 'gift-products') {
    const uniques = new Map<number, Set<string>>();
    for (const item of form.value.promotions[ruleIndex].give_product_id) {
      const selected = uniques.get(item.give_product_id) ?? new Set<string>(); selected.add(item.unique); uniques.set(item.give_product_id, selected);
    }
    pickerUniques.value = uniques;
  }
  pickerVisible.value = true; await loadOptions(1);
}
async function loadOptions(target = pickerPage.value) {
  if (!pickerVisible.value || !current(stamp()) || !Number.isSafeInteger(target) || target < 1 || target > 66_667) return;
  pickerAbort?.abort(); const value = stamp(), generation = pickerGeneration, requestId = ++optionRequest, controller = new AbortController(); pickerAbort = controller;
  pickerPage.value = target; pickerRows.value = []; pickerLoading.value = true; pickerError.value = '';
  try {
    const query = { page: target, limit: 15, keyword: pickerKeyword.value.trim() };
    const result = pickerType.value === 'products' || pickerType.value === 'gift-products' ? await apiFullGiftProducts(query, controller.signal)
      : pickerType.value === 'coupons' ? await apiFullGiftCoupons(query, controller.signal)
      : pickerType.value === 'brands' ? await apiFullGiftBrands(query, controller.signal)
        : pickerType.value === 'labels' ? await apiFullGiftLabels(query, controller.signal)
          : await apiFullGiftUserLabels(query, controller.signal);
    if (pickerCurrent(value, generation) && requestId === optionRequest) {
      pickerRows.value = result.list; pickerCount.value = result.count;
      if (pickerType.value === 'products' || pickerType.value === 'gift-products') {
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
  if (selected === true && pickerType.value === 'gift-products' && (!('gift_eligible' in row) || row.gift_eligible !== 1)) return;
  const choices = new Map(pickerChoices.value), uniques = new Map(pickerUniques.value);
  if (selected === true) { choices.set(row.id, row); if ((pickerType.value === 'products' || pickerType.value === 'gift-products') && !uniques.has(row.id)) uniques.set(row.id, new Set()); }
  else { choices.delete(row.id); uniques.delete(row.id); }
  pickerChoices.value = choices; pickerUniques.value = uniques;
}
function toggleSku(productId: number, unique: string, checked: unknown) {
  if (!current(stamp()) || !pickerVisible.value || !['products', 'gift-products'].includes(pickerType.value) || pickerLoading.value || !pickerChoices.value.has(productId)) return;
  const product = pickerRows.value.find(row => row.id === productId);
  if (!product || !('attrValue' in product) || !product.attrValue.some(sku => sku.unique === unique)) return;
  if (pickerType.value === 'gift-products' && product.gift_eligible !== 1) return;
  const uniques = new Map(pickerUniques.value), selected = new Set(uniques.get(productId) ?? []);
  if (checked === true) selected.add(unique); else selected.delete(unique);
  uniques.set(productId, selected); pickerUniques.value = uniques;
}
function removeChoice(id: number) { if (!current(stamp()) || !pickerVisible.value) return; const choices = new Map(pickerChoices.value), uniques = new Map(pickerUniques.value); choices.delete(id); uniques.delete(id); pickerChoices.value = choices; pickerUniques.value = uniques; }
function applyPicker() {
  if (!current(stamp()) || !form.value || !pickerVisible.value || pickerLoading.value || saving.value) return;
  const rows = [...pickerChoices.value.values()];
  if (pickerType.value === 'user-labels' && rows.length > 100) { pickerError.value = '用户标签最多选择100个，请先取消多余标签'; return; }
  if (pickerType.value === 'products' || pickerType.value === 'gift-products') {
    for (const row of rows) {
      if (!('attrValue' in row)) { pickerError.value = '商品规格身份不完整'; return; }
      if (pickerType.value === 'gift-products' && row.gift_eligible !== 1) { pickerError.value = `商品 #${row.id} 当前不可作为赠品`; return; }
      const selected = pickerUniques.value.get(row.id);
      if (!selected?.size || [...selected].some(unique => !row.attrValue.some(sku => sku.unique === unique && sku.is_retired !== 1))) {
        pickerError.value = `请为商品 #${row.id} 逐项选择当前可用规格`; return;
      }
    }
    if (pickerType.value === 'products') {
      pickedProducts.value = rows as FullGiftProduct[];
      form.value.product_id = rows.map(row => ({ product_id: row.id, unique: [...pickerUniques.value.get(row.id)!] }));
    } else {
      const index = pickerRuleIndex.value, rule = form.value.promotions[index];
      if (!rule) return;
      const quantities = new Map(rule.give_product_id.map(item => [`${item.give_product_id}:${item.unique}`, item.give_product_num]));
      const selected = rows.flatMap(row => [...pickerUniques.value.get(row.id)!].map(unique => {
        const sku = (row as FullGiftProduct).attrValue.find(item => item.unique === unique);
        const key = `${row.id}:${unique}`;
        return { give_product_id: row.id, unique, give_product_num: quantities.get(key) ?? originalPools.value[index]?.products.get(key)?.limit ?? 1,
          stock: Math.min((row as FullGiftProduct).stock, sku?.stock ?? 0) };
      }));
      if (selected.length > 100) { pickerError.value = '每级赠品规格最多100种'; return; }
      try { for (const item of selected) if (availableFor(index, 'products', `${item.give_product_id}:${item.unique}`, item.give_product_num) > item.stock) throw Error('新增可赠量超过赠品库存'); }
      catch (reason) { pickerError.value = reason instanceof Error ? reason.message : '赠品池数量无效'; return; }
      pickedGiftProducts.value[index] = rows as FullGiftProduct[];
      rule.give_product_id = selected.map(({ give_product_id, unique, give_product_num }) => ({ give_product_id, unique, give_product_num }));
    }
  }
  else if (pickerType.value === 'coupons') {
    const index = pickerRuleIndex.value, rule = form.value.promotions[index];
    if (!rule || rows.some(row => !('coupon_title' in row) || row.status !== 1 || row.is_del !== 0)) { pickerError.value = '赠券身份或状态已变化'; return; }
    const quantities = new Map(rule.give_coupon_id.map(item => [item.give_coupon_id, item.give_coupon_num]));
    const selected = rows.map(row => ({ give_coupon_id: row.id,
      give_coupon_num: quantities.get(row.id) ?? originalPools.value[index]?.coupons.get(row.id)?.limit ?? 1 }));
    if (selected.length > 100) { pickerError.value = '每级赠券最多100种'; return; }
    try { for (const item of selected) {
      const coupon = rows.find(row => row.id === item.give_coupon_id) as FullGiftCoupon;
      if (coupon.is_permanent === 0 && availableFor(index, 'coupons', item.give_coupon_id, item.give_coupon_num) > coupon.remain_count) throw Error('新增可赠量超过发行剩余量');
    } } catch (reason) { pickerError.value = reason instanceof Error ? reason.message : '赠券池数量无效'; return; }
    pickedGiftCoupons.value[index] = rows as FullGiftCoupon[]; rule.give_coupon_id = selected;
  }
  else if (pickerType.value === 'brands') { pickedBrands.value = rows as FullGiftBrand[]; form.value.brand_id = rows.map(row => row.id); }
  else if (pickerType.value === 'labels') { pickedLabels.value = rows as FullGiftLabel[]; form.value.store_label_id = rows.map(row => row.id); }
  else { pickedUserLabels.value = rows as FullGiftLabel[]; form.value.label_id = rows.map(row => row.id); }
  closePicker();
}
function removePicked(type: 'products' | 'brands' | 'labels' | 'user-labels', id: number) {
  if (!current(stamp()) || !form.value || saving.value) return;
  if (type === 'products') { pickedProducts.value = pickedProducts.value.filter(row => row.id !== id); form.value.product_id = form.value.product_id.filter(value => value.product_id !== id); }
  else if (type === 'brands') { pickedBrands.value = pickedBrands.value.filter(row => row.id !== id); form.value.brand_id = form.value.brand_id.filter(value => value !== id); }
  else if (type === 'labels') { pickedLabels.value = pickedLabels.value.filter(row => row.id !== id); form.value.store_label_id = form.value.store_label_id.filter(value => value !== id); }
  else { pickedUserLabels.value = pickedUserLabels.value.filter(row => row.id !== id); form.value.label_id = form.value.label_id.filter(value => value !== id); }
}
function acknowledge() { if (!saving.value) { uncertain.value = false; saveError.value = ''; } }
function sameIds(ids: number[], rows: { id: number }[]) { return ids.length === rows.length && ids.every(id => rows.some(row => row.id === id)); }
function selectedIdentityValid(value: FullGiftInput) {
  if ([2, 3].includes(value.product_partake_type)) {
    if (!sameIds(value.product_id.map(item => item.product_id), pickedProducts.value)) return false;
    for (const choice of value.product_id) {
      const product = pickedProducts.value.find(item => item.id === choice.product_id);
      if (!product || choice.unique.some(unique => !product.attrValue.some(sku => sku.unique === unique && sku.is_retired !== 1))) return false;
    }
  }
  if (value.product_partake_type === 4 && !sameIds(value.brand_id, pickedBrands.value)) return false;
  if (value.product_partake_type === 5 && !sameIds(value.store_label_id, pickedLabels.value)) return false;
  if (labelEnabled.value && !sameIds(value.label_id, pickedUserLabels.value)) return false;
  for (let index = 0; index < value.promotions.length; index++) {
    const rule = value.promotions[index], coupons = pickedGiftCoupons.value[index] ?? [], gifts = pickedGiftProducts.value[index] ?? [];
    if (!sameIds(rule.give_coupon_id.map(item => item.give_coupon_id), coupons)) return false;
    if (coupons.some(item => item.status !== 1 || item.is_del !== 0)) return false;
    if (rule.give_product_id.length !== gifts.flatMap(item => item.attrValue).length) return false;
    for (const selection of rule.give_product_id) {
      const product = gifts.find(item => item.id === selection.give_product_id);
      if (!product || !product.attrValue.some(sku => sku.unique === selection.unique && sku.is_retired !== 1)) return false;
    }
  }
  return true;
}
async function save() {
  if (!current(stamp()) || !form.value || loading.value || saving.value || uncertain.value || loadError.value) return;
  let body: FullGiftInput;
  try {
    body = normalizeFullGift(inputBody());
    if (!selectedIdentityValid(body)) throw Error('商品规格、品牌、标签、赠券或赠品身份已变化，请重新选择后保存');
    validateGiftCapacity(body);
  }
  catch (reason) { saveError.value = reason instanceof Error ? reason.message : '满送活动配置无效'; return; }
  const id = discountId.value, value = stamp(), generation = formGeneration, requestId = ++saveRequest, controller = new AbortController(); saveAbort = controller; saving.value = true; saveError.value = '';
  try {
    await apiFullGiftSave(id, { ...body, request_id: crypto.randomUUID(), ...(id ? { revision: revision.value } : {}) }, controller.signal);
    if (!current(value) || generation !== formGeneration || requestId !== saveRequest) return;
    ElMessage.success('满送活动已保存'); void router.push('/marketing/full-gifts');
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
.full-gifts-form { min-width: 0; }.heading { margin-bottom: 14px; }.heading h2 { font-size: 18px; margin: 7px 0 0; }.notice { margin-bottom: 12px; }.hint { color: #737985; font-size: 12px; line-height: 1.6; margin: 7px 0; }.el-form-item p.hint { flex-basis: 100%; }.unit { margin: 0 10px; }.sku-choices { display: flex; flex-wrap: wrap; gap: 6px 14px; }.scope-choice { display: flex; flex-wrap: wrap; gap: 8px 18px; }.scope-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 16px 0; }.product { display: flex; align-items: center; gap: 9px; }.product :deep(.el-image) { width: 40px; height: 40px; flex: 0 0 40px; }.selected-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }.footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; margin-top: 24px; }.picker-search { display: flex; gap: 8px; margin-bottom: 12px; }.picker-search :deep(.el-input) { flex: 1; }.table-scroll { overflow-x: auto; }.pagination { display: flex; justify-content: flex-end; margin-top: 12px; }.rules { width: 100%; }.rule { border: 1px solid var(--el-border-color-light); border-radius: 6px; padding: 12px; margin: 0 0 12px; }.rule-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }.rule-fields { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.rule-fields :deep(.el-input-number) { width: 140px; }.gift-field, .gift-block { margin-top: 14px; }.gift-block { border-top: 1px solid var(--el-border-color-light); padding-top: 12px; }.gift-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 10px 0; }.gift-line > span:first-child { min-width: 200px; overflow-wrap: anywhere; }.gift-line :deep(.el-input-number) { width: 128px; }
@media (max-width: 700px) {
  .picker-search { flex-wrap: wrap; }.pagination { justify-content: center; }
  .rule-fields :deep(.el-input-number) { width: min(150px, calc(50vw - 55px)); }
  .gift-line > span:first-child { min-width: 100%; }
  :deep(.el-date-editor.el-range-editor) { width: 100%; height: auto; min-height: 86px; display: grid; grid-template-columns: 16px minmax(0, 1fr) 16px; grid-template-rows: 24px 18px 24px; }
  :deep(.el-range__icon) { grid-column: 1; grid-row: 1; }
  :deep(.el-range-input) { width: 100%; min-width: 0; grid-column: 2; font-size: 12px; }
  :deep(.el-range-input:first-of-type) { grid-row: 1; }
  :deep(.el-range-input:last-of-type) { grid-row: 3; }
  :deep(.el-range-separator) { width: 100%; grid-column: 2; grid-row: 2; line-height: 18px; }
  :deep(.el-range__close-icon) { grid-column: 3; grid-row: 1; }
  :global(.full-gift-date-popper.el-popper) { box-sizing: border-box; width: calc(100vw - 16px) !important; max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); overflow-x: hidden; overflow-y: auto; }
  :global(.full-gift-date-popper .el-date-range-picker) { box-sizing: border-box; width: 100% !important; }
  :global(.full-gift-date-popper .el-picker-panel__body) { min-width: 0; }
  :global(.full-gift-date-popper .el-date-range-picker__content) { box-sizing: border-box; display: block; width: 100%; padding: 8px; }
  :global(.full-gift-date-popper .el-date-range-picker__content.is-left) { border-right: 0; border-bottom: 1px solid var(--el-border-color-light); }
  :global(.full-gift-date-popper .el-date-range-picker__time-header) { display: flex; flex-wrap: wrap; gap: 4px; }
  :global(.full-gift-date-popper .el-date-range-picker__time-header > .el-icon-arrow-right) { display: none; }
  :global(.full-gift-date-popper .el-date-range-picker__editors-wrap) { display: flex; flex: 1 1 100%; min-width: 0; }
  :global(.full-gift-date-popper .el-date-range-picker__time-picker-wrap) { display: block; flex: 1 1 50%; min-width: 0; }
  :global(.full-gift-date-popper .el-date-range-picker__time-picker-wrap .el-input) { width: 100%; }
}
</style>

