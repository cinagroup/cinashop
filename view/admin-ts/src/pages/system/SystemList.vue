<template>
  <div class="system-page">
    <el-tabs v-model="activeTab">
      <el-tab-pane label="管理员" name="admin">
        <div class="page-head">
          <h3>系统管理员</h3>
          <el-button type="primary" @click="openAdminForm()">＋ 新增管理员</el-button>
        </div>
        <el-table :data="adminList" v-loading="loading" border>
          <el-table-column prop="id" label="ID" width="60" />
          <el-table-column prop="account" label="账号" width="140" />
          <el-table-column prop="realName" label="姓名" width="100" />
          <el-table-column prop="phone" label="手机号" width="130" />
          <el-table-column prop="roles" label="角色" min-width="100" />
          <el-table-column label="等级" width="80">
            <template #default="{ row }">{{ row.level === 0 ? "超级" : `L${row.level}` }}</template>
          </el-table-column>
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="row.status === 1 ? 'success' : 'danger'">
                {{ row.status === 1 ? "正常" : "禁用" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最后登录" width="160">
            <template #default="{ row }">{{ formatTime(row.lastTime) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{ row }">
              <el-button link type="primary" @click="openAdminForm(row)">编辑</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="角色权限" name="role">
        <div class="page-head">
          <h3>角色管理</h3>
          <el-button type="primary" @click="openRoleForm()">＋ 新增角色</el-button>
        </div>
        <el-table :data="roleList" border>
          <el-table-column prop="id" label="ID" width="60" />
          <el-table-column prop="roleName" label="角色名称" min-width="160" />
          <el-table-column prop="rules" label="权限规则" min-width="200" show-overflow-tooltip />
          <el-table-column prop="level" label="等级" width="80" />
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="row.status === 1 ? 'success' : 'danger'">
                {{ row.status === 1 ? "正常" : "禁用" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140">
            <template #default="{ row }">
              <el-button link type="primary" @click="openRoleForm(row)">编辑</el-button>
              <el-button link type="danger" @click="delRole(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 管理员弹窗 -->
    <el-dialog v-model="adminDialog.show" :title="adminDialog.id ? '编辑管理员' : '新增管理员'" width="480px">
      <el-form label-width="80px">
        <el-form-item label="账号">
          <el-input v-model="adminDialog.account" :disabled="!!adminDialog.id" placeholder="登录账号" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="adminDialog.real_name" placeholder="真实姓名" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="adminDialog.phone" placeholder="手机号" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="adminDialog.pwd" type="password" show-password :placeholder="adminDialog.id ? '不修改留空' : '默认 123456'" />
        </el-form-item>
        <el-form-item label="角色ID">
          <el-input v-model="adminDialog.roles" placeholder="角色ID（逗号分隔）" />
        </el-form-item>
        <el-form-item label="等级">
          <el-input-number v-model="adminDialog.level" :min="0" :max="9" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adminDialog.show = false">取消</el-button>
        <el-button type="primary" @click="saveAdmin">保存</el-button>
      </template>
    </el-dialog>

    <!-- 角色弹窗 -->
    <el-dialog v-model="roleDialog.show" :title="roleDialog.id ? '编辑角色' : '新增角色'" width="440px">
      <el-form label-width="80px">
        <el-form-item label="角色名称">
          <el-input v-model="roleDialog.role_name" placeholder="角色名称" />
        </el-form-item>
        <el-form-item label="等级">
          <el-input-number v-model="roleDialog.level" :min="0" :max="9" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDialog.show = false">取消</el-button>
        <el-button type="primary" @click="saveRole">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import dayjs from "dayjs";
import {
  apiAdminSystemAdminList,
  apiAdminSystemAdminSave,
  apiAdminSystemRoleList,
  apiAdminSystemRoleSave,
  apiAdminSystemRoleDel,
  type AdminAccount,
  type RoleItem,
} from "@/api/system";

const activeTab = ref("admin");
const loading = ref(true);
const adminList = ref<AdminAccount[]>([]);
const roleList = ref<RoleItem[]>([]);

const adminDialog = reactive({
  show: false,
  id: 0,
  account: "",
  real_name: "",
  phone: "",
  pwd: "",
  roles: "",
  level: 0,
});

const roleDialog = reactive({
  show: false,
  id: 0,
  role_name: "",
  level: 0,
});

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "—";
}

async function loadAdmin() {
  loading.value = true;
  try {
    adminList.value = await apiAdminSystemAdminList();
  } finally {
    loading.value = false;
  }
}

async function loadRoles() {
  try {
    roleList.value = await apiAdminSystemRoleList();
  } catch {
    roleList.value = [];
  }
}

function openAdminForm(row?: AdminAccount) {
  if (row) {
    adminDialog.id = row.id;
    adminDialog.account = row.account;
    adminDialog.real_name = row.realName;
    adminDialog.phone = row.phone;
    adminDialog.roles = row.roles;
    adminDialog.level = row.level;
  } else {
    adminDialog.id = 0;
    adminDialog.account = "";
    adminDialog.real_name = "";
    adminDialog.phone = "";
    adminDialog.roles = "";
    adminDialog.level = 0;
  }
  adminDialog.pwd = "";
  adminDialog.show = true;
}

async function saveAdmin() {
  try {
    await apiAdminSystemAdminSave({
      id: adminDialog.id || undefined,
      account: adminDialog.account,
      real_name: adminDialog.real_name,
      phone: adminDialog.phone,
      pwd: adminDialog.pwd || undefined,
      roles: adminDialog.roles,
      level: adminDialog.level,
    });
    ElMessage.success(adminDialog.id ? "更新成功" : "创建成功");
    adminDialog.show = false;
    loadAdmin();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

function openRoleForm(row?: RoleItem) {
  if (row) {
    roleDialog.id = row.id;
    roleDialog.role_name = row.roleName;
    roleDialog.level = row.level;
  } else {
    roleDialog.id = 0;
    roleDialog.role_name = "";
    roleDialog.level = 0;
  }
  roleDialog.show = true;
}

async function saveRole() {
  if (!roleDialog.role_name) return ElMessage.warning("请输入角色名称");
  try {
    await apiAdminSystemRoleSave({
      id: roleDialog.id || undefined,
      role_name: roleDialog.role_name,
      level: roleDialog.level,
    });
    ElMessage.success(roleDialog.id ? "更新成功" : "创建成功");
    roleDialog.show = false;
    loadRoles();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  }
}

async function delRole(row: RoleItem) {
  try {
    await ElMessageBox.confirm(`确认删除角色「${row.roleName}」?`, "确认");
    await apiAdminSystemRoleDel(row.id);
    ElMessage.success("已删除");
    loadRoles();
  } catch {
    // cancel
  }
}

onMounted(() => {
  loadAdmin();
  loadRoles();
});
</script>

<style scoped>
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.page-head h3 {
  font-size: 16px;
  margin: 0;
}
</style>
