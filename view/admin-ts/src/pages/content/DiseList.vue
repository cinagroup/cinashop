<template>
  <div>
    <el-card shadow="never">
      <template #header>
        <div class="header">
          <div>
            <div class="title">DIY 装修 / 自定义页面</div>
            <div class="subtitle">value 为装修 JSON；content 为独立的旧版内容，保存时不会互相覆盖。</div>
          </div>
          <el-button type="primary" size="small" @click="openForm()">＋ 新增页面</el-button>
        </div>
      </template>

      <el-table :data="list" v-loading="loading" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="页面名称" min-width="150" />
        <el-table-column prop="title" label="页面标题" min-width="170" />
        <el-table-column label="合同类型" min-width="150">
          <template #default="{ row }">
            <div>{{ typeLabel(row.type) }}</div>
            <div class="muted">{{ row.template_name || "无模板标识" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="DIY" width="80">
          <template #default="{ row }">
            <el-tag :type="row.is_diy === 1 ? 'success' : 'info'" size="small">
              {{ row.is_diy === 1 ? "是" : "否" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'">
              {{ row.status === 1 ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="版本 / 更新时间" min-width="190">
          <template #default="{ row }">
            <el-tooltip :content="row.version || '无版本号'" placement="top">
              <div class="version">{{ row.version || "—" }}</div>
            </el-tooltip>
            <div class="muted">{{ formatTime(row.update_time || row.add_time) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openForm(row)">编辑</el-button>
            <el-tooltip
              :disabled="!row.delete_protected"
              :content="row.delete_protection_reason"
              placement="top"
            >
              <span>
                <el-button
                  size="small"
                  type="danger"
                  :disabled="row.delete_protected"
                  @click="del(row)"
                >
                  删除
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="form.id ? '编辑页面' : '新增 DIY 页面'" width="760px">
      <el-alert
        v-if="!form.id"
        title="新增页固定创建为停用的 DIY 首页合同（type=1、is_diy=1），请先检查内容再另行启用。"
        type="info"
        :closable="false"
        show-icon
        class="notice"
      />
      <el-form :model="form" label-width="110px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" maxlength="255" show-word-limit />
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="form.title" maxlength="255" show-word-limit />
        </el-form-item>
        <el-form-item v-if="form.id" label="不可变合同">
          <el-descriptions :column="3" border size="small" class="contract">
            <el-descriptions-item label="type">{{ form.type }}</el-descriptions-item>
            <el-descriptions-item label="template_name">{{ form.templateName || "空" }}</el-descriptions-item>
            <el-descriptions-item label="is_diy">{{ form.isDiy }}</el-descriptions-item>
          </el-descriptions>
        </el-form-item>
        <el-form-item label="装修 value" required>
          <div class="field">
            <el-input
              v-model="form.value"
              type="textarea"
              :rows="12"
              placeholder="必须是有效 JSON；保存时会校验和规范化"
            />
            <div class="help">公开 DIY 接口读取此字段。损坏 JSON 无法保存。</div>
          </div>
        </el-form-item>
        <el-form-item label="旧版 content">
          <div class="field">
            <el-input
              v-model="form.content"
              type="textarea"
              :rows="5"
              placeholder="仅在明确需要旧版内容时填写"
            />
            <div class="help">独立字段，不会复制到 value；也不能与 value 写入相同内容。</div>
          </div>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch
            v-model="form.status"
            :active-value="1"
            :inactive-value="0"
            :disabled="!form.id"
          />
          <span v-if="!form.id" class="help inline-help">新增合同强制停用</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import request, { getData } from "@/utils/request";

interface DiseRow {
  id: number;
  name: string;
  title: string;
  value: string;
  content: string;
  status: 0 | 1;
  type: number;
  template_name: string;
  is_diy: number;
  is_show: number;
  version: string;
  add_time: number;
  update_time: number;
  delete_protected: boolean;
  delete_protection_reason: string;
}

interface DiseForm {
  id: number;
  name: string;
  title: string;
  value: string;
  content: string;
  status: 0 | 1;
  type: number;
  templateName: string;
  isDiy: number;
}

interface DiseSaveResult {
  id: number;
  version: string;
  update_time: number;
}

const list = ref<DiseRow[]>([]);
const loading = ref(false);
const submitting = ref(false);
const formVisible = ref(false);
const form = reactive<DiseForm>({
  id: 0,
  name: "",
  title: "",
  value: "[]",
  content: "",
  status: 0,
  type: 1,
  templateName: "",
  isDiy: 1,
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    list.value = await getData<DiseRow[]>(request.get("/dise/list"));
  } catch (error) {
    list.value = [];
    ElMessage.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

function prettyJson(value: string): string {
  if (!value.trim()) return value;
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    ElMessage.warning("该页面的 value 已损坏，请修复为有效 JSON 后再保存");
    return value;
  }
}

function openForm(row?: DiseRow): void {
  if (row) {
    form.id = row.id;
    form.name = row.name;
    form.title = row.title;
    form.value = prettyJson(row.value ?? "");
    form.content = row.content ?? "";
    form.status = row.status;
    form.type = row.type;
    form.templateName = row.template_name;
    form.isDiy = row.is_diy;
  } else {
    form.id = 0;
    form.name = "";
    form.title = "";
    form.value = "[]";
    form.content = "";
    form.status = 0;
    form.type = 1;
    form.templateName = "";
    form.isDiy = 1;
  }
  formVisible.value = true;
}

function canonicalJson(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

async function save(): Promise<void> {
  const name = form.name.trim();
  if (!name) {
    ElMessage.error("请输入名称");
    return;
  }
  const value = canonicalJson(form.value);
  if (value === null) {
    ElMessage.error("装修 value 必须是有效且非 null 的 JSON");
    return;
  }
  if (value === form.content) {
    ElMessage.error("value 与 content 必须独立维护，不能写入相同内容");
    return;
  }

  const payload = form.id
    ? {
        id: form.id,
        name,
        title: form.title.trim(),
        value,
        content: form.content,
        status: form.status,
      }
    : {
        create_kind: "diy_page" as const,
        name,
        title: form.title.trim(),
        value,
        content: form.content,
        status: 0 as const,
      };

  submitting.value = true;
  try {
    await getData<DiseSaveResult>(request.post("/dise/save", payload));
    ElMessage.success("保存成功");
    formVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    submitting.value = false;
  }
}

async function del(row: DiseRow): Promise<void> {
  if (row.delete_protected) {
    ElMessage.warning(row.delete_protection_reason || "该配置受保护，不能删除");
    return;
  }
  try {
    await ElMessageBox.confirm(`删除页面「${row.name}」?`, "确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await getData<null>(request.delete(`/dise/del/${row.id}`));
    ElMessage.success("已删除");
    await load();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

function typeLabel(type: number): string {
  if (type === 1) return "1 · 首页装修";
  if (type === 3) return "3 · 系统装修配置";
  return `${type} · 其他`;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "未记录时间";
  return new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false });
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.title {
  font-weight: 600;
}

.subtitle,
.muted,
.help {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.subtitle {
  margin-top: 4px;
}

.version {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notice {
  margin-bottom: 18px;
}

.contract,
.field {
  width: 100%;
}

.help {
  margin-top: 5px;
  line-height: 1.4;
}

.inline-help {
  margin: 0 0 0 10px;
}
</style>
