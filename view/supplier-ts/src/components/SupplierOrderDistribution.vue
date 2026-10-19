<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { getSupplierOrderDistribution, saveSupplierOrderDistribution, distributionInput, distributionMatches, distributionKnownRejection,
  type SupplierDistributionInput, type SupplierDistributionTarget, type SupplierOrderDistribution } from '@/api/orderDistribution';
import { createSupplierSessionScope } from '@/utils/supplierSession';

const props = defineProps<{ target: SupplierDistributionTarget | null; disabled?: boolean }>();
const emit = defineEmits<{ close: []; saved: [id: number] }>();
const data = ref<SupplierOrderDistribution | null>(null), loading = ref(false), saving = ref(false), error = ref(''), notice = ref('');
const uncertain = ref(false), reconciled = ref(false), needsRead = ref(false);
const form = reactive({ delivery_name: '', delivery_id: '', fictitious_content: '' });
const contentLength = computed(() => [...form.fictitious_content].length);
let generation = 0, request: AbortController | undefined, invalid = false, submitted: SupplierDistributionInput | undefined;
function clear() {
  generation++; request?.abort(); data.value = null; error.value = notice.value = ''; loading.value = saving.value = false;
  uncertain.value = reconciled.value = needsRead.value = false; submitted = undefined;
  Object.assign(form, { delivery_name: '', delivery_id: '', fictitious_content: '' });
}
const session = createSupplierSessionScope(() => { invalid = true; clear(); emit('close'); });
function active(ticket: number, target: SupplierDistributionTarget) {
  return !invalid && !props.disabled && session.isCurrent() && ticket === generation && props.target === target;
}
function accept(result: SupplierOrderDistribution) {
  data.value = result; Object.assign(form, { delivery_name: result.delivery_name, delivery_id: result.delivery_id, fictitious_content: result.fictitious_content });
}
async function load() {
  if (saving.value) return;
  const target = props.target; if (!target || invalid || props.disabled || !session.isCurrent()) return;
  generation++; request?.abort(); const ticket = generation; request = new AbortController();
  loading.value = true; error.value = ''; data.value = null;
  try {
    const result = await getSupplierOrderDistribution(target, request.signal);
    if (!active(ticket, target)) return;
    accept(result); needsRead.value = false;
    if (uncertain.value && submitted) {
      reconciled.value = true;
      notice.value = distributionMatches(result, submitted) ? '当前配送信息与本次提交一致。请核对订单轨迹；此处显示当前记录。' : '当前配送信息与本次提交不同。请核对记录后再编辑。';
    }
  } catch (cause) { if (active(ticket, target)) error.value = cause instanceof Error ? cause.message : '配送信息读取失败'; }
  finally { if (active(ticket, target)) loading.value = false; }
}
function continueEditing() { if (!reconciled.value || !data.value || loading.value || saving.value) return; uncertain.value = reconciled.value = false; submitted = undefined; notice.value = ''; }
async function save() {
  const target = props.target, prior = data.value;
  if (!target || !prior?.editable || loading.value || saving.value || uncertain.value || needsRead.value || !active(generation, target)) return;
  let input: SupplierDistributionInput;
  try { input = distributionInput(prior, form); } catch (cause) { error.value = cause instanceof Error ? cause.message : '请核对输入'; return; }
  const ticket = generation; request = new AbortController(); saving.value = true; error.value = notice.value = ''; submitted = input;
  try {
    const result = await saveSupplierOrderDistribution(target, input, request.signal);
    if (!active(ticket, target)) return;
    accept(result); emit('saved', target.id); close();
  } catch (cause) {
    if (!active(ticket, target)) return;
    if (distributionKnownRejection(cause)) { needsRead.value = true; error.value = cause instanceof Error ? cause.message : '保存被拒绝，请重新读取'; }
    else { uncertain.value = true; notice.value = '保存结果未知。请先核对当前配送信息，再决定是否继续编辑。'; }
  } finally { if (active(ticket, target)) saving.value = false; }
}
function close() { clear(); emit('close'); }
function updateOpen(value: boolean) { if (!value && !saving.value) close(); }
watch(() => [props.target, props.disabled], () => { clear(); void load(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { invalid = true; clear(); session.dispose(); });
</script>
<template>
  <el-dialog :model-value="!!target && !disabled" title="配送信息" class="supplier-distribution-dialog" width="min(560px, 94vw)" append-to-body align-center :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" @update:model-value="updateOpen">
    <div class="distribution-body">
      <p class="distribution-order">包裹：{{ target?.order_id }}</p>
      <p v-if="loading" role="status">正在读取当前配送信息…</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon />
      <template v-if="data">
        <el-alert v-if="!data.editable" :title="data.reason" type="info" :closable="false" show-icon />
        <el-form label-position="top" :disabled="!data.editable || saving || uncertain || needsRead">
          <template v-if="data.delivery_type === 'express'">
            <el-form-item label="快递公司"><el-select v-model="form.delivery_name" filterable placeholder="请选择快递公司" aria-label="快递公司" class="distribution-company"><el-option v-for="company in data.express_companies" :key="company.id" :label="company.name" :value="company.name" /></el-select></el-form-item>
            <el-form-item label="运单号"><el-input v-model="form.delivery_id" aria-label="运单号" maxlength="128" /></el-form-item>
          </template>
          <template v-else-if="data.delivery_type === 'send'">
            <el-form-item label="送货人姓名"><el-input v-model="form.delivery_name" aria-label="送货人姓名" maxlength="128" /></el-form-item>
            <el-form-item label="送货人电话"><el-input v-model="form.delivery_id" aria-label="送货人电话" maxlength="18" /></el-form-item>
          </template>
          <el-form-item v-else label="交付备注"><el-input v-model="form.fictitious_content" aria-label="交付备注" aria-describedby="distribution-content-count" type="textarea" :rows="5" maxlength="1000" /><span id="distribution-content-count" class="content-count" :class="{ 'content-count--invalid': contentLength > 500 }">{{ contentLength }} / 500 字</span></el-form-item>
        </el-form>
      </template>
    </div>
    <template #footer>
      <el-button :disabled="loading || saving || disabled" @click="load">{{ uncertain ? '核对当前配送信息' : '重新读取' }}</el-button>
      <el-button v-if="reconciled && data?.editable" :disabled="loading || saving" @click="continueEditing">以当前信息继续编辑</el-button>
      <el-button v-if="data?.editable && !uncertain" type="primary" :loading="saving" :disabled="loading || needsRead || disabled" @click="save">保存配送信息</el-button>
      <el-button :disabled="saving" @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>
<style>
.supplier-distribution-dialog { max-height: calc(100dvh - 32px); display: flex; flex-direction: column; }
.supplier-distribution-dialog .el-dialog__body { min-height: 0; overflow: auto; }
.supplier-distribution-dialog .el-dialog__footer { flex-shrink: 0; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.supplier-distribution-dialog .el-dialog__footer .el-button { margin-left: 0; }
</style>
<style scoped>
.distribution-body { overflow-wrap: anywhere; }
.distribution-order { margin-top: 0; font-weight: 600; }
.distribution-company { width: 100%; }
.el-alert { margin-bottom: 16px; }
.content-count { display: block; width: 100%; text-align: right; color: var(--el-text-color-secondary); font-size: 12px; }
.content-count--invalid { color: var(--el-color-danger); }
</style>
