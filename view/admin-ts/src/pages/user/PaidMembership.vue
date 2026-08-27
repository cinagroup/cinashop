<template>
  <div class="membership-page">
    <section class="hero">
      <div>
        <p class="eyebrow">PAID MEMBERSHIP · OPERATIONS</p>
        <h2>付费会员运营</h2>
        <p>管理套餐、权益、协议、会员卡批次与已支付会员记录。</p>
      </div>
      <div class="hero-actions"><el-button plain @click="openScan">激活二维码</el-button><el-button type="primary" @click="refreshActive">刷新当前视图</el-button></div>
    </section>

    <el-alert
      title="卡密只在新批次生成成功后显示一次"
      description="请立即下载并交由受控渠道保管。会员卡列表不会再次返回密码；线上支付需部署 Worker 并完成微信或支付宝商户配置。"
      type="warning"
      show-icon
      :closable="false"
    />

    <section class="summary-grid" aria-label="付费会员运营概览">
      <el-card shadow="never"><span>启用套餐</span><strong>{{ activePlanCount }}</strong></el-card>
      <el-card shadow="never"><span>卡片库存</span><strong>{{ batchTotals.cards }}</strong></el-card>
      <el-card shadow="never"><span>已兑换</span><strong>{{ batchTotals.used }}</strong></el-card>
      <el-card shadow="never"><span>会员记录</span><strong>{{ recordCount }}</strong></el-card>
    </section>

    <el-card class="workspace" shadow="never">
      <el-tabs v-model="activeTab" @tab-change="loadTab">
        <el-tab-pane label="会员套餐" name="plans">
          <div class="toolbar">
            <div><strong>会员套餐</strong><p>免费、周期与永久会员的运营目录</p></div>
            <el-button type="primary" @click="openPlan()">新增套餐</el-button>
          </div>
          <el-table :data="plans" v-loading="planLoading" stripe row-key="id" empty-text="暂无会员套餐">
            <el-table-column label="套餐" min-width="190">
              <template #default="{ row }"><strong>{{ row.title }}</strong><div class="sub mono">#{{ row.id }} · {{ planTypeLabel(row.type) }}</div></template>
            </el-table-column>
            <el-table-column label="有效期" width="120"><template #default="{ row }">{{ row.type === 'ever' ? '永久' : `${row.vip_day} 天` }}</template></el-table-column>
            <el-table-column label="价格" width="150"><template #default="{ row }"><strong>¥{{ row.pre_price }}</strong><div class="sub line-through">¥{{ row.price }}</div></template></el-table-column>
            <el-table-column label="推荐" width="90"><template #default="{ row }"><el-tag v-if="row.is_label" type="warning">推荐</el-tag><span v-else class="sub">—</span></template></el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }"><el-switch :model-value="row.is_del === 0" active-text="启用" inactive-text="停用" inline-prompt @change="togglePlan(row, $event)" /></template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openPlan(row)">编辑</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="卡批次" name="batches">
          <div class="toolbar">
            <div><strong>会员卡批次</strong><p>批量生成卡号与一次性密码，追踪计数漂移</p></div>
            <el-button type="primary" @click="openBatch()">新建批次并制卡</el-button>
          </div>
          <el-table :data="batches" v-loading="batchLoading" stripe row-key="id" empty-text="暂无会员卡批次">
            <el-table-column label="批次" min-width="220"><template #default="{ row }"><strong>{{ row.title }}</strong><div class="sub mono">#{{ row.id }} · {{ row.remark || '无备注' }}</div></template></el-table-column>
            <el-table-column label="卡片" width="160"><template #default="{ row }"><div>{{ row.actual_used_count }} / {{ row.actual_card_count }} 已兑换</div><el-tag v-if="row.counter_drift" type="danger" size="small">计数漂移</el-tag><div v-else class="sub">计数一致</div></template></el-table-column>
            <el-table-column label="权益期限" width="110"><template #default="{ row }">{{ row.use_day }} 天</template></el-table-column>
            <el-table-column label="状态" width="110"><template #default="{ row }"><el-switch :model-value="row.status === 1" active-text="启用" inactive-text="冻结" inline-prompt @change="toggleBatch(row, $event)" /></template></el-table-column>
            <el-table-column label="创建时间" width="170"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
            <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openCards(row)">查看卡片</el-button><el-button link @click="openBatch(row)">编辑</el-button></template></el-table-column>
          </el-table>
          <div class="pager"><el-pagination v-model:current-page="batchPage" :page-size="20" layout="prev, pager, next, total" :total="batchCount" @current-change="loadBatches" /></div>
        </el-tab-pane>

        <el-tab-pane label="会员权益" name="rights">
          <div class="toolbar">
            <div><strong>会员权益</strong><p>控制会员中心展示与积分等运行时参数</p></div>
            <el-button type="primary" @click="openRight()">新增权益</el-button>
          </div>
          <el-table :data="rights" v-loading="rightLoading" stripe row-key="id" empty-text="暂无会员权益">
            <el-table-column label="权益" min-width="220"><template #default="{ row }"><strong>{{ row.show_title }}</strong><div class="sub mono">{{ row.right_type }} · {{ row.title }}</div></template></el-table-column>
            <el-table-column prop="explain" label="说明" min-width="260" show-overflow-tooltip />
            <el-table-column prop="number" label="数值" width="90" />
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? '启用' : '停用' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openRight(row)">编辑</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="会员记录" name="records">
          <div class="record-filter">
            <el-input v-model="recordQuery.name" clearable placeholder="昵称 / 手机 / 订单号" @keyup.enter="resetRecords" />
            <el-select v-model="recordQuery.pay_type" clearable placeholder="全部支付方式"><el-option label="微信" value="weixin" /><el-option label="余额" value="yue" /><el-option label="支付宝" value="alipay" /></el-select>
            <el-button type="primary" @click="resetRecords">查询</el-button>
          </div>
          <el-table :data="records" v-loading="recordLoading" stripe row-key="id" empty-text="暂无已支付会员记录">
            <el-table-column label="用户" min-width="170"><template #default="{ row }"><strong>{{ row.username || `UID ${row.uid}` }}</strong><div class="sub">{{ row.phone || '未留手机号' }}</div></template></el-table-column>
            <el-table-column label="订单 / 套餐" min-width="220"><template #default="{ row }"><span class="mono">{{ row.order_id }}</span><div class="sub">{{ row.member_title }} · {{ row.vip_day === -1 ? '永久' : `${row.vip_day} 天` }}</div></template></el-table-column>
            <el-table-column label="金额" width="110"><template #default="{ row }">¥{{ row.pay_price }}</template></el-table-column>
            <el-table-column label="渠道" width="120"><template #default="{ row }">{{ row.pay_type || '卡密/免费' }}</template></el-table-column>
            <el-table-column label="卡号" width="175"><template #default="{ row }"><span class="mono">{{ row.code_masked || '—' }}</span></template></el-table-column>
            <el-table-column label="支付时间" width="170"><template #default="{ row }">{{ formatTime(row.pay_time) }}</template></el-table-column>
          </el-table>
          <div class="pager"><el-pagination v-model:current-page="recordPage" :page-size="20" layout="prev, pager, next, total" :total="recordCount" @current-change="loadRecords" /></div>
        </el-tab-pane>

        <el-tab-pane label="会员协议" name="agreement">
          <el-form class="agreement-form" label-position="top" @submit.prevent>
            <el-form-item label="协议标题"><el-input v-model="agreement.title" maxlength="200" show-word-limit /></el-form-item>
            <el-form-item label="协议内容"><el-input v-model="agreement.content" type="textarea" :rows="12" maxlength="200000" /></el-form-item>
            <div class="agreement-actions"><el-switch v-model="agreement.status" :active-value="1" :inactive-value="0" active-text="前台启用" /><el-button type="primary" :loading="agreementSaving" @click="saveAgreement">保存协议</el-button></div>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="planDialog" :title="planForm.id ? '编辑会员套餐' : '新增会员套餐'" width="min(560px, 94vw)" append-to-body>
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="套餐名称"><el-input v-model="planForm.title" maxlength="200" /></el-form-item>
          <el-form-item label="套餐类型"><el-select v-model="planForm.type" :disabled="planForm.id > 0"><el-option v-for="item in planTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          <el-form-item label="有效天数"><el-input-number v-model="planForm.vip_day" :min="1" :max="36500" :disabled="planForm.type === 'ever'" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="planForm.sort" :min="-99999" :max="99999" /></el-form-item>
          <el-form-item label="划线原价"><el-input v-model="planForm.price" :disabled="planForm.type === 'free'" /></el-form-item>
          <el-form-item label="优惠价"><el-input v-model="planForm.pre_price" :disabled="planForm.type === 'free'" /></el-form-item>
        </div>
        <el-form-item><el-checkbox v-model="planForm.is_label" :true-value="1" :false-value="0">标记为推荐套餐</el-checkbox></el-form-item>
      </el-form>
      <template #footer><el-button @click="planDialog = false">取消</el-button><el-button type="primary" :loading="planSaving" @click="savePlan">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="batchDialog" :title="batchForm.id ? '编辑会员卡批次' : '新建批次并制卡'" width="min(600px, 94vw)" append-to-body>
      <el-form label-position="top">
        <el-form-item label="批次名称"><el-input v-model="batchForm.title" maxlength="100" /></el-form-item>
        <div class="form-grid">
          <el-form-item v-if="!batchForm.id" label="制卡数量（最多 6000）"><el-input-number v-model="batchForm.total_num" :min="1" :max="6000" /></el-form-item>
          <el-form-item label="会员有效天数"><el-input-number v-model="batchForm.use_day" :min="1" :max="36500" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="batchForm.sort" :min="-99999" :max="99999" /></el-form-item>
          <el-form-item label="初始状态"><el-switch v-model="batchForm.status" :active-value="1" :inactive-value="0" active-text="启用" inactive-text="冻结" /></el-form-item>
        </div>
        <el-form-item label="备注"><el-input v-model="batchForm.remark" type="textarea" :rows="3" maxlength="512" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="batchDialog = false">取消</el-button><el-button type="primary" :loading="batchSaving" @click="saveBatch">{{ batchForm.id ? '保存' : '生成卡片' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="issuedDialog" title="一次性卡密清单" width="min(920px, 96vw)" append-to-body :close-on-click-modal="false" @closed="clearIssuedCards">
      <el-alert title="关闭后系统不会再次显示密码" type="error" show-icon :closable="false" />
      <div class="issued-actions"><span>本次生成 {{ issuedCards.length }} 张</span><el-button type="primary" @click="downloadIssuedCards">下载 CSV</el-button></div>
      <el-table :data="issuedCards.slice(0, 100)" height="420" stripe>
        <el-table-column type="index" width="70" label="#" />
        <el-table-column prop="card_number" label="卡号" min-width="240"><template #default="{ row }"><span class="mono">{{ row.card_number }}</span></template></el-table-column>
        <el-table-column prop="card_password" label="一次性密码" min-width="210"><template #default="{ row }"><span class="mono secret">{{ row.card_password }}</span></template></el-table-column>
      </el-table>
      <p v-if="issuedCards.length > 100" class="sub">页面仅预览前 100 张，CSV 包含全部 {{ issuedCards.length }} 张。</p>
    </el-dialog>

    <el-drawer v-model="cardDrawer" :title="`${selectedBatch?.title ?? ''} · 卡片`" size="min(860px, 100vw)" append-to-body>
      <div class="card-filter"><el-input v-model="cardQuery.card_number" clearable placeholder="搜索卡号" @keyup.enter="resetCards" /><el-select v-model="cardQuery.is_use" clearable placeholder="全部使用状态"><el-option label="未使用" :value="0" /><el-option label="已使用" :value="1" /></el-select><el-button type="primary" @click="resetCards">查询</el-button></div>
      <el-table :data="cards" v-loading="cardLoading" stripe row-key="id">
        <el-table-column label="卡号" min-width="220"><template #default="{ row }"><span class="mono">{{ row.card_number }}</span><div class="sub">密码已安全隐藏</div></template></el-table-column>
        <el-table-column label="使用人" min-width="160"><template #default="{ row }"><span>{{ row.username || '未使用' }}</span><div v-if="row.phone" class="sub">{{ row.phone }}</div></template></el-table-column>
        <el-table-column label="使用时间" width="170"><template #default="{ row }">{{ formatTime(row.use_time) }}</template></el-table-column>
        <el-table-column label="状态" width="105"><template #default="{ row }"><el-switch :model-value="row.status === 1" inline-prompt active-text="启用" inactive-text="冻结" @change="toggleCard(row, $event)" /></template></el-table-column>
      </el-table>
      <div class="pager"><el-pagination v-model:current-page="cardPage" :page-size="20" layout="prev, pager, next, total" :total="cardCount" @current-change="loadCards" /></div>
    </el-drawer>

    <el-dialog v-model="rightDialog" :title="rightForm.id ? '编辑会员权益' : '新增会员权益'" width="min(680px, 94vw)" append-to-body>
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="权益类型"><el-input v-model="rightForm.right_type" maxlength="100" /></el-form-item>
          <el-form-item label="内部名称"><el-input v-model="rightForm.title" maxlength="200" /></el-form-item>
          <el-form-item label="展示名称"><el-input v-model="rightForm.show_title" maxlength="255" /></el-form-item>
          <el-form-item label="权益数值"><el-input-number v-model="rightForm.number" :min="0" :max="2147483647" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="rightForm.sort" :min="-99999" :max="99999" /></el-form-item>
          <el-form-item label="状态"><el-switch v-model="rightForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
        </div>
        <el-form-item label="简要说明"><el-input v-model="rightForm.explain" maxlength="1024" /></el-form-item>
        <el-form-item label="详细内容"><el-input v-model="rightForm.content" type="textarea" :rows="5" maxlength="200000" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="rightDialog = false">取消</el-button><el-button type="primary" :loading="rightSaving" @click="saveRight">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="scanDialog" title="会员激活二维码" width="min(720px, 94vw)" append-to-body>
      <div v-loading="scanLoading" class="scan-grid">
        <section><h3>H5 激活</h3><img v-if="scan?.wechat_img" :src="scan.wechat_img" alt="H5 会员激活二维码" /><el-empty v-else description="预览模式不生成二维码" :image-size="90" /><p class="sub scan-url">{{ scan?.wechat_url }}</p></section>
        <section><h3>小程序激活</h3><img v-if="scan?.routine" :src="scan.routine" alt="小程序会员激活码" /><el-empty v-else :description="scan?.routine_status === 'unavailable' ? '微信接口暂不可用' : '尚未配置小程序凭据'" :image-size="90" /></section>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiMembershipScan,
  apiMembershipAgreement,
  apiMembershipBatches,
  apiMembershipCards,
  apiMembershipPlans,
  apiMembershipRecords,
  apiMembershipRights,
  apiSaveMembershipAgreement,
  apiSaveMembershipBatch,
  apiSaveMembershipPlan,
  apiSaveMembershipRight,
  apiSetMembershipBatchStatus,
  apiSetMembershipCardStatus,
  apiSetMembershipPlanStatus,
  type IssuedMembershipCard,
  type MembershipBatch,
  type MembershipCard,
  type MembershipPlan,
  type MembershipRecord,
  type MembershipRight,
  type MembershipScan,
} from "@/api/membership";

type TabName = "plans" | "batches" | "rights" | "records" | "agreement";
const activeTab = ref<TabName>("plans");
const plans = ref<MembershipPlan[]>([]);
const batches = ref<MembershipBatch[]>([]);
const rights = ref<MembershipRight[]>([]);
const records = ref<MembershipRecord[]>([]);
const cards = ref<MembershipCard[]>([]);
const planLoading = ref(false);
const batchLoading = ref(false);
const rightLoading = ref(false);
const recordLoading = ref(false);
const cardLoading = ref(false);
const batchPage = ref(1);
const batchCount = ref(0);
const recordPage = ref(1);
const recordCount = ref(0);
const cardPage = ref(1);
const cardCount = ref(0);
const selectedBatch = ref<MembershipBatch | null>(null);
const recordQuery = reactive({ name: "", pay_type: "" });
const cardQuery = reactive<{ card_number: string; is_use: "" | number }>({ card_number: "", is_use: "" });

const activePlanCount = computed(() => plans.value.filter((row) => row.is_del === 0).length);
const batchTotals = computed(() => batches.value.reduce((sum, row) => ({ cards: sum.cards + row.actual_card_count, used: sum.used + row.actual_used_count }), { cards: 0, used: 0 }));

const planTypes = [
  { value: "free", label: "免费体验" },
  { value: "month", label: "月度会员" },
  { value: "quarter", label: "季度会员" },
  { value: "year", label: "年度会员" },
  { value: "ever", label: "永久会员" },
] as const;
const planDialog = ref(false);
const planSaving = ref(false);
const planForm = reactive({ id: 0, type: "month" as MembershipPlan["type"], title: "", vip_day: 30, price: "0.00", pre_price: "0.00", is_label: 0, sort: 0 });
const batchDialog = ref(false);
const batchSaving = ref(false);
const batchForm = reactive({ id: 0, title: "", total_num: 100, use_day: 30, status: 0, sort: 0, remark: "" });
const issuedDialog = ref(false);
const issuedCards = ref<IssuedMembershipCard[]>([]);
const cardDrawer = ref(false);
const rightDialog = ref(false);
const rightSaving = ref(false);
const rightForm = reactive({ id: 0, right_type: "", title: "", show_title: "", image: "", explain: "", content: "", number: 1, sort: 0, status: 1 });
const agreement = reactive({ id: 0, title: "", content: "", status: 1, sort: 0 });
const agreementSaving = ref(false);
const scanDialog = ref(false);
const scanLoading = ref(false);
const scan = ref<MembershipScan | null>(null);

function formatTime(value: number) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value * 1000));
}
function planTypeLabel(type: string) { return planTypes.find((item) => item.value === type)?.label ?? type; }

