<template>
  <view class="operator-page">
    <view v-if="loadingProfile" class="state-card">正在核验履约身份…</view>

    <view v-else-if="!profile?.can_writeoff" class="state-card denied">
      <text class="state-title">当前账号没有核销权限</text>
      <text>需要启用中的门店核销员或平台配送员身份。</text>
      <text v-if="profile?.delivery_identity_conflict" class="warning">配送员身份存在重复，请联系管理员清理后再试。</text>
    </view>

    <template v-else>
      <view v-if="hasBothRoles" class="role-tabs">
        <view :class="['role-tab', { active: role === 'staff' }]" @tap="selectRole('staff')">门店核销</view>
        <view :class="['role-tab', { active: role === 'delivery' }]" @tap="selectRole('delivery')">配送送达</view>
      </view>

      <view class="identity-card">
        <text class="identity-title">{{ role === "delivery" ? "平台配送员" : "门店核销员" }}</text>
        <text v-if="role === 'delivery'">{{ profile.delivery?.nickname || "配送员" }}</text>
        <text v-else>{{ staffStoreNames }}</text>
      </view>

      <view class="scan-card">
        <text class="section-title">扫描或输入订单核销码／会员码</text>
        <input
          v-model="code"
          class="code-input"
          type="text"
          maxlength="32"
          placeholder="12位订单码或客户会员码"
          confirm-type="search"
          @confirm="preview"
        />
        <view class="scan-actions">
          <button class="secondary-button" @tap="scan">扫码</button>
          <button class="primary-button" :loading="loadingPreview" :disabled="executing || confirming" @tap="preview">查找待核销订单</button>
        </view>
      </view>

      <view v-if="memberCandidates.length" class="candidate-card">
        <text class="section-title">选择待核销订单（{{ memberCandidates.length }}）</text>
        <button v-for="item in memberCandidates" :key="item.id" class="candidate-row"
          :disabled="loadingPreview || executing || confirming" @tap="previewMember(item)">
          <text>{{ item.order_id }} · {{ item.total_num }} 件</text>
          <text>{{ item.add_time }}</text>
        </button>
      </view>

      <view v-if="previewOrder" class="preview-card">
        <view class="preview-head">
          <view>
            <text class="section-title">订单 {{ previewOrder.order_id }}</text>
            <text class="customer">{{ previewOrder.real_name }} · {{ previewOrder.user_phone }}</text>
          </view>
          <text class="mode-tag">{{ role === "delivery" ? "送达" : "到店" }}</text>
        </view>

        <view
          v-for="item in previewOrder.cart_info"
          :key="item.id"
          :class="['cart-line', { disabled: item.write_surplus_times <= 0 }]"
        >
          <view class="cart-main" @tap="toggle(item.id)">
            <text :class="['check', { checked: selected[item.id] }]">{{ selected[item.id] ? "✓" : "" }}</text>
            <view class="cart-copy">
              <text class="cart-name">{{ productName(item.cart_info) }}</text>
              <text class="cart-meta">剩余 {{ item.write_surplus_times }} / {{ item.write_times }} 次</text>
            </view>
          </view>
          <view v-if="item.write_surplus_times > 0" class="quantity">
            <button class="quantity-button" @tap.stop="changeQuantity(item.id, -1)">−</button>
            <input
              :value="quantities[item.id]"
              class="quantity-input"
              type="number"
              @input="setQuantity(item.id, item.write_surplus_times, $event)"
            />
            <button class="quantity-button" @tap.stop="changeQuantity(item.id, 1)">＋</button>
          </view>
        </view>

        <button class="execute-button" :loading="executing || confirming" :disabled="selectedQuantity <= 0 || writeUncertain" @tap="execute">
          确认{{ role === "delivery" ? "送达" : "核销" }}（{{ selectedQuantity }}）
        </button>
        <text class="irreversible">操作不可撤销；部分核销后订单码会立即失效。</text>
      </view>
      <view v-if="writeUncertain" class="state-card warning">核销结果尚待确认，请重新查单后再操作。</view>
    </template>
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onHide, onLoad, onShow, onUnload } from "@dcloudio/uni-app";
import {
  apiOperatorWriteoff,
  apiOperatorWriteoffInfo,
  apiOperatorMemberLookup,
  apiOperatorMemberInfo,
  apiOperatorMemberWriteoff,
  apiWriteoffOperatorProfile,
  type OperatorMemberOrderSummary,
  type OperatorWriteoffPreview,
  type WriteoffOperatorProfile,
} from "@/api/order";
import { useAuthStore } from "@/stores/auth";
import { operatorScanSiteOrigins, parseOperatorScanCode, parseOperatorScene } from "@/utils/operatorScanCode";

