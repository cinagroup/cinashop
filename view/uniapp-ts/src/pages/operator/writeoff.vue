<template>
  <ThemePage>
  <view class="operator-page">
    <view v-if="legacyAuto" class="state-card" data-writeoff-legacy="identity-choice"><text class="state-title">选择当前实际核销身份</text><text>历史身份提示不能授予核销权限。普通客户与配送员分别进入独立工作台，再核对订单和次数。</text><text v-if="legacyLoading">正在读取当前账号资格…</text><text v-if="legacyError" class="warning">{{ legacyError }}</text><button v-if="legacyCustomer" :disabled="legacyLoading" @tap="chooseLegacy('customer')">普通客户核销</button><button v-if="legacyDelivery" :disabled="legacyLoading" @tap="chooseLegacy('delivery')">配送送达</button><text v-if="!legacyLoading&&!legacyCustomer&&!legacyDelivery&&!legacyError">当前账号没有可用的普通客户或配送资格。</text><button :disabled="legacyLoading" @tap="loadLegacy">重新读取资格</button></view>
    <view v-else-if="role==='delivery'" class="state-card" data-delivery="legacy-redirect"><text class="state-title">配送送达工作台</text><text>请选择实际平台或门店配送身份后，再核对商品与数量。</text><button @tap="openDelivery">进入配送工作台</button></view>
    <view v-else-if="loadingProfile" class="state-card">正在核验履约身份…</view>

    <view v-else-if="!profile?.can_writeoff" class="state-card denied">
      <text class="state-title">当前账号没有核销权限</text>
      <text>需要启用中的门店核销员或平台配送员身份。</text>
      <text v-if="profile?.delivery_identity_conflict" class="warning">配送员身份存在重复，请联系管理员清理后再试。</text>
    </view>

    <template v-else>
      <view v-if="hasBothRoles" class="role-tabs">
        <view :class="['role-tab', { active: role === 'staff' }]" @tap="selectRole('staff')">门店核销</view>
        <view class="role-tab" @tap="selectRole('delivery')">配送送达</view>
      </view>

      <view class="identity-card">
        <text class="identity-title">门店核销员</text>
        <text>{{ staffStoreNames }}</text>
      </view>

      <view class="scan-card">
        <text class="section-title">扫描或输入客户核销码</text>
        <input
          v-model="code"
          class="code-input"
          type="number"
          maxlength="12"
          placeholder="12位核销码"
          confirm-type="search"
          @confirm="preview"
        />
        <view class="scan-actions">
          <button class="secondary-button" @tap="scan">扫码</button>
          <button class="primary-button" :loading="loadingPreview" @tap="preview">校验核销码</button>
        </view>
      </view>

      <view v-if="previewOrder" class="preview-card">
        <view class="preview-head">
          <view>
            <text class="section-title">订单 {{ previewOrder.order_id }}</text>
            <text class="customer">{{ previewOrder.real_name }} · {{ previewOrder.user_phone }}</text>
          </view>
          <text class="mode-tag">到店</text>
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

        <button class="execute-button" :loading="executing" :disabled="selectedQuantity <= 0" @tap="execute">
          确认核销（{{ selectedQuantity }}）
        </button>
        <text class="irreversible">操作不可撤销；部分核销后当前码会立即失效。</text>
      </view>
    </template>
  </view>
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { computed, ref,watch } from "vue";
import { onLoad, onShow,onHide,onUnload } from "@dcloudio/uni-app";
import {useAuthStore} from '@/stores/auth';
import {createUserCenterRequests,type UserCenterRequests} from '@/api/userCenter';
import {parseUserCenterMenu} from '@/utils/userCenter';
import {customerWorkRoute} from '@/utils/customerWork';
import type {CustomerWorkPage} from '@/types/customerWork';
import {parseCustomerWriteoffLegacyChoice} from '@/utils/customerWorkWriteoff';
import {
  apiOperatorWriteoff,
  apiOperatorWriteoffInfo,
  apiWriteoffOperatorProfile,
  type OperatorWriteoffPreview,
  type WriteoffOperatorProfile,
} from "@/api/order";

type OperatorRole = "staff" | "delivery";

