<template>
  <div class="goods-detail container">
    <el-skeleton v-if="loading" :rows="8" animated />
    <template v-else-if="detail">
      <div class="detail-main">
        <!-- 图片 -->
        <div class="gallery">
          <el-carousel height="400px">
            <el-carousel-item v-for="(img, i) in detail.slider_image" :key="i">
              <img :src="img" class="gallery-img" :alt="detail.store_name" />
            </el-carousel-item>
          </el-carousel>
        </div>

        <!-- 信息 -->
        <div class="info">
          <h1 class="name">{{ detail.store_name }}</h1>
          <p class="subtitle">{{ detail.store_info }}</p>

          <div class="price-box">
            <span class="price-label">价格</span>
            <span class="price">¥{{ detail.price }}</span>
            <span v-if="detail.ot_price && Number(detail.ot_price) > Number(detail.price)" class="ot-price">
              ¥{{ detail.ot_price }}
            </span>
            <span v-if="detail.is_vip" class="vip-tag">SVIP ¥{{ detail.vip_price }}</span>
          </div>

          <div class="meta">
            <span>已售 {{ detail.fsales }}</span>
            <span>库存 {{ detail.stock }}</span>
            <span>评分 {{ detail.star }}</span>
          </div>

          <div class="qty-row">
            <span class="qty-label">数量</span>
            <el-input-number v-model="qty" :min="1" :max="Math.max(detail.stock, 1)" />
          </div>

          <div class="actions">
            <el-button
              type="danger"
              size="large"
              :disabled="detail.cart_button === 0"
              @click="addToCart"
            >
              加入购物车
            </el-button>
            <el-button
              type="primary"
              size="large"
              :disabled="detail.cart_button === 0"
              @click="buyNow"
            >
              立即购买
            </el-button>
            <el-button size="large" :type="collected ? 'warning' : 'default'" @click="toggleCollect">
              {{ collected ? "已收藏" : "收藏" }}
            </el-button>
          </div>
        </div>
      </div>

      <!-- 商品评价 -->
      <div class="reply-section">
        <div class="reply-head">
          <h3 class="reply-title">商品评价</h3>
          <span v-if="replyStats.total > 0" class="reply-count">
            ({{ replyStats.total }}) · {{ replyStats.avgScore }}分 · 好评率{{ replyStats.goodRate }}%
          </span>
        </div>
        <div v-if="replies.length" class="reply-list">
          <div v-for="r in replies" :key="(r as any).id" class="reply-item">
            <div class="reply-user">
              <span class="reply-avatar">{{ ((r as any).nickname || "用")[0] }}</span>
              <span class="reply-name">{{ (r as any).nickname || "用户" }}</span>
              <span class="reply-stars">{{ starText((r as any).productScore) }}</span>
            </div>
            <div class="reply-comment">{{ (r as any).comment }}</div>
            <div v-if="(r as any).pics && (r as any).pics.length" class="reply-pics">
              <el-image
                v-for="(p, i) in (r as any).pics"
                :key="i"
                :src="p"
                class="reply-pic"
                fit="cover"
                :preview-src-list="(r as any).pics"
              />
            </div>
            <div class="reply-meta">
              <span>{{ (r as any).sku || "默认规格" }}</span>
              <span>{{ formatTime((r as any).addTime) }}</span>
            </div>
          </div>
        </div>
        <el-empty v-else :image-size="60" description="暂无评价, 快来抢沙发" />
      </div>
    </template>
    <el-empty v-else description="商品不存在或已下架" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiGoodsDetail, apiReplyConfig, apiReplyList } from "@/api/product";
import { apiCartAdd } from "@/api/cart";
import type { GoodsDetail } from "@/types/product";
import { isLoggedIn } from "@/utils/auth";

const route = useRoute();
const router = useRouter();
const detail = ref<GoodsDetail | null>(null);
const loading = ref(true);
const qty = ref(1);
const collected = ref(false);
const replies = ref<unknown[]>([]);
const replyStats = ref({ total: 0, avgScore: "0.0", goodRate: 100 });

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function starText(score: number): string {
  const n = Math.min(5, Math.max(1, Number(score) || 5));
  return "★".repeat(n);
}

async function loadReplies(productId: number) {
  try {
    replyStats.value = await apiReplyConfig(productId);
  } catch {
    // 静默
  }
  try {
    replies.value = await apiReplyList(productId);
  } catch {
    replies.value = [];
  }
}

async function load() {
  loading.value = true;
  try {
    const id = Number(route.params.id);
    detail.value = await apiGoodsDetail(id);
    collected.value = detail.value.userCollect;
    loadReplies(id);
  } catch (e) {
    console.error("商品详情加载失败", e);
  } finally {
    loading.value = false;
  }
}

async function addToCart() {
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
  if (!detail.value) return;
  try {
    await apiCartAdd({
      productId: detail.value.id,
      unique: `sku${String(detail.value.id).padStart(5, "0")}`,
      cartNum: qty.value,
    });
    ElMessage.success("已加入购物车");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加入失败");
  }
}

function buyNow() {
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
  ElMessage.info("立即购买接入中, 请先在购物车结算");
  addToCart();
}

function toggleCollect() {
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
  collected.value = !collected.value;
  ElMessage.success(collected.value ? "收藏成功" : "已取消收藏");
}

onMounted(load);
</script>

<style scoped>
.goods-detail {
  padding-top: 20px;
}

.detail-main {
  display: flex;
  gap: 32px;
  background: #fff;
  border-radius: 8px;
  padding: 24px;
}

.gallery {
  flex: 0 0 400px;
  border-radius: 8px;
  overflow: hidden;
}

.gallery-img {
  width: 100%;
  height: 400px;
  object-fit: cover;
}

.info {
  flex: 1;
}

.name {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 8px;
}

.subtitle {
  color: #999;
  font-size: 14px;
  margin-bottom: 16px;
}

.price-box {
  background: #f8f8f8;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.price-label {
  color: #999;
  font-size: 13px;
}

.price {
  color: #e64340;
  font-size: 28px;
  font-weight: 700;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 14px;
}

.vip-tag {
  background: linear-gradient(90deg, #d4a94e, #f5d97a);
  color: #fff;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
}

.meta {
  display: flex;
  gap: 24px;
  color: #666;
  font-size: 13px;
  margin-bottom: 16px;
}

.qty-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.qty-label {
  color: #666;
}

.actions {
  display: flex;
  gap: 12px;
}

.reply-section {
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  margin-top: 20px;
}

.reply-head {
  display: flex;
  align-items: baseline;
  margin-bottom: 16px;
}

.reply-title {
  font-size: 16px;
  margin: 0;
}

.reply-count {
  font-size: 13px;
  color: #999;
  margin-left: 12px;
}

.reply-item {
  border-top: 1px solid #f5f5f5;
  padding: 16px 0;
}

.reply-user {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.reply-avatar {
  width: 32px;
  height: 32px;
  background: #e64340;
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.reply-name {
  font-size: 14px;
  color: #333;
}

.reply-stars {
  color: #ff9900;
  font-size: 13px;
}

.reply-comment {
  font-size: 14px;
  color: #444;
  line-height: 1.6;
}

.reply-pics {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.reply-pic {
  width: 80px;
  height: 80px;
  border-radius: 6px;
}

.reply-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: #bbb;
}
</style>
