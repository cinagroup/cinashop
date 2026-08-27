<template>
  <div class="member-card-page">
    <header class="hero">
      <div>
        <p class="eyebrow">OFFICIAL ACCOUNT · MEMBER CARD</p>
        <h2>公众号会员卡迁移目录</h2>
        <p>核对已导入 PostgreSQL 的会员卡配置、领取与激活历史。</p>
      </div>
      <div class="hero-state"><span class="pulse" /> 只读 · 已脱敏</div>
    </header>

    <el-alert
      title="远端制卡、激活和回调写入保持关闭"
      description="旧 PHP 流程会上传图片、创建或更新微信卡券并处理 /wechat/serve 回调；当前没有可安全重放的幂等投递记录，因此本页只展示导入历史。card_id、会员卡 code 与 openid 均只返回掩码。"
      type="warning"
      show-icon
      :closable="false"
    />

    <section class="summary-grid" aria-label="会员卡迁移概览">
      <article>
        <span>有效卡配置</span>
        <strong>{{ summary.active_cards }}</strong>
        <small>共 {{ summary.cards }} 个历史配置</small>
      </article>
      <article>
        <span>有效领取记录</span>
        <strong>{{ summary.active_claims }}</strong>
        <small>累计 {{ summary.claims }} 条</small>
      </article>
      <article>
        <span>已激活</span>
        <strong>{{ summary.activated_claims }}</strong>
        <small>删除历史 {{ summary.deleted_claims }} 条</small>
      </article>
      <article class="legacy">
        <span>旧商户申请</span>
        <strong>{{ summary.legacy_applications }}</strong>
        <small>已由 system_user_apply 取代</small>
      </article>
    </section>

    <el-card shadow="never" class="catalog-card">
      <div class="catalog-head">
        <el-tabs v-model="section" @tab-change="changeSection">
          <el-tab-pane label="卡配置" name="cards" />
          <el-tab-pane label="领取与激活" name="claims" />
        </el-tabs>
        <span class="authority"><i /> PostgreSQL 导入历史</span>
      </div>

      <div class="toolbar">
        <el-input
          v-if="section === 'cards'"
          v-model="filters.keyword"
          clearable
          placeholder="品牌、标题或卡类型"
          @keyup.enter="loadRows(1)"
        />
        <el-input
          v-else
          v-model="filters.uid"
          clearable
          inputmode="numeric"
          placeholder="商城用户 UID"
          @keyup.enter="loadRows(1)"
        />
        <el-select v-if="section === 'cards'" v-model="filters.status" clearable placeholder="全部状态">
          <el-option label="启用" :value="1" />
          <el-option label="停用" :value="0" />
        </el-select>
        <el-select v-else v-model="filters.isSubmit" clearable placeholder="全部激活状态">
          <el-option label="已激活" :value="1" />
          <el-option label="待激活" :value="0" />
        </el-select>
        <el-button @click="loadRows(1)">查询</el-button>
        <span class="result-count">共 {{ total }} 条</span>
      </div>

      <div class="desktop-table">
        <el-table :data="rows" v-loading="loading" stripe row-key="id" empty-text="暂无已导入记录">
          <template v-if="section === 'cards'">
            <el-table-column prop="title" label="会员卡" min-width="170">
              <template #default="{ row }">
                <div class="primary-cell"><strong>{{ display(row.title) }}</strong><small>{{ display(row.brand_name) }}</small></div>
              </template>
            </el-table-column>
            <el-table-column prop="remote_card_id_masked" label="远端卡标识（脱敏）" min-width="150" />
            <el-table-column prop="card_type" label="卡类型" min-width="120" />
            <el-table-column prop="code_type" label="核销码类型" min-width="175" />
            <el-table-column prop="color" label="颜色" min-width="100" />
            <el-table-column prop="status" label="状态" width="95">
              <template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'" effect="plain">{{ row.status === 1 ? "启用" : "停用" }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="add_time" label="录入时间" min-width="170">
              <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
            </el-table-column>
          </template>
          <template v-else>
            <el-table-column prop="uid" label="用户 UID" min-width="105" />
            <el-table-column prop="code_masked" label="会员卡号（脱敏）" min-width="155" />
            <el-table-column prop="openid_masked" label="openid（脱敏）" min-width="140" />
            <el-table-column prop="remote_card_id_masked" label="远端卡标识（脱敏）" min-width="150" />
            <el-table-column prop="store_id" label="门店" width="80" />
            <el-table-column prop="staff_id" label="店员" width="80" />
            <el-table-column prop="is_submit" label="激活" width="95">
              <template #default="{ row }"><el-tag :type="row.is_submit === 1 ? 'success' : 'warning'" effect="plain">{{ row.is_submit === 1 ? "已激活" : "待激活" }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="add_time" label="领取时间" min-width="170">
              <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
            </el-table-column>
          </template>
        </el-table>
      </div>

      <div class="mobile-list" v-loading="loading">
        <article v-for="row in rows" :key="String(row.id)" class="mobile-card">
          <div class="mobile-title">
            <div>
              <strong>{{ section === "cards" ? display(row.title) : `UID ${display(row.uid)}` }}</strong>
              <small>{{ section === "cards" ? display(row.brand_name) : display(row.code_masked) }}</small>
            </div>
            <el-tag :type="rowStatus(row) ? 'success' : 'warning'" size="small">{{ rowStatus(row) ? (section === "cards" ? "启用" : "已激活") : (section === "cards" ? "停用" : "待激活") }}</el-tag>
          </div>
          <dl v-if="section === 'cards'">
            <dt>远端标识</dt><dd>{{ display(row.remote_card_id_masked) }}</dd>
            <dt>卡类型</dt><dd>{{ display(row.card_type) }}</dd>
            <dt>核销码</dt><dd>{{ display(row.code_type) }}</dd>
            <dt>录入时间</dt><dd>{{ formatTime(row.add_time) }}</dd>
          </dl>
          <dl v-else>
            <dt>openid</dt><dd>{{ display(row.openid_masked) }}</dd>
            <dt>远端标识</dt><dd>{{ display(row.remote_card_id_masked) }}</dd>
            <dt>门店 / 店员</dt><dd>{{ display(row.store_id) }} / {{ display(row.staff_id) }}</dd>
            <dt>领取时间</dt><dd>{{ formatTime(row.add_time) }}</dd>
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
      <span>user_enter 仅保留旧申请数量；当前商户申请由 system_user_apply 承担。微信卡券配置和领取记录可审计，但不会触发微信 API 或回放历史回调。</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  apiWechatMemberCardCatalog,
  apiWechatMemberCardSummary,
  type WechatMemberCardRow,
  type WechatMemberCardSummary,
} from "@/api/wechatMemberCard";