type OperatorRole = "staff" | "delivery";

const auth = useAuthStore();
const profile = ref<WriteoffOperatorProfile | null>(null);
const role = ref<OperatorRole>("staff");
const code = ref("");
const memberCandidates = ref<OperatorMemberOrderSummary[]>([]);
const previewOrder = ref<OperatorWriteoffPreview | null>(null);
const previewKind = ref<"order" | "member" | null>(null);
const quantities = ref<Record<number, number>>({});
const selected = ref<Record<number, boolean>>({});
const loadingProfile = ref(true);
const loadingPreview = ref(false);
const executing = ref(false);
const confirming = ref(false);
const writeUncertain = ref(false);
let requestedRole: OperatorRole | null = null;
let pendingCode = "";
let pendingCodeSession = -1;
let visible = false;
let generation = 0;
let profileRequestId = 0;

const hasStaffRole = computed(() => (profile.value?.staff_stores.length ?? 0) > 0);
const hasDeliveryRole = computed(() => Boolean(profile.value?.delivery));
const hasBothRoles = computed(() => hasStaffRole.value && hasDeliveryRole.value);
const staffStoreNames = computed(() =>
  profile.value?.staff_stores.map((item) => item.store_name || `门店 #${item.store_id}`).join("、") || "门店核销员",
);
const selectedQuantity = computed(() => {
  if (!previewOrder.value) return 0;
  return previewOrder.value.cart_info.reduce(
    (total, item) => total + (selected.value[item.id] ? Number(quantities.value[item.id] ?? 0) : 0),
    0,
  );
});

function toast(title: string) {
  uni.showToast({ title, icon: "none", duration: 2500 });
}

function productName(snapshot: Record<string, unknown> | null): string {
  if (!snapshot) return "商品";
  const product = snapshot.product;
  if (product && typeof product === "object" && !Array.isArray(product)) {
    const row = product as Record<string, unknown>;
    const name = row.storeName ?? row.store_name;
    if (typeof name === "string" && name) return name;
  }
  const legacy = snapshot.productInfo;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const row = legacy as Record<string, unknown>;
    const name = row.storeName ?? row.store_name;
    if (typeof name === "string" && name) return name;
  }
  return "商品";
}

function resetPreview() {
  previewOrder.value = null;
  previewKind.value = null;
  quantities.value = {};
  selected.value = {};
}

function invalidatePrivate(clearCode = false) {
  generation++;
  memberCandidates.value = [];
  resetPreview();
  loadingPreview.value = false;
  confirming.value = false;
  if (clearCode) code.value = "";
}

function current(generationAtStart: number, session: number, selectedRole: OperatorRole, scanCode: string) {
  return visible && auth.isLoggedIn && auth.sessionVersion === session
    && generation === generationAtStart && role.value === selectedRole && code.value === scanCode;
}

function acceptPreview(result: OperatorWriteoffPreview, expected: OperatorMemberOrderSummary | null, selectedRole: OperatorRole) {
  if (!result || !Number.isSafeInteger(result.id) || result.id <= 0 || !result.order_id
    || result.actor_kind !== selectedRole || (expected && (result.id !== expected.id || result.order_id !== expected.order_id))
    || !Array.isArray(result.cart_info) || !result.cart_info.length || result.cart_info.length > 500
    || new Set(result.cart_info.map((item) => item.id)).size !== result.cart_info.length
    || result.cart_info.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0
      || !Number.isSafeInteger(item.write_surplus_times) || item.write_surplus_times < 0)) {
    throw new Error("核销订单响应不完整，请重新查询");
  }
  previewOrder.value = result;
  quantities.value = Object.fromEntries(result.cart_info.map((item) => [item.id, item.write_surplus_times]));
  selected.value = Object.fromEntries(result.cart_info.map((item) => [item.id, item.write_surplus_times > 0]));
  writeUncertain.value = false;
}

function selectRole(value: OperatorRole) {
  if (value === "staff" && !hasStaffRole.value) return;
  if (value === "delivery" && !hasDeliveryRole.value) return;
  if (role.value === value) return;
  role.value = value;
  invalidatePrivate(true);
}

