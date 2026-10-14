<template>
  <div class="reply-page">
    <div class="page-head"><h2>商品评价</h2><div class="head-actions"><el-button v-if="canManage" type="primary" :disabled="saving || writeUncertain" @click="openFictitious">添加自评</el-button><el-button v-if="canView" :disabled="saving" @click="refresh">刷新</el-button></div></div>
    <el-alert v-if="!canView" title="没有商品评价查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-form inline class="filters" @submit.prevent="search">
        <el-form-item label="商品信息"><el-input v-model="draft.store_name" placeholder="商品名称、关键词或ID" clearable /></el-form-item>
        <el-form-item label="用户昵称"><el-input v-model="draft.account" placeholder="用户昵称" clearable /></el-form-item>
        <el-form-item label="商品ID"><el-input v-model="draft.product_id" placeholder="全部商品" clearable /></el-form-item>
        <el-form-item label="回复状态"><el-select v-model="draft.is_reply" aria-label="回复状态"><el-option label="全部" value="" /><el-option label="未回复" :value="0" /><el-option label="已回复" :value="1" /></el-select></el-form-item>
        <el-form-item label="日期（上海时间）"><el-date-picker v-model="draftDates" type="daterange" value-format="YYYY/MM/DD" start-placeholder="开始日期" end-placeholder="结束日期" /></el-form-item>
        <el-form-item><el-button type="primary" :disabled="saving" @click="search">查询</el-button><el-button :disabled="saving" @click="reset">重置</el-button></el-form-item>
      </el-form>
      <el-alert v-if="filterError || listError" :title="filterError || listError" type="error" :closable="false" />
      <el-alert v-if="writeUncertain" title="上次操作结果尚未确认，请刷新列表或回复详情后再操作。" type="warning" :closable="false" />
      <div class="table-scroll"><el-table :data="list" v-loading="loading" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="商品" min-width="160"><template #default="{ row }">{{ row.store_name || `商品 #${row.product_id}` }}<div class="muted">商品ID：{{ row.product_id }}</div></template></el-table-column>
        <el-table-column label="用户" width="130"><template #default="{ row }">{{ row.account || row.nickname || "用户" }}</template></el-table-column>
        <el-table-column label="评分" width="90"><template #default="{ row }"><span class="stars">{{ starText(row.product_score) }}</span><div class="muted">综合 {{ row.score }}</div></template></el-table-column>
        <el-table-column prop="comment" label="评价内容" min-width="230" show-overflow-tooltip />
        <el-table-column label="图片" width="90"><template #default="{ row }"><el-image v-if="pictures(row).length" :src="pictures(row)[0]" class="pic" fit="cover" :preview-src-list="pictures(row)" /><span v-else-if="!unavailablePictures(row)">—</span><span v-if="unavailablePictures(row)" class="muted">{{ pictures(row).length ? "部分图片暂不可用" : "图片暂不可用" }}</span></template></el-table-column>
        <el-table-column label="平台回复" min-width="180"><template #default="{ row }"><div class="message-text">{{ row.replyComment?.content || "暂无平台回复" }}</div></template></el-table-column>
        <el-table-column label="回复状态" width="100"><template #default="{ row }">{{ row.is_reply === 1 ? "已回复" : "未回复" }}</template></el-table-column>
        <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "显示" : "隐藏" }}</el-tag></template></el-table-column>
        <el-table-column prop="add_time" label="时间（上海）" width="170" />
        <el-table-column label="操作" width="240"><template #default="{ row }"><div class="row-actions"><el-button link type="primary" :disabled="saving" @click="openThreads(row)">评论线程</el-button>
          <template v-if="canManage"><el-button link type="primary" :disabled="saving || writeUncertain" @click="openReply(row)">平台回复</el-button><el-button link :type="row.status === 1 ? 'warning' : 'success'" :disabled="saving || writeUncertain" @click="toggle(row)">{{ row.status === 1 ? "隐藏" : "显示" }}</el-button><el-button link type="danger" :disabled="saving || writeUncertain" @click="del(row)">删除评价</el-button></template><span v-else class="muted">仅查看</span>
        </div></template></el-table-column>
      </el-table></div>
      <el-empty v-if="!list.length && !loading && !listError" description="暂无评价" />
      <el-pagination class="pager" :current-page="query.page" :page-size="query.limit" :total="total" layout="total, prev, pager, next" :disabled="loading || saving" @current-change="changePage" />
    </template>
    <FictitiousReplyDialog v-model="fictitiousVisible" :can-manage="canManage" :can-select="canSelectProduct" :blocked="writeUncertain" :context-key="fictitiousContext" :initial-product-id="query.product_id" @busy="setFictitiousBusy" @uncertain="writeUncertain = true" @created="afterFictitiousCreated" @verify="refresh" />
    <el-dialog v-model="replyVisible" :title="`平台回复评价 #${replyId}`" width="min(600px, 94vw)" :before-close="closeReply" :close-on-click-modal="!saving" :close-on-press-escape="!saving" @closed="clearReply">
      <el-alert v-if="replyError" :title="replyError" type="error" :closable="false" />
      <el-input v-model="replyContent" type="textarea" :rows="5" placeholder="请输入平台回复内容" :disabled="replyLoading || saving || !canManage" />
      <div class="muted content-count">{{ [...replyContent].length }}/1000 个字符</div>
      <template #footer><el-button :disabled="saving" @click="replyVisible = false">取消</el-button><el-button :disabled="replyLoading || !replyReady || !canManage || writeUncertain" type="primary" :loading="saving" @click="saveReply">保存平台回复</el-button><el-button :disabled="saving" @click="reloadReply">刷新回复</el-button></template>
    </el-dialog>
    <el-dialog v-model="threadVisible" :title="`评价 #${threadReplyId} 的评论线程`" width="min(900px, 96vw)" :before-close="closeThreads" :close-on-click-modal="!saving" :close-on-press-escape="!saving" @closed="clearThreads">
      <el-form inline @submit.prevent="searchThreads"><el-form-item label="日期（上海时间）"><el-date-picker v-model="threadDates" type="daterange" value-format="YYYY/MM/DD" start-placeholder="开始日期" end-placeholder="结束日期" /></el-form-item><el-form-item><el-button :disabled="saving" @click="searchThreads">查询评论</el-button><el-button :disabled="saving" @click="loadThreads(threadPage)">刷新评论</el-button></el-form-item></el-form>
      <el-alert v-if="threadError" :title="threadError" type="error" :closable="false" />
      <el-table :data="threads" v-loading="threadLoading" border>
        <el-table-column label="用户" width="130"><template #default="{ row }">{{ row.user?.nickname || "用户" }}<div v-if="row.user?.level_name" class="muted">{{ row.user.level_name }}</div></template></el-table-column>
        <el-table-column label="用户评论" min-width="220"><template #default="{ row }"><div class="message-text">{{ row.content }}</div><div class="muted">{{ row.create_time }}</div></template></el-table-column>
        <el-table-column label="直接回复" min-width="220"><template #default="{ row }"><template v-if="row.children"><div class="muted">{{ row.children.user?.nickname || "管理员" }}</div><div class="message-text">{{ row.children.content }}</div><div class="muted">{{ row.children.create_time }}</div></template><span v-else class="muted">暂无回复</span></template></el-table-column>
        <el-table-column v-if="canManage" label="操作" width="210"><template #default="{ row }"><div class="row-actions"><el-button link type="primary" :disabled="saving || writeUncertain" @click="openComment(row)">回复评论</el-button><el-button link type="danger" :disabled="saving || writeUncertain" @click="deleteComment(row)">删除评论</el-button><el-button v-if="row.children" link type="danger" :disabled="saving || writeUncertain" @click="deleteComment(row.children)">删除回复</el-button></div></template></el-table-column>
      </el-table>
      <el-empty v-if="!threads.length && !threadLoading && !threadError" description="暂无用户评论" />
      <el-pagination class="pager" :current-page="threadPage" :page-size="15" :total="threadTotal" layout="total, prev, pager, next" :disabled="threadLoading || saving" @current-change="loadThreads" />
    </el-dialog>
    <el-dialog v-model="commentVisible" :title="`回复用户评论 #${commentId}`" width="min(600px, 94vw)" :before-close="closeComment" :close-on-click-modal="!saving" :close-on-press-escape="!saving">
      <el-alert v-if="commentError" :title="commentError" type="error" :closable="false" />
      <el-input v-model="commentContent" type="textarea" :rows="5" placeholder="请输入评论回复内容" :disabled="saving || !canManage" />
      <div class="muted content-count">{{ [...commentContent].length }}/1000 个字符</div>
      <template #footer><el-button :disabled="saving" @click="commentVisible = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!canManage || writeUncertain" @click="saveComment">保存评论回复</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import FictitiousReplyDialog from "./FictitiousReplyDialog.vue";
