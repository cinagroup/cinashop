<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import { getProductReviews, replyProductReview } from "@/api/supplier";
import { useAuthStore } from "@/stores/auth";
import type { SupplierProductReview } from "@/types";

const auth = useAuthStore();
const canManageProducts = computed(() => auth.can("supplier.product.manage"));
const loading = ref(false);
const rows = ref<SupplierProductReview[]>([]);
const total = ref(0);
const filters = reactive({ page: 1, limit: 15, is_reply: "", store_name: "", account: "" });
const replyDialogOpen = ref(false);
const replySubmitting = ref(false);
const current = ref<SupplierProductReview | null>(null);
const replyContent = ref("");

async function load() {
  loading.value = true;
  try {
    const result = await getProductReviews(filters);
    rows.value = result.list;
    total.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "商品评价加载失败");
  } finally {
    loading.value = false;
  }
}

function search() {
  filters.page = 1;
  void load();
}

function openReply(row: SupplierProductReview) {
  if (!canManageProducts.value) return;
  current.value = row;
  replyContent.value = row.replyComment?.content ?? "";
  replyDialogOpen.value = true;
}

async function submitReply() {
  if (!current.value || !canManageProducts.value) return;
  const content = replyContent.value.replace(/\0/g, "").trim();
  if (!content) {
    ElMessage.warning("请输入回复内容");
    return;
  }
  if (content.length > 500) {
    ElMessage.warning("回复内容不能超过500个字符");
    return;
  }
  replySubmitting.value = true;
  try {
    await replyProductReview(current.value.id, content);
    replyDialogOpen.value = false;
    await load();
    ElMessage.success(current.value.replyComment ? "回复已更新" : "回复成功");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "评价回复失败");
  } finally {
    replySubmitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-section product-reviews-page">
    <header class="page-heading">
      <div><h1>商品评价</h1><p>查看当前供应商商品的客户评价，并维护可审计的供应商回复</p></div>
    </header>

    <div class="surface list-surface">
      <div class="filter-row">
        <el-select v-model="filters.is_reply" class="state-select" clearable placeholder="回复状态" @change="search">
          <el-option label="待回复" value="0" /><el-option label="已回复" value="1" />
        </el-select>
        <el-input v-model="filters.store_name" class="search-input" clearable placeholder="商品ID或商品名称" @keyup.enter="search">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-input v-model="filters.account" class="account-input" clearable placeholder="用户名称" @keyup.enter="search" />
        <el-button type="primary" @click="search">查询</el-button>
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
      <div class="pagination-row"><span>共 {{ total }} 条评价</span><el-pagination v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" /></div>
    </div>

    <el-dialog v-if="canManageProducts" v-model="replyDialogOpen" :title="current?.replyComment ? '修改供应商回复' : '回复商品评价'" width="min(560px, 94vw)">
      <div v-if="current" class="reply-context"><strong>{{ current.store_name }}</strong><p>{{ current.comment }}</p></div>
      <el-input v-model="replyContent" type="textarea" :rows="5" maxlength="500" show-word-limit placeholder="回复内容将作为当前供应商的公开回应" />
      <p class="security-note">回复只会写入当前供应商拥有的评价；客户原评价保持不可变。</p>
      <template #footer><el-button @click="replyDialogOpen = false">取消</el-button><el-button type="primary" :loading="replySubmitting" @click="submitReply">保存回复</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
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
