<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Plus } from "@element-plus/icons-vue";
import {
  deleteShippingTemplate,
  getShippingCities,
  getShippingTemplate,
  getShippingTemplates,
  saveShippingTemplate,
  previewMode,
} from "@/api/supplier";
import { ApiError } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useShippingTemplateList } from '@/utils/shippingTemplateList';
import { supplierShippingCreation } from '@/api/shippingCreation';
import type { CreationIntent } from '../../../shared/shippingCreation';
import type {
  ShippingCityOption,
  ShippingFreeRule,
  ShippingNoDeliveryRule,
  ShippingRegionRule,
  ShippingTemplatePayload,
  ShippingTemplateRow,
} from "@/types";

interface TemplateForm extends ShippingTemplatePayload {
  id: number;
}

const saving = ref(false);
const reading = ref(false);
const editError = ref('');
const needsReload = ref(false);
const sessionInvalidated = ref(false);
const uncertainMutation = ref('');
const deleting = ref(false);
const auth = useAuthStore();
const canManage = computed(() => !sessionInvalidated.value && (previewMode || auth.can('supplier.shipping.manage')));
let editGeneration = 0;
let confirmationPending = false;
const dialogVisible = ref(false);
const creation = ref<CreationIntent | null>(null);
let creator: ReturnType<typeof supplierShippingCreation> | undefined;
const cities = ref<ShippingCityOption[]>([]);
const filter = reactive({ name: "" });
const list = useShippingTemplateList(query => getShippingTemplates({ ...query }, session.signal), () => current());
const { rows, count, loading, error: listError, applied, pages } = list;

const blankRegion = (nationwide = false): ShippingRegionRule => ({
  city_ids: nationwide ? [[0]] : [],
  first: "1.00",
  first_price: "0.00",
  continue: "1.00",
  continue_price: "0.00",
});
const blankFree = (): ShippingFreeRule => ({ city_ids: [], number: "1.00", price: "0.00" });
const blankNoDelivery = (): ShippingNoDeliveryRule => ({ city_ids: [] });
const blankForm = (): TemplateForm => ({
  id: 0,
  expectedRevision: undefined,
  name: "",
  type: 1,
  appoint: 0,
  no_delivery: 0,
  sort: 0,
  region_info: [blankRegion(true)],
  appoint_info: [],
  no_delivery_info: [],
});
const form = reactive<TemplateForm>(blankForm());
const session = createSupplierSessionScope(() => {
  if (confirmationPending) ElMessageBox.close();
  confirmationPending = false;
  sessionInvalidated.value = true; editGeneration += 1; list.reset();
  dialogVisible.value = false; cities.value = []; filter.name = '';
  creation.value = null;
  Object.assign(form, blankForm()); loading.value = false; reading.value = false; saving.value = false; deleting.value = false;
}, previewMode);
onBeforeUnmount(() => {
  if (confirmationPending) ElMessageBox.close();
  confirmationPending = false; editGeneration += 1; list.reset(); session.dispose();
});
function current() { return session.isCurrent(); }
function canWrite() { return current() && canManage.value && !uncertainMutation.value; }
function unknownResult(action: string) {
  uncertainMutation.value = `${action}结果未知，已暂停本页写入。请查询列表并核对实际记录；不要直接重复提交。`;
  return uncertainMutation.value;
}

const cascaderProps = {
  value: "city_id",
  label: "name",
  children: "children",
  multiple: true,
  checkStrictly: true,
  emitPath: true,
};

const unitLabel = computed(() => form.type === 1 ? "件" : form.type === 2 ? "KG" : "m³");

function isNationwide(rule: ShippingRegionRule) {
  return rule.city_ids.some((path) => path.length === 1 && path[0] === 0);
}

function decimalValid(value: string, positive = false) {
  return /^\d{1,10}(?:\.\d{1,2})?$/.test(String(value)) && (!positive || Number(value) > 0);
}

