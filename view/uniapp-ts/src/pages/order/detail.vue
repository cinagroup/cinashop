<template>
  <view v-if="loading" class="empty">正在加载订单...</view>
  <view class="order-detail" v-else-if="order">
    <!-- 状态 -->
    <view class="status-card">
      <text class="status-text">{{ statusText }}</text>
      <text class="status-sub">{{ statusSub }}</text>
    </view>

    <view v-if="order.split_orders?.length" class="section">
      <view class="package-heading">
        <text class="package-title">履约包裹</text>
        <text class="package-count">{{ order.split_orders.length }} 个订单</text>
      </view>
      <view
        v-for="item in order.split_orders"
        :key="item.id"
        class="package-card"
        @tap="goPackage(item.order_id)"
      >
        <view class="package-main">
          <text class="package-id">{{ item.order_id }}</text>
          <text class="package-meta">{{ item.total_num }} 件 · {{ packageStatus(item.status) }}</text>
        </view>
        <text class="package-price">¥{{ item.pay_price }}</text>
        <text class="package-arrow">›</text>
      </view>
    </view>

    <!-- 订单信息 -->
    <view class="section">
      <view class="info-row"><text class="label">订单号</text><text>{{ order.order_id }}</text></view>
      <view class="info-row"><text class="label">下单时间</text><text>{{ formatTime(order.add_time) }}</text></view>
      <view class="info-row"><text class="label">{{ order.shipping_type === 2 ? "自提联系人" : "收货人" }}</text><text>{{ order.real_name }} {{ order.user_phone }}</text></view>
      <view class="info-row"><text class="label">{{ order.shipping_type === 2 ? "自提门店" : "收货地址" }}</text><text>{{ order.shipping_type === 2 ? (order.pickup_store?.name || "门店 #" + order.store_id) + " " + (order.pickup_store ? order.pickup_store.address + order.pickup_store.detailed_address : "") : order.province + order.user_address }}</text></view>
    </view>

    <view
      v-if="isWriteoffPending && order.verify_code"
      class="section verify-card"
    >
      <text class="verify-label">{{ order.delivery_type === "send" ? "送达核销码" : "到店核销码" }}</text>
      <text class="verify-code">{{ formattedVerifyCode }}</text>
      <text class="verify-tip">仅在{{ order.delivery_type === "send" ? "配送员当面交付" : "门店工作人员确认商品" }}后出示；部分核销后旧码会立即失效。</text>
    </view>

    <view v-if="virtualItems.length || virtualText" class="section virtual-delivery-card">
      <view class="virtual-heading">
        <view>
          <text class="virtual-title">虚拟商品交付</text>
          <text class="virtual-tip">{{ isManualVirtualDelivery ? "以下内容由履约人员交付，请及时保存" : "卡密仅在当前订单详情展示，请妥善保管" }}</text>
        </view>
        <text class="virtual-status">{{ isManualVirtualDelivery ? "已人工交付" : "已自动发放" }}</text>
      </view>
      <view v-if="virtualText" class="virtual-secret" @tap="copyVirtual(virtualText)">
        <text>{{ virtualText }}</text>
        <text class="copy-action">复制</text>
      </view>
      <view
        v-for="(item, index) in virtualItems"
        :key="`${item.sku_unique ?? 'virtual'}-${index}`"
        class="virtual-item"
      >
        <text class="virtual-index">{{ item.disk_info ? "密钥" : "卡密" }} {{ index + 1 }}</text>
        <template v-if="item.disk_info">
          <text class="virtual-value">{{ item.disk_info }}</text>
          <text class="copy-action" @tap="copyVirtual(item.disk_info)">复制</text>
        </template>
        <template v-else>
          <view class="virtual-field"><text>卡号</text><text>{{ item.card_no }}</text></view>
          <view class="virtual-field"><text>密码</text><text>{{ item.card_pwd }}</text></view>
          <text class="copy-action" @tap="copyVirtual(`${item.card_no ?? ''}\n${item.card_pwd ?? ''}`)">复制</text>
        </template>
      </view>
      <view
        v-if="order.product_type === 1 && order.refund_eligibility && !order.refund_eligibility.allowed"
        class="refund-policy-warning"
      >
        {{ order.refund_eligibility.reason }}
      </view>
    </view>

    <view v-if="secondCardLines.length" class="section second-card-panel">
      <view class="second-card-heading">
        <text class="second-card-title">次卡权益</text>
        <text class="second-card-remaining">{{ secondCardRemaining > 0 ? `剩余 ${secondCardRemaining} 次` : "已全部核销" }}</text>
      </view>
      <view v-for="item in secondCardLines" :key="item.id" class="second-card-line">
        <view>
          <text class="second-card-name">{{ item.cart_info?.product?.storeName || "次卡商品" }}</text>
          <text class="second-card-validity">{{ secondCardValidityText(item) }}</text>
        </view>
        <text>已核销 {{ item.write_times - item.write_surplus_times }} / {{ item.write_times }} 次</text>
      </view>
    </view>

    <!-- 商品 -->
    <view class="section">
      <view class="cart-line" v-for="ci in order.cart_info" :key="ci.id">
        <image
          v-if="ci.cart_info?.product"
          class="cart-image"
          :src="ci.cart_info.product.image"
          mode="aspectFill"
        />
        <view class="cart-info">
          <view class="cart-name">{{ ci.cart_info?.product?.storeName }}</view>
          <view class="cart-bottom">
            <text class="cart-price">¥{{ ci.cart_info?.sku?.price }}</text>
            <text class="cart-num">x{{ ci.cart_num }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="customForm.length" class="section">
      <view class="form-title">补充信息</view>
      <view v-for="(item, index) in customForm" :key="String(item.id ?? index)" class="form-snapshot-row">
        <text class="form-snapshot-label">{{ formTitle(item, index) }}</text>
        <view v-if="formImages(item).length" class="form-snapshot-images">
          <image
            v-for="image in formImages(item)"
            :key="image"
            class="form-snapshot-image"
            :src="assetUrl(image)"
            mode="aspectFill"
            @tap="previewFormImage(image, formImages(item))"
          />
        </view>
        <text v-else class="form-snapshot-value">{{ formValue(item.value) }}</text>
      </view>
    </view>

    <!-- 金额 -->
    <view class="section">
      <view class="amount-row"><text>商品金额</text><text>¥{{ order.total_price }}</text></view>
      <view v-if="cashier?.pay_integral" class="amount-row"><text>所需积分</text><text>{{ cashier.pay_integral }} 积分</text></view>
      <view class="amount-row total-row"><text>实付</text><text class="amount-price">¥{{ order.pay_price }}</text></view>
    </view>

    <view v-if="order.paid === 0 && cashier" class="section cashier-card">
      <view class="cashier-title">选择支付方式</view>
      <view class="cashier-balance">余额 ¥{{ cashier.now_money }} · 积分 {{ cashier.integral }}</view>
      <view v-if="!cashier.payable" class="cashier-warning">{{ cashier.payable_reason }}</view>
      <view
        v-for="method in paymentOptions"
        :key="method.value"
        class="payment-row"
        :class="{ active: payType === method.value, disabled: !method.enabled }"
        @tap="selectPayment(method.value, method.enabled)"
      >
        <view>
          <text class="payment-name">{{ method.label }}</text>
          <text v-if="method.detail" class="payment-detail">{{ method.detail }}</text>
        </view>
        <text>{{ method.enabled ? (payType === method.value ? "✓" : "○") : method.reason }}</text>
      </view>
    </view>

    <view v-if="cashierError || actionError" class="section" role="alert">
      <text>{{ cashierError || actionError }}</text>
      <button :disabled="paying" @tap="load">刷新订单核对</button>
    </view>
    <!-- 支付按钮 -->
    <view v-if="order.paid === 0" class="pay-bar">
      <view
        class="pay-btn"
        :class="{ disabled: paying || !!actionError || !cashier?.payable || (!cashier?.zero_pay && !selectedMethodEnabled) }"
        :aria-disabled="paying || !!actionError || !cashier?.payable || (!cashier?.zero_pay && !selectedMethodEnabled)"
        @tap="pay"
      >
        {{ payButtonText }}
      </view>
    </view>

    <!-- 物流入口 (已发货) -->
    <view v-if="canOperate && order.delivery_type === 'express' && order.status >= 1" class="express-link" @tap="goExpress">
      <text>📍 查看物流</text>
      <text class="arrow">›</text>
    </view>

    <!-- 评价入口 (已签收) -->
    <view v-if="canOperate && order.status === 2" class="express-link" @tap="goReply">
      <text>✍️ 评价订单</text>
      <text class="arrow">›</text>
    </view>

    <!-- 退款入口 (已支付未收货) -->
    <view v-if="canApplyRefund" class="express-link" @tap="goRefund">
      <text>↩️ 申请退款</text>
      <text class="arrow">›</text>
    </view>
    <view class="express-link" @tap="goRefundList">
      <text>📋 退款记录</text>
      <text class="arrow">›</text>
    </view>
  </view>
  <view v-else class="empty" role="alert">
    <text>{{ loadError || '暂无订单信息，请重新加载' }}</text>
    <button @tap="load">重新加载订单</button>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { apiOrderCashier, apiOrderDetail, apiOrderPay } from "@/api/order";
import type {
  CheckoutCashier,
  CheckoutPaymentMethod,
  CheckoutPaymentResult,
  OrderInfo,
} from "@/types/order";
import type { SystemFormComponent } from "@/types/systemForm";
import { API_BASE, getFormType } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";
import { orderDetailId, orderDetailHashId, assertOrderDetailIdentity, assertOrderCashierIdentity, assertOrderPaymentIdentity } from "../../../../common/orderDetailIdentity";

// Route parameters are validated in onLoad; do not forward them onto fragment roots.
defineOptions({ inheritAttrs: false });
const authStore = useAuthStore();
const loading = ref(false), loadError = ref(''), cashierError = ref(''), actionError = ref('');
let currentOrderId = '', revision = 0, disposed = false, visible = false, paymentAttempt = 0;
const order = ref<OrderInfo | null>(null);
const cashier = ref<CheckoutCashier | null>(null);
const payType = ref<CheckoutPaymentMethod>("yue");
const paying = ref(false);
const customForm = computed(() => order.value?.custom_form ?? []);
const virtualItems = computed(() =>
  order.value?.product_type === 1 && Array.isArray(order.value.virtual_info) ? order.value.virtual_info : [],
);
const isManualVirtualDelivery = computed(() => Boolean(
  order.value?.product_type === 3 && order.value.delivery_type === "fictitious" && order.value.status >= 1,
));
const virtualText = computed(() =>
  isManualVirtualDelivery.value
    ? order.value?.fictitious_content ?? ""
    : order.value?.product_type === 1 && typeof order.value.virtual_info === "string"
      ? order.value.virtual_info
      : "",
);
const isWriteoffPending = computed(() => Boolean(
  order.value?.paid === 1 &&
  (
    (order.value.shipping_type === 2 && [0, 5].includes(order.value.status)) ||
    (order.value.delivery_type === "send" && [1, 5].includes(order.value.status))
  ),
));
const secondCardLines = computed(() => (order.value?.cart_info ?? []).filter(
  (item) => item.product_type === 4,
));
const secondCardRemaining = computed(() => secondCardLines.value.reduce(
  (total, item) => total + Math.max(0, item.write_surplus_times),
  0,
));

function secondCardValidityText(item: NonNullable<OrderInfo["cart_info"]>[number]): string {
  if (!item.write_start && !item.write_end) return "永久有效";
  return `有效期：${formatTime(item.write_start)} 至 ${formatTime(item.write_end)}`;
}

function formTitle(item: SystemFormComponent, index: number): string {
  return item.titleConfig?.value || `表单项 ${index + 1}`;
}

function formImages(item: SystemFormComponent): string[] {
  return item.name === "uploadPicture" && Array.isArray(item.value) ? item.value.map(String) : [];
}

function formValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(" - ") || "-";
  return String(value ?? "").trim() || "-";
}

