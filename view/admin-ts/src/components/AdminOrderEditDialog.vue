<template>
  <el-dialog :model-value="visible" title="修改订单" width="min(520px, 94vw)" destroy-on-close
    :close-on-click-modal="!submitting" :close-on-press-escape="!submitting" :show-close="!submitting" @update:model-value="close">
    <el-skeleton v-if="loading" :rows="6" animated />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-form v-if="form && !loading" label-position="top" :disabled="submitting || uncertain">
      <el-form-item label="订单编号"><el-input :model-value="form.values.order_id" disabled /></el-form-item>
      <div class="order-edit-grid">
        <el-form-item label="商品总价"><el-input :model-value="form.values.total_price" disabled /></el-form-item>
        <el-form-item label="原始邮费"><el-input :model-value="form.values.total_postage" disabled /></el-form-item>
        <el-form-item label="实际支付邮费"><el-input :model-value="form.values.pay_postage" disabled /></el-form-item>
      </div>
      <el-form-item label="实际支付金额"><el-input v-model="form.values.pay_price" inputmode="decimal" maxlength="13" aria-label="实际支付金额" /></el-form-item>
      <el-form-item label="赠送积分"><el-input v-model="form.values.gain_integral" inputmode="numeric" maxlength="13" aria-label="赠送积分" /></el-form-item>
      <p class="order-edit-tip">金额最多两位小数；修改后的赠送积分须为非负整数。</p>
    </el-form>
    <template #footer>
      <el-button :disabled="submitting" @click="close(false)">关闭</el-button>
      <el-button v-if="error || uncertain" :disabled="submitting || loading" @click="load">重新载入当前订单</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!form || loading || uncertain" @click="save">保存修改</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { apiAdminOrderEdit, apiAdminOrderUpdate } from '@/api/order';
import type { AdminOrderEditForm } from '@/utils/orderEdit';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
const props = defineProps<{ visible: boolean; id: number; orderNo: string }>();
const emit = defineEmits<{ 'update:visible': [boolean]; updated: [] }>();
const form = ref<AdminOrderEditForm | null>(null), loading = ref(false), submitting = ref(false), uncertain = ref(false), error = ref('');
let epoch = 0, originalGain = '', readController: AbortController | undefined;
const scope = createAdminSessionScope(() => { reset(); emit('update:visible', false); });
function reset() { epoch++; readController?.abort(); form.value = null; originalGain = ''; error.value = ''; uncertain.value = false; loading.value = false; submitting.value = false; }
function close(visible: boolean) { if (submitting.value) return; emit('update:visible', visible); if (!visible) emit('updated'); }
async function load() {
  if (!scope.isCurrent() || !props.visible || submitting.value) return;
  reset(); loading.value = true;
  const generation = epoch, id = props.id, orderNo = props.orderNo, controller = new AbortController(); readController = controller;
  const current = () => scope.isCurrent() && props.visible && generation === epoch && id === props.id && orderNo === props.orderNo;
  try { const result = await apiAdminOrderEdit(id, orderNo, controller.signal); if (current()) { form.value = result; originalGain = result.values.gain_integral; } }
  catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : '订单表单加载失败'; }
  finally { if (current()) loading.value = false; }
}
async function save() {
  if (!scope.isCurrent() || !props.visible || !form.value || submitting.value || loading.value || uncertain.value) return;
  const values = form.value.values;
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(values.pay_price.trim())) { error.value = '实际支付金额须为非负数，最多两位小数'; return; }
  const initialGain = form.value.values.gain_integral;
  if (!/^-?\d{1,10}(?:\.\d{1,2})?$/.test(initialGain.trim())) { error.value = '赠送积分格式错误'; return; }
  if (initialGain.trim() !== originalGain && !/^\d{1,10}(?:\.0{1,2})?$/.test(initialGain.trim())) { error.value = '修改后的赠送积分必须是非负整数'; return; }
  const generation = epoch, id = props.id, request = { revision: form.value.revision, values: { ...values } };
  const current = () => scope.isCurrent() && props.visible && generation === epoch && id === props.id;
  submitting.value = true; error.value = '';
  try {
    await apiAdminOrderUpdate(id, request, scope.signal);
    if (!current()) return;
    submitting.value = false; ElMessage.success('订单修改成功'); close(false);
  } catch (cause) {
    if (current()) { uncertain.value = true; error.value = `请重新载入当前订单核对保存结果。${cause instanceof Error ? cause.message : '请求未完成'}`; }
  } finally { if (current()) submitting.value = false; }
}
watch(() => [props.visible, props.id, props.orderNo] as const, () => { reset(); if (props.visible) void load(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { reset(); scope.dispose(); });
</script>

<style scoped>
.order-edit-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.order-edit-tip { color: #606266; font-size: 13px; line-height: 1.6; }
@media (max-width: 480px) { .order-edit-grid { grid-template-columns: 1fr; gap: 0; } }
</style>
