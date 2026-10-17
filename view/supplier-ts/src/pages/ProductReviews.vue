<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import { getProductReviews, replyProductReview, previewMode } from "@/api/supplier";
import { useAuthStore } from "@/stores/auth";
import { createSupplierSessionScope } from '@/utils/supplierSession';
import type { SupplierProductReview } from "@/types";

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const invalidated = ref(false), loading = ref(false), fresh = ref(false), error = ref('');
const rows = ref<SupplierProductReview[]>([]), total = ref(0);
const filters = reactive({ page: 1, limit: 15, is_reply: "", store_name: "", account: "" });
const replyDialogOpen = ref(false), replySubmitting = ref(false);
const current = ref<SupplierProductReview | null>(null), replyContent = ref("");
let generation = 0, read: AbortController | undefined, write: AbortController | undefined;
const session = createSupplierSessionScope(() => { invalidated.value = true; clear(); }, previewMode);
const canView = computed(() => !invalidated.value && auth.can('supplier.product.view'));
const canManageProducts = computed(() => canView.value && auth.can("supplier.product.manage"));
const context = computed(() => {
  const q = route.query, keys = Object.keys(q);
  if (keys.some(key => !['product_id', 'id', 'is_reply'].includes(key)
    && !(previewMode && key === 'preview' && q.preview === '1')) || ('product_id' in q && 'id' in q)) return null;
  const raw = 'product_id' in q ? q.product_id : q.id;
  let productId: number | undefined;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) return null;
    productId = Number(raw);
  }
  if (q.is_reply !== undefined && q.is_reply !== '0' && q.is_reply !== '1') return null;
  return { productId, isReply: (q.is_reply ?? '') as string };
});
function closeReply() { write?.abort(); write = undefined; replyDialogOpen.value = false; replySubmitting.value = false; current.value = null; replyContent.value = ''; }
function clear() {
  generation++; read?.abort(); read = undefined; closeReply();
  loading.value = false; fresh.value = false; rows.value = []; total.value = 0; error.value = '';
}
function query() { return { ...filters, ...(context.value?.productId ? { product_id: context.value.productId } : {}) }; }
function snapshot() { return { generation, path: route.fullPath, query: JSON.stringify(query()) }; }
function active(c: ReturnType<typeof snapshot>, manage = false) {
  try { return session.isCurrent() && c.generation === generation && c.path === route.fullPath
    && c.query === JSON.stringify(query()) && !!context.value && (manage ? canManageProducts.value : canView.value); }
  catch { invalidated.value = true; clear(); return false; }
}
function validRow(row: SupplierProductReview) {
  return row && Number.isSafeInteger(row.id) && row.id > 0 && Number.isSafeInteger(row.product_id) && row.product_id > 0
    && (!context.value?.productId || row.product_id === context.value.productId)
    && ['store_name', 'image', 'nickname', 'account', 'comment', 'sku', 'add_time'].every(k => typeof row[k as keyof SupplierProductReview] === 'string')
    && [row.product_score, row.service_score, row.delivery_score, row.score].every(n => Number.isInteger(n) && n >= 0 && n <= 5)
    && [0, 1].includes(row.is_reply) && (!filters.is_reply || row.is_reply === Number(filters.is_reply))
    && Array.isArray(row.pics) && row.pics.length <= 8 && row.pics.every(p => typeof p === 'string')
    && (row.replyComment === null || (Number.isSafeInteger(row.replyComment?.id) && row.replyComment.id > 0
      && typeof row.replyComment.content === 'string' && typeof row.replyComment.add_time === 'string' && typeof row.replyComment.update_time === 'string'));
}
async function load() {
  if (replySubmitting.value) return;
  clear(); const c = snapshot(); if (!active(c)) return;
  const controller = read = new AbortController(), params = query(); loading.value = true;
  try {
    const result = await getProductReviews(params, controller.signal);
    if (!active(c) || controller.signal.aborted) return;
    if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < result.list.length
      || result.list.length > params.limit || result.page !== params.page || result.limit !== params.limit
      || !result.list.every(validRow) || new Set(result.list.map(row => row.id)).size !== result.list.length) throw Error('评价结果与当前查询不符，请重新查询');
    if (params.page > 1 && (params.page - 1) * params.limit >= result.count) {
      filters.page = Math.max(1, Math.ceil(result.count / params.limit)); await load(); return;
    }
    rows.value = result.list; total.value = result.count; fresh.value = true;
  } catch (cause) {
    if (active(c) && !controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '商品评价加载失败';
  } finally { if (active(c) && !controller.signal.aborted) loading.value = false; }
}
function search() { if (replySubmitting.value) return; filters.page = 1; void load(); }
function openReply(row: SupplierProductReview) {
  if (!active(snapshot(), true) || !fresh.value || loading.value || replySubmitting.value || !rows.value.includes(row)) return;
  current.value = { ...row, pics: [...row.pics], replyComment: row.replyComment ? { ...row.replyComment } : null };
  replyContent.value = row.replyComment?.content ?? ''; replyDialogOpen.value = true;
}
async function submitReply() {
  const row = current.value, c = snapshot();
  if (!row || !replyDialogOpen.value || !fresh.value || replySubmitting.value || !active(c, true)
    || !rows.value.some(item => item.id === row.id && item.product_id === row.product_id)) return;
  const content = replyContent.value.replace(/\0/g, '').trim();
  if (!content || content.length > 500) { ElMessage.warning(content ? '回复内容不能超过500个字符' : '请输入回复内容'); return; }
  const controller = write = new AbortController(); replySubmitting.value = true;
  try {
    const receipt = await replyProductReview(row.id, content, controller.signal, row.product_id);
    if (!active(c, true) || controller.signal.aborted) return;
    if (!receipt || Object.keys(receipt).length !== 3 || receipt.id !== row.id || !Number.isSafeInteger(receipt.comment_id)
      || receipt.comment_id <= 0 || receipt.is_reply !== 1) throw Error('回复回执不完整');
    closeReply(); const refresh = load(), refreshGeneration = generation; await refresh;
    if (session.isCurrent() && refreshGeneration === generation && c.path === route.fullPath && canManageProducts.value)
      ElMessage.success(row.replyComment ? '回复已更新' : '回复成功');
  } catch (cause) {
    if (active(c, true) && !controller.signal.aborted) {
      clear(); error.value = '回复结果未确认，请重新查询评价核对后再操作';
    }
  } finally { if (write === controller) { write = undefined; replySubmitting.value = false; } }
}
function applyRoute() {
  clear(); Object.assign(filters, { page: 1, limit: 15, is_reply: context.value?.isReply ?? '', store_name: '', account: '' });
  void load();
}
watch(() => route.fullPath, applyRoute, { flush: 'sync' });
watch(() => JSON.stringify(filters), clear, { flush: 'sync' });
watch(() => [auth.token, auth.user?.id, auth.user?.supplier_id, auth.permissionsLoaded, JSON.stringify(auth.permissions)], () => {
  invalidated.value = true; clear();
}, { flush: 'sync' });
onMounted(applyRoute);
onBeforeUnmount(() => { clear(); session.dispose(); });
</script>

