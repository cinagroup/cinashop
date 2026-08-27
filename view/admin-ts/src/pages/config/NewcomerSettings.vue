<template>
  <div class="newcomer-page" v-loading="loading">
    <div class="page-head">
      <div>
        <h2>新人运营</h2>
        <p>统一管理注册方式、注册赠礼、首单优惠和新人专享商品。</p>
      </div>
      <el-button type="primary" :loading="saving" :disabled="!canSave" @click="save">
        保存配置
      </el-button>
    </div>

    <el-alert
      v-if="form.missing_config_keys.length"
      type="warning"
      :closable="false"
      show-icon
      class="section"
      title="生产库尚未保存这些配置；当前按安全默认值展示，只有点击保存后才会写入。"
    >
      <template #default>{{ form.missing_config_keys.join("、") }}</template>
    </el-alert>

    <el-alert :title="form.register_notice" type="info" :closable="false" show-icon class="section" />

    <el-card class="section" shadow="never">
      <template #header><strong>注册与新人礼</strong></template>
      <div class="form-grid">
        <div class="field switch-field">
          <span>新人礼总开关</span>
          <el-switch v-model="form.newcomer_status" :active-value="1" :inactive-value="0" />
        </div>
        <div class="field switch-field">
          <span>强制手机号登录</span>
          <el-switch v-model="form.store_user_mobile" :active-value="1" :inactive-value="0" />
        </div>
        <div class="field switch-field">
          <span>展示注册协议</span>
          <el-switch v-model="form.store_user_agreement" :active-value="1" :inactive-value="0" />
        </div>
        <div class="field">
          <label>小程序登录方式</label>
          <el-checkbox-group v-model="form.routine_auth_type">
            <el-checkbox :value="1">手机号授权</el-checkbox>
            <el-checkbox :value="2">微信授权</el-checkbox>
          </el-checkbox-group>
        </div>
        <div class="field switch-field">
          <span>限制新人礼时效</span>
          <el-switch v-model="form.newcomer_limit_status" :active-value="1" :inactive-value="0" />
        </div>
        <div class="field">
          <label>有效天数</label>
          <el-input-number v-model="form.newcomer_limit_time" :min="0" :max="36500" />
        </div>
      </div>
    </el-card>

    <el-card class="section" shadow="never">
      <template #header><strong>注册赠礼</strong></template>
      <div class="gift-grid">
        <div class="gift-box">
          <div class="switch-field"><span>赠送积分</span><el-switch v-model="form.register_integral_status" :active-value="1" :inactive-value="0" /></div>
          <el-input-number v-model="form.register_give_integral" :min="0" :max="2147483647" controls-position="right" />
        </div>
        <div class="gift-box">
          <div class="switch-field"><span>赠送余额</span><el-switch v-model="form.register_money_status" :active-value="1" :inactive-value="0" /></div>
          <el-input v-model="form.register_give_money" inputmode="decimal"><template #append>元</template></el-input>
          <small>兼容 PHP：实际入账按整数元截断。</small>
        </div>
        <div class="gift-box coupon-box">
          <div class="switch-field"><span>赠送优惠券</span><el-switch v-model="form.register_coupon_status" :active-value="1" :inactive-value="0" /></div>
          <el-select v-model="couponIds" multiple filterable collapse-tags placeholder="选择优惠券" style="width: 100%">
            <el-option v-for="coupon in couponOptions" :key="coupon.id" :label="`${coupon.title}（减 ${coupon.coupon_price}）`" :value="coupon.id" />
          </el-select>
        </div>
      </div>
    </el-card>

    <el-card class="section" shadow="never">
      <template #header><strong>首单优惠</strong></template>
      <div class="form-grid">
        <div class="field switch-field">
          <span>启用首单优惠</span>
          <el-switch v-model="form.first_order_status" :active-value="1" :inactive-value="0" />
        </div>
        <div class="field">
          <label>用户支付比例</label>
          <el-input v-model="form.first_order_discount" inputmode="decimal"><template #append>%</template></el-input>
          <small>90 表示支付原价的 90%，即九折。</small>
        </div>
        <div class="field">
          <label>单笔优惠上限</label>
          <el-input v-model="form.first_order_discount_limit" inputmode="decimal"><template #append>元</template></el-input>
        </div>
      </div>
    </el-card>

    <el-card class="section" shadow="never">
      <template #header>
        <div class="card-head">
          <div>
            <strong>新人专享商品</strong>
            <span class="subtle">普通商品库存仍是唯一库存来源</span>
          </div>
          <div class="catalog-actions">
            <el-switch v-model="form.register_price_status" :active-value="1" :inactive-value="0" active-text="启用专享价" />
            <el-button type="primary" plain @click="openProducts">选择商品</el-button>
          </div>
        </div>
      </template>
      <el-empty v-if="!form.product.length" description="尚未选择新人专享商品" />
      <div v-else class="product-list">
        <article v-for="product in form.product" :key="product.product_id" class="product-card">
          <div class="product-title">
            <el-image :src="product.image" fit="cover" class="product-image">
              <template #error><div class="image-fallback">商品</div></template>
            </el-image>
            <div>
              <strong>{{ product.store_name }}</strong>
              <div class="subtle">ID {{ product.product_id }} · 库存 {{ product.stock }} · 原价 ¥{{ product.ot_price }}</div>
            </div>
            <el-button type="danger" link @click="removeProduct(product.product_id)">移除</el-button>
          </div>
          <div class="sku-list">
            <div v-for="sku in product.attr" :key="sku.unique" class="sku-row">
              <span>{{ sku.suk }}</span>
              <span class="subtle">库存 {{ sku.stock }}</span>
              <el-input v-model="sku.price" inputmode="decimal" aria-label="新人专享价"><template #prepend>¥</template></el-input>
            </div>
          </div>
        </article>
      </div>
    </el-card>

    <el-card class="section" shadow="never">
      <template #header><strong>新人规则说明</strong></template>
      <el-input v-model="form.newcomer_agreement" type="textarea" :rows="8" maxlength="200000" show-word-limit placeholder="向用户说明使用期限、限制和互斥规则" />
    </el-card>

    <div class="footer-actions">
      <span v-if="!canSave" class="subtle">当前账号只有查看权限</span>
      <el-button type="primary" size="large" :loading="saving" :disabled="!canSave" @click="save">保存配置</el-button>
    </div>

    <el-dialog v-model="productDialog" title="选择普通商品" width="min(900px, 94vw)" destroy-on-close>
      <div class="dialog-search">
        <el-input v-model="productKeyword" clearable placeholder="商品名称或 ID" @keyup.enter="loadProductOptions" />
        <el-button type="primary" @click="loadProductOptions">搜索</el-button>
      </div>
      <div class="option-list" v-loading="productLoading">
        <article v-for="product in productOptions" :key="product.id" class="option-card">
          <div>
            <strong>{{ product.store_name }}</strong>
            <div class="subtle">ID {{ product.id }} · {{ product.attr.length }} 个规格 · 库存 {{ product.stock }}</div>
          </div>
          <el-button :disabled="selectedProductIds.has(product.id)" @click="addProduct(product)">
            {{ selectedProductIds.has(product.id) ? "已选择" : "添加" }}
          </el-button>
        </article>
      </div>
      <el-pagination
        v-model:current-page="productPage"
        :page-size="20"
        :total="productTotal"
        layout="prev, pager, next"
        @current-change="loadProductOptions"
      />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  apiNewcomerCoupons,
  apiNewcomerProducts,
  apiRegisterConfig,
  apiSaveRegisterConfig,
  type NewcomerCoupon,
  type NewcomerProductOption,
  type RegisterConfig,
  type RegisterConfigPayload,
} from "@/api/newcomer";
import { useAuthStore } from "@/stores/auth";

