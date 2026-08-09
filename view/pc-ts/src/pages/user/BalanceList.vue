<template>
  <div class="balance-list container">
    <h2 class="title">余额明细</h2>

    <!-- 余额卡片 -->
    <div class="balance-card">
      <div class="balance-label">当前余额</div>
      <div class="balance-num">¥{{ balance }}</div>
    </div>

    <!-- 筛选 -->
    <div class="filter-bar">
      <el-radio-group v-model="filter" @change="load(true)">
        <el-radio-button value="0">全部</el-radio-button>
        <el-radio-button value="1">收入</el-radio-button>
        <el-radio-button value="2">支出</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 明细列表 -->
    <el-table :data="filteredList" v-loading="loading" border>
      <el-table-column label="标题" prop="title" min-width="140" />
      <el-table-column label="备注" prop="mark" min-width="180" show-overflow-tooltip />
      <el-table-column label="类型" width="80">
        <template #default="{ row }">
          <el-tag :type="row.pm === 1 ? 'success' : 'warning'">
            {{ row.pm === 1 ? "收入" : "支出" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="金额" width="120">
        <template #default="{ row }">
          <span :class="{ income: row.pm === 1 }">
            {{ row.pm === 1 ? "+" : "-" }}¥{{ row.number }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
      </el-table-column>
    </el-table>

    <div class="load-more" v-if="hasMore">
      <el-button @click="loadMore">加载更多</el-button>
    </div>

    <el-button type="primary" class="recharge-btn" @click="$router.push('/user/recharge')">充值</el-button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import request, { getData } from "@/utils/request";

interface BillItem {
  id: number;
  title: string;
  mark: string;
  pm: number;
  number: string;
  addTime: number;
}

const list = ref<BillItem[]>([]);
const balance = ref("0.00");
const loading = ref(false);
const filter = ref("0");
const page = ref(1);
const hasMore = ref(true);

const filteredList = computed(() => {
  if (filter.value === "1") return list.value.filter((l) => l.pm === 1);
  if (filter.value === "2") return list.value.filter((l) => l.pm === 0);
  return list.value;
});

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load(reset = false) {
  if (reset) {
    page.value = 1;
    list.value = [];
  }
  loading.value = true;
  try {
    const result = await getData<BillItem[]>(
      request.get<BillItem[]>("/user/balance", { params: { page: page.value, limit: 20 } }),
    );
    const rows = result as BillItem[];
    list.value = [...list.value, ...rows];
    hasMore.value = rows.length >= 20;
  } catch (e) {
    console.error("余额明细加载失败", e);
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  page.value += 1;
  await load();
}

onMounted(async () => {
  await load(true);
  try {
    const info = await getData<Record<string, unknown>>(request.get("/user/info"));
    balance.value = String(info?.now_money ?? "0.00");
  } catch {
    // ignore
  }
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.balance-card {
  background: linear-gradient(135deg, #e64340, #ff7a45);
  border-radius: 8px;
  padding: 24px;
  color: #fff;
  margin-bottom: 20px;
  display: flex;
  align-items: baseline;
  gap: 16px;
}

.balance-label {
  font-size: 14px;
  opacity: 0.9;
}

.balance-num {
  font-size: 32px;
  font-weight: 700;
}

.filter-bar {
  margin-bottom: 16px;
}

.income {
  color: #67c23a;
  font-weight: 600;
}

.load-more {
  text-align: center;
  margin-top: 16px;
}

.recharge-btn {
  position: fixed;
  right: 40px;
  bottom: 40px;
}
</style>