function validationMessage() {
  if (!form.name.trim()) return "请填写运费模板名称";
  if (!form.region_info.length || !isNationwide(form.region_info[0])) return "第一条配送规则必须是默认全国";
  for (const rule of form.region_info) {
    if (!rule.city_ids.length) return "请选择配送区域";
    if (!decimalValid(rule.first, true) || !decimalValid(rule.continue, true)) return "首计量和续计量必须大于0且最多两位小数";
    if (!decimalValid(rule.first_price) || !decimalValid(rule.continue_price)) return "首费和续费必须是最多两位小数的非负数";
  }
  if (form.appoint) {
    for (const rule of form.appoint_info) {
      if (!rule.city_ids.length) return "请选择包邮区域";
      if (!decimalValid(rule.number, true) || !decimalValid(rule.price)) return "包邮门槛格式错误";
    }
  }
  if (form.no_delivery && form.no_delivery_info.some((rule) => !rule.city_ids.length)) return "请选择禁配区域";
  return "";
}

async function load() { await list.load(); }
async function search() { await list.load({ name: filter.name, page: 1, limit: applied.value.limit }); }
async function changePage(page: number) { await list.load({ ...applied.value, page }); }
async function changePageSize(event: Event) {
  await list.load({ ...applied.value, page: 1, limit: Number((event.target as HTMLSelectElement).value) });
}
async function jumpPage(event: Event) { await changePage(Number((event.target as HTMLInputElement).value)); }

async function openCreate() {
  if (!canWrite() || saving.value || deleting.value || reading.value) return;
  const generation = ++editGeneration;
  reading.value = true;
  editError.value = '';
  needsReload.value = false;
  Object.assign(form, blankForm());
  creation.value = null;
  dialogVisible.value = true;
  try {
    if (!previewMode) {
      creator ??= supplierShippingCreation(session);
      const pending = await creator.load();
      if (!current() || generation !== editGeneration) return;
      creation.value = pending;
      if (pending) Object.assign(form, pending.payload, { id: 0 });
    }
  } catch (error) {
    if (current() && generation === editGeneration) {
      needsReload.value = true;
      editError.value = error instanceof Error ? error.message : '无法读取原创建请求，已阻止新建';
    }
  } finally { if (current() && generation === editGeneration) reading.value = false; }
}

async function openEdit(id: number) {
  if (!current() || saving.value || deleting.value) return;
  const generation = ++editGeneration;
  reading.value = true;
  try {
    const detail = await getShippingTemplate(id, session.signal);
    if (!current() || generation !== editGeneration) return;
    if (!/^shipping-v1:[a-f0-9]{64}$/.test(detail.revision)) throw new Error('编辑版本缺失或无效，请重新读取模板');
    const regions = detail.templateList.map((rule) => ({ ...rule, city_ids: rule.city_ids.map((path) => [...path]) }));
    const nationwideIndex = regions.findIndex(isNationwide);
    if (nationwideIndex > 0) regions.unshift(regions.splice(nationwideIndex, 1)[0]);
    Object.assign(form, {
      id,
      expectedRevision: detail.revision,
      name: detail.formData.name,
      type: detail.formData.type,
      appoint: detail.formData.appoint_check,
      no_delivery: detail.formData.no_delivery_check,
      sort: detail.formData.sort,
      region_info: regions.length ? regions : [blankRegion(true)],
      appoint_info: detail.appointList,
      no_delivery_info: detail.noDeliveryList,
    });
    dialogVisible.value = true;
    creation.value = null;
    editError.value = '';
    needsReload.value = false;
  } catch (error) {
    if (!current() || generation !== editGeneration) return;
    // A failed reload never replaces the user's current form or version.
    editError.value = error instanceof Error ? error.message : '运费模板详情加载失败';
    ElMessage.error(error instanceof Error ? error.message : "运费模板详情加载失败");
  } finally {
    if (current() && generation === editGeneration) reading.value = false;
  }
}

async function reloadEditor() {
  if (!current() || confirmationPending || saving.value || reading.value || !form.id) return;
  const generation = editGeneration, id = form.id;
  try {
    confirmationPending = true;
    await ElMessageBox.confirm('重新读取会替换当前输入。请先复制需要保留的内容，再与最新模板核对。', '重新读取模板',
      { type: 'warning', confirmButtonText: '读取最新模板', cancelButtonText: '保留输入' });
    confirmationPending = false;
    if (!current() || generation !== editGeneration || !dialogVisible.value || saving.value) return;
    await openEdit(id);
  } catch (error) {
    if (!current()) return;
    if (error !== 'cancel' && error !== 'close') ElMessage.error('重新读取失败，当前输入已保留');
  } finally { confirmationPending = false; }
}

