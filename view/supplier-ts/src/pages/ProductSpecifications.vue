<script setup lang="ts">
import { onMounted } from 'vue';
import { useSupplierProductRuleEditor } from '@/utils/supplierProductRuleEditor';
import SupplierProductRuleEditor from '@/components/SupplierProductRuleEditor.vue';
const editor = useSupplierProductRuleEditor();
const { auth, canRead, canManage, catalog, loading, busy, editing, error, notice, filter, editId, editRevision, createRevision, createIds, form,
  attempt, receipt, recoveryRead, submitDisabled, blankDimension, message, load, search, openCreate, openEdit, addDimension, removeDimension,
  immutableAttempt, verify, reread, recover, submit, removeRule, finishAttempt, closeEditor, current, session, invalidate } = editor;
// Retain the page's existing author API while both entrypoints use one controller.
defineExpose({ auth, canRead, canManage, catalog, loading, busy, editing, error, notice, filter, editId, editRevision, createRevision, createIds, form,
  attempt, receipt, recoveryRead, submitDisabled, blankDimension, message, load, search, openCreate, openEdit, addDimension, removeDimension,
  immutableAttempt, verify, reread, recover, submit, removeRule, finishAttempt, closeEditor, current, session, invalidate });
onMounted(load);
</script>
<template>
  <section class="page-section product-specifications-page">
    <header class="page-heading"><div><h1>规格模板</h1><p>复用当前供应商的规格维度与规格值，减少重复录入</p></div><div class="heading-actions"><el-button :disabled="busy || !!attempt" :loading="loading" @click="load">重新读取</el-button><el-button v-if="canManage" type="primary" :disabled="busy || loading || !!attempt || !catalog" @click="openCreate">新增模板</el-button></div></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon /><el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
    <article v-if="attempt" class="recovery" role="status"><p>操作结果待核对，当前模板不会重复提交。</p><el-button type="primary" :loading="busy" :disabled="busy" @click="recover">核对执行结果</el-button><el-button :disabled="busy || !recoveryRead" @click="finishAttempt">按当前列表结束本次操作</el-button></article>
    <article class="surface filter-bar"><el-input v-model="filter.rule_name" clearable placeholder="搜索模板名称" :disabled="busy || !!attempt" @keyup.enter="search" /><el-button type="primary" :disabled="busy || !!attempt" @click="search">查询</el-button></article>
    <article v-loading="loading" class="surface table-card"><el-table :data="catalog?.list ?? []" empty-text="暂无规格模板"><el-table-column prop="id" label="ID" width="90" /><el-table-column prop="rule_name" label="模板名称" min-width="180" /><el-table-column label="规格内容" min-width="330"><template #default="scope"><div class="dimension-summary"><div v-for="dimension in scope.row.spec" :key="dimension.value"><strong>{{ dimension.value }}</strong><span><el-tag v-for="detail in dimension.detail" :key="detail" size="small" effect="plain">{{ detail }}</el-tag></span></div></div></template></el-table-column><el-table-column v-if="canManage" label="操作" width="140" fixed="right"><template #default="scope"><el-button link type="primary" :disabled="busy || !!attempt" @click="openEdit(scope.row.id)">编辑</el-button><el-button link type="danger" :disabled="busy || !!attempt" @click="removeRule(scope.row)">删除</el-button></template></el-table-column></el-table><div class="table-footer"><span>共 {{ catalog?.count ?? 0 }} 个模板</span><el-pagination v-model:current-page="filter.page" :page-size="filter.limit" :total="catalog?.count ?? 0" layout="prev, pager, next" :disabled="busy || !!attempt" @current-change="load" /></div></article>
    <SupplierProductRuleEditor :editor="editor" />
  </section>
</template>
<style scoped>
.product-specifications-page{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0;max-width:100%}.heading-actions{display:flex;gap:8px}.heading-actions :deep(.el-button+.el-button){margin-left:0}.filter-bar{display:flex;gap:12px;padding:18px}.filter-bar .el-input{max-width:360px}.table-card{overflow:hidden;min-width:0}.table-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 20px;color:var(--text-muted)}.dimension-summary{display:grid;gap:10px;padding:4px 0}.dimension-summary>div{display:grid;grid-template-columns:minmax(70px,110px) 1fr;align-items:start;gap:10px}.dimension-summary span{display:flex;flex-wrap:wrap;gap:6px}.rule-form{display:grid;gap:4px}.dimension-editor{padding:18px 0;border-top:1px solid var(--border)}.dimension-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}.dimension-heading h3{margin:0 0 4px;font-size:16px}.dimension-heading p{margin:0;color:var(--text-muted);font-size:13px}.dimension-row{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(280px,1.6fr) 60px;align-items:start;gap:12px;margin-bottom:12px}.dimension-row .el-select{width:100%}.recovery{padding:16px;border:1px solid #fcd34d;border-radius:8px;background:#fffbeb}.recovery p{margin:0 0 12px;color:#92400e}
@media(max-width:720px){.page-heading,.filter-bar,.table-footer,.dimension-heading{align-items:stretch;flex-direction:column}.heading-actions{flex-wrap:wrap}.filter-bar .el-input{max-width:none}.dimension-row{grid-template-columns:1fr 60px}.dimension-row .el-select{grid-column:1/-1;grid-row:2}.product-specifications-page :deep(.el-dialog__body){max-height:64dvh;overflow:auto}.recovery :deep(.el-button){margin:4px 8px 4px 0;white-space:normal}}
</style>
