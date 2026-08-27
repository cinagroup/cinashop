<template>
  <div class="channel-page">
    <div class="page-head">
      <div>
        <div class="eyebrow">WECHAT OFFICIAL ACCOUNT</div>
        <h2>渠道二维码</h2>
        <p>管理投放渠道、推广员、用户标签与扫码转化，保留旧系统的永久二维码数据结构。</p>
      </div>
      <div class="head-actions">
        <el-button @click="categoryVisible = true">分类管理</el-button>
        <el-button type="primary" @click="openForm()">＋ 新建渠道码</el-button>
      </div>
    </div>

    <el-alert
      title="二维码由队列异步生成；保存后显示“生成中”时可手动重试。公众号扫码回调尚未启用，本批次只恢复目录、生成任务与历史统计读取。"
      type="warning"
      :closable="false"
      show-icon
    />

    <div class="summary-grid">
      <div class="summary-card"><span>渠道总数</span><strong>{{ total }}</strong><small>当前筛选结果</small></div>
      <div class="summary-card green"><span>累计关注</span><strong>{{ summary.follow }}</strong><small>当前页汇总</small></div>
      <div class="summary-card blue"><span>累计扫码</span><strong>{{ summary.scan }}</strong><small>当前页汇总</small></div>
      <div class="summary-card amber"><span>待生成</span><strong>{{ summary.pending }}</strong><small>可安全重试</small></div>
    </div>

    <el-card shadow="never" class="content-card">
      <div class="filters">
        <el-input v-model="query.name" clearable placeholder="搜索渠道码名称" @keyup.enter="load" />
        <el-select v-model="query.cate_id" clearable placeholder="全部分类">
          <el-option v-for="item in categories" :key="item.id" :label="item.cate_name" :value="item.id" />
        </el-select>
        <el-select v-model="query.status" clearable placeholder="全部状态">
          <el-option label="启用" :value="1" /><el-option label="停用" :value="0" />
        </el-select>
        <el-button type="primary" @click="load">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </div>

      <el-table :data="list" v-loading="loading" border class="desktop-table">
        <el-table-column label="渠道" min-width="260">
          <template #default="{ row }">
            <div class="channel-cell">
              <div class="qr-thumb" :class="{ pending: row.provisioning !== 'ready' }">
                <el-image v-if="row.image" :src="row.image" fit="cover"><template #error><span>码</span></template></el-image>
                <span v-else>···</span>
              </div>
              <div><strong>{{ row.name }}</strong><small>{{ row.cateName || "未分类" }} · ID {{ row.id }}</small></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="推广员" min-width="165">
          <template #default="{ row }"><strong>{{ row.nickname || `UID ${row.uid}` }}</strong><small class="block">UID {{ row.uid }}</small></template>
        </el-table-column>
        <el-table-column label="标签" min-width="180">
          <template #default="{ row }"><el-tag v-for="name in row.label_name" :key="name" size="small" effect="plain" class="tag">{{ name }}</el-tag></template>
        </el-table-column>
        <el-table-column label="转化" width="140">
          <template #default="{ row }"><div class="metric-pair"><span>扫码 <b>{{ row.scan }}</b></span><span>关注 <b>{{ row.follow }}</b></span></div></template>
        </el-table-column>
        <el-table-column label="二维码" width="110">
          <template #default="{ row }"><el-tag :type="row.provisioning === 'ready' ? 'success' : 'warning'">{{ row.provisioning === "ready" ? "已就绪" : "生成中" }}</el-tag></template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'" effect="plain">{{ row.status === 1 ? "启用" : "停用" }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="292" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openStatistics(row)">统计</el-button>
            <el-button link type="primary" @click="openUsers(row)">用户</el-button>
            <el-button link type="primary" @click="openForm(row)">编辑</el-button>
            <el-button v-if="row.provisioning !== 'ready'" link type="warning" @click="retryProvision(row)">重试</el-button>
            <el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleStatus(row)">{{ row.status === 1 ? "停用" : "启用" }}</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-loading="loading" class="mobile-list">
        <article v-for="row in list" :key="row.id" class="mobile-card">
          <div class="mobile-title"><div><strong>{{ row.name }}</strong><small>{{ row.cateName }} · UID {{ row.uid }}</small></div><el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? "启用" : "停用" }}</el-tag></div>
          <div class="mobile-metrics"><span>扫码 <b>{{ row.scan }}</b></span><span>关注 <b>{{ row.follow }}</b></span><span>昨日 <b>{{ row.y_follow }}</b></span></div>
          <div><el-tag v-for="name in row.label_name" :key="name" size="small" effect="plain" class="tag">{{ name }}</el-tag></div>
          <div class="mobile-actions"><el-button @click="openStatistics(row)">统计</el-button><el-button @click="openUsers(row)">用户</el-button><el-button type="primary" plain @click="openForm(row)">编辑</el-button><el-button v-if="row.provisioning !== 'ready'" type="warning" plain @click="retryProvision(row)">重试生成</el-button></div>
        </article>
      </div>
      <el-empty v-if="!loading && !list.length" description="暂无渠道二维码" />
      <div class="pagination"><el-pagination v-model:current-page="query.page" :page-size="query.limit" :total="total" layout="prev, pager, next, total" @current-change="load" /></div>
    </el-card>

    <el-dialog v-model="formVisible" :title="form.id ? '编辑渠道二维码' : '新建渠道二维码'" width="min(760px, 95vw)" destroy-on-close>
      <el-form :model="form" label-width="110px" class="channel-form">
        <div class="form-grid">
          <el-form-item label="渠道名称" required><el-input v-model="form.name" maxlength="255" show-word-limit /></el-form-item>
          <el-form-item label="所属分类" required><el-select v-model="form.cateId" style="width:100%"><el-option v-for="item in categories" :key="item.id" :label="item.cate_name" :value="item.id" /></el-select></el-form-item>
          <el-form-item label="推广员" required>
            <el-select v-model="form.uid" filterable remote :remote-method="searchPromoters" :loading="promoterLoading" style="width:100%" placeholder="输入 UID 或选择推广员">
              <el-option v-for="item in promoters" :key="item.uid" :label="`${item.nickname} · UID ${item.uid}`" :value="item.uid" />
            </el-select>
          </el-form-item>
          <el-form-item label="用户标签" required><el-select v-model="form.labelIds" multiple filterable collapse-tags style="width:100%"><el-option v-for="item in activeLabels" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
          <el-form-item label="有效期"><el-input-number v-model="form.time" :min="0" :max="10000" /><span class="field-hint">天，0 表示永久</span></el-form-item>
          <el-form-item label="状态"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /></el-form-item>
        </div>

        <el-divider content-position="left">扫码自动回复</el-divider>
        <el-form-item label="回复类型" required><el-radio-group v-model="form.type"><el-radio-button value="text">文字</el-radio-button><el-radio-button value="image">图片</el-radio-button><el-radio-button value="voice">语音</el-radio-button><el-radio-button value="news">图文</el-radio-button><el-radio-button value="url">链接</el-radio-button></el-radio-group></el-form-item>
        <el-form-item v-if="form.type === 'text'" label="回复内容" required><el-input v-model="form.text" type="textarea" :rows="4" maxlength="20000" show-word-limit /></el-form-item>
        <template v-else-if="form.type === 'image' || form.type === 'voice'">
          <el-alert title="仅可使用已迁移且类型匹配的公众号素材 media_id。" type="info" :closable="false" class="inline-alert" />
          <el-form-item label="素材 media_id" required><el-input v-model="form.mediaId" maxlength="64" /></el-form-item>
          <el-form-item label="素材路径"><el-input v-model="form.mediaPath" maxlength="128" placeholder="可选，用于管理端预览" /></el-form-item>
        </template>
        <template v-else-if="form.type === 'news'">
          <el-form-item label="文章 ID"><el-input-number v-model="form.newsId" :min="0" /></el-form-item>
          <el-form-item label="图文标题" required><el-input v-model="form.newsTitle" maxlength="255" /></el-form-item>
          <el-form-item label="图文摘要"><el-input v-model="form.newsSynopsis" type="textarea" :rows="2" maxlength="500" /></el-form-item>
          <el-form-item label="封面图片"><el-input v-model="form.newsImage" maxlength="255" /></el-form-item>
          <el-form-item label="图文链接" required><el-input v-model="form.newsUrl" maxlength="2000" placeholder="https://... 或选择已有文章后使用站内链接" /></el-form-item>
        </template>
        <el-form-item v-else label="链接地址" required><el-input v-model="form.url" maxlength="2000" placeholder="https://..." /></el-form-item>
      </el-form>
      <template #footer><el-button @click="formVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存并提交生成</el-button></template>
    </el-dialog>

    <el-dialog v-model="categoryVisible" title="渠道码分类" width="min(620px, 94vw)">
      <div class="category-create"><el-input v-model="categoryForm.name" maxlength="30" placeholder="输入分类名称" @keyup.enter="saveCategory" /><el-button type="primary" @click="saveCategory">{{ categoryForm.id ? "保存修改" : "新增分类" }}</el-button><el-button v-if="categoryForm.id" @click="resetCategoryForm">取消</el-button></div>
      <el-table :data="categories" border>
        <el-table-column prop="cate_name" label="分类名称" />
        <el-table-column label="操作" width="140"><template #default="{ row }"><el-button link type="primary" @click="editCategory(row)">编辑</el-button><el-button link type="danger" @click="removeCategory(row)">删除</el-button></template></el-table-column>
      </el-table>
    </el-dialog>

    <el-drawer v-model="usersVisible" :title="`${activeChannel?.name ?? ''} · 扫码用户`" size="min(720px, 96vw)">
      <el-table :data="users" v-loading="usersLoading" border>
        <el-table-column label="用户" min-width="180"><template #default="{ row }"><strong>{{ row.nickname || `UID ${row.uid}` }}</strong><small class="block">UID {{ row.uid }} · {{ row.userType || "未知来源" }}</small></template></el-table-column>
        <el-table-column label="关注" width="90"><template #default="{ row }"><el-tag :type="row.isFollow ? 'success' : 'info'">{{ row.isFollow ? "已关注" : "未关注" }}</el-tag></template></el-table-column>
        <el-table-column label="最近扫码" width="180"><template #default="{ row }">{{ formatEpoch(row.lastScanTime) }}</template></el-table-column>
      </el-table>
      <el-empty v-if="!usersLoading && !users.length" description="暂无历史扫码用户" />
    </el-drawer>

    <el-drawer v-model="statisticsVisible" :title="`${activeChannel?.name ?? ''} · 转化统计`" size="min(760px, 96vw)">
      <div class="stats-toolbar"><el-date-picker v-model="statsDates" type="daterange" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" /><el-button type="primary" :loading="statsLoading" @click="loadStatistics">刷新</el-button></div>
      <div v-if="statistics" class="stats-summary"><div><span>累计扫码</span><strong>{{ statistics.all_scan }}</strong></div><div><span>累计关注</span><strong>{{ statistics.all_follow }}</strong></div><div><span>昨日扫码</span><strong>{{ statistics.y_scan }}</strong></div><div><span>昨日关注</span><strong>{{ statistics.y_follow }}</strong></div></div>
      <div v-if="statistics" class="trend-list">
        <div v-for="(label, index) in statistics.trend.xAxis" :key="label" class="trend-row">
          <span>{{ label }}</span><div class="bars"><i class="bar scan" :style="{ width: barWidth(statistics.trend.series[1]?.data[index] ?? 0) }"></i><i class="bar follow" :style="{ width: barWidth(statistics.trend.series[0]?.data[index] ?? 0) }"></i></div><small>{{ statistics.trend.series[1]?.data[index] ?? 0 }} / {{ statistics.trend.series[0]?.data[index] ?? 0 }}</small>
        </div>
        <div class="legend"><span><i class="dot scan"></i>扫码</span><span><i class="dot follow"></i>关注</span></div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiChannelCategoryDelete, apiChannelCategoryList, apiChannelCategorySave, apiChannelDelete,
  apiChannelDetail, apiChannelLabels, apiChannelList, apiChannelPromoters, apiChannelProvision,
  apiChannelSave, apiChannelStatistics, apiChannelStatus, apiChannelUsers,
  type ChannelCategory, type ChannelDetail, type ChannelItem, type ChannelLabel,
  type ChannelPromoter, type ChannelReplyType, type ChannelStatistics, type ChannelUser,
} from "@/api/wechatQrcode";

