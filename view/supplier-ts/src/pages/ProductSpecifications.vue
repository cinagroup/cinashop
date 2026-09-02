<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Plus } from "@element-plus/icons-vue";
import {
  deleteProductRule,
  getProductRule,
  getProductRules,
  saveProductRule,
} from "@/api/supplier";
import { useAuthStore } from "@/stores/auth";
import type { ProductDimension, ProductRulePayload, ProductRuleTemplate } from "@/types";

interface ProductRuleForm extends ProductRulePayload {
  id: number;
}

const auth = useAuthStore();
const canManageProducts = computed(() => auth.can("supplier.product.manage"));
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const rows = ref<ProductRuleTemplate[]>([]);
const count = ref(0);
const filter = reactive({ rule_name: "", page: 1, limit: 20 });
const blankDimension = (): ProductDimension => ({ value: "", detail: [] });
const blankForm = (): ProductRuleForm => ({ id: 0, rule_name: "", spec: [blankDimension()] });
const form = reactive<ProductRuleForm>(blankForm());

function cloneSpec(spec: ProductDimension[]): ProductDimension[] {
  return spec.map((item) => ({ value: item.value, detail: [...item.detail] }));
}

async function load() {
  loading.value = true;
  try {
    const result = await getProductRules(filter);
    rows.value = result.list;
    count.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "规格模板加载失败");
  } finally {
    loading.value = false;
  }
}

function search() {
  filter.page = 1;
  void load();
}

function openCreate() {
  if (!canManageProducts.value) return;
  Object.assign(form, blankForm());
  dialogVisible.value = true;
}

async function openEdit(id: number) {
  if (!canManageProducts.value) return;
  try {
    const detail = await getProductRule(id);
    Object.assign(form, {
      id: detail.id,
      rule_name: detail.rule_name,
      spec: detail.spec.length ? cloneSpec(detail.spec) : [blankDimension()],
    });
    dialogVisible.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "规格模板详情加载失败");
  }
}

function addDimension() {
  if (form.spec.length >= 3) return ElMessage.warning("最多支持3个规格维度");
  form.spec.push(blankDimension());
}

function removeDimension(index: number) {
  if (form.spec.length === 1) return ElMessage.warning("至少保留一个规格维度");
  form.spec.splice(index, 1);
}

function validationMessage() {
  const ruleName = form.rule_name.trim();
  if (!ruleName) return "请填写模板名称";
  if (ruleName.length > 32) return "模板名称不能超过32个字符";
  if (form.spec.length < 1 || form.spec.length > 3) return "商品规格维度需为1至3项";
  const dimensionNames: string[] = [];
  for (const dimension of form.spec) {
    const name = dimension.value.trim();
    if (!name) return "请填写规格名称";
    if (name.length > 32) return "规格名称不能超过32个字符";
    if (!dimension.detail.length || dimension.detail.length > 50) return `规格“${name}”需包含1至50个规格值`;
    const details = dimension.detail.map((item) => item.trim());
    if (details.some((item) => !item || item.length > 64)) return `规格“${name}”包含空值或超长规格值`;
    if (new Set(details).size !== details.length) return `规格“${name}”的规格值不能重复`;
    dimensionNames.push(name);
  }
  if (new Set(dimensionNames).size !== dimensionNames.length) return "规格名称不能重复";
  return "";
}

async function submit() {
  if (!canManageProducts.value) return;
  const message = validationMessage();
  if (message) return ElMessage.warning(message);
  saving.value = true;
  try {
    const payload: ProductRulePayload = {
      rule_name: form.rule_name.trim(),
      spec: form.spec.map((dimension) => ({
        value: dimension.value.trim(),
        detail: dimension.detail.map((item) => item.trim()),
      })),
    };
    await saveProductRule(form.id, payload);
    dialogVisible.value = false;
    ElMessage.success(form.id ? "规格模板已更新" : "规格模板已创建");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "规格模板保存失败");
  } finally {
    saving.value = false;
  }
}

async function removeRule(row: ProductRuleTemplate) {
  if (!canManageProducts.value) return;
  try {
    await ElMessageBox.confirm(
      `确认删除“${row.rule_name}”？已套用到商品的规格不会被改写，但模板本身无法恢复。`,
      "删除规格模板",
      { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" },
    );
    await deleteProductRule(row.id);
    ElMessage.success("规格模板已删除");
    if (rows.value.length === 1 && filter.page > 1) filter.page -= 1;
    await load();
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : "规格模板删除失败");
    }
  }
}

