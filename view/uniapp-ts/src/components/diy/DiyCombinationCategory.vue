<template>
  <view class="combination-products" :data-category="id">
    <scroll-view v-if="children.length" scroll-x :show-scrollbar="false" class="combination-children"><view class="combination-child-row"><view v-for="item in children" :key="item.id" class="combination-child" :class="{selected:child===item.id}" :data-category="item.id" @tap="choose(item.id)"><image v-if="item.pic" :src="safeDiyImageUrl(item.pic)" mode="aspectFill" /><text>{{item.cate_name}}</text></view></view></scroll-view>
    <view class="combination-product-grid"><view v-for="(column,i) in columns" :key="i" class="combination-product-column"><DiyListProductCard v-for="product in column" :key="product.id" :product="product" :config="cardConfig" :disabled="true" :allowed="state.lease()" @open="open" @measured="state.adoptMeasurements" /></view></view>
    <view v-if="error" class="combination-status" role="alert">{{error}}<button @tap="retry">重试当前分类</button></view>
    <view v-else-if="loading" class="combination-status" role="status">正在读取分类商品…</view>
    <view v-else-if="loaded && !products.length" class="combination-status">当前分类暂无商品</view>
    <button v-else-if="more && products.length" class="combination-more" @tap="loadMore">加载更多</button>
    <view v-else-if="loaded" class="combination-status">已显示全部商品</view>
    <view v-if="notice" class="combination-status" role="status">{{notice}}</view>
  </view>
</template>
<script setup lang="ts">
import { computed, watch } from 'vue';
import { useThemeStore } from '@/stores/theme';
import { useDiyCombinationCategory } from '@/composables/useDiyCombinationCategory';
import { normalizeDiyList } from '@/utils/diyListConfig';
import { safeDiyImageUrl } from '@/utils/diy';
import DiyListProductCard from './DiyListProductCard.vue';
const props=withDefaults(defineProps<{id:number;active?:boolean;loadMoreSignal?:number}>(),{active:true,loadMoreSignal:0});
const state=useDiyCombinationCategory(()=>props.id,()=>props.active),theme=useThemeStore();
const {children,child,products,columns,loading,error,notice,loaded,more,loadMore,reload,choose,open}=state;
const cardConfig=computed(()=>normalizeDiyList({name:'goodList',styleConfig:{tabVal:1},typeConfig:{activeValue:3},classList:{classVal:[props.id]},cartConfig:{tabVal:1},checkboxInfo:{type:[0,1,2,3,4,5]}},theme.preset));
function retry(){if(children.value.length||products.value.length)void loadMore();else void reload();}
watch(()=>props.loadMoreSignal,()=>{if(props.active)void loadMore();});
</script>
<style scoped>
.combination-products{padding:20rpx;min-width:0;box-sizing:border-box;}.combination-children{background:#fff;border-radius:20rpx;margin-bottom:20rpx;}.combination-child-row{display:flex;width:max-content;min-width:100%;padding:20rpx;box-sizing:border-box;gap:24rpx;}.combination-child{display:flex;flex-direction:column;align-items:center;font-size:24rpx;max-width:150rpx;flex-shrink:0;}.combination-child image{width:90rpx;height:90rpx;border-radius:50%;}.combination-child.selected{color:var(--view-theme,#e93323);font-weight:bold;}.combination-product-grid{display:flex;gap:20rpx;align-items:flex-start;}.combination-product-column{flex:1;min-width:0;display:flex;flex-direction:column;gap:20rpx;}.combination-status{padding:24rpx;text-align:center;color:#888;font-size:26rpx;}.combination-more{margin:20rpx;font-size:26rpx;}
</style>
