<template>
  <div class="work-page">
    <header class="hero">
      <div>
        <p class="eyebrow">ENTERPRISE WECHAT</p>
        <h2>企业微信迁移目录</h2>
        <p>查看已导入 PostgreSQL 的成员、客户、客户群、渠道码和发送历史。</p>
      </div>
      <el-tag type="warning" effect="dark" size="large">目录只读 · 动作受控处置</el-tag>
    </header>

    <el-alert
      title="目录同步与主动发送保持关闭"
      description="成员/客户同步、渠道码变更、主动欢迎语、打标签、群发与朋友圈投递均未开放。这里只允许对 UNKNOWN/DEAD 后置动作做有权限、幂等且不可变审计的人工处置；风险重试仅在 authority 核验后由服务端异步执行。列表中的人员标识、手机号和邮箱默认脱敏。"
      type="warning"
      show-icon
      :closable="false"
    />

    <section class="summary-grid" aria-label="企业微信迁移概览">
      <article><span>有效成员</span><strong>{{ summary.active_members }}</strong><small>共 {{ summary.members }} 名成员</small></article>
      <article><span>企业客户</span><strong>{{ summary.clients }}</strong><small>未删除的外部联系人</small></article>
      <article><span>客户群</span><strong>{{ summary.groups }}</strong><small>{{ summary.channels }} 个渠道码</small></article>
      <article class="pending"><span>待确认结果</span><strong>{{ summary.pending_delivery_results }}</strong><small>导入历史，不会自动重试</small></article>
    </section>

    <el-card shadow="never" class="catalog-card">
      <div class="catalog-head">
        <el-tabs v-model="activeSection" class="catalog-tabs" @tab-change="changeSection">
          <el-tab-pane v-for="tab in tabs" :key="tab.key" :label="tab.label" :name="tab.key" />
        </el-tabs>
        <div class="authority"><span class="dot" /> PostgreSQL 导入历史</div>
      </div>

      <div class="toolbar">
        <el-input v-model="filters.keyword" clearable placeholder="按名称或标识搜索" @keyup.enter="loadRows(1)" />
        <el-select v-if="activeTab.hasStatus" v-model="filters.status" clearable placeholder="全部状态" @change="loadRows(1)">
          <el-option label="正常 / 已启用" :value="activeSection === 'member' ? 1 : 0" />
          <el-option label="其他状态" :value="activeSection === 'member' ? 4 : 1" />
        </el-select>
        <el-button @click="loadRows(1)">查询</el-button>
        <span class="result-count">共 {{ total }} 条</span>
      </div>

      <div class="desktop-table">
        <el-table :data="rows" v-loading="loading" stripe row-key="id" empty-text="暂无已导入记录">
          <el-table-column
            v-for="column in activeTab.columns"
            :key="column.key"
            :prop="column.key"
            :label="column.label"
            :min-width="column.width"
          >
            <template #default="{ row }">
              <el-tag v-if="column.kind === 'status'" :type="statusType(row[column.key])" effect="plain">
                {{ statusText(row[column.key]) }}
              </el-tag>
              <span v-else-if="column.kind === 'time'">{{ formatTime(row[column.key]) }}</span>
              <span v-else-if="column.kind === 'bool'">{{ row[column.key] ? "是" : "否" }}</span>
              <strong v-else-if="column.primary">{{ displayValue(row[column.key]) }}</strong>
              <span v-else>{{ displayValue(row[column.key]) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="mobile-list" v-loading="loading">
        <article v-for="row in rows" :key="String(row.id)" class="mobile-card">
          <div class="mobile-title">
            <strong>{{ displayValue(row[activeTab.columns[0].key]) }}</strong>
            <el-tag v-if="activeTab.hasStatus" :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
          </div>
          <dl>
            <template v-for="column in activeTab.columns.slice(1, 5)" :key="column.key">
              <dt>{{ column.label }}</dt>
              <dd>{{ column.kind === "time" ? formatTime(row[column.key]) : displayValue(row[column.key]) }}</dd>
            </template>
          </dl>
        </article>
        <el-empty v-if="!rows.length && !loading" description="暂无已导入记录" />
      </div>

      <el-pagination
        v-if="total > pageSize"
        class="pager"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="pageSize"
        :current-page="page"
        @current-change="loadRows"
      />
    </el-card>

    <el-card shadow="never" class="action-card">
      <template #header>
        <div class="action-head">
          <div>
            <strong>客户后置动作台账</strong>
            <p>Queue 仅携带动作引用；列表不展示客户、员工、欢迎码或标签内容。</p>
          </div>
          <el-tag :type="actionAuthority === 'verified' ? 'success' : 'info'" effect="plain">
            远端写权限：{{ actionAuthority === "verified" ? "已核验" : "关闭" }}
          </el-tag>
        </div>
      </template>

      <div class="action-toolbar">
        <el-select v-model="actionFilters.status" clearable placeholder="全部状态" @change="loadActions(1)">
          <el-option v-for="status in actionStatuses" :key="status" :label="actionStatusText(status)" :value="status" />
        </el-select>
        <el-select v-model="actionFilters.actionType" clearable placeholder="全部动作" @change="loadActions(1)">
          <el-option v-for="type in actionTypes" :key="type" :label="actionTypeText(type)" :value="type" />
        </el-select>
        <el-button @click="loadActions(1)">刷新</el-button>
        <span class="result-count">共 {{ actionTotal }} 条</span>
      </div>

      <div class="desktop-table">
        <el-table :data="actionRows" v-loading="actionLoading" stripe row-key="id" empty-text="暂无后置动作">
          <el-table-column prop="id" label="动作 ID" min-width="90" />
          <el-table-column label="动作类型" min-width="130">
            <template #default="{ row }">{{ actionTypeText(row.action_type) }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="115">
            <template #default="{ row }"><el-tag :type="actionStatusType(row.status)" effect="plain">{{ actionStatusText(row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="attempt_count" label="处理次数" min-width="85" />
          <el-table-column prop="last_error_code" label="错误码" min-width="230">
            <template #default="{ row }">{{ displayValue(row.last_error_code) }}</template>
          </el-table-column>
          <el-table-column prop="provider_code" label="Provider" min-width="95">
            <template #default="{ row }">{{ displayValue(row.provider_code) }}</template>
          </el-table-column>
          <el-table-column label="更新时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.update_time) }}</template>
          </el-table-column>
          <el-table-column label="处置" fixed="right" min-width="90">
            <template #default="{ row }">
              <el-button v-if="canDecide(row)" type="primary" link @click="openDecision(row)">人工处置</el-button>
              <span v-else>—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="mobile-list" v-loading="actionLoading">
        <article v-for="row in actionRows" :key="row.id" class="mobile-card action-mobile-card">
          <div class="mobile-title">
            <strong>#{{ row.id }} · {{ actionTypeText(row.action_type) }}</strong>
            <el-tag :type="actionStatusType(row.status)" size="small">{{ actionStatusText(row.status) }}</el-tag>
          </div>
          <p>{{ displayValue(row.last_error_code) }}</p>
          <div class="mobile-action-meta">
            <span>处理 {{ row.attempt_count }} 次</span><span>{{ formatTime(row.update_time) }}</span>
          </div>
          <el-button v-if="canDecide(row)" type="primary" plain @click="openDecision(row)">人工处置</el-button>
        </article>
        <el-empty v-if="!actionRows.length && !actionLoading" description="暂无后置动作" />
      </div>

      <el-pagination
        v-if="actionTotal > pageSize"
        class="pager"
        layout="total, prev, pager, next"
        :total="actionTotal"
        :page-size="pageSize"
        :current-page="actionPage"
        @current-change="loadActions"
      />
    </el-card>

    <el-dialog v-model="decisionVisible" title="人工处置企业微信动作" width="min(520px, 92vw)" destroy-on-close>
      <el-alert
        v-if="selectedAction?.action_type === 'WELCOME_SEND'"
        title="欢迎码是 20 秒内单次使用凭据，UNKNOWN/DEAD 不允许重发。"
        type="warning"
        show-icon
        :closable="false"
      />
      <el-form label-position="top" class="decision-form">
        <el-form-item label="动作">
          <span>#{{ selectedAction?.id }} · {{ selectedAction ? actionTypeText(selectedAction.action_type) : "—" }}</span>
        </el-form-item>
        <el-form-item label="处置方式" required>
          <el-select v-model="decision.operation" class="full-width">
            <el-option v-for="operation in availableOperations" :key="operation" :value="operation" :label="operationText(operation)" />
          </el-select>
        </el-form-item>
        <el-form-item label="处置理由（8～500 字；勿填客户、员工、欢迎码或标签内容）" required>
          <el-input v-model="decision.reason" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="仅填写对账依据与处置结论，不录入个人信息或凭据" />
        </el-form-item>
        <el-form-item v-if="decision.operation === 'CONFIRM_SUCCEEDED'" label="Provider 参考号（可选，仅保存摘要）">
          <el-input v-model="decision.providerReference" maxlength="256" />
        </el-form-item>
        <el-form-item v-if="decision.operation === 'RETRY_WITH_RISK'">
          <el-checkbox v-model="decision.riskAccepted">我已完成对账，并接受远端副作用可能重复的风险</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="decisionVisible = false">取消</el-button>
        <el-button type="primary" :loading="decisionSubmitting" @click="submitDecision">提交不可变处置记录</el-button>
      </template>
    </el-dialog>

    <footer class="boundary-note">
      <strong>迁移边界</strong>
      <span>C8 动作结构已进入生产数据库，但 authority 仍关闭；真实租户、旧媒体素材迁移、预发和发布批准完成前不得启用。</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  apiDecideEnterpriseWechatContactAction,
  apiEnterpriseWechatCatalog,
  apiEnterpriseWechatContactActions,
  apiEnterpriseWechatSummary,
  type ContactActionDecision,
  type ContactActionRow,
  type ContactActionStatus,
  type ContactActionType,
  type EnterpriseWechatRow,
  type EnterpriseWechatSummary,
} from "@/api/enterpriseWechat";

type Section = "member" | "client" | "group" | "channel" | "template" | "moment" | "welcome";
type Column = { key: string; label: string; width: number; kind?: "status" | "time" | "bool"; primary?: boolean };
type Tab = { key: Section; label: string; hasStatus: boolean; columns: Column[] };

const tabs: Tab[] = [
  { key: "member", label: "成员", hasStatus: true, columns: [
    { key: "name", label: "成员", width: 130, primary: true }, { key: "position", label: "职务", width: 130 },
    { key: "userid", label: "企业标识", width: 135 }, { key: "mobile", label: "手机号", width: 130 },
    { key: "main_department", label: "主部门", width: 85 }, { key: "status", label: "状态", width: 95, kind: "status" },
    { key: "update_time", label: "更新时间", width: 170, kind: "time" },
  ] },
  { key: "client", label: "客户", hasStatus: false, columns: [
    { key: "name", label: "客户", width: 140, primary: true }, { key: "external_userid", label: "外部联系人标识", width: 150 },
    { key: "corp_name", label: "企业", width: 140 }, { key: "position", label: "职位", width: 110 },
    { key: "remark", label: "备注", width: 160 }, { key: "uid", label: "商城 UID", width: 95 },
    { key: "update_time", label: "更新时间", width: 170, kind: "time" },
  ] },
  { key: "group", label: "客户群", hasStatus: true, columns: [
    { key: "name", label: "客户群", width: 180, primary: true }, { key: "chat_id", label: "群标识", width: 135 },
    { key: "owner", label: "群主", width: 125 }, { key: "member_num", label: "成员数", width: 90 },
    { key: "retreat_group_num", label: "累计退群", width: 90 }, { key: "status", label: "状态", width: 95, kind: "status" },
    { key: "update_time", label: "更新时间", width: 170, kind: "time" },
  ] },
  { key: "channel", label: "渠道码", hasStatus: true, columns: [
    { key: "name", label: "渠道码", width: 170, primary: true }, { key: "type", label: "在线规则", width: 90 },
    { key: "assigned_member_count", label: "接待成员", width: 90 }, { key: "client_num", label: "新增客户", width: 90 },
    { key: "skip_verify", label: "自动通过", width: 90, kind: "bool" }, { key: "status", label: "状态", width: 95, kind: "status" },
    { key: "create_time", label: "创建时间", width: 170, kind: "time" },
  ] },
  { key: "template", label: "群发历史", hasStatus: false, columns: [
    { key: "name", label: "群发模板", width: 170, primary: true }, { key: "type", label: "对象类型", width: 90 },
    { key: "assigned_member_count", label: "成员数", width: 85 }, { key: "template_type", label: "发送方式", width: 90 },
    { key: "send_type", label: "发送状态", width: 90 }, { key: "has_failure_detail", label: "失败记录", width: 90, kind: "bool" },
    { key: "send_time", label: "发送时间", width: 170, kind: "time" },
  ] },
  { key: "moment", label: "朋友圈历史", hasStatus: false, columns: [
    { key: "name", label: "朋友圈任务", width: 180, primary: true }, { key: "assigned_member_count", label: "成员数", width: 85 },
    { key: "client_type", label: "客户范围", width: 90 }, { key: "remote_job_state", label: "远端任务", width: 110 },
    { key: "remote_moment_state", label: "朋友圈 ID", width: 110 }, { key: "has_invalid_recipients", label: "无效接收人", width: 100, kind: "bool" },
    { key: "send_time", label: "发送时间", width: 170, kind: "time" },
  ] },
  { key: "welcome", label: "欢迎语", hasStatus: false, columns: [
    { key: "content_preview", label: "欢迎语预览", width: 300, primary: true }, { key: "type", label: "适用范围", width: 100 },
    { key: "attachment_count", label: "附件数", width: 85 }, { key: "sort", label: "排序", width: 75 },
    { key: "update_time", label: "更新时间", width: 170, kind: "time" },
  ] },
];

const emptySummary: EnterpriseWechatSummary = {
  members: 0, active_members: 0, clients: 0, groups: 0, channels: 0, templates: 0,
  moments: 0, pending_delivery_results: 0, catalog_authority: "postgresql_imported_history",
  remote_write_authority: "not_migrated_requires_idempotent_outbox", pii_display: "masked",
};

const summary = ref<EnterpriseWechatSummary>(emptySummary);
const activeSection = ref<Section>("member");
const rows = ref<EnterpriseWechatRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const filters = reactive<{ keyword: string; status: number | "" }>({ keyword: "", status: "" });
const activeTab = computed(() => tabs.find((tab) => tab.key === activeSection.value) ?? tabs[0]);

const actionStatuses: ContactActionStatus[] = ["UNKNOWN", "DEAD", "RETRYABLE", "PENDING", "PROCESSING", "SUCCEEDED", "SKIPPED", "EXPIRED", "CLOSED"];
const actionTypes: ContactActionType[] = ["WELCOME_SEND", "AUTO_TAG", "CLIENT_UID_LINK"];
const actionRows = ref<ContactActionRow[]>([]);
const actionTotal = ref(0);
const actionPage = ref(1);
const actionLoading = ref(false);
const actionAuthority = ref<"verified" | "disabled">("disabled");
const actionFilters = reactive<{ status: ContactActionStatus | ""; actionType: ContactActionType | "" }>({ status: "", actionType: "" });
const decisionVisible = ref(false);
const decisionSubmitting = ref(false);
const selectedAction = ref<ContactActionRow | null>(null);
const decision = reactive<{
  requestKey: string;
  operation: ContactActionDecision["operation"];
  reason: string;
  riskAccepted: boolean;
  providerReference: string;
}>({ requestKey: "", operation: "CLOSE", reason: "", riskAccepted: false, providerReference: "" });
const availableOperations = computed<ContactActionDecision["operation"][]>(() => {
  const row = selectedAction.value;
  if (!row) return [];
  const operations: ContactActionDecision["operation"][] = [];
  if (row.status === "UNKNOWN") operations.push("CONFIRM_SUCCEEDED");
  if (row.action_type !== "WELCOME_SEND") operations.push("RETRY_WITH_RISK");
  operations.push("CLOSE");
  return operations;
});

function displayValue(value: unknown): string { return value === null || value === undefined || value === "" ? "—" : String(value); }
function formatTime(value: unknown): string { const epoch = Number(value); return epoch ? new Date(epoch * 1000).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function statusText(value: unknown): string { const status = Number(value); if (activeSection.value === "member") return status === 1 ? "已激活" : status === 4 ? "未激活" : `状态 ${status}`; return status === 0 ? "正常" : status === 1 ? "异常" : `状态 ${status}`; }
function statusType(value: unknown): "success" | "warning" | "info" { const status = Number(value); return activeSection.value === "member" ? (status === 1 ? "success" : "warning") : (status === 0 || status === 1 && activeSection.value === "channel" ? "success" : "info"); }
function actionTypeText(value: ContactActionType): string { return ({ WELCOME_SEND: "发送欢迎语", AUTO_TAG: "自动标签", CLIENT_UID_LINK: "关联商城用户" } as const)[value]; }
function actionStatusText(value: ContactActionStatus): string { return ({ PENDING: "待调度", ENQUEUING: "入队中", ENQUEUED: "已入队", PROCESSING: "处理中", RETRYABLE: "可重试", SUCCEEDED: "成功", SKIPPED: "已跳过", EXPIRED: "已过期", UNKNOWN: "结果未知", DEAD: "需人工处理", CLOSED: "已关闭" } as const)[value]; }
function actionStatusType(value: ContactActionStatus): "success" | "warning" | "danger" | "info" { if (value === "SUCCEEDED") return "success"; if (value === "UNKNOWN" || value === "RETRYABLE" || value === "EXPIRED") return "warning"; if (value === "DEAD") return "danger"; return "info"; }
function operationText(value: ContactActionDecision["operation"]): string { return ({ CONFIRM_SUCCEEDED: "对账后确认成功", RETRY_WITH_RISK: "接受重复风险并重试", CLOSE: "关闭动作" } as const)[value]; }
function canDecide(row: ContactActionRow): boolean { return row.status === "UNKNOWN" || row.status === "DEAD"; }

async function loadRows(targetPage = 1) {
  loading.value = true;
  page.value = targetPage;
  try {
    const data = await apiEnterpriseWechatCatalog(activeSection.value, {
      page: targetPage, limit: pageSize, keyword: filters.keyword, status: activeTab.value.hasStatus ? filters.status : undefined,
    });
    rows.value = data.list;
    total.value = data.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "企业微信目录加载失败");
  } finally { loading.value = false; }
}

function changeSection() { filters.keyword = ""; filters.status = ""; void loadRows(1); }

async function loadActions(targetPage = 1) {
  actionLoading.value = true;
  actionPage.value = targetPage;
  try {
    const data = await apiEnterpriseWechatContactActions({
      page: targetPage,
      limit: pageSize,
      status: actionFilters.status || undefined,
      action_type: actionFilters.actionType || undefined,
    });
    actionRows.value = data.list;
    actionTotal.value = data.count;
    actionAuthority.value = data.remote_write_authority;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "企业微信动作台账加载失败");
  } finally { actionLoading.value = false; }
}

