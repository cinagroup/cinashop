<template>
  <el-dialog :model-value="modelValue" :title="restore ? '恢复商品' : '移入回收站'" width="min(560px, 94vw)"
    :before-close="beforeClose" :close-on-click-modal="!busy" :close-on-press-escape="!busy" @update:model-value="visibleChange">
    <p class="product-name">{{ product.store_name }}（#{{ product.id }}）</p>
    <p>当前状态：{{ product.is_del === 1 ? '回收站中' : '未回收' }}；{{ product.is_show === 1 ? '上架标记开启' : '未上架' }}</p>
    <p v-if="restore">恢复只清除回收站标记，上架状态保持原值。</p>
    <p v-else>移入回收站后，该商品将下架。</p>
    <p v-if="product.type === 0">关联的子商品会同步回收站状态。</p>
    <p v-if="product.type === 1">门店商品会回到待审核状态。</p>
    <el-alert title="此操作会使该商品现有的全部购物车记录失效。" type="warning" :closable="false" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" class="notice" />
    <el-alert v-if="uncertain" title="上次操作结果尚未确认。请重新读取商品，在相应状态列表中核对后再决定新的操作。" type="warning" :closable="false" class="notice" />
    <template #footer>
      <el-button :disabled="busy" @click="close">取消</el-button>
      <el-button v-if="uncertain" :disabled="busy" @click="emit('refresh')">重新读取商品</el-button>
      <el-button v-if="uncertain" :disabled="busy || !canAcknowledgeRecycle(product.id)" @click="acknowledge">已核对，开始新的操作</el-button>
      <el-button :type="restore ? 'primary' : 'danger'" :loading="busy" :disabled="disabled" @click="save">{{ restore ? '确认恢复' : '确认移入回收站' }}</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getToken } from '@/utils/auth';
import type { AdminProductCatalogItem } from '@/api/product';
import { acknowledgeRecycleRead, apiAdminProductRecycle, canAcknowledgeRecycle, hasUnconfirmedRecycle } from '@/api/productRecycle';
const props = defineProps<{ modelValue: boolean; product: AdminProductCatalogItem; canManage: boolean; contextKey: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: []; refresh: [] }>();
const busy = ref(false), uncertain = ref(false), error = ref('');
const restore = computed(() => props.product.is_del === 1);
const disabled = computed(() => !props.canManage || busy.value || uncertain.value || ![0,1].includes(props.product.is_del));
let epoch = 0, alive = true;
const stamp = () => ({ epoch, product: props.product.id, expected: props.product.is_del, context: props.contextKey, token: getToken(), session: localStorage.getItem('admin_session') });
const current = (scope: ReturnType<typeof stamp>) => alive && props.modelValue && props.canManage && epoch === scope.epoch && props.product.id === scope.product && props.product.is_del === scope.expected && props.contextKey === scope.context && !!scope.token && getToken() === scope.token && localStorage.getItem('admin_session') === scope.session;
function reset() { epoch++; busy.value = uncertain.value = false; error.value = ''; }
function close() { if (busy.value) return; reset(); emit('update:modelValue', false); }
function beforeClose(done: () => void) { if (!busy.value) { close(); done(); } }
function visibleChange(value: boolean) { if (!value) close(); }
async function acknowledge() {
  const scope = stamp(); if (!current(scope) || busy.value || !uncertain.value) return;
  try { await acknowledgeRecycleRead(scope.product); if (current(scope)) { uncertain.value = false; error.value = ''; } }
  catch (value) { if (current(scope)) error.value = value instanceof Error ? value.message : '核对失败'; }
}
async function save() {
  const scope = stamp(); if (disabled.value || !current(scope)) return;
  busy.value = true; error.value = '';
  try {
    await apiAdminProductRecycle(scope.product, scope.expected as 0 | 1);
    if (!current(scope)) return;
    busy.value = false; ElMessage.success(scope.expected === 1 ? '成功恢复商品' : '成功移到回收站'); close(); emit('saved');
  } catch (value) {
    if (!current(scope)) return;
    uncertain.value = hasUnconfirmedRecycle(scope.product);
    error.value = `${uncertain.value ? '操作结果未确认' : '操作未完成'}：${value instanceof Error ? value.message : '请求失败'}`;
  } finally { if (current(scope)) busy.value = false; }
}
watch(() => [props.modelValue, props.product.id, props.product.is_del, props.canManage, props.contextKey] as const, (value, previous) => {
  if (!value[0] || !value[3]) { reset(); if (value[0]) emit('update:modelValue', false); return; }
  if (!previous || !previous[0]) {
    reset(); try { uncertain.value = hasUnconfirmedRecycle(props.product.id); } catch (value) { uncertain.value = true; error.value = value instanceof Error ? value.message : '核对状态无效'; }
    return;
  }
  if (value.slice(1).some((item, index) => item !== previous[index + 1])) { reset(); emit('update:modelValue', false); }
}, { immediate: true });
onBeforeUnmount(() => { alive = false; reset(); });
</script>
<style scoped>
.product-name { font-weight: 600; overflow-wrap: anywhere; }.notice { margin-top: 10px; }
@media (max-width: 600px) { :deep(.el-dialog__footer) { display: flex; flex-wrap: wrap; gap: 8px; }:deep(.el-dialog__footer .el-button) { margin-left: 0; } }
</style>
