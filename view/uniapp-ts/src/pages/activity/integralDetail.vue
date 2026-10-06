<template>
  <ThemePage>
  <view class="integral-detail">
    <view class="navigation"><button size="mini" :disabled="buying || navigating" @tap="home">首页</button><button size="mini" :disabled="buying || navigating" @tap="mall">积分商城</button><button size="mini" :disabled="buying || navigating" @tap="cart">购物车</button></view>
    <view v-if="loading" class="notice" role="status">正在读取积分商品与规格…</view>
    <view v-if="error" class="error" role="alert">{{ error }}</view>
    <view v-if="referralNotice" class="notice" role="status">{{ referralNotice }}</view>
    <button v-if="!prepared" class="refresh" size="mini" :disabled="loading || locked" @tap="load">重新读取积分商品</button>
    <template v-if="detail">
      <view class="product">
        <ProductMedia :images="gallery" video="" :picture-config="detail.detailDisplay.data.design.pictureConfig" :dots="detail.detailDisplay.data.design.swiperDot" :active="visible"/><view v-if="!detail.detailDisplay.data.configured" class="notice">当前使用默认活动详情布局</view>
        <view class="section">
          <view class="title"><text v-if="detail.storeInfo.brandName" class="brand">{{ detail.storeInfo.brandName }}</text>{{ detail.storeInfo.storeName }}</view>
          <view v-if="selectedSku?.purchasable" class="price">{{ selectedSku.integral }}积分 + ¥{{ selectedSku.price }}<text v-if="selectedSku.otPrice !== '0.00'" class="original">参考价 ¥{{ selectedSku.otPrice }}</text></view>
          <view class="notice">已兑换 {{ detail.storeInfo.sales }} {{ detail.storeInfo.unitName || '件' }} · {{ detail.saleStock ? '选择规格后兑换' : '当前暂无可兑换规格' }}</view>
          <view v-if="detail.issues.includes('summary_price_invalid')" class="notice" role="status">商品默认报价资料异常，请选择资料有效的规格；不以默认值作为免费兑换报价。</view>
          <view class="labels"><view v-for="label in detail.storeInfo.storeLabel" :key="label.id" class="label"><image v-if="label.icon" class="small-icon" :src="label.icon" mode="aspectFit" />{{ label.labelName }}</view></view>
          <view v-if="detail.issues.length" class="notice" role="status">部分历史资料或规格暂不可用，可兑换规格仍可选择；请以最新结算复核结果为准。</view>
        </view>
      </view>
      <view class="section card">
        <view class="heading">兑换规则</view>
        <view class="notice">{{ detail.storeInfo.onceNum > 0 ? `每个订单限兑 ${detail.storeInfo.onceNum} 件` : '未设置每单限兑数量' }}；{{ detail.storeInfo.num > 0 ? `每人累计限兑 ${detail.storeInfo.num} 件` : '未设置累计限兑数量' }}。</view>
        <view class="notice">可兑库存取活动及商品各层剩余量。选择规格不会预留库存；累计限兑资格、所需积分、现金及配送费在加购和结算时重新校验。</view>
        <view v-if="detail.storeInfo.systemFormId" class="notice">此商品需要补充信息，请在订单确认页填写后提交。</view>
        <view v-if="detail.storeInfo.productType === 4" class="notice">此商品需要门店自提，提货信息在订单确认页选择。</view>
        <IntegralSkuSelection :detail="detail" :selected="selected" :quantity="quantity" :disabled="locked || loading || needsRefresh"
          @choose="choose" @quantity="setQuantity" @step="stepQuantity" />
      </view>
      <ActivityDetailContent :data="detail.detailDisplay.data" :product-id="detail.storeInfo.productId" :active="visible" :review-module="false"/>
      <view class="section card">
        <view class="heading">分享积分商品</view><view v-if="detail.siteName" class="notice">{{ detail.siteName }}</view>
        <!-- #ifdef MP-WEIXIN -->
        <button open-type="share" :disabled="buying || navigating">分享给朋友</button>
        <!-- #endif -->
        <button :disabled="buying || navigating" @tap="copyShare">复制商品链接</button>
        <!-- #ifdef APP-PLUS -->
        <button :disabled="buying || navigating || sharing" @tap="appShare">分享到微信朋友</button>
        <!-- #endif -->
        <button :disabled="buying || navigating || !selectedSku?.purchasable" @tap="togglePoster">{{ posterVisible ? '收起分享海报' : '生成分享海报' }}</button>
        <IntegralSharePoster v-if="posterVisible && shareUrl && selectedSku?.purchasable" :url="shareUrl" :title="detail.storeInfo.storeName"
          :image="selectedSku.image || detail.storeInfo.image" :price="selectedSku.price" :integral="selectedSku.integral" :site-name="detail.siteName" :tagline="detail.productPosterTitle" />
        <button :disabled="buying || navigating || collectionLoading || collectionSaving" @tap="toggleCollection">{{ collectionLoading ? '正在读取收藏状态' : collected === null ? '读取收藏状态' : collected ? '取消收藏关联商品' : '收藏关联商品' }}</button>
        <view v-if="collectionError" class="error" role="alert">{{ collectionError }}<button size="mini" :disabled="collectionLoading || collectionSaving" @tap="loadCollection">重新读取收藏状态</button></view>
        <view v-if="shareNotice" class="notice" role="status">{{ shareNotice }}</view>
      </view>
    </template>
    <view class="action-bar"><ActivityDetailMenu v-if="detail" :menu="detail.detailDisplay.data.design.menuList" :product-id="detail.storeInfo.productId" :path="'/pages/activity/integralDetail?id='+activityId" :title="detail.storeInfo.storeName" :image="detail.storeInfo.image" :active="visible"/><view v-if="totals" class="total">{{ totals.integral }}积分 + ¥{{ totals.cash }}</view><button class="buy-button" :disabled="!canBuy" :loading="buying || navigating" @tap="purchase">{{ prepared ? '继续结算' : detail?.storeInfo.systemFormId ? '填写补充信息并结算' : '去结算' }}</button></view>
  </view>
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import ProductMedia from '@/components/productDetail/ProductMedia.vue';
import ActivityDetailContent from '@/components/productDetail/ActivityDetailContent.vue';
import ActivityDetailMenu from '@/components/productDetail/ActivityDetailMenu.vue';
import { computed, ref, watch } from 'vue';
import { onShareAppMessage, onUnload } from '@dcloudio/uni-app';
import IntegralSkuSelection from '@/components/IntegralSkuSelection.vue';
import IntegralSharePoster from '@/components/IntegralSharePoster.vue';
import { useIntegralPurchase } from '@/composables/useIntegralPurchase';
import { useIntegralCollection } from '@/composables/useIntegralCollection';
import { useIntegralReferral } from '@/composables/useIntegralReferral';
import { integralShareUrl, shareIntegralInApp } from '@/utils/integralShare';
const purchaseFlow = useIntegralPurchase();
const { activityId, referral, detail, visible, selected, selectedSku, quantity, totals, loading, buying, navigating, locked, canBuy, error,
  prepared, needsRefresh, sharePath, choose, setQuantity, stepQuantity, load, purchase } = purchaseFlow;
