<template>
  <ThemePage>
  <view class="integral-page">
    <!-- 我的积分 -->
    <view class="points-card">
      <view class="points-label">我的积分</view>
      <view class="points-num">{{ points }}</view>
      <view class="points-action" @tap="goSign">✍️ 去签到</view>
    </view>
    <view class="logs-link" @tap="goLogs">📊 积分明细 ›</view>

    <view v-if="listLoading" class="empty" role="status">正在读取积分商城…</view>
    <view v-if="listError" class="list-error" role="alert">{{ listError }}</view>
    <button size="mini" :disabled="listLoading || locked" @tap="load">刷新积分商城</button>
    <!-- 积分商品 -->
    <view v-if="list.length" class="goods-grid">
      <view v-for="g in list" :key="g.id" class="goods-card">
        <image
          class="goods-image"
          :src="integralImage(g.image) || placeholder"
          mode="aspectFill"
          @tap="openDetail(g.id)"
        />
        <view class="goods-info">
          <view class="goods-name">{{ g.title }}</view>
          <view class="goods-bottom">
            <view class="integral-price">
              <text class="int-val">{{ g.integral }}</text>
              <text class="int-unit">积分</text>
              <text v-if="Number(g.price) > 0" class="cash-price">+¥{{ g.price }}</text>
            </view>
            <button class="exchange-btn" size="mini" :disabled="locked" @tap="exchange(g)">选择兑换规格</button>
          </view>
          <view class="goods-stock" v-if="Number(g.stock) <= 0">已兑完</view>
        </view>
      </view>
    </view>
    <view v-else-if="!listLoading && !listError" class="empty">暂无积分商品</view>

    <view v-if="skuVisible" class="mask" @tap="closeSku()">
      <view class="sku-sheet" @tap.stop>
        <view class="sku-title">{{ pendingDetail?.storeInfo.storeName }}</view>
        <view v-if="detailLoading" class="sheet-notice" role="status">正在读取规格…</view>
        <view v-if="purchaseError" class="list-error" role="alert">{{ purchaseError }}</view>
        <button v-if="!prepared" size="mini" :disabled="detailLoading || locked" @tap="reloadDetail">重新读取商品</button>
        <view class="sheet-scroll">
          <IntegralSkuSelection v-if="pendingDetail" :detail="pendingDetail" :selected="selected" :quantity="quantity"
            :disabled="locked || detailLoading || needsRefresh" @choose="choose" @quantity="setQuantity" @step="stepQuantity" />
          <view v-if="pendingDetail" class="sheet-notice">每单限兑 {{ pendingDetail.storeInfo.onceNum || '未设置' }} 件；累计限兑 {{ pendingDetail.storeInfo.num || '未设置' }} 件。库存、限购及最终积分与现金在结算时复核。</view>
          <view v-if="pendingDetail?.storeInfo.systemFormId" class="sheet-notice">订单确认页需要填写商品补充信息。</view>
        </view>
        <view class="sku-actions">
          <button :disabled="locked" @tap="closeSku()">取消</button>
          <button class="confirm-button" :disabled="!canBuy" :loading="submitting || navigating" @tap="confirmExchange">{{ prepared ? '继续结算' : '去结算' }}</button>
        </view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref, watch } from "vue";
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { http } from "@/utils/request";
import { apiIntegralList, type IntegralListItem } from "@/api/activity";
import IntegralSkuSelection from '@/components/IntegralSkuSelection.vue';
import { useIntegralPurchase } from '@/composables/useIntegralPurchase';
import { useAuthStore } from '@/stores/auth';
import { integralImage, integralDetailUrl } from '../../../../common/integralPurchase';
const auth = useAuthStore(), purchase = useIntegralPurchase('dialog');
const { active: skuVisible, detail: pendingDetail, selected, quantity, locked, loading: detailLoading,
  buying: submitting, navigating, error: purchaseError, prepared, needsRefresh, canBuy, choose, setQuantity, stepQuantity,
  load: reloadDetail, close: closeSku, purchase: confirmExchange } = purchase;
const list = ref<IntegralListItem[]>([]);
const points = ref('未登录'), listLoading = ref(false), listError = ref('');
let visible = false, generation = 0, disposed = false;
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function load() {
  if (!visible || disposed || locked.value) return;
  const current = ++generation;
  listLoading.value = true; listError.value = ''; points.value = auth.isLoggedIn ? '读取中' : '未登录';
  try {
    const rows = await apiIntegralList({ page: 1, limit: 20 });
    if (current !== generation || !visible || disposed) return;
    list.value = rows;
  } catch (e) {
    if (current === generation && visible) listError.value = e instanceof Error ? e.message : '积分商城读取失败';
  } finally {
    if (current === generation) listLoading.value = false;
  }
  if (!auth.isLoggedIn || current !== generation || !visible) return;
  try {
    const info = await http.get<Record<string, unknown>>("/user/info");
    if (current === generation && visible && !disposed) points.value = typeof info.integral === 'number' && Number.isFinite(info.integral) && info.integral >= 0
      || typeof info.integral === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(info.integral) ? String(info.integral) : '暂不可读';
  } catch {
    if (current === generation && visible) points.value = '暂不可读';
  }
}
async function exchange(item: IntegralListItem) {
  await purchase.open(item.id);
}
function openDetail(id: number) { if (!locked.value) uni.navigateTo({ url: integralDetailUrl(id) }); }

