<template>
  <ThemePage>
  <view class="cart-page">
    <view v-if="cartStore.ready && cartStore.items.length" class="cart-heading">
      <text>共 {{ cartStore.items.length }} 项商品</text>
      <button class="manage-toggle" :disabled="blocked" @tap="toggleManagement">{{ managing ? '取消' : '管理' }}</button>
    </view>
    <view v-if="cartStore.loading" class="empty" role="status">正在读取购物车报价…</view>
    <view v-else-if="cartStore.error" class="empty" role="alert"><view>{{ cartStore.error }}</view><button @tap="reload()">重新读取购物车</button><button v-if="!auth.isLoggedIn" @tap="login">去登录</button></view>
    <view v-else-if="cartStore.items.length" class="cart-list">
      <view v-for="group in cartGroups" :key="group.key" class="cart-group" :class="{ 'invalid-group': group.key === 'invalid' }">
      <view v-if="group.key === 'invalid'" class="invalid-heading">
        <text>失效商品（{{ invalidItems.length }}）</text>
        <button class="clear-invalid" :disabled="blocked" @tap="clearInvalid">一键清空</button>
      </view>
      <view class="cart-item" v-for="item in group.items" :key="item.id" :data-cart-id="item.id">
        <button class="check" :class="{ checked: isChecked(item) }" :disabled="blocked || (!managing && !item.isValid)" :aria-label="`选择${item.productInfo?.storeName || '失效商品'}`" :aria-pressed="isChecked(item)" @tap="toggle(item.id)">
          <text v-if="isChecked(item)">✓</text>
        </button>
        <image
          class="cart-image"
          :src="item.productInfo?.image || placeholder"
          mode="aspectFill"
          @tap="goDetail(item.productId)"
        />
        <view class="cart-info">
          <view class="cart-name">{{ item.productInfo?.storeName ?? '商品已失效' }}</view>
          <view>{{ item.productInfo?.suk }}</view>
          <view class="cart-bottom">
            <view v-if="item.isValid">
              <text class="cart-price">¥{{ item.promotion?.unitPriceCents === null ? cartLinePrice(item) : cartUnitPrice(item) }}</text>
              <view class="price-label">{{ cartPriceLabel(item) }}</view>
              <view class="line-total">本商品合计 ¥{{ cartLinePrice(item) }}</view>
              <view v-if="cartPromotionSummary(item)" class="promotion-parts">{{ cartPromotionSummary(item) }}</view>
            </view><text v-else>已失效</text>
            <view v-if="item.isValid && !managing" class="num-control">
              <button class="num-btn" :disabled="blocked || item.cartNum <= 1" @tap="changeNum(item, -1)">-</button>
              <text class="num">{{ item.cartNum }}</text>
              <button class="num-btn" :disabled="blocked || item.cartNum >= Math.min(item.productInfo?.stock ?? 0, 32767)" @tap="changeNum(item, 1)">+</button>
            </view>
          </view>
          <view class="row-actions">
            <button v-if="item.isValid" :disabled="blocked" @tap.stop="collectRows([item.id])">收藏</button>
            <button :disabled="blocked" @tap.stop="removeRows([item.id])">删除</button>
          </view>
        </view>
      </view>
      </view>
    </view>
    <view v-else class="cart-empty" role="status">
      <image class="cart-empty-image" src="/static/php-assets/images/empty-box.gif" mode="aspectFit" aria-hidden="true" />
      <view class="cart-empty-title">暂无商品，去加点别的吧～</view>
    </view>

    <view v-if="!managing && cartStore.checkedItems.length && cartStore.ready" class="budget-panel" aria-live="polite">
      <view v-if="budget.loading" role="status">正在计算选中商品的优惠预算…</view>
      <view v-else-if="budget.error || scopeError" role="alert">{{ budget.error || scopeError }}<button :disabled="blocked" @tap="reloadBudget">重新计算预算</button></view>
      <template v-else-if="budgetReady && budget.result">
        <view class="budget-title">选中商品预算 ¥{{ budget.result.pay }}</view>
        <view>商品原价 ¥{{ budget.result.raw }} · 会员优惠 ¥{{ budget.result.membership }}</view>
        <view>促销优惠 ¥{{ budget.result.promotions }} · 首单优惠 ¥{{ budget.result.firstOrder }}</view>
        <view v-if="budget.result.requiredIntegral">兑换另外需要 {{ budget.result.requiredIntegral }} 积分，结算时重新核验余额。</view>
        <view v-if="budget.result.coupon">{{ budget.result.coupon.title }}：预计省 ¥{{ budget.result.coupon.discount }}（{{ budget.result.coupon.requiresClaim ? '尚未领取' : '已领取' }}）</view>
        <view v-if="budget.result.coupon?.requiresClaim" class="estimate-note">此金额假设领券成功。点击“领券并去结算”后领取，结算会重新核验该券。</view>
        <view v-for="gift in budget.result.gifts" :key="gift.id">{{ gift.name }}：预计赠 {{ gift.giveIntegral }} 积分、{{ gift.coupons.length }} 张券、{{ gift.products.reduce((sum,item)=>sum+item.quantity,0) }} 件赠品</view>
        <view v-if="!budget.result.svipActive && budget.result.svipSaving !== '0.00'" class="estimate-note">如已开通有效 SVIP，商品预算预计再省 ¥{{ budget.result.svipSaving }}；此处未开通会员。</view>
      </template>
      <view class="estimate-note">预算不含运费、积分抵扣和支付费用，以结算重新报价为准。库存、优惠券和赠品未预留。</view>
    </view>
    <view v-if="managementMessage" class="management-message" role="status">{{ managementMessage }}</view>
    <view v-if="claimError" class="estimate-note" role="alert">{{ claimError }}</view>
    <view class="checkout-bar" :style="{bottom:footerHeight ? `${footerHeight}px` : 'var(--window-bottom,0px)',paddingBottom:footerHeight ? '20rpx' : 'calc(20rpx + env(safe-area-inset-bottom))'}" v-if="cartStore.items.length && !cartStore.error && !cartStore.loading">
      <button class="check-all" :disabled="blocked" @tap="toggleAll">
        <view class="check" :class="{ checked: allChecked }">
          <text v-if="allChecked">✓</text>
        </view>
        <text>全选</text>
      </button>
      <template v-if="managing">
        <view class="management-summary">已选 {{ managementItems.length }} 项</view>
        <button class="collect-btn" :disabled="blocked || !canCollectSelection" @tap="collectRows(managementSelection)">收藏商品</button>
        <button class="delete-btn" :disabled="blocked || !managementItems.length" @tap="removeRows(managementSelection)">删除</button>
      </template>
      <template v-else>
      <view class="total-area">
        <text class="total-label">合计: </text>
        <text class="total-price">¥{{ cartStore.totalPrice }}</text>
      </view>
      <button class="checkout-btn" :disabled="blocked || !budgetReady" @tap="goCheckout">{{ claiming ? '正在领取…' : budget.result?.coupon?.requiresClaim ? '领券并去结算' : '去结算' }}</button>
      </template>
    </view>
  </view>
  <DiyGlobalFooter :active="footerVisible" @height="footerHeight=$event" />
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import DiyGlobalFooter from '@/components/diy/DiyGlobalFooter.vue';
import { useDiyFooterHost } from '@/composables/useDiyFooterHost';
const { visible: footerVisible, height: footerHeight } = useDiyFooterHost();
import { computed, ref, shallowRef, watch } from "vue";
import { onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { useCartStore } from "@/stores/cart";
import { useAuthStore } from '@/stores/auth';
import { cartUnitPrice, cartLinePrice, cartPriceLabel, cartPromotionSummary, type CartDisplayItem } from '../../../../common/cartPrice';
import { CartBudgetSession, cartBudgetScope, type CartBudgetState } from '../../../../common/cartComputation';
import { apiCartCompute } from '@/api/cartComputation';
import { apiCouponReceive } from '@/api/activity';
import { apiCollectProducts, PRODUCT_COLLECT_LIMIT } from '@/api/productCollection';
import { requestCartReconciliation } from '@/stores/cartMutation';

const cartStore = useCartStore();
const auth = useAuthStore(), visible = ref(false);
let disposed = false;
const claiming = ref(false), claimError = ref('');
const managing = ref(false), managementSelection = ref<number[]>([]), collecting = ref(false), managementMessage = ref('');
let managementVersion = 0;
const blocked = computed(() => !visible.value || !cartStore.ready || cartStore.loading || cartStore.updating || claiming.value || collecting.value);
const budget = shallowRef<CartBudgetState>({ fingerprint:'',loading:false,error:'',result:null });
const budgetSession = new CartBudgetSession(apiCartCompute,state=>{budget.value=state;});
const scopeError=ref('');
const scope=computed(()=>{
  if(managing.value||!visible.value||!cartStore.ready||cartStore.loading||cartStore.updating||!cartStore.checkedItems.length||!auth.isLoggedIn)return null;
  try{return cartBudgetScope(cartStore.checkedItems,{uid:auth.uid,version:auth.sessionVersion});}catch{return null;}
});
const budgetReady=computed(()=>!!scope.value&&!budget.value.loading&&!budget.value.error&&!!budget.value.result&&budget.value.fingerprint===scope.value.fingerprint);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const validItems = computed(() => cartStore.items.filter(item => item.isValid));
const invalidItems = computed(() => cartStore.items.filter(item => !item.isValid));
const cartGroups = computed(() => [{ key: 'valid', items: validItems.value }, { key: 'invalid', items: invalidItems.value }].filter(group => group.items.length));
const managementItems = computed(() => cartStore.items.filter(item => managementSelection.value.includes(item.id)));
const canCollectSelection = computed(() => !!managementItems.value.length && managementItems.value.every(item => item.isValid)
  && new Set(managementItems.value.map(item => item.productId)).size <= PRODUCT_COLLECT_LIMIT);
const allChecked = computed(() => managing.value
  ? !!cartStore.items.length && cartStore.items.every(item => managementSelection.value.includes(item.id))
  : !!validItems.value.length && validItems.value.every(item => item.checked));
function isChecked(item: CartDisplayItem) { return managing.value ? managementSelection.value.includes(item.id) : item.checked; }
function resetManagement() {
  managementVersion++; managing.value = false; managementSelection.value = []; collecting.value = false; managementMessage.value = '';
}
function toggleManagement() {
  if (blocked.value) return;
  managing.value = !managing.value; managementSelection.value = []; managementMessage.value = '';
}
async function removeRows(ids: number[]) {
  if (blocked.value) return;
  if (ids.length > 200) { managementMessage.value = '每次最多删除 200 项商品'; return; }
  const selected = [...ids], owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion }, version = ++managementVersion;
  managementMessage.value = '';
  const removed = await cartStore.removeItems(selected);
  if (disposed || !visible.value || auth.uid !== owner.uid || auth.token !== owner.token || auth.sessionVersion !== owner.version || version !== managementVersion) return;
  if (removed) {
    managementSelection.value = managementSelection.value.filter(id => cartStore.items.some(item => item.id === id));
    managementMessage.value = '已删除所选商品';
    if (!cartStore.items.length) managing.value = false;
  }
}
async function clearInvalid() { if (!blocked.value) await removeRows(invalidItems.value.map(item => item.id)); }
async function collectRows(ids: number[]) {
  if (blocked.value || !ids.length || new Set(ids).size !== ids.length) return;
  const rows = ids.map(id => cartStore.items.find(item => item.id === id));
  if (rows.some(item => !item?.isValid)) { managementMessage.value = '失效商品可删除，不能收藏'; return; }
  const products = [...new Set(rows.map(item => item!.productId))];
  if (products.length > PRODUCT_COLLECT_LIMIT) { managementMessage.value = '每次最多收藏 100 件商品'; return; }
  const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion }, version = ++managementVersion;
  const current = () => !disposed && visible.value && auth.uid === owner.uid && auth.token === owner.token && auth.sessionVersion === owner.version && version === managementVersion;
  collecting.value = true; managementMessage.value = '';
  try {
    const added = await apiCollectProducts(products);
    if (current()) managementMessage.value = added ? '收藏成功' : '所选商品已收藏';
  } catch { if (current()) managementMessage.value = '收藏结果未确认，请到我的收藏查看'; }
  finally { if (current()) collecting.value = false; }
}
watch(() => cartStore.items.map(item => item.id).join(','), () => {
  if (cartStore.ready) managementSelection.value = managementSelection.value.filter(id => cartStore.items.some(item => item.id === id));
});

