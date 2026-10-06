<template>
  <div class="supplier-menu-rules">
    <el-card shadow="never">
      <template #header>
        <div class="heading">
          <div>
            <strong>供应商菜单规则</strong>
            <p>清点旧系统的 type=4 菜单与接口规则，以及它们对数字角色规则的影响。</p>
          </div>
          <el-button v-if="canView" :loading="loading || catalogLoading" @click="refresh">刷新</el-button>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有供应商菜单规则查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <el-alert class="notice" type="info" :closable="false" show-icon
          title="遗留菜单与实际导航是两套配置">
          <p>下方树来自旧 system_menus 的 type=4 行。接口规则的数字 ID 仍可被供应商角色引用并映射为稳定权限。</p>
          <p>供应商当前看到的导航由固定权限目录生成；修改旧行的名称、排序、页面路径或显示状态不会改变该导航。</p>
        </el-alert>
        <el-alert class="notice" type="warning" :closable="false" show-icon
          :title="catalog?.write_ready
            ? '受控写入能力已安装；当前页面仍只读，新增、编辑、显隐及删除尚未开放。'
            : catalog
              ? '此环境未启用受控规则写入；当前页面只读，新增、编辑、显隐及删除均未开放。'
              : '规则写入状态尚未确认；当前页面只读，新增、编辑、显隐及删除均未开放。'" />
        <div class="filters">
          <el-input v-model="draftKeyword" aria-label="供应商规则关键词" maxlength="80" clearable
            placeholder="名称、路径、标识、接口或 ID" :disabled="loading" @keyup.enter="search" />
          <el-select v-model="draftVisibility" aria-label="供应商规则显示筛选" :disabled="loading">
            <el-option label="全部（含隐藏）" value="all" />
            <el-option label="显示" value="shown" />
            <el-option label="隐藏" value="hidden" />
          </el-select>
          <el-button type="primary" :disabled="loading" @click="search">查询</el-button>
          <el-button :disabled="loading" @click="resetFilters">重置</el-button>
        </div>
        <el-alert v-if="error" class="notice" :title="error" type="error" :closable="false" show-icon />
        <p class="count">规则节点：{{ total }}。隐藏节点仍可通过“隐藏”筛选核对；角色引用为原始数字引用，包含停用或尚未分配给子账号的角色。</p>
        <div class="table-scroll">
          <el-table :data="rules" v-loading="loading" row-key="id"
            :tree-props="{ children: 'children' }" default-expand-all stripe empty-text="暂无供应商规则">
            <el-table-column prop="id" label="ID" width="78" />
            <el-table-column prop="menu_name" label="规则名称" min-width="180" show-overflow-tooltip />
            <el-table-column label="类别" width="85">
              <template #default="{ row }">{{ row.auth_type === 2 ? '接口' : row.auth_type === 1 ? '菜单' : '其它旧类型' }}</template>
            </el-table-column>
            <el-table-column label="接口方法与路径" min-width="210" show-overflow-tooltip>
              <template #default="{ row }">{{ row.auth_type === 2 ? `${row.methods || 'GET'} ${row.api_url}` : '—' }}</template>
            </el-table-column>
            <el-table-column prop="menu_path" label="旧页面路径" min-width="170" show-overflow-tooltip />
            <el-table-column prop="unique_auth" label="旧权限标识" min-width="165" show-overflow-tooltip />
            <el-table-column label="显示" width="85">
              <template #default="{ row }"><el-tag :type="row.is_show === 1 ? 'success' : 'info'">
                {{ row.is_show === 1 ? '显示' : '隐藏' }}</el-tag></template>
            </el-table-column>
            <el-table-column label="原始角色引用" width="120" align="center">
              <template #default="{ row }">{{ row.role_reference_count }}</template>
            </el-table-column>
            <el-table-column label="可映射权限" min-width="165" show-overflow-tooltip>
              <template #default="{ row }">{{ row.effective_permissions.join(', ') || '无' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }"><el-button link type="primary" :disabled="loading" @click="openDetail(row)">详情</el-button></template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </el-card>

    <el-card v-if="canView" shadow="never" class="catalog-card">
      <template #header>
        <div class="heading"><div><strong>固定 Supplier 导航目录（按角色权限裁剪）</strong>
          <p>下列路由是全部可能显示的固定导航；实际登录账号只看到其稳定权限允许的项目，并非上表旧菜单行的动态渲染结果。</p></div></div>
      </template>
      <el-alert v-if="catalogError" class="notice" :title="catalogError" type="error" :closable="false" show-icon />
      <el-table :data="catalog?.navigation ?? []" v-loading="catalogLoading" stripe empty-text="暂无导航">
        <el-table-column prop="name" label="导航名称" min-width="160" />
        <el-table-column prop="path" label="Supplier 页面路由" min-width="190" />
        <el-table-column prop="permission" label="显示所需权限" min-width="190" />
      </el-table>
      <el-collapse class="permission-catalog">
        <el-collapse-item title="查看稳定 Supplier 权限目录（不是旧 ruleList(4)）" name="permissions">
          <el-table :data="catalog?.permissions ?? []" stripe size="small" empty-text="暂无稳定权限">
            <el-table-column prop="label" label="权限说明" min-width="130" />
            <el-table-column prop="key" label="稳定权限组" min-width="195" />
            <el-table-column label="管理能力" width="105">
              <template #default="{ row }">{{ row.manage ? '支持管理' : '仅查看' }}</template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <el-dialog v-model="detailVisible" title="供应商规则详情" width="min(700px, calc(100vw - 24px))" @closed="closeDetail">
      <div v-loading="detailLoading">
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon />
        <el-descriptions v-if="detail" :column="1" border class="detail">
          <el-descriptions-item label="规则 ID">{{ detail.id }}</el-descriptions-item>
          <el-descriptions-item label="类型">供应商 type=4 · {{ detail.auth_type === 2 ? '接口' : detail.auth_type === 1 ? '菜单' : '其它旧类型' }}</el-descriptions-item>
          <el-descriptions-item label="父级 ID">{{ detail.pid }}</el-descriptions-item>
          <el-descriptions-item label="名称">{{ detail.menu_name }}</el-descriptions-item>
          <el-descriptions-item label="旧权限标识">{{ detail.unique_auth || '—' }}</el-descriptions-item>
          <el-descriptions-item label="旧页面路径">{{ detail.menu_path || '—' }}</el-descriptions-item>
          <el-descriptions-item label="接口方法与路径">{{ detail.auth_type === 2 ? `${detail.methods || 'GET'} ${detail.api_url}` : '—' }}</el-descriptions-item>
          <el-descriptions-item label="显示状态">{{ detail.is_show ? '显示' : '隐藏' }}</el-descriptions-item>
          <el-descriptions-item label="接口启用">{{ detail.access ? '启用' : '停用' }}</el-descriptions-item>
          <el-descriptions-item label="原始角色引用数">{{ detail.role_reference_count }}</el-descriptions-item>
          <el-descriptions-item label="原始引用角色 ID">{{ detail.role_reference_ids.join(', ') || '无' }}</el-descriptions-item>
          <el-descriptions-item label="映射的稳定权限">{{ detail.effective_permissions.join(', ') || '无' }}</el-descriptions-item>
        </el-descriptions>
        <p class="detail-note">原始数字引用包含停用或未分配的角色，不等于供应商子账号已获得接口访问权限。实际授权由服务端按启用角色和供应商账号重新计算；此处不会修改角色规则。</p>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { apiSupplierMenuRuleCatalog, apiSupplierMenuRuleDetail, apiSupplierMenuRules,
  type SupplierMenuRule, type SupplierMenuRuleCatalog, type SupplierMenuRuleFilter } from "@/api/supplierMenuRules";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";