const list = ref<ChannelItem[]>([]);
const total = ref(0);
const loading = ref(false);
const categories = ref<ChannelCategory[]>([]);
const labels = ref<ChannelLabel[]>([]);
const promoters = ref<ChannelPromoter[]>([]);
const promoterLoading = ref(false);
const query = reactive<{ page: number; limit: number; name: string; cate_id?: number; status?: number }>({ page: 1, limit: 20, name: "" });
const summary = computed(() => ({ follow: list.value.reduce((sum, row) => sum + row.follow, 0), scan: list.value.reduce((sum, row) => sum + row.scan, 0), pending: list.value.filter((row) => row.provisioning !== "ready").length }));
const activeLabels = computed(() => labels.value.filter((item) => item.status === 1 && (item.type ?? 0) === 0 && (item.relationId ?? 0) === 0));

function blankForm() { return { id: 0, name: "", cateId: 0, uid: 0, labelIds: [] as number[], time: 0, status: 1, type: "text" as ChannelReplyType, text: "", mediaId: "", mediaPath: "", newsId: 0, newsTitle: "", newsSynopsis: "", newsImage: "", newsUrl: "", url: "" }; }
const form = reactive(blankForm());
const formVisible = ref(false);
const saving = ref(false);
const categoryVisible = ref(false);
const categoryForm = reactive({ id: 0, name: "" });
const usersVisible = ref(false);
const usersLoading = ref(false);
const users = ref<ChannelUser[]>([]);
const statisticsVisible = ref(false);
const statsLoading = ref(false);
const statistics = ref<ChannelStatistics | null>(null);
const statsDates = ref<[Date, Date]>([new Date(Date.now() - 6 * 86_400_000), new Date()]);
const activeChannel = ref<ChannelItem | null>(null);

