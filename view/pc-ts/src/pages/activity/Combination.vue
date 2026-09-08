<template>
  <div class="combination container">
    <h2 class="title">多人拼团</h2>
    <el-button :disabled="loading" @click="load(page)">刷新拼团列表</el-button>
    <p v-if="loading" role="status">正在加载拼团商品…</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-button v-if="error" :disabled="loading" @click="load(page)">重试商品列表</el-button>
    <div v-if="list.length" class="goods-grid">
      <router-link
        v-for="item in list"
        :key="item.id"
        class="goods-card"
        :to="`/combination/${item.id}`"
      >
        <div class="goods-image">
          <img :src="item.image || placeholder" :alt="item.title" loading="lazy" />
        </div>
        <div class="goods-info">
          <div class="goods-name">{{ item.title }}</div>
          <div class="goods-bottom">
            <span class="price">¥{{ item.price.toFixed(2) }}</span>
            <span class="ot-price">¥{{ item.ot_price.toFixed(2) }}</span>
          </div>
          <div class="group-info">
            <span>{{ item.people }}人团</span>
            <span class="group-btn">去拼团</span>
          </div>
        </div>
      </router-link>
    </div>
    <el-empty v-else-if="!loading && !error" description="当前页暂无拼团活动" />
    <nav class="pagination" aria-label="拼团商品分页">
      <el-button :disabled="loading || page <= 1" @click="load(page - 1)">上一页</el-button>
      <span>第 {{ page }} 页</span>
      <el-button :disabled="loading || !!error || list.length < 20" @click="load(page + 1)">下一页</el-button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { apiCombinationList } from "@/api/activity";
import type { CombinationItem } from '../../../../common/combinationPurchase';

const list = ref<CombinationItem[]>([]);
const loading = ref(true);
const page = ref(1), error = ref('');
let revision = 0, disposed = false;
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function load(nextPage = 1) {
  if (disposed) return;
  const current = ++revision;
  list.value = []; error.value = ''; loading.value = true; page.value = nextPage;
  try {
    const rows = await apiCombinationList(nextPage);
    if (!disposed && current === revision) list.value = rows;
  } catch (e) { if (!disposed && current === revision) error.value = e instanceof Error ? e.message : '拼团列表加载失败'; }
  finally { if (!disposed && current === revision) loading.value = false; }
}
onMounted(() => { void load(); });
onUnmounted(() => { disposed = true; revision++; });
</script>

<style scoped>
.title {
  font-size: 22px;
  margin: 20px 0;
}
.pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 20px 0; }

.goods-card {
  display: block;
  text-decoration: none;
  color: inherit;
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
  align-items: baseline;
  gap: 8px;
  margin-top: 8px;
}

.price {
  color: #e64340;
  font-size: 18px;
  font-weight: 600;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 13px;
}

.group-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
  font-size: 13px;
  color: #666;
}

.group-btn {
  background: #e64340;
  color: #fff;
  border-radius: 16px;
  padding: 4px 16px;
  font-size: 12px;
}
</style>
