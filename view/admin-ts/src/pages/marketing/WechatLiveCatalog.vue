<template>
  <div class="live-page">
    <header class="page-head">
      <div>
        <p class="eyebrow">WECHAT MINI PROGRAM</p>
        <h2>小程序直播目录</h2>
        <p>查看从 PHP 迁移的直播间、直播商品与主播资料。</p>
      </div>
      <el-button type="primary" :loading="syncing" @click="syncStatus">同步微信状态</el-button>
    </header>

    <el-alert
      title="微信外部写操作暂未迁移"
      description="本页只提供目录读取和状态同步。创建或删除直播间、提交商品审核、导入直播商品等非幂等操作仍留在旧系统，避免队列重试时重复创建微信资源。"
      type="warning"
      show-icon
      :closable="false"
    />

    <section class="summary-grid" aria-label="直播目录概览">
      <article><span>直播间</span><strong>{{ counts.rooms }}</strong><small>本地目录</small></article>
      <article><span>直播商品</span><strong>{{ counts.goods }}</strong><small>审核状态只读</small></article>
      <article><span>主播</span><strong>{{ counts.anchors }}</strong><small>角色同步未迁移</small></article>
      <article class="boundary"><span>运行边界</span><strong>只读 + 同步</strong><small>无微信资源写入</small></article>
    </section>

    <el-card shadow="never" class="catalog-card">
      <el-tabs v-model="activeTab" @tab-change="changeTab">
        <el-tab-pane label="直播间" name="rooms" />
        <el-tab-pane label="直播商品" name="goods" />
        <el-tab-pane label="主播" name="anchors" />
      </el-tabs>

      <div class="toolbar">
        <div>
          <strong>{{ tabTitle }}</strong>
          <p>{{ tabNote }}</p>
        </div>
        <div class="filters">
          <el-select v-if="activeTab === 'rooms'" v-model="roomStatus" aria-label="筛选直播状态" @change="resetAndLoad">
            <el-option label="全部状态" :value="0" />
            <el-option label="直播中" :value="1" />
            <el-option label="未开始" :value="2" />
            <el-option label="已结束" :value="3" />
          </el-select>
          <el-select v-if="activeTab === 'goods'" v-model="goodsStatus" aria-label="筛选审核状态" @change="resetAndLoad">
            <el-option label="全部审核状态" :value="99" />
            <el-option label="审核通过" :value="1" />
            <el-option label="审核中" :value="0" />
            <el-option label="审核失败" :value="-1" />
          </el-select>
          <el-input v-model="keyword" clearable :placeholder="searchPlaceholder" aria-label="搜索直播目录" @clear="resetAndLoad" @keyup.enter="resetAndLoad">
            <template #append><el-button @click="resetAndLoad">查询</el-button></template>
          </el-input>
        </div>
      </div>

      <div class="desktop-table">
        <el-table v-if="activeTab === 'rooms'" :data="rooms" v-loading="loading" stripe row-key="id" empty-text="暂无直播间">
          <el-table-column label="直播间" min-width="260">
            <template #default="{ row }"><strong>{{ row.name }}</strong><div class="sub-text mono">room_id: {{ row.room_id || '-' }}</div></template>
          </el-table-column>
          <el-table-column label="主播" min-width="170"><template #default="{ row }">{{ row.anchor_name || '-' }}<div class="sub-text">{{ row.anchor_wechat || '-' }}</div></template></el-table-column>
          <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag :type="roomTone(row.live_status)">{{ roomStatusText(row.live_status) }}</el-tag></template></el-table-column>
          <el-table-column label="开播时间" min-width="180"><template #default="{ row }">{{ formatTime(row.start_time) }}</template></el-table-column>
          <el-table-column label="展示" width="90"><template #default="{ row }"><el-tag :type="row.is_show ? 'success' : 'info'" effect="plain">{{ row.is_show ? '展示' : '隐藏' }}</el-tag></template></el-table-column>
        </el-table>

        <el-table v-else-if="activeTab === 'goods'" :data="goods" v-loading="loading" stripe row-key="id" empty-text="暂无直播商品">
          <el-table-column label="商品" min-width="260"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="sub-text mono">product_id: {{ row.product_id }} · goods_id: {{ row.goods_id || '-' }}</div></template></el-table-column>
          <el-table-column label="直播价" width="145"><template #default="{ row }">¥{{ row.price }}<div v-if="row.price_type === 2" class="sub-text">至 ¥{{ row.price2 }}</div></template></el-table-column>
          <el-table-column label="审核" width="120"><template #default="{ row }"><el-tag :type="goodsTone(row.audit_status)">{{ goodsStatusText(row.audit_status) }}</el-tag></template></el-table-column>
          <el-table-column label="本地展示" width="105"><template #default="{ row }"><el-tag :type="row.is_show ? 'success' : 'info'" effect="plain">{{ row.is_show ? '展示' : '隐藏' }}</el-tag></template></el-table-column>
          <el-table-column label="加入时间" min-width="180"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
        </el-table>

        <el-table v-else :data="anchors" v-loading="loading" stripe row-key="id" empty-text="暂无主播">
          <el-table-column label="主播" min-width="220"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="sub-text mono">#{{ row.id }}</div></template></el-table-column>
          <el-table-column prop="wechat" label="微信号" min-width="190" />
          <el-table-column prop="phone" label="手机号" min-width="160" />
          <el-table-column label="展示" width="100"><template #default="{ row }"><el-tag :type="row.is_show ? 'success' : 'info'">{{ row.is_show ? '已启用' : '已停用' }}</el-tag></template></el-table-column>
          <el-table-column label="创建时间" min-width="180"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
        </el-table>
      </div>

      <div class="mobile-list" v-loading="loading">
        <article v-for="row in mobileRows" :key="`${activeTab}-${row.id}`" class="mobile-card">
          <div class="mobile-title">
            <div><strong>{{ rowTitle(row) }}</strong><span class="mono">{{ rowIdentity(row) }}</span></div>
            <el-tag :type="rowTone(row)">{{ rowState(row) }}</el-tag>
          </div>
          <p>{{ rowDetail(row) }}</p>
          <small>{{ formatTime(rowTimestamp(row)) }}</small>
        </article>
        <el-empty v-if="!mobileRows.length && !loading" description="暂无数据" />
      </div>

      <el-pagination class="pager" background layout="prev, pager, next" :current-page="page" :page-size="20" :total="activeCount" @current-change="changePage" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiWechatLiveAnchors, apiWechatLiveGoods, apiWechatLiveRooms, apiWechatLiveSync, type WechatLiveAnchor, type WechatLiveGood, type WechatLiveRoom } from "@/api/wechatLive";