function assetUrl(value: string): string {
  return value.startsWith("/") ? `${API_BASE}${value}` : value;
}

function previewFormImage(current: string, images: string[]) {
  if (!order.value || !currentView().current()) return;
  uni.previewImage({ current: assetUrl(current), urls: images.map(assetUrl) });
}

function copyVirtual(value: string) {
  const scope = currentView();
  if (!order.value || !scope.current()) return;
  const data = value.trim();
  if (!data) return;
  uni.setClipboardData({
    data,
    success: () => { if (scope.current()) uni.showToast({ title: "已复制", icon: "success" }); },
  });
}

const statusText = computed(() => {
  if (!order.value) return "";
  if (order.value.paid === 0) return "待支付";
  if (order.value.type === 3 && order.value.pink_status === 1) return "拼团中";
  if (order.value.type === 3 && order.value.pink_status === 3) return "拼团失败，退款处理中";
  if (order.value.supplier_allocation_status === 1) return "订单分配中";
  if (order.value.pid === -1) return `已拆分为 ${order.value.split_orders?.length ?? 0} 个履约订单`;
  if (order.value.delivery_type === "fictitious" && order.value.status >= 1) {
    return order.value.product_type === 3 ? "虚拟商品已交付" : "卡密已发放";
  }
  if (order.value.shipping_type === 2 && order.value.status === 0) return "待到店核销";
  if (order.value.shipping_type === 2 && order.value.status === 5) return "部分核销";
  if (order.value.delivery_type === "send" && order.value.status === 1) return "配送中，待送达核销";
  if (order.value.delivery_type === "send" && order.value.status === 5) return "部分送达核销";
  switch (order.value.status) {
    case 0: return "待发货";
    case 1: return "待收货";
    case 2: return "已收货";
    case 3: return "已完成";
    default: return "未知";
  }
});