async function loadPlans() { planLoading.value = true; try { const result = await apiMembershipPlans({ limit: 100 }); plans.value = result.list; } catch (error) { ElMessage.error(error instanceof Error ? error.message : "会员套餐加载失败"); } finally { planLoading.value = false; } }
async function loadBatches() { batchLoading.value = true; try { const result = await apiMembershipBatches({ page: batchPage.value, limit: 20 }); batches.value = result.list; batchCount.value = result.count; } catch (error) { ElMessage.error(error instanceof Error ? error.message : "会员卡批次加载失败"); } finally { batchLoading.value = false; } }
async function loadRights() { rightLoading.value = true; try { const result = await apiMembershipRights(); rights.value = result.list; } catch (error) { ElMessage.error(error instanceof Error ? error.message : "会员权益加载失败"); } finally { rightLoading.value = false; } }
async function loadRecords() { recordLoading.value = true; try { const result = await apiMembershipRecords({ ...recordQuery, page: recordPage.value, limit: 20 }); records.value = result.list; recordCount.value = result.count; } catch (error) { ElMessage.error(error instanceof Error ? error.message : "会员记录加载失败"); } finally { recordLoading.value = false; } }
async function loadAgreement() { try { const result = await apiMembershipAgreement(); if (result) Object.assign(agreement, { id: result.id, title: result.title, content: result.content ?? "", status: result.status, sort: result.sort }); } catch (error) { ElMessage.error(error instanceof Error ? error.message : "会员协议加载失败"); } }
async function loadCards() { if (!selectedBatch.value) return; cardLoading.value = true; try { const result = await apiMembershipCards(selectedBatch.value.id, { ...cardQuery, page: cardPage.value, limit: 20 }); cards.value = result.list; cardCount.value = result.count; } catch (error) { ElMessage.error(error instanceof Error ? error.message : "会员卡加载失败"); } finally { cardLoading.value = false; } }