type TabName = "rooms" | "goods" | "anchors";
type CatalogRow = WechatLiveRoom | WechatLiveGood | WechatLiveAnchor;

const activeTab = ref<TabName>("rooms");
const keyword = ref("");
const roomStatus = ref(0);
const goodsStatus = ref(99);
const page = ref(1);
const loading = ref(false);
const syncing = ref(false);
const rooms = ref<WechatLiveRoom[]>([]);
const goods = ref<WechatLiveGood[]>([]);
const anchors = ref<WechatLiveAnchor[]>([]);
const counts = reactive({ rooms: 0, goods: 0, anchors: 0 });

const tabTitle = computed(() => ({ rooms: "直播间状态", goods: "直播商品审核", anchors: "主播资料" })[activeTab.value]);
const tabNote = computed(() => ({ rooms: "状态由定时队列从微信读取后写回本地。", goods: "审核状态只同步，不在 Worker 中提交或删除商品。", anchors: "保留旧系统主播目录，不修改微信主播角色。" })[activeTab.value]);
const searchPlaceholder = computed(() => ({ rooms: "名称、主播或微信号", goods: "名称、商品 ID", anchors: "姓名、微信号或手机号" })[activeTab.value]);
const activeCount = computed(() => counts[activeTab.value]);
const mobileRows = computed<CatalogRow[]>(() => ({ rooms: rooms.value, goods: goods.value, anchors: anchors.value })[activeTab.value]);

function formatTime(timestamp: number) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function roomStatusText(status: number) {
  if ([101, 105, 106].includes(status)) return "直播中";
  if (status === 102) return "未开始";
  if ([103, 104, 107].includes(status)) return "已结束";
  return `未知 ${status}`;
}

function roomTone(status: number): "danger" | "warning" | "info" {
  if ([101, 105, 106].includes(status)) return "danger";
  if (status === 102) return "warning";
  return "info";
}

function goodsStatusText(status: number) {
  if (status === 2) return "审核通过";
  if (status === 3) return "审核失败";
  return "审核中";
}

function goodsTone(status: number): "success" | "danger" | "warning" {
  if (status === 2) return "success";
  if (status === 3) return "danger";
  return "warning";
}

function isRoom(row: CatalogRow): row is WechatLiveRoom { return "room_id" in row; }
function isGood(row: CatalogRow): row is WechatLiveGood { return "goods_id" in row; }
function rowTitle(row: CatalogRow) { return row.name || `#${row.id}`; }
function rowIdentity(row: CatalogRow) {
  if (isRoom(row)) return `room_id: ${row.room_id || "-"}`;
  if (isGood(row)) return `product_id: ${row.product_id}`;
  return row.wechat || `#${row.id}`;
}
function rowState(row: CatalogRow) {
  if (isRoom(row)) return roomStatusText(row.live_status);
  if (isGood(row)) return goodsStatusText(row.audit_status);
  return row.is_show ? "已启用" : "已停用";
}
function rowTone(row: CatalogRow): "success" | "danger" | "warning" | "info" {
  if (isRoom(row)) return roomTone(row.live_status);
  if (isGood(row)) return goodsTone(row.audit_status);
  return row.is_show ? "success" : "info";
}
function rowDetail(row: CatalogRow) {
  if (isRoom(row)) return `主播 ${row.anchor_name || "-"} · ${row.anchor_wechat || "未绑定微信号"}`;
  if (isGood(row)) return `直播价 ¥${row.price}${row.price_type === 2 ? ` - ¥${row.price2}` : ""}`;
  return `${row.phone || "未登记手机号"} · ${row.is_show ? "本地展示" : "本地隐藏"}`;
}
function rowTimestamp(row: CatalogRow) { return isRoom(row) ? row.start_time : row.add_time; }