const auth = useAuthStore();
const stored = ref(localStorage.getItem("admin_session"));
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && !!session &&
    stored.value === localStorage.getItem("admin_session") &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes("supplier_menu_rules.view") &&
      session.uniqueAuth.includes("supplier_menu_rules.view")));
});

const rules = ref<SupplierMenuRule[]>([]), total = ref(0), catalog = ref<SupplierMenuRuleCatalog | null>(null);
const draftKeyword = ref(""), keyword = ref(""), draftVisibility = ref<"all" | "shown" | "hidden">("all");
const visibility = ref<"all" | "shown" | "hidden">("all");
const loading = ref(false), error = ref(""), catalogLoading = ref(false), catalogError = ref("");
const detailVisible = ref(false), detailLoading = ref(false), detailError = ref("");
const detail = ref<SupplierMenuRule | null>(null);
let alive = false, syncing = false, generation = 0, listVersion = 0, catalogVersion = 0, detailVersion = 0;
let listAbort: AbortController | null = null, catalogAbort: AbortController | null = null;
let detailAbort: AbortController | null = null;
type Scope = { identity: string; stored: string | null; generation: number };
function scope(): Scope { return { identity: identity.value, stored: stored.value, generation }; }
function current(value: Scope): boolean {
  return alive && canView.value && identity.value === value.identity && stored.value === value.stored &&
    value.stored === localStorage.getItem("admin_session") && generation === value.generation;
}
const message = (failure: unknown) => failure instanceof Error ? failure.message : "供应商菜单规则加载失败";
function invalidate(): void {
  generation++; listVersion++; catalogVersion++; detailVersion++;
  listAbort?.abort(); catalogAbort?.abort(); detailAbort?.abort();
  listAbort = catalogAbort = detailAbort = null;
  rules.value = []; total.value = 0; catalog.value = null; detail.value = null;
  loading.value = catalogLoading.value = detailLoading.value = false;
  error.value = catalogError.value = detailError.value = ""; detailVisible.value = false;
}
function filter(): SupplierMenuRuleFilter {
  return { keyword: keyword.value, ...(visibility.value === "all" ? {} :
    { is_show: visibility.value === "shown" ? 1 as const : 0 as const }) };
}
async function load(): Promise<void> {
  if (!canView.value) return;
  listAbort?.abort(); const controller = new AbortController(); listAbort = controller;
  const value = scope(), version = ++listVersion; loading.value = true; error.value = "";
  rules.value = []; total.value = 0;
  try {
    const page = await apiSupplierMenuRules(filter(), controller.signal);
    if (current(value) && listVersion === version && listAbort === controller) {
      rules.value = page.list; total.value = page.count;
    }
  } catch (failure) {
    if (current(value) && listVersion === version && !controller.signal.aborted) error.value = message(failure);
  } finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
async function loadCatalog(): Promise<void> {
  if (!canView.value) return;
  catalogAbort?.abort(); const controller = new AbortController(); catalogAbort = controller;
  const value = scope(), version = ++catalogVersion; catalogLoading.value = true; catalogError.value = "";
  catalog.value = null;
  try {
    const next = await apiSupplierMenuRuleCatalog(controller.signal);
    if (current(value) && catalogVersion === version && catalogAbort === controller) catalog.value = next;
  } catch (failure) {
    if (current(value) && catalogVersion === version && !controller.signal.aborted) catalogError.value = message(failure);
  } finally { if (catalogAbort === controller) { catalogAbort = null; catalogLoading.value = false; } }
}
function refresh(): void { void load(); void loadCatalog(); }
function search(): void {
  if (!canView.value || loading.value) return;
  keyword.value = draftKeyword.value.trim(); visibility.value = draftVisibility.value;
  closeDetail(); void load();
}
function resetFilters(): void { draftKeyword.value = ""; draftVisibility.value = "all"; search(); }
async function openDetail(row: SupplierMenuRule): Promise<void> {
  if (!canView.value || loading.value) return;
  detailAbort?.abort(); const controller = new AbortController(); detailAbort = controller;
  const value = scope(), version = ++detailVersion;
  detail.value = null; detailError.value = ""; detailLoading.value = true; detailVisible.value = true;
  try {
    const next = await apiSupplierMenuRuleDetail(row.id, controller.signal);
    if (current(value) && detailVersion === version && detailAbort === controller && detailVisible.value) detail.value = next;
  } catch (failure) {
    if (current(value) && detailVersion === version && !controller.signal.aborted) detailError.value = message(failure);
  } finally { if (detailAbort === controller) { detailAbort = null; detailLoading.value = false; } }
}
function closeDetail(): void {
  detailVersion++; detailAbort?.abort(); detailAbort = null; detailLoading.value = false;
  detail.value = null; detailError.value = ""; detailVisible.value = false;
}
function syncSession(): void {
  syncing = true; invalidate();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  syncing = false; if (canView.value) refresh();
}
function syncStorage(event: StorageEvent): void {
  if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession();
}
watch(identity, () => { if (alive && !syncing) { invalidate(); if (canView.value) refresh(); } }, { flush: "sync" });
onMounted(() => {
  alive = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", syncStorage);
  syncSession();
});
onBeforeUnmount(() => {
  alive = false; invalidate();
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", syncStorage);
});
</script>

<style scoped>
.supplier-menu-rules { min-width: 0; display: grid; gap: 16px; }
.heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; flex-wrap: wrap; }
.heading p { margin: 5px 0 0; color: #7a8391; font-size: 12px; line-height: 1.6; }
.notice { margin: 12px 0; }.notice p { margin: 3px 0; line-height: 1.55; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 8px; }
.filters :deep(.el-input) { flex: 1 1 230px; max-width: 390px; }
.filters :deep(.el-select) { width: 175px; }
.count, .detail-note { color: #7a8391; font-size: 12px; line-height: 1.6; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.permission-catalog { margin-top: 18px; }
.detail { margin-top: 14px; }.detail :deep(.el-descriptions__content) { overflow-wrap: anywhere; }
@media (max-width: 640px) { .filters :deep(.el-input), .filters :deep(.el-select) { max-width: none; width: 100%; } }
</style>