const profile = ref<WriteoffOperatorProfile | null>(null);
const role = ref<OperatorRole>("staff");
const code = ref("");
const previewOrder = ref<OperatorWriteoffPreview | null>(null);
const quantities = ref<Record<number, number>>({});
const selected = ref<Record<number, boolean>>({});
const loadingProfile = ref(true);
const loadingPreview = ref(false);
const executing = ref(false);
let requestedRole: OperatorRole | null = null;
let pendingCode = "";
const legacyAuto=ref(false),legacyLoading=ref(false),legacyError=ref(''),legacyCustomer=ref(false),legacyDelivery=ref(false),legacyAuth=useAuthStore();let legacyQuery:Record<string,string>={},legacyVisible=false,legacyDisposed=false,legacyEpoch=0,legacyScope:UserCenterRequests|null=null;
function clearLegacy(){legacyEpoch++;legacyScope?.abort();legacyScope=null;legacyCustomer.value=false;legacyDelivery.value=false;legacyLoading.value=false;legacyError.value='';profile.value=null;code.value='';pendingCode='';resetPreview();}
async function loadLegacy(){if(!legacyAuto.value||!legacyVisible||legacyDisposed||legacyQuery.entry!=='legacy-auto')return;clearLegacy();if(!legacyAuth.isLoggedIn){legacyError.value='请登录后读取当前核销资格';return;}const epoch=legacyEpoch,scope=createUserCenterRequests(()=>legacyAuto.value&&legacyVisible&&!legacyDisposed&&legacyEpoch===epoch);legacyScope=scope;legacyLoading.value=true;try{const menu=parseUserCenterMenu(await scope.request('menu/user','GET',{},true),scope.owner.uid);if(!scope.active())return;legacyCustomer.value=menu.capabilities.work===true;legacyDelivery.value=menu.capabilities.deliveryWorkBench===true;}catch(failure){if(scope.active())legacyError.value=failure instanceof Error&&/[\u3400-\u9fff]/u.test(failure.message)?failure.message:'当前核销资格暂无法核对，请重新读取';}finally{if(scope.active())legacyLoading.value=false;scope.abort();if(legacyScope===scope)legacyScope=null;}}
function chooseLegacy(kind:'customer'|'delivery'){if(!legacyAuto.value||!legacyVisible||legacyDisposed||legacyLoading.value||!legacyAuth.isLoggedIn||(kind==='customer'?!legacyCustomer.value:!legacyDelivery.value))return;try{let url='/pages/delivery/scanning';if(kind==='customer'){const page=(legacyQuery.next??'scanning') as CustomerWorkPage;url=page==='scanning'?customerWorkRoute('scanning',legacyQuery.code?{namespace:'auto',value:legacyQuery.code}:{}):customerWorkRoute(page,{legacyOrderId:legacyQuery.legacyOrderId!});}uni.navigateTo({url,fail:()=>{if(legacyVisible)legacyError.value='所选工作台暂时无法打开，请重新读取资格';}});}catch{legacyError.value='历史核销入口无效，请重新进入工作台';}}

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