async function submit() {
  if (!canWrite() || saving.value || deleting.value || reading.value || needsReload.value || !dialogVisible.value || creation.value) return;
  const message = validationMessage();
  if (message) return ElMessage.warning(message);
  saving.value = true;
  const generation = editGeneration, id = form.id;
  editError.value = '';
  try {
    const payload: ShippingTemplatePayload = {
      ...(id > 0 ? { expectedRevision: form.expectedRevision } : {}),
      name: form.name.trim(),
      type: form.type,
      appoint: form.appoint,
      no_delivery: form.no_delivery,
      sort: form.sort,
      region_info: form.region_info,
      appoint_info: form.appoint ? form.appoint_info : [],
      no_delivery_info: form.no_delivery ? form.no_delivery_info : [],
    };
    if (!id && !previewMode) {
      if (!creator) throw new Error('创建恢复未就绪');
      const pending = await creator.prepare(JSON.parse(JSON.stringify(payload)));
      if (!current() || generation !== editGeneration) return;
      creation.value = pending; Object.assign(form, pending.payload, { id: 0 });
      if (JSON.stringify(pending.payload) !== JSON.stringify(payload)) {
        editError.value = '另一标签页已有创建请求，已恢复其原始表单。请先恢复查询，不会发送当前未保存输入。';
        return;
      }
      const result = await creator.send(pending.requestKey);
      if (current() && generation === editGeneration) creation.value = result;
      return;
    }
    await saveShippingTemplate(id, JSON.parse(JSON.stringify(payload)), session.signal);
    if (!current() || generation !== editGeneration) return;
    dialogVisible.value = false;
    ElMessage.success(form.id ? "运费模板已更新" : "运费模板已创建");
    await load();
  } catch (error) {
    if (!current() || generation !== editGeneration) return;
    editError.value = !id && !previewMode ? `${error instanceof Error ? error.message : '创建未确认'}。原请求已保留，请恢复查询或使用原请求重试。`
      : error instanceof ApiError && error.status === 400 ? error.message : unknownResult('保存');
    needsReload.value = /其他操作修改|编辑版本/.test(editError.value);
    ElMessage.error(editError.value);
  } finally {
    if (current() && generation === editGeneration) saving.value = false;
  }
}

async function creationAction(action: 'recover' | 'send' | 'acknowledge') {
  if (!creator || !creation.value || saving.value || !current() || !canManage.value) return;
  const generation = editGeneration, key = creation.value.requestKey;
  saving.value = true; editError.value = '';
  try {
    if (action === 'acknowledge') {
      await creator.acknowledge(key);
      if (!current() || generation !== editGeneration) return;
      creation.value = null; dialogVisible.value = false;
      ElMessage.success('已确认原创建结果'); await load();
    } else {
      const result = await creator[action](key);
      if (!current() || generation !== editGeneration) return;
      creation.value = result;
      if (!result.receipt) editError.value = '暂未查到已提交回执。原请求继续保留，只能使用原键和原内容重试。';
    }
  } catch (error) {
    if (current() && generation === editGeneration) editError.value = error instanceof Error ? error.message : '恢复失败，原请求已保留';
  } finally { if (current() && generation === editGeneration) saving.value = false; }
}

async function removeTemplate(row: ShippingTemplateRow) {
  if (row.id === 1 || !canWrite() || deleting.value || saving.value || reading.value || dialogVisible.value) return;
  deleting.value = true;
  let dispatched = false;
  try {
    confirmationPending = true;
    await ElMessageBox.confirm(
      `删除“${row.name}”后不能恢复；被商品使用的模板会被服务器拒绝删除。`,
      "删除运费模板",
      { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" },
    );
    confirmationPending = false;
    if (!canWrite()) return;
    dispatched = true;
    await deleteShippingTemplate(row.id, session.signal);
    if (!current()) return;
    ElMessage.success("运费模板已删除");
    await load();
  } catch (error) {
    if (!current()) return;
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(dispatched && !(error instanceof ApiError && error.status === 400) ? unknownResult('删除') : error instanceof Error ? error.message : '运费模板删除失败');
    }
  } finally { confirmationPending = false; if (current()) deleting.value = false; }
}

