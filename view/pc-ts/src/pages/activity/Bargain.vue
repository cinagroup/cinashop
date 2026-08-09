<template>
  <div class="bargain container">
    <div class="head">
      <h2 class="title">砍价专区</h2>
      <el-button link type="primary" @click="openMy">我的砍价</el-button>
    </div>

    <!-- 砍价商品 -->
    <div v-if="goods.length" class="goods-grid">
      <div v-for="item in goods" :key="(item as any).id" class="goods-card">
        <div class="goods-image">
          <img :src="(item as any).image || placeholder" :alt="(item as any).store_name" loading="lazy" />
        </div>
        <div class="goods-info">
          <div class="goods-name">{{ (item as any).storeName }}</div>
          <div class="goods-bottom">
            <span class="price">¥{{ (item as any).price }}</span>
            <span class="min-price">可砍至 ¥{{ (item as any).minPrice }}</span>
          </div>
          <el-button type="danger" size="small" style="width: 100%" @click="startBargain(item)">
            发起砍价
          </el-button>
        </div>
      </div>
    </div>
    <el-empty v-else-if="!loading" description="暂无砍价商品" />

    <!-- 我的砍价 -->
    <el-dialog v-model="myVisible" title="我的砍价" width="520px">
      <div v-if="myList.length" class="my-list">
        <div v-for="item in myList" :key="(item as any).id" class="my-item">
          <div class="my-info">
            <div class="my-name">砍价商品 #{{ (item as any).bargainId }}</div>
            <div class="my-progress">
              当前价 <b class="cur">¥{{ (item as any).bargainPrice }}</b> / 底价 ¥{{ (item as any).bargainPriceMin }}
            </div>
            <el-progress :percentage="percentOf(item)" :stroke-width="8" />
          </div>
          <div class="my-actions">
            <el-button size="small" type="danger" @click="help(item)">帮砍 -¥{{ (item as any).price || "?" }}</el-button>
            <el-button size="small" @click="cancelMy(item)">取消</el-button>
          </div>
        </div>
      </div>
      <el-empty v-else description="还没有发起过砍价" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiBargainList, apiBargainStart, apiBargainHelp, apiMyBargains, apiBargainCancel } from "@/api/activity";

const goods = ref<unknown[]>([]);
const myList = ref<unknown[]>([]);
const loading = ref(true);
const myVisible = ref(false);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

function percentOf(item: unknown) {
  const min = Number((item as any).bargainPriceMin ?? 0);
  const start = Number((item as any).bargainPrice ?? 0);
  const cur = Number((item as any).bargainPrice ?? start);
  if (start <= min) return 100;
  return Math.min(100, Math.max(0, Math.round(((start - cur) / (start - min)) * 100)));
}

async function startBargain(item: unknown) {
  try {
    const res = await apiBargainStart((item as any).id);
    ElMessage.success(`发起成功, 砍价记录 #${res.id}`);
    loadMy();
  } catch (e) {
    ElMessage.error((e as Error).message || "发起失败");
  }
}

async function help(item: unknown) {
  try {
    const res = await apiBargainHelp((item as any).id);
    ElMessage.success(`帮砍成功, 再减 ¥${res.price}`);
    loadMy();
  } catch (e) {
    ElMessage.error((e as Error).message || "帮砍失败");
  }
}

async function cancelMy(item: unknown) {
  try {
    await apiBargainCancel((item as any).id);
    ElMessage.success("已取消");
    loadMy();
  } catch (e) {
    ElMessage.error((e as Error).message || "取消失败");
  }
}

async function loadMy() {
  myList.value = await apiMyBargains();
}

async function openMy() {
  myVisible.value = true;
  await loadMy();
}

onMounted(async () => {
  try {
    goods.value = await apiBargainList();
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 20px 0;
}

.title {
  font-size: 22px;
}

.goods-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.goods-card {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
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
  justify-content: space-between;
  margin: 8px 0 12px;
}

.price {
  color: #e64340;
  font-size: 18px;
  font-weight: 600;
}

.min-price {
  color: #999;
  font-size: 12px;
}

.my-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.my-item {
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.my-info {
  flex: 1;
}

.my-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}

.my-progress {
  font-size: 13px;
  color: #666;
  margin-bottom: 8px;
}

.cur {
  color: #e64340;
  font-size: 16px;
}
</style>
