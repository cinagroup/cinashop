<template>
  <div class="shipping-list">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>运费模板</span>
          <el-button type="primary" size="small" @click="openForm()">＋ 新增模板</el-button>
        </div>
      </template>

      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="模板名称" min-width="160" />
        <el-table-column label="计费方式" width="110">
          <template #default="{ row }">{{ row.type === 1 ? "按件" : "按重" }}</template>
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
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openForm(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 表单弹窗 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑模板' : '新增模板'" width="640px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="模板名称" required>
          <el-input v-model="form.name" placeholder="如: 江浙沪包邮" />
        </el-form-item>
        <el-form-item label="计费方式">
          <el-radio-group v-model="form.type">
            <el-radio :value="1">按件</el-radio>
            <el-radio :value="2">按重</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" />
        </el-form-item>
        <el-form-item label="是否启用">
          <el-switch v-model="form.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item label="区域费率">
          <div class="region-list">
            <div v-for="(r, i) in form.regions" :key="i" class="region-row">
              <el-input v-model="r.region_name" placeholder="地区 (如: 广东省)" class="region-name" />
              <el-input-number v-model="r.first" :min="0" :precision="2" :step="1" class="region-num" />
              <span class="region-unit">首件/首重</span>
              <el-input-number v-model="r.first_price" :min="0" :precision="2" :step="0.5" class="region-num" />
              <span class="region-unit">首费</span>
              <el-input-number v-model="r.continue" :min="0" :precision="2" :step="1" class="region-num" />
              <span class="region-unit">续件/续重</span>
              <el-input-number v-model="r.continue_price" :min="0" :precision="2" :step="0.5" class="region-num" />
              <span class="region-unit">续费</span>
              <el-button size="small" type="danger" text @click="form.regions.splice(i, 1)">删</el-button>
            </div>
            <el-button size="small" @click="addRegion">＋ 添加区域</el-button>
          </div>
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
  apiAdminShippingTemplateList,
  apiAdminShippingTemplateSave,
  apiAdminShippingTemplateDel,
  type ShippingTemplate,
  type ShippingRegion,
} from "@/api/shipping";

const list = ref<ShippingTemplate[]>([]);
const regions = ref<(ShippingRegion & { templateId: number })[]>([]);
const loading = ref(false);
const formVisible = ref(false);
const saving = ref(false);
const form = reactive({
  id: 0,
  name: "",
  type: 1,
  sort: 0,
  status: 1,
  regions: [] as ShippingRegion[],
});

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

function addRegion() {
  form.regions.push({ region_id: 0, region_name: "", first: "1", first_price: "0", continue: "1", continue_price: "0" });
}

async function load() {
  loading.value = true;
  try {
    const result = await apiAdminShippingTemplateList();
    list.value = result.list;
    regions.value = result.regions;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function openForm(row?: ShippingTemplate) {
  if (row) {
    form.id = row.id;
    form.name = row.name;
    form.type = row.type;
    form.sort = row.sort;
    form.status = row.status;
    form.regions = regions.value
      .filter((r) => r.templateId === row.id)
      .map((r) => ({
        region_id: r.regionId ?? r.region_id ?? 0,
        region_name: r.regionName ?? r.region_name ?? "",
        first: r.first,
        first_price: r.firstPrice ?? r.first_price ?? "0",
        continue: r.continue,
        continue_price: r.continuePrice ?? r.continue_price ?? "0",
      }));
  } else {
    form.id = 0;
    form.name = "";
    form.type = 1;
    form.sort = 0;
    form.status = 1;
    form.regions = [{ region_id: 0, region_name: "", first: "1", first_price: "0", continue: "1", continue_price: "0" }];
  }
  formVisible.value = true;
}

async function save() {
  if (!form.name) return ElMessage.error("请输入模板名称");
  saving.value = true;
  try {
    await apiAdminShippingTemplateSave({
      id: form.id || undefined,
      name: form.name,
      type: form.type,
      sort: form.sort,
      status: form.status,
      regions: form.regions.filter((r) => r.region_name),
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

async function del(row: ShippingTemplate) {
  try {
    await ElMessageBox.confirm(`确认删除模板「${row.name}」?`, "删除确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await apiAdminShippingTemplateDel(row.id);
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
</style>