function extractVerifyCode(value: unknown): string {
  const text = String(value ?? "").trim();
  if (/^\d{12}$/.test(text)) return text;
  const queryMatch = text.match(/[?&#](?:code|verify_code|verifyCode)=(\d{12})(?:[&#]|$)/);
  if (queryMatch) return queryMatch[1];
  const plainMatch = text.match(/(?:^|\D)(\d{12})(?:\D|$)/);
  return plainMatch?.[1] ?? "";
}

function resetPreview() {
  previewOrder.value = null;
  quantities.value = {};
  selected.value = {};
}

function selectRole(value: OperatorRole) {
  if (value === "delivery") return openDelivery();
  if (value === "staff" && !hasStaffRole.value) return;
  role.value = value;
  code.value = "";
  resetPreview();
}

async function loadProfile() {
  if (deliveryMode()) return openDelivery();
  loadingProfile.value = true;
  try {
    profile.value = await apiWriteoffOperatorProfile();
    if (requestedRole === "delivery" && hasDeliveryRole.value) role.value = "delivery";
    else if (requestedRole === "staff" && hasStaffRole.value) role.value = "staff";
    else if (!hasStaffRole.value && hasDeliveryRole.value) role.value = "delivery";
    else role.value = "staff";
    if (deliveryMode()) return openDelivery();
    if (pendingCode && profile.value.can_writeoff) {
      code.value = pendingCode;
      pendingCode = "";
      await preview();
    }
  } catch (error) {
    profile.value = null;
    toast(error instanceof Error ? error.message : "身份核验失败");
  } finally {
    loadingProfile.value = false;
  }
}

function scan() {
  if (deliveryMode()) return openDelivery();
  uni.scanCode({
    scanType: ["qrCode", "barCode"],
    success: (result) => {
      if (deliveryMode()) return openDelivery();
      const parsed = extractVerifyCode(result.result);
      if (!parsed) return toast("二维码中没有有效的12位核销码");
      code.value = parsed;
      void preview();
    },
    fail: (error) => {
      if (!String(error.errMsg ?? "").includes("cancel")) toast("当前环境无法扫码，请手动输入核销码");
    },
  });
}

async function preview() {
  if (deliveryMode()) return openDelivery();
  const normalized = extractVerifyCode(code.value);
  if (!normalized) return toast("请输入12位核销码");
  loadingPreview.value = true;
  resetPreview();
  try {
    const result = await apiOperatorWriteoffInfo(role.value, normalized);
    if (deliveryMode()) return;
    code.value = normalized;
    previewOrder.value = result;
    quantities.value = Object.fromEntries(result.cart_info.map((item) => [item.id, item.write_surplus_times]));
    selected.value = Object.fromEntries(result.cart_info.map((item) => [item.id, item.write_surplus_times > 0]));
  } catch (error) {
    toast(error instanceof Error ? error.message : "核销码校验失败");
  } finally {
    loadingPreview.value = false;
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
    uni.showModal({
      title: "确认核销",
      content: `确认本次核销 ${selectedQuantity.value} 次？操作不可撤销。`,
      confirmText: "确认核销",
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false),
    });
  });
}

async function execute() {
  if (deliveryMode()) return openDelivery();
  if (!previewOrder.value || selectedQuantity.value <= 0 || executing.value) return;
  if (!(await confirmExecute())) return;
  if (deliveryMode()) return openDelivery();
  const items = previewOrder.value.cart_info
    .filter((item) => selected.value[item.id] && Number(quantities.value[item.id] ?? 0) > 0)
    .map((item) => ({ order_cart_id: item.id, quantity: Number(quantities.value[item.id]) }));
  executing.value = true;
  try {
    const result = await apiOperatorWriteoff(role.value, code.value, items);
    uni.showToast({ title: result.completed ? "核销完成" : "部分核销成功", icon: "success" });
    code.value = "";
    resetPreview();
  } catch (error) {
    toast(error instanceof Error ? error.message : "核销失败");
  } finally {
    executing.value = false;
  }
}

