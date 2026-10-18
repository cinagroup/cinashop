<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { deleteShippingTemplate, getShippingTemplates } from '@/api/supplier';
import { ApiError } from '@/api/http';
import { useShippingTemplateList } from '@/utils/shippingTemplateList';
import { useSupplierShippingTemplateEditor } from '@/utils/supplierShippingTemplateEditor';
import SupplierShippingTemplateEditor from '@/components/SupplierShippingTemplateEditor.vue';
import type { ShippingTemplateRow } from '@/types';
const deleting = ref(false), filter = reactive({ name: '' });
let confirmationPending = false;
const editor = useSupplierShippingTemplateEditor({ blocked: () => deleting.value,
  onInvalidate: () => { if (confirmationPending) ElMessageBox.close(); confirmationPending = false; list.reset(); filter.name = ''; deleting.value = false; },
  onSaved: async () => { await load(); },
});
const { saving, reading, sessionInvalidated, uncertainMutation, dialogVisible, canManage, current, session, canWrite, unknownResult, openCreate, openEdit } = editor;
const list = useShippingTemplateList(query => getShippingTemplates({ ...query }, session.signal), () => current());
const { rows, count, loading, error: listError, applied, pages } = list;
async function load() { await list.load(); }
async function search() { await list.load({ name: filter.name, page: 1, limit: applied.value.limit }); }
async function changePage(page: number) { await list.load({ ...applied.value, page }); }
async function changePageSize(event: Event) { await list.load({ ...applied.value, page: 1, limit: Number((event.target as HTMLSelectElement).value) }); }
async function jumpPage(event: Event) { await changePage(Number((event.target as HTMLInputElement).value)); }
async function removeTemplate(row: ShippingTemplateRow) {
  if (row.id === 1 || !canWrite() || deleting.value || saving.value || reading.value || dialogVisible.value) return;
  deleting.value = true; let dispatched = false;
  try {
    confirmationPending = true;
    await ElMessageBox.confirm(`删除“${row.name}”后不能恢复；被商品使用的模板会被服务器拒绝删除。`, '删除运费模板', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' });
    confirmationPending = false;
    // The deletion itself owns blocked; other author calls remain blocked until it finishes.
    if (!current() || !canManage.value || uncertainMutation.value) return;
    dispatched = true; await deleteShippingTemplate(row.id, session.signal);
    if (!current()) return;
    ElMessage.success('运费模板已删除'); await load();
  } catch (error) {
    if (!current()) return;
    if (error !== 'cancel' && error !== 'close') ElMessage.error(dispatched && !(error instanceof ApiError && error.status === 400) ? unknownResult('删除') : error instanceof Error ? error.message : '运费模板删除失败');
  } finally { confirmationPending = false; if (current()) deleting.value = false; }
}
onMounted(async () => { if (current()) await load(); });
onBeforeUnmount(() => { if (confirmationPending) ElMessageBox.close(); confirmationPending = false; list.reset(); });
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

    <SupplierShippingTemplateEditor :editor="editor" />
  </section>
</template>

<style scoped>
.filter-bar { display: flex; gap: 12px; padding: 18px; }
.filter-bar .el-input { max-width: 360px; }
.table-card { overflow: hidden; }
.table-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; padding: 14px 20px; color: var(--text-muted); }
.table-footer label, .page-actions { display: flex; align-items: center; gap: 8px; }
.table-footer select, .table-footer input { min-height: 32px; border: 1px solid var(--border); border-radius: 6px; color: inherit; background: var(--bg); }
.table-footer input { width: 60px; }
.page-actions .el-button + .el-button { margin-left: 0; }
@media (max-width: 900px) { .table-footer { justify-content: flex-start; padding: 14px 12px; } }
</style>
