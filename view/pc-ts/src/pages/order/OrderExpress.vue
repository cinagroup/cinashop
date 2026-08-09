<template>
  <div class="express-page container">
    <h2 class="title">物流查询</h2>

    <div class="search-bar">
      <el-input v-model="orderId" placeholder="输入订单号" @keyup.enter="query" />
      <el-button type="primary" @click="query">查询</el-button>
    </div>

    <el-skeleton v-if="loading" :rows="5" animated />

    <div v-else-if="result" class="result">
      <div class="info-card">
        <div class="info-row">
          <span class="label">订单号</span>
          <span>{{ result.orderId }}</span>
        </div>
        <div class="info-row">
          <span class="label">物流状态</span>
          <el-tag :type="result.deliveryStatus === '已签收' ? 'success' : 'warning'">
            {{ result.deliveryStatus }}
          </el-tag>
        </div>
        <div class="info-row" v-if="result.expressNo">
          <span class="label">快递公司</span>
          <span>{{ result.expressName }} {{ result.expressNo }}</span>
        </div>
      </div>

      <div v-if="result.traces.length" class="traces">
        <div class="trace-title">物流轨迹</div>
        <el-timeline>
          <el-timeline-item
            v-for="(t, i) in result.traces"
            :key="i"
            :timestamp="t.time"
            :type="t.status === '已签收' ? 'success' : 'primary'"
            placement="top"
          >
            <div class="trace-status">{{ t.status }}</div>
            <div class="trace-content">{{ t.content }}</div>
          </el-timeline-item>
        </el-timeline>
      </div>
      <el-empty v-else description="暂无物流轨迹信息" />
    </div>
    <el-empty v-else-if="!loading && searched" description="未找到物流信息" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { apiOrderExpress } from "@/api/order";

const route = useRoute();
const orderId = ref((route.query.orderId as string) ?? "");
const loading = ref(false);
const searched = ref(false);
const result = ref<Awaited<ReturnType<typeof apiOrderExpress>> | null>(null);

async function query() {
  if (!orderId.value) return ElMessage.warning("请输入订单号");
  loading.value = true;
  searched.value = true;
  try {
    result.value = await apiOrderExpress(orderId.value);
  } catch (e) {
    result.value = null;
    ElMessage.error((e as Error).message || "查询失败");
  } finally {
    loading.value = false;
  }
}

if (orderId.value) query();
</script>

<style scoped>
.title {
  font-size: 22px;
  margin: 20px 0;
}

.search-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}

.info-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.info-row {
  display: flex;
  gap: 16px;
  padding: 8px 0;
}

.label {
  color: #999;
  width: 80px;
}

.traces {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
}

.trace-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
}

.trace-status {
  font-size: 14px;
  font-weight: 600;
  color: #409eff;
}

.trace-content {
  font-size: 13px;
  color: #666;
  margin-top: 4px;
}
</style>
