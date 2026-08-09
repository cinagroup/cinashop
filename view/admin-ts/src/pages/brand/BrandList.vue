<template>
  <div class="brand-page">
    <div class="page-head">
      <h2>品牌管理</h2>
      <el-button type="primary" @click="openForm()">＋ 新增品牌</el-button>
    </div>

    <el-table :data="list" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="brandName" label="品牌名称" min-width="180" />
      <el-table-column label="Logo" width="100">
        <template #default="{ row }">
          <el-image v-if="row.pic" :src="row.pic" class="brand-logo" fit="cover" />
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column prop="sort" label="排序" width="80" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.isShow === 1 ? 'success' : 'info'">
            {{ row.isShow === 1 ? "显示" : "隐藏" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button link type="primary" @click="openForm(row)">编辑</el-button>
          <el-button link type="danger" @click="del(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!list.length && !loading" description="暂无品牌" />

    <!-- 新增/编辑弹窗 -->
    <el-dialog v-model="showForm" :title="form.id ? '编辑品牌' : '新增品牌'" width="440px">
      <el-form label-width="80px">
        <el-form-item label="品牌名称">
          <el-input v-model="form.brand_name" placeholder="品牌名称" />
        </el-form-item>
        <el-form-item label="Logo URL">
          <el-input v-model="form.pic" placeholder="品牌 Logo 图片地址" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" :max="999" />
        </el-form-item>
        <el-form-item label="显示">
          <el-switch v-model="form.is_show" :active-value="1" :inactive-value="0" />
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
import { apiAdminBrandList, apiAdminBrandSave, apiAdminBrandDel, type BrandItem } from "@/api/brand";

const list = ref<BrandItem[]>([]);
const loading = ref(true);
const showForm = ref(false);
const form = reactive({ id: 0, brand_name: "", pic: "", sort: 0, is_show: 1 });

async function load() {
  loading.value = true;
  try {
    list.value = await apiAdminBrandList();
  } catch (e) {
    list.value = [];
    ElMessage.error((e as Error).message || "加载失败");
  } finally {
    loading.value = false;
  }
}

function openForm(row?: BrandItem) {
  if (row) {
    form.id = row.id;
    form.brand_name = row.brandName;
    form.pic = row.pic;
    form.sort = row.sort;
    form.is_show = row.isShow;
  } else {
    form.id = 0;
    form.brand_name = "";
    form.pic = "";
    form.sort = 0;
    form.is_show = 1;
  }
  showForm.value = true;
}

async function save() {
  if (!form.brand_name) return ElMessage.warning("请输入品牌名称");
  try {
    await apiAdminBrandSave({ id: form.id || undefined, brand_name: form.brand_name, pic: form.pic, sort: form.sort, is_show: form.is_show });
    ElMessage.success(form.id ? "更新成功" : "创建成功");
    showForm.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function del(row: BrandItem) {
  try {
    await ElMessageBox.confirm(`确认删除品牌「${row.brandName}」?`, "确认");
    await apiAdminBrandDel(row.id);
    ElMessage.success("已删除");
    load();
  } catch {
    // cancel
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
.brand-logo {
  width: 48px;
  height: 48px;
  border-radius: 6px;
}
</style>
