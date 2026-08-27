<template>
  <div class="express-page container">
    <h2 class="title">物流查询</h2>

    <div class="search-bar">
      <el-input v-model="orderId" placeholder="输入订单号" @keyup.enter="query" />
      <el-button type="primary" @click="query">查询</el-button>
    </div>

    <el-skeleton v-if="loading" :rows="5" animated />

    <div v-else-if="result && displayResult" class="result">
      <div v-if="result.packages.length > 1" class="package-picker">
        <span class="label">选择包裹</span>
        <el-select v-model="selectedPackageId" style="width: min(420px, 100%)">
          <el-option
            v-for="item in result.packages"
            :key="item.orderId"
            :label="`${item.expressName || '快递包裹'} ${item.expressNo}`"
            :value="item.orderId"
          />
        </el-select>
      </div>

      <div class="info-card">
        <div class="info-row">
          <span class="label">订单号</span>
          <span>{{ displayResult.orderId }}</span>
        </div>
        <div class="info-row">
          <span class="label">物流状态</span>
          <el-tag
            :type="displayResult.trackingState === 'delivered' ? 'success' : displayResult.trackingState === 'exception' ? 'danger' : 'warning'"
          >
            {{ displayResult.deliveryStatus }}
          </el-tag>
        </div>
        <div class="info-row" v-if="displayResult.expressNo">
          <span class="label">快递公司</span>
          <span>{{ displayResult.expressName }} {{ displayResult.expressNo }}</span>
        </div>
      </div>

      <el-alert
        v-if="displayResult.message"
        class="tracking-notice"
        :title="displayResult.message"
        :type="displayResult.trackingState === 'exception' ? 'error' : 'info'"
        :closable="false"
        show-icon
      />

      <div v-if="displayResult.traces.length" class="traces">
        <div class="trace-title">物流轨迹</div>
        <el-timeline>
          <el-timeline-item
            v-for="(t, i) in displayResult.traces"
            :key="`${t.time}-${i}`"
            :timestamp="t.time"
            :type="t.status === '已签收' ? 'success' : 'primary'"
            placement="top"
          >
            <div class="trace-status">{{ t.status }}</div>
            <div class="trace-content">{{ t.content }}</div>
          </el-timeline-item>
        </el-timeline>
      </div>
      <el-empty v-else-if="!displayResult.message" description="承运商尚未返回物流轨迹" />
    </div>
    <el-empty v-else-if="!loading && searched" description="未找到物流信息" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { apiOrderExpress } from "@/api/order";

const route = useRoute();
const orderId = ref((route.query.orderId as string) ?? "");
const loading = ref(false);
const searched = ref(false);
const result = ref<Awaited<ReturnType<typeof apiOrderExpress>> | null>(null);
const selectedPackageId = ref("");
const displayResult = computed(() => {
  if (!result.value) return null;
  return (
    result.value.packages.find((item) => item.orderId === selectedPackageId.value) ??
    result.value
  );
});

async function query() {
  if (!orderId.value) return ElMessage.warning("请输入订单号");
  loading.value = true;
  searched.value = true;
  try {
    result.value = await apiOrderExpress(orderId.value);
    selectedPackageId.value = result.value.packages[0]?.orderId ?? "";
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

.package-picker {
  display: flex;
  align-items: center;
  gap: 16px;
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}

.tracking-notice {
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

@media (max-width: 640px) {
  .search-bar,
  .package-picker,
  .info-row {
    align-items: stretch;
    flex-direction: column;
  }

  .label {
    width: auto;
  }
}
</style>
