<template>
  <div class="checkout container">
    <h2 class="title">确认订单</h2>
    <el-alert v-if="selectionError" :title="selectionError" type="error" :closable="false" show-icon />
    <el-button v-if="selectionError" @click="loadCheckout">重新加载结算信息</el-button>
    <el-skeleton v-if="checkoutLoading" :rows="3" animated />

    <fieldset class="checkout-controls" :disabled="checkoutLoading || !!pendingSubmission">
    <section class="section">
      <h3 class="section-title">配送方式</h3>
      <el-alert
        v-if="includesSecondCard"
        title="订单包含次卡商品，仅支持门店自提；支付后按订单有效期到店核销。"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-radio-group v-else v-model="shippingType">
        <el-radio-button :value="1">快递配送</el-radio-button>
        <el-radio-button :value="2">门店自提</el-radio-button>
      </el-radio-group>
      <div v-if="shippingType === 2" class="store-list">
        <button
          v-for="store in pickupStores"
          :key="store.id"
          type="button"
          class="store-card"
          :class="{ selected: selectedStoreId === store.id }"
          @click="selectedStoreId = store.id"
        >
          <strong>{{ store.name }}</strong>
          <span>{{ store.address }}{{ store.detailed_address }}</span>
          <small>{{ store.day_time || store.valid_time || "营业时间以门店通知为准" }}</small>
        </button>
        <el-empty v-if="!pickupStores.length" description="暂无营业中的自提门店" />
      </div>
    </section>

    <!-- 收货地址 -->
    <section v-if="shippingType === 1" class="section">
      <h3 class="section-title">收货地址</h3>
      <div class="address-list">
        <button
          v-for="addr in addresses"
          :key="addr.id"
          class="address-card"
          type="button"
          :aria-pressed="selectedAddrId === addr.id"
          :class="{ selected: selectedAddrId === addr.id }"
          @click="selectedAddrId = addr.id"
        >
          <div class="addr-top">
            <span class="name">{{ addr.real_name }}</span>
            <span class="phone">{{ addr.phone }}</span>
            <el-tag v-if="addr.is_default" size="small" type="danger">默认</el-tag>
          </div>
          <div class="addr-detail">
            {{ addr.province }}{{ addr.city }}{{ addr.district }}{{ addr.detail }}
          </div>
        </button>
      </div>
      <el-button size="small" @click="showAddressDialog = true">+ 新增地址</el-button>
    </section>

    <section v-else class="section">
      <h3 class="section-title">自提联系人</h3>
      <el-form label-width="90px" class="pickup-contact">
        <el-form-item label="联系人"><el-input v-model="pickupContact.realName" maxlength="32" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="pickupContact.phone" maxlength="18" /></el-form-item>
      </el-form>
    </section>

    <!-- 商品清单 -->
    <section class="section">
      <h3 class="section-title">商品清单</h3>
      <el-table :data="displayItems" class="checkout-desktop-items">
        <el-table-column label="商品">
          <template #default="{ row }">
            <div class="product-cell">
              <img v-if="row.productInfo" :src="row.productInfo.image" class="thumb" />
              <span>{{ row.productInfo?.storeName }}<small class="checkout-sku">{{ row.productInfo?.suk }}</small></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="商品单价" width="120">
          <template #default="{ row }">
            <span v-if="quoteReady">¥{{ row.productInfo?.price }}<small v-if="row.quotedUnitPrice !== row.productInfo?.price" class="checkout-sku">优惠价 ¥{{ row.quotedUnitPrice }}</small></span>
            <span v-else>待报价</span>
          </template>
        </el-table-column>
        <el-table-column prop="cartNum" label="数量" width="80" />
        <el-table-column label="优惠前小计" width="120">
          <template #default="{ row }">{{ quoteReady ? `¥${row.sumPrice}` : '待报价' }}</template>
        </el-table-column>
      </el-table>
      <ul class="checkout-mobile-items" aria-label="结算商品">
        <li v-for="item in displayItems" :key="item.id">
          <div class="product-cell">
            <img v-if="item.productInfo" :src="item.productInfo.image" alt="" class="thumb" />
            <span>{{ item.productInfo?.storeName }}<small class="checkout-sku">{{ item.productInfo?.suk }}</small></span>
          </div>
          <dl>
            <div><dt>商品单价</dt><dd>{{ quoteReady ? `¥${item.productInfo?.price}` : '待报价' }}</dd></div>
            <div v-if="quoteReady && 'quotedUnitPrice' in item && item.quotedUnitPrice !== item.productInfo?.price"><dt>优惠单价</dt><dd>¥{{ item.quotedUnitPrice }}</dd></div>
            <div><dt>数量</dt><dd>{{ item.cartNum }}</dd></div>
            <div><dt>优惠前小计</dt><dd>{{ quoteReady ? `¥${item.sumPrice}` : '待报价' }}</dd></div>
          </dl>
        </li>
      </ul>
      <el-checkbox v-if="checkoutItems.length && checkoutItems.every(item => item.type === 0)" v-model="useIntegral">使用积分抵扣（可用额度由系统计算）</el-checkbox>
    </section>

    <section class="section" aria-label="结算优惠券">
      <h3 class="section-title">优惠券</h3>
      <p v-if="activityOptions.type !== 0">当前活动订单不叠加普通优惠券。</p>
      <template v-else>
        <p>以下优惠券已按当前商品和配送方式筛选；选择和提交时仍由服务端重新校验。首单优惠优先且不与优惠券叠加。</p>
        <el-button :disabled="!!pendingSubmission" @click="selectedCouponId = 0">不使用优惠券</el-button>
        <el-button :disabled="!couponContext.scope || couponState.loading || !!pendingSubmission" @click="refreshCoupons">刷新优惠券</el-button>
        <p v-if="couponState.loading" role="status">正在加载优惠券…</p>
        <el-alert v-if="couponContext.error" :title="couponContext.error" type="error" :closable="false" show-icon />
        <el-alert v-if="couponState.error" :title="couponState.error" type="error" :closable="false" show-icon />
        <el-button v-if="couponState.error" :disabled="!!pendingSubmission" @click="retryCoupons">重试加载优惠券</el-button>
        <CouponCards :coupons="couponState.list" selectable :selected-id="selectedCouponId" :disabled="couponState.loading || !!pendingSubmission" @select="selectCoupon" />
        <p v-if="pendingSubmission">提交内容已锁定，确认结果前不能更换优惠券。</p>
        <p v-if="!pendingSubmission && couponContext.scope && !couponState.loading && !couponState.error && !couponState.list.length">{{ couponState.nextCursor !== null ? '本页暂无适用优惠券，可继续查找。' : '当前订单暂无可用优惠券（可能受首单优惠或适用范围限制）。' }}</p>
        <el-button v-if="couponState.nextCursor !== null" :disabled="couponState.loading || !!pendingSubmission" @click="loadMoreCoupons">{{ couponState.list.length ? '加载更多适用券' : '继续查找可用优惠券' }}</el-button>
        <el-alert v-if="selectedCouponId && quoteReady && quoteState.result?.prices.couponDiscount === '0.00'" title="所选优惠券本次未产生抵扣，请核对首单互斥及费用明细，也可取消或重选。" type="warning" :closable="false" show-icon />
      </template>
    </section>

    <SystemFormFields
      v-if="customForm.length"
      :key="formRevision"
      v-model="customForm"
      :title="systemFormName"
      :disabled="checkoutLoading || !!pendingSubmission"
      @pending-change="pendingUploads = $event"
    />
    <el-alert v-if="!checkoutLoading && formValidationError" :title="formValidationError" type="warning" :closable="false" show-icon />
    <p v-if="pendingUploads" role="status">图片正在上传，完成前无法提交订单。</p>
    </fieldset>

    <section class="section quote-section" aria-live="polite" :aria-busy="quoteState.loading">
      <h3 class="section-title">费用明细</h3>
      <p v-if="quoteState.loading">正在计算最新报价，完成前无法提交订单…</p>
      <el-alert v-else-if="deliveryError || quoteState.error" :title="deliveryError || quoteState.error" type="error" :closable="false" show-icon />
      <el-button v-if="quoteState.error && !pendingSubmission" @click="renewQuote">重新获取报价</el-button>
      <el-button v-if="addressError || storeError" :disabled="!!pendingSubmission" @click="loadCheckout">重试配送信息</el-button>
      <dl v-if="quoteReady && quoteState.result" class="quote-prices">
        <div><dt>商品金额</dt><dd>¥{{ quoteState.result.prices.subtotal }}</dd></div>
        <div v-if="quoteState.result.prices.memberDiscount !== '0.00'"><dt>会员优惠</dt><dd>-¥{{ quoteState.result.prices.memberDiscount }}</dd></div>
        <div v-if="quoteState.result.prices.firstOrderDiscount !== '0.00'"><dt>首单优惠（不与优惠券叠加）</dt><dd>-¥{{ quoteState.result.prices.firstOrderDiscount }}</dd></div>
        <div v-if="quoteState.result.prices.couponDiscount !== '0.00'"><dt>优惠券</dt><dd>-¥{{ quoteState.result.prices.couponDiscount }}</dd></div>
        <div v-if="quoteState.result.prices.integralDiscount !== '0.00'"><dt>积分抵扣（{{ quoteState.result.prices.usedIntegral }} 积分）</dt><dd>-¥{{ quoteState.result.prices.integralDiscount }}</dd></div>
        <div><dt>运费</dt><dd>¥{{ quoteState.result.prices.postage }}</dd></div>
        <div v-if="quoteState.result.prices.postageDiscount !== '0.00'"><dt>运费优惠</dt><dd>-¥{{ quoteState.result.prices.postageDiscount }}</dd></div>
        <div class="quote-payable"><dt>应付金额</dt><dd>¥{{ quoteState.result.prices.payable }}</dd></div>
      </dl>
    </section>

    <!-- 备注 + 提交 -->
    <section class="section submit-section">
      <div class="remark-row">
        <span>订单备注:</span>
        <el-input v-model="remark" placeholder="选填" class="remark-input" :disabled="!!pendingSubmission" />
      </div>
      <el-alert v-if="submissionError" :title="submissionError" :description="pendingSubmission ? '结果尚未确认；重试会复用相同订单标识和提交内容，不会自动发起付款。' : '服务端已明确拒绝本次表单且未完成建单；请修改后重新提交。'" type="error" :closable="false" show-icon />
      <el-button v-if="submissionError && !pendingSubmission" :disabled="checkoutLoading" @click="loadCheckout">重新加载结算要求</el-button>
      <div class="submit-row">
        <span class="total">
          应付: <span class="price">{{ quoteReady ? `¥${quoteState.result?.prices.payable}` : '待报价' }}</span>
        </span>
        <el-button type="primary" size="large" :loading="submitting" :disabled="!canSubmit" @click="submitOrder">
          {{ pendingSubmission ? '重试确认订单' : '提交订单' }}
        </el-button>
      </div>
    </section>

    <!-- 新增地址弹窗 -->
    <el-dialog v-model="showAddressDialog" title="新增地址" width="min(480px, calc(100vw - 24px))">
      <el-form :model="addrForm" label-width="80px">
        <el-form-item label="收货人"><el-input v-model="addrForm.realName" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="addrForm.phone" /></el-form-item>
        <el-form-item label="省市区">
          <el-input v-model="addrForm.region" placeholder="如: 北京市 朝阳区" />
        </el-form-item>
        <el-form-item label="详细地址"><el-input v-model="addrForm.detail" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddressDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingAddress" @click="saveAddress">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useCartStore } from "@/stores/cart";
