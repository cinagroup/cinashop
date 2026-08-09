<template>
  <div class="spread-center container">
    <h2 class="title">分销中心</h2>

    <!-- 佣金概览 -->
    <div class="commission-cards">
      <div class="commission-card">
        <div class="card-label">可提现佣金</div>
        <div class="card-value">¥{{ commission.withdrawable }}</div>
      </div>
      <div class="commission-card">
        <div class="card-label">累计佣金</div>
        <div class="card-value">¥{{ commission.totalCommission }}</div>
      </div>
      <div class="commission-card">
        <div class="card-label">昨日佣金</div>
        <div class="card-value">¥{{ commission.yesterdayCommission }}</div>
      </div>
      <div class="commission-card">
        <div class="card-label">推广人数</div>
        <div class="card-value">{{ commission.spreadCount }}</div>
      </div>
    </div>

    <!-- 佣金明细 -->
    <el-card shadow="never" class="section">
      <template #header>
        <div class="section-header">
          <span>佣金明细</span>
          <el-radio-group v-model="type" size="small" @change="loadList">
            <el-radio-button value="1">一级佣金</el-radio-button>
            <el-radio-button value="2">二级佣金</el-radio-button>
            <el-radio-button value="3">提现记录</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="title" label="说明" min-width="160" />
        <el-table-column label="金额" width="120">
          <template #default="{ row }">
            <span :class="row.pm === 1 ? 'income' : 'expense'">
              {{ row.pm === 1 ? "+" : "-" }}¥{{ row.number }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!list.length && !loading" description="暂无明细" />
    </el-card>

    <!-- 提现 -->
    <el-card shadow="never" class="section">
      <template #header>申请提现</template>
      <el-form :model="extract" label-width="90px" style="max-width: 480px">
        <el-form-item label="提现方式">
          <el-select v-model="extract.extract_type" style="width: 100%">
            <el-option label="银行卡" value="bank" />
            <el-option label="支付宝" value="alipay" />
            <el-option label="微信" value="weixin" />
          </el-select>
        </el-form-item>
        <el-form-item label="真实姓名">
          <el-input v-model="extract.real_name" placeholder="请输入真实姓名" />
        </el-form-item>
        <el-form-item label="收款账号">
          <el-input v-model="extract.extract_number" placeholder="银行卡号/支付宝账号" />
        </el-form-item>
        <el-form-item label="提现金额">
          <el-input-number v-model="extract.extract_price" :min="0" :precision="2" style="width: 100%" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="extracting" @click="submitExtract">提交提现</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import {
  apiCommission,
  apiCommissionList,
  apiSpreadPeople,
  apiExtractCash,
} from "@/api/finance";
import dayjs from "dayjs";

const commission = ref({
  yesterdayCommission: "0.00",
  totalCommission: "0.00",
  frozenCommission: "0.00",
  withdrawable: "0.00",
  spreadCount: 0,
});
const list = ref<unknown[]>([]);
const loading = ref(false);
const type = ref("1");
const extracting = ref(false);
const extract = ref({
  extract_type: "bank",
  real_name: "",
  extract_number: "",
  extract_price: 0,
});

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

async function loadList() {
  loading.value = true;
  try {
    list.value = await apiCommissionList(Number(type.value));
  } finally {
    loading.value = false;
  }
}

async function submitExtract() {
  if (!extract.value.real_name) return ElMessage.error("请输入真实姓名");
  if (!extract.value.extract_number) return ElMessage.error("请输入收款账号");
  if (extract.value.extract_price <= 0) return ElMessage.error("请输入提现金额");
  extracting.value = true;
  try {
    await apiExtractCash({ ...extract.value, extract_price: String(extract.value.extract_price) });
    ElMessage.success("提现申请已提交");
    extract.value = { extract_type: "bank", real_name: "", extract_number: "", extract_price: 0 };
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "提交失败");
  } finally {
    extracting.value = false;
  }
}

onMounted(async () => {
  try {
    commission.value = await apiCommission();
    // 统计推广人数 (简化: 只取一次列表长度)
    const people = await apiSpreadPeople(1, 100);
    commission.value.spreadCount = people.length;
  } catch {
    // ignore
  }
  loadList();
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.commission-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.commission-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  text-align: center;
}

.card-label {
  color: #999;
  font-size: 13px;
}

.card-value {
  font-size: 24px;
  font-weight: 700;
  color: #e64340;
  margin-top: 8px;
}

.section {
  margin-bottom: 20px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.income {
  color: #67c23a;
  font-weight: 600;
}

.expense {
  color: #f56c6c;
  font-weight: 600;
}
</style>
