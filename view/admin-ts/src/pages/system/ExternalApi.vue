<template>
  <div class="external-page">
    <header class="page-head">
      <div>
        <p class="eyebrow">THIRD-PARTY ACCESS</p>
        <h2>对外接口与授权</h2>
        <p>管理第三方 API 身份、运行时能力与脱敏访问审计。</p>
      </div>
      <el-button type="primary" @click="openAccount()">创建 API 账户</el-button>
    </header>

    <el-alert
      title="旧系统明文凭据与任意外部推送不会在 Worker 中执行"
      description="新建与轮换只保存 bcrypt 哈希，并仅显示一次新密钥。当前仅开放订单备注与退款备注两条低风险写接口；发货、收货、退款资金及用户写操作仍保持未迁移。"
      type="warning"
      show-icon
      :closable="false"
    />

    <section class="summary-grid" aria-label="对外接口概览">
      <article><span>有效账户</span><strong>{{ activeCount }}</strong><small>status = 1</small></article>
      <article><span>可用只读接口</span><strong>{{ availableReadCount }}</strong><small>目录、订单、退款与用户</small></article>
      <article><span>可用写接口</span><strong>{{ availableWriteCount }}</strong><small>事务化备注更新</small></article>
      <article><span>未迁移接口</span><strong>{{ unavailableCount }}</strong><small>不会因导入文档自动启用</small></article>
      <article class="boundary"><span>凭据策略</span><strong>Hash only</strong><small>密钥只显示一次</small></article>
    </section>

    <el-card shadow="never" class="content-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="账户与授权" name="accounts" />
        <el-tab-pane label="接口目录" name="interfaces" />
        <el-tab-pane label="访问审计" name="audit" />
      </el-tabs>

      <template v-if="activeTab === 'accounts'">
        <div class="toolbar">
          <el-input v-model="filters.name" clearable placeholder="搜索 AppID 或描述" @keyup.enter="loadAccounts" />
          <el-select v-model="filters.status" clearable placeholder="全部状态" @change="loadAccounts">
            <el-option label="已启用" :value="1" />
            <el-option label="已禁用" :value="2" />
          </el-select>
          <el-button @click="loadAccounts">查询</el-button>
        </div>

        <div class="desktop-table">
          <el-table :data="accounts" v-loading="loading" stripe row-key="id" empty-text="暂无 API 账户">
            <el-table-column label="账户" min-width="230">
              <template #default="{ row }"><strong>{{ row.appid }}</strong><div class="sub-text">{{ row.title || '未填写描述' }}</div></template>
            </el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '已启用' : '已禁用' }}</el-tag></template></el-table-column>
            <el-table-column label="权限" width="100"><template #default="{ row }">{{ row.rules.length }} 项</template></el-table-column>
            <el-table-column label="凭据" min-width="170"><template #default="{ row }"><el-tag :type="row.credential_state === 'hashed' ? 'success' : 'danger'" effect="plain">{{ row.credential_state === 'hashed' ? 'bcrypt 哈希' : '需轮换' }}</el-tag><div v-if="row.legacy_plaintext_present" class="danger-note">源数据含明文副本</div></template></el-table-column>
            <el-table-column label="最近使用" min-width="175"><template #default="{ row }">{{ formatTime(row.last_time) }}</template></el-table-column>
            <el-table-column label="操作" width="220" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openAccount(row)">编辑</el-button><el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleStatus(row)">{{ row.status === 1 ? '禁用' : '启用' }}</el-button><el-button link type="danger" @click="removeAccount(row)">删除</el-button></template></el-table-column>
          </el-table>
        </div>

        <div class="mobile-list" v-loading="loading">
          <article v-for="row in accounts" :key="row.id" class="mobile-card">
            <div class="mobile-title"><div><strong>{{ row.appid }}</strong><small>{{ row.title || '未填写描述' }}</small></div><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '启用' : '禁用' }}</el-tag></div>
            <p>{{ row.rules.length }} 项授权 · {{ row.credential_state === 'hashed' ? '凭据已哈希' : '凭据需轮换' }}</p>
            <div class="mobile-actions"><el-button size="small" @click="openAccount(row)">编辑</el-button><el-button size="small" @click="toggleStatus(row)">{{ row.status === 1 ? '禁用' : '启用' }}</el-button><el-button size="small" type="danger" plain @click="removeAccount(row)">删除</el-button></div>
          </article>
          <el-empty v-if="!accounts.length && !loading" description="暂无 API 账户" />
        </div>
      </template>

      <template v-else-if="activeTab === 'interfaces'">
        <el-alert class="catalog-note" title="接口文档是迁移证据，不是路由开关" description="只有标记为“可用只读”或“可用写入”的路由已在 Worker 注册；其余授权 ID 即使存在也会返回未迁移。" type="info" show-icon :closable="false" />
        <div class="interface-groups">
          <section v-for="group in interfaces" :key="group.id" class="interface-group">
            <h3>{{ group.name }}</h3>
            <button v-for="item in group.children" :key="item.id" class="interface-row" type="button" @click="showInterface(item)">
              <span class="method" :class="item.method.toLowerCase()">{{ item.method || '-' }}</span>
              <span><strong>{{ item.name }}</strong><small>{{ item.url }}</small></span>
              <el-tag :type="runtimeType(item.runtime_status)" effect="plain">{{ runtimeLabel(item.runtime_status) }}</el-tag>
            </button>
          </section>
        </div>
      </template>

      <template v-else>
        <el-alert class="catalog-note" title="审计记录不保存原始敏感标识" description="资源、来源 IP 与 User-Agent 只展示不可逆 HMAC 前缀；查询参数仅记录字段名，不记录值、请求体或响应体。" type="info" show-icon :closable="false" />
        <div class="audit-toolbar">
          <el-input v-model="auditFilters.route" clearable placeholder="筛选路由模板" @keyup.enter="loadAudits(1)" />
          <el-select v-model="auditFilters.operation" clearable placeholder="读写类型" @change="loadAudits(1)"><el-option label="读取" value="read" /><el-option label="写入" value="write" /></el-select>
          <el-select v-model="auditFilters.outcome" clearable placeholder="执行结果" @change="loadAudits(1)"><el-option label="成功" value="success" /><el-option label="拒绝" value="denied" /><el-option label="已限流" value="rate_limited" /><el-option label="错误" value="error" /></el-select>
          <el-button @click="loadAudits(1)">查询</el-button>
        </div>
        <div class="desktop-table">
          <el-table :data="audits" v-loading="auditLoading" stripe row-key="id" empty-text="暂无访问审计">
            <el-table-column label="时间" min-width="175"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
            <el-table-column label="账户" min-width="155"><template #default="{ row }"><strong>{{ row.appid }}</strong><div class="sub-text">#{{ row.out_account_id }}</div></template></el-table-column>
            <el-table-column label="接口" min-width="260"><template #default="{ row }"><span class="method" :class="row.method.toLowerCase()">{{ row.method }}</span><code class="audit-route">{{ row.route_template }}</code><div v-if="row.query_fields" class="sub-text">字段：{{ row.query_fields }}</div></template></el-table-column>
            <el-table-column label="结果" width="115"><template #default="{ row }"><el-tag :type="outcomeType(row.outcome)" effect="plain">{{ outcomeLabel(row.outcome) }}</el-tag><div class="sub-text">{{ row.result_code }}</div></template></el-table-column>
            <el-table-column label="摘要" min-width="190"><template #default="{ row }"><code>{{ row.resource_hash || '-' }}</code><div class="sub-text">IP {{ row.ip_hash || '-' }}</div></template></el-table-column>
            <el-table-column label="耗时" width="90"><template #default="{ row }">{{ row.duration_ms }} ms</template></el-table-column>
          </el-table>
        </div>
        <div class="mobile-list" v-loading="auditLoading">
          <article v-for="row in audits" :key="row.id" class="mobile-card">
            <div class="mobile-title"><div><strong>{{ row.method }} {{ row.route_template }}</strong><small>{{ row.appid }} · {{ formatTime(row.add_time) }}</small></div><el-tag :type="outcomeType(row.outcome)">{{ outcomeLabel(row.outcome) }}</el-tag></div>
            <p>资源 {{ row.resource_hash || '-' }} · IP {{ row.ip_hash || '-' }} · {{ row.duration_ms }} ms</p>
          </article>
          <el-empty v-if="!audits.length && !auditLoading" description="暂无访问审计" />
        </div>
        <el-pagination class="audit-pagination" background layout="prev, pager, next, total" :current-page="auditPage" :page-size="auditLimit" :total="auditTotal" @current-change="loadAudits" />
      </template>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑 API 账户' : '创建 API 账户'" width="min(620px, 94vw)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="AppID"><el-input v-model="form.appid" maxlength="50" placeholder="例如 erp-production" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="form.title" maxlength="200" placeholder="说明调用方与用途" /></el-form-item>
        <el-form-item label="状态"><el-radio-group v-model="form.status"><el-radio-button :value="1">启用</el-radio-button><el-radio-button :value="2">禁用</el-radio-button></el-radio-group></el-form-item>
        <el-form-item label="接口权限">
          <el-tree ref="rulesTree" :data="interfaces" node-key="id" show-checkbox :props="{ label: 'name', children: 'children' }" :check-strictly="true">
            <template #default="{ data }"><span class="tree-node"><span>{{ data.name }}</span><small v-if="data.type === 1">{{ data.method }} {{ data.url }} · {{ runtimeLabel(data.runtime_status) }}</small></span></template>
          </el-tree>
        </el-form-item>
        <el-form-item v-if="form.id" label="密钥轮换"><el-switch v-model="form.rotate_secret" active-text="保存时生成新密钥并使旧 token 失效" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveAccount">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="secretVisible" title="请立即保存新密钥" width="min(620px, 94vw)" :close-on-click-modal="false">
      <el-alert title="关闭后无法再次查看" type="warning" show-icon :closable="false" />
      <div class="secret-box"><code>{{ issuedSecret }}</code><el-button type="primary" @click="copySecret">复制</el-button></div>
    </el-dialog>

    <el-drawer v-model="interfaceVisible" title="接口文档" size="min(560px, 92vw)">
      <template v-if="interfaceDetail">
        <div class="detail-route"><span class="method" :class="interfaceDetail.method.toLowerCase()">{{ interfaceDetail.method }}</span><code>{{ interfaceDetail.url }}</code></div>
        <h3>{{ interfaceDetail.name }}</h3><p>{{ interfaceDetail.describe || '暂无描述' }}</p>
        <el-tag :type="runtimeType(interfaceDetail.runtime_status)">{{ runtimeLabel(interfaceDetail.runtime_status) }}</el-tag>
        <h4>请求示例</h4><pre>{{ pretty(interfaceDetail.request_example) }}</pre>
        <h4>返回示例</h4><pre>{{ pretty(interfaceDetail.return_example) }}</pre>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiExternalAccountDelete,
  apiExternalAccounts,
  apiExternalAccountSave,
  apiExternalAccountStatus,
  apiExternalAudits,
  apiExternalInterfaceInfo,
  apiExternalInterfaces,
  type ExternalAccount,
  type ExternalAudit,
  type ExternalInterface,
  type ExternalInterfaceDetail,
} from "@/api/externalApi";