async function loadProfile() {
  invalidatePrivate(true);
  const requestId = ++profileRequestId;
  const session = auth.sessionVersion;
  const ownGeneration = generation;
  if (!auth.isLoggedIn) { profile.value = null; loadingProfile.value = false; return; }
  loadingProfile.value = true;
  try {
    const result = await apiWriteoffOperatorProfile();
    if (!visible || auth.sessionVersion !== session || generation !== ownGeneration) return;
    if (!result || !Array.isArray(result.staff_stores) || typeof result.can_writeoff !== "boolean") {
      throw new Error("核销身份响应无效");
    }
    profile.value = result;
    if (requestedRole === "delivery" && hasDeliveryRole.value) role.value = "delivery";
    else if (requestedRole === "staff" && hasStaffRole.value) role.value = "staff";
    else if (!hasStaffRole.value && hasDeliveryRole.value) role.value = "delivery";
    else role.value = "staff";
    if (!result.can_writeoff || pendingCodeSession !== session) pendingCode = "";
    if (pendingCode) {
      code.value = pendingCode;
      pendingCode = "";
      await preview();
    }
  } catch (error) {
    if (!visible || auth.sessionVersion !== session || generation !== ownGeneration) return;
    profile.value = null;
    pendingCode = "";
    toast(error instanceof Error ? error.message : "身份核验失败");
  } finally {
    if (visible && auth.sessionVersion === session && profileRequestId === requestId) {
      loadingProfile.value = false;
    }
  }
}

function scan() {
  if (!visible || !profile.value?.can_writeoff || executing.value || confirming.value) return;
  const session = auth.sessionVersion, selectedRole = role.value, ownGeneration = generation;
  uni.scanCode({
    scanType: ["qrCode", "barCode"],
    success: (result) => {
      if (!visible || auth.sessionVersion !== session || role.value !== selectedRole || generation !== ownGeneration) return;
      const origins = operatorScanSiteOrigins();
      const parsed = parseOperatorScanCode((result as typeof result & { path?: string }).path, origins)
        ?? parseOperatorScanCode(result.result, origins);
      if (!parsed) return toast("扫码内容没有有效的订单码或会员码");
      code.value = parsed.code;
      void preview();
    },
    fail: (error) => {
      if (visible && auth.sessionVersion === session && generation === ownGeneration
        && !String(error.errMsg ?? "").includes("cancel")) toast("当前环境无法扫码，请手动输入码");
    },
  });
}

async function preview() {
  if (!visible || !profile.value?.can_writeoff || loadingPreview.value || executing.value || confirming.value) return;
  const parsed = parseOperatorScanCode(code.value, operatorScanSiteOrigins());
  if (!parsed) return toast("请输入有效的订单码或会员码");
  code.value = parsed.code;
  const ownGeneration = ++generation, session = auth.sessionVersion, selectedRole = role.value;
  loadingPreview.value = true;
  memberCandidates.value = [];
  resetPreview();
  try {
    if (parsed.kind === "order") {
      const result = await apiOperatorWriteoffInfo(selectedRole, parsed.code);
      if (!current(ownGeneration, session, selectedRole, parsed.code)) return;
      acceptPreview(result, null, selectedRole);
      previewKind.value = "order";
    } else {
      const result = await apiOperatorMemberLookup(selectedRole, parsed.code);
      if (!current(ownGeneration, session, selectedRole, parsed.code)) return;
      const rows = result?.data;
      if (!Array.isArray(rows) || rows.length > 20
        || new Set(rows.map((row) => row.id)).size !== rows.length
        || rows.some((row) => !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.order_id !== "string" || !row.order_id)) {
        throw new Error("会员码查单响应无效");
      }
      memberCandidates.value = rows;
      if (!rows.length) toast("该会员码暂无可核销订单");
    }
  } catch (error) {
    if (current(ownGeneration, session, selectedRole, parsed.code)) toast(error instanceof Error ? error.message : "查单失败");
  } finally {
    if (current(ownGeneration, session, selectedRole, parsed.code)) loadingPreview.value = false;
  }
}