import { apiDirectCartList } from "@/api/cart";
import { parseCheckoutSelection } from "@/api/productPurchase";
import { CheckoutQuoteSession, checkoutQuoteFingerprint, type CheckoutQuoteOptions, type CheckoutQuoteState } from "@/api/checkoutQuote";
import {
  apiAddressList,
  apiAddressSave,
  apiOrderConfirm,
  apiOrderComputed,
  apiOrderCreate,
  apiOrderCoupons,
  apiOrderSystemForm,
  apiPickupStores,
} from "@/api/order";
import type { CartItem, PickupStore, UserAddress } from "@/types/order";
import type { SystemFormComponent } from "@/types/systemForm";
import SystemFormFields from "@/components/SystemFormFields.vue";
import { prepareOrderSystemFormSubmission } from "../../../../common/order-system-form";
import { canEditRejectedOrder } from "@/utils/apiError";
import { OrderCouponSession, orderCouponScope, type OrderCouponState } from "@/api/orderCoupons";
import CouponCards from "@/components/CouponCards.vue";

const router = useRouter();
const route = useRoute();
const cartStore = useCartStore();

const addresses = ref<UserAddress[]>([]);
const selectedAddrId = ref(0);
const shippingType = ref<1 | 2>(1);
const pickupStores = ref<PickupStore[]>([]);
const selectedStoreId = ref(0);
const pickupContact = ref({ realName: "", phone: "" });
const remark = ref("");
const submitting = ref(false);
const showAddressDialog = ref(false);
const addrForm = ref({ realName: "", phone: "", region: "", detail: "" });
const customForm = ref<SystemFormComponent[]>([]);
const systemFormName = ref("");
const systemFormError = ref("");
const formRevision = ref(0);
const pendingUploads = ref(0);
const formValidationError = computed(() => {
  if (!customForm.value.length) return "";
  try { prepareOrderSystemFormSubmission(customForm.value, customForm.value, 0); return ""; }
  catch (error) { return error instanceof Error ? error.message : "请检查补充信息"; }
});
const selectedItems = ref<CartItem[]>([]);
const selectionError = ref("");
const checkoutLoading = ref(true);
const loadedRoute = ref("");
const orderKey = ref("");
const addressError = ref("");
const storeError = ref("");
const useIntegral = ref(false);
const selectedCouponId = ref(0);
const couponState = shallowRef<OrderCouponState>({ list: [], nextCursor: null, fingerprint: "", loading: false, error: "" });
const couponPicker = new OrderCouponSession(apiOrderCoupons, (next) => { couponState.value = next; });
const savingAddress = ref(false);
const submissionError = ref("");
const submissionUncertain = ref(false);
const pendingSubmission = shallowRef<Parameters<typeof apiOrderCreate>[1] | null>(null);
const activityOptions = ref<Pick<CheckoutQuoteOptions, "type" | "pinkId" | "combinationId" | "seckillId" | "bargainUserId">>({ type: 0 });
const checkoutItems = computed(() => checkoutLoading.value || selectionError.value || loadedRoute.value !== route.fullPath
  ? [] : selectedItems.value);