type Section = "cards" | "claims";

const emptySummary: WechatMemberCardSummary = {
  cards: 0, active_cards: 0, claims: 0, active_claims: 0, activated_claims: 0,
  deleted_claims: 0, legacy_applications: 0, catalog_authority: "postgresql_imported_history",
  remote_write_authority: "not_migrated_requires_idempotent_outbox", callback_authority: "disabled", pii_display: "masked",
};
const summary = ref(emptySummary);
const section = ref<Section>("cards");
const rows = ref<WechatMemberCardRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(false);
const filters = reactive<{ keyword: string; uid: string; status: number | ""; isSubmit: number | "" }>({ keyword: "", uid: "", status: "", isSubmit: "" });

function display(value: unknown): string { return value === null || value === undefined || value === "" ? "—" : String(value); }
function formatTime(value: unknown): string { const epoch = Number(value); return epoch ? new Date(epoch * 1000).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function rowStatus(row: WechatMemberCardRow): boolean { return Number(section.value === "cards" ? row.status : row.is_submit) === 1; }

async function loadRows(targetPage = 1) {
  loading.value = true;
  page.value = targetPage;
  try {
    const data = await apiWechatMemberCardCatalog(section.value, {
      page: targetPage,
      limit: pageSize,
      keyword: section.value === "cards" ? filters.keyword : undefined,
      uid: section.value === "claims" ? filters.uid : undefined,
      status: section.value === "cards" ? filters.status : undefined,
      is_submit: section.value === "claims" ? filters.isSubmit : undefined,
    });
    rows.value = data.list;
    total.value = data.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "会员卡迁移目录加载失败");
  } finally {
    loading.value = false;
  }
}

