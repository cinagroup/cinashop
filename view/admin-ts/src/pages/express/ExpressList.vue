<template>
  <div class="express-list">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>快递公司</span>
          <el-button type="primary" size="small" @click="openForm()">＋ 新增快递</el-button>
        </div>
      </template>

      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="公司名称" min-width="160" />
        <el-table-column prop="code" label="编码" width="140" />
        <el-table-column prop="sort" label="排序" width="80" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.isShow ? 'success' : 'info'">
              {{ row.isShow ? "显示" : "隐藏" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openForm(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 表单弹窗 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑快递' : '新增快递'" width="460px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="公司名称" required>
          <el-input v-model="form.name" placeholder="如: 顺丰速运" />
        </el-form-item>
        <el-form-item label="编码">
          <el-input v-model="form.code" placeholder="如: SF" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" />
        </el-form-item>
        <el-form-item label="是否显示">
          <el-switch v-model="form.is_show" :active-value="1" :inactive-value="0" />
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
  apiAdminExpressList,
  apiAdminExpressSave,
  apiAdminExpressDel,
  type ExpressItem,
} from "@/api/shipping";

const list = ref<ExpressItem[]>([]);
const loading = ref(false);
const formVisible = ref(false);
const saving = ref(false);
const form = reactive({
  id: 0,
  name: "",
  code: "",
  sort: 0,
  is_show: 1,
});

async function load() {
  loading.value = true;
  try {
    list.value = await apiAdminExpressList();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function openForm(row?: ExpressItem) {
  if (row) {
    form.id = row.id;
    form.name = row.name;
    form.code = row.code || "";
    form.sort = row.sort;
    form.is_show = row.isShow;
  } else {
    form.id = 0;
    form.name = "";
    form.code = "";
    form.sort = 0;
    form.is_show = 1;
  }
  formVisible.value = true;
}

async function save() {
  if (!form.name) return ElMessage.error("请输入快递公司名称");
  saving.value = true;
  try {
    await apiAdminExpressSave({
      id: form.id || undefined,
      name: form.name,
      code: form.code,
      sort: form.sort,
      is_show: form.is_show,
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

async function del(row: ExpressItem) {
  try {
    await ElMessageBox.confirm(`确认删除快递公司「${row.name}」?`, "删除确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await apiAdminExpressDel(row.id);
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
</style>
