<template>
  <div class="category-page">
    <div class="page-head">
      <h2>商品分类</h2>
      <el-button type="primary" @click="openForm()">＋ 新增分类</el-button>
    </div>

    <el-table :data="list" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="cateName" label="分类名称" />
      <el-table-column label="排序" width="100" prop="sort" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.isShow === 1 ? 'success' : 'info'">
            {{ row.isShow === 1 ? "显示" : "隐藏" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button link type="primary" @click="openForm(row)">编辑</el-button>
          <el-button link type="danger" @click="del(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增/编辑弹窗 -->
    <el-dialog v-model="showForm" :title="formData.id ? '编辑分类' : '新增分类'" width="480px">
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="formData.cate_name" placeholder="分类名称" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="formData.sort" :min="0" :max="999" />
        </el-form-item>
        <el-form-item label="显示">
          <el-switch v-model="formData.is_show" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showForm = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiAdminCategoryList, apiAdminCategorySave, apiAdminCategoryDel, type CategoryItem } from "@/api/category";

const list = ref<CategoryItem[]>([]);
const loading = ref(true);
const showForm = ref(false);
const formData = reactive({
  id: 0,
  cate_name: "",
  sort: 0,
  is_show: 1,
});

async function load() {
  loading.value = true;
  try {
    list.value = await apiAdminCategoryList();
  } finally {
    loading.value = false;
  }
}

function openForm(row?: CategoryItem) {
  if (row) {
    formData.id = row.id;
    formData.cate_name = row.cateName;
    formData.sort = row.sort;
    formData.is_show = row.isShow;
  } else {
    formData.id = 0;
    formData.cate_name = "";
    formData.sort = 0;
    formData.is_show = 1;
  }
  showForm.value = true;
}

async function save() {
  if (!formData.cate_name) return ElMessage.warning("请输入分类名称");
  try {
    await apiAdminCategorySave({
      id: formData.id || undefined,
      cate_name: formData.cate_name,
      sort: formData.sort,
      is_show: formData.is_show,
    });
    ElMessage.success(formData.id ? "更新成功" : "创建成功");
    showForm.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function del(row: CategoryItem) {
  try {
    await ElMessageBox.confirm(`确认删除分类「${row.cateName}」?`, "确认");
    await apiAdminCategoryDel(row.id);
    ElMessage.success("已删除");
    load();
  } catch {
    // 取消
  }
}

onMounted(load);
</script>

<style scoped>
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.page-head h2 {
  font-size: 18px;
  margin: 0;
}
</style>