function goSign() {
  uni.navigateTo({ url: "/pages/user/sign" });
}

function goLogs() {
  uni.navigateTo({ url: "/pages/user/integralLogs" });
}

watch(() => [auth.sessionVersion, auth.token, auth.uid], () => { generation++; list.value = []; points.value = auth.isLoggedIn ? '待读取' : '未登录'; listLoading.value = false; listError.value = ''; }, { flush: 'sync' });
onShow(() => { if (!disposed) { visible = true; purchase.show(); void load(); } });
onHide(() => { visible = false; generation++; listLoading.value = false; purchase.suspend(); });
onUnload(() => { disposed = true; visible = false; generation++; purchase.dispose(); });
</script>

<style scoped>
.integral-page {
  padding: 20rpx;
}

.points-card {
  background: linear-gradient(135deg, var(--view-theme, #e93323), var(--view-gradient, #FF7931));
  border-radius: 16rpx;
  padding: 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
  display: flex;
  align-items: center;
}

.points-label {
  font-size: 24rpx;
  opacity: 0.9;
}

.points-num {
  font-size: 48rpx;
  font-weight: 700;
  flex: 1;
  padding-left: 20rpx;
}

.points-action {
  font-size: 24rpx;
  background: rgba(255, 255, 255, 0.2);
  padding: 10rpx 20rpx;
  border-radius: 28rpx;
}

.goods-grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
}

.goods-card {
  width: 48%;
  background: #fff;
  border-radius: 12rpx;
  margin-bottom: 20rpx;
  overflow: hidden;
  position: relative;
}

.goods-image {
  width: 100%;
  height: 300rpx;
  background: #f7f7f7;
}

.goods-info {
  padding: 16rpx;
}

.goods-name {
  font-size: 26rpx;
  height: 72rpx;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.goods-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10rpx;
}

.integral-price {
  display: flex;
  align-items: baseline;
}

.int-val {
  font-size: 32rpx;
  font-weight: 700;
  color: var(--view-theme, #e93323);
}

.int-unit {
  font-size: 20rpx;
  color: var(--view-theme, #e93323);
}

.cash-price {
  font-size: 20rpx;
  color: #999;
  margin-left: 6rpx;
}

.exchange-btn {
  background: var(--view-theme, #e93323);
  color: #fff;
  font-size: 24rpx;
  padding: 8rpx 20rpx;
  border-radius: 26rpx;
}

.goods-stock {
  position: absolute;
  top: 120rpx;
  left: 0;
  right: 0;
  text-align: center;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 26rpx;
  padding: 10rpx 0;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 100rpx 0;
}

.logs-link {
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  font-size: 26rpx;
  color: #666;
  margin-bottom: 20rpx;
}

.mask { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, 0.5); display: flex; align-items: flex-end; }
.sku-sheet { width: 100%; max-height: 80vh; display:flex; flex-direction:column; padding: 28rpx 20rpx calc(28rpx + env(safe-area-inset-bottom)); box-sizing: border-box; background: #f5f5f5; border-radius: 24rpx 24rpx 0 0; }
.sheet-scroll {max-height:48vh;min-height:0;overflow-y:auto;}.sheet-notice {font-size:24rpx;line-height:1.7;color:#666;margin:16rpx 0;overflow-wrap:anywhere;}.list-error {color:#a72823;background:var(--view-minorColorT, rgba(233, 51, 35, 0.1));padding:16rpx;margin:16rpx 0;font-size:25rpx;line-height:1.7;overflow-wrap:anywhere;}
.sku-title { font-size: 30rpx; font-weight: 600; margin-bottom: 20rpx; }
.sku-options { display: flex; flex-wrap: wrap; gap: 14rpx; max-height: 42vh; overflow-y: auto; }
.sku-option { display: flex; flex-direction: column; gap: 6rpx; min-width: 200rpx; padding: 16rpx; background: #fff; border: 2rpx solid #eee; border-radius: 12rpx; font-size: 24rpx; }
.sku-option.active { color: var(--view-theme, #e93323); border-color: var(--view-theme, #e93323); }
.sku-option.disabled { opacity: 0.45; }
.quantity-row { display: flex; align-items: center; justify-content: space-between; margin-top: 24rpx; }
.quantity-stepper { display: flex; align-items: center; gap: 20rpx; }
.quantity-stepper button { margin: 0; }
.sku-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16rpx; padding-top: 24rpx; }
.confirm-button { background: var(--view-theme, #e93323); color: #fff; }
</style>