function formatEpoch(value: number) { return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function dateText(date: Date) { const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, "0"); const day = String(date.getDate()).padStart(2, "0"); return `${year}-${month}-${day}`; }
function resetQuery() { query.name = ""; query.cate_id = undefined; query.status = undefined; query.page = 1; void load(); }
function resetCategoryForm() { categoryForm.id = 0; categoryForm.name = ""; }
function editCategory(row: ChannelCategory) { categoryForm.id = row.id; categoryForm.name = row.cate_name; }
function barWidth(value: number) { const max = Math.max(1, ...((statistics.value?.trend.series ?? []).flatMap((item) => item.data))); return `${Math.max(3, Math.round(value / max * 100))}%`; }

async function load() { loading.value = true; try { const result = await apiChannelList({ ...query }); list.value = result.list; total.value = result.count; } catch (error) { ElMessage.error((error as Error).message || "加载渠道二维码失败"); } finally { loading.value = false; } }
async function loadOptions() { try { const [categoryResult, labelResult, promoterResult] = await Promise.all([apiChannelCategoryList(), apiChannelLabels(), apiChannelPromoters()]); categories.value = categoryResult.data; labels.value = labelResult; promoters.value = promoterResult; } catch (error) { ElMessage.error((error as Error).message || "加载表单选项失败"); } }
async function searchPromoters(keyword: string) { promoterLoading.value = true; try { promoters.value = await apiChannelPromoters(keyword); } finally { promoterLoading.value = false; } }

