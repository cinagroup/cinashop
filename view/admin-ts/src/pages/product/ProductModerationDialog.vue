<template>
  <el-dialog :model-value="modelValue" :title="mode === 'remove' ? '强制下架' : '商品审核'" width="min(580px, 94vw)"
    :before-close="beforeClose" :close-on-click-modal="!busy" :close-on-press-escape="!busy" @update:model-value="visibleChange">
    <p class="product-name">{{ product.store_name }}（#{{ product.id }}）</p>
    <p>当前审核：{{ reviewLabel(product.is_verify) }}；{{ product.is_show === 1 ? '已上架' : '未上架' }}</p>
    <p v-if="product.refusal" class="reason">当前原因：{{ product.refusal }}</p>
    <p v-if="product.auto_on_time">定时上架：{{ time(product.auto_on_time) }}（北京时间）</p>
    <p v-if="product.auto_off_time">定时下架：{{ time(product.auto_off_time) }}（北京时间）</p>
    <el-alert title="提交审核会使此商品现有的有效购物车失效。" type="info" :closable="false" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" class="notice" />
    <el-alert v-if="uncertain" title="上次审核结果尚未确认。请重新读取商品并核对审核状态、定时时间及购物车影响，再决定新的操作。" type="warning" :closable="false" class="notice" />
    <el-form v-loading="loading" label-position="top" class="moderation-form">
      <el-form-item v-if="mode === 'verify'" label="审核状态">
        <el-radio-group v-model="decision" aria-label="审核状态" :disabled="disabled">
          <el-radio-button :value="1">通过</el-radio-button><el-radio-button :value="-1">拒绝</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="mode === 'remove' || decision === -1" :label="mode === 'remove' ? '下架原因' : '拒绝原因'" required>
        <el-input v-model="reason" type="textarea" aria-label="审核原因" :rows="3" :maxlength="255" show-word-limit :disabled="disabled" />
      </el-form-item>
      <template v-if="mode === 'verify' && decision === 1">
        <el-form-item label="上架时机">
          <el-radio-group v-model="show" aria-label="上架时机" :disabled="disabled">
            <el-radio-button :value="1">立即上架</el-radio-button><el-radio-button :value="2">定时上架</el-radio-button><el-radio-button :value="0">放入仓库</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="show === 2" label="上架时间（北京时间）" required>
          <el-date-picker v-model="onTime" type="datetime" aria-label="定时上架时间" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" :disabled="disabled" class="time-picker" />
        </el-form-item>
      </template>
    </el-form>
    <template #footer>
      <el-button :disabled="busy" @click="close">取消审核</el-button>
      <el-button v-if="uncertain" :disabled="busy" @click="emit('refresh')">重新读取商品</el-button>
      <el-button v-if="uncertain" :disabled="busy || !canAcknowledgeModeration(product.id)" @click="acknowledge">已核对，开始新的审核</el-button>
      <el-button type="primary" :loading="busy" :disabled="disabled" @click="save">{{ mode === 'remove' ? '确认强制下架' : '提交审核' }}</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import type { AdminProductCatalogItem } from '@/api/product';
import { acknowledgeModerationRead, apiAdminProductGetVerify, apiAdminProductModerationForm, apiAdminProductSetVerify,
  canAcknowledgeModeration, hasUnconfirmedModeration, type ProductModerationMode } from '@/api/productModeration';
