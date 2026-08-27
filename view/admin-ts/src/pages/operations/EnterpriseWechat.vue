<template>
  <div class="work-page">
    <header class="hero">
      <div>
        <p class="eyebrow">ENTERPRISE WECHAT</p>
        <h2>企业微信迁移目录</h2>
        <p>查看已导入 PostgreSQL 的成员、客户、客户群、渠道码和发送历史。</p>
      </div>
      <el-tag type="warning" effect="dark" size="large">只读运行面</el-tag>
    </header>

    <el-alert
      title="外部同步与发送保持关闭"
      description="成员/客户同步、渠道码变更、欢迎语发送、客户打标签、群发与朋友圈投递需要 Cloudflare Queue、幂等投递记录和专用凭据；当前页面不会调用企业微信写接口。列表中的人员标识、手机号和邮箱默认脱敏。"
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

    <footer class="boundary-note">
      <strong>迁移边界</strong>
      <span>24 张 work_* 表已进入迁移链；6 张无稳定唯一键的关联表仍需专门的确定性导入策略。</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  apiEnterpriseWechatCatalog,
  apiEnterpriseWechatSummary,
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

function displayValue(value: unknown): string { return value === null || value === undefined || value === "" ? "—" : String(value); }
function formatTime(value: unknown): string { const epoch = Number(value); return epoch ? new Date(epoch * 1000).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function statusText(value: unknown): string { const status = Number(value); if (activeSection.value === "member") return status === 1 ? "已激活" : status === 4 ? "未激活" : `状态 ${status}`; return status === 0 ? "正常" : status === 1 ? "异常" : `状态 ${status}`; }
function statusType(value: unknown): "success" | "warning" | "info" { const status = Number(value); return activeSection.value === "member" ? (status === 1 ? "success" : "warning") : (status === 0 || status === 1 && activeSection.value === "channel" ? "success" : "info"); }

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

onMounted(async () => {
  try { summary.value = await apiEnterpriseWechatSummary(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "企业微信概览加载失败"); }
  await loadRows(1);
});
</script>

<style scoped>
.work-page { display: grid; gap: 16px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px; border: 1px solid #dfe8e5; border-radius: 14px; background: radial-gradient(circle at 92% 12%, rgba(50, 190, 136, .17), transparent 31%), linear-gradient(135deg, #fff 0%, #f3fbf8 100%); }
.hero h2 { margin: 3px 0 8px; color: #14251f; font-size: 25px; }.hero p { margin: 0; color: #65766f; }.eyebrow { color: #16865e !important; font-size: 11px; font-weight: 800; letter-spacing: .15em; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }.summary-grid article { display: grid; gap: 5px; padding: 18px; border: 1px solid #e4ebe8; border-radius: 12px; background: #fff; }.summary-grid span,.summary-grid small { color: #74827d; }.summary-grid strong { color: #17342a; font-size: 26px; }.summary-grid .pending { background: #18372d; border-color: #18372d; }.summary-grid .pending span,.summary-grid .pending small { color: #b9d4ca; }.summary-grid .pending strong { color: #fff; }
.catalog-card { border-radius: 12px; }.catalog-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }.catalog-tabs { min-width: 0; flex: 1; }.authority { display: flex; align-items: center; gap: 7px; color: #697a73; font-size: 12px; white-space: nowrap; }.dot { width: 8px; height: 8px; border-radius: 50%; background: #2eaf78; box-shadow: 0 0 0 4px #e1f5eb; }
.toolbar { display: grid; grid-template-columns: minmax(240px, 1fr) 160px auto 1fr; gap: 10px; align-items: center; margin: 4px 0 16px; }.result-count { justify-self: end; color: #7b8883; font-size: 13px; }.mobile-list { display: none; }.pager { justify-content: flex-end; margin-top: 16px; }
.boundary-note { display: flex; gap: 12px; padding: 14px 16px; border: 1px solid #e5e9e7; border-radius: 10px; background: #fafcfb; color: #65736e; font-size: 13px; }.boundary-note strong { color: #273b34; white-space: nowrap; }
@media (max-width: 1050px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.catalog-head { align-items: flex-start; flex-direction: column; gap: 0; }.catalog-tabs { width: 100%; } }
@media (max-width: 720px) {
  .hero { align-items: stretch; flex-direction: column; padding: 18px; }.hero .el-tag { align-self: flex-start; }.summary-grid { gap: 8px; }.summary-grid article { padding: 13px; }.summary-grid strong { font-size: 22px; }
  .toolbar { grid-template-columns: 1fr; }.result-count { justify-self: start; }.desktop-table { display: none; }.mobile-list { display: grid; gap: 10px; }.mobile-card { padding: 14px; border: 1px solid #e4ebe8; border-radius: 10px; background: #fff; }.mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.mobile-card dl { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 7px 10px; margin: 14px 0 0; font-size: 12px; }.mobile-card dt { color: #87938f; }.mobile-card dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #354740; }.boundary-note { flex-direction: column; gap: 5px; }
}
</style>
