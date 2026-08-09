<template>
  <view class="goods-list">
    <!-- 分类 tab (一级) -->
    <scroll-view scroll-x class="cate-bar" v-if="categories.length">
      <view
        class="cate-tab"
        :class="{ active: activeCateId === undefined }"
        @tap="switchCate(undefined)"
      >
        全部
      </view>
      <view
        class="cate-tab"
        v-for="cate in categories"
        :key="cate.id"
        :class="{ active: activeCateId === cate.id }"
        @tap="switchCate(cate.id)"
      >
        {{ cate.cate_name }}
      </view>
    </scroll-view>

    <!-- 排序栏 -->
    <view class="sort-bar">
      <view
        class="sort-item"
        :class="{ active: sortType === '' }"
        @tap="setSort('')"
      >
        综合
      </view>
      <view
        class="sort-item"
        :class="{ active: sortType === 'sales' }"
        @tap="setSort('sales')"
      >
        销量
      </view>
      <view
        class="sort-item"
        :class="{ active: sortType.startsWith('price') }"
        @tap="togglePrice"
      >
        价格 {{ sortType === "price_desc" ? "↓" : "↑" }}
      </view>
    </view>

    <!-- 商品网格 -->
    <view class="goods-grid">
      <view
        class="goods-card"
        v-for="item in goods"
        :key="item.id"
        @tap="goDetail(item.id)"
      >
        <image class="goods-image" :src="item.image || placeholder" mode="aspectFill" />
        <view class="goods-info">
          <view class="goods-name">{{ item.store_name }}</view>
          <view class="goods-bottom">
            <text class="price">¥{{ item.price }}</text>
            <text class="sales">已售 {{ item.sales }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="!goods.length && !loading" class="empty">暂无商品</view>

    <!-- 加载更多 -->
    <view v-if="goods.length && hasMore" class="load-more" @tap="loadMore">加载更多</view>
    <view v-if="goods.length && !hasMore" class="load-more">没有更多了</view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onReachBottom } from "@dcloudio/uni-app";
import { apiGoodsList, apiCategory } from "@/api/product";
import type { GoodsItem, CategoryNode } from "@/types/product";

const goods = ref<GoodsItem[]>([]);
const loading = ref(true);
const page = ref(1);
const limit = 10;
const hasMore = ref(true);
const sortType = ref("");
const keyword = ref("");
const cid = ref<number | undefined>();
const categories = ref<CategoryNode[]>([]);
const activeCateId = ref<number | undefined>();

const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function fetch(reset = false) {
  if (reset) {
    page.value = 1;
    goods.value = [];
  }
  loading.value = true;
  try {
    const params: Record<string, unknown> = { page: page.value, limit };
    if (keyword.value) params.keyword = keyword.value;
    if (cid.value) params.cid = cid.value;
    if (sortType.value === "sales") params.salesOrder = "desc";
    if (sortType.value === "price_asc") params.priceOrder = "asc";
    if (sortType.value === "price_desc") params.priceOrder = "desc";

    const result = await apiGoodsList(params);
    goods.value = goods.value.concat(result.list);
    hasMore.value = result.list.length >= limit;
    page.value += 1;
  } catch (e) {
    console.error("商品列表加载失败", e);
  } finally {
    loading.value = false;
  }
}

function setSort(type: string) {
  sortType.value = type;
  fetch(true);
}

/** 切换一级分类 tab */
function switchCate(cateId: number | undefined) {
  activeCateId.value = cateId;
  cid.value = cateId;
  fetch(true);
}

/** 从分类树中找 cid 所属的一级分类 (二级分类定位到父级高亮) */
function findParentId(tree: CategoryNode[], target: number): number | undefined {
  for (const n of tree) {
    if (n.id === target) return n.id;
    for (const child of n.children ?? []) {
      if (child.id === target) return n.id;
    }
  }
  return undefined;
}

function togglePrice() {
  sortType.value = sortType.value === "price_asc" ? "price_desc" : "price_asc";
  fetch(true);
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

function loadMore() {
  if (hasMore.value) fetch();
}

onLoad((options) => {
  keyword.value = (options?.keyword as string) ?? "";
  cid.value = options?.cid ? Number(options.cid) : undefined;
  fetch(true);
  // 加载一级分类 tab (并定位高亮)
  apiCategory()
    .then((tree) => {
      categories.value = tree;
      if (cid.value !== undefined) {
        activeCateId.value = findParentId(tree, cid.value);
      }
    })
    .catch(() => {
      /* 分类加载失败不影响商品列表 */
    });
});

onReachBottom(() => {
  if (hasMore.value) fetch();
});
</script>

<style scoped>
.goods-list {
  padding: 20rpx;
}

.cate-bar {
  white-space: nowrap;
  margin-bottom: 16rpx;
}

.cate-tab {
  display: inline-block;
  padding: 10rpx 28rpx;
  margin-right: 16rpx;
  font-size: 26rpx;
  color: #555;
  background: #f5f5f5;
  border-radius: 30rpx;
}

.cate-tab.active {
  color: #fff;
  background: #e93323;
  font-weight: 600;
}

.sort-bar {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
}

.sort-item {
  flex: 1;
  text-align: center;
  font-size: 28rpx;
  color: #555;
}

.sort-item.active {
  color: #e93323;
  font-weight: 600;
}

.load-more {
  text-align: center;
  color: #999;
  padding: 30rpx;
  font-size: 26rpx;
}
</style>