const includesSecondCard = computed(() => checkoutItems.value.some(
  (item) => item.productInfo?.productType === 4,
));
const couponContext = computed(() => {
  if (!checkoutItems.value.length || activityOptions.value.type !== 0) return { scope: null, error: "" };
  try { return { scope: orderCouponScope(checkoutItems.value, shippingType.value, selectedStoreId.value), error: "" }; }
  catch (error) { return { scope: null, error: error instanceof Error ? error.message : "订单筛券范围无效" }; }
});
const quoteOptions = computed<CheckoutQuoteOptions>(() => ({
  ...activityOptions.value,
  addressId: shippingType.value === 1 ? selectedAddrId.value : 0,
  shippingType: shippingType.value,
  storeId: shippingType.value === 2 ? selectedStoreId.value : 0,
  couponId: activityOptions.value.type === 0 ? selectedCouponId.value : 0,
  useIntegral: useIntegral.value,
}));
const deliveryError = computed(() => checkoutLoading.value || selectionError.value ? "" : shippingType.value === 1
  ? addressError.value || (!addresses.value.some((item) => item.id === selectedAddrId.value) ? "请选择收货地址后获取完整报价" : "")
  : storeError.value || (!pickupStores.value.some((item) => item.id === selectedStoreId.value) ? "请选择自提门店后获取报价" : ""));
