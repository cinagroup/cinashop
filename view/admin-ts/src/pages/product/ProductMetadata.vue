<template>
  <div class="metadata-page">
    <div class="page-head">
      <div>
        <h2>商品基础资料</h2>
        <p>集中维护商品编辑时复用的计量单位与保障服务。</p>
      </div>
      <el-button @click="$router.push('/product')">返回商品</el-button>
    </div>

    <el-card shadow="never">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="商品单位" name="units">
          <div class="toolbar">
            <el-input
              v-model="unitQuery.name"
              clearable
              placeholder="搜索单位"
              @keyup.enter="loadUnits"
            />
            <el-button type="primary" @click="openUnit()">新增单位</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="units" v-loading="unitLoading" min-width="520">
              <el-table-column prop="name" label="单位名称" min-width="180" />
              <el-table-column prop="sort" label="排序" width="100" />
              <el-table-column label="状态" width="100">
                <template #default><el-tag type="success">启用</el-tag></template>
              </el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openUnit(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteUnit(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!unitLoading && !units.length" description="暂无商品单位" />
          <el-pagination
            v-model:current-page="unitQuery.page"
            :page-size="unitQuery.limit"
            :total="unitTotal"
            layout="total, prev, pager, next"
            @current-change="loadUnits"
          />
        </el-tab-pane>

        <el-tab-pane label="保障服务" name="ensures">
          <div class="toolbar">
            <el-input
              v-model="ensureQuery.name"
              clearable
              placeholder="搜索保障条款"
              @keyup.enter="loadEnsures"
            />
            <el-button type="primary" @click="openEnsure()">新增保障</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="ensures" v-loading="ensureLoading" min-width="760">
              <el-table-column label="图标" width="78">
                <template #default="{ row }">
                  <el-image v-if="row.image" :src="row.image" class="ensure-image" fit="cover" />
                  <span v-else>—</span>
                </template>
              </el-table-column>
              <el-table-column prop="name" label="保障条款" min-width="150" />
              <el-table-column prop="desc" label="说明" min-width="240" show-overflow-tooltip />
              <el-table-column prop="sort" label="排序" width="80" />
              <el-table-column label="启用" width="90">
                <template #default="{ row }">
                  <el-switch
                    :model-value="row.status"
                    :active-value="1"
                    :inactive-value="0"
                    @change="setEnsureStatus(row, Number($event))"
                  />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openEnsure(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteEnsure(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!ensureLoading && !ensures.length" description="暂无保障服务" />
          <el-pagination
            v-model:current-page="ensureQuery.page"
            :page-size="ensureQuery.limit"
            :total="ensureTotal"
            layout="total, prev, pager, next"
            @current-change="loadEnsures"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="unitDialog" :title="unitForm.id ? '编辑单位' : '新增单位'" width="min(440px, 92vw)">
      <el-form label-width="82px">
        <el-form-item label="单位名称" required>
          <el-input v-model="unitForm.name" maxlength="50" placeholder="如：件、盒、千克" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="unitForm.sort" :min="0" :max="32767" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="unitDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveUnit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="ensureDialog" :title="ensureForm.id ? '编辑保障' : '新增保障'" width="min(560px, 92vw)">
      <el-form label-width="92px">
        <el-form-item label="保障条款" required>
          <el-input v-model="ensureForm.name" maxlength="255" />
        </el-form-item>
        <el-form-item label="图标地址" required>
          <el-input v-model="ensureForm.image" maxlength="255" placeholder="HTTPS 或素材中心稳定地址" />
        </el-form-item>
        <el-form-item label="保障说明" required>
          <el-input v-model="ensureForm.desc" type="textarea" :rows="3" maxlength="255" show-word-limit />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="ensureForm.sort" :min="0" :max="2147483647" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="ensureForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ensureDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEnsure">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiProductEnsureDelete,
  apiProductEnsureList,
  apiProductEnsureSave,
  apiProductEnsureStatus,
  apiProductUnitDelete,
  apiProductUnitList,
  apiProductUnitSave,
  type ProductEnsure,
  type ProductUnit,
} from "@/api/productMetadata";

const activeTab = ref("units");
const units = ref<ProductUnit[]>([]);
const ensures = ref<ProductEnsure[]>([]);
const unitLoading = ref(false);
const ensureLoading = ref(false);
const saving = ref(false);
const unitTotal = ref(0);
const ensureTotal = ref(0);
const unitQuery = reactive({ page: 1, limit: 20, name: "" });
const ensureQuery = reactive({ page: 1, limit: 20, name: "" });
const unitDialog = ref(false);
const ensureDialog = ref(false);
const unitForm = reactive({ id: 0, name: "", sort: 0 });
const ensureForm = reactive({ id: 0, name: "", image: "", desc: "", sort: 0, status: 1 });

async function loadUnits() {
  unitLoading.value = true;
  try {
    const result = await apiProductUnitList(unitQuery);
    units.value = result.list;
    unitTotal.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "单位加载失败");
  } finally {
    unitLoading.value = false;
  }
}

async function loadEnsures() {
  ensureLoading.value = true;
  try {
    const result = await apiProductEnsureList(ensureQuery);
    ensures.value = result.list;
    ensureTotal.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保障服务加载失败");
  } finally {
    ensureLoading.value = false;
  }
}

function openUnit(row?: ProductUnit) {
  Object.assign(unitForm, row ? { id: row.id, name: row.name, sort: row.sort } : { id: 0, name: "", sort: 0 });
  unitDialog.value = true;
}

async function saveUnit() {
  const name = unitForm.name.trim();
  if (!name) return ElMessage.warning("请输入单位名称");
  saving.value = true;
  try {
    await apiProductUnitSave(unitForm.id, { name, sort: unitForm.sort });
    unitDialog.value = false;
    ElMessage.success(unitForm.id ? "单位已更新" : "单位已创建");
    await loadUnits();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "单位保存失败");
  } finally {
    saving.value = false;
  }
}

async function deleteUnit(row: ProductUnit) {
  try {
    await ElMessageBox.confirm(`确认删除单位「${row.name}」？正在使用的单位会被服务端拒绝。`, "删除单位", { type: "warning" });
  } catch { return; }
  try {
    await apiProductUnitDelete(row.id);
    ElMessage.success("单位已删除");
    await loadUnits();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "单位删除失败");
  }
}

