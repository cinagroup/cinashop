<template>
  <view v-if="block.is_show && block.list.length" class="service" :class="`menu-style-${block.style}`" :data-module="module">
    <view class="service-title">{{ block.title }}</view>
    <view class="service-items">
      <template v-for="(item,index) in block.list" :key="index">
        <!-- #ifdef MP-WEIXIN -->
        <button v-if="contactType===1 && item.url==='/pages/extension/customer_list/chat'" class="service-item" open-type="contact">
          <image v-if="media(item.pic)&&!failed.has(index)" class="service-image" :src="media(item.pic)" @error="failImage(index)" mode="aspectFit" />
          <text v-else class="service-letter">{{ item.name.slice(0,1) }}</text><text class="service-label">{{ item.name }}</text><text class="arrow">›</text>
        </button>
        <view v-else class="service-item" role="button" :aria-label="item.name" @tap="emit('open',index)">
          <image v-if="media(item.pic)&&!failed.has(index)" class="service-image" :src="media(item.pic)" @error="failImage(index)" mode="aspectFit" />
          <text v-else class="service-letter">{{ item.name.slice(0,1) }}</text><text class="service-label">{{ item.name }}</text><text class="arrow">›</text>
        </view>
        <!-- #endif -->
        <!-- #ifndef MP-WEIXIN -->
        <view class="service-item" role="button" :aria-label="item.name" @tap="emit('open',index)">
          <image v-if="media(item.pic)&&!failed.has(index)" class="service-image" :src="media(item.pic)" @error="failImage(index)" mode="aspectFit" />
          <text v-else class="service-letter">{{ item.name.slice(0,1) }}</text><text class="service-label">{{ item.name }}</text><text class="arrow">›</text>
        </view>
        <!-- #endif -->
      </template>
    </view>
    <text v-if="failed.size" class="media-warning">部分菜单图片暂不可用</text>
  </view>
</template>
<script setup lang="ts">
import { ref,watch } from 'vue';
import type { PublicUserCenterDesignValue } from '../../../../common/userCenterDesign';
import { userCenterMedia as media } from '@/utils/userCenter';
const props=defineProps<{block:PublicUserCenterDesignValue['menu'];module:'menu'|'merMenu';contactType:number}>();
const emit=defineEmits<{open:[index:number]}>(),failed=ref(new Set<number>());
function failImage(index:number){failed.value=new Set([...failed.value,index]);}
watch(()=>props.block,()=>{failed.value=new Set();});
</script>
<style scoped>
.service{background:#fff;border-radius:24rpx;margin:24rpx 0;padding:28rpx}.service-title{font-size:30rpx;font-weight:600;margin-bottom:28rpx}.service-items{display:grid;gap:30rpx 18rpx;grid-template-columns:repeat(4,minmax(0,1fr))}.service-item{display:flex;align-items:center;flex-direction:column;gap:14rpx;min-width:0;border:0;background:none;padding:0;margin:0;font-size:26rpx;line-height:1.5}.service-item::after{border:0}.service-image,.service-letter{height:54rpx;width:54rpx;flex-shrink:0}.service-letter{display:flex;align-items:center;justify-content:center;border-radius:14rpx;background:#fff3f0;color:var(--view-theme,#e93323);font-weight:600}.service-label{max-width:100%;overflow-wrap:anywhere;text-align:center}.arrow{display:none;color:#999}.menu-style-2 .service-items{grid-template-columns:1fr;gap:0}.menu-style-2 .service-item{flex-direction:row;padding:22rpx 0;border-bottom:1rpx solid #f3f3f3}.menu-style-2 .service-label{flex:1;text-align:left}.menu-style-2 .arrow{display:block}.menu-style-2 .service-image,.menu-style-2 .service-letter{width:44rpx;height:44rpx}.menu-style-3{background:transparent;padding:0}.menu-style-3 .service-title{padding:0 8rpx}.menu-style-3 .service-items{grid-template-columns:repeat(3,minmax(0,1fr));gap:20rpx}.menu-style-3 .service-item{border-radius:24rpx;background:#fff;min-height:176rpx;justify-content:center;padding:20rpx 12rpx;box-sizing:border-box}.media-warning{display:block;font-size:22rpx;color:#99683d;margin-top:18rpx}
</style>
