<template>
  <div class="level-list">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>会员等级</span>
          <el-button type="primary" size="small" @click="openForm()">＋ 新增等级</el-button>
        </div>
      </template>

      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="等级名称" min-width="140">
          <template #default="{ row }">
            <span :style="{ color: row.color || '#333', fontWeight: 600 }">
              {{ row.name }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="grade" label="级别" width="80" />
        <el-table-column label="会员折扣" width="100">
          <template #default="{ row }">{{ Number(row.discount) / 10 }} 折</template>
        </el-table-column>
        <el-table-column prop="expNum" label="升级经验" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.isShow ? 'success' : 'info'">
              {{ row.isShow ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="explain" label="说明" min-width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openForm(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新增/编辑弹窗 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑等级' : '新增等级'" width="480px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="等级名称" required>
          <el-input v-model="form.name" placeholder="如: 白银会员" />
        </el-form-item>
        <el-form-item label="级别" required>
          <el-input-number v-model="form.grade" :min="0" />
        </el-form-item>
        <el-form-item label="会员折扣">
          <el-input-number v-model="form.discount" :min="0" :max="100" />
          <span class="hint">% (如 95 = 9.5 折)</span>
        </el-form-item>
        <el-form-item label="升级经验">
          <el-input-number v-model="form.exp_num" :min="0" />
        </el-form-item>
        <el-form-item label="颜色">
          <el-color-picker v-model="form.color" />
        </el-form-item>
        <el-form-item label="是否启用">
          <el-switch v-model="form.is_show" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.explain" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminLevelList,
  apiAdminLevelSave,
  apiAdminLevelDel,
  type LevelItem,
} from "@/api/level";

const list = ref<LevelItem[]>([]);
const loading = ref(false);
const formVisible = ref(false);
const saving = ref(false);
const form = reactive({
  id: 0,
  name: "",
  grade: 0,
  discount: 100,
  exp_num: 0,
  color: "",
  is_show: 1,
  explain: "",
});

async function load() {
  loading.value = true;
  try {
    list.value = await apiAdminLevelList();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function openForm(row?: LevelItem) {
  if (row) {
    form.id = row.id;
    form.name = row.name;
    form.grade = row.grade;
    form.discount = Number(row.discount);
    form.exp_num = row.expNum;
    form.color = row.color || "";
    form.is_show = row.isShow;
    form.explain = row.explain || "";
  } else {
    form.id = 0;
    form.name = "";
    form.grade = list.value.length;
    form.discount = 100;
    form.exp_num = 0;
    form.color = "";
    form.is_show = 1;
    form.explain = "";
  }
  formVisible.value = true;
}

async function save() {
  if (!form.name) return ElMessage.error("请输入等级名称");
  saving.value = true;
  try {
    await apiAdminLevelSave({
      id: form.id || undefined,
      name: form.name,
      grade: form.grade,
      discount: form.discount,
      exp_num: form.exp_num,
      is_show: form.is_show,
      color: form.color,
      explain: form.explain,
    });
    ElMessage.success("保存成功");
    formVisible.value = false;
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function del(row: LevelItem) {
  try {
    await ElMessageBox.confirm(`确认删除等级「${row.name}」?`, "删除确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await apiAdminLevelDel(row.id);
    ElMessage.success("已删除");
    load();
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

.hint {
  color: #999;
  font-size: 12px;
  margin-left: 8px;
}
</style>
