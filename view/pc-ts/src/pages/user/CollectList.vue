<template>
  <div class="collect-list container">
    <h2 class="title">我的收藏</h2>
    <div v-if="productIds.length" class="goods-grid">
      <div
        v-for="item in products"
        :key="item.id"
        class="goods-card"
        @click="$router.push(`/goods/${item.id}`)"
      >
        <div class="goods-image">
          <img :src="item.image || placeholder" :alt="item.store_name" loading="lazy" />
        </div>
        <div class="goods-info">
          <div class="goods-name">{{ item.store_name }}</div>
          <div class="goods-bottom">
            <span class="price">¥{{ item.price }}</span>
          </div>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无收藏" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { apiCollectList } from "@/api/user";
import { apiGoodsList } from "@/api/product";
import type { GoodsItem } from "@/types/product";

const productIds = ref<number[]>([]);
const products = ref<GoodsItem[]>([]);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

onMounted(async () => {
  try {
    productIds.value = await apiCollectList();
    if (productIds.value.length) {
      // 后端商品列表支持 ids 参数 (逗号分隔)
      const result = await apiGoodsList({ ids: productIds.value.join(","), limit: 50 });
      products.value = result.list;
    }
  } catch (e) {
    console.error("收藏加载失败", e);
  }
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.goods-card {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
}

.goods-image {
  aspect-ratio: 1;
  background: #f8f8f8;
}

.goods-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.goods-info {
  padding: 12px;
}

.goods-name {
  font-size: 14px;
  height: 40px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.goods-bottom {
  display: flex;
  margin-top: 8px;
}

.price {
  color: #e64340;
  font-weight: 600;
}
</style>
