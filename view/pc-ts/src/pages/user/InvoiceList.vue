<template>
  <div class="invoice-list container">
    <h2 class="title">我的发票</h2>

    <!-- 添加发票 -->
    <el-card shadow="never" class="section">
      <template #header>添加发票</template>
      <el-form :model="form" label-width="90px" style="max-width: 480px">
        <el-form-item label="抬头类型">
          <el-radio-group v-model="form.header_type">
            <el-radio :value="1">个人</el-radio>
            <el-radio :value="2">企业</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="发票抬头" required>
          <el-input v-model="form.name" placeholder="公司名称或个人名称" />
        </el-form-item>
        <el-form-item label="税号" required>
          <el-input v-model="form.duty_number" placeholder="企业税号" />
        </el-form-item>
        <el-form-item label="设为默认">
          <el-switch v-model="form.is_default" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 发票列表 -->
    <el-card shadow="never" class="section">
      <template #header>发票列表</template>
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="name" label="抬头" min-width="160" />
        <el-table-column prop="duty_number" label="税号" width="160" />
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <el-tag size="small">{{ row.header_type === 1 ? "个人" : "企业" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="默认" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.is_default" size="small" type="danger">默认</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button link type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!list.length && !loading" description="暂无发票" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiInvoiceList, apiInvoiceSave, apiInvoiceDel } from "@/api/finance";

interface Invoice {
  id: number;
  header_type: number;
  name: string;
  duty_number: string;
  is_default: number;
}

const list = ref<Invoice[]>([]);
const loading = ref(false);
const saving = ref(false);
const form = reactive({
  header_type: 1,
  name: "",
  duty_number: "",
  is_default: 0,
});

async function load() {
  loading.value = true;
  try {
    list.value = (await apiInvoiceList()) as Invoice[];
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.name) return ElMessage.error("请输入发票抬头");
  if (!form.duty_number) return ElMessage.error("请输入税号");
  saving.value = true;
  try {
    await apiInvoiceSave({ ...form });
    ElMessage.success("保存成功");
    form.name = "";
    form.duty_number = "";
    form.is_default = 0;
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function del(row: Invoice) {
  await apiInvoiceDel(row.id);
  ElMessage.success("已删除");
  load();
}

onMounted(load);
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.section {
  margin-bottom: 20px;
}
</style>