import { apiAdminProductReplyList, apiAdminProductReplySet, apiAdminProductReplyDelete, apiAdminProductReplyGet,
  apiAdminProductReplyComments, apiAdminProductReplySaveComment, apiAdminProductReplyDeleteComment, apiAdminReplyStatus,
  type AdminProductReplyItem, type AdminProductReplyComment, type AdminProductReplyQuery, type AdminProductReplyThread } from "@/api/reply";

const route = useRoute(), auth = useAuthStore();
const list = ref<AdminProductReplyItem[]>([]), total = ref(0), loading = ref(false), saving = ref(false);
const listError = ref(""), filterError = ref(""), writeUncertain = ref(false);
const draft = reactive<{ store_name: string; account: string; product_id: string; is_reply: "" | 0 | 1 }>({ store_name: "", account: "", product_id: "", is_reply: "" });
const draftDates = ref<[string, string] | null>(null);
const query = reactive<AdminProductReplyQuery>({ store_name: "", account: "", product_id: 0, is_reply: "", data: "", page: 1, limit: 15 });
const replyVisible = ref(false), replyId = ref(0), replyContent = ref(""), replyLoading = ref(false), replyReady = ref(false), replyError = ref("");
const threadVisible = ref(false), threadReplyId = ref(0), threads = ref<AdminProductReplyThread[]>([]), threadTotal = ref(0), threadPage = ref(1), threadLoading = ref(false), threadError = ref("");
const threadDates = ref<[string, string] | null>(null), threadTime = ref("");
const commentVisible = ref(false), commentId = ref(0), commentContent = ref(""), commentError = ref("");
const fictitiousVisible = ref(false);
let fictitiousBusy = false;
let alive = false, syncing = false, generation = 0, listGeneration = 0, replyGeneration = 0, threadGeneration = 0;
let listAbort: AbortController | null = null, replyAbort: AbortController | null = null, threadAbort: AbortController | null = null;
let stored = localStorage.getItem("admin_session");
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
function hasPermission(key: string): boolean {
  void sessionVersion.value; const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") && !!auth.userInfo && !!session &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || auth.uniqueAuth.includes(key) && session.uniqueAuth.includes(key));
}
const canView = computed(() => hasPermission("reply.view") || hasPermission("reply.manage"));
const canManage = computed(() => canView.value && hasPermission("reply.manage"));
const canSelectProduct = computed(() => hasPermission("product.view"));
const fictitiousContext = computed(() => `${identity.value}:${sessionVersion.value}`);
type Stamp = { identity: string; stored: string | null; generation: number };
function stamp(): Stamp { return { identity: identity.value, stored, generation }; }
function current(value: Stamp): boolean { return alive && canView.value && value.identity === identity.value && value.stored === stored &&
  stored === localStorage.getItem("admin_session") && value.generation === generation && auth.token === getToken(); }
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";
function pictures(row: AdminProductReplyItem): string[] { return Array.isArray(row.pics) ? row.pics.filter((item): item is string => typeof item === "string" && !!item) : []; }
function unavailablePictures(row: AdminProductReplyItem): boolean { return Array.isArray(row.pics) && row.pics.some(item => item === ''); }
function starText(score: number): string { return "★".repeat(Math.min(5, Math.max(0, Number(score) || 0))); }
function productId(value: unknown): number {
  if (value === undefined || value === "" || value === "0") return 0;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) throw Error("商品ID格式错误");
  return Number(value);
}
function dateRange(value: [string, string] | null): string {
  if (!value) return "";
  if (value.length !== 2 || value.some(day => !/^\d{4}\/\d{2}\/\d{2}$/.test(day)) || value[0] > value[1]) throw Error("请选择有效的日期范围");
  return value.join("-");
}
function validContent(value: string, secondary = false): string {
  const content = value.trim(); if (!content || secondary && content === "0") throw Error("请输入回复内容");
  if ([...content].length > 1000) throw Error("回复内容不能超过1000个字符");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(content)) throw Error("回复内容包含非法字符");
  return content;
}
function clearReply(): void { replyGeneration++; replyAbort?.abort(); replyAbort = null; replyVisible.value = false; replyId.value = 0; replyContent.value = replyError.value = ""; replyLoading.value = replyReady.value = false; }
function clearThreads(): void { threadGeneration++; threadAbort?.abort(); threadAbort = null; threadVisible.value = commentVisible.value = false; threadReplyId.value = commentId.value = 0;
  threads.value = []; threadTotal.value = 0; threadPage.value = 1; threadLoading.value = false; threadError.value = commentError.value = commentContent.value = threadTime.value = ""; threadDates.value = null; }