const emptyForm = (): RegisterConfig => ({
  store_user_mobile: 0,
  routine_auth_type: [1, 2],
  store_user_agreement: 1,
  newcomer_status: 0,
  newcomer_limit_status: 1,
  newcomer_limit_time: 0,
  register_integral_status: 0,
  register_give_integral: 0,
  register_money_status: 0,
  register_give_money: "0.00",
  register_coupon_status: 0,
  register_give_coupon: [],
  first_order_status: 0,
  first_order_discount: "100",
  first_order_discount_limit: "0.00",
  register_price_status: 0,
  product: [],
  newcomer_agreement: "",
  register_notice: "",
  missing_config_keys: [],
});

const authStore = useAuthStore();
const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const canSave = computed(() => previewMode || authStore.userInfo?.level === 0 || authStore.uniqueAuth.includes("config.manage"));
const form = ref<RegisterConfig>(emptyForm());
const couponIds = ref<number[]>([]);
const couponOptions = ref<NewcomerCoupon[]>([]);
const loading = ref(true);
const saving = ref(false);
const productDialog = ref(false);
const productLoading = ref(false);
const productKeyword = ref("");
const productPage = ref(1);
const productTotal = ref(0);
const productOptions = ref<NewcomerProductOption[]>([]);
const selectedProductIds = computed(() => new Set(form.value.product.map((product) => product.product_id)));