type RulesTree = { getCheckedKeys: (leafOnly?: boolean) => Array<string | number>; setCheckedKeys: (keys: number[]) => void };

const activeTab = ref("accounts");
const loading = ref(false);
const saving = ref(false);
const accounts = ref<ExternalAccount[]>([]);
const interfaces = ref<ExternalInterface[]>([]);
const audits = ref<ExternalAudit[]>([]);
const filters = reactive<{ name: string; status: number | "" }>({ name: "", status: "" });
const auditFilters = reactive<{ route: string; operation: "read" | "write" | ""; outcome: ExternalAudit["outcome"] | "" }>({ route: "", operation: "", outcome: "" });
const auditLoading = ref(false);
const auditPage = ref(1);
const auditLimit = 20;
const auditTotal = ref(0);
const dialogVisible = ref(false);
const secretVisible = ref(false);
const interfaceVisible = ref(false);
const issuedSecret = ref("");
const interfaceDetail = ref<ExternalInterfaceDetail | null>(null);
const rulesTree = ref<RulesTree | null>(null);
const form = reactive({ id: 0, appid: "", title: "", status: 1, rules: [] as number[], rotate_secret: false });

const leafInterfaces = computed(() => interfaces.value.flatMap((group) => group.children ?? []));
const availableReadCount = computed(() => leafInterfaces.value.filter((item) => item.runtime_status === "available_read").length);
const availableWriteCount = computed(() => leafInterfaces.value.filter((item) => item.runtime_status === "available_write").length);
const unavailableCount = computed(() => leafInterfaces.value.filter((item) => item.runtime_status === "not_migrated").length);
const activeCount = computed(() => accounts.value.filter((item) => item.status === 1).length);

