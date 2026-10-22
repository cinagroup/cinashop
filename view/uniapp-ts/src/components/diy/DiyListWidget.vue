<template>
  <view v-if="active && config.enabled" class="diy-list-widget" :data-kind="config.kind" :data-component-key="config.identity" :data-layout="config.style" :style="config.wrapperStyle">
    <view v-if="loading" class="list-status" role="status">正在读取列表…</view>
    <view v-else-if="error" class="list-error" role="alert">{{error}}</view>
    <template v-else-if="loaded">
      <template v-if="config.kind==='goodList'">
        <view v-if="config.style===1" class="list-waterfall">
          <view v-for="(column,index) in columns" :key="index" class="list-column"><DiyListProductCard v-for="product in column" :key="product.id" :product="product" :config="config" :disabled="purchase.locked.value" :allowed="state.lease()" @open="openProduct" @action="productAction" @measured="measured" /></view>
        </view>
        <scroll-view v-else :scroll-x="config.style===5" :show-scrollbar="false"><view class="list-products" :class="`layout-${config.style}`"><DiyListProductCard v-for="product in products" :key="product.id" :product="product" :config="config" :disabled="purchase.locked.value" :allowed="state.lease()" @open="openProduct" @action="productAction" /></view></scroll-view>
        <view v-if="!products.length" class="list-empty">当前范围暂无商品</view>
      </template>
      <template v-else>
        <view class="list-articles" :class="`article-layout-${config.style}`">
          <view v-for="article in articles" :key="article.id" class="list-article" :data-article-id="article.id" :style="config.panelStyle" @tap="openArticle(article.id)">
            <image v-if="config.style!==0 && article.image_input[0]" class="article-image" :style="config.imageStyle" :src="article.image_input[0]" mode="aspectFill" />
            <view class="article-copy"><text class="article-title" :style="config.nameStyle">{{article.title}}</text>
              <image v-if="config.style===0 && article.image_input[0]" class="article-image" :style="config.imageStyle" :src="article.image_input[0]" mode="aspectFill" />
              <view class="article-meta" :style="config.statisticStyle"><text v-if="config.checks.includes(0)" class="article-time" :style="config.timeStyle">{{article.add_time}}</text><view class="article-counts"><text v-if="config.checks.includes(1)" class="article-visit"><text :style="config.browseStyle">◉ </text>{{article.visit}}</text><text v-if="config.checks.includes(2)" class="article-likes"><text :style="config.likeStyle">♡ </text>{{article.likes}}</text></view></view>
            </view>
          </view>
        </view>
        <view v-if="!articles.length" class="list-empty">当前分类暂无文章</view>
      </template>
      <view v-if="config.limitNotice" class="list-status">{{config.limitNotice}}</view>
    </template>
    <view v-if="notice" class="list-status" role="status">{{notice}}</view>
    <button class="list-retry" :disabled="loading" @tap="load">{{error?'重试当前列表':'刷新当前列表'}}</button>
    <view v-if="purchase.error.value" class="list-error" role="alert">{{purchase.error.value}}<button v-if="purchase.needsRefresh.value" @tap="purchase.reread">重新读取购物车</button><button v-if="purchase.needsRefresh.value" @tap="goCart">到购物车核对</button></view>
    <view v-if="purchase.opened.value" class="list-sku-mask" @tap="purchase.close"><view class="list-sku-modal" @tap.stop><view v-if="purchase.loading.value" class="list-status">正在读取规格…</view><CategorySkuSelection v-else-if="purchase.detail.value" :detail="purchase.detail.value" :selected="purchase.selected.value" :quantity="purchase.quantity.value" :maximum="purchase.maximum.value" :disabled="purchase.locked.value" :mode="purchase.mode.value" @choose="purchase.choose" @quantity="purchase.setQuantity" @step="purchase.step" @confirm="purchase.purchase" @close="purchase.close" /><view v-else class="list-status">{{purchase.error.value || '规格尚未读取'}}<button @tap="purchase.close">关闭</button></view></view></view>
  </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyListWidget } from '@/composables/useDiyListWidget';
import { openDiyLink } from '@/utils/diy';
import CategorySkuSelection from '@/components/category/CategorySkuSelection.vue';
import DiyListProductCard from './DiyListProductCard.vue';
const props = withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const state = useDiyListWidget(()=>props.block,()=>props.active);
const {config,products,articles,columns,loading,loaded,error,notice,purchase,load,openProduct,productAction,openArticle} = state;
function measured(row:{id:number;height:number;current:()=>boolean}){state.adoptMeasurements([row],row.current);}
function goCart(){if(props.active)openDiyLink('/pages/cart/index');}
</script>
<style scoped>
.diy-list-widget{width:100%;box-sizing:border-box;min-width:0;overflow-wrap:anywhere;}.list-products{display:grid;grid-template-columns:1fr;gap:16rpx;min-width:0;}.list-products.layout-2{grid-template-columns:repeat(3,minmax(0,1fr));}.list-products.layout-3{grid-template-columns:repeat(2,minmax(0,1fr));padding:24rpx;box-sizing:border-box;background:#fff;}.list-products.layout-5{display:flex;min-width:100%;width:max-content;}.layout-5>:deep(.diy-list-product){width:200rpx;flex-shrink:0;}.list-waterfall{display:flex;gap:16rpx;align-items:flex-start;}.list-column{display:flex;flex:1;min-width:0;flex-direction:column;gap:16rpx;}.list-articles{display:flex;flex-direction:column;gap:20rpx;}.list-article{display:flex;padding:20rpx;box-sizing:border-box;min-width:0;overflow:hidden;}.article-image{width:240rpx;height:152rpx;flex-shrink:0;}.article-copy{flex:1;min-width:0;padding-left:24rpx;}.article-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:30rpx;line-height:42rpx;}.article-meta{display:flex;align-items:center;gap:12rpx;margin-top:20rpx;font-size:23rpx;flex-wrap:wrap;}.article-time{flex:1;}.article-counts{display:flex;gap:20rpx;flex-wrap:wrap;}.article-layout-0 .list-article,.article-layout-2 .list-article{flex-direction:column;padding:0;}.article-layout-0 .article-copy{padding:32rpx 24rpx;}.article-layout-0 .article-image{display:block;width:100%;height:320rpx;margin-top:24rpx;}.article-layout-0 .article-title,.article-layout-2 .article-title{-webkit-line-clamp:1;}.article-layout-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;}.article-layout-2 .article-image{width:100%;height:216rpx;}.article-layout-2 .article-copy{padding:20rpx;}.article-layout-2 .article-meta{flex-direction:column;align-items:flex-start;}.list-status,.list-error,.list-empty{font-size:25rpx;padding:20rpx;}.list-error{color:#a32920;}.list-retry{font-size:24rpx;margin:12rpx 20rpx;}.list-sku-mask{position:fixed;inset:0;z-index:125;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;}.list-sku-modal{width:100%;background:#fff;max-height:80vh;overflow-y:auto;border-radius:24rpx 24rpx 0 0;}
</style>
