<template>
  <div class="goods-cate container">
    <h2 class="title">全部分类</h2>
    <div v-if="categories.length" class="cate-tree">
      <div v-for="top in categories" :key="top.id" class="cate-group">
        <div class="cate-top" @click="$router.push({ path: '/goods', query: { cid: top.id } })">
          <img v-if="top.pic" :src="top.pic" class="cate-icon" />
          <span class="cate-name">{{ top.cate_name }}</span>
        </div>
        <div v-if="top.children?.length" class="cate-children">
          <span
            v-for="child in top.children"
            :key="child.id"
            class="child"
            @click="$router.push({ path: '/goods', query: { cid: child.id } })"
          >
            {{ child.cate_name }}
          </span>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无分类" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { apiCategory } from "@/api/product";
import type { CategoryNode } from "@/types/product";

const categories = ref<CategoryNode[]>([]);

onMounted(async () => {
  try {
    categories.value = await apiCategory();
  } catch (e) {
    console.error("分类加载失败", e);
  }
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.cate-group {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}

.cate-top {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 16px;
  font-weight: 600;
}

.cate-icon {
  width: 40px;
  height: 40px;
  object-fit: contain;
}

.cate-children {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
  padding-left: 50px;
}

.child {
  background: #f8f8f8;
  border-radius: 16px;
  padding: 4px 14px;
  font-size: 13px;
  color: #555;
  cursor: pointer;
}

.child:hover {
  color: #e64340;
}
</style>
