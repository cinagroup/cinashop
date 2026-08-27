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
          @click="selectAmount(amt)"
        >
          ¥{{ amt }}
          <small v-if="quotaGifts[String(amt)]">赠 ¥{{ quotaGifts[String(amt)] }}</small>
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

    <div class="payment-card">
      <strong>微信支付</strong>
      <span :class="{ unavailable: !wechatReady }">
        {{ wechatReady ? "扫码完成充值" : (paymentReason || "当前不可用") }}
      </span>
    </div>

    <el-button
      type="danger"
      size="large"
      style="width: 100%; margin-top: 24px"
      :loading="submitting"
      :disabled="!finalAmount || !wechatReady"
      @click="submit"
    >
      立即充值 ¥{{ finalAmount }}
    </el-button>

    <div v-if="commissionEnabled" class="commission-card">
      <div>
        <strong>佣金转余额</strong>
        <span>可用佣金以服务端扣除冻结金额后的结果为准</span>
      </div>
      <div class="commission-balance">佣金余额 ¥{{ brokerageBalance }}</div>
      <el-input-number
        v-model="transferAmount"
        :min="0.01"
        :max="Math.max(Number(brokerageBalance), 0.01)"
        :precision="2"
        placeholder="转入金额"
      />
      <el-button
        type="warning"
        :loading="transferSubmitting"
        :disabled="!transferAmount || transferAmount <= 0"
        @click="submitCommissionTransfer"
      >
        转入余额
      </el-button>
      <small>转入后只能用于商城消费，不能再转回佣金或提现。</small>
    </div>

    <el-dialog v-model="qrVisible" title="微信扫码充值" width="360px" @closed="stopPolling">
      <div class="wechat-qr">
        <canvas ref="qrCanvas" />
        <strong>¥{{ pendingAmount }}</strong>
        <span>到账以微信支付回调为准</span>
      </div>
      <template #footer>
        <el-button @click="qrVisible = false">稍后支付</el-button>
        <el-button type="primary" @click="confirmPaid">我已完成支付</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import QRCode from "qrcode";
import { apiBrokerageToBalance, apiRechargeCreate, apiRechargeIndex } from "@/api/finance";
import { apiOrderCashier, apiPaymentReadiness, apiRechargePay } from "@/api/order";
import { apiUserInfo } from "@/api/user";

const amounts = ref<number[]>([50, 100, 200, 500, 1000]);
const selected = ref<number>(100);
const customAmount = ref<number | null>(null);
const balance = ref("0.00");
const brokerageBalance = ref("0.00");
const commissionEnabled = ref(false);
const transferAmount = ref<number | null>(null);
const transferSubmitting = ref(false);
const submitting = ref(false);
const wechatReady = ref(false);
const paymentReason = ref("");
const qrVisible = ref(false);
const qrCanvas = ref<HTMLCanvasElement | null>(null);
const pendingOrderId = ref("");
const pendingAmount = ref("0.00");
const quotaIds = ref<Record<string, number>>({});
const quotaGifts = ref<Record<string, string>>({});
let pollingToken = 0;

const finalAmount = computed(() => customAmount.value ?? selected.value ?? 0);

function selectAmount(amount: number) {
  selected.value = amount;
  customAmount.value = null;
}

async function submit() {
  if (!finalAmount.value) return;
  submitting.value = true;
  try {
    const rechargeId = customAmount.value === null
      ? quotaIds.value[String(selected.value)] ?? 0
      : 0;
    const res = await apiRechargeCreate(finalAmount.value, "h5", rechargeId);
    pendingOrderId.value = res.orderId;
    pendingAmount.value = res.price;
    const payment = await apiRechargePay(res.orderId, "pc");
    const codeUrl = typeof payment.jsConfig?.code_url === "string"
      ? payment.jsConfig.code_url
      : "";
    if (!codeUrl) throw new Error("微信支付二维码创建失败");
    qrVisible.value = true;
    await nextTick();
    if (!qrCanvas.value) throw new Error("微信支付二维码画布不可用");
    await QRCode.toCanvas(qrCanvas.value, codeUrl, { width: 220, margin: 1 });
    void pollPaid(++pollingToken);
  } catch (e) {
    ElMessage.error((e as Error).message || "充值失败");
  } finally {
    submitting.value = false;
  }
}