<template>
  <section class="page-section product-reviews-page">
    <header class="page-heading">
      <div><h1>商品评价</h1><p v-if="context?.productId">商品 #{{ context.productId }} 的客户评价</p><p v-else>查看当前供应商商品的客户评价，并维护供应商回复</p></div>
      <div class="heading-actions"><el-button v-if="context?.productId || !context" @click="router.push('/product-reviews')">返回全店评价</el-button><el-button @click="router.push('/products')">返回商品列表</el-button></div>
    </header>

    <el-alert v-if="!context" title="商品评价查询参数无效，请返回全店评价重新选择" type="warning" :closable="false" />
    <el-alert v-if="invalidated" title="登录状态或权限已变化，请重新进入页面" type="warning" :closable="false" />
    <el-alert v-if="error" :title="error" type="warning" :closable="false" class="review-alert" />
    <div v-if="context && canView" class="surface list-surface">
      <div class="filter-row">
        <el-select v-model="filters.is_reply" class="state-select" :disabled="replySubmitting" clearable placeholder="回复状态" @change="search">
          <el-option label="待回复" value="0" /><el-option label="已回复" value="1" />
        </el-select>
        <el-input v-model="filters.store_name" class="search-input" :disabled="replySubmitting" clearable placeholder="商品ID或商品名称" @keyup.enter="search">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-input v-model="filters.account" class="account-input" :disabled="replySubmitting" clearable placeholder="用户名称" @keyup.enter="search" />
        <el-button type="primary" :disabled="replySubmitting" @click="search">查询</el-button>
      </div>

      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="id" label="评价 ID" width="100" />
        <el-table-column label="商品" min-width="240">
          <template #default="scope">
            <div class="review-product">
              <img v-if="scope.row.image" :src="scope.row.image" alt="" />
              <div><strong>{{ scope.row.store_name }}</strong><span>#{{ scope.row.product_id }}<template v-if="scope.row.sku"> · {{ scope.row.sku }}</template></span></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="nickname" label="用户" min-width="140" />
        <el-table-column label="评分" width="150"><template #default="scope"><el-rate :model-value="scope.row.score" disabled /></template></el-table-column>
        <el-table-column label="评价内容" min-width="260">
          <template #default="scope">
            <div class="review-content"><p>{{ scope.row.comment }}</p><div v-if="scope.row.pics.length" class="review-pictures"><el-image v-for="picture in scope.row.pics" :key="picture" :src="picture" :preview-src-list="scope.row.pics" fit="cover" /></div></div>
          </template>
        </el-table-column>
        <el-table-column label="供应商回复" min-width="260"><template #default="scope"><span v-if="scope.row.replyComment">{{ scope.row.replyComment.content }}</span><span v-else class="muted">尚未回复</span></template></el-table-column>
        <el-table-column prop="add_time" label="评价时间" width="180" />
        <el-table-column v-if="canManageProducts" label="操作" width="100" fixed="right"><template #default="scope"><el-button link type="primary" @click="openReply(scope.row)">{{ scope.row.replyComment ? "修改回复" : "回复" }}</el-button></template></el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ total }} 条评价</span><el-pagination :disabled="replySubmitting || loading" v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" /></div>
    </div>

    <el-dialog v-if="canManageProducts" v-model="replyDialogOpen" :title="current?.replyComment ? '修改供应商回复' : '回复商品评价'" width="min(560px, 94vw)" :close-on-click-modal="!replySubmitting" :close-on-press-escape="!replySubmitting" :show-close="!replySubmitting" @close="closeReply">
      <div v-if="current" class="reply-context"><strong>{{ current.store_name }}</strong><p>{{ current.comment }}</p></div>
      <el-input :disabled="replySubmitting" v-model="replyContent" type="textarea" :rows="5" maxlength="500" show-word-limit placeholder="回复内容将作为当前供应商的公开回应" />
      <p class="security-note">回复只会写入当前供应商拥有的评价；客户原评价保持不可变。</p>
      <template #footer><el-button :disabled="replySubmitting" @click="closeReply">取消</el-button><el-button type="primary" :loading="replySubmitting" @click="submitReply">保存回复</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.review-alert { margin-bottom: 16px; }
.account-input { width: 220px; }
.review-product { display: flex; align-items: center; gap: 12px; }
.review-product img { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; }
.review-product strong, .review-product span { display: block; }
.review-product span, .muted { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.review-content p, .reply-context p { margin: 0; line-height: 1.6; }
.review-pictures { display: flex; gap: 6px; margin-top: 8px; }
.review-pictures :deep(.el-image) { width: 42px; height: 42px; border-radius: 6px; }
.reply-context { margin-bottom: 16px; padding: 14px; border-radius: 10px; background: var(--el-fill-color-light); }
.reply-context p { margin-top: 6px; color: var(--el-text-color-secondary); }
@media (max-width: 720px) { .account-input { width: 100%; } }
</style>
