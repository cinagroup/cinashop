<template>
  <div class="seckill container">
    <h2 class="title">限时秒杀</h2>

    <!-- 时间段 -->
    <div class="time-slots">
      <button
        v-for="slot in slots"
        :key="slot.id"
        type="button"
        class="time-slot"
        :class="{ active: slot.id === selectedId }"
        :aria-pressed="slot.id === selectedId"
        :disabled="!slot.start_time || !slot.end_time"
        @click="selectTime(slot)"
      >
        <span class="slot-time">{{ slot.start_time || '—' }} - {{ slot.end_time || '—' }}</span>
        <span class="slot-status">{{ slot.state }}</span>
      </button>
    </div>
    <el-button :disabled="loading" @click="loadIndex">刷新时段</el-button>
    <p>时段时间为北京时间；价格、库存及购买资格以结算时校验为准。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-button v-if="error && selectedId" :disabled="loading" @click="loadGoods(page)">重试商品列表</el-button>
    <p v-if="loading" role="status">正在加载秒杀商品…</p>

    <!-- 商品 -->
    <div v-if="goods.length" class="goods-grid">
      <router-link
        v-for="item in goods"
        :key="item.id"
        class="goods-card"
        :to="`/seckill/${item.id}`"
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
        </div>
      </router-link>
    </div>
    <el-empty v-else-if="!loading && !error" :description="slots.length ? '当前时段暂无秒杀商品' : '暂无秒杀时段'" />
    <nav v-if="selectedId" aria-label="秒杀商品分页" class="pagination">
      <el-button :disabled="loading || page <= 1" @click="loadGoods(page - 1)">上一页</el-button>
      <span>第 {{ page }} 页</span>
      <el-button :disabled="loading || !!error || goods.length < pageSize" @click="loadGoods(page + 1)">下一页</el-button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { apiSeckillIndex, apiSeckillList } from "@/api/activity";
import type { SeckillItem, SeckillSlot } from "../../../../common/seckillPurchase";

const slots = ref<SeckillSlot[]>([]);
const goods = ref<SeckillItem[]>([]);
const selectedId = ref(0), page = ref(1), error = ref('');
const pageSize = 20;
let revision = 0;
const loading = ref(true);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function loadGoods(nextPage: number) {
  const request = ++revision, id = selectedId.value;
  loading.value = true; goods.value = []; error.value = ''; page.value = nextPage;
  try {
    const rows = await apiSeckillList(id, nextPage, pageSize);
    if (request === revision) goods.value = rows;
  } catch (e) {
    if (request === revision) error.value = (e as Error).message || '秒杀商品加载失败';
  } finally {
    if (request === revision) loading.value = false;
  }
}
function selectTime(slot: SeckillSlot) {
  if (!slot.start_time || !slot.end_time) return;
  selectedId.value = slot.id;
  void loadGoods(1);
}
async function loadIndex() {
  const request = ++revision;
  loading.value = true; goods.value = []; slots.value = []; selectedId.value = 0; error.value = '';
  try {
    const data = await apiSeckillIndex();
    if (request !== revision) return;
    slots.value = data.seckillTime;
    const active = data.seckillTime[data.seckillTimeIndex] ?? data.seckillTime.find(slot => slot.start_time && slot.end_time);
    if (active) { selectedId.value = active.id; await loadGoods(1); }
  } catch (e) {
    if (request === revision) error.value = (e as Error).message || '秒杀时段加载失败';
  } finally {
    if (request === revision) loading.value = false;
  }
}
onMounted(loadIndex);
onUnmounted(() => { revision++; });
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
  display: block;
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

.time-slot.active .slot-status {
  color: #e64340;
}

.goods-card {
  color: inherit;
  text-decoration: none;
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
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 24px 0; }
.seckill > p { margin: 12px 0; line-height: 1.6; }
.time-slot:disabled { cursor: not-allowed; opacity: .6; }
</style>