const quoteState = shallowRef<CheckoutQuoteState>({ loading: false, error: "", fingerprint: "", result: null });
const quoteSession = new CheckoutQuoteSession({ confirm: apiOrderConfirm, computed: apiOrderComputed }, (state) => { quoteState.value = state; });
const quoteReady = computed(() => !checkoutLoading.value && !selectionError.value && !deliveryError.value
  && !quoteState.value.loading && !!quoteState.value.result
  && quoteState.value.fingerprint === checkoutQuoteFingerprint(checkoutItems.value, quoteOptions.value));
const displayItems = computed(() => quoteReady.value ? quoteState.value.result!.items : checkoutItems.value);
const canSubmit = computed(() => quoteReady.value && !systemFormError.value && !formValidationError.value
  && pendingUploads.value === 0 && !submitting.value && !savingAddress.value);

function selectCoupon(id: number) {
  if (pendingSubmission.value || couponState.value.loading || couponState.value.fingerprint !== couponContext.value.scope?.fingerprint
    || !couponState.value.list.some((coupon) => coupon.id === id && coupon.availability === "available")) return;
  selectedCouponId.value = id;
}
function refreshCoupons() {
  if (pendingSubmission.value) return;
  const refreshUnselectedQuote = selectedCouponId.value === 0;
  selectedCouponId.value = 0;
  const scope = couponContext.value.scope;
  if (scope) void couponPicker.load(scope);
  // Refresh account/first-order pricing too, even when setting couponId=0 does not trigger the option watcher.
  if (refreshUnselectedQuote) void reloadQuote();
}
function loadMoreCoupons() {
  const scope = couponContext.value.scope;
  if (scope && !pendingSubmission.value) void couponPicker.load(scope, true);
}
function retryCoupons() {
  if (couponState.value.nextCursor !== null) loadMoreCoupons();
  else refreshCoupons();
}