async function submitCommissionTransfer() {
  const amount = Number(transferAmount.value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return;
  try {
    await ElMessageBox.confirm(
      `确认将 ¥${amount.toFixed(2)} 佣金转入余额？转入后不可转回或提现。`,
      "确认佣金转余额",
      { type: "warning", confirmButtonText: "确认转入", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  transferSubmitting.value = true;
  try {
    const result = await apiBrokerageToBalance(amount);
    balance.value = result.nowMoney;
    brokerageBalance.value = result.brokeragePrice;
    transferAmount.value = null;
    ElMessage.success("佣金已转入余额");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "转入失败");
  } finally {
    transferSubmitting.value = false;
  }
}

async function pollPaid(token: number) {
  for (let attempt = 0; attempt < 30 && token === pollingToken; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (token !== pollingToken) return;
    try {
      const cashier = await apiOrderCashier(pendingOrderId.value, "recharge");
      if (cashier.paid) {
        balance.value = cashier.now_money;
        qrVisible.value = false;
        ElMessage.success("充值到账");
        return;
      }
    } catch {
      // 短暂网络错误不终止二维码有效期内的状态确认。
    }
  }
}

function stopPolling() {
  pollingToken += 1;
}

async function confirmPaid() {
  const cashier = await apiOrderCashier(pendingOrderId.value, "recharge");
  if (!cashier.paid) {
    ElMessage.warning("暂未收到充值结果，请稍后再试");
    return;
  }
  balance.value = cashier.now_money;
  qrVisible.value = false;
  ElMessage.success("充值到账");
}

onMounted(async () => {
  try {
    const readiness = await apiPaymentReadiness();
    wechatReady.value = readiness.weixin.enabled;
    paymentReason.value = readiness.weixin.reason;
  } catch (error) {
    paymentReason.value = error instanceof Error ? error.message : "支付状态加载失败";
  }
  try {
    const idx = await apiRechargeIndex();
    commissionEnabled.value = idx.user_extract_balance_status === 1;
    if (Array.isArray(idx.recharge_quota) && idx.recharge_quota.length) {
      const valid = idx.recharge_quota.filter((item) => Number(item.price) > 0);
      amounts.value = valid.map((item) => Number(item.price));
      quotaIds.value = Object.fromEntries(valid.map((item) => [String(Number(item.price)), item.id]));
      quotaGifts.value = Object.fromEntries(
        valid
          .filter((item) => Number(item.give_money) > 0)
          .map((item) => [String(Number(item.price)), Number(item.give_money).toFixed(2)]),
      );
      if (amounts.value.length) selected.value = amounts.value[0];
    }
  } catch {
    // 套餐接口异常时使用默认金额
  }
  try {
    const info = (await apiUserInfo()) as any;
    balance.value = info?.now_money ?? "0.00";
    brokerageBalance.value = info?.brokerage_price ?? "0.00";
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

.payment-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
  padding: 18px 20px;
  border-radius: 8px;
  background: #fff;
}

.payment-card span {
  color: #67c23a;
}

.payment-card span.unavailable {
  color: #909399;
}

.wechat-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.wechat-qr strong {
  color: #e64340;
  font-size: 24px;
}

.commission-card {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto 220px auto;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
  padding: 20px;
  border-radius: 8px;
  background: #fff;
}

.commission-card > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.commission-card span,
.commission-card small {
  color: #909399;
  font-size: 12px;
}

.commission-card small {
  grid-column: 1 / -1;
}

.commission-balance {
  color: #e6a23c;
  font-weight: 600;
}

@media (max-width: 768px) {
  .commission-card {
    grid-template-columns: 1fr;
  }

  .commission-card small {
    grid-column: auto;
  }
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
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  text-align: center;
  padding: 14px 0;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.amount-item small {
  color: #e6a23c;
  font-size: 12px;
  font-weight: 500;
}

.amount-item.active {
  border-color: #e64340;
  color: #e64340;
  background: #fff5f5;
}
</style>