const statusSub = computed(() => {
  if (!order.value?.paid) return "请尽快完成支付";
  if (order.value.type === 3 && order.value.pink_status === 1) return "等待其他成员支付，成团后才能发货";
  if (order.value.type === 3 && order.value.pink_status === 3) return "系统会按原支付方式自动退款";
  if (order.value.supplier_allocation_status === 1) return "正在生成各供应商履约订单，请稍后刷新";
  if (order.value.pid === -1) return "可进入下方包裹分别查看物流与售后";
  if (order.value.delivery_type === "fictitious" && order.value.status >= 1) {
    return order.value.product_type === 3
      ? "交付内容已显示在订单详情，请及时保存"
      : "卡密已发送到订单详情，请及时保存";
  }
  if (order.value.shipping_type === 2 && [0, 5].includes(order.value.status)) {
    return "到店后向工作人员出示核销码";
  }
  if (order.value.delivery_type === "send" && [1, 5].includes(order.value.status)) {
    return "配送员当面交付商品后再出示核销码";
  }
  return "感谢您的购买";
});

const formattedVerifyCode = computed(() =>
  (order.value?.verify_code ?? "").replace(/(\d{4})(?=\d)/g, "$1 "),
);

const canOperate = computed(
  () =>
    order.value?.paid === 1 &&
    (order.value.type !== 3 || order.value.pink_status === 2) &&
    order.value.pid !== -1 &&
    order.value.supplier_allocation_status !== 1,
);
const canApplyRefund = computed(() => {
  const current = order.value;
  if (!current || !canOperate.value || current.refund_status !== 0) return false;
  if (current.product_type === 1) {
    return Boolean(current.refund_eligibility?.allowed) && [0, 1, 5].includes(current.status);
  }
  return [0, 1, 5].includes(current.status);
});