async function reloadQuote() {
  if (pendingSubmission.value) return;
  if (checkoutLoading.value || savingAddress.value || selectionError.value || systemFormError.value || deliveryError.value || !checkoutItems.value.length) {
    quoteSession.invalidate();
    return;
  }
  await quoteSession.load(checkoutItems.value, quoteOptions.value);
}
function renewQuote() {
  if (pendingSubmission.value) return;
  quoteSession.reset();
  void reloadQuote();
}

function choiceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidate = record.val ?? record.value ?? record.label;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
}

function initializeComponent(item: SystemFormComponent): SystemFormComponent {
  let value = item.value;
  const hasValue = Array.isArray(value) ? value.length > 0 : String(value ?? "").trim().length > 0;
  if (!hasValue && item.name === "texts") value = item.defaultValConfig?.value ?? "";
  else if (!hasValue && item.name === "radios") value = choiceText(item.wordsConfig?.list?.[0]);
  else if (item.name === "uploadPicture" || item.name === "dateranges") value = hasValue && Array.isArray(value) ? value : [];
  else if (!hasValue) value = "";
  return { ...item, value };
}

async function loadSystemForm(items: CartItem[], generation: number) {
  formRevision.value++;
  pendingUploads.value = 0;
  const ids = [...new Set(items
    .map((item) => Number(item.productInfo?.systemFormId ?? 0))
    .filter((id) => id > 0))];
  customForm.value = [];
  systemFormName.value = "";
  systemFormError.value = ids.length > 1 ? "同一订单不能包含不同的自定义表单" : "";
  if (systemFormError.value) { selectionError.value = systemFormError.value; return; }
  if (!ids[0]) return;
  try {
    const form = await apiOrderSystemForm(ids[0]);
    if (generation !== checkoutGeneration) return;
    systemFormName.value = form.name;
    customForm.value = form.value.map(initializeComponent);
  } catch (error) {
    if (generation !== checkoutGeneration) return;
    systemFormError.value = error instanceof Error ? error.message : "系统表单加载失败";
    selectionError.value = systemFormError.value;
  }
}

