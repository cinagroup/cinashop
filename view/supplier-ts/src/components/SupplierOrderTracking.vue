<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getSupplierOrderTracking, type SupplierOrderTracking, type SupplierTrackingTarget } from '@/api/orderTracking';
import { previewMode } from '@/api/supplier';
import { createSupplierSessionScope } from '@/utils/supplierSession';

const props = defineProps<{ target: SupplierTrackingTarget | null; disabled?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const data = ref<SupplierOrderTracking | null>(null), loading = ref(false), error = ref('');
let generation = 0, request: AbortController | undefined, invalid = false;
function clear() { generation++; request?.abort(); data.value = null; error.value = ''; loading.value = false; }
const session = createSupplierSessionScope(() => { invalid = true; clear(); emit('close'); }, previewMode);
function active(ticket: number, target: SupplierTrackingTarget) {
  return !invalid && !props.disabled && session.isCurrent() && ticket === generation && props.target === target;
}
async function load() {
  clear();
  const target = props.target, ticket = generation;
  if (!target || invalid || props.disabled || !session.isCurrent()) return;
  request = new AbortController(); loading.value = true;
  try {
    const result = await getSupplierOrderTracking(target, request.signal);
    if (active(ticket, target)) data.value = result;
  } catch (cause) {
    if (active(ticket, target)) error.value = cause instanceof Error ? cause.message : '物流查询失败，请重试';
  } finally { if (active(ticket, target)) loading.value = false; }
}
function close() { clear(); emit('close'); }
function updateOpen(value: boolean) { if (!value) close(); }
watch(() => [props.target, props.disabled], () => { void load(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { invalid = true; clear(); session.dispose(); });
const source = computed(() => data.value?.trackingSource === 'cache' ? '最近查询缓存' : data.value?.trackingSource === 'carrier' ? '承运商返回' : '商家填写的运单');
</script>
<template>
  <el-dialog :model-value="!!target && !disabled" title="包裹物流" class="supplier-tracking-dialog" width="min(600px, 94vw)" append-to-body align-center @update:model-value="updateOpen">
    <div class="tracking-body">
      <p class="tracking-order">订单：{{ target?.order_id }}</p>
      <p v-if="loading" role="status">正在查询承运商物流…</p>
      <el-alert v-else-if="error" :title="error" type="error" :closable="false" show-icon />
      <template v-else-if="data">
        <dl><div><dt>快递公司</dt><dd>{{ data.expressName || '未填写' }}</dd></div><div><dt>运单号</dt><dd>{{ data.expressNo }}</dd></div><div><dt>数据来源</dt><dd>{{ source }}</dd></div></dl>
        <el-alert :title="data.message || data.deliveryStatus" :type="data.trackingState === 'exception' || data.trackingState === 'temporarily_unavailable' ? 'warning' : 'info'" :closable="false" show-icon />
        <el-timeline v-if="data.traces.length" aria-label="承运商物流轨迹">
          <el-timeline-item v-for="(trace, index) in data.traces" :key="index" :timestamp="trace.time"><strong>{{ trace.status }}</strong><p>{{ trace.content }}</p></el-timeline-item>
        </el-timeline>
        <p v-else role="status">{{ data.trackingState === 'not_configured' ? '物流查询服务尚未配置，暂无承运商轨迹。' : data.trackingState === 'temporarily_unavailable' ? '承运商暂不可用，稍后可重新查询。' : '承运商尚未返回轨迹。' }}</p>
      </template>
    </div>
    <template #footer><el-button :disabled="loading || disabled" @click="load">重新查询</el-button><el-button type="primary" @click="close">关闭</el-button></template>
  </el-dialog>
</template>
<style>
.supplier-tracking-dialog { max-height: calc(100dvh - 32px); display: flex; flex-direction: column; }
.supplier-tracking-dialog .el-dialog__body { overflow: auto; min-height: 0; }
.supplier-tracking-dialog .el-dialog__footer { flex-shrink: 0; }
</style>
<style scoped>
.tracking-body { overflow-wrap: anywhere; }
.tracking-order { margin-top: 0; font-weight: 600; }
dl { margin: 16px 0; }
dl > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 12px; margin: 8px 0; }
dt { color: var(--el-text-color-secondary); }
dd { margin: 0; }
.el-timeline { margin-top: 24px; padding-left: 10px; }
.el-timeline p { margin: 6px 0; line-height: 1.6; }
</style>