const props = defineProps<{ modelValue: boolean; product: AdminProductCatalogItem; mode: ProductModerationMode; canManage: boolean; contextKey: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: []; refresh: [] }>();
const decision = ref<1 | -1>(1), show = ref<0 | 1 | 2>(0), reason = ref(''), onTime = ref('');
const busy = ref(false), loading = ref(false), ready = ref(false), uncertain = ref(false), error = ref('');
const disabled = computed(() => !props.canManage || !ready.value || loading.value || busy.value || uncertain.value);
let epoch = 0, alive = true, abort: AbortController | null = null;
const stamp = () => ({ epoch, product: props.product.id, context: props.contextKey, mode: props.mode, token: getToken(), session: localStorage.getItem('admin_session') });
const current = (scope: ReturnType<typeof stamp>) => alive && props.modelValue && props.canManage && epoch === scope.epoch && props.product.id === scope.product && props.mode === scope.mode && props.contextKey === scope.context && !!scope.token && getToken() === scope.token && localStorage.getItem('admin_session') === scope.session;
const message = (value: unknown) => value instanceof Error ? value.message : '审核请求失败';
const reviewLabels: Record<string, string> = { '0': '待审核', '1': '已通过', '-1': '已拒绝', '-2': '强制下架' };
const reviewLabel = (value: number) => reviewLabels[String(value)] ?? `状态 ${value}`;
const time = (value: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(value * 1000);
function reset() { epoch++; abort?.abort(); abort = null; decision.value = 1; show.value = 0; reason.value = onTime.value = error.value = ''; busy.value = loading.value = ready.value = uncertain.value = false; }
function close() { if (busy.value) return; reset(); emit('update:modelValue', false); }
function beforeClose(done: () => void) { if (!busy.value) { close(); done(); } }
function visibleChange(value: boolean) { if (!value) close(); }
async function load() {
  const scope = stamp(), controller = new AbortController(); abort = controller; loading.value = true;
  try {
    uncertain.value = hasUnconfirmedModeration(scope.product);
    await apiAdminProductModerationForm(scope.product, scope.mode, controller.signal);
    if (current(scope)) ready.value = true;
  } catch (value) { if (current(scope)) error.value = message(value); }
  finally { if (abort === controller) { abort = null; loading.value = false; } }
}
async function acknowledge() {
  const scope = stamp(); if (!current(scope) || busy.value || !uncertain.value) return;
  try { await acknowledgeModerationRead(scope.product); if (current(scope)) { uncertain.value = false; error.value = ''; decision.value = 1; show.value = 0; reason.value = onTime.value = ''; } }
  catch (value) { if (current(scope)) error.value = message(value); }
}
async function save() {
  if (disabled.value || !current(stamp())) return;
  const scope = stamp(), approve = props.mode === 'verify' && decision.value === 1;
  if (!approve && !reason.value.trim()) { error.value = '请输入原因'; return; }
  if (approve && show.value === 2 && !onTime.value) { error.value = '请选择定时上架时间（北京时间）'; return; }
  const body = { is_verify: props.mode === 'remove' ? -2 as const : decision.value, refusal: approve ? '' : reason.value,
    is_show: approve ? show.value : 0 as const, auto_on_time: approve && show.value === 2 ? onTime.value : '' };
  busy.value = true; error.value = '';
  try {
    if (props.mode === 'verify') {
      const warning = await apiAdminProductGetVerify(scope.product);
      if (!current(scope)) return;
      if (warning) {
        try { await ElMessageBox.confirm('存在售价低于结算价的普通规格，请核对价格后确认是否继续本次审核。', '售价提醒', { confirmButtonText: '仍然提交审核', cancelButtonText: '返回核对', type: 'warning' }); }
        catch { return; }
      }
    }
    if (!current(scope)) return;
    await apiAdminProductSetVerify(scope.product, body);
    if (!current(scope)) return;
    busy.value = false; ElMessage.success('审核成功'); close(); emit('saved');
  } catch (value) {
    if (!current(scope)) return;
    uncertain.value = hasUnconfirmedModeration(scope.product);
    const rejected = value instanceof AdminResponseError && [400,403,404,409,422].includes(Number(value.status));
    error.value = `${uncertain.value ? '审核结果未确认' : rejected ? '审核未完成' : '审核失败'}：${message(value)}`;
  } finally { if (current(scope)) busy.value = false; }
}
watch(() => [props.modelValue, props.product.id, props.mode, props.canManage, props.contextKey] as const, (value, previous) => {
  if (!value[0] || !value[3]) { reset(); if (value[0]) emit('update:modelValue', false); return; }
  if (!previous || !previous[0]) { reset(); void load(); return; }
  if (value.slice(1).some((item, index) => item !== previous[index + 1])) { reset(); emit('update:modelValue', false); }
}, { immediate: true });
onBeforeUnmount(() => { alive = false; reset(); });
</script>
<style scoped>
.product-name { font-weight: 600; overflow-wrap: anywhere; }.reason { white-space: pre-wrap; overflow-wrap: anywhere; }.notice { margin: 10px 0; }.moderation-form { margin-top: 16px; }.time-picker { width: 100%; }
@media (max-width: 600px) { :deep(.el-dialog__footer) { display: flex; flex-wrap: wrap; gap: 8px; }:deep(.el-dialog__footer .el-button) { margin-left: 0; }:deep(.el-radio-group) { display: flex; flex-wrap: wrap; } }
</style>
