<template>
  <div class="recharge container">
    <h2 class="title">余额充值</h2>

    <!-- 当前余额 -->
    <div class="balance-card">
      <div class="balance-label">当前余额 (元)</div>
      <div class="balance-num">{{ balance }}</div>
      <el-button type="primary" plain size="small" @click="$router.push('/user/balance')">
        收支明细
      </el-button>
    </div>

    <!-- 金额选择 -->
    <div class="amount-card">
      <div class="amount-label">选择充值金额</div>
      <div class="amount-grid">
        <div
          v-for="amt in amounts"
          :key="amt"
          class="amount-item"
          :class="{ active: selected === amt }"
          @click="selected = amt"
        >
          ¥{{ amt }}
        </div>
      </div>
      <el-input-number
        v-model="customAmount"
        :min="1"
        :max="100000"
        :precision="2"
        placeholder="自定义金额"
        style="width: 220px"
        @change="selected = 0"
      />
    </div>

    <el-button
      type="danger"
      size="large"
      style="width: 100%; margin-top: 24px"
      :loading="submitting"
      :disabled="!finalAmount"
      @click="submit"
    >
      立即充值 ¥{{ finalAmount }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiRechargeCreate, apiRechargeIndex } from "@/api/finance";
import { apiUserInfo } from "@/api/user";

const amounts = ref<number[]>([50, 100, 200, 500, 1000]);
const selected = ref<number>(100);
const customAmount = ref<number | null>(null);
const balance = ref("0.00");
const submitting = ref(false);

const finalAmount = computed(() => customAmount.value ?? selected.value ?? 0);

async function submit() {
  if (!finalAmount.value) return;
  submitting.value = true;
  try {
    const res = await apiRechargeCreate(finalAmount.value, "h5");
    ElMessage.success(`充值订单 ${(res as any).orderId} 已创建`);
    // 刷新余额 (余额支付通道简化: 直接显示提示)
    const info = await apiUserInfo();
    balance.value = (info as any).now_money ?? balance.value;
  } catch (e) {
    ElMessage.error((e as Error).message || "充值失败");
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    const idx = (await apiRechargeIndex()) as any[];
    if (Array.isArray(idx) && idx.length) {
      amounts.value = idx.map((i) => Number(i.price ?? i.money ?? 0)).filter((n: number) => n > 0);
      if (amounts.value.length) selected.value = amounts.value[0];
    }
  } catch {
    // 套餐接口异常时使用默认金额
  }
  try {
    const info = (await apiUserInfo()) as any;
    balance.value = info?.now_money ?? "0.00";
  } catch {
    // 未登录时静默
  }
});
</script>

<style scoped>
.title {
  font-size: 22px;
  margin: 20px 0;
}

.balance-card {
  background: linear-gradient(135deg, #e64340, #f56c6c);
  color: #fff;
  border-radius: 12px;
  padding: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.balance-label {
  font-size: 14px;
  opacity: 0.9;
}

.balance-num {
  font-size: 32px;
  font-weight: 700;
  flex: 1;
  padding-left: 16px;
}

.amount-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
}

.amount-label {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}

.amount-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.amount-item {
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  text-align: center;
  padding: 14px 0;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.amount-item.active {
  border-color: #e64340;
  color: #e64340;
  background: #fff5f5;
}
</style>
