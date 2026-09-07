<template>
  <view v-if="visible" class="mask" @tap="close">
    <view class="sheet" @tap.stop>
      <view>选择商品规格</view>
      <view class="muted">活动资格、库存及价格将在服务端校验，最终金额以结算报价为准。</view>
      <view v-if="loading">加载规格中…</view>
      <view v-if="error" class="error">{{ error }}<button size="mini" :disabled="buying" @tap="load">重新加载</button></view>
      <button v-for="sku in skus" :key="sku.unique" :disabled="sku.stock <= 0 || buying" :class="{ active: selected === sku.unique }" @tap="selected = sku.unique">{{ sku.suk }} · 基础库存 {{ sku.stock }}</button>
      <button :disabled="loading || buying || !selected" :loading="buying" @tap="purchase">去结算</button>
      <button :disabled="buying" @tap="close">取消</button>
    </view>
  </view>
</template>
<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";
import { apiGoodsDetail } from "@/api/product";
import { apiCartAdd } from "@/api/order";
import type { GoodsSku } from "@/types/product";
const props = defineProps<{ visible: boolean; productId: number; activityId: number; type: 1 | 2 | 3 }>();
const emit = defineEmits<{ (event: "close"): void; (event: "purchased", id: number): void }>();
const skus = ref<GoodsSku[]>([]), selected = ref(""), loading = ref(false), buying = ref(false), error = ref("");
let generation = 0;
async function load() {
  const revision = ++generation; loading.value = true; buying.value = false; error.value = ""; skus.value = []; selected.value = "";
  try {
    const goods = await apiGoodsDetail(props.productId);
    if (revision !== generation) return;
    if (goods.id !== props.productId) throw new Error("活动商品不匹配");
    skus.value = goods.skus;
    selected.value = goods.skus.find((sku) => sku.stock > 0)?.unique ?? "";
    if (!selected.value) error.value = "暂无可购买规格";
  } catch (e) { if (revision === generation) error.value = e instanceof Error ? e.message : "规格加载失败"; }
  finally { if (revision === generation) loading.value = false; }
}
function close() { if (!buying.value) emit("close"); }
async function purchase() {
  if (loading.value || buying.value || !skus.value.some((sku) => sku.unique === selected.value && sku.stock > 0)) return;
  buying.value = true; error.value = ""; const revision = generation;
  try {
    const result = await apiCartAdd({ productId: props.productId, unique: selected.value, cartNum: 1, type: props.type, activityId: props.activityId, new: 1 });
    if (revision === generation && props.visible) emit("purchased", result.id);
  } catch (e) { if (revision === generation) error.value = e instanceof Error ? e.message : "活动加购失败"; }
  finally { if (revision === generation) buying.value = false; }
}
watch(() => [props.visible, props.productId, props.activityId, props.type], () => { if (props.visible) void load(); else generation++; }, { immediate: true });
onUnmounted(() => { generation++; });
</script>
<style scoped>
.mask { position: fixed; inset: 0; z-index: 100; background: #0008; display: flex; align-items: flex-end; }
.sheet { box-sizing: border-box; width: 100%; padding: 28rpx; background: white; border-radius: 24rpx 24rpx 0 0; max-height: 80vh; overflow-y: auto; }
.sheet button { font-size: 28rpx; margin-top: 16rpx; }
.active { color: #e93323; border: 2rpx solid #e93323; }
.muted { color: #777; font-size: 24rpx; margin: 16rpx 0; }
.error { color: #b72a1d; }
</style>