async function loadAddresses(generation: number) {
  try {
    const rows = await apiAddressList();
    if (generation !== checkoutGeneration) return;
    addresses.value = rows;
    addressError.value = "";
    const def = addresses.value.find((a) => a.is_default);
    selectedAddrId.value = def?.id ?? addresses.value[0]?.id ?? 0;
    const contact = def ?? addresses.value[0];
    if (contact && !pickupContact.value.realName && !pickupContact.value.phone) {
      pickupContact.value = { realName: contact.real_name, phone: contact.phone };
    }
  } catch (error) {
    if (generation !== checkoutGeneration) return;
    addresses.value = [];
    selectedAddrId.value = 0;
    addressError.value = error instanceof Error ? error.message : "收货地址加载失败";
  }
}

async function loadPickupStores(generation: number) {
  try {
    const rows = await apiPickupStores();
    if (generation !== checkoutGeneration) return;
    pickupStores.value = rows;
    storeError.value = "";
    selectedStoreId.value = pickupStores.value[0]?.id ?? 0;
  } catch (error) {
    if (generation !== checkoutGeneration) return;
    pickupStores.value = [];
    selectedStoreId.value = 0;
    storeError.value = error instanceof Error ? error.message : "自提门店加载失败";
  }
}

async function saveAddress() {
  if (savingAddress.value || pendingSubmission.value) return;
  const generation = checkoutGeneration;
  const f = addrForm.value;
  if (!f.realName || !f.phone || !f.detail) return ElMessage.error("请填写完整地址信息");
  const [province = "", city = "", district = ""] = f.region.split(/\s+/);
  savingAddress.value = true;
  quoteSession.invalidate();
  try {
    const saved = await apiAddressSave({ real_name: f.realName, phone: f.phone, province, city, district, detail: f.detail });
    if (generation !== checkoutGeneration) return;
    showAddressDialog.value = false;
    ElMessage.success("地址已保存");
    await loadAddresses(generation);
    if (generation !== checkoutGeneration) return;
    if (addresses.value.some((item) => item.id === saved.id)) selectedAddrId.value = saved.id;
  } catch (error) {
    if (generation === checkoutGeneration) ElMessage.error(error instanceof Error ? error.message : "地址保存失败");
  } finally {
    if (generation === checkoutGeneration) { savingAddress.value = false; await reloadQuote(); }
  }
}