function loadTab(name: string | number) {
  const tab = String(name) as TabName;
  if (tab === "plans") void loadPlans();
  if (tab === "batches") void loadBatches();
  if (tab === "rights") void loadRights();
  if (tab === "records") void loadRecords();
  if (tab === "agreement") void loadAgreement();
}
function refreshActive() { loadTab(activeTab.value); }
async function openScan() { scanDialog.value = true; scanLoading.value = true; try { scan.value = await apiMembershipScan(); } catch (error) { ElMessage.error(error instanceof Error ? error.message : "激活二维码加载失败"); } finally { scanLoading.value = false; } }
function resetRecords() { recordPage.value = 1; void loadRecords(); }
function resetCards() { cardPage.value = 1; void loadCards(); }

function openPlan(row?: MembershipPlan) {
  Object.assign(planForm, row ? { id: row.id, type: row.type, title: row.title, vip_day: row.vip_day, price: row.price, pre_price: row.pre_price, is_label: row.is_label, sort: row.sort } : { id: 0, type: "month", title: "", vip_day: 30, price: "0.00", pre_price: "0.00", is_label: 0, sort: 0 });
  planDialog.value = true;
}
async function savePlan() {
  if (!planForm.title.trim()) return ElMessage.warning("请填写套餐名称");
  planSaving.value = true;
  try {
    const payload = { ...planForm, vip_day: planForm.type === "ever" ? -1 : planForm.vip_day, price: planForm.type === "free" ? "0.00" : planForm.price, pre_price: planForm.type === "free" ? "0.00" : planForm.pre_price };
    await apiSaveMembershipPlan(planForm.id, payload);
    planDialog.value = false;
    ElMessage.success("会员套餐已保存");
    await loadPlans();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); } finally { planSaving.value = false; }
}
async function togglePlan(row: MembershipPlan, enabled: string | number | boolean) {
  const previous = row.is_del;
  row.is_del = enabled ? 0 : 1;
  try { await apiSetMembershipPlanStatus(row.id, row.is_del); ElMessage.success(row.is_del ? "套餐已停用" : "套餐已启用"); } catch (error) { row.is_del = previous; ElMessage.error(error instanceof Error ? error.message : "状态修改失败"); }
}

