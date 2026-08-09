<template>
  <div class="cart container">
    <h2 class="title">购物车</h2>
    <el-empty v-if="!cartStore.items.length && !cartStore.loading" description="购物车是空的">
      <el-button type="primary" @click="$router.push('/goods')">去逛逛</el-button>
    </el-empty>
    <template v-else>
      <el-table :data="cartStore.items" @selection-change="onSelectionChange">
        <el-table-column type="selection" width="50" />
        <el-table-column label="商品" min-width="300">
          <template #default="{ row }">
            <div class="product-cell" @click="$router.push(`/goods/${row.productId}`)">
              <img v-if="row.productInfo" :src="row.productInfo.image" class="thumb" />
              <span class="name">{{ row.productInfo?.storeName ?? "商品已失效" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="单价" width="120">
          <template #default="{ row }">¥{{ row.productInfo?.price ?? "-" }}</template>
        </el-table-column>
        <el-table-column label="数量" width="160">
          <template #default="{ row }">
            <el-input-number
              :model-value="row.cartNum"
              :min="1"
              size="small"
              @change="(v: number | undefined) => updateNum(row.id, v ?? 1)"
            />
          </template>
        </el-table-column>
        <el-table-column label="小计" width="120">
          <template #default="{ row }">
            <span class="sum">¥{{ row.sumPrice }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button link type="danger" @click="removeItem(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="checkout-bar">
        <span class="total">
          合计: <span class="price">¥{{ cartStore.totalPrice }}</span>
        </span>
        <el-button
          type="primary"
          size="large"
          :disabled="!cartStore.checkedItems.length"
          @click="goCheckout"
        >
          去结算 ({{ cartStore.totalNum }})
        </el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useCartStore } from "@/stores/cart";
import { apiCartNum, apiCartDel } from "@/api/cart";
import type { CartItem } from "@/types/order";

const router = useRouter();
const cartStore = useCartStore();

function onSelectionChange(rows: CartItem[]) {
  const selected = new Set(rows.map((r) => r.id));
  cartStore.items.forEach((i) => (i.checked = selected.has(i.id)));
}

async function updateNum(id: number, num: number | undefined) {
  try {
    await apiCartNum(id, num ?? 1);
    cartStore.fetchList();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "修改失败");
  }
}

async function removeItem(id: number) {
  await apiCartDel([id]);
  cartStore.fetchList();
  ElMessage.success("已删除");
}

function goCheckout() {
  router.push("/checkout");
}

onMounted(() => {
  cartStore.fetchList();
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
}

.name {
  font-size: 14px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.sum {
  color: #e64340;
  font-weight: 600;
}

.checkout-bar {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 20px;
}

.price {
  color: #e64340;
  font-size: 22px;
  font-weight: 700;
}
</style>
