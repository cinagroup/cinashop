<template>
  <div class="goods-list container">
    <!-- 筛选栏 -->
    <div class="filter-bar">
      <div class="filter-group">
        <span class="label">分类:</span>
        <el-select v-model="filter.cid" placeholder="全部分类" clearable @change="reload">
          <el-option
            v-for="cate in categories"
            :key="cate.id"
            :label="cate.cate_name"
            :value="cate.id"
          />
        </el-select>
      </div>
      <div class="filter-group">
        <span class="label">排序:</span>
        <el-radio-group v-model="filter.sortType" @change="reload">
          <el-radio-button value="">综合</el-radio-button>
          <el-radio-button value="sales_desc">销量</el-radio-button>
          <el-radio-button value="price_asc">价格↑</el-radio-button>
          <el-radio-button value="price_desc">价格↓</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <!-- 商品网格 -->
    <div v-if="loading" class="loading">
      <el-skeleton :rows="8" animated />
    </div>
    <template v-else>
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
      <el-empty v-else description="暂无商品" />
    </template>

    <!-- 分页 -->
    <div v-if="total > limit" class="pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="limit"
        :total="total"
        layout="prev, pager, next"
        @current-change="fetch"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import { apiGoodsList, apiCategory } from "@/api/product";
import type { GoodsItem, CategoryNode } from "@/types/product";

const route = useRoute();
const goods = ref<GoodsItem[]>([]);
const categories = ref<CategoryNode[]>([]);
const loading = ref(true);
const page = ref(1);
const limit = 12;
const total = ref(0);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const filter = reactive({
  cid: route.query.cid ? Number(route.query.cid) : undefined as number | undefined,
  keyword: (route.query.keyword as string) ?? "",
  sortType: "",
});

function reload() {
  page.value = 1;
  fetch();
}

async function fetch() {
  loading.value = true;
  try {
    const params: Record<string, unknown> = { page: page.value, limit };
    if (filter.cid) params.cid = filter.cid;
    if (filter.keyword) params.keyword = filter.keyword;
    if (filter.sortType === "sales_desc") params.salesOrder = "desc";
    if (filter.sortType === "price_asc") params.priceOrder = "asc";
    if (filter.sortType === "price_desc") params.priceOrder = "desc";

    const result = await apiGoodsList(params);
    goods.value = result.list;
    total.value = result.count ?? result.list.length;
  } catch (e) {
    console.error("商品列表加载失败", e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => route.query,
  () => {
    filter.cid = route.query.cid ? Number(route.query.cid) : undefined;
    filter.keyword = (route.query.keyword as string) ?? "";
    reload();
  },
);

onMounted(async () => {
  try {
    categories.value = await apiCategory();
  } catch {
    // ignore
  }
  fetch();
});
</script>

<style scoped>
.goods-list {
  padding-top: 20px;
}

.filter-bar {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 20px;
  display: flex;
  gap: 32px;
  align-items: center;
  flex-wrap: wrap;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.label {
  color: #666;
  font-size: 14px;
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

.pagination {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}
</style>
