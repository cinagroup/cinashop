<template>
  <div class="combination container">
    <h2 class="title">多人拼团</h2>
    <div v-if="list.length" class="goods-grid">
      <div
        v-for="item in list"
        :key="(item as any).id"
        class="goods-card"
        @click="$router.push(`/combination/${(item as any).id}`)"
      >
        <div class="goods-image">
          <img :src="(item as any).image || placeholder" :alt="(item as any).store_name" loading="lazy" />
        </div>
        <div class="goods-info">
          <div class="goods-name">{{ (item as any).store_name }}</div>
          <div class="goods-bottom">
            <span class="price">¥{{ (item as any).price }}</span>
            <span class="ot-price">¥{{ (item as any).ot_price }}</span>
          </div>
          <div class="group-info">
            <span>{{ (item as any).people }}人团</span>
            <span class="group-btn">去拼团</span>
          </div>
        </div>
      </div>
    </div>
    <el-empty v-else-if="!loading" description="暂无拼团活动" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { apiCombinationList } from "@/api/activity";

const list = ref<unknown[]>([]);
const loading = ref(true);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

onMounted(async () => {
  try {
    list.value = await apiCombinationList();
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.title {
  font-size: 22px;
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
