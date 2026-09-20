<template>
  <div class="cart container">
    <h2 class="title">购物车</h2>
    <p v-if="cartStore.loading" role="status">正在读取购物车报价…</p>
    <div v-else-if="cartStore.error" role="alert"><p>{{ cartStore.error }}</p><el-button @click="reload">重新读取购物车</el-button></div>
    <el-empty v-else-if="!cartStore.items.length" description="购物车是空的">
      <el-button type="primary" @click="$router.push('/goods')">去逛逛</el-button>
    </el-empty>
    <template v-else>
      <el-table :data="cartStore.items">
        <el-table-column width="60">
          <template #header><el-checkbox aria-label="全选有效商品" :model-value="allChecked" :disabled="blocked" @change="(value: boolean | string | number) => cartStore.toggleAll(Boolean(value))" /></template>
          <template #default="{ row }"><el-checkbox :aria-label="`选择${row.productInfo?.storeName ?? '失效商品'}`" :model-value="row.checked" :disabled="blocked || !row.isValid" @change="(value: boolean | string | number) => cartStore.toggleChecked(row.id, Boolean(value))" /></template>
        </el-table-column>
        <el-table-column label="商品" min-width="300">
          <template #default="{ row }">
            <div class="product-cell" @click="$router.push(`/goods/${row.productId}`)">
              <ProductImage v-if="row.productInfo" :src="row.productInfo.image" :alt="row.productInfo.storeName" class="thumb" />
              <span class="name">{{ row.productInfo?.storeName ?? "商品已失效" }}</span>
              <small>{{ row.productInfo?.suk }}</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="单价" width="120">
          <template #default="{ row }"><template v-if="row.isValid">¥{{ cartUnitPrice(row) }}<small class="price-label">{{ cartPriceLabel(row) }}</small></template><span v-else>已失效</span></template>
        </el-table-column>
        <el-table-column label="数量" width="160">
          <template #default="{ row }">
            <el-input-number
              v-if="row.isValid"
              :model-value="row.cartNum"
              :min="1"
              :max="Math.min(row.productInfo?.stock ?? 0, 32767)"
              :disabled="blocked || !row.isValid"
              :aria-label="`数量 ${row.productInfo?.suk ?? '失效商品'}`"
              size="small"
              @change="(v: number | undefined) => cartStore.updateQuantity(row.id, v ?? 1)"
            />
            <span v-else>{{ row.cartNum }}</span>
          </template>
        </el-table-column>
        <el-table-column label="小计" width="120">
          <template #default="{ row }">
            <span v-if="row.isValid" class="sum">¥{{ cartLinePrice(row) }}</span><span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button link type="danger" :disabled="blocked" @click="cartStore.removeItem(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="checkout-bar">
        <small>商品预估金额，不含运费及其他优惠，以结算报价为准</small>
        <span class="total">
          合计: <span class="price">¥{{ cartStore.totalPrice }}</span>
        </span>
        <el-button
          type="primary"
          size="large"
          :disabled="blocked || !cartStore.checkedItems.length"
          @click="goCheckout"
        >
          去结算 ({{ cartStore.totalNum }})
        </el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import ProductImage from "@/components/ProductImage.vue";
import { computed, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useCartStore } from "@/stores/cart";
import { onAuthChange } from '@/utils/auth';
import { cartUnitPrice, cartLinePrice, cartPriceLabel } from '../../../../common/cartPrice';

const router = useRouter();
const cartStore = useCartStore();

const blocked = computed(() => !cartStore.ready || cartStore.loading || cartStore.updating);
const allChecked = computed(() => cartStore.items.some(row => row.isValid) && cartStore.items.filter(row => row.isValid).every(row => row.checked));
let disposed = false;
async function reload() { if (!disposed) await cartStore.fetchList().catch(() => {}); }
const unbind = onAuthChange(() => { void reload(); });

function goCheckout() {
  if (blocked.value || !cartStore.checkedItems.length) return;
  router.push("/checkout");
}

onMounted(reload);
onBeforeUnmount(() => { disposed = true; unbind(); cartStore.cancelPending(); });
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
.price-label { display: block; color: #9b5717; }

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