async function openForm(row?: ChannelItem) {
  Object.assign(form, blankForm()); formVisible.value = true;
  if (!row) { form.cateId = categories.value[0]?.id ?? 0; return; }
  try {
    const detail = (await apiChannelDetail(row.id)).info;
    Object.assign(form, { id: detail.id, name: detail.name, cateId: detail.cate_id, uid: detail.uid, labelIds: detail.labelIds, time: detail.time, status: detail.status, type: detail.type });
    if (!promoters.value.some((item) => item.uid === detail.uid)) promoters.value.push({ uid: detail.uid, nickname: detail.nickname, avatar: detail.avatar, status: 1 });
    fillReply(detail);
  } catch (error) { formVisible.value = false; ElMessage.error((error as Error).message || "加载渠道码详情失败"); }
}

function fillReply(detail: ChannelDetail) {
  const data = detail.data ?? detail.content ?? {};
  if (detail.type === "text") form.text = String(data.content ?? "");
  else if (detail.type === "url") form.url = String(data.content ?? "");
  else if (detail.type === "image" || detail.type === "voice") { form.mediaId = String(data.media_id ?? ""); form.mediaPath = String(data.src ?? ""); }
  else { form.newsId = Number(data.id ?? 0); form.newsTitle = String(data.title ?? ""); form.newsSynopsis = String(data.synopsis ?? ""); form.newsImage = String(data.image ?? ""); form.newsUrl = String(data.url ?? ""); }
}

function replyContent(): Record<string, unknown> {
  if (form.type === "text") return { content: form.text };
  if (form.type === "url") return { content: form.url };
  if (form.type === "image" || form.type === "voice") return { media_id: form.mediaId, src: form.mediaPath };
  return { list: { id: form.newsId, title: form.newsTitle, synopsis: form.newsSynopsis, image: form.newsImage, image_input: form.newsImage ? [form.newsImage] : [], url: form.newsUrl } };
}

