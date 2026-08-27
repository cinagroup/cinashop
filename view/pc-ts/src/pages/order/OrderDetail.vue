<template>
  <div class="order-detail container">
    <el-skeleton v-if="loading" :rows="6" animated />
    <template v-else-if="order">
      <div class="detail-card">
        <div class="detail-header">
          <h2>订单详情</h2>
          <span class="status">{{ statusText }}</span>
        </div>
        <el-descriptions :column="descriptionColumns" border>
          <el-descriptions-item label="订单号">{{ order.order_id }}</el-descriptions-item>
          <el-descriptions-item label="下单时间">{{ formatTime(order.add_time) }}</el-descriptions-item>
          <el-descriptions-item :label="order.shipping_type === 2 ? '自提联系人' : '收货人'">
            {{ order.real_name }} {{ order.user_phone }}
          </el-descriptions-item>
          <el-descriptions-item :label="order.shipping_type === 2 ? '自提门店' : '收货地址'">
            <template v-if="order.shipping_type === 2">
              {{ order.pickup_store?.name || `门店 #${order.store_id}` }}
              {{ order.pickup_store ? `${order.pickup_store.address}${order.pickup_store.detailed_address}` : "" }}
            </template>
            <template v-else>{{ order.province }}{{ order.user_address }}</template>
          </el-descriptions-item>
          <el-descriptions-item label="商品数量">{{ order.total_num }}</el-descriptions-item>
          <el-descriptions-item label="支付方式">
            {{ payTypeText }}
          </el-descriptions-item>
        </el-descriptions>
        <el-alert
          v-if="order.supplier_allocation_status === 1"
          class="allocation-alert"
          title="支付成功，正在按供应商生成履约订单"
          type="info"
          :closable="false"
          show-icon
        />
        <div
          v-if="isWriteoffPending && order.verify_code"
          class="verify-card"
        >
          <span>{{ order.delivery_type === "send" ? "送达核销码" : "到店核销码" }}</span>
          <strong>{{ formattedVerifyCode }}</strong>
          <small>仅在{{ order.delivery_type === "send" ? "配送员当面交付" : "门店工作人员确认商品" }}后出示；部分核销后旧码会立即失效。</small>
        </div>
      </div>

      <div v-if="virtualItems.length || virtualText" class="detail-card virtual-delivery-card">
        <div class="virtual-heading">
          <div>
            <h3>虚拟商品交付</h3>
            <small>卡密仅在当前订单详情展示，请妥善保管</small>
          </div>
          <el-tag type="success">已自动发放</el-tag>
        </div>
        <div v-if="virtualText" class="virtual-secret">
          <span>{{ virtualText }}</span>
          <el-button size="small" @click="copySecret(virtualText)">复制</el-button>
        </div>
        <div v-for="(item, index) in virtualItems" :key="`${item.sku_unique ?? 'virtual'}-${index}`" class="virtual-item">
          <template v-if="item.disk_info">
            <span class="virtual-index">密钥 {{ index + 1 }}</span>
            <code>{{ item.disk_info }}</code>
            <el-button size="small" @click="copySecret(item.disk_info)">复制</el-button>
          </template>
          <template v-else>
            <span class="virtual-index">卡密 {{ index + 1 }}</span>
            <span><small>卡号</small><code>{{ item.card_no }}</code></span>
            <span><small>密码</small><code>{{ item.card_pwd }}</code></span>
            <el-button size="small" @click="copySecret(`${item.card_no ?? ''}\n${item.card_pwd ?? ''}`)">复制</el-button>
          </template>
        </div>
      </div>

      <div v-if="order.split_orders?.length" class="detail-card">
        <div class="package-heading">
          <h3>履约包裹</h3>
          <el-tag type="info">{{ order.split_orders.length }} 个订单</el-tag>
        </div>
        <button
          v-for="item in order.split_orders"
          :key="item.id"
          class="package-card"
          type="button"
          @click="router.push(`/order/${item.order_id}`)"
        >
          <span class="package-main">
            <strong>{{ item.order_id }}</strong>
            <small>{{ item.total_num }} 件 · {{ packageStatus(item.status) }}</small>
          </span>
          <span class="package-price">¥{{ item.pay_price }}</span>
          <span class="package-arrow">›</span>
        </button>
      </div>

      <div class="detail-card">
        <h3>商品清单</h3>
        <div v-for="ci in order.cart_info" :key="ci.id" class="cart-line">
          <img v-if="ci.cart_info?.product" :src="ci.cart_info.product.image" class="thumb" />
          <span class="cart-name">{{ ci.cart_info?.product?.storeName }}</span>
          <span class="cart-price">¥{{ ci.cart_info?.sku?.price }}</span>
          <span class="cart-num">x{{ ci.cart_num }}</span>
        </div>
      </div>

      <div class="detail-card">
        <div class="amount-row">
          <span>商品金额</span>
          <span>¥{{ order.total_price }}</span>
        </div>
        <div class="amount-row total-row">
          <span>实付金额</span>
          <span class="price">¥{{ order.pay_price }}</span>
        </div>
      </div>

      <div v-if="order.paid === 0 && cashier" class="detail-card cashier-card">
        <div class="cashier-heading">
          <div>
            <h3>选择支付方式</h3>
            <small>余额 ¥{{ cashier.now_money }} · 积分 {{ cashier.integral }}</small>
          </div>
          <span v-if="cashier.pay_integral" class="integral-cost">需 {{ cashier.pay_integral }} 积分</span>
        </div>
        <el-alert
          v-if="!cashier.payable"
          :title="cashier.payable_reason"
          type="warning"
          :closable="false"
          show-icon
        />
        <div class="payment-grid">
          <button
            v-for="method in paymentOptions"
            :key="method.value"
            type="button"
            class="payment-option"
            :class="{ active: payType === method.value, disabled: !method.enabled }"
            :disabled="!method.enabled"
            @click="payType = method.value"
          >
            <strong>{{ method.label }}</strong>
            <small>{{ method.enabled ? method.detail : method.reason }}</small>
          </button>
        </div>
      </div>

      <div v-if="order.paid === 0" class="pay-bar">
        <el-button
          type="primary"
          size="large"
          :loading="paying"
          :disabled="!cashier?.payable || (!cashier?.zero_pay && !selectedMethodEnabled)"
          @click="pay"
        >
          {{ payButtonText }}
        </el-button>
      </div>
      <div
        v-else-if="order.pid !== -1 && order.supplier_allocation_status !== 1"
        class="pay-bar"
      >
        <el-button v-if="order.status === 1 && order.shipping_type !== 2 && order.delivery_type !== 'send'" type="primary" size="large" @click="take">
          确认收货
        </el-button>
        <el-button v-if="[0, 5].includes(order.status)" size="large" @click="goRefund">
          申请退款
        </el-button>
        <el-button v-if="order.status === 2" type="primary" size="large" @click="reviewVisible = true">
          评价订单
        </el-button>
      </div>
    </template>
    <el-empty v-else description="订单不存在" />

    <el-dialog v-model="reviewVisible" title="评价订单" width="min(520px, 92vw)" destroy-on-close>
      <div v-if="order" class="review-products">
        <div v-for="item in order.cart_info" :key="item.id" class="review-product">
          <img v-if="item.cart_info?.product" :src="item.cart_info.product.image" alt="" />
          <span>{{ item.cart_info?.product?.storeName || "商品" }}</span>
        </div>
      </div>

      <div v-if="customForm.length" class="detail-card">
        <h3>补充信息</h3>
        <div v-for="(item, index) in customForm" :key="String(item.id ?? index)" class="form-snapshot-row">
          <span class="form-snapshot-label">{{ formTitle(item, index) }}</span>
          <div v-if="formImages(item).length" class="form-snapshot-images">
            <el-image
              v-for="image in formImages(item)"
              :key="image"
              :src="image"
              :preview-src-list="formImages(item)"
              fit="cover"
            />
          </div>
          <span v-else class="form-snapshot-value">{{ formValue(item.value) }}</span>
        </div>
      </div>
      <el-form label-position="top">
        <el-form-item label="商品质量"><el-rate v-model="reviewForm.productScore" /></el-form-item>
        <el-form-item label="服务态度"><el-rate v-model="reviewForm.serviceScore" /></el-form-item>
        <el-form-item label="物流速度"><el-rate v-model="reviewForm.logisticsScore" /></el-form-item>
        <el-form-item label="评价内容">
          <el-input
            v-model="reviewForm.comment"
            type="textarea"
            :rows="4"
            :maxlength="512"
            show-word-limit
            placeholder="分享你的购物体验，帮助更多买家"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="primary" :loading="reviewing" @click="submitReview">提交评价</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="qrVisible" title="微信扫码支付" width="360px" @closed="stopPaymentPolling">
      <div class="wechat-qr">
        <canvas ref="qrCanvas" />
        <strong>¥{{ cashier?.pay_price ?? order?.pay_price }}</strong>
        <span>请使用微信扫一扫完成付款</span>
      </div>
      <template #footer>
        <el-button @click="qrVisible = false">稍后支付</el-button>
        <el-button type="primary" @click="confirmExternalPayment">我已完成支付</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import QRCode from "qrcode";