async function submitOrder() {
  if (!canSubmit.value || loadedRoute.value !== route.fullPath) return;
  const addr = addresses.value.find((a) => a.id === selectedAddrId.value);
  if (shippingType.value === 1 && !addr) return ElMessage.error("请选择收货地址");
  if (shippingType.value === 2 && !selectedStoreId.value) return ElMessage.error("请选择自提门店");
  if (
    shippingType.value === 2
    && (!pickupContact.value.realName.trim() || !pickupContact.value.phone.trim())
  ) {
    return ElMessage.error("请填写自提联系人和手机号");
  }

  const items = checkoutItems.value;
  if (!items.length) return ElMessage.error("请选择商品");
  if (systemFormError.value) return ElMessage.error(systemFormError.value);

  submitting.value = true;
  submissionError.value = "";
  const generation = checkoutGeneration;
  try {
    if (!pendingSubmission.value) {
      orderKey.value = quoteState.value.result!.key;
      // Freeze the same address/options as the accepted quote. Never send a client total or payType.
      pendingSubmission.value = JSON.parse(JSON.stringify({
        ...quoteOptions.value,
        cartIds: items.map((i) => i.id),
        ...(shippingType.value === 2 ? { realName: pickupContact.value.realName.trim(), userPhone: pickupContact.value.phone.trim() } : {}),
        mark: remark.value,
        customForm: customForm.value,
      }));
    }
    const result = await apiOrderCreate(orderKey.value, pendingSubmission.value!);
    if (generation !== checkoutGeneration) return;
    ElMessage.success("订单创建成功");
    // A badge/list refresh failure must not turn a successful order into a failed submission.
    await cartStore.fetchList().catch(() => {});
    if (generation === checkoutGeneration) await router.push(`/order/${result.orderId}`);
  } catch (e) {
    if (generation !== checkoutGeneration) return;
    submissionError.value = e instanceof Error ? e.message : "下单结果未确认";
    if (canEditRejectedOrder(e, orderKey.value, submissionUncertain.value)) {
      pendingSubmission.value = null;
      quoteSession.invalidate();
      await reloadQuote();
    } else {
      // Even a later explicit rejection cannot settle an earlier transport timeout.
      submissionUncertain.value = true;
    }
  } finally {
    if (generation === checkoutGeneration) submitting.value = false;
  }
}