async function save() {
  if (!form.name.trim() || !form.cateId || !form.uid || !form.labelIds.length) return ElMessage.error("请完整填写名称、分类、推广员和用户标签");
  if (form.type === "text" && !form.text) return ElMessage.error("请填写文字回复");
  if ((form.type === "image" || form.type === "voice") && !form.mediaId.trim()) return ElMessage.error("请填写素材 media_id");
  if (form.type === "news" && (!form.newsTitle.trim() || !form.newsUrl.trim())) return ElMessage.error("请填写图文标题和链接");
  if (form.type === "url" && !/^https?:\/\//i.test(form.url)) return ElMessage.error("请输入完整的 HTTP 或 HTTPS 链接");
  saving.value = true;
  try {
    const result = await apiChannelSave(form.id, { uid: form.uid, name: form.name, cate_id: form.cateId, label_id: form.labelIds, type: form.type, content: replyContent(), time: form.time, status: form.status });
    ElMessage.success(result.provisioning === "ready" ? "渠道码已保存" : result.queued ? "已保存，二维码生成任务已提交" : "已保存，请稍后重试二维码生成");
    formVisible.value = false; await load();
  } catch (error) { ElMessage.error((error as Error).message || "保存失败"); } finally { saving.value = false; }
}

async function toggleStatus(row: ChannelItem) { try { await apiChannelStatus(row.id, row.status === 1 ? 0 : 1); ElMessage.success("状态已更新"); await load(); } catch (error) { ElMessage.error((error as Error).message || "操作失败"); } }
async function retryProvision(row: ChannelItem) { try { const result = await apiChannelProvision(row.id); ElMessage.success(result.queued ? "二维码生成任务已重新提交" : result.status === "ready" ? "二维码已就绪" : "任务暂未入队，请稍后重试"); await load(); } catch (error) { ElMessage.error((error as Error).message || "提交生成任务失败"); } }
async function remove(row: ChannelItem) { try { await ElMessageBox.confirm(`确认删除渠道码「${row.name}」？历史扫码记录仍会保留。`, "删除确认", { type: "warning" }); await apiChannelDelete(row.id); ElMessage.success("渠道码已删除"); await load(); } catch (error) { if (error !== "cancel") ElMessage.error((error as Error).message || "删除失败"); } }

async function saveCategory() { if (!categoryForm.name.trim()) return ElMessage.error("请输入分类名称"); try { await apiChannelCategorySave({ id: categoryForm.id || undefined, cate_name: categoryForm.name }); ElMessage.success("分类已保存"); resetCategoryForm(); categories.value = (await apiChannelCategoryList()).data; } catch (error) { ElMessage.error((error as Error).message || "保存分类失败"); } }
async function removeCategory(row: ChannelCategory) { try { await ElMessageBox.confirm(`确认删除分类「${row.cate_name}」？`, "删除确认", { type: "warning" }); await apiChannelCategoryDelete(row.id); categories.value = (await apiChannelCategoryList()).data; ElMessage.success("分类已删除"); } catch (error) { if (error !== "cancel") ElMessage.error((error as Error).message || "删除分类失败"); } }
async function openUsers(row: ChannelItem) { activeChannel.value = row; usersVisible.value = true; usersLoading.value = true; try { users.value = (await apiChannelUsers(row.id)).list; } catch (error) { ElMessage.error((error as Error).message || "加载扫码用户失败"); } finally { usersLoading.value = false; } }
async function openStatistics(row: ChannelItem) { activeChannel.value = row; statisticsVisible.value = true; await loadStatistics(); }
async function loadStatistics() { if (!activeChannel.value) return; statsLoading.value = true; try { statistics.value = await apiChannelStatistics(activeChannel.value.id, `${dateText(statsDates.value[0])} - ${dateText(statsDates.value[1])}`); } catch (error) { ElMessage.error((error as Error).message || "加载统计失败"); } finally { statsLoading.value = false; } }

onMounted(async () => { await loadOptions(); await load(); });
</script>

<style scoped>
.channel-page { display: grid; gap: 16px; color: #172033; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.page-head h2 { margin: 3px 0 0; font-size: 25px; letter-spacing: -.02em; }
.page-head p { margin: 7px 0 0; color: #778197; }
.eyebrow { color: #3157d5; font-weight: 700; font-size: 11px; letter-spacing: .16em; }
.head-actions, .filters, .category-create, .stats-toolbar { display: flex; gap: 10px; flex-wrap: wrap; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.summary-card { min-height: 104px; padding: 18px 20px; border: 1px solid #e8ebf3; border-radius: 14px; background: linear-gradient(145deg, #fff, #f8f9fd); display: grid; align-content: center; }
.summary-card span, .summary-card small { color: #818a9d; }.summary-card strong { margin: 3px 0; font-size: 26px; color: #21304d; }.summary-card.green strong { color: #13865b; }.summary-card.blue strong { color: #3157d5; }.summary-card.amber strong { color: #d97706; }
.content-card { border-radius: 14px; }.filters { margin-bottom: 16px; }.filters .el-input { width: 220px; }.filters .el-select { width: 150px; }
.channel-cell { display: flex; align-items: center; gap: 12px; }.channel-cell strong, .channel-cell small, .block { display: block; }.channel-cell small, .block { color: #8992a5; margin-top: 4px; }
.qr-thumb { width: 52px; height: 52px; flex: none; border-radius: 9px; overflow: hidden; background: #eff3ff; color: #3157d5; display: grid; place-items: center; font-weight: 800; }.qr-thumb.pending { background: #fff7e6; color: #d97706; }.qr-thumb .el-image { width: 100%; height: 100%; }.qr-thumb :deep(.el-image__error) { display: grid; place-items: center; }
.tag { margin: 2px 4px 2px 0; }.metric-pair { display: grid; gap: 5px; color: #697386; }.metric-pair b { color: #1f2c45; }
.pagination { display: flex; justify-content: flex-end; margin-top: 16px; }.form-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }.form-grid .el-form-item:first-child, .form-grid .el-form-item:nth-child(4) { grid-column: 1 / -1; }
.field-hint { color: #8992a5; margin-left: 8px; font-size: 12px; }.inline-alert { margin: 0 0 16px 110px; width: calc(100% - 110px); }.category-create { margin-bottom: 16px; }.category-create .el-input { flex: 1; min-width: 180px; }
.stats-toolbar { justify-content: flex-end; margin-bottom: 18px; }.stats-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }.stats-summary div { background: #f7f9fd; border: 1px solid #ebedf3; border-radius: 12px; padding: 14px; }.stats-summary span, .stats-summary strong { display: block; }.stats-summary span { color: #7d8699; font-size: 12px; }.stats-summary strong { margin-top: 5px; font-size: 23px; }
.trend-list { border-top: 1px solid #edf0f5; padding-top: 18px; }.trend-row { display: grid; grid-template-columns: 72px 1fr 72px; gap: 12px; align-items: center; margin-bottom: 13px; }.trend-row > span, .trend-row small { color: #737d91; font-size: 12px; }.bars { display: grid; gap: 3px; }.bar { height: 6px; border-radius: 10px; min-width: 3px; }.bar.scan, .dot.scan { background: #3157d5; }.bar.follow, .dot.follow { background: #1aa574; }.legend { display: flex; gap: 18px; justify-content: flex-end; color: #747e91; font-size: 12px; }.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
.mobile-list { display: none; }.mobile-card { border: 1px solid #e9ecf2; border-radius: 12px; padding: 14px; margin-bottom: 10px; }.mobile-title { display: flex; justify-content: space-between; gap: 12px; }.mobile-title strong, .mobile-title small { display: block; }.mobile-title small { margin-top: 4px; color: #8891a4; }.mobile-metrics { margin: 14px 0; display: grid; grid-template-columns: repeat(3, 1fr); background: #f7f9fc; border-radius: 9px; padding: 10px; color: #778197; }.mobile-metrics b { color: #25324b; }.mobile-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 13px; }
@media (max-width: 980px) { .summary-grid { grid-template-columns: repeat(2, 1fr); }.form-grid { grid-template-columns: 1fr; }.form-grid .el-form-item { grid-column: auto !important; } }
@media (max-width: 760px) { .page-head { flex-direction: column; }.head-actions { width: 100%; }.head-actions .el-button { flex: 1; }.summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.summary-card { min-height: 92px; padding: 14px; }.desktop-table { display: none; }.mobile-list { display: block; }.filters .el-input, .filters .el-select { width: 100%; }.filters .el-button { flex: 1; }.channel-form :deep(.el-form-item__label) { float: none; display: block; text-align: left; width: auto !important; }.channel-form :deep(.el-form-item__content) { margin-left: 0 !important; }.inline-alert { margin-left: 0; width: 100%; }.stats-summary { grid-template-columns: repeat(2, 1fr); }.stats-toolbar .el-date-editor { width: 100%; }.trend-row { grid-template-columns: 58px 1fr 58px; }.pagination { overflow-x: auto; justify-content: flex-start; } }
</style>