function addRegion() {
  if (form.region_info.length >= 100) return ElMessage.warning("配送规则不能超过100组");
  form.region_info.push(blankRegion());
}

function addFreeRule() {
  if (form.appoint_info.length >= 100) return ElMessage.warning("包邮规则不能超过100组");
  form.appoint_info.push(blankFree());
}

function addNoDeliveryRule() {
  if (form.no_delivery_info.length >= 100) return ElMessage.warning("禁配规则不能超过100组");
  form.no_delivery_info.push(blankNoDelivery());
}

onMounted(async () => {
  if (!current()) return;
  try {
    const result = await getShippingCities(session.signal);
    if (!current()) return;
    cities.value = result;
  } catch (error) {
    if (!current()) return;
    ElMessage.error(error instanceof Error ? error.message : "城市数据加载失败");
  }
  await load();
});
</script>

<template>
  <section class="page-section shipping-page">
    <header class="page-heading">
      <div><h1>运费模板</h1><p>按供应商隔离管理配送费、指定包邮和禁配区域</p></div>
      <el-button type="primary" :icon="Plus" :disabled="!canManage || !!uncertainMutation || saving || deleting" @click="openCreate">新增模板</el-button>
    </header>

    <el-alert v-if="sessionInvalidated" title="登录身份或权限已改变，当前页面已失效。请重新进入本页。" type="warning" :closable="false" show-icon />
    <el-alert v-else-if="uncertainMutation" :title="uncertainMutation" type="error" :closable="false" show-icon />
    <article class="surface filter-bar">
      <el-input v-model="filter.name" clearable maxlength="255" placeholder="搜索模板名称" @keyup.enter="search" />
      <el-button type="primary" :disabled="sessionInvalidated" @click="search">查询</el-button>
    </article>
    <el-alert v-if="listError" :title="listError" description="显示内容仍为上次成功查询的结果；重试不会执行任何写入。" type="error" :closable="false" show-icon />
    <el-button v-if="listError" :disabled="sessionInvalidated || loading" @click="list.retry">重试列表</el-button>

    <article class="surface table-card" v-loading="loading">
      <el-table :data="rows" empty-text="暂无运费模板">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="模板名称" min-width="180">
          <template #default="{ row }">{{ row.name }} <el-tag v-if="row.id === 1" size="small" type="info">默认模板</el-tag></template>
        </el-table-column>
        <el-table-column prop="type" label="计费方式" width="110" />
        <el-table-column prop="appoint" label="指定包邮" width="110" />
        <el-table-column prop="sort" label="排序" width="90" />
        <el-table-column prop="add_time" label="更新时间" width="175" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="scope">
            <el-button link type="primary" :disabled="sessionInvalidated || saving || deleting" @click="openEdit(scope.row.id)">编辑</el-button>
            <el-button v-if="scope.row.id !== 1" link type="danger" :disabled="!canManage || !!uncertainMutation || saving || deleting || reading" @click="removeTemplate(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <nav class="table-footer" aria-label="运费模板分页">
        <span>共 {{ count }} 个模板 · 第 {{ applied.page }} / {{ pages }} 页</span>
        <span v-if="applied.name">当前查询：{{ applied.name }}</span>
        <label>每页 <select aria-label="每页数量" :value="applied.limit" :disabled="sessionInvalidated || loading" @change="changePageSize"><option v-for="size in [10, 20, 50, 100]" :key="size" :value="size">{{ size }} 条</option></select></label>
        <div class="page-actions">
          <el-button :disabled="sessionInvalidated || loading || applied.page <= 1" @click="changePage(applied.page - 1)">上一页</el-button>
          <label>跳至 <input aria-label="跳转页码" type="number" min="1" :max="Math.min(pages, 1000000)" :value="applied.page" :disabled="sessionInvalidated || loading" @change="jumpPage" /></label>
          <el-button :disabled="sessionInvalidated || loading || applied.page >= pages || applied.page >= 1000000" @click="changePage(applied.page + 1)">下一页</el-button>
        </div>
      </nav>
    </article>

    <el-dialog v-if="!sessionInvalidated" v-model="dialogVisible" class="supplier-shipping-dialog" align-center :title="form.id ? '编辑运费模板' : '新增运费模板'" width="min(1080px, 94vw)" destroy-on-close
      :close-on-click-modal="!saving && !reading" :close-on-press-escape="!saving && !reading" :show-close="!saving && !reading">
      <el-alert v-if="editError" class="edit-error" :title="editError" type="error" :closable="false" show-icon
        :description="needsReload ? '当前输入已保留；保存已暂停。请先复制需要的内容，再重新读取最新模板核对。' : '当前输入已保留。'" />
      <el-alert v-if="creation" class="edit-error" :title="creation.receipt ? `已确认创建，模板 ID：${creation.receipt.id}` : '已保存原始创建请求，刷新或重入后可恢复'"
        :type="creation.receipt ? 'success' : 'warning'" :closable="false" show-icon
        description="当前表单已冻结。回执仅证明曾创建；模板之后被删除或转移时不代表仍可访问。不要清除浏览器数据。" />
      <el-form label-position="top" class="shipping-form" :disabled="saving || reading || !canManage || !!creation">
        <div class="form-grid top-grid">
          <el-form-item label="模板名称" required><el-input v-model="form.name" maxlength="255" show-word-limit /></el-form-item>
          <el-form-item label="计费方式"><el-radio-group v-model="form.type"><el-radio-button :value="1">按件数</el-radio-button><el-radio-button :value="2">按重量</el-radio-button><el-radio-button :value="3">按体积</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="2147483647" /></el-form-item>
        </div>

        <section class="rule-section">
          <div class="rule-heading"><div><h3>配送区域及运费</h3><p>默认全国规则必须保留；更具体的城市规则优先匹配</p></div><el-button :icon="Plus" @click="addRegion">添加区域</el-button></div>
          <div v-for="(rule, index) in form.region_info" :key="`region-${index}`" class="rule-row region-row">
            <div class="region-picker">
              <strong>{{ index === 0 && isNationwide(rule) ? "默认全国" : `配送区域 ${index + 1}` }}</strong>
              <el-cascader v-if="!(index === 0 && isNationwide(rule))" v-model="rule.city_ids" :options="cities" :props="cascaderProps" collapse-tags collapse-tags-tooltip clearable filterable placeholder="选择省/市" />
            </div>
            <label>首{{ unitLabel }}<el-input v-model="rule.first" /></label>
            <label>首费（元）<el-input v-model="rule.first_price" /></label>
            <label>续{{ unitLabel }}<el-input v-model="rule.continue" /></label>
            <label>续费（元）<el-input v-model="rule.continue_price" /></label>
            <el-button v-if="index > 0" text type="danger" :icon="Delete" aria-label="删除配送规则" @click="form.region_info.splice(index, 1)" />
          </div>
        </section>

        <section class="rule-section">
          <div class="rule-heading"><div><h3>指定包邮</h3><p>计量和商品金额同时达到门槛时免运费</p></div><el-switch v-model="form.appoint" :active-value="1" :inactive-value="0" /></div>
          <template v-if="form.appoint">
            <div v-for="(rule, index) in form.appoint_info" :key="`free-${index}`" class="rule-row compact-rule">
              <el-cascader v-model="rule.city_ids" :options="cities" :props="cascaderProps" collapse-tags collapse-tags-tooltip clearable filterable placeholder="选择包邮区域" />
              <label>包邮计量（{{ unitLabel }}）<el-input v-model="rule.number" /></label>
              <label>商品金额（元）<el-input v-model="rule.price" /></label>
              <el-button text type="danger" :icon="Delete" aria-label="删除包邮规则" @click="form.appoint_info.splice(index, 1)" />
            </div>
            <el-button plain :icon="Plus" @click="addFreeRule">添加包邮区域</el-button>
          </template>
        </section>

        <section class="rule-section">
          <div class="rule-heading"><div><h3>指定不送达</h3><p>命中禁配区域时，下单会明确失败，不会退化成零运费</p></div><el-switch v-model="form.no_delivery" :active-value="1" :inactive-value="0" /></div>
          <template v-if="form.no_delivery">
            <div v-for="(rule, index) in form.no_delivery_info" :key="`deny-${index}`" class="rule-row no-delivery-row">
              <el-cascader v-model="rule.city_ids" :options="cities" :props="cascaderProps" collapse-tags collapse-tags-tooltip clearable filterable placeholder="选择禁配区域" />
              <el-button text type="danger" :icon="Delete" aria-label="删除禁配规则" @click="form.no_delivery_info.splice(index, 1)" />
            </div>
            <el-button plain :icon="Plus" @click="addNoDeliveryRule">添加禁配区域</el-button>
          </template>
        </section>
      </el-form>
      <template #footer>
        <el-button :disabled="saving || reading" @click="dialogVisible = false; editGeneration += 1">取消</el-button>
        <el-button v-if="form.id" :disabled="saving || reading" :loading="reading" @click="reloadEditor">重新读取模板</el-button>
        <template v-if="creation">
          <el-button :disabled="saving || !canManage" @click="creationAction('recover')">恢复查询</el-button>
          <el-button v-if="!creation.receipt" :disabled="saving || !canManage" @click="creationAction('send')">使用原请求重试</el-button>
          <el-button v-else type="primary" :disabled="saving || !canManage" @click="creationAction('acknowledge')">确认完成</el-button>
        </template>
        <el-button v-else type="primary" :loading="saving" :disabled="reading || needsReload || !canManage || !!uncertainMutation" @click="submit">保存模板</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.filter-bar { display: flex; gap: 12px; padding: 18px; }