const { collected, collectionLoading, collectionSaving, collectionError, loadCollection, toggleCollection } = useIntegralCollection(detail, visible);
const { referralNotice, disposeReferral } = useIntegralReferral(activityId, referral, visible);
const shareNotice = ref(''), sharing = ref(false), posterVisible = ref(false);
const shareUrl = computed(() => detail.value ? integralShareUrl(sharePath.value, detail.value.siteUrl) : '');
const gallery = computed(() => [...new Set([selectedSku.value?.image, ...(detail.value?.storeInfo.images ?? []), detail.value?.storeInfo.image].filter((value): value is string => !!value))]);
let shareGeneration = 0;
watch(detail, () => { shareNotice.value = ''; sharing.value = false; posterVisible.value = false; shareGeneration++; }, { flush: 'sync' });
function home() { if (!buying.value && !navigating.value) uni.switchTab({ url: '/pages/index/index' }); }
function mall() { if (!buying.value && !navigating.value) uni.navigateTo({ url: '/pages/user/integral' }); }
function cart() { if (!buying.value && !navigating.value) uni.switchTab({ url: '/pages/cart/index' }); }
function copyShare() {
  if (!detail.value || buying.value || navigating.value) return;
  if (!shareUrl.value) { shareNotice.value = '商家尚未配置可分享的站点链接'; return; }
  const current = shareGeneration;
  uni.setClipboardData({ data: shareUrl.value, success: () => { if(current===shareGeneration)shareNotice.value = '商品链接已复制'; }, fail: () => { if(current===shareGeneration)shareNotice.value = '复制失败，请重试'; } });
}
function appShare() {
  if (!detail.value || buying.value || navigating.value || sharing.value) return;
  const current=shareGeneration;sharing.value=true;
  shareIntegralInApp({url:shareUrl.value,title:detail.value.storeInfo.storeName,image:selectedSku.value?.image || detail.value.storeInfo.image,summary:detail.value.productPosterTitle},message=>{
    if(current!==shareGeneration)return;sharing.value=false;shareNotice.value=message;
  },()=>current===shareGeneration && visible.value);
}
function togglePoster() {if(!shareUrl.value){shareNotice.value='商家尚未配置可分享的站点链接';return;}posterVisible.value=!posterVisible.value;}
onUnload(()=>{purchaseFlow.dispose();disposeReferral();shareGeneration++;});
onShareAppMessage(() => ({ title: detail.value?.storeInfo.storeName || '积分商城', path: sharePath.value, imageUrl: detail.value?.storeInfo.image || '' }));
</script>
<style scoped>
.integral-detail {padding:20rpx 20rpx calc(170rpx + env(safe-area-inset-bottom));font-size:27rpx;overflow-wrap:anywhere;}
.integral-detail .action-bar{flex-wrap:wrap}.integral-detail{padding-bottom:260rpx}
.navigation {display:flex;gap:14rpx;flex-wrap:wrap;margin-bottom:20rpx;}.navigation button {margin:0;}
.product,.card {background:#fff;border-radius:16rpx;margin-bottom:20rpx;overflow:hidden;}.section {padding:24rpx;}
.gallery {height:500rpx;}.product-image {width:100%;height:100%;background:#f5f5f5;}.image-placeholder {padding:120rpx 20rpx;text-align:center;background:#f5f5f5;color:#777;}
.title {font-size:34rpx;font-weight:600;line-height:1.6;}.brand {display:inline-block;font-size:23rpx;margin-right:12rpx;color:var(--view-theme, #e93323);}
.heading {font-size:30rpx;font-weight:600;margin-bottom:18rpx;}.price {font-size:36rpx;color:var(--view-priceColor, #e93323);margin-top:20rpx;}.original {display:block;color:#888;font-size:23rpx;text-decoration:line-through;margin-top:10rpx;}
.notice {font-size:25rpx;color:#666;line-height:1.7;margin:16rpx 0;white-space:pre-wrap;}.error {padding:20rpx;color:#a72823;background:#fff0ed;line-height:1.7;margin-bottom:20rpx;}.refresh {margin:0 0 20rpx;}
.labels {display:flex;flex-wrap:wrap;gap:12rpx;}.label {display:flex;align-items:center;gap:8rpx;border:1rpx solid #ead5b4;border-radius:8rpx;padding:4rpx 10rpx;color:#805b27;font-size:23rpx;}
.small-icon {width:40rpx;height:40rpx;flex-shrink:0;}.ensure {display:flex;gap:16rpx;align-items:flex-start;margin-top:18rpx;}.ensure-name {font-weight:600;}.ensure>view {min-width:0;flex:1;}.spec {display:flex;gap:20rpx;padding:16rpx 0;border-bottom:1rpx solid #eee;line-height:1.6;white-space:pre-wrap;}.spec>text:first-child {width:180rpx;flex-shrink:0;color:#666;}.spec>text:last-child {flex:1;min-width:0;}
.description {overflow-x:auto;}.action-bar {position:fixed;left:0;right:0;bottom:0;background:#fff;box-shadow:0 -2rpx 10rpx #0001;padding:18rpx 24rpx calc(18rpx + env(safe-area-inset-bottom));z-index:8;display:flex;align-items:center;gap:20rpx;}.total {flex:1;min-width:0;font-size:26rpx;color:var(--view-priceColor, #e93323);}.buy-button {margin:0;background:var(--view-theme, #e93323);color:#fff;font-size:27rpx;white-space:normal;line-height:1.6;padding:18rpx 28rpx;}.buy-button[disabled] {background:#eee;color:#888;}
@media(min-width:800px) {.integral-detail {max-width:960px;margin:0 auto;}.gallery {height:480px;}.action-bar {max-width:960px;box-sizing:border-box;left:50%;transform:translateX(-50%);}}
</style>
