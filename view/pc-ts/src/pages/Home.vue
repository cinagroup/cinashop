<template>
  <div class="home container">
    <!-- 营销入口 -->
    <div class="marketing-bar">
      <div class="marketing-item" @click="$router.push('/seckill')">
        <span class="marketing-icon">⚡</span>
        <span>限时秒杀</span>
      </div>
      <div class="marketing-item" @click="$router.push('/combination')">
        <span class="marketing-icon">👥</span>
        <span>多人拼团</span>
      </div>
    </div>

    <!-- 推荐商品 -->
    <section class="section">
      <h2 class="section-title">为你推荐</h2>
      <div v-if="loading" class="loading">
        <el-skeleton :rows="6" animated />
      </div>
      <div v-else class="goods-grid">
        <div
          v-for="item in goods"
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
              <span class="sales">已售 {{ item.sales }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 分类快捷入口 -->
    <section class="section">
      <h2 class="section-title">商品分类</h2>
      <div class="cate-grid">
        <div
          v-for="cate in categories"
          :key="cate.id"
          class="cate-card"
          @click="$router.push({ path: '/goods', query: { cid: cate.id } })"
        >
          <img v-if="cate.pic" :src="cate.pic" class="cate-icon" />
          <span class="cate-name">{{ cate.cate_name }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { apiGoodsList, apiCategory } from "@/api/product";
import type { GoodsItem, CategoryNode } from "@/types/product";

const goods = ref<GoodsItem[]>([]);
const categories = ref<CategoryNode[]>([]);
const loading = ref(true);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

onMounted(async () => {
  try {
    const [goodsRes, cateRes] = await Promise.all([
      apiGoodsList({ page: 1, limit: 8 }),
      apiCategory(),
    ]);
    goods.value = goodsRes.list;
    categories.value = cateRes.slice(0, 8);
  } catch (e) {
    console.error("首页加载失败", e);
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.home {
  padding-top: 20px;
}

.marketing-bar {
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
}

.marketing-item {
  flex: 1;
  background: linear-gradient(135deg, #ff6a88, #ff9a8b);
  color: #fff;
  border-radius: 12px;
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.2s;
}

.marketing-item:nth-child(2) {
  background: linear-gradient(135deg, #ff9a45, #ffd36e);
}

.marketing-item:hover {
  transform: translateY(-2px);
}

.marketing-icon {
  font-size: 24px;
}

.section {
  margin-bottom: 32px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 16px;
  padding-left: 10px;
  border-left: 4px solid #e64340;
}

.goods-card {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}

.goods-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
}

.goods-image {
  aspect-ratio: 1;
  overflow: hidden;
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
  line-height: 1.4;
  height: 40px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.goods-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}

.price {
  color: #e64340;
  font-size: 18px;
  font-weight: 600;
}

.sales {
  color: #999;
  font-size: 12px;
}

.cate-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 16px;
}

.cate-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px 10px;
  text-align: center;
  cursor: pointer;
  transition: box-shadow 0.2s;
}

.cate-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.cate-icon {
  width: 48px;
  height: 48px;
  object-fit: contain;
  margin-bottom: 8px;
}

.cate-name {
  font-size: 13px;
  color: #555;
}
</style>
