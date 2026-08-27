<template>
  <div class="product-list">
    <!-- 搜索栏 -->
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="商品名称">
          <el-input
            v-model="query.store_name"
            placeholder="请输入商品名称"
            clearable
            @keyup.enter="reload"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">搜索</el-button>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 工具栏 -->
    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="warning" plain @click="$router.push('/product/virtual-alerts')">
          卡密预警
        </el-button>
        <el-button type="primary" @click="$router.push('/product/create')">
          添加商品
        </el-button>
      </div>

      <!-- 表格 -->
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="商品" min-width="240">
          <template #default="{ row }">
            <div class="product-cell">
              <el-image
                v-if="row.image"
                :src="row.image"
                class="thumb"
                fit="cover"
                :preview-src-list="[row.image]"
              />
              <span class="name">{{ row.store_name }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="price" label="价格" width="100">
          <template #default="{ row }">¥{{ row.price }}</template>
        </el-table-column>
        <el-table-column prop="stock" label="库存" width="80" />
        <el-table-column prop="sales" label="销量" width="80" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.is_show === 1 ? 'success' : 'info'">
              {{ row.is_show === 1 ? "上架" : "下架" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.product_type === 1"
              link
              type="primary"
              @click="$router.push(`/product/virtual/${row.id}`)"
            >
              卡密库存
            </el-button>
            <el-button v-if="row.product_type !== 1" link type="primary" @click="$router.push(`/product/edit/${row.id}`)">
              编辑
            </el-button>
            <el-button link :type="row.is_show === 1 ? 'warning' : 'success'" @click="toggleShow(row)">
              {{ row.is_show === 1 ? "下架" : "上架" }}
            </el-button>
            <el-button link type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.limit"
        :total="total"
        layout="total, prev, pager, next"
        class="pagination"
        @current-change="fetch"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminProductList,
  apiAdminProductSetShow,
  apiAdminProductDel,
} from "@/api/product";
import type { AdminProduct } from "@/types/admin";

const list = ref<AdminProduct[]>([]);
const loading = ref(false);
const total = ref(0);
const query = reactive({ page: 1, limit: 10, store_name: "" });

async function fetch() {
  loading.value = true;
  try {
    const result = await apiAdminProductList({
      page: query.page,
      limit: query.limit,
      store_name: query.store_name || undefined,
    });
    list.value = result.list;
    total.value = result.list.length < query.limit ? (query.page - 1) * query.limit + result.list.length : query.page * query.limit + 1;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function reload() {
  query.page = 1;
  fetch();
}

function reset() {
  query.store_name = "";
  reload();
}

async function toggleShow(row: AdminProduct) {
  try {
    await apiAdminProductSetShow(row.id, row.is_show === 1 ? 0 : 1);
    ElMessage.success(row.is_show === 1 ? "已下架" : "已上架");
    fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "操作失败");
  }
}

async function del(row: AdminProduct) {
  try {
    await ElMessageBox.confirm(`确定删除商品「${row.store_name}」?`, "确认");
  } catch {
    return;
  }
  try {
    await apiAdminProductDel(row.id);
    ElMessage.success("已删除");
    fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "删除失败");
  }
}

onMounted(fetch);
</script>

<style scoped>
.filter-card {
  margin-bottom: 16px;
}

.toolbar {
  margin-bottom: 16px;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.thumb {
  width: 56px;
  height: 56px;
  border-radius: 4px;
  flex-shrink: 0;
}

.name {
  font-size: 14px;
}

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
