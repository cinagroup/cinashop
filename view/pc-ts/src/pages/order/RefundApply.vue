<template>
  <div class="refund-apply container">
    <h2 class="title">申请退款</h2>

    <el-card shadow="never" class="refund-card">
      <el-form :model="form" label-width="100px" style="max-width: 560px">
        <el-form-item label="退款类型" required>
          <el-radio-group v-model="form.applyType">
            <el-radio :value="1">仅退款</el-radio>
            <el-radio :value="2">退货退款</el-radio>
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
          <el-button type="danger" :loading="submitting" @click="submit">提交申请</el-button>
          <el-button @click="$router.back()">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import request, { getData } from "@/utils/request";

const route = useRoute();
const router = useRouter();
const submitting = ref(false);

const form = reactive({
  applyType: 1,
  refundReason: "",
  refundExplain: "",
});

async function submit() {
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
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.refund-card {
  max-width: 700px;
}
</style>