function closeReply(done: () => void): void { if (!saving.value) done(); }
function closeThreads(done: () => void): void { if (!saving.value) done(); }
function closeComment(done: () => void): void { if (!saving.value) done(); }
function clearFictitious(): void { fictitiousVisible.value = false; if (fictitiousBusy) { fictitiousBusy = false; saving.value = false; } }
function setFictitiousBusy(value: boolean): void { if (value) { fictitiousBusy = true; saving.value = true; } else if (fictitiousBusy) { fictitiousBusy = false; saving.value = false; } }
function openFictitious(): void { if (!canManage.value || !current(stamp()) || saving.value || writeUncertain.value) return; clearReply(); clearThreads(); fictitiousVisible.value = true; }
async function afterFictitiousCreated(): Promise<void> { if (current(stamp())) await load(); }
function clear(): void { generation++; listGeneration++; listAbort?.abort(); listAbort = null; clearFictitious(); clearReply(); clearThreads(); list.value = []; total.value = 0; loading.value = false; saving.value = false; writeUncertain.value = false; listError.value = filterError.value = ""; }
async function load(target = query.page): Promise<void> {
  if (!current(stamp()) || !Number.isSafeInteger(target) || target < 1 || (target - 1) * query.limit > 2_147_483_647) return;
  listAbort?.abort(); const scope = stamp(), turn = ++listGeneration, controller = new AbortController(); listAbort = controller;
  // Element Plus clamps current-page when total drops to zero. Keep the known
  // count while loading the next page so it cannot emit an unintended page 1.
  query.page = target; loading.value = true; listError.value = ""; list.value = [];
  try { const result = await apiAdminProductReplyList({ ...query }, controller.signal);
    if (!current(scope) || turn !== listGeneration) return;
    if (target > 1 && !result.list.length) { await load(Math.max(1, Math.ceil(result.count / query.limit))); return; }
    list.value = result.list; total.value = result.count; writeUncertain.value = false;
  } catch (error) { if (current(scope) && turn === listGeneration) { list.value = []; total.value = 0; listError.value = errorText(error); } }
  finally { if (turn === listGeneration) { loading.value = false; listAbort = null; } }
}
async function search(): Promise<void> {
  if (!current(stamp()) || saving.value) return;
  try { for (const value of [draft.store_name, draft.account]) if ([...value].length > 128 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) throw Error("筛选文字格式错误或超过128个字符");
    const id = productId(draft.product_id), dates = dateRange(draftDates.value); if (!["", 0, 1].includes(draft.is_reply)) throw Error("回复状态格式错误");
    generation++; clearFictitious(); clearReply(); clearThreads(); filterError.value = "";
    Object.assign(query, { store_name: draft.store_name.trim(), account: draft.account.trim(), product_id: id, is_reply: draft.is_reply, data: dates }); await load(1);
  } catch (error) { filterError.value = errorText(error); }
}
async function reset(): Promise<void> { Object.assign(draft, { store_name: "", account: "", product_id: "", is_reply: "" }); draftDates.value = null; await search(); }
async function refresh(): Promise<void> { if (!saving.value) { clearFictitious(); clearReply(); clearThreads(); await load(); } }
async function changePage(page: number): Promise<void> { if (!saving.value) { generation++; clearFictitious(); clearReply(); clearThreads(); await load(page); } }
const inList = (id: number) => list.value.some(row => row.id === id);
async function openReply(row: AdminProductReplyItem): Promise<void> {
  if (!canManage.value || saving.value || writeUncertain.value || !inList(row.id)) return;
  clearReply(); replyId.value = row.id; replyVisible.value = true; await reloadReply();
}
async function reloadReply(): Promise<void> {
  if (!current(stamp()) || !replyVisible.value || !replyId.value || saving.value) return;
  replyAbort?.abort(); const scope = stamp(), turn = ++replyGeneration, id = replyId.value, controller = new AbortController(); replyAbort = controller; replyLoading.value = true; replyReady.value = false; replyError.value = "";
  try { const result = await apiAdminProductReplyGet(id, controller.signal); if (current(scope) && turn === replyGeneration && replyVisible.value && replyId.value === id) { replyContent.value = result.content; replyReady.value = true; writeUncertain.value = false; } }
  catch (error) { if (current(scope) && turn === replyGeneration) replyError.value = errorText(error); }
  finally { if (turn === replyGeneration) { replyLoading.value = false; replyAbort = null; } }
}
async function saveReply(): Promise<void> {
  if (!canManage.value || !current(stamp()) || saving.value || writeUncertain.value || replyLoading.value || !replyReady.value || !replyVisible.value || !inList(replyId.value)) return;
  let content: string; try { content = validContent(replyContent.value); } catch (error) { replyError.value = errorText(error); return; }
  const scope = stamp(), id = replyId.value; saving.value = true; replyError.value = "";
  try { await apiAdminProductReplySet(id, content); if (current(scope)) { clearReply(); ElMessage.success("平台回复已保存"); await load(); } }
  catch (error) { if (current(scope)) { replyError.value = errorText(error); writeUncertain.value = true; } }
  finally { if (current(scope)) saving.value = false; }
}
async function openThreads(row: AdminProductReplyItem): Promise<void> {
  if (!current(stamp()) || saving.value || !inList(row.id)) return;
  clearThreads(); threadReplyId.value = row.id; threadVisible.value = true; await loadThreads(1);
}
async function loadThreads(page = threadPage.value): Promise<void> {
  if (!current(stamp()) || !threadVisible.value || !threadReplyId.value || !Number.isSafeInteger(page) || page < 1 || (page - 1) * 15 > 2_147_483_647) return;
  threadAbort?.abort(); const scope = stamp(), turn = ++threadGeneration, id = threadReplyId.value, controller = new AbortController(); threadAbort = controller;
  threadPage.value = page; threadLoading.value = true; threadError.value = ""; commentVisible.value = false; threads.value = [];
  try { const result = await apiAdminProductReplyComments(id, { time: threadTime.value, page, limit: 15 }, controller.signal);
    if (!current(scope) || turn !== threadGeneration || !threadVisible.value || threadReplyId.value !== id) return;
    if (page > 1 && !result.list.length) { await loadThreads(Math.max(1, Math.ceil(result.count / 15))); return; }
    threads.value = result.list; threadTotal.value = result.count; writeUncertain.value = false;
  } catch (error) { if (current(scope) && turn === threadGeneration) { threads.value = []; threadTotal.value = 0; threadError.value = errorText(error); } }
  finally { if (turn === threadGeneration) { threadLoading.value = false; threadAbort = null; } }
}
async function searchThreads(): Promise<void> { if (saving.value) return; try { threadTime.value = dateRange(threadDates.value); await loadThreads(1); } catch (error) { threadError.value = errorText(error); } }
function openComment(row: AdminProductReplyThread): void {
  if (!canManage.value || !current(stamp()) || saving.value || writeUncertain.value || !threadVisible.value || !threads.value.some(item => item.id === row.id) || row.pid !== 0 || row.uid <= 0 || row.reply_id !== threadReplyId.value) return;
  commentId.value = row.id; commentContent.value = row.children?.content ?? ""; commentError.value = ""; commentVisible.value = true;
}
async function saveComment(): Promise<void> {
  if (!canManage.value || !current(stamp()) || saving.value || writeUncertain.value || !commentVisible.value || !threadVisible.value || !threads.value.some(row => row.id === commentId.value)) return;
  let content: string; try { content = validContent(commentContent.value, true); } catch (error) { commentError.value = errorText(error); return; }
  const scope = stamp(), reply = threadReplyId.value, id = commentId.value; saving.value = true; commentError.value = "";
  try { await apiAdminProductReplySaveComment(reply, id, content); if (current(scope)) { commentVisible.value = false; ElMessage.success("评论回复已保存"); await loadThreads(); } }
  catch (error) { if (current(scope)) { commentError.value = errorText(error); writeUncertain.value = true; } }
  finally { if (current(scope)) saving.value = false; }
}
async function confirm(message: string, title: string): Promise<boolean> {
  try { await ElMessageBox.confirm(message, title, { type: "warning" }); return true; }
  catch (error) { if (error !== "cancel" && error !== "close") ElMessage.error(errorText(error)); return false; }
}
async function del(row: AdminProductReplyItem): Promise<void> {
  if (!canManage.value || !current(stamp()) || saving.value || writeUncertain.value || !inList(row.id)) return;
  const scope = stamp(); if (!await confirm(`确认删除评价 #${row.id}？`, "删除评价")) return;
  if (!canManage.value || !current(scope) || !inList(row.id) || saving.value) return; saving.value = true;
  try { await apiAdminProductReplyDelete(row.id); if (current(scope)) { clearReply(); clearThreads(); ElMessage.success("评价已删除"); await load(); } }
  catch (error) { if (current(scope)) { listError.value = errorText(error); writeUncertain.value = true; } }
  finally { if (current(scope)) saving.value = false; }
}
async function toggle(row: AdminProductReplyItem): Promise<void> {
  if (!canManage.value || !current(stamp()) || saving.value || writeUncertain.value || !inList(row.id)) return;
  const scope = stamp(); saving.value = true;
  try { await apiAdminReplyStatus(row.id, row.status === 1 ? 0 : 1); if (current(scope)) { ElMessage.success("显示状态已更新"); await load(); } }
  catch (error) { if (current(scope)) { listError.value = errorText(error); writeUncertain.value = true; } }
  finally { if (current(scope)) saving.value = false; }
}
async function deleteComment(row: AdminProductReplyComment): Promise<void> {
  if (!canManage.value || !current(stamp()) || saving.value || writeUncertain.value || !threadVisible.value || row.reply_id !== threadReplyId.value || !threads.value.some(item => item.id === row.id || item.children?.id === row.id)) return;
  const scope = stamp(), thread = threadReplyId.value, turn = threadGeneration;
  if (!await confirm(row.pid === 0 ? "确认删除该评论及其直接回复？" : "确认删除这条回复？", "删除评论")) return;
  if (!canManage.value || !current(scope) || !threadVisible.value || threadReplyId.value !== thread || threadGeneration !== turn || saving.value) return; saving.value = true;
  try { await apiAdminProductReplyDeleteComment(row.id); if (current(scope)) { ElMessage.success("评论已删除"); await loadThreads(); } }
  catch (error) { if (current(scope)) { threadError.value = errorText(error); writeUncertain.value = true; } }
  finally { if (current(scope)) saving.value = false; }
}
function syncSession(): void {
  syncing = true; clear(); Object.assign(draft, { store_name: "", account: "", product_id: "", is_reply: "" }); draftDates.value = null;
  Object.assign(query, { store_name: "", account: "", product_id: 0, is_reply: "", data: "", page: 1, limit: 15 });
  const session = getAdminSession(); auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session"); sessionVersion.value++; syncing = false; if (canView.value) void applyRoute();
}
async function applyRoute(): Promise<void> {
  if (!current(stamp())) return;
  try {
    const id = productId(route.query.product_id), status = route.query.is_reply;
    if (status !== undefined && !["", "0", "1"].includes(status as string)) throw Error("回复状态格式错误");
    draft.product_id = id ? String(id) : "";
    draft.is_reply = status === "0" ? 0 : status === "1" ? 1 : "";
    await search();
  } catch (error) { clear(); filterError.value = errorText(error); }
}
function syncStorage(event: StorageEvent): void { if (event.key === null || ["admin_token", "admin_session"].includes(event.key)) syncSession(); }
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
watch(() => [route.query.product_id, route.query.is_reply], () => { if (alive) { clear(); void applyRoute(); } });
onMounted(() => { alive = true; window.addEventListener("admin-session-changed", syncSession); window.addEventListener("admin-auth-expired", syncSession); window.addEventListener("storage", syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener("admin-session-changed", syncSession); window.removeEventListener("admin-auth-expired", syncSession); window.removeEventListener("storage", syncStorage); });
</script>

<style scoped>
.reply-page { min-width: 0; }.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.page-head h2 { font-size: 18px; margin: 0; }.filters { display: flex; flex-wrap: wrap; }.filters :deep(.el-select) { width: 115px; }
.head-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.table-scroll { overflow-x: auto; width: 100%; }.row-actions { display: flex; flex-wrap: wrap; gap: 8px; }.row-actions :deep(.el-button + .el-button) { margin-left: 0; }
.stars { color: #ff9900; }.pic { width: 48px; height: 48px; border-radius: 6px; }.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.message-text { white-space: pre-wrap; overflow-wrap: anywhere; }.content-count { text-align: right; margin-top: 8px; }.pager { justify-content: flex-end; margin-top: 16px; }
@media (max-width: 650px) { .filters :deep(.el-form-item) { width: 100%; margin-right: 0; }.filters :deep(.el-form-item__content), .filters :deep(.el-input), .filters :deep(.el-date-editor) { min-width: 0; width: 100%; } }
</style>
