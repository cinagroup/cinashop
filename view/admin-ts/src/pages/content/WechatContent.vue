<template>
  <div class="wechat-content-page">
    <div class="page-head">
      <div>
        <h2>公众号内容</h2>
        <p>维护关键词、关注/默认回复、图文内容，并审阅迁移后的消息历史。</p>
      </div>
      <el-tag type="info" effect="plain">迁移批次 0071</el-tag>
    </div>

    <el-alert
      title="安全边界：回复二维码现通过可靠队列异步生成，不在页面请求内直连微信。公众号扫码回调、用户/卡券事件链与群发仍保持关闭。"
      type="warning"
      :closable="false"
      show-icon
    />

    <el-card shadow="never">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="自动回复" name="reply">
          <div class="reserved-grid">
            <div v-for="item in reservedCards" :key="item.key" class="reserved-card">
              <div class="reserved-title">
                <div>
                  <strong>{{ item.title }}</strong>
                  <small>{{ item.key }}</small>
                </div>
                <el-tag v-if="item.ambiguous" type="danger">历史重复</el-tag>
                <el-tag v-else-if="item.reply" :type="item.reply.status === 1 ? 'success' : 'info'">
                  {{ item.reply.status === 1 ? "已启用" : "已停用" }}
                </el-tag>
                <el-tag v-else type="info">未配置</el-tag>
              </div>
              <p>{{ item.reply ? replySummary(item.reply) : "尚未配置回复内容" }}</p>
              <el-button type="primary" plain @click="openReply(item.reply ?? undefined, item.key)">
                {{ item.reply ? "编辑回复" : "立即配置" }}
              </el-button>
            </div>
          </div>

          <div class="section-head">
            <div><h3>关键词回复</h3><small>新写入会拒绝跨回复重复关键词，旧数据仍原样保留。</small></div>
            <el-button type="primary" @click="openReply()">新增关键词回复</el-button>
          </div>
          <div class="filters">
            <el-input v-model="replyQuery.key" placeholder="搜索关键词" clearable @keyup.enter="loadReplies" />
            <el-select v-model="replyQuery.type" placeholder="全部类型" clearable>
              <el-option v-for="item in replyTypes" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button type="primary" @click="loadReplies">查询</el-button>
            <el-button @click="resetReplyQuery">重置</el-button>
          </div>
          <el-table :data="replies" v-loading="replyLoading" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column prop="key" label="关键词" min-width="180" show-overflow-tooltip />
            <el-table-column prop="typeName" label="类型" width="110" />
            <el-table-column label="回复摘要" min-width="260"><template #default="{ row }">{{ replySummary(row) }}</template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="270" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openReply(row)">编辑</el-button>
                <el-button link type="primary" @click="openReplyCode(row)">二维码</el-button>
                <el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleReply(row)">{{ row.status === 1 ? "停用" : "启用" }}</el-button>
                <el-button link type="danger" @click="removeReply(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!replyLoading && !replies.length" description="暂无关键词回复" />
        </el-tab-pane>

        <el-tab-pane label="图文内容" name="news">
          <div class="section-head">
            <div><h3>图文消息组</h3><small>每组 1–8 篇文章；删除分组不会删除 CMS 历史文章。</small></div>
            <el-button type="primary" @click="openNews()">新增图文</el-button>
          </div>
          <div class="filters">
            <el-input v-model="newsQuery.cate_name" placeholder="搜索图文名称" clearable @keyup.enter="loadNews" />
            <el-button type="primary" @click="loadNews">查询</el-button>
            <el-button @click="resetNewsQuery">重置</el-button>
          </div>
          <el-table :data="newsList" v-loading="newsLoading" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="名称" min-width="220"><template #default="{ row }"><strong>{{ row.cateName }}</strong><small class="block">{{ row.firstArticle?.synopsis || "暂无摘要" }}</small></template></el-table-column>
            <el-table-column prop="articleCount" label="文章数" width="90" />
            <el-table-column prop="sort" label="排序" width="80" />
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag></template></el-table-column>
            <el-table-column label="更新时间" width="180"><template #default="{ row }">{{ formatEpoch(row.addTime) }}</template></el-table-column>
            <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openNews(row)">编辑</el-button><el-button link type="danger" @click="removeNews(row)">删除</el-button></template></el-table-column>
          </el-table>
          <el-empty v-if="!newsLoading && !newsList.length" description="暂无图文内容" />
        </el-tab-pane>

        <el-tab-pane label="消息历史" name="message">
          <div class="section-head">
            <div><h3>迁移消息历史</h3><small>OpenID 和消息载荷中的用户标识已脱敏；本批不写入新回调。</small></div>
          </div>
          <div class="filters">
            <el-select v-model="messageQuery.type" placeholder="全部消息类型" clearable>
              <el-option v-for="item in messageTypes" :key="item.value" :label="`${item.label} (${item.count})`" :value="item.value" />
            </el-select>
            <el-button type="primary" @click="loadMessages">查询</el-button>
            <el-button @click="resetMessageQuery">重置</el-button>
          </div>
          <el-table :data="messages" v-loading="messageLoading" border>
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="openidMasked" label="用户标识" min-width="150" />
            <el-table-column prop="type" label="类型" width="130" />
            <el-table-column label="载荷" min-width="240">
              <template #default="{ row }">
                <el-popover placement="top-start" :width="460" trigger="click">
                  <pre class="payload">{{ formatPayload(row.result) }}</pre>
                  <template #reference><el-button link type="primary">查看脱敏详情</el-button></template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatEpoch(row.addTime) }}</template></el-table-column>
          </el-table>
          <el-empty v-if="!messageLoading && !messages.length" description="暂无消息历史" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="replyDialog" :title="replyForm.id ? '编辑自动回复' : '新增自动回复'" width="min(680px, 94vw)" destroy-on-close>
      <el-form :model="replyForm" label-width="100px">
        <el-form-item label="关键词" required>
          <el-input v-model="replyForm.key" :disabled="reservedEditing" maxlength="1300" placeholder="多个关键词用英文逗号分隔" />
        </el-form-item>
        <el-form-item label="回复类型" required>
          <el-radio-group v-model="replyForm.type">
            <el-radio-button v-for="item in replyTypes" :key="item.value" :value="item.value">{{ item.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="replyForm.type === 'text'" label="文字内容" required>
          <el-input v-model="replyForm.content" type="textarea" :rows="6" maxlength="20000" show-word-limit />
        </el-form-item>
        <el-form-item v-else-if="replyForm.type === 'image' || replyForm.type === 'voice'" label="已迁移素材" required>
          <el-select v-model="replyForm.mediaId" filterable placeholder="选择已有微信素材" style="width: 100%">
            <el-option v-for="item in filteredMedia" :key="item.id" :label="`${item.path || item.mediaId} · ${item.temporary ? '临时' : '永久'}`" :value="item.mediaId" />
          </el-select>
        </el-form-item>
        <el-form-item v-else label="图文消息" required>
          <el-select v-model="replyForm.newsCategoryId" filterable placeholder="选择图文组（回复首篇文章）" style="width: 100%">
            <el-option v-for="item in newsList" :key="item.id" :label="`${item.cateName} · ${item.articleCount}篇`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态"><el-switch v-model="replyForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="replyDialog = false">取消</el-button><el-button type="primary" :loading="replySaving" @click="saveReply">保存回复</el-button></template>
    </el-dialog>

    <el-dialog v-model="replyCodeDialog" title="回复二维码" width="min(440px, 92vw)">
      <div class="reply-code-panel">
        <div v-if="replyCode.status === 'ready' && replyCode.url" class="reply-code-image"><el-image :src="replyCode.url" fit="contain"><template #error><span>二维码图片加载失败</span></template></el-image></div>
        <el-alert v-else title="二维码正在队列中生成，可关闭窗口后稍后查看或再次提交。" type="warning" :closable="false" show-icon />
        <p>关键词：<strong>{{ replyCodeKey }}</strong></p>
        <small>生成操作不会在页面请求内直连微信接口；队列任务可安全重试。</small>
      </div>
      <template #footer><el-button @click="replyCodeDialog = false">关闭</el-button><el-button type="primary" :loading="replyCodeLoading" @click="provisionReplyCode">{{ replyCode.status === "ready" ? "重新检查" : "重试生成" }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="newsDialog" :title="newsForm.id ? '编辑图文消息' : '新增图文消息'" width="min(980px, 96vw)" destroy-on-close>
      <div class="news-settings">
        <label>排序 <el-input-number v-model="newsForm.sort" :min="0" /></label>
        <label>启用 <el-switch v-model="newsForm.status" :active-value="1" :inactive-value="0" /></label>
        <el-button :disabled="newsForm.articles.length >= 8" @click="addArticle">添加文章（{{ newsForm.articles.length }}/8）</el-button>
      </div>
      <div class="article-stack">
        <div v-for="(article, index) in newsForm.articles" :key="article.localKey" class="article-card">
          <div class="article-title"><strong>第 {{ index + 1 }} 篇</strong><el-button v-if="newsForm.articles.length > 1" link type="danger" @click="newsForm.articles.splice(index, 1)">移除</el-button></div>
          <el-form :model="article" label-width="82px">
            <div class="two-cols">
              <el-form-item label="标题" required><el-input v-model="article.title" maxlength="255" /></el-form-item>
              <el-form-item label="作者" required><el-input v-model="article.author" maxlength="255" /></el-form-item>
            </div>
            <el-form-item label="摘要" required><el-input v-model="article.synopsis" maxlength="500" /></el-form-item>
            <div class="two-cols">
              <el-form-item label="封面地址"><el-input v-model="article.imageInput" maxlength="255" /></el-form-item>
              <el-form-item label="跳转地址"><el-input v-model="article.url" maxlength="255" placeholder="留空使用文章详情页" /></el-form-item>
            </div>
            <el-form-item label="正文" required><el-input v-model="article.content" type="textarea" :rows="5" maxlength="200000" /></el-form-item>
          </el-form>
        </div>
      </div>
      <template #footer><el-button @click="newsDialog = false">取消</el-button><el-button type="primary" :loading="newsSaving" @click="saveNews">保存图文</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiWechatMediaList,
  apiWechatMessageList,
  apiWechatMessageTypes,
  apiWechatNewsDelete,
  apiWechatNewsDetail,
  apiWechatNewsList,
  apiWechatNewsSave,
  apiWechatReplyDelete,
  apiWechatReplyCodeProvision,
  apiWechatReplyCodeStatus,
  apiWechatReplyDetail,
  apiWechatReplyList,
  apiWechatReplySave,
  apiWechatReplyStatus,
  apiWechatReservedReply,
  type WechatMediaItem,
  type WechatMessageRecord,
  type WechatNewsCategory,
  type WechatReplyItem,
  type WechatReplyCodeStatus,
  type WechatReplyType,
} from "@/api/wechatContent";

const replyTypes: Array<{ value: WechatReplyType; label: string }> = [
  { value: "text", label: "文字" }, { value: "image", label: "图片" },
  { value: "news", label: "图文" }, { value: "voice", label: "语音" },
];
const activeTab = ref("reply");
const reservedCards = reactive<Array<{ key: "subscribe" | "default"; title: string; reply: WechatReplyItem | null; ambiguous: boolean }>>([
  { key: "subscribe", title: "关注回复", reply: null, ambiguous: false },
  { key: "default", title: "默认回复", reply: null, ambiguous: false },
]);
const replies = ref<WechatReplyItem[]>([]);
const replyLoading = ref(false);
const replySaving = ref(false);
const replyDialog = ref(false);
const replyCodeDialog = ref(false);
const replyCodeLoading = ref(false);
const replyCodeId = ref(0);
const replyCodeKey = ref("");
const replyCode = reactive<WechatReplyCodeStatus>({ status: "pending", url: "" });
const replyQuery = reactive({ key: "", type: "" as "" | WechatReplyType, page: 1, limit: 100 });
const replyForm = reactive({ id: 0, key: "", type: "text" as WechatReplyType, status: 1, content: "", mediaId: "", newsCategoryId: 0 });
const reservedEditing = computed(() => ["subscribe", "default"].includes(replyForm.key));
const media = ref<WechatMediaItem[]>([]);
const filteredMedia = computed(() => media.value.filter((item) => item.type === replyForm.type));

const newsList = ref<WechatNewsCategory[]>([]);
const newsLoading = ref(false);
const newsSaving = ref(false);
const newsDialog = ref(false);
const newsQuery = reactive({ cate_name: "", page: 1, limit: 100 });
let localArticleKey = 0;
function blankArticle() { return { localKey: ++localArticleKey, id: 0, title: "", author: "", content: "", synopsis: "", imageInput: "", url: "", sort: 0, status: 1 }; }
const newsForm = reactive({ id: 0, sort: 0, status: 1, articles: [blankArticle()] });

const messages = ref<WechatMessageRecord[]>([]);
const messageTypes = ref<Array<{ value: string; label: string; count: number }>>([]);
const messageLoading = ref(false);
const messageQuery = reactive({ type: "", page: 1, limit: 100 });

function replySummary(item: WechatReplyItem): string {
  if (item.type === "text") return String(item.data.content ?? "");
  if (item.type === "news") return String(item.data.title ?? "未命名图文");
  return String(item.data.src ?? item.data.media_id ?? "未关联素材");
}
function formatEpoch(value: string | number): string {
  const epoch = Number(value);
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toLocaleString("zh-CN", { hour12: false }) : "—";
}
function formatPayload(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }

async function loadReserved() {
  const results = await Promise.all(reservedCards.map((item) => apiWechatReservedReply(item.key)));
  results.forEach((result, index) => { reservedCards[index].reply = result.info; reservedCards[index].ambiguous = result.ambiguous; });
}
async function loadReplies() {
  replyLoading.value = true;
  try { replies.value = (await apiWechatReplyList(replyQuery)).list; }
  catch (error) { ElMessage.error((error as Error).message || "加载自动回复失败"); }
  finally { replyLoading.value = false; }
}
function resetReplyQuery() { replyQuery.key = ""; replyQuery.type = ""; void loadReplies(); }
async function openReply(row?: WechatReplyItem, reservedKey?: "subscribe" | "default") {
  let item = row;
  if (row?.id) item = (await apiWechatReplyDetail(row.id)).info;
  Object.assign(replyForm, { id: item?.id ?? 0, key: reservedKey ?? item?.key ?? "", type: item?.type ?? "text", status: item?.status ?? 1, content: String(item?.data.content ?? ""), mediaId: String(item?.data.media_id ?? ""), newsCategoryId: 0 });
  if (item?.type === "news") {
    const articleId = Number(item.data.id ?? 0);
    replyForm.newsCategoryId = newsList.value.find((group) => group.articleIds.includes(articleId))?.id ?? 0;
  }
  replyDialog.value = true;
}
async function saveReply() {
  if (!replyForm.key.trim()) return ElMessage.error("请填写关键词");
  let data: Record<string, unknown> = {};
  if (replyForm.type === "text") {
    if (!replyForm.content) return ElMessage.error("请填写回复内容");
    data = { content: replyForm.content };
  } else if (replyForm.type === "image" || replyForm.type === "voice") {
    const selected = media.value.find((item) => item.mediaId === replyForm.mediaId && item.type === replyForm.type);
    if (!selected) return ElMessage.error("请选择类型匹配的已迁移素材");
    data = { src: selected.path, media_id: selected.mediaId };
  } else {
    if (!replyForm.newsCategoryId) return ElMessage.error("请选择图文消息");
    const detail = (await apiWechatNewsDetail(replyForm.newsCategoryId)).info;
    const article = detail.articles?.[0];
    if (!article) return ElMessage.error("所选图文没有可用文章");
    data = { id: article.id, title: article.title, synopsis: article.synopsis, image: article.imageInput, image_input: article.image_input, url: article.url };
  }
  replySaving.value = true;
  try {
    await apiWechatReplySave(replyForm.id, { key: replyForm.key, type: replyForm.type, status: replyForm.status, data });
    ElMessage.success("自动回复已保存"); replyDialog.value = false;
    await Promise.all([loadReserved(), loadReplies()]);
  } catch (error) { ElMessage.error((error as Error).message || "保存失败"); }
  finally { replySaving.value = false; }
}
async function toggleReply(row: WechatReplyItem) { try { await apiWechatReplyStatus(row.id, row.status === 1 ? 0 : 1); ElMessage.success("状态已更新"); await loadReplies(); } catch (error) { ElMessage.error((error as Error).message || "操作失败"); } }
async function openReplyCode(row: WechatReplyItem) { replyCodeId.value = row.id; replyCodeKey.value = row.key; Object.assign(replyCode, { status: "pending", url: "" }); replyCodeDialog.value = true; replyCodeLoading.value = true; try { const current = await apiWechatReplyCodeStatus(row.id); Object.assign(replyCode, current); if (current.status !== "ready") Object.assign(replyCode, await apiWechatReplyCodeProvision(row.id)); } catch (error) { ElMessage.error((error as Error).message || "加载回复二维码失败"); } finally { replyCodeLoading.value = false; } }
async function provisionReplyCode() { if (!replyCodeId.value) return; replyCodeLoading.value = true; try { const result = replyCode.status === "ready" ? await apiWechatReplyCodeStatus(replyCodeId.value) : await apiWechatReplyCodeProvision(replyCodeId.value); Object.assign(replyCode, result); ElMessage.success(result.status === "ready" ? "二维码已就绪" : result.queued ? "生成任务已提交" : "任务暂未入队，请稍后重试"); } catch (error) { ElMessage.error((error as Error).message || "提交生成任务失败"); } finally { replyCodeLoading.value = false; } }
async function removeReply(row: WechatReplyItem) { try { await ElMessageBox.confirm(`确认删除关键词回复「${row.key}」？`, "删除确认", { type: "warning" }); await apiWechatReplyDelete(row.id); ElMessage.success("回复已删除"); await loadReplies(); } catch (error) { if (error !== "cancel") ElMessage.error((error as Error).message || "删除失败"); } }

async function loadNews() {
  newsLoading.value = true;
  try { newsList.value = (await apiWechatNewsList(newsQuery)).list; }
  catch (error) { ElMessage.error((error as Error).message || "加载图文失败"); }
  finally { newsLoading.value = false; }
}
function resetNewsQuery() { newsQuery.cate_name = ""; void loadNews(); }
function addArticle() { if (newsForm.articles.length < 8) newsForm.articles.push(blankArticle()); }
async function openNews(row?: WechatNewsCategory) {
  Object.assign(newsForm, { id: 0, sort: 0, status: 1, articles: [blankArticle()] });
  if (row) {
    try {
      const detail = (await apiWechatNewsDetail(row.id)).info;
      newsForm.id = detail.id; newsForm.sort = detail.sort; newsForm.status = detail.status;
      newsForm.articles = (detail.articles ?? []).map((article) => ({ localKey: ++localArticleKey, id: article.id, title: article.title, author: article.author, content: article.content, synopsis: article.synopsis, imageInput: article.imageInput || article.image_input?.[0] || "", url: article.url, sort: article.sort, status: article.status }));
      if (!newsForm.articles.length) newsForm.articles = [blankArticle()];
    } catch (error) { return ElMessage.error((error as Error).message || "加载图文详情失败"); }
  }
  newsDialog.value = true;
}
async function saveNews() {
  if (newsForm.articles.some((item) => !item.title.trim() || !item.author.trim() || !item.synopsis.trim() || !item.content.trim())) return ElMessage.error("请完整填写每篇文章的标题、作者、摘要和正文");
  newsSaving.value = true;
  try {
    await apiWechatNewsSave({ id: newsForm.id, sort: newsForm.sort, status: newsForm.status, list: newsForm.articles.map(({ localKey: _localKey, ...item }, index) => ({ ...item, image_input: item.imageInput ? [item.imageInput] : [], sort: index })) });
    ElMessage.success("图文内容已保存"); newsDialog.value = false; await loadNews();
  } catch (error) { ElMessage.error((error as Error).message || "保存失败"); }
  finally { newsSaving.value = false; }
}
async function removeNews(row: WechatNewsCategory) { try { await ElMessageBox.confirm(`确认删除图文组「${row.cateName}」？CMS 历史文章会保留。`, "删除确认", { type: "warning" }); await apiWechatNewsDelete(row.id); ElMessage.success("图文组已删除"); await loadNews(); } catch (error) { if (error !== "cancel") ElMessage.error((error as Error).message || "删除失败"); } }

async function loadMessages() {
  messageLoading.value = true;
  try { messages.value = (await apiWechatMessageList(messageQuery)).list; }
  catch (error) { ElMessage.error((error as Error).message || "加载消息历史失败"); }
  finally { messageLoading.value = false; }
}
function resetMessageQuery() { messageQuery.type = ""; void loadMessages(); }

onMounted(async () => {
  await Promise.all([loadReserved(), loadReplies(), loadNews(), loadMessages()]);
  const [mediaResult, types] = await Promise.all([apiWechatMediaList(), apiWechatMessageTypes()]);
  media.value = mediaResult.list; messageTypes.value = types;
});
</script>

<style scoped>
.wechat-content-page { display: grid; gap: 16px; }
.page-head, .section-head, .reserved-title, .article-title, .news-settings { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.page-head h2, .section-head h3 { margin: 0; color: #172033; }
.page-head p, .section-head small { margin: 6px 0 0; color: #7b8497; }
.reserved-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 4px 0 26px; }
.reserved-card { border: 1px solid #e5e9f1; border-radius: 12px; padding: 18px; background: linear-gradient(135deg, #fff, #f7f9ff); }
.reserved-title small, .block { display: block; color: #8991a3; margin-top: 4px; }
.reserved-card p { min-height: 44px; color: #5f687b; line-height: 1.6; }
.section-head { margin: 12px 0 16px; align-items: center; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.filters .el-input, .filters .el-select { width: 220px; }
.news-settings { justify-content: flex-start; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.news-settings label { display: flex; align-items: center; gap: 8px; color: #5f687b; }
.article-stack { display: grid; gap: 14px; max-height: 64vh; overflow-y: auto; padding-right: 4px; }
.article-card { border: 1px solid #e5e9f1; border-radius: 10px; padding: 16px; background: #fafbfe; }
.article-title { margin-bottom: 12px; align-items: center; }
.two-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.payload { margin: 0; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.reply-code-panel { text-align: center; }.reply-code-image { width: 230px; height: 230px; margin: 0 auto 16px; padding: 10px; border: 1px solid #e5e9f1; border-radius: 12px; }.reply-code-image .el-image { width: 100%; height: 100%; }.reply-code-panel p { color: #475268; }.reply-code-panel small { color: #8891a3; }
@media (max-width: 760px) {
  .reserved-grid, .two-cols { grid-template-columns: 1fr; }
  .page-head, .section-head { flex-direction: column; align-items: stretch; }
  .filters .el-input, .filters .el-select { width: 100%; }
}
</style>
