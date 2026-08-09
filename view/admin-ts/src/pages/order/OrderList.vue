<template>
  <div class="order-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="订单号">
          <el-input v-model="query.order_id" placeholder="订单号" clearable />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部" clearable style="width: 140px">
            <el-option label="待发货" :value="0" />
            <el-option label="待收货" :value="1" />
            <el-option label="已收货" :value="2" />
            <el-option label="已完成" :value="3" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">搜索</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="order_id" label="订单号" min-width="200" />
        <el-table-column prop="real_name" label="收货人" width="100" />
        <el-table-column prop="user_phone" label="电话" width="120" />
        <el-table-column prop="total_num" label="数量" width="70" />
        <el-table-column label="金额" width="110">
          <template #default="{ row }">¥{{ row.pay_price }}</template>
        </el-table-column>
        <el-table-column label="支付状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.paid === 1 ? 'success' : 'warning'">
              {{ row.paid === 1 ? "已支付" : "未支付" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="订单状态" width="100">
          <template #default="{ row }">{{ statusText(row.status) }}</template>
        </el-table-column>
        <el-table-column label="下单时间" width="160">
          <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push(`/order/${row.order_id}`)">
              详情
            </el-button>
            <el-button
              v-if="row.paid === 1 && row.status === 0"
              link
              type="primary"
              @click="deliver(row)"
            >
              发货
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="query.page"
        :page-size="query.limit"
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
import { apiAdminOrderList, apiAdminOrderDelivery } from "@/api/order";
import type { AdminOrder } from "@/types/admin";
import dayjs from "dayjs";

const list = ref<AdminOrder[]>([]);
const loading = ref(false);
const total = ref(0);
const query = reactive({ page: 1, limit: 10, order_id: "", status: undefined as number | undefined });

function statusText(status: number): string {
  switch (status) {
    case 0: return "待发货";
    case 1: return "待收货";
    case 2: return "已收货";
    case 3: return "已完成";
    default: return "未知";
  }
}

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

async function fetch() {
  loading.value = true;
  try {
    const result = await apiAdminOrderList({
      page: query.page,
      limit: query.limit,
      order_id: query.order_id || undefined,
      status: query.status,
    });
    list.value = result.list;
    total.value =
      result.list.length < query.limit
        ? (query.page - 1) * query.limit + result.list.length
        : query.page * query.limit + 1;
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

async function deliver(row: AdminOrder) {
  try {
    await ElMessageBox.confirm(`确认给订单 ${row.order_id} 发货?`, "确认");
  } catch {
    return;
  }
  try {
    await apiAdminOrderDelivery(row.order_id, { delivery_name: "顺丰速运" });
    ElMessage.success("发货成功");
    fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "发货失败");
  }
}

onMounted(fetch);
</script>

<style scoped>
.filter-card {
  margin-bottom: 16px;
}

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
