<template>
  <div class="checkout container">
    <h2 class="title">确认订单</h2>

    <section class="section">
      <h3 class="section-title">配送方式</h3>
      <el-radio-group v-model="shippingType">
        <el-radio-button :value="1">快递配送</el-radio-button>
        <el-radio-button :value="2">门店自提</el-radio-button>
      </el-radio-group>
      <div v-if="shippingType === 2" class="store-list">
        <button
          v-for="store in pickupStores"
          :key="store.id"
          type="button"
          class="store-card"
          :class="{ selected: selectedStoreId === store.id }"
          @click="selectedStoreId = store.id"
        >
          <strong>{{ store.name }}</strong>
          <span>{{ store.address }}{{ store.detailed_address }}</span>
          <small>{{ store.day_time || store.valid_time || "营业时间以门店通知为准" }}</small>
        </button>
        <el-empty v-if="!pickupStores.length" description="暂无营业中的自提门店" />
      </div>
    </section>

    <!-- 收货地址 -->
    <section v-if="shippingType === 1" class="section">
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

    <section v-else class="section">
      <h3 class="section-title">自提联系人</h3>
      <el-form label-width="90px" class="pickup-contact">
        <el-form-item label="联系人"><el-input v-model="pickupContact.realName" maxlength="32" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="pickupContact.phone" maxlength="18" /></el-form-item>
      </el-form>
    </section>

    <!-- 商品清单 -->
    <section class="section">
      <h3 class="section-title">商品清单</h3>
      <el-table :data="checkoutItems">
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
      <div v-if="firstOrderQuote?.eligible" class="first-order-summary">
        <span>首单优惠（不与优惠券叠加）</span>
        <strong v-if="firstOrderDiscount > 0">-¥{{ firstOrderDiscount.toFixed(2) }}</strong>
        <span v-else>已启用</span>
      </div>
    </section>

    <SystemFormFields
      v-if="customForm.length"
      v-model="customForm"
      :title="systemFormName"
    />

    <!-- 备注 + 提交 -->
    <section class="section submit-section">
      <div class="remark-row">
        <span>订单备注:</span>
        <el-input v-model="remark" placeholder="选填" class="remark-input" />
      </div>
      <div class="submit-row">
        <span class="total">
          应付: <span class="price">¥{{ checkoutTotal }}</span>
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
import { computed, ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useCartStore } from "@/stores/cart";
import {
  apiAddressList,
  apiAddressSave,
  apiFirstOrderQuote,
  apiOrderCreate,
  apiOrderSystemForm,
  apiPickupStores,
} from "@/api/order";
import type { FirstOrderQuote, PickupStore, UserAddress } from "@/types/order";
import type { SystemFormComponent } from "@/types/systemForm";
import SystemFormFields from "@/components/SystemFormFields.vue";

const router = useRouter();
const route = useRoute();
const cartStore = useCartStore();

