<template>
  <div class="checkout container">
    <h2 class="title">确认订单</h2>

    <!-- 收货地址 -->
    <section class="section">
      <h3 class="section-title">收货地址</h3>
      <div class="address-list">
        <div
          v-for="addr in addresses"
          :key="addr.id"
          class="address-card"
          :class="{ selected: selectedAddrId === addr.id }"
          @click="selectedAddrId = addr.id"
        >
          <div class="addr-top">
            <span class="name">{{ addr.real_name }}</span>
            <span class="phone">{{ addr.phone }}</span>
            <el-tag v-if="addr.is_default" size="small" type="danger">默认</el-tag>
          </div>
          <div class="addr-detail">
            {{ addr.province }}{{ addr.city }}{{ addr.district }}{{ addr.detail }}
          </div>
        </div>
      </div>
      <el-button size="small" @click="showAddressDialog = true">+ 新增地址</el-button>
    </section>

    <!-- 商品清单 -->
    <section class="section">
      <h3 class="section-title">商品清单</h3>
      <el-table :data="cartStore.checkedItems">
        <el-table-column label="商品">
          <template #default="{ row }">
            <div class="product-cell">
              <img v-if="row.productInfo" :src="row.productInfo.image" class="thumb" />
              <span>{{ row.productInfo?.storeName }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="单价" width="120">
          <template #default="{ row }">¥{{ row.productInfo?.price }}</template>
        </el-table-column>
        <el-table-column prop="cartNum" label="数量" width="80" />
        <el-table-column label="小计" width="120">
          <template #default="{ row }">¥{{ row.sumPrice }}</template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 备注 + 提交 -->
    <section class="section submit-section">
      <div class="remark-row">
        <span>订单备注:</span>
        <el-input v-model="remark" placeholder="选填" class="remark-input" />
      </div>
      <div class="submit-row">
        <span class="total">
          应付: <span class="price">¥{{ cartStore.totalPrice }}</span>
        </span>
        <el-button type="primary" size="large" :loading="submitting" @click="submitOrder">
          提交订单
        </el-button>
      </div>
    </section>

    <!-- 新增地址弹窗 -->
    <el-dialog v-model="showAddressDialog" title="新增地址" width="480px">
      <el-form :model="addrForm" label-width="80px">
        <el-form-item label="收货人"><el-input v-model="addrForm.realName" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="addrForm.phone" /></el-form-item>
        <el-form-item label="省市区">
          <el-input v-model="addrForm.region" placeholder="如: 北京市 朝阳区" />
        </el-form-item>
        <el-form-item label="详细地址"><el-input v-model="addrForm.detail" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddressDialog = false">取消</el-button>
        <el-button type="primary" @click="saveAddress">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useCartStore } from "@/stores/cart";
import { apiAddressList, apiAddressSave, apiOrderCreate } from "@/api/order";
import type { UserAddress } from "@/types/order";

const router = useRouter();
const cartStore = useCartStore();

const addresses = ref<UserAddress[]>([]);
const selectedAddrId = ref(0);
const remark = ref("");
const submitting = ref(false);
const showAddressDialog = ref(false);
const addrForm = ref({ realName: "", phone: "", region: "", detail: "" });

async function loadAddresses() {
  try {
    addresses.value = await apiAddressList();
    const def = addresses.value.find((a) => a.is_default);
    selectedAddrId.value = def?.id ?? addresses.value[0]?.id ?? 0;
  } catch {
    // ignore
  }
}

async function saveAddress() {
  const f = addrForm.value;
  if (!f.realName || !f.phone || !f.detail) return ElMessage.error("请填写完整地址信息");
  const [province = "", city = "", district = ""] = f.region.split(/\s+/);
  await apiAddressSave({
    real_name: f.realName,
    phone: f.phone,
    province,
    city,
    district,
    detail: f.detail,
  });
  showAddressDialog.value = false;
  ElMessage.success("地址已保存");
  await loadAddresses();
}

async function submitOrder() {
  if (!selectedAddrId.value) return ElMessage.error("请选择收货地址");
  const addr = addresses.value.find((a) => a.id === selectedAddrId.value);
  if (!addr) return ElMessage.error("请选择收货地址");

  const items = cartStore.checkedItems;
  if (!items.length) return ElMessage.error("请选择商品");

  submitting.value = true;
  try {
    const key = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await apiOrderCreate(key, {
      cartIds: items.map((i) => i.id),
      realName: addr.real_name,
      userPhone: addr.phone,
      province: addr.province,
      userAddress: `${addr.city}${addr.district}${addr.detail}`,
      mark: remark.value,
    });
    ElMessage.success("订单创建成功");
    await cartStore.fetchList();
    router.push(`/order/${result.orderId}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "下单失败");
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await Promise.all([cartStore.fetchList(), loadAddresses()]);
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.section {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}

.section-title {
  font-size: 16px;
  margin-bottom: 16px;
}

.address-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}

.address-card {
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.2s;
}

.address-card.selected {
  border-color: #e64340;
}

.addr-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.name {
  font-weight: 600;
}

.phone {
  color: #999;
}

.addr-detail {
  font-size: 13px;
  color: #666;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
}

.submit-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.remark-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.remark-input {
  max-width: 400px;
}

.submit-row {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 20px;
}

.price {
  color: #e64340;
  font-size: 24px;
  font-weight: 700;
}
</style>
