<template>
  <view class="bargain-detail">
    <view class="heading">{{ mine ? '我的砍价' : '砍价详情' }}</view>
    <view v-if="loading" class="notice">正在加载砍价…</view>
    <view v-if="error" class="error">{{ error }}</view>
    <button v-if="!prepared" size="mini" :disabled="loading || locked" @tap="load()">{{ mine ? '刷新我的砍价' : '刷新活动与资格' }}</button>
    <button v-if="!mine" size="mini" :disabled="loading || locked" @tap="goMine">我的砍价</button>
    <button v-if="!loggedIn" :disabled="loading || locked" @tap="login">登录后查看与参与</button>
    <view v-if="mine">
      <view v-for="row in records" :key="row.id" class="record">
        <view class="heading">{{ row.title }}</view>
        <view class="notice">记录 #{{ row.id }} · {{ row.ready ? '可购买' : statusText(row.status) }}</view>
        <view v-if="row.amountsValid" class="notice">当前 ¥{{ row.current }} · 底价 ¥{{ row.minimum }} · 已砍 ¥{{ row.cut }} · {{ row.progress }}%</view>
        <view v-else class="error">金额异常，暂不可购买，请刷新确认</view>
        <button :disabled="loading || locked" @tap="chooseRecord(row.id)">查看这条砍价记录</button>
      </view>
      <view v-if="loggedIn && !loading && !error && !records.length" class="notice">当前页暂无砍价记录</view>
      <view v-if="loggedIn" class="pagination">
        <button size="mini" :disabled="loading || locked || page <= 1" @tap="load(page - 1)">上一页</button>
        <text>第 {{ page }} 页</text>
        <button size="mini" :disabled="loading || locked || !!error || records.length < 20 || page >= 10000" @tap="load(page + 1)">下一页</button>
      </view>
    </view>
    <view v-else-if="detail" class="product">
      <image class="goods-img" :src="selectedSku?.image || detail.image || placeholder" mode="aspectFit" />
      <view class="info-section">
        <view class="heading">{{ detail.title }}</view>
        <view class="notice">{{ open ? '活动进行中' : '活动未开始或已结束' }} · 起价 ¥{{ detail.activity_price }} · 活动底价 ¥{{ detail.minimum_price }}</view>
        <view v-if="detail.participation" class="participation">
          <view class="heading">记录 #{{ detail.participation.id }} · {{ stateText(detail.participation.state) }}</view>
          <view class="price">当前价 ¥{{ detail.participation.current_price }}</view>
          <view class="notice">底价 ¥{{ detail.participation.minimum_price }} · 已砍 ¥{{ detail.participation.cut_price }} · 还需砍 ¥{{ detail.participation.remaining_cut }}</view>
          <view class="progress"><view :style="{ width: detail.participation.progress_percent + '%' }" /></view>
          <view class="notice">进度 {{ detail.participation.progress_percent }}%</view>
          <view v-if="detail.participation.activity_price_changed" class="error">活动起价已调整。当前价不等于结算参考价，请核对后再购买。</view>
        </view>
        <view v-else class="notice">{{ loggedIn ? '尚未参与，发起后可帮自己砍一刀。' : '登录后确认本人砍价资格；不会自动发起砍价。' }}</view>
        <view class="heading">选择活动规格</view>
        <button v-for="sku in detail.skus" :key="sku.unique" class="sku" :class="{ selected: selected === sku.unique }"
          :disabled="locked || loading || sku.max_quantity < 1" @tap="choose(sku.unique)">
          {{ sku.suk || '默认规格' }}{{ sku.catalog_price === null ? '' : ' · 参考价 ¥' + sku.catalog_price }}{{ sku.max_quantity < 1 ? ' · 已售罄' : '' }}
        </button>
        <view v-if="!detail.skus.length" class="notice">暂无可购买规格</view>
        <view class="quantity-row"><text>购买数量</text><input aria-label="购买数量" type="number" :value="quantity" :disabled="locked || loading" @input="setQuantity" /></view>
        <view v-if="selectedSku" class="notice">当前规格最多 {{ selectedSku.max_quantity }} 件</view>
        <view class="notice">仅砍至底价且仍有效的本人记录可购买。目录不锁库存，金额与资格以服务端结算复核为准。</view>
        <button v-if="canStart" :disabled="locked" @tap="startBargain">发起砍价</button>
        <button v-if="canHelp" :disabled="locked" @tap="helpSelf">帮自己砍一刀</button>
      </view>
    </view>
    <view v-if="!mine" class="action-bar"><button class="buy-btn" :disabled="!canBuy" :loading="buying || navigating" @tap="purchase">{{ prepared ? '继续结算' : '购买所选砍价规格' }}</button></view>
    <DiySuspendedNavigation />
  </view>
</template>

<script setup lang="ts">
import { useBargainPurchase } from '@/composables/useBargainPurchase';
const { mine, records, page, loggedIn, detail, selected, quantity, selectedSku, loading, buying, navigating, error, prepared,
  open, locked, canBuy, canStart, canHelp, choose, load, login, goMine, chooseRecord, purchase, startBargain, helpSelf } = useBargainPurchase();
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";
function statusText(status: number) { return ({ 1: '砍价中', 2: '已关闭', 3: '待复核资格', 4: '已使用' } as Record<number, string>)[status] || '未知'; }
function stateText(state: string) { return ({ cutting: '砍价中', ready: '可购买', closed: '已关闭', used: '已使用' } as Record<string, string>)[state] || '未知'; }
function setQuantity(event: unknown) {
  const payload = event as { detail?: { value?: unknown }; target?: { value?: unknown } };
  const value = payload.detail?.value ?? payload.target?.value, raw = typeof value === 'string' ? value : '';
  quantity.value = /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : raw;
}
</script>

<style scoped>
.bargain-detail { padding: 24rpx 24rpx calc(150rpx + env(safe-area-inset-bottom)); }
.heading { font-size: 32rpx; font-weight: 600; overflow-wrap: anywhere; margin: 20rpx 0; }
.product, .record { margin-top: 24rpx; background: white; border-radius: 16rpx; overflow: hidden; }
.record, .info-section { padding: 24rpx; }
.goods-img { width: 100%; height: 440rpx; background: #f5f5f5; }
.notice { margin: 18rpx 0; font-size: 25rpx; color: #666; line-height: 1.6; }
.error { padding: 20rpx; color: #a72823; background: #fff0ed; margin-bottom: 20rpx; }
.price { color: #b72a1d; margin: 24rpx 0; font-size: 34rpx; }
.sku { margin-top: 16rpx; font-size: 26rpx; }
.selected { color: #ad261d; border: 2rpx solid #e93323; }
.progress { height: 14rpx; background: #ffe9e5; border-radius: 8rpx; overflow: hidden; }
.progress > view { height: 100%; background: #e93323; }
.quantity-row { display: flex; gap: 20rpx; align-items: center; font-size: 28rpx; margin-top: 24rpx; }
.quantity-row input { width: 140rpx; padding: 12rpx; border: 1rpx solid #aaa; }
.pagination { display: flex; align-items: center; gap: 16rpx; padding: 20rpx 0; font-size: 24rpx; }
.action-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom)); background: white; box-shadow: 0 -2rpx 10rpx #0001; }
.buy-btn { background: #e93323; color: white; font-size: 30rpx; }
.buy-btn[disabled] { background: #eee; color: #777; }
</style>
