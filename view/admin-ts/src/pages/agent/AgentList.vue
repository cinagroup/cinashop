<template>
  <div>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="推广人列表" name="spread">
        <el-card shadow="never">
          <el-table :data="list" v-loading="loading" border>
            <el-table-column prop="uid" label="UID" width="80" />
            <el-table-column label="用户" min-width="140">
              <template #default="{ row }">{{ row.nickname || row.account || `用户#${row.uid}` }}</template>
            </el-table-column>
            <el-table-column prop="phone" label="手机" width="130" />
            <el-table-column prop="spreadCount" label="推广人数" width="100" sortable />
            <el-table-column label="佣金余额" width="120">
              <template #default="{ row }">¥{{ row.brokeragePrice }}</template>
            </el-table-column>
            <el-table-column label="注册时间" width="160">
              <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
            </el-table-column>
          </el-table>
          <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="20" :current-page="page" @current-change="loadSpread" />
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="佣金明细" name="brokerage">
        <el-card shadow="never">
          <el-table :data="brokerageList" v-loading="bLoading" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="用户" width="120">
              <template #default="{ row }">{{ row.nickname || `#${row.uid}` }}</template>
            </el-table-column>
            <el-table-column prop="title" label="标题" width="140" />
            <el-table-column prop="category" label="分类" width="120" />
            <el-table-column label="金额" width="110">
              <template #default="{ row }">
                <span :class="row.pm === 1 ? 'green' : 'red'">{{ row.pm === 1 ? '+' : '-' }}¥{{ row.number }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="mark" label="备注" min-width="180" show-overflow-tooltip />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : row.status === -1 ? 'danger' : 'warning'" size="small">
                  {{ brokerageStatusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
            </el-table-column>
          </el-table>
          <el-pagination class="pager" layout="total, prev, pager, next" :total="bTotal" :page-size="20" :current-page="bPage" @current-change="loadBrokerage" />
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import request, { getData } from "@/utils/request";

const activeTab = ref("spread");
const list = ref<any[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const brokerageList = ref<any[]>([]);
const bTotal = ref(0);
const bPage = ref(1);
const bLoading = ref(false);

function formatTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const brokerageStatusLabels: Record<number, string> = {
  [-1]: "无效",
  0: "冻结",
  1: "有效",
};

function brokerageStatusLabel(status: unknown): string {
  return brokerageStatusLabels[Number(status)] ?? "?";
}

async function loadSpread(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = (await getData(request.get("/spread/list", { params: { page: p, limit: 20 } }))) as any;
    list.value = r.list || [];
    total.value = r.total || 0;
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadBrokerage(p = 1) {
  bLoading.value = true;
  bPage.value = p;
  try {
    const r = (await getData(request.get("/brokerage/list", { params: { page: p, limit: 20 } }))) as any;
    brokerageList.value = r.list || [];
    bTotal.value = r.total || 0;
  } catch {
    brokerageList.value = [];
  } finally {
    bLoading.value = false;
  }
}

watch(activeTab, (v) => {
  if (v === "brokerage" && !brokerageList.value.length) loadBrokerage();
});

onMounted(() => loadSpread(1));
</script>

<style scoped>
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
.green {
  color: #67c23a;
  font-weight: 600;
}
.red {
  color: #e93323;
  font-weight: 600;
}
</style>