const paymentLabels: Record<CheckoutPaymentMethod, string> = {
  yue: "余额支付",
  weixin: "微信支付",
  alipay: "支付宝",
  offline: "线下支付",
};

const paymentOptions = computed(() => {
  if (!cashier.value) return [];
  return (["yue", "weixin", "alipay", "offline"] as CheckoutPaymentMethod[]).map((value) => {
    const platformSupported = value !== "alipay" || getFormType() === "h5";
    return {
      value,
      label: paymentLabels[value],
      enabled: platformSupported && cashier.value!.methods[value].enabled,
      reason: platformSupported
        ? cashier.value!.methods[value].reason
        : "当前端不支持支付宝 H5 支付",
      detail: value === "yue" ? `可用余额 ¥${cashier.value!.now_money}` : "",
    };
  });
});

const selectedMethodEnabled = computed(
  () => Boolean(paymentOptions.value.find((method) => method.value === payType.value)?.enabled),
);

const payButtonText = computed(() => {
  if (paying.value) return "正在发起支付...";
  if (cashier.value?.zero_pay) return "确认支付";
  return `${paymentLabels[payType.value]} ¥${cashier.value?.pay_price ?? order.value?.pay_price ?? "0.00"}`;
});

function selectPayment(method: CheckoutPaymentMethod, enabled: boolean) {
  if (enabled && !paying.value && !actionError.value && currentView().current()) payType.value = method;
}

