<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { getProfile, updatePassword, updateProfile } from "@/api/supplier";
import { useAuthStore } from "@/stores/auth";
import type { SupplierProfile } from "@/types";

const router = useRouter();
const auth = useAuthStore();
const loading = ref(true);
const saving = ref(false);
const changingPassword = ref(false);
const formRef = ref<FormInstance>();
const passwordFormRef = ref<FormInstance>();
const form = ref<SupplierProfile | null>(null);
const passwordForm = ref({ pwd: "", new_pwd: "", conf_pwd: "" });
const rules: FormRules = {
  supplier_name: [{ required: true, message: "请输入供应商名称", trigger: "blur" }],
  name: [{ required: true, message: "请输入联系人", trigger: "blur" }],
  account: [{ required: true, message: "请输入登录账号", trigger: "blur" }],
  email: [{ type: "email", message: "邮箱格式错误", trigger: "blur" }],
};
const passwordRules: FormRules = {
  pwd: [{ required: true, message: "请输入原密码", trigger: "blur" }],
  new_pwd: [
    { required: true, message: "请输入新密码", trigger: "blur" },
    { min: 12, max: 72, message: "新密码需要 12 至 72 位", trigger: "blur" },
  ],
  conf_pwd: [
    { required: true, message: "请确认新密码", trigger: "blur" },
    {
      validator: (_rule, value, callback) => {
        if (value !== passwordForm.value.new_pwd) callback(new Error("两次输入的密码不一致"));
        else callback();
      },
      trigger: "blur",
    },
  ],
};

async function load() {
  loading.value = true;
  try {
    form.value = await getProfile();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "资料加载失败");
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.value) return;
  await formRef.value?.validate();
  saving.value = true;
  try {
    await updateProfile(form.value);
    ElMessage.success("供应商资料已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function changePassword() {
  await passwordFormRef.value?.validate();
  changingPassword.value = true;
  try {
    await updatePassword(passwordForm.value);
    ElMessage.success("密码修改成功，请使用新密码重新登录");
    await auth.signOut();
    await router.replace("/login");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "密码修改失败");
  } finally {
    changingPassword.value = false;
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
        <div class="form-section"><h2>登录账号</h2><div class="form-grid">
          <el-form-item label="登录账号" prop="account"><el-input v-model="form.account" autocomplete="username" /></el-form-item>
        </div></div>
        <div class="form-actions"><el-button type="primary" :loading="saving" @click="save">保存资料</el-button></div>
      </el-form>
    </div>
    <div class="surface profile-surface">
      <el-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules" label-position="top">
        <div class="form-section"><h2>修改登录密码</h2><div class="form-grid">
          <el-form-item label="原密码" prop="pwd"><el-input v-model="passwordForm.pwd" type="password" show-password autocomplete="current-password" /></el-form-item>
          <div />
          <el-form-item label="新密码" prop="new_pwd"><el-input v-model="passwordForm.new_pwd" type="password" show-password autocomplete="new-password" placeholder="至少 12 位" /></el-form-item>
          <el-form-item label="确认新密码" prop="conf_pwd"><el-input v-model="passwordForm.conf_pwd" type="password" show-password autocomplete="new-password" /></el-form-item>
        </div></div>
        <div class="form-actions"><el-button type="primary" :loading="changingPassword" @click="changePassword">修改密码并重新登录</el-button></div>
      </el-form>
    </div>
  </section>
</template>
