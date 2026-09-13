<template>
  <div class="shipping-list">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>运费模板</span>
          <el-button type="primary" size="small" @click="openForm()">＋ 新增模板</el-button>
        </div>
      </template>

      <div class="list-controls">
        <el-input v-model="searchName" maxlength="255" clearable placeholder="搜索模板名称" aria-label="搜索模板名称" @keyup.enter="search" />
        <el-button @click="search">查询</el-button>
        <el-select v-model="limit" aria-label="每页模板数量" @change="search">
          <el-option v-for="size in [1, 5, 10, 20, 50]" :key="size" :label="`每页 ${size} 条`" :value="size" />
        </el-select>
      </div>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
      <el-button v-if="loadError" @click="load">重试当前页</el-button>
      <p v-if="compactTable" class="table-hint">左右滑动表格可查看全部列和操作</p>
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="模板名称" min-width="160" />
        <el-table-column label="计费方式" width="110">
          <template #default="{ row }">{{ row.type === 1 ? "按件" : row.type === 2 ? "按重" : "按体积" }}</template>
        </el-table-column>
        <el-table-column label="配送区域" min-width="200">
          <template #default="{ row }">
            <span class="region-text">{{ regionText(row.id) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="sort" label="排序" width="80" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? "启用" : "停用" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" :fixed="compactTable ? false : 'right'">
          <template #default="{ row }">
            <el-button size="small" @click="openForm(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="list-pagination">
        <span>{{ count === null ? '总数待刷新' : `共 ${count} 个模板` }} · 第 {{ cursors.length }} 页</span>
        <el-button :disabled="loading || cursors.length === 1" @click="previousPage">上一页</el-button>
        <el-button :disabled="loading || !nextCursor || !!loadError" @click="nextPage">下一页</el-button>
      </div>
    </el-card>

    <ShippingTemplateEditor v-if="formVisible" :id="editId" @close="formVisible=false" @saved="editorSaved" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import ShippingTemplateEditor from './ShippingTemplateEditor.vue';
import { ElMessage, ElMessageBox } from "element-plus";
import { getToken } from '@/utils/auth';
import {
  apiAdminShippingTemplateList,
  apiAdminShippingTemplateDel,
  type ShippingTemplate,
  type ShippingRegion,
} from "@/api/shipping";

const list = ref<ShippingTemplate[]>([]);
const regions = ref<(ShippingRegion & { templateId: number })[]>([]);
const loading = ref(false);
const compactTable = ref(window.innerWidth <= 768);
const updateTableWidth = () => { compactTable.value = window.innerWidth <= 768; };
window.addEventListener('resize', updateTableWidth);
const searchName = ref('');
const appliedName = ref('');
const limit = ref(20);
const count = ref<number | null>(null);
const cursors = ref<Array<string | undefined>>([undefined]);
const nextCursor = ref<string | null>(null);
const loadError = ref('');
let loadGeneration = 0;
const formVisible = ref(false);
const editId = ref(0);

function regionText(templateId: number) {
  const rs = regions.value.filter((r) => r.templateId === templateId);
  if (!rs.length) return "-";
  return rs
    .map((r) => {
      const name = r.regionName ?? r.region_name ?? "";
      const fp = r.firstPrice ?? r.first_price ?? "0";
      const cp = r.continuePrice ?? r.continue_price ?? "0";
      return `${name} ¥${fp}/${r.first} + ¥${cp}/${r.continue}`;
    })
    .join("; ");
}

async function load() {
  const generation = ++loadGeneration;
  const token = getToken();
  loading.value = true;
  loadError.value = '';
  list.value = [];
  regions.value = [];
  nextCursor.value = null;
  count.value = null;
  try {
    const result = await apiAdminShippingTemplateList({ limit: limit.value, name: appliedName.value, cursor: cursors.value.at(-1) });
    if (generation !== loadGeneration || getToken() !== token) return;
    list.value = result.list;
    regions.value = result.regions;
    count.value = result.count;
    nextCursor.value = result.nextCursor;
  } catch (e) {
    if (generation === loadGeneration && getToken() === token) loadError.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function refreshFirstPage() { cursors.value = [undefined]; void load(); }
function search() { appliedName.value = searchName.value.trim(); refreshFirstPage(); }
function nextPage() { if (!loading.value && nextCursor.value) { cursors.value.push(nextCursor.value); void load(); } }
function previousPage() { if (!loading.value && cursors.value.length > 1) { cursors.value.pop(); void load(); } }
onBeforeUnmount(() => { loadGeneration++; window.removeEventListener('resize', updateTableWidth); });

function openForm(row?: ShippingTemplate) {
  ElMessage.closeAll();
  editId.value = row?.id ?? 0;
  formVisible.value = true;
}
function editorSaved() {
  formVisible.value = false;
  ElMessage.success('保存成功');
  refreshFirstPage();
}

async function del(row: ShippingTemplate) {
  try {
    await ElMessageBox.confirm(`确认删除模板「${row.name}」?`, "删除确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await apiAdminShippingTemplateDel(row.id);
    ElMessage.success("已删除");
    refreshFirstPage();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "删除失败");
  }
}

onMounted(load);
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.region-text {
  font-size: 12px;
  color: #666;
}

.region-list {
  width: 100%;
}

.region-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.region-name {
  width: 140px;
}

.region-num {
  width: 120px;
}

.region-unit {
  font-size: 12px;
  color: #999;
}
.list-controls, .list-pagination { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
.list-controls .el-input { max-width: 260px; }
.list-controls .el-select { width: 140px; }
.list-pagination { justify-content: flex-end; }
.list-pagination span { font-size: 13px; color: #666; }
.table-hint { color: #666; font-size: 12px; margin: 8px 0; }
</style>