function packageStatus(status: number): string {
  return ["待发货", "待收货", "已收货", "已完成"][status] ?? "处理中";
}

function goPackage(orderId: string) {
  if (!order.value?.split_orders?.some(item => item.order_id === orderId) || !currentView().current()) return;
  try { uni.navigateTo({ url: `/pages/order/detail?orderId=${orderDetailId(orderId)}` }); }
  catch { uni.showToast({ title: '包裹订单链接无效', icon: 'none' }); }
}

function formatTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function pay() {
  if (!order.value || !cashier.value || paying.value || loading.value || actionError.value || !cashier.value.payable) return;
  const scope = currentView(), method = cashier.value.zero_pay ? 'yue' : payType.value;
  if (!scope.current()) return;
  if (!cashier.value.zero_pay && !selectedMethodEnabled.value) {
    uni.showToast({ title: cashier.value.methods[payType.value].reason || "支付方式不可用", icon: "none" });
    return;
  }
  paying.value = true;
  const attempt = ++paymentAttempt;
  try {
    const result = await apiOrderPay(
      scope.id,
      method,
      paymentChannel(),
    );
    if (!scope.current()) return;
    assertOrderPaymentIdentity(result, scope.id, method);
    if (result.paid) return showPaidResult(scope);
    if (await continueExternalPayment(result, scope)) return;
    if (!scope.current()) return;
    if (result.offline) {
      uni.showToast({ title: "已提交线下支付，请等待确认", icon: "none" });
      await load();
      return;
    }
    if (await waitForPaid(scope)) showPaidResult(scope);
    else if (scope.current()) actionError.value = '支付结果确认中，请刷新订单核对后再操作';
  } catch (e) {
    if (scope.current()) actionError.value = `支付结果尚未确认，请刷新订单核对后再操作。${errorText(e)}`;
  } finally {
    // Native payment can hide this page. Keep its lock until that attempt settles,
    // without letting an older account's callback unlock a newer attempt.
    if (attempt === paymentAttempt) paying.value = false;
  }
}

function paymentChannel(): string {
  const platform = getFormType();
  // #ifdef H5
  if (typeof window !== 'undefined' && /MicroMessenger/i.test(window.navigator.userAgent)) return "weixin";
  // #endif
  return platform;
}