function formatTime(value: number) { return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "从未使用"; }
function pretty(value: unknown) { return value === null ? "-" : typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function runtimeLabel(value: ExternalInterface["runtime_status"]) { return value === "available_read" ? "Worker 可用只读" : value === "available_write" ? "Worker 可用写入" : value === "group" ? "分组" : "尚未迁移"; }
function runtimeType(value: ExternalInterface["runtime_status"]) { return value === "available_read" ? "success" : value === "available_write" ? "warning" : "info"; }
function outcomeLabel(value: ExternalAudit["outcome"]) { return ({ success: "成功", denied: "拒绝", rate_limited: "已限流", error: "错误" } as const)[value]; }
function outcomeType(value: ExternalAudit["outcome"]) { return value === "success" ? "success" : value === "rate_limited" ? "warning" : "danger"; }

async function loadAccounts() {
  loading.value = true;
  try { const result = await apiExternalAccounts({ ...filters, page: 1, limit: 100 }); accounts.value = result.list; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "账户加载失败"); }
  finally { loading.value = false; }
}

async function loadAudits(page = auditPage.value) {
  auditLoading.value = true;
  auditPage.value = page;
  try {
    const result = await apiExternalAudits({ ...auditFilters, page, limit: auditLimit });
    audits.value = result.list;
    auditTotal.value = result.count;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "审计记录加载失败"); }
  finally { auditLoading.value = false; }
}

