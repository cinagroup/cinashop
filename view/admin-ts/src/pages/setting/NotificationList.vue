<template>
  <div>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="通知模板" name="template">
        <el-card shadow="never">
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span>通知模板</span>
              <el-button type="primary" size="small" @click="openForm()">＋ 新增</el-button>
            </div>
          </template>
          <el-table :data="list" v-loading="loading" border>
            <el-table-column prop="id" label="ID" width="60" />
            <el-table-column prop="title" label="标题" min-width="160" />
            <el-table-column prop="type" label="类型" width="100" />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">{{ row.status === 1 ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button size="small" @click="openForm(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-dialog v-model="formVisible" :title="form.id ? '编辑模板' : '新增模板'" width="560px">
          <el-form :model="form" label-width="80px">
            <el-form-item label="标题"><el-input v-model="form.title" /></el-form-item>
            <el-form-item label="类型">
              <el-select v-model="form.type" style="width:200px">
                <el-option value="wechat" label="微信" />
                <el-option value="sms" label="短信" />
                <el-option value="system" label="站内信" />
              </el-select>
            </el-form-item>
            <el-form-item label="内容">
              <el-input v-model="form.content" type="textarea" :rows="5" placeholder="模板内容, 支持变量如 {order_id}" />
            </el-form-item>
            <el-form-item label="启用"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /></el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="formVisible = false">取消</el-button>
            <el-button type="primary" @click="save">保存</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <el-tab-pane label="短信配置" name="sms">
        <el-card shadow="never">
          <template #header>短信平台配置</template>
          <el-form :model="smsConfig" label-width="160px" v-loading="smsLoading">
            <el-form-item label="短信平台">
              <el-select v-model="smsConfig.sms_provider" style="width:200px">
                <el-option value="aliyun" label="阿里云" />
                <el-option value="tencent" label="腾讯云" />
                <el-option value="" label="未启用" />
              </el-select>
            </el-form-item>
            <el-form-item label="AccessKeyId"><el-input v-model="smsConfig.sms_access_key" placeholder="短信 API Key" /></el-form-item>
            <el-form-item label="AccessKeySecret"><el-input v-model="smsConfig.sms_secret_key" placeholder="短信 API Secret" show-password /></el-form-item>
            <el-form-item label="签名名称"><el-input v-model="smsConfig.sms_sign_name" placeholder="如: CinaShop" /></el-form-item>
            <el-form-item label="验证码模板ID"><el-input v-model="smsConfig.sms_template_code" placeholder="短信模板 ID" /></el-form-item>
            <el-form-item><el-button type="primary" @click="saveSms">保存配置</el-button></el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from "vue";
import { ElMessage } from "element-plus";
import request, { getData } from "@/utils/request";

const activeTab = ref("template");
const list = ref<any[]>([]);
const loading = ref(false);
const formVisible = ref(false);
const form = reactive({ id: 0, title: "", content: "", type: "wechat", status: 1 });
const smsConfig = reactive<Record<string, string>>({});
const smsLoading = ref(false);

async function load() {
  loading.value = true;
  try { list.value = await getData(request.get("/notification/list")); } catch { list.value = []; } finally { loading.value = false; }
}

function openForm(row?: any) {
  if (row) { form.id = row.id; form.title = row.title; form.content = row.content || ""; form.type = row.type || "wechat"; form.status = row.status; }
  else { form.id = 0; form.title = ""; form.content = ""; form.type = "wechat"; form.status = 1; }
  formVisible.value = true;
}

async function save() {
  if (!form.title) return ElMessage.error("请输入标题");
  try {
    await getData(request.post("/notification/save", { id: form.id || undefined, title: form.title, content: form.content, type: form.type, status: form.status }));
    ElMessage.success("保存成功"); formVisible.value = false; load();
  } catch (e) { ElMessage.error((e as Error).message); }
}

async function loadSms() {
  smsLoading.value = true;
  try { const r = await getData(request.get("/sms/config")); Object.assign(smsConfig, r || {}); } catch { /* ignore */ } finally { smsLoading.value = false; }
}

async function saveSms() {
  try { await getData(request.post("/sms/config", smsConfig)); ElMessage.success("保存成功"); } catch (e) { ElMessage.error((e as Error).message); }
}

watch(activeTab, (v) => { if (v === "sms" && !Object.keys(smsConfig).length) loadSms(); });
onMounted(load);
</script>
