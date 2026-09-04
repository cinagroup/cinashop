<template>
  <div class="refund-apply container">
    <h2 class="title">申请退款</h2>

    <el-card v-loading="loading" shadow="never" class="refund-card">
      <el-alert
        v-if="refundBlockedReason"
        :title="refundBlockedReason"
        type="warning"
        :closable="false"
        show-icon
        class="policy-alert"
      />
      <el-form v-if="order" :model="form" label-width="100px" style="max-width: 560px">
        <el-form-item label="退款类型" required>
          <el-radio-group v-model="form.applyType">
            <el-radio :value="1">仅退款</el-radio>
            <el-radio v-if="!isVirtualOrder" :value="2">退货退款</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="退款原因" required>
          <el-select v-model="form.refundReason" placeholder="请选择退款原因" style="width: 100%">
            <el-option label="商品质量问题" value="商品质量问题" />
            <el-option label="商品与描述不符" value="商品与描述不符" />
            <el-option label="不想要了" value="不想要了" />
            <el-option label="其他原因" value="其他原因" />
          </el-select>
        </el-form-item>
        <el-form-item label="退款说明">
          <el-input
            v-model="form.refundExplain"
            type="textarea"
            :rows="3"
            placeholder="请描述退款原因"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="danger"
            :loading="submitting"
            :disabled="!canSubmit"
            @click="submit"
          >提交申请</el-button>
          <el-button @click="$router.back()">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiOrderDetail } from "@/api/order";
import type { OrderInfo } from "@/types/order";
import request, { getData } from "@/utils/request";

const route = useRoute();
const router = useRouter();
const submitting = ref(false);
const loading = ref(true);
const order = ref<OrderInfo | null>(null);

const form = reactive({
  applyType: 1,
  refundReason: "",
  refundExplain: "",
});

const isVirtualOrder = computed(() => [1, 3, 4].includes(order.value?.product_type ?? 0));
const refundBlockedReason = computed(() => {
  if (order.value?.product_type !== 1) return "";
  if (order.value.refund_eligibility?.allowed) return "";
  return order.value.refund_eligibility?.reason || "卡密商品退款状态无法确认，请返回订单详情刷新";
});
const canSubmit = computed(() => Boolean(order.value) && !loading.value && !refundBlockedReason.value);

async function submit() {
  if (!canSubmit.value) return ElMessage.error(refundBlockedReason.value || "订单状态不允许退款");
  if (!form.refundReason) return ElMessage.error("请选择退款原因");
  submitting.value = true;
  try {
    const orderId = route.params.orderId as string;
    await getData(
      request.post(`/order/refund/apply/${orderId}`, {
        refundReason: form.refundReason,
        refundExplain: form.refundExplain,
        applyType: form.applyType,
      }),
    );
    ElMessage.success("退款申请已提交");
    router.push("/order");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "提交失败");
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    order.value = await apiOrderDetail(String(route.params.orderId ?? ""));
    if (isVirtualOrder.value) form.applyType = 1;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "订单加载失败");
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.refund-card {
  max-width: 700px;
}

.policy-alert {
  margin-bottom: 20px;
}
</style>