async function continueExternalPayment(result: CheckoutPaymentResult, scope: ReturnType<typeof currentView>): Promise<boolean> {
  if (!scope.current()) return true;
  if (result.pay_type === "alipay" && result.payUrl) {
    // #ifdef H5
    window.location.assign(result.payUrl);
    // #endif
    return true;
  }
  if (result.pay_type !== "weixin" || !result.jsConfig) return false;
  const h5Url = typeof result.jsConfig.h5_url === "string" ? result.jsConfig.h5_url : "";
  if (h5Url) {
    // #ifdef H5
    window.location.assign(h5Url);
    // #endif
    return true;
  }
  const config = result.jsConfig;
  // #ifdef H5
  const bridge = (window as unknown as {
    WeixinJSBridge?: {
      invoke(
        name: string,
        config: Record<string, unknown>,
        callback: (response: { err_msg?: string }) => void,
      ): void;
    };
  }).WeixinJSBridge;
  if (!bridge) throw new Error("请在微信内打开并完成支付");
  await new Promise<void>((resolve, reject) => {
    bridge.invoke("getBrandWCPayRequest", config, (response) => {
      response.err_msg === "get_brand_wcpay_request:ok"
        ? resolve()
        : reject(new Error("微信支付未完成"));
    });
  });
  // #endif
  // #ifndef H5
  await new Promise<void>((resolve, reject) => {
    uni.requestPayment({
      provider: "wxpay",
      timeStamp: String(config.timeStamp ?? ""),
      nonceStr: String(config.nonceStr ?? ""),
      package: String(config.package ?? ""),
      signType: String(config.signType ?? "RSA") as "MD5" | "HMAC-SHA256" | "RSA",
      paySign: String(config.paySign ?? ""),
      success: () => resolve(),
      fail: (error) => reject(new Error(error.errMsg)),
    });
  });
  // #endif
  return false;
}