function openEnsure(row?: ProductEnsure) {
  Object.assign(ensureForm, row
    ? { id: row.id, name: row.name, image: row.image, desc: row.desc, sort: row.sort, status: row.status }
    : { id: 0, name: "", image: "", desc: "", sort: 0, status: 1 });
  ensureDialog.value = true;
}

async function saveEnsure() {
  const payload = {
    name: ensureForm.name.trim(),
    image: ensureForm.image.trim(),
    desc: ensureForm.desc.trim(),
    sort: ensureForm.sort,
    status: ensureForm.status,
  };
  if (!payload.name || !payload.image || !payload.desc) return ElMessage.warning("请完整填写保障条款、图标和说明");
  saving.value = true;
  try {
    await apiProductEnsureSave(ensureForm.id, payload);
    ensureDialog.value = false;
    ElMessage.success(ensureForm.id ? "保障服务已更新" : "保障服务已创建");
    await loadEnsures();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保障服务保存失败");
  } finally {
    saving.value = false;
  }
}

async function setEnsureStatus(row: ProductEnsure, status: number) {
  try {
    await apiProductEnsureStatus(row.id, status);
    row.status = status;
    ElMessage.success(status ? "保障服务已启用" : "保障服务已停用");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "状态更新失败");
  }
}

async function deleteEnsure(row: ProductEnsure) {
  try {
    await ElMessageBox.confirm(`确认删除保障服务「${row.name}」？被商品引用时服务端会拒绝。`, "删除保障", { type: "warning" });
  } catch { return; }
  try {
    await apiProductEnsureDelete(row.id);
    ElMessage.success("保障服务已删除");
    await loadEnsures();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保障服务删除失败");
  }
}

onMounted(() => void Promise.all([loadUnits(), loadEnsures()]));
</script>

<style scoped>
.metadata-page { display: grid; gap: 16px; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.page-head h2 { margin: 0 0 6px; font-size: 20px; }
.page-head p { margin: 0; color: #667085; }
.toolbar { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.toolbar .el-input { width: min(320px, 100%); }
.table-scroll { width: 100%; overflow-x: auto; }
.ensure-image { width: 42px; height: 42px; border-radius: 8px; }
.el-pagination { margin-top: 16px; justify-content: flex-end; }

@media (max-width: 640px) {
  .page-head { align-items: flex-start; }
  .page-head p { font-size: 13px; }
  .toolbar { align-items: stretch; flex-direction: column; }
  .toolbar .el-input, .toolbar .el-button { width: 100%; }
  .el-pagination { justify-content: center; overflow-x: auto; }
}
</style>
