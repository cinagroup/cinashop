<template>
  <ThemePage>
    <view class="collection-page">
      <view class="collection-tabs"><view :class="{active:kind==='product'}" @tap="select('product')">商品收藏</view><view :class="{active:kind==='video'}" @tap="select('video')">视频收藏</view></view>
      <view class="list-tools"><text v-if="ready">共 {{ count }} 条收藏</text><button size="mini" :disabled="busy" @tap="load(true)">刷新</button></view>
      <view v-if="kind==='product' && productCards.length" class="collection-grid">
        <view v-for="item in productCards" :key="item.id" class="collection-card" :class="{unavailable:item.is_fail || item.available===false}">
          <view @tap="openProduct(item.id)"><image v-if="media(item.image)" class="cover" :src="media(item.image)" mode="aspectFill" /><view v-else class="missing-cover">图片暂不可用</view><view class="card-info"><view class="card-name">{{ item.store_name }}</view><text class="price">¥{{ item.price }}</text><text class="hint">{{ item.is_fail || item.available===false ? '商品已失效' : item.navigationHint }}</text></view></view>
          <button class="remove" :disabled="busy || !!error || !!mutationError" @tap="remove(item.id)">{{ removing===item.id?'正在取消...':'取消收藏' }}</button>
        </view>
      </view>
      <view v-else-if="kind==='video' && videos.length" class="collection-grid video-grid">
        <view v-for="item in videos" :key="item.id" class="collection-card" :class="{unavailable:!item.available || item.is_fail}">
          <view role="button" :aria-label="`播放 ${item.desc}`" @tap="openVideo(item.id)"><view class="video-cover"><image v-if="media(item.image)" class="cover" :src="media(item.image)" mode="aspectFill" /><view v-else class="missing-cover">视频封面暂不可用</view><text v-if="item.available && !item.is_fail" class="play-symbol">▶</text></view><view class="card-info"><view class="card-name">{{ item.desc || '未命名视频' }}</view><text class="video-author">{{ item.site_name }}</text><text class="hint">{{ item.available && !item.is_fail ? `${item.like_num} 人喜欢 · 点击播放` : '视频已失效，仍可取消收藏' }}</text></view></view>
          <button class="remove" :disabled="busy || !!error || !!mutationError" @tap="remove(item.id)">{{ removing===item.id?'正在取消...':'取消收藏' }}</button>
        </view>
      </view>
      <view v-if="loading" class="state">正在加载收藏...</view>
      <view v-if="error || mutationError || videoError" class="state error" role="alert"><text>{{ error || mutationError || videoError }}</text><button v-if="!auth.isLoggedIn" @tap="login">前往登录</button><button v-else :disabled="busy" @tap="load(true)">刷新核对</button></view>
      <view v-else-if="ready && !(kind==='product'?products.length:videos.length)" class="state">{{ count ? '部分收藏已失效或被移除，可继续翻页查看其他记录' : '暂无收藏' }}</view>
      <button v-if="hasMore" class="load-more" :disabled="busy || !!error || !!mutationError" @tap="load()">加载更多</button>
      <view v-if="playing" class="video-overlay" @tap="closeVideo"><view class="video-panel" @tap.stop><video :key="playing.id" class="player" :src="media(playing.video_url)" :poster="media(playing.image)" :controls="true" :autoplay="false" @error="playbackFailed" /><view class="playing-title">{{ playing.desc }}</view><button @tap="closeVideo">关闭视频</button></view></view>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { useUserCollections } from '@/composables/useUserCollections';
import { userCenterMedia as media } from '@/utils/userCenter';
const {auth,kind,products,productCards,videos,count,loading,ready,error,mutationError,removing,playing,videoError,hasMore,busy,load,select,login,remove,openProduct,openVideo,closeVideo,playbackFailed}=useUserCollections();
</script>
<style scoped>
.collection-page{padding:24rpx;max-width:1100rpx;margin:auto}.collection-tabs{display:flex;background:#fff;border-radius:20rpx;padding:22rpx;gap:24rpx}.collection-tabs>view{flex:1;text-align:center;font-size:30rpx;color:#777;padding:10rpx;border-bottom:4rpx solid transparent}.collection-tabs>view.active{color:var(--view-theme,#e93323);border-color:var(--view-theme,#e93323);font-weight:600}.list-tools{display:flex;align-items:center;justify-content:space-between;padding:22rpx 4rpx;color:#777;font-size:24rpx}.list-tools button{margin:0;font-size:24rpx}.collection-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20rpx}.collection-card{background:#fff;border-radius:20rpx;overflow:hidden;min-width:0}.cover,.missing-cover{width:100%;height:300rpx}.missing-cover{display:flex;justify-content:center;align-items:center;background:#f5f5f5;color:#999;font-size:24rpx}.card-info{padding:18rpx}.card-name{font-size:27rpx;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:76rpx}.price{display:block;font-size:32rpx;color:var(--view-priceColor,#e93323);font-weight:600;margin-top:12rpx}.hint,.video-author{display:block;color:#888;font-size:22rpx;margin-top:8rpx;line-height:1.5}.remove{font-size:24rpx;background:#fff;color:#777;border-top:1rpx solid #f4f4f4;border-radius:0;margin:0}.remove::after{border:0}.unavailable .cover{opacity:.55}.unavailable .card-name,.unavailable .price{color:#999}.video-cover{position:relative}.video-cover .cover,.video-cover .missing-cover{height:360rpx}.play-symbol{position:absolute;bottom:18rpx;right:18rpx;background:rgba(0,0,0,.4);color:#fff;padding:10rpx 16rpx;border-radius:50%;font-size:24rpx}.state{text-align:center;padding:38rpx 20rpx;font-size:27rpx;color:#777;line-height:1.7}.state button{font-size:27rpx;margin-top:24rpx}.error{color:#a43429}.load-more{font-size:27rpx;margin-top:24rpx}.video-overlay{position:fixed;z-index:1000;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24rpx;box-sizing:border-box}.video-panel{width:100%;max-width:1000rpx;border-radius:22rpx;background:#fff;overflow:hidden}.player{width:100%;height:520rpx}.playing-title{padding:24rpx;font-size:27rpx;line-height:1.6}.video-panel button{font-size:28rpx;margin:0;border-radius:0}
</style>
