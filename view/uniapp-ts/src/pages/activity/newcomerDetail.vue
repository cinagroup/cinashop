<template>
  <ThemePage>
  <view class="newcomer-detail">
    <view class="heading">新人专享商品</view>
    <view v-if="loading" class="notice" role="status">正在加载新人商品…</view>
    <view v-if="error" class="error" role="alert">{{ error }}</view>
    <button v-if="!auth.isLoggedIn" @tap="login">登录后查看</button>
    <button v-else size="mini" :disabled="loading" @tap="load">刷新商品</button>
    <view v-if="auth.isLoggedIn && (recovery || recoveryInvalid)" class="recovery" role="status">
      <view class="notice">此账号有待核对的新人购买。购买按钮会保持关闭，直至原购物行得到核对或你明确放弃。</view>
      <view v-if="recovery && recovery.activityId !== routeActivityId" class="notice">待核对活动 #{{ recovery.activityId }}</view>
      <button v-if="recovery && recovery.activityId !== routeActivityId" size="mini" :disabled="navigating" @tap="openRecoveryActivity">返回原活动</button>
      <button v-if="recovery?.state === 'acknowledged' && prepared !== null" size="mini" :disabled="!canBuy" @tap="purchase">继续原购物行结算</button>
      <button v-if="recovery?.state === 'acknowledged' && prepared === null" size="mini" :disabled="checking" @tap="verify">重新核对原购物行</button>
      <button v-if="recovery?.state === 'unknown'" size="mini" :disabled="preparing || buying || checking || recovery.activityId !== routeActivityId" @tap="retryOriginal">使用原编号核对请求</button>
      <button size="mini" :disabled="checking || preparing || buying" @tap="inspect">读取未结算购物行</button>
      <view v-for="candidate in candidates" :key="candidate.id" class="notice">购物行 #{{ candidate.id }} · {{ candidate.sku }} · {{ candidate.valid ? '当前有效' : '当前无效' }}</view>
      <button size="mini" :disabled="navigating" @tap="openOrders">查看订单</button>
      <button size="mini" :disabled="preparing || buying || checking || navigating" @tap="abandon">已核对，放弃原意图</button>
    </view>
    <view v-if="detail" class="product">
      <ProductMedia :images="detail.image?[detail.image]:[]" video="" :picture-config="activityDesign.pictureConfig" :dots="activityDesign.swiperDot" :active="visible"/>
      <view v-if="activityDesignError" class="notice">{{activityDesignError}}<button size="mini" @tap="reloadActivityDesign">重试展示设置</button></view>
      <ActivityDetailMenu :menu="activityDesign.menuList" :product-id="detail.id" :path="'/pages/activity/newcomerDetail?id='+detail.id" :title="detail.title" :image="detail.image" :active="visible"/>
      <view class="content">
        <view class="name">{{ detail.title }}</view>
        <view v-if="detail.description" class="notice">{{ detail.description }}</view>
        <view class="price">新人价 ¥{{ selectedSku?.price ?? detail.price }} <text v-if="Number(detail.originalPrice) > Number(selectedSku?.price ?? detail.price)" class="original">¥{{ detail.originalPrice }}</text></view>
        <view class="notice">基础商品库存快照 {{ detail.stock }}，下单以服务端实时校验为准</view>
        <view class="section-title">活动规格</view>
        <button v-for="sku in detail.skus" :key="sku.unique" size="mini" class="sku" :class="{ chosen: selected === sku.unique }"
          :disabled="preparing || buying || navigating || recovery !== null || recoveryInvalid" @tap="choose(sku.unique)">
          <image v-if="sku.image" :src="sku.image" mode="aspectFill" class="sku-image" />
          <view><view>{{ sku.name || '默认规格' }}</view><view class="sku-price">¥{{ sku.price }}</view></view>
        </button>
        <view v-if="!detail.skus.length" class="notice">当前没有可购买的活动规格</view>
        <view class="notice">新人专享限购 1 件。活动规格库存仅为配置快照，具体可购状态将在加购和结算时核验。</view>
        <button class="purchase" :disabled="!canBuy" @tap="purchase">{{ prepared !== null ? '继续结算' : buying ? '正在加购…' : preparing ? '正在准备…' : '立即购买' }}</button>
      </view>
    </view>
  </view>
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import ProductMedia from '@/components/productDetail/ProductMedia.vue';
import ActivityDetailMenu from '@/components/productDetail/ActivityDetailMenu.vue';
import {useActivityDetailDesign,useActivityDetailShare} from '@/composables/useActivityDetailDesign';
const {activityDesign,activityDesignError,reloadActivityDesign}=useActivityDetailDesign();
import { useNewcomerProduct } from '@/composables/useNewcomerProduct';
const { auth, detail, routeActivityId, selected, selectedSku, loading, preparing, buying, navigating, prepared, canBuy, error, visible,
  recovery, recoveryInvalid, checking, candidates, load, login, choose, purchase, retryOriginal, verify, inspect, abandon, openOrders, openRecoveryActivity } = useNewcomerProduct();
useActivityDetailShare(()=>detail.value?{title:detail.value.title,path:`/pages/activity/newcomerDetail?id=${detail.value.id}`,image:detail.value.image}:null,()=>visible.value);
</script>
<style scoped>
.newcomer-detail { max-width: 900px; margin: auto; padding: 24rpx 24rpx calc(60rpx + env(safe-area-inset-bottom)); overflow-wrap: anywhere; }
.recovery { margin: 18rpx 0; padding: 18rpx; border: 1rpx solid #e8c58f; border-radius: 12rpx; background: #fff9ed; }
.recovery button { margin: 12rpx 0; }
.heading { font-size: 38rpx; font-weight: 700; margin-bottom: 20rpx; }.notice { color: #67636a; font-size: 25rpx; line-height: 1.6; margin: 18rpx 0; }.error { color: #a62b22; padding: 18rpx; background: #fff0ee; margin-bottom: 14rpx; }
.product { border-radius: 18rpx; overflow: hidden; background: white; }.hero-image { width: 100%; height: 400rpx; background: #f5f5f5; }.content { padding: 26rpx; }.name { font-size: 34rpx; font-weight: 650; }.price { color: var(--view-priceColor, #e93323); font-size: 34rpx; margin: 22rpx 0; }.original { color: #888; text-decoration: line-through; font-size: 23rpx; }.section-title { font-size: 28rpx; font-weight: 600; margin: 26rpx 0 12rpx; }.sku { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 18rpx; margin: 0; padding: 18rpx 14rpx; border: 1rpx solid #ece7e4; border-radius: 12rpx; background: white; color: #262326; text-align: left; font-size: 27rpx; line-height: 1.35; }.sku + .sku { margin-top: 12rpx; }.sku::after { border: 0; }.sku.chosen { border-color: var(--view-priceColor, #e93323); background: #fff5f2; }.sku-image { flex: none; width: 70rpx; height: 70rpx; }.sku-price { color: var(--view-priceColor, #e93323); font-size: 24rpx; margin-top: 6rpx; }.purchase { margin-top: 22rpx; background: var(--view-priceColor, #e93323); color: white; }.purchase[disabled] { background: #d6d0ce; color: #696362; }
</style>
