<template>
  <el-card shadow="never">
    <template #header>操作日志</template>
    <el-table :data="list" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="admin_name" label="操作人" width="120" />
      <el-table-column prop="action" label="操作内容" min-width="300" show-overflow-tooltip />
      <el-table-column prop="ip" label="IP" width="140" />
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
      </el-table-column>
    </el-table>
    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="20"
      :current-page="page"
      @current-change="load"
    />
  </el-card>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import request, { getData } from "@/utils/request";

const list = ref<any[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);

function formatTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = (await getData(
      request.get("/log/list", { params: { page: p, limit: 20 } }),
    )) as any;
    list.value = r.list || [];
    total.value = r.total || 0;
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
