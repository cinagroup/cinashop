<template>
  <view class="cate-page">
    <!-- 左侧一级分类 -->
    <scroll-view scroll-y class="cate-left">
      <view
        v-for="(cate, idx) in categories"
        :key="cate.id"
        class="cate-left-item"
        :class="{ active: activeIndex === idx }"
        @tap="activeIndex = idx"
      >
        <image v-if="cate.pic" :src="cate.pic" class="cate-left-icon" mode="aspectFill" />
        <text class="cate-left-text">{{ cate.cate_name }}</text>
      </view>
      <view v-if="!categories.length" class="left-empty">暂无分类</view>
    </scroll-view>

    <!-- 右侧二级分类 -->
    <scroll-view scroll-y class="cate-right">
      <view v-if="current" class="cate-right-head">
        <text class="head-name">{{ current.cate_name }}</text>
        <text class="head-all" @tap="goList(current.id)">查看全部 ›</text>
      </view>

      <view v-if="current?.children?.length" class="child-list">
        <view
          class="child-item"
          v-for="child in current.children"
          :key="child.id"
          @tap="goList(child.id)"
        >
          <image v-if="child.pic" :src="child.pic" class="child-icon" mode="aspectFill" />
          <text class="child-name">{{ child.cate_name }}</text>
        </view>
      </view>
      <view v-else-if="current" class="empty">
        <text>该分类下暂无子分类</text>
        <text class="empty-all" @tap="goList(current.id)">去逛逛 ›</text>
      </view>
    </scroll-view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { apiCategory } from "@/api/product";
import type { CategoryNode } from "@/types/product";

const categories = ref<CategoryNode[]>([]);
const activeIndex = ref(0);

const current = computed(() => categories.value[activeIndex.value]);

function goList(cid: number) {
  uni.navigateTo({ url: `/pages/goods/list?cid=${cid}` });
}

/** 从首页分类入口跳转 (switchTab + storage) 时定位到对应一级分类 */
function locateFromStorage() {
  const cid = Number(uni.getStorageSync("cate_selected") ?? 0);
  if (!cid) return;
  const idx = categories.value.findIndex((c) => c.id === cid);
  if (idx < 0) return; // 数据未就绪, 保留 storage 等数据到位后再定位
  uni.removeStorageSync("cate_selected");
  activeIndex.value = idx;
}

onShow(locateFromStorage);

onMounted(async () => {
  try {
    categories.value = await apiCategory();
    // 首次进入 onShow 时数据可能未到位, 数据到位后再定位
    locateFromStorage();
  } catch (e) {
    console.error("分类加载失败", e);
  }
});
</script>

<style scoped>
.cate-page {
  display: flex;
  height: 100vh;
}

.cate-left {
  width: 180rpx;
  background: #f8f8f8;
  flex-shrink: 0;
}

.cate-left-item {
  padding: 30rpx 20rpx;
  font-size: 26rpx;
  color: #555;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6rpx;
}

.cate-left-icon {
  width: 56rpx;
  height: 56rpx;
  border-radius: 12rpx;
}

.cate-left-text {
  font-size: 24rpx;
}

.cate-left-item.active {
  background: #fff;
  color: #e93323;
  font-weight: 600;
  border-left: 6rpx solid #e93323;
}

.left-empty {
  padding: 40rpx 0;
  text-align: center;
  color: #999;
  font-size: 24rpx;
}

.cate-right {
  flex: 1;
  background: #fff;
  padding: 20rpx;
}

.cate-right-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10rpx 6rpx 20rpx;
  border-bottom: 2rpx solid #f5f5f5;
}

.head-name {
  font-size: 30rpx;
  font-weight: 700;
  color: #333;
}

.head-all {
  font-size: 24rpx;
  color: #999;
}

.child-list {
  display: flex;
  flex-wrap: wrap;
}

.child-item {
  width: 33.3%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24rpx 0;
}

.child-icon {
  width: 100rpx;
  height: 100rpx;
  border-radius: 16rpx;
}

.child-name {
  font-size: 24rpx;
  margin-top: 10rpx;
  color: #333;
}

.empty {
  padding: 80rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16rpx;
  color: #999;
  font-size: 26rpx;
}

.empty-all {
  color: #e93323;
  font-size: 26rpx;
}
</style>