import { apiOrderCashier, apiOrderDetail, apiOrderPay, apiOrderTake } from "@/api/order";
import { apiReplySubmit } from "@/api/product";
import type {
  CheckoutCashier,
  CheckoutPaymentMethod,
  CheckoutPaymentResult,
  OrderInfo,
} from "@/types/order";
import type { SystemFormComponent } from "@/types/systemForm";
import dayjs from "dayjs";

const route = useRoute();
const router = useRouter();
const order = ref<OrderInfo | null>(null);
const cashier = ref<CheckoutCashier | null>(null);
const loading = ref(true);
const paying = ref(false);
const payType = ref<CheckoutPaymentMethod>("yue");
const qrVisible = ref(false);
const qrCanvas = ref<HTMLCanvasElement | null>(null);
let paymentPollingToken = 0;
const reviewing = ref(false);
const reviewVisible = ref(false);
const reviewForm = ref({
  productScore: 5,
  serviceScore: 5,
  logisticsScore: 5,
  comment: "",
});
const descriptionColumns = ref(window.innerWidth <= 768 ? 1 : 2);
const customForm = computed(() => order.value?.custom_form ?? []);
const virtualItems = computed(() =>
  Array.isArray(order.value?.virtual_info) ? order.value.virtual_info : [],
);
const virtualText = computed(() =>
  typeof order.value?.virtual_info === "string" ? order.value.virtual_info : "",
);
const isWriteoffPending = computed(() => Boolean(
  order.value?.paid === 1 &&
  (
    (order.value.shipping_type === 2 && [0, 5].includes(order.value.status)) ||
    (order.value.delivery_type === "send" && [1, 5].includes(order.value.status))
  ),
));