function changeSection() {
  filters.keyword = "";
  filters.uid = "";
  filters.status = "";
  filters.isSubmit = "";
  void loadRows(1);
}

onMounted(async () => {
  try { summary.value = await apiWechatMemberCardSummary(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "会员卡迁移概览加载失败"); }
  await loadRows(1);
});
</script>

<style scoped>
.member-card-page { display: grid; gap: 16px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; padding: 25px; overflow: hidden; border: 1px solid #e8e2d7; border-radius: 15px; background: radial-gradient(circle at 88% 2%, rgba(205, 153, 52, .2), transparent 34%), linear-gradient(135deg, #fffdf8 0%, #f8f4eb 100%); }
.hero h2 { margin: 3px 0 8px; color: #302819; font-size: 25px; }.hero p { margin: 0; color: #776d5d; }.eyebrow { color: #9b6b12 !important; font-size: 11px; font-weight: 800; letter-spacing: .13em; }
.hero-state { display: flex; align-items: center; gap: 9px; padding: 9px 13px; border: 1px solid #d9c79e; border-radius: 999px; background: rgba(255,255,255,.72); color: #70521a; font-size: 13px; white-space: nowrap; }.pulse { width: 8px; height: 8px; border-radius: 50%; background: #3aa570; box-shadow: 0 0 0 4px rgba(58,165,112,.14); }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }.summary-grid article { display: grid; gap: 5px; padding: 18px; border: 1px solid #e8e4dd; border-radius: 12px; background: #fff; }.summary-grid span,.summary-grid small { color: #817a6e; }.summary-grid strong { color: #342e24; font-size: 27px; }.summary-grid .legacy { background: #2d2922; border-color: #2d2922; }.summary-grid .legacy span,.summary-grid .legacy small { color: #cfc5b3; }.summary-grid .legacy strong { color: #fff; }
.catalog-card { border-radius: 12px; }.catalog-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }.catalog-head :deep(.el-tabs__header) { margin-bottom: 10px; }.authority { display: flex; align-items: center; gap: 7px; color: #746d61; font-size: 12px; white-space: nowrap; }.authority i { width: 8px; height: 8px; border-radius: 50%; background: #3aa570; }
.toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 165px auto 1fr; gap: 10px; align-items: center; margin: 6px 0 16px; }.result-count { justify-self: end; color: #847e73; font-size: 13px; }.primary-cell { display: grid; gap: 3px; }.primary-cell small { color: #918a7e; }.mobile-list { display: none; }.pager { justify-content: flex-end; margin-top: 16px; }
.boundary-note { display: flex; gap: 12px; padding: 14px 16px; border: 1px solid #e7e2da; border-radius: 10px; background: #fcfbf8; color: #746d61; font-size: 13px; }.boundary-note strong { color: #373126; white-space: nowrap; }
@media (max-width: 1050px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.catalog-head { align-items: flex-start; flex-direction: column; gap: 0; } }
@media (max-width: 720px) {
  .hero { align-items: stretch; flex-direction: column; padding: 18px; }.hero-state { align-self: flex-start; }.summary-grid { gap: 8px; }.summary-grid article { padding: 13px; }.summary-grid strong { font-size: 22px; }
  .toolbar { grid-template-columns: 1fr; }.result-count { justify-self: start; }.desktop-table { display: none; }.mobile-list { display: grid; gap: 10px; }.mobile-card { padding: 14px; border: 1px solid #e8e4dd; border-radius: 11px; background: #fff; }.mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.mobile-title > div { display: grid; gap: 4px; }.mobile-title small { color: #8a8377; }.mobile-card dl { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 7px 10px; margin: 14px 0 0; font-size: 12px; }.mobile-card dt { color: #938c81; }.mobile-card dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #443e34; }.boundary-note { flex-direction: column; gap: 5px; }
}
</style>
