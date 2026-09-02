<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from "element-plus";
import {
  deleteSupplierAdministrator,
  deleteSupplierRole,
  getSupplierAdministratorForm,
  getSupplierAdministrators,
  getSupplierRoles,
  saveSupplierAdministrator,
  saveSupplierRole,
  setSupplierAdministratorStatus,
} from "@/api/supplier";
import { useAuthStore } from "@/stores/auth";
import type {
  SupplierAdministrator,
  SupplierAdminPayload,
  SupplierPermissionTreeNode,
  SupplierRole,
  SupplierRoleOption,
  SupplierRolePayload,
} from "@/types";

const auth = useAuthStore();
const canManage = computed(() => auth.can("supplier.admin.manage"));
const loading = ref(false);
const saving = ref(false);
const rows = ref<SupplierAdministrator[]>([]);
const total = ref(0);
const page = ref(1);
const dialogOpen = ref(false);
const editingId = ref(0);
const roles = ref<SupplierRoleOption[]>([]);
const formRef = ref<FormInstance>();
const roleListOpen = ref(false);
const roleDialogOpen = ref(false);
const roleSaving = ref(false);
const roleEditingId = ref(0);
const roleRows = ref<SupplierRole[]>([]);
const permissionTree = ref<SupplierPermissionTreeNode[]>([]);
const roleFormRef = ref<FormInstance>();

const emptyForm = (): SupplierAdminPayload => ({
  account: "",
  real_name: "",
  phone: "",
  head_pic: "",
  roles: [],
  status: 1,
  pwd: "",
  conf_pwd: "",
});
const form = reactive<SupplierAdminPayload>(emptyForm());
const emptyRoleForm = (): SupplierRolePayload => ({ role_name: "", rules: [], status: 1 });
const roleForm = reactive<SupplierRolePayload>(emptyRoleForm());

const rules: FormRules<SupplierAdminPayload> = {
  account: [
    { required: true, message: "请输入管理员账号", trigger: "blur" },
    { min: 3, max: 32, message: "账号长度应为 3-32 个字符", trigger: "blur" },
  ],
  real_name: [{ required: true, message: "请输入管理员姓名", trigger: "blur" }],
  phone: [{ required: true, message: "请输入管理员电话", trigger: "blur" }],
  roles: [{ required: true, type: "array", min: 1, message: "请选择至少一个角色", trigger: "change" }],
};

const roleRules: FormRules<SupplierRolePayload> = {
  role_name: [
    { required: true, message: "请输入角色名称", trigger: "blur" },
    { max: 32, message: "角色名称不能超过 32 个字符", trigger: "blur" },
  ],
  rules: [{ required: true, type: "array", min: 1, message: "请至少选择一项权限", trigger: "change" }],
};

async function load() {
  loading.value = true;
  try {
    const result = await getSupplierAdministrators({ page: page.value, limit: 20 });
    rows.value = result.list;
    total.value = result.count;
  } finally {
    loading.value = false;
  }
}

async function openForm(row?: SupplierAdministrator) {
  if (!canManage.value) return;
  const definition = await getSupplierAdministratorForm(row?.id);
  roles.value = definition.role_options;
  editingId.value = definition.info?.id ?? 0;
  Object.assign(form, emptyForm(), definition.info ? {
    account: definition.info.account,
    real_name: definition.info.real_name,
    phone: definition.info.phone,
    head_pic: definition.info.head_pic,
    roles: [...definition.info.roles],
    status: definition.info.status as 0 | 1,
  } : {});
  formRef.value?.clearValidate();
  dialogOpen.value = true;
}

