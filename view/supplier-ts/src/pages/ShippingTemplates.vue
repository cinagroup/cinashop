<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Plus } from "@element-plus/icons-vue";
import {
  deleteShippingTemplate,
  getShippingCities,
  getShippingTemplate,
  getShippingTemplates,
  saveShippingTemplate,
} from "@/api/supplier";
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

const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const rows = ref<ShippingTemplateRow[]>([]);
const count = ref(0);
const cities = ref<ShippingCityOption[]>([]);
const filter = reactive({ name: "", page: 1, limit: 20 });

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

async function load() {
  loading.value = true;
  try {
    const result = await getShippingTemplates(filter);
    rows.value = result.data;
    count.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "运费模板加载失败");
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, blankForm());
  dialogVisible.value = true;
}

async function openEdit(id: number) {
  try {
    const detail = await getShippingTemplate(id);
    const regions = detail.templateList.map((rule) => ({ ...rule, city_ids: rule.city_ids.map((path) => [...path]) }));
    const nationwideIndex = regions.findIndex(isNationwide);
    if (nationwideIndex > 0) regions.unshift(regions.splice(nationwideIndex, 1)[0]);
    Object.assign(form, {
      id,
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
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "运费模板详情加载失败");
  }
}

async function submit() {
  const message = validationMessage();
  if (message) return ElMessage.warning(message);
  saving.value = true;
  try {
    const payload: ShippingTemplatePayload = {
      name: form.name.trim(),
      type: form.type,
      appoint: form.appoint,
      no_delivery: form.no_delivery,
      sort: form.sort,
      region_info: form.region_info,
      appoint_info: form.appoint ? form.appoint_info : [],
      no_delivery_info: form.no_delivery ? form.no_delivery_info : [],
    };
    await saveShippingTemplate(form.id, payload);
    dialogVisible.value = false;
    ElMessage.success(form.id ? "运费模板已更新" : "运费模板已创建");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "运费模板保存失败");
  } finally {
    saving.value = false;
  }
}

async function removeTemplate(row: ShippingTemplateRow) {
  try {
    await ElMessageBox.confirm(
      `删除“${row.name}”后不能恢复；被商品使用的模板会被服务器拒绝删除。`,
      "删除运费模板",
      { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" },
    );
    await deleteShippingTemplate(row.id);
    ElMessage.success("运费模板已删除");
    await load();
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : "运费模板删除失败");
    }
  }
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
  try {
    cities.value = await getShippingCities();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "城市数据加载失败");
  }
  await load();
});
</script>

<template>
  <section class="page-section shipping-page">
    <header class="page-heading">
      <div><h1>运费模板</h1><p>按供应商隔离管理配送费、指定包邮和禁配区域</p></div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增模板</el-button>
    </header>

    <article class="surface filter-bar">
      <el-input v-model="filter.name" clearable maxlength="255" placeholder="搜索模板名称" @keyup.enter="load" />
      <el-button type="primary" @click="load">查询</el-button>
    </article>

    <article class="surface table-card" v-loading="loading">
      <el-table :data="rows" empty-text="暂无运费模板">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="模板名称" min-width="180" />
        <el-table-column prop="type" label="计费方式" width="110" />
        <el-table-column prop="appoint" label="指定包邮" width="110" />
        <el-table-column prop="sort" label="排序" width="90" />
        <el-table-column prop="add_time" label="更新时间" width="175" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row.id)">编辑</el-button>
            <el-button link type="danger" @click="removeTemplate(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="table-footer"><span>共 {{ count }} 个模板</span></div>
    </article>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑运费模板' : '新增运费模板'" width="min(1080px, 94vw)" destroy-on-close>
      <el-form label-position="top" class="shipping-form">
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
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submit">保存模板</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.filter-bar { display: flex; gap: 12px; padding: 18px; }
.filter-bar .el-input { max-width: 360px; }
.table-card { overflow: hidden; }
.table-footer { display: flex; justify-content: flex-end; padding: 14px 20px; color: var(--text-muted); }
.shipping-form { max-height: 68vh; overflow-y: auto; padding-right: 8px; }
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
  .top-grid { grid-template-columns: 1fr; }
  .region-row, .compact-rule { grid-template-columns: 1fr 1fr; }
  .region-picker, .compact-rule .el-cascader { grid-column: 1 / -1; }
  .no-delivery-row { grid-template-columns: 1fr auto; }
}
</style>