function openDecision(row: ContactActionRow) {
  selectedAction.value = row;
  decision.requestKey = crypto.randomUUID();
  decision.operation = row.status === "UNKNOWN" ? "CONFIRM_SUCCEEDED" : row.action_type === "WELCOME_SEND" ? "CLOSE" : "RETRY_WITH_RISK";
  decision.reason = "";
  decision.riskAccepted = false;
  decision.providerReference = "";
  decisionVisible.value = true;
}

async function submitDecision() {
  const row = selectedAction.value;
  const reason = decision.reason.trim();
  if (!row || reason.length < 8) { ElMessage.warning("请填写至少 8 个字的处置理由"); return; }
  if (decision.operation === "RETRY_WITH_RISK" && !decision.riskAccepted) { ElMessage.warning("必须明确接受重复副作用风险"); return; }
  decisionSubmitting.value = true;
  try {
    await apiDecideEnterpriseWechatContactAction(row.id, {
      request_key: decision.requestKey,
      operation: decision.operation,
      reason,
      risk_accepted: decision.operation === "RETRY_WITH_RISK" ? true : undefined,
      provider_reference: decision.operation === "CONFIRM_SUCCEEDED" ? decision.providerReference.trim() || undefined : undefined,
    });
    ElMessage.success("处置记录已提交");
    decisionVisible.value = false;
    await loadActions(actionPage.value);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "动作处置失败");
  } finally { decisionSubmitting.value = false; }
}

