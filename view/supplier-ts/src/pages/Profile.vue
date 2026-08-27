<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { getProfile, updateProfile } from "@/api/supplier";
import type { SupplierProfile } from "@/types";

const loading = ref(true);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = ref<SupplierProfile | null>(null);
const rules: FormRules = {
  supplier_name: [{ required: true, message: "请输入供应商名称", trigger: "blur" }],
  name: [{ required: true, message: "请输入联系人", trigger: "blur" }],
  account: [{ required: true, message: "请输入登录账号", trigger: "blur" }],
  email: [{ type: "email", message: "邮箱格式错误", trigger: "blur" }],
  conf_pwd: [
    {
      validator: (_rule, value, callback) => {
        if (form.value?.pwd && value !== form.value.pwd) callback(new Error("两次输入的密码不一致"));
        else callback();
      },
      trigger: "blur",
    },
  ],
};

async function load() {
  loading.value = true;
  try {
    form.value = { ...(await getProfile()), conf_pwd: "" };
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "资料加载失败");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.value) return;
  await formRef.value?.validate();
  if (form.value.pwd && form.value.pwd.length < 12) {
    ElMessage.warning("新密码至少需要 12 位");
    return;
  }
  saving.value = true;
  try {
    await updateProfile(form.value);
    form.value.pwd = "";
    form.value.conf_pwd = "";
    ElMessage.success("供应商资料已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-section">
    <header class="page-heading"><div><h1>供应商资料</h1><p>维护主体、联系人和登录账号</p></div></header>
    <div v-loading="loading" class="surface profile-surface">
      <el-form v-if="form" ref="formRef" :model="form" :rules="rules" label-position="top">
        <div class="form-section"><h2>主体信息</h2><div class="form-grid">
          <el-form-item label="供应商名称" prop="supplier_name"><el-input v-model="form.supplier_name" /></el-form-item>
          <el-form-item label="联系人" prop="name"><el-input v-model="form.name" /></el-form-item>
          <el-form-item label="联系电话" prop="phone"><el-input v-model="form.phone" /></el-form-item>
          <el-form-item label="电子邮箱" prop="email"><el-input v-model="form.email" /></el-form-item>
          <el-form-item class="wide" label="所在地区"><el-input v-model="form.address" /></el-form-item>
          <el-form-item class="wide" label="详细地址"><el-input v-model="form.detailed_address" /></el-form-item>
        </div></div>
        <div class="form-section"><h2>登录安全</h2><div class="form-grid">
          <el-form-item label="登录账号" prop="account"><el-input v-model="form.account" autocomplete="username" /></el-form-item>
          <div />
          <el-form-item label="新密码"><el-input v-model="form.pwd" type="password" show-password autocomplete="new-password" placeholder="不修改请留空，至少 12 位" /></el-form-item>
          <el-form-item label="确认新密码" prop="conf_pwd"><el-input v-model="form.conf_pwd" type="password" show-password autocomplete="new-password" /></el-form-item>
        </div></div>
        <div class="form-actions"><el-button type="primary" :loading="saving" @click="save">保存资料</el-button></div>
      </el-form>
    </div>
  </section>
</template>