async function openAccount(row?: ExternalAccount) {
  Object.assign(form, row ? { id: row.id, appid: row.appid, title: row.title, status: row.status, rules: [...row.rules], rotate_secret: false } : { id: 0, appid: "", title: "", status: 1, rules: [], rotate_secret: false });
  dialogVisible.value = true;
  await nextTick();
  rulesTree.value?.setCheckedKeys(form.rules);
}

async function saveAccount() {
  const appid = form.appid.trim();
  if (!/^[A-Za-z0-9._:-]{3,50}$/.test(appid)) { ElMessage.warning("AppID 须为 3-50 位字母、数字或 ._:-"); return; }
  const checked = rulesTree.value?.getCheckedKeys(false).map(Number) ?? [];
  const leafIds = new Set(leafInterfaces.value.map((item) => item.id));
  const rules = checked.filter((id) => leafIds.has(id));
  saving.value = true;
  try {
    const result = await apiExternalAccountSave(form.id, { appid, title: form.title, status: form.status, rules, rotate_secret: form.rotate_secret });
    dialogVisible.value = false;
    await loadAccounts();
    if (result.issued_secret) { issuedSecret.value = result.issued_secret; secretVisible.value = true; }
    else ElMessage.success("保存成功");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); }
  finally { saving.value = false; }
}

async function toggleStatus(row: ExternalAccount) {
  const status = row.status === 1 ? 2 : 1;
  await apiExternalAccountStatus(row.id, status);
  row.status = status;
  ElMessage.success(status === 1 ? "账户已启用" : "账户已禁用");
}

async function removeAccount(row: ExternalAccount) {
  await ElMessageBox.confirm(`删除 API 账户 ${row.appid}？`, "删除确认", { type: "warning" });
  await apiExternalAccountDelete(row.id);
  await loadAccounts();
  ElMessage.success("账户已删除");
}

async function showInterface(row: ExternalInterface) {
  interfaceDetail.value = await apiExternalInterfaceInfo(row.id);
  interfaceVisible.value = true;
}

async function copySecret() {
  await navigator.clipboard.writeText(issuedSecret.value);
  ElMessage.success("密钥已复制");
}

onMounted(async () => {
  try { interfaces.value = await apiExternalInterfaces(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "接口目录加载失败"); }
  await loadAccounts();
});
watch(activeTab, (tab) => { if (tab === "audit" && !audits.value.length) void loadAudits(1); });
</script>

