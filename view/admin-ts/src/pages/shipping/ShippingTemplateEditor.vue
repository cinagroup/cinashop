<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { AdminResponseError } from '@/utils/request';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { adminShippingCreation } from '@/api/shippingCreation';
import type { CreationIntent } from '../../../../shared/shippingCreation';
import { apiAdminShippingCities, apiAdminShippingTemplateDetail, apiAdminShippingTemplateSave,
  type ShippingGroupedForm, type ShippingGroupedRegion, type ShippingCity } from '@/api/shipping';

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ saved: []; close: [] }>();
const defaultRegion = (): ShippingGroupedRegion => ({ city_ids: [[0]], first: '1.00', first_price: '0.00', continue: '1.00', continue_price: '0.00' });
const form = reactive<ShippingGroupedForm>({ id: props.id, name: '', type: 1, status: 1, sort: 0, appoint: 0, no_delivery: 0,
  region_info: [defaultRegion()], appoint_info: [], no_delivery_info: [] });
const cities = ref<ShippingCity[]>([]);
const loading = ref(true), saving = ref(false), ready = ref(false), error = ref('');
const uncertain = ref(false);
const creation = ref<CreationIntent | null>(null);
let creator: ReturnType<typeof adminShippingCreation> | undefined;
const errorBanner = ref<HTMLElement | null>(null);
watch(error, async value => { if (value) { await nextTick(); errorBanner.value?.scrollIntoView({ block: 'nearest' }); } });
let generation = 0;
const scope = createAdminSessionScope(() => {
  generation++; ready.value = false; loading.value = false; saving.value = false;
  error.value = '登录身份已变化，请关闭后重新打开；已发出的保存可能已完成，请先核对。';
  creation.value = null;
});
const unit = computed(() => form.type === 1 ? '件' : form.type === 2 ? 'KG' : 'm³');
const cascaderProps = { value: 'city_id', label: 'name', children: 'children', multiple: true, checkStrictly: true, emitPath: true };
const regionOptions = computed(() => [{ city_id: 0, name: '默认全国' }, ...cities.value]);
const current = (run: number) => run === generation && scope.isCurrent();
async function load() {
  if (!scope.isCurrent()) return;
  const run = ++generation;
  loading.value = true; ready.value = false; error.value = '';
  try {
    if (!props.id) {
      creator ??= adminShippingCreation(scope);
      const pending = await creator.load();
      if (!current(run)) return;
      creation.value = pending;
      if (pending) Object.assign(form, pending.payload);
    }
    const [options, detail] = await Promise.all([apiAdminShippingCities(scope.signal), props.id ? apiAdminShippingTemplateDetail(props.id, scope.signal) : Promise.resolve(null)]);
    if (!current(run)) return;
    cities.value = options;
    if (detail) Object.assign(form, detail.formData, { expectedRevision: detail.revision, region_info: detail.region_info,
      appoint_info: detail.appoint_info, no_delivery_info: detail.no_delivery_info });
    ready.value = true;
  } catch (e) { if (current(run)) error.value = e instanceof Error ? e.message : '加载失败'; }
  finally { if (run === generation) loading.value = false; }
}
async function reload() {
  try { await ElMessageBox.confirm('重新读取会放弃当前未保存输入。请先自行记录需要保留的修改。', '重新读取模板', { type: 'warning' }); }
  catch { return; }
  await load();
}
function validation() {
  if (!form.name.trim() || form.name.trim().length > 255) return '请填写有效模板名称';
  const decimal = (value: string, digits: number, positive = false) => new RegExp(`^\\d{1,${digits}}(?:\\.\\d{1,2})?$`).test(value) && (!positive || Number(value) > 0);
  if (form.region_info.flatMap(row => row.city_ids).filter(path => path.length === 1 && path[0] === 0).length !== 1) return '配送区域必须且只能包含一个默认全国规则';
  for (const row of form.region_info) {
    if (!row.city_ids.length) return '请选择配送区域';
    if (!decimal(row.first,10,true) || !decimal(row.continue,10,true) || !decimal(row.first_price,10) || !decimal(row.continue_price,10)) return '首计量和续计量必须大于0，费率为非负数，最多两位小数';
  }
  if (form.appoint && (!form.appoint_info.length || form.appoint_info.some(row => !row.city_ids.length || !decimal(row.number,8,true) || !decimal(row.price,8)))) return '请填写完整的包邮区域和门槛';
  if (form.no_delivery && (!form.no_delivery_info.length || form.no_delivery_info.some(row => !row.city_ids.length))) return '请选择禁配区域';
  for (const rows of [form.region_info, ...(form.appoint ? [form.appoint_info] : []), ...(form.no_delivery ? [form.no_delivery_info] : [])]) {
    const paths = rows.flatMap(row => row.city_ids), endpoints = paths.map(path => path.at(-1));
    if (paths.length > 1000 || new Set(endpoints).size !== endpoints.length) return '同类地区不能重复，且最多1000项';
  }
  return '';
}
async function save() {
  if (saving.value || !ready.value || uncertain.value || creation.value) return;
  if (!scope.isCurrent()) return;
  error.value = validation(); if (error.value) return;
  const run = generation;
  saving.value = true;
  try {
    // Freeze this attempt; never rebuild it from inputs while the request is outstanding.
    const payload = JSON.parse(JSON.stringify({ ...form, name: form.name.trim(),
      appoint_info: form.appoint ? form.appoint_info : [], no_delivery_info: form.no_delivery ? form.no_delivery_info : [] }));
    if (!props.id) {
      if (!creator) throw new Error('创建恢复未就绪');
      const pending = await creator.prepare(payload);
      if (!current(run)) return;
      creation.value = pending; Object.assign(form, pending.payload);
      if (JSON.stringify(pending.payload) !== JSON.stringify(payload)) {
        error.value = '另一标签页已有创建请求，已恢复其原始表单。请先恢复查询，不会发送当前未保存输入。';
        return;
      }
      // Preparation is durable before send. Another tab's saved input wins.
      creation.value = await creator.send(pending.requestKey);
      if (current(run)) error.value = '';
      return;
    }
    await apiAdminShippingTemplateSave(payload, scope.signal);
    if (current(run)) emit('saved');
  } catch (e) {
    if (current(run)) {
      uncertain.value = !!props.id && !(e instanceof AdminResponseError && e.status === 400);
      error.value = !props.id ? `${e instanceof Error ? e.message : '创建未确认'}。原请求若已保存则不会丢弃，请使用恢复查询或原样重试。`
        : uncertain.value ? '保存结果未知，已停止重试。请关闭编辑器并刷新列表核对，避免覆盖。' : e instanceof Error ? e.message : '保存失败';
    }
  }
  finally { if (run === generation) saving.value = false; }
}
async function creationAction(action: 'recover' | 'send' | 'acknowledge') {
  if (!creator || !creation.value || saving.value || !scope.isCurrent()) return;
  const run = generation, key = creation.value.requestKey;
  saving.value = true; error.value = '';
  try {
    if (action === 'acknowledge') {
      await creator.acknowledge(key);
      if (current(run)) { creation.value = null; emit('saved'); }
    } else {
      const result = await creator[action](key);
      if (!current(run)) return;
      creation.value = result;
      if (!result.receipt) error.value = '暂未查到已提交回执。原请求继续保留，只能使用原键和原内容重试。';
    }
  } catch (e) { if (current(run)) error.value = e instanceof Error ? e.message : '恢复失败，原请求已保留'; }
  finally { if (current(run)) saving.value = false; }
}
onMounted(load);
onBeforeUnmount(() => { generation++; scope.dispose(); });
</script>