onMounted(async () => {
  try { summary.value = await apiEnterpriseWechatSummary(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "企业微信概览加载失败"); }
  await Promise.all([loadRows(1), loadActions(1)]);
});
</script>

<style scoped>
.work-page { display: grid; gap: 16px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px; border: 1px solid #dfe8e5; border-radius: 14px; background: radial-gradient(circle at 92% 12%, rgba(50, 190, 136, .17), transparent 31%), linear-gradient(135deg, #fff 0%, #f3fbf8 100%); }
.hero h2 { margin: 3px 0 8px; color: #14251f; font-size: 25px; }.hero p { margin: 0; color: #65766f; }.eyebrow { color: #16865e !important; font-size: 11px; font-weight: 800; letter-spacing: .15em; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }.summary-grid article { display: grid; gap: 5px; padding: 18px; border: 1px solid #e4ebe8; border-radius: 12px; background: #fff; }.summary-grid span,.summary-grid small { color: #74827d; }.summary-grid strong { color: #17342a; font-size: 26px; }.summary-grid .pending { background: #18372d; border-color: #18372d; }.summary-grid .pending span,.summary-grid .pending small { color: #b9d4ca; }.summary-grid .pending strong { color: #fff; }
.catalog-card { border-radius: 12px; }.catalog-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }.catalog-tabs { min-width: 0; flex: 1; }.authority { display: flex; align-items: center; gap: 7px; color: #697a73; font-size: 12px; white-space: nowrap; }.dot { width: 8px; height: 8px; border-radius: 50%; background: #2eaf78; box-shadow: 0 0 0 4px #e1f5eb; }
.toolbar { display: grid; grid-template-columns: minmax(240px, 1fr) 160px auto 1fr; gap: 10px; align-items: center; margin: 4px 0 16px; }.result-count { justify-self: end; color: #7b8883; font-size: 13px; }.mobile-list { display: none; }.pager { justify-content: flex-end; margin-top: 16px; }
.action-card { border-radius: 12px; }.action-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.action-head p { margin: 5px 0 0; color: #73817c; font-size: 13px; }.action-toolbar { display: grid; grid-template-columns: 180px 180px auto 1fr; gap: 10px; align-items: center; margin-bottom: 16px; }.decision-form { margin-top: 16px; }.full-width { width: 100%; }.action-mobile-card p { margin: 12px 0; color: #596963; font-size: 12px; overflow-wrap: anywhere; }.mobile-action-meta { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 12px; color: #87938f; font-size: 12px; }
.boundary-note { display: flex; gap: 12px; padding: 14px 16px; border: 1px solid #e5e9e7; border-radius: 10px; background: #fafcfb; color: #65736e; font-size: 13px; }.boundary-note strong { color: #273b34; white-space: nowrap; }
@media (max-width: 1050px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.catalog-head,.action-head { align-items: flex-start; flex-direction: column; gap: 8px; }.catalog-tabs { width: 100%; } }
@media (max-width: 720px) {
  .hero { align-items: stretch; flex-direction: column; padding: 18px; }.hero .el-tag { align-self: flex-start; }.summary-grid { gap: 8px; }.summary-grid article { padding: 13px; }.summary-grid strong { font-size: 22px; }
  .toolbar,.action-toolbar { grid-template-columns: 1fr; }.result-count { justify-self: start; }.desktop-table { display: none; }.mobile-list { display: grid; gap: 10px; }.mobile-card { padding: 14px; border: 1px solid #e4ebe8; border-radius: 10px; background: #fff; }.mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.mobile-card dl { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 7px 10px; margin: 14px 0 0; font-size: 12px; }.mobile-card dt { color: #87938f; }.mobile-card dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #354740; }.boundary-note { flex-direction: column; gap: 5px; }
}
</style>