const paymentLabels: Record<CheckoutPaymentMethod, string> = {
  yue: "余额支付",
  weixin: "微信支付",
  alipay: "支付宝",
  offline: "线下支付",
};

const paymentOptions = computed(() => {
  if (!cashier.value) return [];
  return (["yue", "weixin", "alipay", "offline"] as CheckoutPaymentMethod[]).map((value) => ({
    value,
    label: paymentLabels[value],
    enabled: cashier.value!.methods[value].enabled,
    reason: cashier.value!.methods[value].reason,
    detail: value === "yue" ? `可用 ¥${cashier.value!.now_money}` : "立即发起支付",
  }));
});

const selectedMethodEnabled = computed(
  () => Boolean(cashier.value?.methods[payType.value]?.enabled),
);

const payButtonText = computed(() => {
  if (cashier.value?.zero_pay) return "确认支付";
  return `${paymentLabels[payType.value]} ¥${cashier.value?.pay_price ?? order.value?.pay_price ?? "0.00"}`;
});

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

function syncDescriptionColumns() {
  descriptionColumns.value = window.innerWidth <= 768 ? 1 : 2;
}

const statusText = computed(() => {
  if (!order.value) return "";
  if (order.value.paid === 0) return "待支付";
  if (order.value.type === 3 && order.value.pink_status === 1) return "拼团中";
  if (order.value.type === 3 && order.value.pink_status === 3) return "拼团失败，退款处理中";
  if (order.value.supplier_allocation_status === 1) return "订单分配中";
  if (order.value.pid === -1) return `已拆分为 ${order.value.split_orders?.length ?? 0} 个履约订单`;
  if (order.value.delivery_type === "fictitious" && order.value.status >= 1) return "卡密已发放";
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

const formattedVerifyCode = computed(() =>
  (order.value?.verify_code ?? "").replace(/(\d{4})(?=\d)/g, "$1 "),
);

function packageStatus(status: number): string {
  return ["待发货", "待收货", "已收货", "已完成"][status] ?? "处理中";
}

const payTypeText = computed(() => {
  switch (order.value?.pay_type) {
    case "yue": return "余额支付";
    case "weixin": return "微信支付";
    case "alipay": return "支付宝";
    case "offline": return "线下支付";
    default: return "未支付";
  }
});

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

async function pay() {
  if (!order.value || !cashier.value || !cashier.value.payable) return;
  const method = cashier.value.zero_pay ? "yue" : payType.value;
  if (!cashier.value.zero_pay && !selectedMethodEnabled.value) return;
  try {
    await ElMessageBox.confirm(
      `确认使用${paymentLabels[method]}支付 ¥${order.value.pay_price}?`,
      "支付确认",
    );
  } catch {
    return;
  }
  paying.value = true;
  try {
    const result = await apiOrderPay(order.value.order_id, method, "pc");
    await handlePaymentResult(result);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "支付失败");
  } finally {
    paying.value = false;
  }
}

async function take() {
  if (!order.value) return;
  await apiOrderTake(order.value.order_id);
  ElMessage.success("已确认收货");
  load();
}

function goRefund() {
  if (!order.value) return;
  router.push(`/refund/${order.value.order_id}`);
}

async function copySecret(value: string) {
  const secret = value.trim();
  if (!secret) return;
  try {
    await navigator.clipboard.writeText(secret);
    ElMessage.success("已复制");
  } catch {
    ElMessage.error("复制失败，请手动选择");
  }
}

async function handlePaymentResult(result: CheckoutPaymentResult) {
  if (result.paid) {
    ElMessage.success("支付成功");
    await load();
    return;
  }
  if (result.pay_type === "alipay" && result.payUrl) {
    window.location.assign(result.payUrl);
    return;
  }
  if (result.pay_type === "weixin" && result.jsConfig) {
    const codeUrl = typeof result.jsConfig.code_url === "string" ? result.jsConfig.code_url : "";
    const h5Url = typeof result.jsConfig.h5_url === "string" ? result.jsConfig.h5_url : "";
    if (h5Url) {
      window.location.assign(h5Url);
      return;
    }
    if (!codeUrl) throw new Error("微信支付二维码创建失败");
    qrVisible.value = true;
    await nextTick();
    if (!qrCanvas.value) throw new Error("微信支付二维码画布不可用");
    await QRCode.toCanvas(qrCanvas.value, codeUrl, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    void pollExternalPayment(++paymentPollingToken);
    return;
  }
  if (result.offline) {
    ElMessage.info("已提交线下支付，请等待商家确认");
    await load();
    return;
  }
  throw new Error("支付下单结果无效");
}

async function pollExternalPayment(token: number) {
  for (let attempt = 0; attempt < 30 && token === paymentPollingToken; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (token !== paymentPollingToken || !order.value) return;
    try {
      const latest = await apiOrderDetail(order.value.order_id);
      if (latest.paid === 1) {
        order.value = latest;
        qrVisible.value = false;
        ElMessage.success("支付成功");
        await load();
        return;
      }
    } catch {
      // 短暂网络错误不终止二维码有效期内的状态确认。
    }
  }
}

function stopPaymentPolling() {
  paymentPollingToken += 1;
}

async function confirmExternalPayment() {
  if (!order.value) return;
  const latest = await apiOrderDetail(order.value.order_id);
  if (latest.paid !== 1) {
    ElMessage.warning("暂未收到支付结果，请稍后再试");
    return;
  }
  order.value = latest;
  qrVisible.value = false;
  ElMessage.success("支付成功");
  await load();
}

async function submitReview() {
  if (!order.value || reviewing.value) return;
  const comment = reviewForm.value.comment.trim();
  if (!comment) return ElMessage.warning("请填写评价内容");
  const items = order.value.cart_info ?? [];
  if (!items.length || items.some((item) => !item.unique)) {
    return ElMessage.error("订单商品快照不完整，无法评价");
  }
  reviewing.value = true;
  try {
    for (const item of items) {
      await apiReplySubmit({
        unique: item.unique,
        comment,
        productScore: reviewForm.value.productScore,
        serviceScore: reviewForm.value.serviceScore,
        logisticsScore: reviewForm.value.logisticsScore,
      });
    }
    ElMessage.success("评价成功，感谢你的反馈");
    reviewVisible.value = false;
    reviewForm.value.comment = "";
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "评价失败");
  } finally {
    reviewing.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    order.value = await apiOrderDetail(String(route.params.orderId));
    cashier.value = order.value.paid === 0
      ? await apiOrderCashier(order.value.order_id)
      : null;
    const firstEnabled = paymentOptions.value.find((item) => item.enabled);
    if (firstEnabled) payType.value = firstEnabled.value;
  } catch (e) {
    console.error("订单加载失败", e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => route.params.orderId,
  () => load(),
  { immediate: true },
);

onMounted(() => window.addEventListener("resize", syncDescriptionColumns));
onBeforeUnmount(() => {
  stopPaymentPolling();
  window.removeEventListener("resize", syncDescriptionColumns);
});
</script>

<style scoped>
.container {
  padding-top: 20px;
}

.detail-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.allocation-alert {
  margin-top: 16px;
}

.verify-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 20px;
  border: 1px dashed #e64340;
  border-radius: 10px;
  background: #fff7f6;
}

.verify-card strong {
  color: #e64340;
  font-size: 30px;
  letter-spacing: 3px;
}

.verify-card small {
  color: #777;
}

.package-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.package-heading h3 {
  margin: 0;
}

.virtual-delivery-card {
  border: 1px solid #d9ecff;
  background: linear-gradient(135deg, #f4faff, #fff);
}

.virtual-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.virtual-heading h3 {
  margin: 0 0 5px;
}

.virtual-heading small,
.virtual-item small {
  color: #909399;
}

.virtual-item,
.virtual-secret {
  display: grid;
  grid-template-columns: minmax(70px, auto) minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid #e8f3fb;
}

.virtual-secret {
  grid-template-columns: minmax(0, 1fr) auto;
}

.virtual-item > span:not(.virtual-index) {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.virtual-item code,
.virtual-secret span {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.virtual-index {
  color: #409eff;
  font-weight: 600;
}

.package-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid #ebeef5;
  border-radius: 10px;
  background: #fafafa;
  padding: 14px 16px;
  margin-top: 10px;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.package-card:hover,
.package-card:focus-visible {
  border-color: #e64340;
  background: #fff7f6;
  outline: none;
}

.package-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.package-main strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.package-main small {
  color: #909399;
}

.package-price {
  color: #e64340;
  font-weight: 600;
}

.package-arrow {
  color: #c0c4cc;
  font-size: 24px;
}

.status {
  color: #e64340;
  font-size: 16px;
}

.cart-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
}

.cart-name {
  flex: 1;
}

.cart-price {
  color: #e64340;
}

.cart-num {
  color: #999;
}

.form-snapshot-row {
  display: grid;
  grid-template-columns: minmax(100px, 180px) 1fr;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid #f2f3f5;
}

.form-snapshot-label {
  color: #909399;
}

.form-snapshot-value {
  min-width: 0;
  overflow-wrap: anywhere;
}

.form-snapshot-images {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.form-snapshot-images :deep(.el-image) {
  width: 80px;
  height: 80px;
  border-radius: 6px;
}

.amount-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  color: #666;
}

.total-row {
  border-top: 1px solid #f0f0f0;
  padding-top: 12px;
  font-size: 15px;
}

.price {
  color: #e64340;
  font-size: 20px;
  font-weight: 700;
}

.pay-bar {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0 40px;
}

.cashier-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.cashier-heading h3 {
  margin: 0 0 6px;
}

.cashier-heading small {
  color: #909399;
}

.integral-cost {
  color: #e6a23c;
  font-weight: 600;
}

.payment-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.payment-option {
  display: flex;
  min-height: 78px;
  flex-direction: column;
  justify-content: center;
  gap: 7px;
  padding: 12px;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  color: #303133;
  background: #fff;
  cursor: pointer;
}

.payment-option small {
  color: #909399;
}

.payment-option.active {
  border-color: #e64340;
  color: #e64340;
  background: #fff7f6;
}

.payment-option.disabled {
  cursor: not-allowed;
  opacity: .55;
}

.wechat-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.wechat-qr strong {
  color: #e64340;
  font-size: 24px;
}

.wechat-qr span {
  color: #606266;
}

.review-products {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.review-product {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: #606266;
}

.review-product img {
  width: 42px;
  height: 42px;
  border-radius: 6px;
  object-fit: cover;
}

.review-product span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .container {
    padding-inline: 12px;
  }

  .detail-card {
    padding: 16px;
  }

  .detail-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  :deep(.el-descriptions__content) {
    word-break: break-all;
  }

  .form-snapshot-row {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .virtual-item {
    grid-template-columns: 1fr auto;
  }

  .payment-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .virtual-item > span:not(.virtual-index),
  .virtual-item code {
    grid-column: 1 / -1;
  }
}
</style>
