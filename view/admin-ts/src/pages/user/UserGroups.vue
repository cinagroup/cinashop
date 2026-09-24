<template>
  <div class="user-groups">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div>
            <strong>商城用户分组</strong>
            <p class="sub">维护商城会员分组；已关联用户的分组不能删除。</p>
          </div>
          <el-button v-if="canManage" type="primary" @click="openCreate">新增分组</el-button>
        </div>
      </template>

      <el-alert v-if="!canView" title="当前账号没有用户查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <el-alert v-if="!canManage" title="当前账号仅有查看权限；如需维护分组，请联系管理员开通用户管理权限。" type="info" :closable="false" show-icon class="notice" />
        <div class="filters">
          <el-input v-model="searchDraft" aria-label="分组名称" placeholder="搜索分组名称" clearable maxlength="64" @keyup.enter="search" />
          <el-button type="primary" :loading="loading" @click="search">查询</el-button>
          <el-button :disabled="loading" @click="resetSearch">重置</el-button>
          <el-button :disabled="loading" @click="load(page)">刷新</el-button>
        </div>

        <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="load(page)">重试</el-button></template>
        </el-alert>
        <div class="table-scroll">
          <el-table :data="list" v-loading="loading" stripe row-key="id" empty-text="暂无用户分组">
            <el-table-column prop="id" label="ID" width="100" />
            <el-table-column prop="group_name" label="分组名称" min-width="220" />
            <el-table-column v-if="canManage" label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" :disabled="saving || deletingId !== null" @click="openEdit(row)">编辑</el-button>
                <el-button link type="danger" :disabled="saving || deletingId !== null" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination
          :current-page="page"
          :page-size="PAGE_SIZE"
          :total="count"
          :disabled="loading"
          layout="total, prev, pager, next"
          class="pager"
          @current-change="load"
        />
      </template>
    </el-card>

    <el-dialog
      v-model="dialogOpen"
      :title="editingId ? '编辑分组' : '新增分组'"
      width="min(440px, 94vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="分组名称" required>
          <el-input v-model="formName" aria-label="编辑分组名称" maxlength="64" show-word-limit autofocus @keyup.enter="save" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canManage" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import {
  apiAdminDeleteUserGroup,
  apiAdminSaveUserGroup,
  apiAdminUserGroups,
  normalizedUserGroupName,
  type UserGroup,
} from "@/api/userGroups";