async function waitForPaid(scope: ReturnType<typeof currentView>): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!scope.current()) return false;
    const latest = await apiOrderDetail(scope.id);
    if (!scope.current()) return false;
    assertOrderDetailIdentity(latest, scope.id, scope.uid);
    if (latest.paid === 1) {
      order.value = latest;
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

function showPaidResult(scope: ReturnType<typeof currentView>) {
  if (!scope.current()) return;
  uni.redirectTo({
    url: `/pages/order/payResult?orderId=${scope.id}`,
    fail: () => { if (scope.current()) actionError.value = '支付结果页未打开，请刷新订单核对'; },
  });
}

function goExpress() {
  if (!order.value || !canOperate.value || !currentView().current()) return;
  uni.navigateTo({ url: `/pages/order/express?orderId=${order.value.order_id}` });
}

function goReply() {
  if (!order.value || !canOperate.value || !currentView().current()) return;
  uni.navigateTo({ url: `/pages/order/reply?orderId=${order.value.order_id}` });
}

function goRefund() {
  if (!order.value || !canApplyRefund.value || !currentView().current()) return;
  uni.navigateTo({ url: `/pages/order/refundApply?orderId=${order.value.order_id}` });
}

function goRefundList() {
  if (!order.value || !currentView().current()) return;
  uni.navigateTo({ url: "/pages/order/refundList" });
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : '读取失败，请稍后重试'; }
function currentView() {
  const version = revision, id = currentOrderId, owner = authStore.sessionVersion, uid = authStore.uid, token = authStore.token;
  return { id, uid, current: () => !disposed && visible && revision === version && currentOrderId === id
    && authStore.sessionVersion === owner && authStore.uid === uid && authStore.token === token && uid > 0 && !!token };
}
function clearView() {
  revision++; order.value = null; cashier.value = null; loading.value = false;
  loadError.value = ''; cashierError.value = ''; actionError.value = ''; payType.value = 'yue';
}
async function load() {
  if (!visible || disposed) return;
  const paymentInFlight = paying.value;
  clearView();
  const scope = currentView();
  try { orderDetailId(scope.id); } catch (error) { loadError.value = errorText(error); return; }
  if (!scope.current()) { loadError.value = '请登录后重新加载订单'; return; }
  loading.value = true;
  try {
    const latest = await apiOrderDetail(scope.id);
    if (!scope.current()) return;
    assertOrderDetailIdentity(latest, scope.id, scope.uid);
    order.value = latest;
    if (latest.paid === 0) {
      try {
        const nextCashier = await apiOrderCashier(scope.id);
        if (!scope.current()) return;
        assertOrderCashierIdentity(nextCashier, scope.id, latest.pay_price);
        cashier.value = nextCashier;
        const firstEnabled = paymentOptions.value.find((item) => item.enabled);
        if (firstEnabled) payType.value = firstEnabled.value;
      } catch (error) { if (scope.current()) cashierError.value = `收银信息读取失败，请刷新订单。${errorText(error)}`; }
    }
    if (latest.paid === 0 && paymentInFlight) actionError.value = '支付仍在处理中，请稍后刷新订单核对';
  } catch (e) {
    if (scope.current()) loadError.value = errorText(e);
  } finally { if (scope.current()) loading.value = false; }
}

function setRoute(value: unknown) {
  clearView(); currentOrderId = '';
  try { currentOrderId = orderDetailId(value); } catch (error) { loadError.value = errorText(error); }
}
function readHashRoute(): boolean {
  // #ifdef H5
  if (typeof window !== 'undefined' && window.location.hash) {
    try {
      const id = orderDetailHashId(window.location.hash);
      if (id === null) { clearView(); currentOrderId = ''; return true; }
      if (id !== currentOrderId) { setRoute(id); void load(); return true; }
    } catch (error) { clearView(); currentOrderId = ''; loadError.value = errorText(error); return true; }
  }
  // #endif
  return false;
}
function hashChanged() { if (visible && !disposed) readHashRoute(); }
watch(() => authStore.sessionVersion, () => {
  paymentAttempt++; paying.value = false; clearView(); loadError.value = '登录状态已变化，请重新加载订单';
}, { flush: 'sync' });
onLoad(options => setRoute(options?.orderId));
onShow(() => { if (disposed) return; visible = true; if (!readHashRoute()) void load(); });
onHide(() => { visible = false; clearView(); });
// #ifdef H5
if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
// #endif
onUnload(() => {
  disposed = true; visible = false; clearView();
  // #ifdef H5
  if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
  // #endif
});
</script>

<style scoped>
.order-detail {
  padding: 20rpx;
  padding-bottom: 140rpx;
}

.status-card {
  background: linear-gradient(135deg, #e93323, #ff7a45);
  border-radius: 16rpx;
  padding: 40rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.status-text {
  display: block;
  font-size: 36rpx;
  font-weight: 700;
}

.status-sub {
  display: block;
  font-size: 24rpx;
  opacity: 0.9;
  margin-top: 8rpx;
}

.section {
  background: #fff;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.second-card-panel {
  border: 2rpx solid #f3d19e;
  background: linear-gradient(135deg, #fff8ec, #fff);
}

.second-card-heading,
.second-card-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
}

.second-card-heading {
  margin-bottom: 12rpx;
}

.second-card-title,
.second-card-name {
  font-weight: 600;
}

.second-card-remaining {
  color: #d97706;
}

.second-card-line {
  padding: 18rpx 0;
  border-top: 1rpx solid #f7e7ce;
  font-size: 24rpx;
}

.second-card-line > view {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.second-card-validity {
  color: #999;
  font-size: 22rpx;
}

.cashier-card {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.cashier-title {
  font-size: 30rpx;
  font-weight: 700;
}

.cashier-balance,
.payment-detail {
  color: #888;
  font-size: 22rpx;
}

.cashier-warning {
  padding: 16rpx;
  border-radius: 10rpx;
  color: #b54708;
  background: #fff4e5;
}

.payment-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 0;
  border-top: 1rpx solid #f0f0f0;
}

.payment-row > view {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.payment-row.active {
  color: #e93323;
}

.payment-row.disabled {
  color: #aaa;
}

.payment-name {
  font-size: 28rpx;
  font-weight: 600;
}

.pay-btn.disabled {
  opacity: .5;
}

.package-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}

.package-title {
  font-size: 30rpx;
  font-weight: 600;
}

.package-count,
.package-meta {
  color: #999;
  font-size: 22rpx;
}

.package-card {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 0;
  border-top: 1rpx solid #f3f3f3;
}

.package-main {
  flex: 1;
  min-width: 0;
}

.package-id,
.package-meta {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.package-id {
  font-size: 25rpx;
  font-weight: 600;
  margin-bottom: 6rpx;
}

.package-price {
  color: #e93323;
  font-weight: 600;
}

.package-arrow {
  color: #ccc;
  font-size: 34rpx;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 12rpx 0;
  font-size: 26rpx;
}

.label {
  color: #999;
}

.cart-line {
  display: flex;
  padding: 12rpx 0;
}

.cart-image {
  width: 100rpx;
  height: 100rpx;
  border-radius: 8rpx;
  flex-shrink: 0;
}

.cart-info {
  flex: 1;
  margin-left: 16rpx;
}

.cart-name {
  font-size: 26rpx;
}

.cart-bottom {
  display: flex;
  justify-content: space-between;
  margin-top: 8rpx;
}

.cart-price {
  color: #e93323;
}

.cart-num {
  color: #999;
}

.verify-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12rpx;
  border: 2rpx dashed #e93323;
  background: #fff7f6;
}

.verify-label {
  color: #666;
  font-size: 26rpx;
}

.verify-code {
  color: #e93323;
  font-size: 44rpx;
  font-weight: 700;
  letter-spacing: 4rpx;
}

.verify-tip {
  color: #888;
  font-size: 22rpx;
  text-align: center;
}

.virtual-delivery-card {
  border: 2rpx solid #d9ecff;
  background: linear-gradient(135deg, #f4faff, #fff);
}

.virtual-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rpx;
  margin-bottom: 12rpx;
}

.virtual-title,
.virtual-tip {
  display: block;
}

.virtual-title {
  font-size: 30rpx;
  font-weight: 600;
}

.virtual-tip {
  color: #8a8f99;
  font-size: 22rpx;
  margin-top: 6rpx;
}

.virtual-status {
  flex-shrink: 0;
  padding: 6rpx 12rpx;
  border-radius: 999rpx;
  background: #e9f8ef;
  color: #2f9e5b;
  font-size: 21rpx;
}

.virtual-secret,
.virtual-item {
  padding: 18rpx 0;
  border-top: 1rpx solid #e8f3fb;
}

.virtual-secret {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}

.virtual-secret > text:first-child,
.virtual-value {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.virtual-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12rpx 16rpx;
}

.virtual-index {
  color: #2979ff;
  font-weight: 600;
}

.virtual-field {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  gap: 16rpx;
  padding: 12rpx;
  border-radius: 8rpx;
  background: rgba(255, 255, 255, 0.82);
}

.virtual-field > text:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}

.copy-action {
  color: #2979ff;
  font-size: 24rpx;
}

.refund-policy-warning {
  margin-top: 18rpx;
  padding: 18rpx 20rpx;
  border-radius: 12rpx;
  background: #fff1f0;
  color: #cf1322;
  font-size: 24rpx;
  line-height: 1.55;
}

.form-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 8rpx;
}

.form-snapshot-row {
  padding: 18rpx 0;
  border-top: 1rpx solid #f2f3f5;
}

.form-snapshot-label,
.form-snapshot-value {
  display: block;
  font-size: 26rpx;
}

.form-snapshot-label {
  color: #999;
  margin-bottom: 10rpx;
}

.form-snapshot-value {
  color: #333;
  overflow-wrap: anywhere;
}

.form-snapshot-images {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}

.form-snapshot-image {
  width: 140rpx;
  height: 140rpx;
  border-radius: 10rpx;
}

.amount-row {
  display: flex;
  justify-content: space-between;
  padding: 8rpx 0;
  color: #666;
  font-size: 26rpx;
}

.total-row {
  border-top: 1rpx solid #f5f5f5;
  padding-top: 16rpx;
}

.amount-price {
  color: #e93323;
  font-size: 32rpx;
  font-weight: 700;
}

.pay-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  padding: 20rpx 30rpx;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

.pay-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 40rpx;
  font-size: 30rpx;
}

.express-link {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-top: 20rpx;
  font-size: 28rpx;
  color: #333;
}

.express-link .arrow {
  color: #ccc;
  font-size: 32rpx;
}
</style>