async function previewMember(item: OperatorMemberOrderSummary) {
  if (!visible || loadingPreview.value || executing.value || confirming.value
    || !memberCandidates.value.some((candidate) => candidate.id === item.id && candidate.order_id === item.order_id)) return;
  const parsed = parseOperatorScanCode(code.value, operatorScanSiteOrigins());
  if (!parsed || parsed.kind !== "member") return;
  const ownGeneration = ++generation, session = auth.sessionVersion, selectedRole = role.value;
  loadingPreview.value = true;
  resetPreview();
  try {
    const result = await apiOperatorMemberInfo(selectedRole, parsed.code, item.id);
    if (!current(ownGeneration, session, selectedRole, parsed.code)) return;
    acceptPreview(result, item, selectedRole);
    previewKind.value = "member";
  } catch (error) {
    if (current(ownGeneration, session, selectedRole, parsed.code)) toast(error instanceof Error ? error.message : "订单预览失败");
  } finally {
    if (current(ownGeneration, session, selectedRole, parsed.code)) loadingPreview.value = false;
  }
}

function toggle(id: number) {
  const item = previewOrder.value?.cart_info.find((row) => row.id === id);
  if (!item || item.write_surplus_times <= 0) return;
  selected.value = { ...selected.value, [id]: !selected.value[id] };
}

function boundedQuantity(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function setQuantity(id: number, max: number, event: Event) {
  const detail = (event as Event & { detail?: { value?: unknown } }).detail;
  quantities.value = { ...quantities.value, [id]: boundedQuantity(Number(detail?.value ?? 1), max) };
}

function changeQuantity(id: number, delta: number) {
  const item = previewOrder.value?.cart_info.find((row) => row.id === id);
  if (!item) return;
  quantities.value = {
    ...quantities.value,
    [id]: boundedQuantity(Number(quantities.value[id] ?? 1) + delta, item.write_surplus_times),
  };
}

function confirmExecute(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      uni.showModal({
        title: "确认核销",
        content: `确认本次核销 ${selectedQuantity.value} 次？操作不可撤销。`,
        confirmText: "确认核销",
        success: (result) => resolve(Boolean(result.confirm)),
        fail: () => resolve(false),
      });
    } catch { resolve(false); }
  });
}

async function execute() {
  if (!visible || !previewOrder.value || !previewKind.value || selectedQuantity.value <= 0
    || executing.value || confirming.value || writeUncertain.value) return;
  const preview = previewOrder.value, kind = previewKind.value, selectedRole = role.value;
  const scannedCode = code.value, session = auth.sessionVersion, ownGeneration = generation;
  const items = preview.cart_info
    .filter((item) => selected.value[item.id] && Number(quantities.value[item.id] ?? 0) > 0)
    .map((item) => ({ order_cart_id: item.id, quantity: Number(quantities.value[item.id]) }));
  if (!items.length || items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity <= 0
    || item.quantity > (preview.cart_info.find((row) => row.id === item.order_cart_id)?.write_surplus_times ?? 0))) return;
  const quantitySnapshot = JSON.stringify(quantities.value);
  confirming.value = true;
  const confirmed = await confirmExecute();
  if (!current(ownGeneration, session, selectedRole, scannedCode) || previewOrder.value !== preview
    || previewKind.value !== kind) return;
  confirming.value = false;
  if (!confirmed || quantitySnapshot !== JSON.stringify(quantities.value)) return;
  executing.value = true;
  let acknowledged = false;
  try {
    const result = kind === "member"
      ? await apiOperatorMemberWriteoff(selectedRole, scannedCode, preview.id, items)
      : await apiOperatorWriteoff(selectedRole, scannedCode, items);
    if (!current(ownGeneration, session, selectedRole, scannedCode) || previewOrder.value !== preview) return;
    if (!result || result.order_id !== preview.order_id || typeof result.completed !== "boolean"
      || !Number.isSafeInteger(result.status)) throw new Error("核销回执不完整，请重新查单确认");
    acknowledged = true;
    uni.showToast({ title: result.completed ? "核销完成" : "部分核销成功", icon: "success" });
    code.value = "";
    memberCandidates.value = [];
    writeUncertain.value = false;
    resetPreview();
  } catch (error) {
    if (current(ownGeneration, session, selectedRole, scannedCode)) {
      writeUncertain.value = true;
      resetPreview();
      toast(error instanceof Error ? error.message : "核销结果待确认，请重新查单");
    }
  } finally {
    executing.value = false;
    if (!acknowledged && auth.sessionVersion === session) writeUncertain.value = true;
  }
}