onMounted(load);
</script>

<template>
  <section class="page-section product-specifications-page">
    <header class="page-heading">
      <div><h1>规格模板</h1><p>复用当前供应商的规格维度与规格值，减少重复录入</p></div>
      <el-button v-if="canManageProducts" type="primary" :icon="Plus" @click="openCreate">新增模板</el-button>
    </header>

    <article class="surface filter-bar">
      <el-input v-model="filter.rule_name" clearable maxlength="32" placeholder="搜索模板名称" @keyup.enter="search" />
      <el-button type="primary" @click="search">查询</el-button>
    </article>

    <article v-loading="loading" class="surface table-card">
      <el-table :data="rows" empty-text="暂无规格模板">
        <el-table-column prop="id" label="ID" width="90" />
        <el-table-column prop="rule_name" label="模板名称" min-width="180" />
        <el-table-column label="规格内容" min-width="360">
          <template #default="scope">
            <div class="dimension-summary">
              <div v-for="dimension in scope.row.spec" :key="dimension.value">
                <strong>{{ dimension.value }}</strong>
                <span><el-tag v-for="detail in dimension.detail" :key="detail" size="small" effect="plain">{{ detail }}</el-tag></span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="canManageProducts" label="操作" width="140" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row.id)">编辑</el-button>
            <el-button link type="danger" @click="removeRule(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="table-footer">
        <span>共 {{ count }} 个模板</span>
        <el-pagination v-model:current-page="filter.page" :page-size="filter.limit" :total="count" layout="prev, pager, next" @current-change="load" />
      </div>
    </article>

    <el-dialog v-if="canManageProducts" v-model="dialogVisible" :title="form.id ? '编辑规格模板' : '新增规格模板'" width="min(760px, 94vw)" destroy-on-close>
      <el-form label-position="top" class="rule-form">
        <el-form-item label="模板名称" required><el-input v-model="form.rule_name" maxlength="32" show-word-limit placeholder="例如：服装颜色尺码" /></el-form-item>
        <section class="dimension-editor">
          <div class="dimension-heading"><div><h3>规格维度</h3><p>每个模板支持1至3个维度，每个维度最多50个值</p></div><el-button :icon="Plus" :disabled="form.spec.length >= 3" @click="addDimension">添加维度</el-button></div>
          <div v-for="(dimension, index) in form.spec" :key="index" class="dimension-row">
            <el-input v-model="dimension.value" maxlength="32" placeholder="规格名称，如颜色" />
            <el-select v-model="dimension.detail" multiple filterable allow-create default-first-option placeholder="输入规格值后回车" />
            <el-button text type="danger" :icon="Delete" aria-label="删除规格维度" @click="removeDimension(index)" />
          </div>
        </section>
        <el-alert title="模板只复制规格结构" type="info" :closable="false" show-icon description="套用模板不会包含价格、库存、图片或已有商品数据；商品保存时仍需逐个核对 SKU。" />
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submit">保存模板</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.filter-bar { display: flex; gap: 12px; padding: 18px; }
.filter-bar .el-input { max-width: 360px; }
.table-card { overflow: hidden; }
.table-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 20px; color: var(--text-muted); }
.dimension-summary { display: grid; gap: 10px; padding: 4px 0; }
.dimension-summary > div { display: grid; grid-template-columns: minmax(70px, 110px) 1fr; align-items: start; gap: 10px; }
.dimension-summary span { display: flex; flex-wrap: wrap; gap: 6px; }
.rule-form { display: grid; gap: 4px; }
.dimension-editor { padding: 18px 0; border-top: 1px solid var(--border); }
.dimension-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
.dimension-heading h3 { margin: 0 0 4px; font-size: 16px; }
.dimension-heading p { margin: 0; color: var(--text-muted); font-size: 13px; }
.dimension-row { display: grid; grid-template-columns: minmax(150px, .7fr) minmax(280px, 1.6fr) 36px; align-items: start; gap: 12px; margin-bottom: 12px; }
.dimension-row .el-select { width: 100%; }
@media (max-width: 720px) {
  .filter-bar, .table-footer, .dimension-heading { align-items: stretch; flex-direction: column; }
  .dimension-row { grid-template-columns: 1fr 36px; }
  .dimension-row .el-select { grid-column: 1 / -1; grid-row: 2; }
}
</style>