<template>
  <el-dialog class="admin-shipping-dialog" :model-value="true" :title="id ? '编辑完整运费模板' : '新增完整运费模板'" width="min(920px, 96vw)" top="4vh"
    :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <div v-if="error" ref="errorBanner"><el-alert :title="error" type="error" :closable="false" show-icon /></div>
    <el-alert v-if="creation" :title="creation.receipt ? `已确认创建，模板 ID：${creation.receipt.id}` : '已保存原始创建请求，刷新或重入后可恢复'"
      :type="creation.receipt ? 'success' : 'warning'" :closable="false" show-icon
      description="当前表单已冻结。回执仅证明曾创建；模板之后被删除或转移时不代表仍可访问。不要清除浏览器数据。" />
    <el-button v-if="!ready && !loading" @click="load">重试读取</el-button>
    <div v-loading="loading">
      <el-form v-if="ready" label-position="top" :disabled="saving || !!creation" class="template-editor">
        <el-form-item label="模板名称" required><el-input v-model="form.name" aria-label="模板名称" maxlength="255" /></el-form-item>
        <div class="meta-grid">
          <el-form-item label="计费方式"><el-radio-group v-model="form.type"><el-radio :value="1">按件</el-radio><el-radio :value="2">按重</el-radio><el-radio :value="3">按体积</el-radio></el-radio-group></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="2147483647" :precision="0" aria-label="排序" /></el-form-item>
          <el-form-item label="启用模板"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" aria-label="启用模板" /></el-form-item>
        </div>
        <h3>配送费规则（{{ unit }}）</h3>
        <p>全国为默认费率，可另设省市规则；同一地区在同类规则中只选一次。</p>
        <fieldset v-for="(row, i) in form.region_info" :key="i" class="rule-group">
          <legend>配送规则 {{ i + 1 }}</legend>
          <el-cascader v-model="row.city_ids" :options="regionOptions" :props="cascaderProps" :aria-label="`配送地区 ${i+1}`" popper-class="shipping-city-picker" placeholder="请选择省市地区" collapse-tags clearable />
          <div class="rates">
            <label>首计量（{{ unit }}）<el-input v-model="row.first" :aria-label="`首计量 ${i+1}`" inputmode="decimal" /></label>
            <label>首费（元）<el-input v-model="row.first_price" :aria-label="`首费 ${i+1}`" inputmode="decimal" /></label>
            <label>续计量（{{ unit }}）<el-input v-model="row.continue" :aria-label="`续计量 ${i+1}`" inputmode="decimal" /></label>
            <label>续费（元）<el-input v-model="row.continue_price" :aria-label="`续费 ${i+1}`" inputmode="decimal" /></label>
          </div>
          <el-button type="danger" text @click="form.region_info.splice(i,1)">移除配送规则 {{ i+1 }}</el-button>
        </fieldset>
        <el-button :disabled="saving || !!creation || form.region_info.length>=100" @click="form.region_info.push({...defaultRegion(),city_ids:[]})">添加配送规则</el-button>
        <h3><el-switch v-model="form.appoint" :active-value="1" :inactive-value="0" aria-label="条件包邮" /> 条件包邮</h3>
        <p>关闭后保存会清除此类规则；保存前重新打开开关仍保留输入。</p>
        <template v-if="form.appoint">
          <fieldset v-for="(row,i) in form.appoint_info" :key="i" class="rule-group">
            <legend>包邮规则 {{ i+1 }}</legend>
            <el-cascader v-model="row.city_ids" :options="cities" :props="cascaderProps" :aria-label="`包邮地区 ${i+1}`" popper-class="shipping-city-picker" placeholder="请选择省市地区" collapse-tags clearable />
            <div class="rates"><label>计量门槛（{{ unit }}）<el-input v-model="row.number" :aria-label="`包邮计量 ${i+1}`" inputmode="decimal" /></label><label>金额门槛（元）<el-input v-model="row.price" :aria-label="`包邮金额 ${i+1}`" inputmode="decimal" /></label></div>
            <el-button type="danger" text @click="form.appoint_info.splice(i,1)">移除包邮规则 {{ i+1 }}</el-button>
          </fieldset>
          <el-button :disabled="saving || !!creation || form.appoint_info.length>=100" @click="form.appoint_info.push({city_ids:[],number:'1.00',price:'0.00'})">添加包邮规则</el-button>
        </template>
        <h3><el-switch v-model="form.no_delivery" :active-value="1" :inactive-value="0" aria-label="不配送区域" /> 不配送区域</h3>
        <template v-if="form.no_delivery">
          <fieldset v-for="(row,i) in form.no_delivery_info" :key="i" class="rule-group">
            <legend>禁配规则 {{ i+1 }}</legend>
            <el-cascader v-model="row.city_ids" :options="cities" :props="cascaderProps" :aria-label="`禁配地区 ${i+1}`" popper-class="shipping-city-picker" placeholder="请选择省市地区" collapse-tags clearable />
            <el-button type="danger" text @click="form.no_delivery_info.splice(i,1)">移除禁配规则 {{ i+1 }}</el-button>
          </fieldset>
          <el-button :disabled="saving || !!creation || form.no_delivery_info.length>=100" @click="form.no_delivery_info.push({city_ids:[]})">添加禁配规则</el-button>
        </template>
      </el-form>
    </div>
    <template #footer>
      <div class="editor-actions"><el-button v-if="id" :disabled="saving || loading || uncertain" @click="reload">重新读取（放弃输入）</el-button><el-button :disabled="saving" @click="emit('close')">关闭</el-button>
        <template v-if="creation">
          <el-button :disabled="saving" @click="creationAction('recover')">恢复查询</el-button>
          <el-button v-if="!creation.receipt" :disabled="saving" @click="creationAction('send')">使用原请求重试</el-button>
          <el-button v-else type="primary" :disabled="saving" @click="creationAction('acknowledge')">确认完成</el-button>
        </template>
        <el-button v-else type="primary" :disabled="!ready || loading || uncertain" :loading="saving" @click="save">保存完整模板</el-button></div>
    </template>
  </el-dialog>
</template>
<style scoped>
.template-editor { margin-top: 16px; }
.meta-grid,.rates { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.rule-group { margin: 12px 0; padding: 12px; border: 1px solid #dcdfe6; border-radius: 6px; min-width: 0; }
.rule-group .el-cascader { width: 100%; margin-bottom: 12px; }
.rates label { min-width: 0; font-size: 13px; color: #606266; }
.rates .el-input { margin-top: 6px; }
.editor-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.editor-actions .el-button { margin-left: 0; }
p { color: #606266; font-size: 13px; }
@media(max-width:600px) { .meta-grid { grid-template-columns: 1fr; } }
</style>
<style>
.admin-shipping-dialog { display: flex; flex-direction: column; max-height: 92dvh; }
.admin-shipping-dialog .el-dialog__body { min-height: 0; overflow-y: auto; }
.admin-shipping-dialog .el-dialog__header, .admin-shipping-dialog .el-dialog__footer { flex-shrink: 0; }
.shipping-city-picker .el-cascader-panel { max-width: 92vw; overflow-x: auto; }
.shipping-city-picker .el-cascader-menu { min-width: 140px; }
</style>
