<template>
  <div class="goods-search container">
    <h2 class="title">
      搜索: <span class="keyword">{{ keyword }}</span>
    </h2>

    <!-- 热门搜索 -->
    <div v-if="!keyword && hotKeywords.length" class="hot-section">
      <span class="hot-label">热门搜索:</span>
      <span
        v-for="word in hotKeywords"
        :key="word"
        class="hot-word"
        @click="goKeyword(word)"
      >
        {{ word }}
      </span>
    </div>

    <div v-if="goods.length" class="goods-grid">
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
    <el-empty v-else-if="!loading" description="未找到相关商品" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGoodsList } from "@/api/product";
import request, { getData } from "@/utils/request";
import type { GoodsItem } from "@/types/product";

const route = useRoute();
const router = useRouter();
const keyword = ref("");
const goods = ref<GoodsItem[]>([]);
const loading = ref(true);
const hotKeywords = ref<string[]>([]);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function loadHotKeywords() {
  try {
    const words = await getData<{ keyword: string }[]>(request.get("/search/hot_keyword"));
    hotKeywords.value = words.map((w) => w.keyword);
  } catch {
    hotKeywords.value = [];
  }
}

function goKeyword(word: string) {
  router.push({ path: "/search", query: { keyword: word } });
}

async function search() {
  loading.value = true;
  try {
    const result = await apiGoodsList({ keyword: keyword.value, page: 1, limit: 24 });
    goods.value = result.list;
  } catch (e) {
    console.error("搜索失败", e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => route.query.keyword,
  (kw) => {
    keyword.value = (kw as string) ?? "";
    search();
  },
);

onMounted(() => {
  keyword.value = (route.query.keyword as string) ?? "";
  search();
  loadHotKeywords();
});
</script>

<style scoped>
.hot-section {
  margin-bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.hot-label {
  color: #999;
  font-size: 14px;
}

.hot-word {
  background: #fff;
  border-radius: 16px;
  padding: 4px 14px;
  font-size: 13px;
  color: #e64340;
  cursor: pointer;
  border: 1px solid #ffd7d3;
}

.hot-word:hover {
  background: #e64340;
  color: #fff;
}

.title {
  font-size: 18px;
  margin: 20px 0;
}

.keyword {
  color: #e64340;
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
  justify-content: space-between;
  margin-top: 8px;
}

.price {
  color: #e64340;
  font-weight: 600;
}

.sales {
  color: #999;
  font-size: 12px;
}
</style>