onLoad((query) => {
  requestedRole = query?.role === "delivery" ? "delivery" : query?.role === "staff" ? "staff" : null;
  pendingCode = (parseOperatorScene(query?.scene)
    ?? parseOperatorScanCode(query?.code, operatorScanSiteOrigins()))?.code ?? "";
  pendingCodeSession = auth.sessionVersion;
});

onShow(() => {
  visible = true;
  if (pendingCodeSession !== auth.sessionVersion) pendingCode = "";
  void loadProfile();
});

onHide(() => { visible = false; profileRequestId++; pendingCode = ""; profile.value = null; invalidatePrivate(true); });
onUnload(() => { visible = false; profileRequestId++; pendingCode = ""; profile.value = null; invalidatePrivate(true); });
watch(code, () => invalidatePrivate(), { flush: "sync" });
watch(() => auth.sessionVersion, () => {
  pendingCode = "";
  profile.value = null;
  writeUncertain.value = false;
  invalidatePrivate(true);
  // setLogin increments the epoch before updating token/uid. Reload after the
  // action completes so the request binds to the replacement credentials.
  const session = auth.sessionVersion;
  if (visible) queueMicrotask(() => {
    if (visible && auth.sessionVersion === session) void loadProfile();
  });
}, { flush: "sync" });
</script>

<style scoped>
.operator-page { min-height: 100vh; padding: 24rpx; background: #f5f6f8; box-sizing: border-box; color: #242424; }
.state-card, .identity-card, .scan-card, .preview-card, .candidate-card { display: flex; flex-direction: column; gap: 14rpx; padding: 28rpx; margin-bottom: 20rpx; border-radius: 20rpx; background: #fff; }
.state-card { align-items: center; margin-top: 120rpx; color: #777; }
.state-title, .section-title, .identity-title { font-size: 30rpx; font-weight: 650; color: #222; }
.warning { color: #d94838; }
.role-tabs { display: flex; padding: 8rpx; margin-bottom: 20rpx; border-radius: 18rpx; background: #e8eaf0; }
.role-tab { flex: 1; padding: 18rpx; border-radius: 14rpx; text-align: center; color: #666; }
.role-tab.active { background: #fff; color: #e93323; font-weight: 650; box-shadow: 0 4rpx 14rpx rgba(0, 0, 0, 0.06); }
.identity-card { gap: 8rpx; color: #666; }
.code-input { height: 92rpx; padding: 0 22rpx; border: 2rpx solid #dcdfe6; border-radius: 14rpx; font-size: 42rpx; letter-spacing: 8rpx; box-sizing: border-box; }
.scan-actions { display: flex; gap: 18rpx; }
.scan-actions button { flex: 1; margin: 0; font-size: 28rpx; }
.candidate-row { display: flex; justify-content: space-between; align-items: center; margin: 0; padding: 22rpx; text-align: left; background: #f7f8fa; color: #333; font-size: 26rpx; }
.primary-button, .execute-button { background: #e93323; color: #fff; }
.secondary-button { background: #fff; color: #e93323; border: 2rpx solid #e93323; }
.preview-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8rpx; }
.preview-head > view { display: flex; flex-direction: column; gap: 8rpx; }
.customer, .cart-meta, .irreversible { font-size: 24rpx; color: #777; }
.mode-tag { padding: 8rpx 16rpx; border-radius: 999rpx; background: #fff1ef; color: #e93323; font-size: 24rpx; }
.cart-line { padding: 24rpx 0; border-top: 1rpx solid #eee; }
.cart-line.disabled { opacity: 0.5; }
.cart-main { display: flex; align-items: center; gap: 18rpx; }
.check { width: 38rpx; height: 38rpx; border: 2rpx solid #bbb; border-radius: 50%; text-align: center; line-height: 36rpx; color: #fff; }
.check.checked { border-color: #e93323; background: #e93323; }
.cart-copy { display: flex; flex: 1; flex-direction: column; gap: 8rpx; min-width: 0; }
.cart-name { overflow: hidden; font-size: 28rpx; text-overflow: ellipsis; white-space: nowrap; }
.quantity { display: flex; align-items: center; justify-content: flex-end; margin-top: 16rpx; }
.quantity-button { width: 64rpx; height: 56rpx; padding: 0; margin: 0; line-height: 52rpx; background: #f3f4f6; color: #333; }
.quantity-input { width: 96rpx; height: 56rpx; text-align: center; background: #fafafa; }
.execute-button { margin-top: 22rpx; }
.execute-button[disabled] { background: #ccc; }
.irreversible { text-align: center; }
</style>
