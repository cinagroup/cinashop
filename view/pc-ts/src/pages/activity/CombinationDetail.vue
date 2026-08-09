<template>
  <div class="pink-detail container">
    <el-skeleton v-if="loading" :rows="6" animated />

    <div v-else-if="info" class="pink-main">
      <!-- 商品信息 -->
      <div class="pink-head">
        <div class="pink-img">
          <img :src="combo.image || placeholder" :alt="combo.storeName" />
        </div>
        <div class="pink-info">
          <div class="pink-name">{{ combo.storeName }}</div>
          <div class="pink-price">
            <span class="price">¥{{ info.price }}</span>
            <span class="ot-price">¥{{ info.otPrice }}</span>
          </div>
          <div class="pink-people">
            {{ info.people }} 人成团
          </div>
          <el-button type="danger" size="large" style="width: 220px" :loading="joining" @click="join">
            立即参团
          </el-button>
        </div>
      </div>

      <!-- 进行中的团 -->
      <h3 class="section-title">正在拼团 ({{ pinkList.length }})</h3>
      <div v-if="pinkList.length" class="pink-list">
        <div v-for="p in pinkList" :key="(p as any).id" class="pink-item">
          <div class="pink-item-info">
            <div class="pink-item-name">拼团发起人</div>
            <div class="pink-item-people">
              <el-progress :percentage="progressOf(p)" :stroke-width="10">
                <span class="progress-label">{{ (p as any).people }} / {{ info.people }} 人</span>
              </el-progress>
            </div>
          </div>
          <div class="pink-item-status">
            <el-tag v-if="(p as any).status === 1" type="success">拼团中</el-tag>
            <el-tag v-else type="info">已完成</el-tag>
          </div>
        </div>
      </div>
      <el-empty v-else description="暂无进行中的拼团, 快来发起第一个团吧" />
    </div>

    <el-empty v-else description="拼团活动不存在或已结束" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiCombinationPink, apiJoinPink } from "@/api/activity";
import { apiCartAdd } from "@/api/cart";
import { apiOrderCreate } from "@/api/order";
import { apiAddressList } from "@/api/order";

const route = useRoute();
const router = useRouter();
const comboId = Number(route.params.id);

const info = ref<any>(null);
const loading = ref(true);
const joining = ref(false);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const combo = computed<any>(() => (info.value as any)?.combination ?? {});
const pinkList = computed<any[]>(() => (info.value as any)?.pinkList ?? []);

function progressOf(p: unknown) {
  const people = Number((p as any).people ?? 1);
  const total = Number((info.value as any)?.people ?? 2);
  return Math.min(100, Math.round((people / total) * 100));
}

/** 参团: 加购 → 创建订单(type=2) → 生成团记录 → 跳支付 */
async function join() {
  joining.value = true;
  try {
    // 1. 地址 (取默认/第一个)
    const addrs = await apiAddressList();
    const addr = addrs.find((a) => (a as any).is_default === 1) ?? addrs[0];
    if (!addr) {
      ElMessage.warning("请先在个人中心添加收货地址");
      router.push("/user/address");
      return;
    }

    // 2. 加购 (拼团商品 SKU, 简化用首个 unique)
    const cart = await apiCartAdd({
      productId: (combo.value as any).productId,
      unique: "sku00001",
      cartNum: 1,
      type: 2,
    });

    // 3. 创建订单 (type=2 拼团)
    const key = `pink-${Date.now()}`;
    const order = await apiOrderCreate(key, {
      cartIds: [cart.id],
      realName: (addr as any).real_name,
      userPhone: (addr as any).phone,
      province: (addr as any).province ?? "",
      userAddress: (addr as any).detail ?? "",
      type: 2,
    });

    // 4. 生成团记录
    await apiJoinPink({
      combinationId: comboId,
      productId: (combo.value as any).productId,
      orderId: order.orderId,
    });

    ElMessage.success("参团成功, 请完成支付");
    router.push(`/order/${order.orderId}`);
  } catch (e) {
    ElMessage.error((e as Error).message || "参团失败");
  } finally {
    joining.value = false;
  }
}

onMounted(async () => {
  try {
    info.value = await apiCombinationPink(comboId);
  } catch {
    info.value = null;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.pink-head {
  display: flex;
  gap: 24px;
  background: #fff;
  border-radius: 8px;
  padding: 24px;
}

.pink-img {
  width: 280px;
  height: 280px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.pink-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pink-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pink-name {
  font-size: 18px;
  font-weight: 600;
}

.pink-price {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.price {
  color: #e64340;
  font-size: 26px;
  font-weight: 700;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
}

.pink-people {
  color: #666;
  font-size: 14px;
}

.section-title {
  margin: 24px 0 12px;
  font-size: 16px;
}

.pink-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pink-item {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.pink-item-info {
  flex: 1;
}

.pink-item-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}

.progress-label {
  font-size: 12px;
}
</style>