<style scoped>
.external-page { display: grid; gap: 16px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px; border: 1px solid #e4eaf2; border-radius: 14px; background: linear-gradient(135deg, #fff 0%, #f3f7ff 100%); }
.page-head h2 { margin: 2px 0 8px; color: #172033; font-size: 24px; }
.page-head p { margin: 0; color: #6f7a8e; }
.eyebrow { color: #2f70d0 !important; font-size: 11px; font-weight: 700; letter-spacing: .14em; }
.summary-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.summary-grid article { display: grid; gap: 5px; padding: 18px; border: 1px solid #e7eaf0; border-radius: 12px; background: #fff; }
.summary-grid span, .summary-grid small { color: #7d8799; }
.summary-grid strong { color: #1d2a3f; font-size: 25px; }
.summary-grid .boundary { background: #172c4a; border-color: #172c4a; }
.summary-grid .boundary span, .summary-grid .boundary small { color: #b8c7dd; }
.summary-grid .boundary strong { color: #fff; font-size: 19px; }
.content-card { border-radius: 12px; }
.toolbar { display: grid; grid-template-columns: minmax(240px, 1fr) 160px auto; gap: 10px; margin-bottom: 16px; }
.sub-text, .danger-note { margin-top: 5px; font-size: 12px; }
.sub-text { color: #8791a3; }
.danger-note { color: #c45656; }
.mobile-list { display: none; }
.catalog-note { margin-bottom: 16px; }
.audit-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 150px 150px auto; gap: 10px; margin-bottom: 16px; }
.audit-route { margin-left: 8px; overflow-wrap: anywhere; }
.audit-pagination { justify-content: flex-end; margin-top: 16px; }
.interface-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.interface-group { overflow: hidden; border: 1px solid #e5e9f0; border-radius: 12px; background: #fff; }
.interface-group h3 { margin: 0; padding: 14px 16px; border-bottom: 1px solid #eef1f5; font-size: 15px; }
.interface-row { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; padding: 13px 16px; border: 0; border-bottom: 1px solid #f0f2f5; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.interface-row:hover { background: #f7faff; }
.interface-row strong, .interface-row small { display: block; }
.interface-row small { margin-top: 4px; color: #8993a4; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.method { display: inline-flex; justify-content: center; padding: 4px 7px; border-radius: 6px; background: #eef2f7; color: #526174; font: 700 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.method.get { background: #e8f7ef; color: #198754; }
.method.post { background: #fff3db; color: #a76600; }
.method.put, .method.delete { background: #fff0f0; color: #c45656; }
.tree-node { display: flex; align-items: center; gap: 8px; }
.tree-node small { color: #8a94a5; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.secret-box { display: flex; align-items: center; gap: 12px; margin-top: 18px; padding: 14px; border-radius: 10px; background: #111c2f; }
.secret-box code { flex: 1; overflow-wrap: anywhere; color: #e8efff; }
.detail-route { display: flex; align-items: center; gap: 10px; }
.detail-route code { overflow-wrap: anywhere; }
pre { max-height: 300px; overflow: auto; padding: 14px; border-radius: 8px; background: #111827; color: #d7e2f2; white-space: pre-wrap; }
@media (max-width: 1050px) { .summary-grid, .interface-groups { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .page-head { flex-direction: column; padding: 18px; }
  .page-head .el-button { width: 100%; }
  .summary-grid { gap: 8px; }
  .summary-grid article { padding: 13px; }
  .summary-grid strong { font-size: 21px; }
  .toolbar { grid-template-columns: 1fr; }
  .audit-toolbar { grid-template-columns: 1fr; }
  .desktop-table { display: none; }
  .mobile-list { display: grid; gap: 10px; }
  .mobile-card { padding: 14px; border: 1px solid #e7eaf0; border-radius: 10px; background: #fff; }
  .mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .mobile-title strong, .mobile-title small { display: block; }
  .mobile-title small { margin-top: 4px; color: #8791a3; }
  .mobile-card p { color: #6f7a8e; font-size: 12px; }
  .mobile-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .interface-groups { grid-template-columns: 1fr; }
  .interface-row { grid-template-columns: 52px minmax(0, 1fr); }
  .interface-row .el-tag { grid-column: 2; justify-self: start; }
  .tree-node { align-items: flex-start; flex-direction: column; gap: 2px; }
  .secret-box { align-items: stretch; flex-direction: column; }
}
</style>