onLoad((query) => {
  if(query?.entry!==undefined){legacyAuto.value=true;try{let input:string|Record<string,unknown>=query;
   // #ifdef H5
   if(typeof window!=='undefined'){const hash=window.location.hash.replace(/^#/u,''),at=hash.indexOf('?');if(hash.slice(0,at)==='/pages/operator/writeoff')input=hash.slice(at+1);}
   // #endif
   legacyQuery=parseCustomerWriteoffLegacyChoice(input);}catch(failure){legacyError.value=failure instanceof Error?failure.message:'历史核销入口无效';legacyQuery={};}return;}
  requestedRole = query?.role === "delivery" ? "delivery" : query?.role === "staff" ? "staff" : null;
  if (requestedRole === "delivery") role.value = "delivery";
  pendingCode = extractVerifyCode(query?.code);
});

onShow(() => {
  legacyVisible=true;if(legacyAuto.value){if(legacyQuery.entry==='legacy-auto')void loadLegacy();else legacyError.value='历史核销入口无效，请重新进入工作台';return;}
  if (deliveryMode()) return openDelivery();
  void loadProfile();
});
onHide(()=>{legacyVisible=false;if(legacyAuto.value){clearLegacy();delete legacyQuery.code;}});onUnload(()=>{legacyVisible=false;legacyDisposed=true;if(legacyAuto.value){clearLegacy();legacyQuery={};}});watch(()=>[legacyAuth.uid,legacyAuth.token,legacyAuth.sessionVersion],()=>{if(legacyAuto.value){clearLegacy();delete legacyQuery.code;if(legacyVisible&&legacyQuery.entry==='legacy-auto')void loadLegacy();}},{flush:'sync'});

/** Legacy delivery links enter the new scope and durable-operation flow. Staff keeps its own API. */
function deliveryMode(){return role.value==='delivery'||requestedRole==='delivery';}
function openDelivery(){role.value='delivery';requestedRole='delivery';code.value='';pendingCode='';resetPreview();loadingProfile.value=false;const target={url:'/pages/delivery/scanning',fail:()=>toast('配送工作台暂时无法打开，请重试')};if(typeof uni.redirectTo==='function')uni.redirectTo(target);else uni.navigateTo(target);}
</script>

<style scoped>
.operator-page { min-height: 100vh; padding: 24rpx; background: #f5f6f8; box-sizing: border-box; color: #242424; }
.state-card, .identity-card, .scan-card, .preview-card { display: flex; flex-direction: column; gap: 14rpx; padding: 28rpx; margin-bottom: 20rpx; border-radius: 20rpx; background: #fff; }
.state-card { align-items: center; margin-top: 120rpx; color: #777; }
.state-title, .section-title, .identity-title { font-size: 30rpx; font-weight: 650; color: #222; }
.warning { color: #d94838; }
.role-tabs { display: flex; padding: 8rpx; margin-bottom: 20rpx; border-radius: 18rpx; background: #e8eaf0; }
.role-tab { flex: 1; padding: 18rpx; border-radius: 14rpx; text-align: center; color: #666; }
.role-tab.active { background: #fff; color: var(--view-theme, #e93323); font-weight: 650; box-shadow: 0 4rpx 14rpx rgba(0, 0, 0, 0.06); }
.identity-card { gap: 8rpx; color: #666; }
.code-input { height: 92rpx; padding: 0 22rpx; border: 2rpx solid #dcdfe6; border-radius: 14rpx; font-size: 42rpx; letter-spacing: 8rpx; box-sizing: border-box; }
.scan-actions { display: flex; gap: 18rpx; }
.scan-actions button { flex: 1; margin: 0; font-size: 28rpx; }
.primary-button, .execute-button { background: var(--view-theme, #e93323); color: #fff; }
.secondary-button { background: #fff; color: var(--view-theme, #e93323); border: 2rpx solid var(--view-theme, #e93323); }
.preview-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8rpx; }
.preview-head > view { display: flex; flex-direction: column; gap: 8rpx; }
.customer, .cart-meta, .irreversible { font-size: 24rpx; color: #777; }
.mode-tag { padding: 8rpx 16rpx; border-radius: 999rpx; background: var(--view-minorColorT, rgba(233, 51, 35, 0.1)); color: var(--view-theme, #e93323); font-size: 24rpx; }
.cart-line { padding: 24rpx 0; border-top: 1rpx solid #eee; }
.cart-line.disabled { opacity: 0.5; }
.cart-main { display: flex; align-items: center; gap: 18rpx; }
.check { width: 38rpx; height: 38rpx; border: 2rpx solid #bbb; border-radius: 50%; text-align: center; line-height: 36rpx; color: #fff; }
.check.checked { border-color: var(--view-theme, #e93323); background: var(--view-theme, #e93323); }
.cart-copy { display: flex; flex: 1; flex-direction: column; gap: 8rpx; min-width: 0; }
.cart-name { overflow: hidden; font-size: 28rpx; text-overflow: ellipsis; white-space: nowrap; }
.quantity { display: flex; align-items: center; justify-content: flex-end; margin-top: 16rpx; }
.quantity-button { width: 64rpx; height: 56rpx; padding: 0; margin: 0; line-height: 52rpx; background: #f3f4f6; color: #333; }
.quantity-input { width: 96rpx; height: 56rpx; text-align: center; background: #fafafa; }
.execute-button { margin-top: 22rpx; }
.execute-button[disabled] { background: #ccc; }
.irreversible { text-align: center; }
</style>