async function submit() {
  await formRef.value?.validate();
  if (!editingId.value && form.pwd.length < 12) {
    ElMessage.warning("新管理员密码至少需要 12 位");
    return;
  }
  if (form.pwd !== form.conf_pwd) {
    ElMessage.warning("两次输入的密码不一致");
    return;
  }
  saving.value = true;
  try {
    await saveSupplierAdministrator(editingId.value, { ...form, roles: [...form.roles] });
    ElMessage.success(editingId.value ? "管理员已更新" : "管理员已添加");
    dialogOpen.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

async function changeStatus(row: SupplierAdministrator) {
  const next = row.status as 0 | 1;
  try {
    await setSupplierAdministratorStatus(row.id, next);
    ElMessage.success(next ? "账号已启用" : "账号已停用");
  } catch (error) {
    row.status = next ? 0 : 1;
    throw error;
  }
}

async function remove(row: SupplierAdministrator) {
  await ElMessageBox.confirm(
    `确认删除子账号“${row.real_name || row.account}”吗？删除后现有会话将失效。`,
    "删除管理员",
    { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" },
  );
  await deleteSupplierAdministrator(row.id);
  ElMessage.success("管理员已删除");
  if (rows.value.length === 1 && page.value > 1) page.value -= 1;
  await load();
}

async function loadRoles() {
  const result = await getSupplierRoles();
  roleRows.value = result.list;
  permissionTree.value = result.permission_tree;
  roles.value = result.list
    .filter((role) => role.status === 1)
    .map((role) => ({ value: role.id, label: role.role_name }));
}

async function openRoleManager() {
  if (!canManage.value) return;
  await loadRoles();
  roleListOpen.value = true;
}

function openRoleForm(row?: SupplierRole) {
  roleEditingId.value = row?.id ?? 0;
  Object.assign(roleForm, emptyRoleForm(), row ? {
    role_name: row.role_name,
    rules: [...row.rules],
    status: row.status as 0 | 1,
  } : {});
  roleFormRef.value?.clearValidate();
  roleDialogOpen.value = true;
}

async function submitRole() {
  await roleFormRef.value?.validate();
  roleSaving.value = true;
  try {
    await saveSupplierRole(roleEditingId.value, { ...roleForm, rules: [...roleForm.rules] });
    ElMessage.success(roleEditingId.value ? "角色已更新" : "角色已添加");
    roleDialogOpen.value = false;
    await loadRoles();
  } finally {
    roleSaving.value = false;
  }
}

async function removeRole(row: SupplierRole) {
  await ElMessageBox.confirm(
    `确认删除角色“${row.role_name}”吗？正在使用的角色不能删除。`,
    "删除角色",
    { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" },
  );
  await deleteSupplierRole(row.id);
  ElMessage.success("角色已删除");
  await loadRoles();
}

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">Access control</p>
        <h1>子账号管理</h1>
        <p>角色由平台为当前供应商配置；子账号只能获得角色明确包含的功能。</p>
      </div>
      <div v-if="canManage" class="heading-actions">
        <el-button @click="openRoleManager">角色权限</el-button>
        <el-button type="primary" @click="openForm()">添加管理员</el-button>
      </div>
    </header>

    <el-alert
      title="主管理员不能在这里被停用或删除；子账号也不能给他人授予自己没有的权限。"
      type="info"
      :closable="false"
      show-icon
    />

    <el-card shadow="never" class="table-card">
      <el-table v-loading="loading" :data="rows" empty-text="暂无子账号">
        <el-table-column label="管理员" min-width="180">
          <template #default="{ row }">
            <div class="identity">
              <el-avatar :size="36" :src="row.head_pic">{{ row.real_name?.slice(0, 1) }}</el-avatar>
              <div><strong>{{ row.real_name }}</strong><span>{{ row.account }}</span></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="电话" min-width="140" />
        <el-table-column label="角色" min-width="190">
          <template #default="{ row }">
            <div class="roles">
              <el-tag v-for="name in row.role_names" :key="name" effect="plain">{{ name }}</el-tag>
              <span v-if="!row.role_names.length" class="muted">无有效角色</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最近登录" min-width="165">
          <template #default="{ row }">{{ row._last_time || "从未登录" }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-switch
              v-model="row.status"
              :active-value="1"
              :inactive-value="0"
              :disabled="!canManage || row.id === auth.user?.id"
              @change="changeStatus(row)"
            />
          </template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="145" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openForm(row)">编辑</el-button>
            <el-button link type="danger" :disabled="row.id === auth.user?.id" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > 20"
        v-model:current-page="page"
        layout="prev, pager, next, total"
        :page-size="20"
        :total="total"
        @current-change="load"
      />
    </el-card>

    <el-dialog v-model="dialogOpen" :title="editingId ? '编辑管理员' : '添加管理员'" width="min(560px, 94vw)">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <div class="form-grid">
          <el-form-item label="账号" prop="account"><el-input v-model="form.account" maxlength="32" /></el-form-item>
          <el-form-item label="姓名" prop="real_name"><el-input v-model="form.real_name" maxlength="16" /></el-form-item>
          <el-form-item label="电话" prop="phone"><el-input v-model="form.phone" maxlength="32" /></el-form-item>
          <el-form-item label="状态"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /></el-form-item>
        </div>
        <el-form-item label="角色" prop="roles">
          <el-select v-model="form.roles" multiple filterable placeholder="请选择当前供应商角色" style="width: 100%">
            <el-option v-for="role in roles" :key="role.value" :label="role.label" :value="role.value" />
          </el-select>
        </el-form-item>
        <div class="form-grid">
          <el-form-item :label="editingId ? '新密码（留空不修改）' : '密码'">
            <el-input v-model="form.pwd" type="password" show-password maxlength="72" autocomplete="new-password" />
          </el-form-item>
          <el-form-item label="确认密码">
            <el-input v-model="form.conf_pwd" type="password" show-password maxlength="72" autocomplete="new-password" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="roleListOpen" title="供应商角色权限" width="min(760px, 96vw)">
      <div class="role-heading">
        <p>角色只在当前供应商内生效，子账号不能授予超出自身范围的权限。</p>
        <el-button type="primary" @click="openRoleForm()">添加角色</el-button>
      </div>
      <el-table :data="roleRows" empty-text="暂无角色">
        <el-table-column prop="role_name" label="角色" min-width="160" />
        <el-table-column label="权限" min-width="240">
          <template #default="{ row }">
            <span>{{ row.rules.length }} 项</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openRoleForm(row)">编辑</el-button>
            <el-button link type="danger" @click="removeRole(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="roleDialogOpen" :title="roleEditingId ? '编辑角色' : '添加角色'" width="min(680px, 96vw)" append-to-body>
      <el-form ref="roleFormRef" :model="roleForm" :rules="roleRules" label-position="top">
        <div class="form-grid">
          <el-form-item label="角色名称" prop="role_name">
            <el-input v-model="roleForm.role_name" maxlength="32" />
          </el-form-item>
          <el-form-item label="状态">
            <el-switch v-model="roleForm.status" :active-value="1" :inactive-value="0" />
          </el-form-item>
        </div>
        <el-form-item label="权限范围" prop="rules">
          <el-checkbox-group v-model="roleForm.rules" class="permission-grid">
            <article v-for="group in permissionTree" :key="group.key" class="permission-card">
              <strong>{{ group.label }}</strong>
              <div>
                <el-checkbox v-for="permission in group.children" :key="permission.key" :value="permission.key">
                  {{ permission.label }}
                </el-checkbox>
              </div>
            </article>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="roleSaving" @click="submitRole">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.admin-page { display: grid; gap: 20px; }
.page-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
.page-heading h1 { margin: 4px 0 8px; font-size: clamp(24px, 3vw, 34px); }
.page-heading p { margin: 0; color: var(--text-muted); }
.eyebrow { color: var(--brand) !important; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 12px; }
.table-card { border-radius: 18px; }
.identity { display: flex; align-items: center; gap: 10px; }
.identity strong, .identity span { display: block; }
.identity span, .muted { color: var(--text-muted); font-size: 12px; margin-top: 3px; }
.roles { display: flex; flex-wrap: wrap; gap: 6px; }
.heading-actions, .role-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.role-heading { margin-bottom: 16px; }
.role-heading p { margin: 0; color: var(--text-muted); }
.permission-grid { width: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.permission-card { padding: 12px; border: 1px solid var(--border-color); border-radius: 12px; }
.permission-card strong { display: block; margin-bottom: 8px; }
.permission-card div { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.el-pagination { justify-content: flex-end; margin-top: 18px; }
@media (max-width: 640px) {
  .page-heading { align-items: flex-start; flex-direction: column; }
  .form-grid, .permission-grid { grid-template-columns: 1fr; }
}
</style>