async function loadActive() {
  loading.value = true;
  try {
    const base = { page: page.value, limit: 20, keyword: keyword.value || undefined };
    if (activeTab.value === "rooms") {
      const result = await apiWechatLiveRooms({ ...base, status: roomStatus.value });
      rooms.value = result.list; counts.rooms = result.count;
    } else if (activeTab.value === "goods") {
      const result = await apiWechatLiveGoods({ ...base, status: goodsStatus.value });
      goods.value = result.list; counts.goods = result.count;
    } else {
      const result = await apiWechatLiveAnchors(base);
      anchors.value = result.list; counts.anchors = result.count;
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "直播目录加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadCounts() {
  const [roomResult, goodsResult, anchorResult] = await Promise.all([
    apiWechatLiveRooms({ page: 1, limit: 1, status: 0 }),
    apiWechatLiveGoods({ page: 1, limit: 1, status: 99 }),
    apiWechatLiveAnchors({ page: 1, limit: 1 }),
  ]);
  counts.rooms = roomResult.count; counts.goods = goodsResult.count; counts.anchors = anchorResult.count;
}

async function changeTab(name: string | number) { activeTab.value = String(name) as TabName; page.value = 1; keyword.value = ""; await loadActive(); }
async function resetAndLoad() { page.value = 1; await loadActive(); }
async function changePage(next: number) { page.value = next; await loadActive(); }

async function syncStatus() {
  syncing.value = true;
  try {
    const result = await apiWechatLiveSync();
    ElMessage.success(`已排队 ${result.jobs.length} 个只读同步任务`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "状态同步入队失败");
  } finally {
    syncing.value = false;
  }
}

onMounted(async () => {
  try { await loadCounts(); } catch { /* 当前标签仍会给出明确错误 */ }
  await loadActive();
});
</script>

<style scoped>
.live-page { display: grid; gap: 16px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px; border: 1px solid #e5e9f0; border-radius: 14px; background: linear-gradient(135deg, #fff 0%, #f2f8ff 100%); }
.page-head h2 { margin: 2px 0 8px; color: #172033; font-size: 24px; }
.page-head p { margin: 0; color: #6f7a8e; }
.eyebrow { color: #2f70d0 !important; font-size: 11px; font-weight: 700; letter-spacing: .14em; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.summary-grid article { display: grid; gap: 5px; padding: 18px; border: 1px solid #e7eaf0; border-radius: 12px; background: #fff; }
.summary-grid span, .summary-grid small { color: #7d8799; }
.summary-grid strong { color: #1d2a3f; font-size: 25px; }
.summary-grid .boundary { background: #172c4a; border-color: #172c4a; }
.summary-grid .boundary span, .summary-grid .boundary small { color: #b8c7dd; }
.summary-grid .boundary strong { color: #fff; font-size: 18px; }
.catalog-card { border-radius: 12px; }
.toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.toolbar p { margin: 6px 0 0; color: #8791a3; font-size: 12px; }
.filters { display: flex; gap: 10px; }
.filters .el-select { width: 160px; }
.filters .el-input { width: 300px; }
.sub-text { margin-top: 5px; color: #8a94a5; font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.pager { justify-content: flex-end; margin-top: 18px; }
.mobile-list { display: none; }
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .toolbar { flex-direction: column; }
  .filters, .filters .el-input { width: 100%; }
}
@media (max-width: 720px) {
  .page-head { flex-direction: column; padding: 18px; }
  .page-head .el-button { width: 100%; }
  .summary-grid { gap: 8px; }
  .summary-grid article { padding: 13px; }
  .summary-grid strong { font-size: 21px; }
  .summary-grid .boundary strong { font-size: 15px; }
  .filters { flex-direction: column; }
  .filters .el-select { width: 100%; }
  .desktop-table { display: none; }
  .mobile-list { display: grid; gap: 10px; min-height: 80px; }
  .mobile-card { padding: 14px; border: 1px solid #e7eaf0; border-radius: 10px; background: #fff; }
  .mobile-card p { margin: 10px 0; color: #6f7a8e; font-size: 12px; line-height: 1.55; }
  .mobile-card small { color: #99a2b2; }
  .mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .mobile-title strong, .mobile-title span { display: block; }
  .mobile-title span { margin-top: 4px; color: #8a94a5; font-size: 11px; }
  .pager { justify-content: center; }
}
</style>
