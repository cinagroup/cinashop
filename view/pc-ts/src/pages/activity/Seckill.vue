<template>
  <div class="seckill container">
    <h2 class="title">限时秒杀</h2>

    <!-- 时间段 -->
    <div class="time-slots">
      <div
        v-for="slot in slots"
        :key="(slot as any).id"
        class="time-slot"
        :class="{ active: (slot as any).is_active }"
        @click="selectTime(slot)"
      >
        <div class="slot-time">{{ (slot as any).start_time }} - {{ (slot as any).end_time }}</div>
        <div class="slot-status">{{ (slot as any).is_active ? "抢购中" : "未开始" }}</div>
      </div>
    </div>

    <!-- 商品 -->
    <div v-if="goods.length" class="goods-grid">
      <div
        v-for="item in goods"
        :key="(item as any).id"
        class="goods-card"
        @click="$router.push(`/goods/${(item as any).product_id}`)"
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
        </div>
      </div>
    </div>
    <el-empty v-else-if="!loading" description="当前时段暂无秒杀商品" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { apiSeckillIndex, apiSeckillList } from "@/api/activity";

const slots = ref<unknown[]>([]);
const goods = ref<unknown[]>([]);
const loading = ref(true);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function selectTime(slot: unknown) {
  loading.value = true;
  try {
    goods.value = await apiSeckillList((slot as any).start_time);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    slots.value = await apiSeckillIndex();
    const active = slots.value.find((s) => (s as any).is_active);
    if (active) await selectTime(active);
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

.time-slots {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.time-slot {
  background: #fff;
  border-radius: 8px;
  padding: 12px 20px;
  cursor: pointer;
  border: 2px solid transparent;
  text-align: center;
}

.time-slot.active {
  border-color: #e64340;
}

.slot-time {
  font-size: 14px;
  font-weight: 600;
}

.slot-status {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

.time-slot.active .slot-status {
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
</style>