const addresses = ref<UserAddress[]>([]);
const selectedAddrId = ref(0);
const shippingType = ref<1 | 2>(1);
const pickupStores = ref<PickupStore[]>([]);
const selectedStoreId = ref(0);
const pickupContact = ref({ realName: "", phone: "" });
const remark = ref("");
const submitting = ref(false);
const showAddressDialog = ref(false);
const addrForm = ref({ realName: "", phone: "", region: "", detail: "" });
const customForm = ref<SystemFormComponent[]>([]);
const systemFormName = ref("");
const systemFormError = ref("");
const firstOrderQuote = ref<FirstOrderQuote | null>(null);
const directCartIds = computed(() => {
  const raw = String(route.query.cartIds ?? route.query.cartId ?? "");
  const ids = [...new Set(raw.split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  return ids.length <= 100 ? ids : [];
});
const checkoutItems = computed(() => {
  const ids = new Set(directCartIds.value);
  return route.query.mode === "buy" && ids.size > 0
    ? cartStore.items.filter((item) => ids.has(item.id))
    : cartStore.checkedItems;
});
const firstOrderDiscount = computed(() => Number(firstOrderQuote.value?.firstOrderPrice ?? 0));
const checkoutTotal = computed(() => Math.max(
  0,
  checkoutItems.value.reduce((sum, item) => sum + Number(item.sumPrice), 0)
    - firstOrderDiscount.value,
).toFixed(2));

async function loadFirstOrderQuote() {
  const cartIds = checkoutItems.value.map((item) => item.id);
  if (!cartIds.length) {
    firstOrderQuote.value = null;
    return;
  }
  try {
    firstOrderQuote.value = await apiFirstOrderQuote(cartIds);
  } catch {
    firstOrderQuote.value = null;
  }
}

function choiceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidate = record.val ?? record.value ?? record.label;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
}

function initializeComponent(item: SystemFormComponent): SystemFormComponent {
  let value = item.value;
  const hasValue = Array.isArray(value) ? value.length > 0 : String(value ?? "").trim().length > 0;
  if (!hasValue && item.name === "texts") value = item.defaultValConfig?.value ?? "";
  else if (!hasValue && item.name === "radios") value = choiceText(item.wordsConfig?.list?.[0]);
  else if (item.name === "uploadPicture" || item.name === "dateranges") value = hasValue && Array.isArray(value) ? value : [];
  else if (!hasValue) value = "";
  return { ...item, value };
}

async function loadSystemForm() {
  const ids = [...new Set(checkoutItems.value
    .map((item) => Number(item.productInfo?.systemFormId ?? 0))
    .filter((id) => id > 0))];
  customForm.value = [];
  systemFormName.value = "";
  systemFormError.value = ids.length > 1 ? "同一订单不能包含不同的自定义表单" : "";
  if (systemFormError.value) return;
  if (!ids[0]) return;
  try {
    const form = await apiOrderSystemForm(ids[0]);
    systemFormName.value = form.name;
    customForm.value = form.value.map(initializeComponent);
  } catch (error) {
    systemFormError.value = error instanceof Error ? error.message : "系统表单加载失败";
  }
}

async function loadAddresses() {
  try {
    addresses.value = await apiAddressList();
    const def = addresses.value.find((a) => a.is_default);
    selectedAddrId.value = def?.id ?? addresses.value[0]?.id ?? 0;
    const contact = def ?? addresses.value[0];
    if (contact && !pickupContact.value.realName && !pickupContact.value.phone) {
      pickupContact.value = { realName: contact.real_name, phone: contact.phone };
    }
  } catch {
    // ignore
  }
}

async function loadPickupStores() {
  try {
    pickupStores.value = await apiPickupStores();
    selectedStoreId.value = pickupStores.value[0]?.id ?? 0;
  } catch {
    pickupStores.value = [];
    selectedStoreId.value = 0;
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
  const addr = addresses.value.find((a) => a.id === selectedAddrId.value);
  if (shippingType.value === 1 && !addr) return ElMessage.error("请选择收货地址");
  if (shippingType.value === 2 && !selectedStoreId.value) return ElMessage.error("请选择自提门店");
  if (
    shippingType.value === 2
    && (!pickupContact.value.realName.trim() || !pickupContact.value.phone.trim())
  ) {
    return ElMessage.error("请填写自提联系人和手机号");
  }

  const items = checkoutItems.value;
  if (!items.length) return ElMessage.error("请选择商品");
  if (systemFormError.value) return ElMessage.error(systemFormError.value);

  submitting.value = true;
  try {
    const key = `pc_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = await apiOrderCreate(key, {
      cartIds: items.map((i) => i.id),
      realName: shippingType.value === 1 ? addr?.real_name : pickupContact.value.realName.trim(),
      userPhone: shippingType.value === 1 ? addr?.phone : pickupContact.value.phone.trim(),
      province: shippingType.value === 1 ? addr?.province : "",
      userAddress: shippingType.value === 1 && addr
        ? `${addr.city}${addr.district}${addr.detail}`
        : "",
      shippingType: shippingType.value,
      storeId: shippingType.value === 2 ? selectedStoreId.value : 0,
      mark: remark.value,
      customForm: customForm.value,
      type: Number(route.query.type ?? 0) || undefined,
      pinkId: Number(route.query.pinkId ?? 0) || undefined,
      combinationId: Number(route.query.combinationId ?? 0) || undefined,
      seckillId: Number(route.query.seckillId ?? 0) || undefined,
      bargainUserId: Number(route.query.bargainUserId ?? 0) || undefined,
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
  await Promise.all([cartStore.fetchList(), loadAddresses(), loadPickupStores()]);
  await Promise.all([loadSystemForm(), loadFirstOrderQuote()]);
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

.first-order-summary {
  display: flex;
  justify-content: flex-end;
  gap: 16px;
  margin-top: 16px;
  color: #666;
}

.first-order-summary strong {
  color: #e64340;
}

.store-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.store-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  padding: 14px;
  cursor: pointer;
}

.store-card.selected {
  border-color: #e64340;
  box-shadow: 0 0 0 1px #e64340;
}

.store-card span,
.store-card small {
  color: #666;
}

.pickup-contact {
  max-width: 520px;
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