let checkoutGeneration = 0;
async function loadCheckout() {
  const generation = ++checkoutGeneration;
  quoteSession.reset();
  checkoutLoading.value = true;
  selectionError.value = "";
  selectedItems.value = [];
  pendingSubmission.value = null;
  submissionUncertain.value = false;
  pendingUploads.value = 0;
  submissionError.value = "";
  submitting.value = false;
  savingAddress.value = false;
  addressError.value = "";
  storeError.value = "";
  systemFormError.value = "";
  showAddressDialog.value = false;
  useIntegral.value = false;
  selectedCouponId.value = 0;
  couponPicker.reset();
  customForm.value = [];
  orderKey.value = "";
  try {
    const requested = parseCheckoutSelection(route.query);
    let rows: CartItem[];
    if (requested.mode === "buy") {
      rows = await apiDirectCartList(requested.ids);
      if (generation !== checkoutGeneration) return;
      if (!Array.isArray(rows) || rows.length !== requested.ids.length || new Set(rows.map((item) => item.id)).size !== rows.length
        || rows.some((item) => !requested.ids.includes(item.id) || item.isNew !== 1 || !item.isValid || !item.productInfo)) {
        throw new Error("立即购买商品不完整或已失效，请重新选择");
      }
    } else {
      await cartStore.fetchList();
      rows = cartStore.checkedItems.filter((item) => item.isValid);
    }
    if (generation !== checkoutGeneration) return;
    if (!rows.length) throw new Error("请选择要结算的商品");
    const type = rows[0].type;
    if (rows.some((item) => item.type !== type)) throw new Error("不同活动的商品请分开结算");
    const activity: typeof activityOptions.value = { type };
    for (const name of ["type", "pinkId", "combinationId", "seckillId", "bargainUserId"] as const) {
      const value = route.query[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("活动结算参数无效");
      if (name === "type" && Number(value) !== type) throw new Error("活动类型与结算商品不匹配");
      activity[name] = Number(value);
    }
    activityOptions.value = activity;
    selectedItems.value = rows;
    loadedRoute.value = route.fullPath;
    shippingType.value = rows.some((item) => item.productInfo?.productType === 4) ? 2 : 1;
    await Promise.all([loadAddresses(generation), loadPickupStores(generation), loadSystemForm(rows, generation)]);
  } catch (error) {
    if (generation === checkoutGeneration) selectionError.value = error instanceof Error ? error.message : "结算商品加载失败";
  } finally {
    if (generation === checkoutGeneration) { checkoutLoading.value = false; await reloadQuote(); }
  }
}
// Clear the selected coupon before repricing a changed cart/delivery scope. No stale page can restore it.
watch(() => couponContext.value.scope?.fingerprint ?? "", () => {
  if (pendingSubmission.value) { couponPicker.pause(); return; }
  selectedCouponId.value = 0;
  couponPicker.reset();
  if (couponContext.value.scope) void couponPicker.load(couponContext.value.scope);
}, { flush: "sync" });
watch(pendingSubmission, (pending) => { if (pending) couponPicker.pause(); }, { flush: "sync" });
watch(quoteOptions, () => { void reloadQuote(); }, { flush: "sync" });
watch(() => route.fullPath, loadCheckout, { immediate: true, flush: "sync" });
onUnmounted(() => { checkoutGeneration++; quoteSession.reset(); couponPicker.reset(); });
</script>

<style scoped>
.checkout-controls { border: 0; padding: 0; margin: 0; min-width: 0; }
.checkout-mobile-items { display: none; list-style: none; padding: 0; margin: 0 0 12px; }
.checkout-mobile-items li + li { border-top: 1px solid #eee; padding-top: 14px; margin-top: 14px; }
.checkout-mobile-items dl { margin: 12px 0 0; }
.checkout-mobile-items dl > div { display: flex; justify-content: space-between; gap: 12px; margin: 6px 0; }
.checkout-mobile-items dd { margin: 0; }
.quote-prices { width: min(100%, 430px); margin: 0 0 0 auto; }
.quote-prices > div { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; }
.quote-prices dd { margin: 0; flex-shrink: 0; }
.quote-payable { border-top: 1px solid #eee; color: #d93025; font-weight: 600; }
.quote-section > .el-button { margin-top: 12px; }
.title {
  font-size: 20px;
  margin: 20px 0;
}

.section {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}

.section-title {
  font-size: 16px;
  margin-bottom: 16px;
}

.address-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}

.first-order-summary {
  display: flex;
  justify-content: flex-end;
  gap: 16px;
  margin-top: 16px;
  color: #666;
}

.first-order-summary strong {
  color: #e64340;
}

.store-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.store-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  padding: 14px;
  cursor: pointer;
}

.store-card.selected {
  border-color: #e64340;
  box-shadow: 0 0 0 1px #e64340;
}

.store-card span,
.store-card small {
  color: #666;
}

.pickup-contact {
  max-width: 520px;
}

.address-card {
  text-align: left;
  background: white;
  color: inherit;
  font: inherit;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.2s;
}

.address-card.selected {
  border-color: #e64340;
}

.addr-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.name {
  font-weight: 600;
}

.phone {
  color: #999;
}

.addr-detail {
  font-size: 13px;
  color: #666;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
}

.checkout-sku { display: block; color: #777; margin-top: 4px; }

.submit-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.remark-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.remark-input {
  max-width: 400px;
}

.submit-row {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 20px;
}

.price {
  color: #e64340;
  font-size: 24px;
  font-weight: 700;
}
@media (max-width: 900px) {
  .address-list, .store-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .checkout-desktop-items { display: none; }
  .checkout-mobile-items { display: block; }
  .checkout-mobile-items .product-cell > span { min-width: 0; overflow-wrap: anywhere; }
  .checkout-mobile-items .thumb { flex-shrink: 0; }
  .section { padding: 14px; }
  .address-list, .store-list { grid-template-columns: minmax(0, 1fr); }
  .addr-top, .submit-row, .remark-row { flex-wrap: wrap; }
  .quote-prices { font-size: 13px; }
}
</style>