async function load() {
  loading.value = true;
  try {
    const [config, coupons] = await Promise.all([
      apiRegisterConfig(),
      apiNewcomerCoupons({ page: 1, limit: 100 }),
    ]);
    form.value = config;
    couponIds.value = config.register_give_coupon.map((coupon) => coupon.id);
    const merged = new Map<number, NewcomerCoupon>();
    for (const coupon of [...config.register_give_coupon, ...coupons.list]) merged.set(coupon.id, coupon);
    couponOptions.value = [...merged.values()];
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "新人配置加载失败");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  if (!form.value.routine_auth_type.length) {
    ElMessage.warning("至少选择一种小程序登录方式");
    return;
  }
  saving.value = true;
  try {
    const payload: RegisterConfigPayload = {
      ...form.value,
      register_give_coupon: [...couponIds.value],
      product: form.value.product.map((product) => ({
        product_id: product.product_id,
        attr: product.attr.map((sku) => ({ unique: sku.unique, price: sku.price })),
      })),
    };
    const saved = await apiSaveRegisterConfig(payload);
    form.value = saved;
    couponIds.value = saved.register_give_coupon.map((coupon) => coupon.id);
    ElMessage.success("新人运营配置已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function openProducts() {
  productDialog.value = true;
  productPage.value = 1;
  await loadProductOptions();
}

async function loadProductOptions() {
  productLoading.value = true;
  try {
    const result = await apiNewcomerProducts({ page: productPage.value, limit: 20, keyword: productKeyword.value });
    productOptions.value = result.list;
    productTotal.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "商品加载失败");
  } finally {
    productLoading.value = false;
  }
}

function addProduct(product: NewcomerProductOption) {
  if (selectedProductIds.value.has(product.id)) return;
  if (!product.attr.length) {
    ElMessage.warning("该商品没有可用规格");
    return;
  }
  form.value.product.push({
    product_id: product.id,
    store_name: product.store_name,
    image: product.image,
    price: product.price,
    ot_price: product.ot_price,
    stock: product.stock,
    attr: product.attr.map((sku) => ({ ...sku, price: sku.price })),
  });
}

function removeProduct(productId: number) {
  form.value.product = form.value.product.filter((product) => product.product_id !== productId);
}

onMounted(load);
</script>

<style scoped>
.newcomer-page { max-width: 1180px; margin: 0 auto; }
.page-head, .card-head, .switch-field, .product-title, .sku-row, .dialog-search, .option-card, .footer-actions { display: flex; align-items: center; }
.page-head, .card-head, .option-card, .footer-actions { justify-content: space-between; }
.page-head { gap: 16px; margin-bottom: 18px; }
.page-head h2 { margin: 0 0 5px; font-size: 22px; }
.page-head p { margin: 0; color: #7a8492; }
.section { margin-bottom: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 24px; }
.gift-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.field, .gift-box { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.switch-field { justify-content: space-between; gap: 12px; }
.gift-box { padding: 15px; border: 1px solid #e8ebef; border-radius: 10px; background: #fafbfc; }
.coupon-box { grid-column: span 1; }
.subtle, small { color: #84909d; font-size: 12px; }
.card-head { gap: 16px; }
.card-head strong { margin-right: 10px; }
.catalog-actions { display: flex; align-items: center; gap: 14px; }
.product-list { display: grid; gap: 12px; }
.product-card { padding: 14px; border: 1px solid #e5e8ec; border-radius: 10px; }
.product-title { gap: 12px; }
.product-title > div:nth-child(2) { flex: 1; min-width: 0; }
.product-image { width: 52px; height: 52px; border-radius: 8px; background: #f1f3f5; flex: 0 0 auto; }
.image-fallback { width: 100%; height: 100%; display: grid; place-items: center; color: #9aa3ad; font-size: 12px; }
.sku-list { display: grid; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e5e8ec; }
.sku-row { display: grid; grid-template-columns: minmax(100px, 1fr) 100px minmax(150px, 220px); gap: 12px; }
.dialog-search { gap: 10px; margin-bottom: 14px; }
.option-list { display: grid; gap: 8px; min-height: 120px; margin-bottom: 16px; }
.option-card { gap: 12px; padding: 12px; border: 1px solid #e7eaee; border-radius: 8px; }
.footer-actions { gap: 16px; padding: 4px 0 28px; }
@media (max-width: 900px) {
  .form-grid, .gift-grid { grid-template-columns: 1fr 1fr; }
  .coupon-box { grid-column: span 2; }
}
@media (max-width: 640px) {
  .page-head, .card-head { align-items: flex-start; flex-direction: column; }
  .form-grid, .gift-grid { grid-template-columns: 1fr; }
  .coupon-box { grid-column: auto; }
  .catalog-actions { width: 100%; justify-content: space-between; }
  .sku-row { grid-template-columns: 1fr auto; }
  .sku-row :deep(.el-input) { grid-column: 1 / -1; }
  .page-head > .el-button { width: 100%; }
}
</style>