const PAGE_SIZE = 10;
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("user.view") || auth.uniqueAuth.includes("user.manage")));
const canManage = computed(() => canView.value &&
  (auth.userInfo?.level === 0 || auth.uniqueAuth.includes("user.manage")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.uniqueAuth.join(",")}`);

const list = ref<UserGroup[]>([]);
const count = ref(0);
const page = ref(1);
const loading = ref(false);
const loadError = ref("");
const searchDraft = ref("");
const keyword = ref("");
const dialogOpen = ref(false);
const editingId = ref(0);
const formName = ref("");
const saving = ref(false);
const deletingId = ref<number | null>(null);
let mounted = false;
let generation = 0;
let pending: AbortController | null = null;

function active(stamp: string): boolean {
  return mounted && canView.value && sessionKey.value === stamp && auth.token === getToken();
}

function discardList() {
  generation++;
  pending?.abort();
  pending = null;
  list.value = [];
  count.value = 0;
  loading.value = false;
  loadError.value = "";
}

async function load(targetPage = page.value): Promise<boolean> {
  if (!mounted || !canView.value) return false;
  const stamp = sessionKey.value;
  const current = ++generation;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  loading.value = true;
  loadError.value = "";
  list.value = [];
  try {
    const result = await apiAdminUserGroups({
      page: targetPage,
      limit: PAGE_SIZE,
      group_name: keyword.value || undefined,
    }, controller.signal);
    if (!active(stamp) || current !== generation) return false;
    if (result.page !== targetPage || result.limit !== PAGE_SIZE) throw new Error("分组分页结果与请求不一致");
    list.value = result.list;
    count.value = result.count;
    page.value = targetPage;
    return true;
  } catch (error) {
    if (active(stamp) && current === generation && !controller.signal.aborted) {
      loadError.value = error instanceof Error ? error.message : "加载用户分组失败";
    }
    return false;
  } finally {
    if (current === generation) {
      pending = null;
      loading.value = false;
    }
  }
}

function search() {
  keyword.value = searchDraft.value.trim();
  void load(1);
}

function resetSearch() {
  searchDraft.value = "";
  keyword.value = "";
  void load(1);
}

function openCreate() {
  if (!canManage.value || saving.value || deletingId.value !== null) return;
  editingId.value = 0;
  formName.value = "";
  dialogOpen.value = true;
}

function openEdit(row: UserGroup) {
  if (!canManage.value || saving.value || deletingId.value !== null ||
    !list.value.some((item) => item.id === row.id && item.group_name === row.group_name)) return;
  editingId.value = row.id;
  formName.value = row.group_name;
  dialogOpen.value = true;
}

async function save() {
  if (!canManage.value || !dialogOpen.value || saving.value) return;
  let name: string;
  try {
    name = normalizedUserGroupName(formName.value);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "分组名称无效");
    return;
  }
  const stamp = sessionKey.value;
  const id = editingId.value;
  saving.value = true;
  try {
    const result = await apiAdminSaveUserGroup({ id, group_name: name });
    if (!active(stamp)) return;
    if (id && result.id !== id) throw new Error("分组保存结果与编辑目标不一致，请刷新列表核对");
    dialogOpen.value = false;
    if (!id) {
      keyword.value = "";
      searchDraft.value = "";
    }
    if (await load(id ? page.value : 1)) ElMessage.success("分组已保存");
    else ElMessage.warning("分组已提交，列表刷新失败，请手动刷新核对");
  } catch (error) {
    if (active(stamp)) ElMessage.error(error instanceof Error ? error.message : "保存用户分组失败");
  } finally {
    saving.value = false;
  }
}

async function remove(row: UserGroup) {
  if (!canManage.value || deletingId.value !== null || saving.value ||
    !list.value.some((item) => item.id === row.id && item.group_name === row.group_name)) return;
  const stamp = sessionKey.value;
  try {
    await ElMessageBox.confirm(`确认删除用户分组「${row.group_name}」？`, "删除确认", { type: "warning" });
  } catch {
    return;
  }
  if (!active(stamp) || !canManage.value || deletingId.value !== null ||
    !list.value.some((item) => item.id === row.id && item.group_name === row.group_name)) return;
  deletingId.value = row.id;
  try {
    await apiAdminDeleteUserGroup(row.id);
    if (!active(stamp)) return;
    const targetPage = list.value.length === 1 && page.value > 1 ? page.value - 1 : page.value;
    if (await load(targetPage)) ElMessage.success("分组已删除");
    else ElMessage.warning("分组已删除，列表刷新失败，请手动刷新核对");
  } catch (error) {
    if (!active(stamp)) return;
    const message = error instanceof Error ? error.message : "删除用户分组失败";
    if (message.includes("该分组仍有用户")) ElMessage.warning("该分组仍有用户，不能删除。请先调整关联用户的分组。");
    else ElMessage.error(message);
  } finally {
    deletingId.value = null;
  }
}

function syncSession() {
  const session = getAdminSession();
  auth.$patch({
    token: getToken() ?? "",
    userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [],
    uniqueAuth: session?.uniqueAuth ?? [],
  });
}

watch(sessionKey, () => {
  discardList();
  dialogOpen.value = false;
  if (mounted && canView.value) void load(1);
});
onMounted(() => {
  mounted = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const previousSession = sessionKey.value;
  syncSession();
  if (previousSession === sessionKey.value && canView.value) void load(1);
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  discardList();
});
</script>

<style scoped>
.user-groups { min-width: 0; }
.card-header, .filters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.card-header { justify-content: space-between; }
.sub { margin: 4px 0 0; color: #737985; font-size: 12px; }
.filters { margin-bottom: 16px; }
.filters :deep(.el-input) { width: min(280px, 100%); }
.notice { margin-bottom: 16px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.pager { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 600px) {
  .filters :deep(.el-input) { width: 100%; }
  .pager { justify-content: center; }
}
</style>