.edit-error { margin-bottom: 12px; }
:global(.supplier-shipping-dialog) { display: flex; flex-direction: column; max-height: calc(100dvh - 24px); }
:global(.supplier-shipping-dialog .el-dialog__body) { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
:global(.supplier-shipping-dialog .el-dialog__header), :global(.supplier-shipping-dialog .el-dialog__footer), .edit-error { flex-shrink: 0; }
.filter-bar .el-input { max-width: 360px; }
.table-card { overflow: hidden; }
.table-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; padding: 14px 20px; color: var(--text-muted); }
.table-footer label, .page-actions { display: flex; align-items: center; gap: 8px; }
.table-footer select, .table-footer input { min-height: 32px; border: 1px solid var(--border); border-radius: 6px; color: inherit; background: var(--bg); }
.table-footer input { width: 60px; }
.page-actions .el-button + .el-button { margin-left: 0; }
.shipping-form { flex: 1; min-height: 0; max-height: 68vh; overflow-y: auto; padding-right: 8px; }
.top-grid { grid-template-columns: minmax(240px, 1fr) minmax(300px, 1fr) 160px; }
.rule-section { padding: 20px 0; border-top: 1px solid var(--border); }
.rule-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
.rule-heading h3 { margin: 0 0 4px; font-size: 16px; }
.rule-heading p { margin: 0; color: var(--text-muted); font-size: 13px; }
.rule-row { display: grid; align-items: end; gap: 12px; padding: 14px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.region-row { grid-template-columns: minmax(220px, 2fr) repeat(4, minmax(105px, 1fr)) 34px; }
.compact-rule { grid-template-columns: minmax(260px, 2fr) minmax(140px, 1fr) minmax(140px, 1fr) 34px; }
.no-delivery-row { grid-template-columns: minmax(260px, 1fr) 34px; }
.rule-row label { display: grid; gap: 6px; color: var(--text-muted); font-size: 12px; }
.region-picker { display: grid; gap: 8px; }
.region-picker .el-cascader, .compact-rule .el-cascader, .no-delivery-row .el-cascader { width: 100%; }
@media (max-width: 900px) {
  .table-footer { justify-content: flex-start; padding: 14px 12px; }
  .top-grid { grid-template-columns: 1fr; }
  .region-row, .compact-rule { grid-template-columns: 1fr 1fr; }
  .region-picker, .compact-rule .el-cascader { grid-column: 1 / -1; }
  .no-delivery-row { grid-template-columns: 1fr auto; }
}
</style>