function toggle(id: number) {
  if (blocked.value) return;
  const item = cartStore.items.find((i) => i.id === id);
  if (!item) return;
  if (managing.value) managementSelection.value = managementSelection.value.includes(id) ? managementSelection.value.filter(value => value !== id) : [...managementSelection.value, id];
  else cartStore.toggleChecked(id, !item.checked);
}

function toggleAll() {
  if (blocked.value) return;
  if (managing.value) managementSelection.value = allChecked.value ? [] : cartStore.items.map(item => item.id);
  else cartStore.toggleAll(!allChecked.value);
}

async function changeNum(item: CartDisplayItem, delta: number) {
  if (blocked.value || managing.value || !cartStore.items.includes(item)) return;
  await cartStore.updateQuantity(item.id, item.cartNum + delta);
}

function goDetail(id: number) {
  if (blocked.value || !cartStore.items.some(row => row.productId === id && row.isValid)) return;
  uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

async function goCheckout() {
  if (blocked.value || managing.value) return;
  if (!cartStore.checkedItems.length || !budgetReady.value || !scope.value) {
    return uni.showToast({ title: "请选择商品", icon: "none" });
  }
  const current=scope.value,owner={uid:auth.uid,token:auth.token,version:auth.sessionVersion};
  const coupon=budget.value.result!.coupon; let couponId=coupon?.userId??0;
  claimError.value='';
  if(coupon?.requiresClaim){
    claiming.value=true;
    try{
      const receipt=await apiCouponReceive(coupon.issueId);
      if(disposed||!visible.value||auth.uid!==owner.uid||auth.token!==owner.token||auth.sessionVersion!==owner.version||scope.value?.fingerprint!==current.fingerprint)return;
      if(!Number.isSafeInteger(receipt.couponUserId)||receipt.couponUserId<=0)throw new Error('领券结果无效，请刷新优惠券列表后重试');
      couponId=receipt.couponUserId;
      await budgetSession.load(current);
      if(disposed||!visible.value||scope.value?.fingerprint!==current.fingerprint||!budgetReady.value)return;
    }catch(error){
      if(visible.value&&auth.uid===owner.uid&&auth.sessionVersion===owner.version&&scope.value?.fingerprint===current.fingerprint){
        claimError.value=error instanceof Error?error.message:'领券未确认，请重新读取预算';
        // A lost reply can follow a committed claim. A fresh read reconciles
        // ownership before another explicit click; it never repeats the grant.
        await budgetSession.load(current);
      }
      return;
    }
    finally{claiming.value=false;}
  }
  if(disposed||!visible.value||auth.uid!==owner.uid||auth.token!==owner.token||auth.sessionVersion!==owner.version||scope.value?.fingerprint!==current.fingerprint)return;
  const first=current.selection[0]!,params=new URLSearchParams();
  if(first.type>0){params.set('type',String(first.type));if(first.type===1)params.set('seckillId',String(first.activityId));if(first.type===3)params.set('combinationId',String(first.activityId));}
  if(couponId)params.set('couponId',String(couponId));
  uni.navigateTo({url:`/pages/order/confirm${params.size?'?'+params.toString():''}`});
}

async function reloadBudget(){if(!blocked.value&&scope.value)await budgetSession.load(scope.value);}
watch(()=>scope.value?.fingerprint??'',()=>{
  claimError.value='';scopeError.value='';budgetSession.reset();
  if(scope.value)void budgetSession.load(scope.value);
  else if(visible.value&&cartStore.ready&&cartStore.checkedItems.length){try{cartBudgetScope(cartStore.checkedItems,{uid:auth.uid,version:auth.sessionVersion});}catch(error){scopeError.value=error instanceof Error?error.message:'选中商品不能预算';}}
},{flush:'sync'});

let reloadVersion = 0;
async function reload(reconcileError = true) {
  if (!visible.value || disposed) return;
  // A second retry must not replace the in-flight recovery after fetchList
  // synchronously clears its error. Lifecycle reads may still supersede it.
  if (reconcileError && cartStore.loading) return;
  const recovering = reconcileError && !!cartStore.error;
  const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  const generation = ++reloadVersion, readGeneration = cartStore.readVersion + 1;
  try { await cartStore.fetchList(); } catch { return; }
  if (!recovering || disposed || !visible.value || auth.uid !== owner.uid || auth.token !== owner.token || auth.sessionVersion !== owner.version
    || generation !== reloadVersion || cartStore.readVersion !== readGeneration || !cartStore.ready || cartStore.loading || cartStore.updating || cartStore.error) return;
  // A successful explicit retry reconciles an uncertain outcome, never replays
  // its write or turns ordinary Page reads into mutation notifications.
  requestCartReconciliation();
  await cartStore.fetchCount();
}
function login() { if (visible.value && !disposed && !auth.isLoggedIn) uni.navigateTo({ url: '/pages/auth/login' }); }
watch(() => auth.sessionVersion, () => { resetManagement(); void Promise.resolve().then(() => reload(false)); }, { flush: 'sync' });
onShow(() => { visible.value = true; void reload(false); });
onHide(() => { visible.value = false; resetManagement(); budgetSession.reset(); cartStore.cancelPending(); });
onUnload(() => { disposed = true; visible.value = false; resetManagement(); budgetSession.reset(); cartStore.cancelPending(); });
</script>

<style scoped>
.cart-heading, .invalid-heading { display:flex; justify-content:space-between; align-items:center; padding:8rpx 12rpx 24rpx; color:#333; font-size:28rpx; }
.manage-toggle, .clear-invalid, .row-actions button { margin:0; padding:0 12rpx; background:transparent; font-size:24rpx; line-height:44rpx; }
.manage-toggle::after, .clear-invalid::after, .row-actions button::after, .check::after, .check-all::after { border:0; }
.cart-group { background:#fff; border-radius:24rpx; overflow:hidden; margin-bottom:20rpx; }
.cart-group .cart-item { border-radius:0; margin:0; padding:28rpx 24rpx; }
.cart-group .cart-item + .cart-item { border-top:1rpx solid #f5f5f5; }
.invalid-group { color:#999; }
.invalid-heading { padding:28rpx 24rpx 0; }
.clear-invalid { color:#999; }
.row-actions { display:flex; justify-content:flex-end; gap:16rpx; margin-top:14rpx; }
.row-actions button { color:#666; border:1rpx solid #ddd; border-radius:24rpx; padding:0 20rpx; }
.management-summary { flex:1; font-size:24rpx; color:#999; text-align:right; margin-right:16rpx; }
.collect-btn, .delete-btn { margin:0 0 0 16rpx; padding:12rpx 22rpx; border-radius:36rpx; background:#fff; font-size:24rpx; line-height:32rpx; }
.collect-btn { border:1rpx solid #ccc; color:#333; }
.delete-btn { border:1rpx solid var(--view-theme,#e93323); color:var(--view-theme,#e93323); }
.management-message { color:#666; font-size:24rpx; padding:16rpx; }

.cart-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 82rpx 0 160rpx;
  background: #fff;
  border-radius: 24rpx;
}

.cart-empty-image {
  width: 440rpx;
  height: 360rpx;
}

.cart-empty-title {
  padding-top: 16rpx;
  color: #999;
  font-size: 26rpx;
  line-height: 36rpx;
}

.cart-page {
  padding: 20rpx;
  padding-bottom: 140rpx;
}

.cart-item {
  display: flex;
  align-items: center;
  background: #fff;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
}

.check {
  width: 40rpx;
  height: 40rpx;
  border-radius: 50%;
  border: 2rpx solid #ddd;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 16rpx 0 0;
  padding: 0;
  background: #fff;
  line-height: 1;
  color: #fff;
  font-size: 24rpx;
  flex-shrink: 0;
}

.check.checked {
  background: var(--view-theme, #e93323);
  border-color: var(--view-theme, #e93323);
}

.cart-image {
  width: 200rpx;
  height: 200rpx;
  border-radius: 16rpx;
  flex-shrink: 0;
}

.cart-info {
  flex: 1;
  min-width: 0;
  margin-left: 16rpx;
}

.cart-name {
  font-size: 28rpx;
  font-weight: 500;
  line-height: 40rpx;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.cart-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 16rpx;
}

.cart-price {
  color: var(--view-priceColor, #e93323);
  font-size: 30rpx;
  font-weight: 600;
}

.num-control {
  display: flex;
  align-items: center;
}

.num-btn {
  padding: 0;
  margin: 0;
  width: 48rpx;
  height: 48rpx;
  border: 1rpx solid #ddd;
  border-radius: 6rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28rpx;
}

.num {
  padding: 0 20rpx;
  font-size: 26rpx;
}

.checkout-bar {
  position: fixed;
  bottom: var(--window-bottom, 0px);
  left: 0;
  right: 0;
  background: #fff;
  display: flex;
  align-items: center;
  padding: 20rpx 30rpx;
  box-shadow: 0 -2rpx 10rpx rgba(0, 0, 0, 0.05);
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

.check-all {
  display: flex;
  align-items: center;
  font-size: 26rpx;
  padding: 0;
  margin: 0;
  background: #fff;
}

.total-area {
  flex: 1;
  text-align: right;
  margin-right: 20rpx;
}

.total-price {
  color: var(--view-priceColor, #e93323);
  font-size: 36rpx;
  font-weight: 700;
}

.checkout-btn {
  line-height: 1.5;
  margin: 0;
  background: var(--view-theme, #e93323);
  color: #fff;
  border-radius: 40rpx;
  padding: 16rpx 50rpx;
  font-size: 28rpx;
}
.price-label { color: #9b5717; font-size: 22rpx; }
.line-total { color: #535763; font-size: 22rpx; margin-top: 4rpx; }
.promotion-parts { color: #9b5717; font-size: 21rpx; margin-top: 4rpx; line-height: 1.45; }
.estimate-note { color: #666; font-size: 22rpx; padding: 16rpx 0; }
.budget-panel { padding:24rpx; margin:20rpx 0; background:#fff; border-radius:12rpx; color:#535763; font-size:24rpx; line-height:1.6; }
.budget-title { color:var(--view-priceColor,#e93323); font-size:30rpx; font-weight:600; }
</style>
