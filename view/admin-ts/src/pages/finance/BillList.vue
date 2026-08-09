<template>
  <div class="bill-list">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>资金流水</span>
          <el-radio-group v-model="pmFilter" size="small" @change="load(1)">
            <el-radio-button :value="undefined">全部</el-radio-button>
            <el-radio-button :value="1">收入</el-radio-button>
            <el-radio-button :value="0">支出</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="用户" width="130">
          <template #default="{ row }">
            {{ row.nickname || row.account || `用户#${row.uid}` }}
          </template>
        </el-table-column>
        <el-table-column label="类型" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="row.pm === 1 ? 'success' : 'danger'">
              {{ row.title || row.category }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="category" label="分类" width="110" />
        <el-table-column prop="type" label="明细" width="130" />
        <el-table-column label="金额" width="110">
          <template #default="{ row }">
            <span :class="row.pm === 1 ? 'income' : 'expense'">
              {{ row.pm === 1 ? "+" : "-" }}¥{{ row.number }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="balance" label="余额" width="100" />
        <el-table-column label="说明" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.mark || "-" }}</template>
        </el-table-column>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiAdminBillList, type BillItem } from "@/api/finance";

const list = ref<BillItem[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const pmFilter = ref<number | undefined>(undefined);

function formatTime(ts: number) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const result = await apiAdminBillList({ pm: pmFilter.value, page: p, limit: 20 });
    list.value = result.list;
    total.value = result.total;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.income {
  color: #67c23a;
  font-weight: 600;
}

.expense {
  color: #e93323;
  font-weight: 600;
}

.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