function openBatch(row?: MembershipBatch) {
  Object.assign(batchForm, row ? { id: row.id, title: row.title, total_num: row.total_num, use_day: row.use_day, status: row.status, sort: row.sort, remark: row.remark } : { id: 0, title: "", total_num: 100, use_day: 30, status: 0, sort: 0, remark: "" });
  batchDialog.value = true;
}
async function saveBatch() {
  if (!batchForm.title.trim()) return ElMessage.warning("请填写批次名称");
  if (!batchForm.id) await ElMessageBox.confirm(`确认生成 ${batchForm.total_num} 张会员卡？密码只显示一次。`, "一次性制卡确认", { type: "warning", confirmButtonText: "生成并显示卡密" });
  batchSaving.value = true;
  try {
    const result = await apiSaveMembershipBatch(batchForm.id, { ...batchForm });
    batchDialog.value = false;
    if (result.cards.length) { issuedCards.value = result.cards; issuedDialog.value = true; }
    ElMessage.success(result.cards.length ? "制卡成功，请立即下载卡密" : "批次已保存");
    await loadBatches();
  } catch (error) { if (error !== "cancel") ElMessage.error(error instanceof Error ? error.message : "保存失败"); } finally { batchSaving.value = false; }
}
async function toggleBatch(row: MembershipBatch, enabled: string | number | boolean) {
  const previous = row.status;
  row.status = enabled ? 1 : 0;
  try { await apiSetMembershipBatchStatus(row.id, row.status); ElMessage.success(row.status ? "批次已启用" : "批次已冻结"); } catch (error) { row.status = previous; ElMessage.error(error instanceof Error ? error.message : "状态修改失败"); }
}
function openCards(row: MembershipBatch) { selectedBatch.value = row; cardPage.value = 1; Object.assign(cardQuery, { card_number: "", is_use: "" }); cardDrawer.value = true; void loadCards(); }
async function toggleCard(row: MembershipCard, enabled: string | number | boolean) {
  const previous = row.status;
  row.status = enabled ? 1 : 0;
  try { await apiSetMembershipCardStatus(row, row.status); } catch (error) { row.status = previous; ElMessage.error(error instanceof Error ? error.message : "卡片状态修改失败"); }
}
function clearIssuedCards() { issuedCards.value = []; }
function downloadIssuedCards() {
  const rows = ["card_number,card_password", ...issuedCards.value.map((row) => `${row.card_number},${row.card_password}`)];
  const blob = new Blob(["\ufeff", rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `membership-cards-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function openRight(row?: MembershipRight) {
  Object.assign(rightForm, row ? { ...row } : { id: 0, right_type: "", title: "", show_title: "", image: "", explain: "", content: "", number: 1, sort: 0, status: 1 });
  rightDialog.value = true;
}
async function saveRight() {
  if (!rightForm.right_type.trim() || !rightForm.title.trim() || !rightForm.show_title.trim()) return ElMessage.warning("请完整填写权益类型和名称");
  rightSaving.value = true;
  try { await apiSaveMembershipRight(rightForm.id, { ...rightForm }); rightDialog.value = false; ElMessage.success("会员权益已保存"); await loadRights(); } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); } finally { rightSaving.value = false; }
}
async function saveAgreement() {
  if (!agreement.title.trim() || !agreement.content.trim()) return ElMessage.warning("请填写协议标题与内容");
  agreementSaving.value = true;
  try { await apiSaveMembershipAgreement({ ...agreement }); ElMessage.success("会员协议已保存"); } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); } finally { agreementSaving.value = false; }
}

onMounted(async () => { await Promise.all([loadPlans(), loadBatches(), loadRecords()]); });
</script>

<style scoped>
.membership-page { display: grid; gap: 18px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 28px; color: #fff; border-radius: 18px; background: radial-gradient(circle at 85% 0%, rgba(255,255,255,.19), transparent 34%), linear-gradient(135deg, #172554, #4338ca 56%, #7c3aed); box-shadow: 0 18px 45px rgba(49,46,129,.22); }
.hero h2 { margin: 4px 0 8px; font-size: 28px; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.hero p { margin: 0; opacity: .84; }
.eyebrow { letter-spacing: .14em; font-size: 12px; font-weight: 700; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.summary-grid :deep(.el-card__body) { display: grid; gap: 8px; }
.summary-grid span { color: #64748b; font-size: 13px; }
.summary-grid strong { color: #1e1b4b; font-size: 28px; }
.workspace { min-width: 0; }
.scan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; text-align: center; min-height: 260px; }
.scan-grid section { padding: 18px; border: 1px solid #e2e8f0; border-radius: 14px; }
.scan-grid img { width: min(100%, 240px); aspect-ratio: 1; object-fit: contain; }
.scan-url { word-break: break-all; }
.toolbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin: 4px 0 18px; }
.toolbar p { margin: 5px 0 0; color: #64748b; font-size: 13px; }
.sub { margin-top: 4px; color: #7c8799; font-size: 12px; }
.mono { font-family: "SFMono-Regular", Consolas, monospace; }
.secret { color: #9f1239; font-weight: 700; letter-spacing: .08em; }
.line-through { text-decoration: line-through; }
.pager { display: flex; justify-content: flex-end; padding-top: 18px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.record-filter, .card-filter { display: grid; grid-template-columns: minmax(220px, 1fr) 180px auto; gap: 10px; margin-bottom: 18px; }
.agreement-form { max-width: 820px; padding: 12px 4px; }
.agreement-actions, .issued-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.issued-actions { margin: 16px 0 12px; }
@media (max-width: 900px) {
  .summary-grid { grid-template-columns: repeat(2, 1fr); }
  .hero { padding: 22px; }
}
@media (max-width: 620px) {
  .membership-page { gap: 14px; }
  .hero, .toolbar { flex-direction: column; }
  .hero h2 { font-size: 24px; }
  .summary-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
  .summary-grid strong { font-size: 23px; }
  .form-grid, .record-filter, .card-filter { grid-template-columns: 1fr; }
  .agreement-actions { align-items: stretch; flex-direction: column; }
  :deep(.el-tabs__nav-wrap) { overflow-x: auto; }
}
</style>
