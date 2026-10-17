<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getSupplierProductDetail } from '@/api/supplierProductDetail';
import { previewMode } from '@/api/supplier';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { supplierProductDetailId } from '@/utils/productDetailRoute';
import { supplierProductDetailVideo, formatSupplierProductDetailMoney as formatMoney } from '@/utils/productDetail';
import { productDescriptionPreview, productImagePreview } from '@/utils/productMedia';
import { formatTime } from '@/utils/format';
import type { SupplierProductDetail, SupplierProductDetailContext } from '@/types/productDetail';

const route = useRoute(), router = useRouter(), auth = useAuthStore();
const detail = ref<SupplierProductDetail | null>(null), loading = ref(false), fresh = ref(false);
const error = ref(''), invalidated = ref(false), now = ref(Date.now()), failedImages = ref(new Set<string>());
let generation = 0, read: AbortController | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
const session = createSupplierSessionScope(() => { invalidated.value = true; clear(); }, previewMode);
const productId = computed(() => supplierProductDetailId(route.params, route.query, previewMode));
const canView = computed(() => !invalidated.value && auth.can('supplier.product.view'));
const context = computed<SupplierProductDetailContext | null>(() => {
  const actorId = auth.user?.id ?? (previewMode ? 1 : 0), supplierId = auth.user?.supplier_id ?? (previewMode ? 1 : 0);
  return productId.value && Number.isSafeInteger(actorId) && actorId > 0 && Number.isSafeInteger(supplierId) && supplierId > 0
    ? { actorId, supplierId, productId: productId.value } : null;
});
const product = computed(() => detail.value?.product);
const canUseDetail = computed(() => canView.value && fresh.value && !loading.value && !!detail.value);
const canEdit = computed(() => canUseDetail.value && auth.can('supplier.product.manage')
  && !!product.value && [0, 1, 3].includes(product.value.product_type));
const description = computed(() => detail.value
  ? productDescriptionPreview(detail.value.media.description_html, detail.value.media.previews, now.value) : '');
const video = computed(() => detail.value ? supplierProductDetailVideo(detail.value, now.value) : null);
const pictures = computed(() => product.value ? [...new Set([product.value.image, ...product.value.slider_image].filter(Boolean))] : []);
function clear() {
  generation++; read?.abort(); read = undefined; clearTimeout(expiryTimer); expiryTimer = undefined;
  detail.value = null; fresh.value = false; loading.value = false; error.value = ''; failedImages.value = new Set();
}
function snapshot() { return { generation, path: route.fullPath, context: JSON.stringify(context.value) }; }
function active(c: ReturnType<typeof snapshot>) {
  try { return session.isCurrent() && c.generation === generation && c.path === route.fullPath
    && c.context === JSON.stringify(context.value) && !!context.value && canView.value; }
  catch { invalidated.value = true; clear(); return false; }
}
function scheduleMediaExpiry() {
  clearTimeout(expiryTimer); now.value = Date.now();
  if (!detail.value) return;
  const expiries = Object.values(detail.value.media.previews).flatMap(entry => entry.status === 'ready' && entry.expires_at !== null
    ? [entry.expires_at * 1000] : []);
  const signedVideo = /[?&]expires=([1-9]\d*)/.exec(detail.value.product.video_preview_url);
  if (signedVideo) expiries.push(Number(signedVideo[1]) * 1000);
  const next = Math.min(...expiries.filter(expiry => Number.isSafeInteger(expiry) && expiry > now.value));
  if (Number.isFinite(next)) expiryTimer = setTimeout(scheduleMediaExpiry, Math.min(next - now.value, 2_147_483_647));
}
async function load() {
  clear(); const c = snapshot(), expected = context.value; if (!expected || !active(c)) return;
  const controller = read = new AbortController(); loading.value = true;
  try {
    const result = await getSupplierProductDetail(expected, controller.signal);
    if (!active(c) || controller.signal.aborted) return;
    detail.value = result; fresh.value = true; scheduleMediaExpiry();
  } catch (cause) {
    if (active(c) && !controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '商品详情读取失败';
  } finally { if (active(c) && !controller.signal.aborted) loading.value = false; }
}
function image(reference: string) {
  return detail.value && !failedImages.value.has(reference) ? productImagePreview(reference, detail.value.media.previews, now.value) : null;
}
function failed(reference: string) { failedImages.value = new Set([...failedImages.value, reference]); }
function reviews() {
  if (!active(snapshot()) || !canUseDetail.value) return;
  void router.push({ path: '/product-reviews', query: { product_id: String(productId.value) } });
}
function edit() {
  if (!active(snapshot()) || !canEdit.value) return;
  void router.push(`/products/${productId.value}/edit`);
}
function typeName(value: number) { return ({ 0: '实物商品', 1: '卡密商品', 2: '优惠券商品', 3: '虚拟商品', 4: '次卡商品' } as Record<number, string>)[value] ?? `商品类型 ${value}`; }
function verifyName(value: number) { return value === 1 ? '审核通过' : value === 0 ? '待审核' : '审核未通过'; }
function freightName(value: number) { return ({ 1: '包邮', 2: '固定运费', 3: '运费模板' } as Record<number, string>)[value] ?? '未设置'; }
watch(() => route.fullPath, () => { void load(); }, { flush: 'sync' });
watch(() => [auth.token, auth.user?.id, auth.user?.supplier_id, auth.permissionsLoaded, JSON.stringify(auth.permissions)], () => {
  invalidated.value = true; clear();
}, { flush: 'sync' });
onMounted(load);
onBeforeUnmount(() => { clear(); session.dispose(); });
</script>

<template>
  <section class="page-section product-detail-page">
    <header class="page-heading">
      <div><h1>商品详情</h1><p v-if="productId">商品 #{{ productId }}<template v-if="product"> · {{ product.store_name }}</template></p><p v-else>查看商品资料、规格与配送信息</p></div>
      <div class="detail-actions"><el-button @click="router.push('/products')">返回商品列表</el-button><el-button v-if="canUseDetail" @click="reviews">查看评价</el-button><el-button v-if="canEdit" @click="edit">编辑商品</el-button></div>
    </header>
    <el-alert v-if="!productId" title="商品编号或查询参数无效，请返回商品列表重新选择" type="warning" :closable="false" />
    <el-alert v-else-if="invalidated" title="登录状态或权限已变化，请重新进入页面" type="warning" :closable="false" />
    <el-alert v-else-if="!canView || !context" title="当前账号无法查看商品详情" type="warning" :closable="false" />
    <template v-else>
      <div class="detail-toolbar"><span>商品资料仅供查看</span><el-button :loading="loading" @click="load">刷新详情</el-button></div>
      <el-alert v-if="error" :title="error" type="warning" :closable="false" />
      <p v-if="loading" role="status" class="detail-loading">正在读取商品详情…</p>
      <template v-if="detail && product && fresh">
        <article class="surface detail-card">
          <div class="detail-summary"><div class="detail-main-image"><img v-if="image(product.image)" :src="image(product.image)!" :alt="product.store_name" referrerpolicy="no-referrer" @error="failed(product.image)" /><span v-else>图片暂不可用</span></div><div><p class="detail-kind">{{ typeName(product.product_type) }}</p><h2>{{ product.store_name }}</h2><p>{{ product.store_info || '暂无商品简介' }}</p><div class="detail-badges"><span>{{ verifyName(product.is_verify) }}</span><span>{{ product.is_show === 1 ? '已上架' : '未上架' }}</span></div><p class="detail-price">¥{{ formatMoney(product.price) }}<small> / {{ product.unit_name || '件' }}</small></p></div></div>
          <dl class="detail-facts"><div><dt>商品 ID</dt><dd>{{ detail.product_id }}</dd></div><div><dt>库存</dt><dd>{{ product.stock }}</dd></div><div><dt>销量</dt><dd>{{ product.sales }}</dd></div><div><dt>划线价</dt><dd>¥{{ formatMoney(product.ot_price) }}</dd></div><div><dt>会员价</dt><dd>¥{{ formatMoney(product.vip_price) }}</dd></div><div><dt>商品条码</dt><dd>{{ product.bar_code || '未填写' }}</dd></div><div><dt>关键词</dt><dd>{{ product.keyword || '未填写' }}</dd></div><div><dt>创建时间</dt><dd>{{ formatTime(product.add_time) }}</dd></div></dl>
          <p v-if="product.refusal" class="detail-refusal">审核说明：{{ product.refusal }}</p>
        </article>
        <article class="surface detail-card">
          <h2>商品规格</h2><dl v-if="detail.attributes.length" class="detail-facts"><div v-for="attribute in detail.attributes" :key="attribute.name"><dt>{{ attribute.name }}</dt><dd>{{ attribute.values.join(' / ') }}</dd></div></dl>
          <p v-if="!detail.skus.length" class="detail-empty">暂无在售规格</p>
          <div v-else class="detail-table-scroll" tabindex="0" aria-label="商品规格表，可横向滚动"><table><thead><tr><th>规格</th><th>售价</th><th>划线价</th><th>会员价</th><th>库存</th><th>销量</th><th>条码</th></tr></thead><tbody><tr v-for="sku in detail.skus" :key="sku.id"><td><div class="detail-sku"><img v-if="image(sku.image)" :src="image(sku.image)!" alt="" referrerpolicy="no-referrer" @error="failed(sku.image)" /><span>{{ sku.suk || '默认规格' }}</span></div></td><td>¥{{ formatMoney(sku.price) }}</td><td>¥{{ formatMoney(sku.ot_price) }}</td><td>¥{{ formatMoney(sku.vip_price) }}</td><td>{{ sku.stock }}</td><td>{{ sku.sales }}</td><td>{{ sku.bar_code || '—' }}</td></tr></tbody></table></div>
        </article>
        <article class="surface detail-card"><h2>配送与售后</h2><dl class="detail-facts"><div><dt>运费方式</dt><dd>{{ freightName(product.freight) }}</dd></div><div v-if="product.freight === 2"><dt>固定运费</dt><dd>¥{{ formatMoney(product.postage) }}</dd></div><div v-if="product.freight === 3"><dt>运费模板</dt><dd>#{{ product.temp_id }}</dd></div><div><dt>参与包邮活动</dt><dd>{{ product.is_postage === 1 ? '参与' : '不参与' }}</dd></div><div><dt>支持退款</dt><dd>{{ product.is_support_refund === 1 ? '支持' : '不支持' }}</dd></div><div><dt>购买限制</dt><dd>{{ product.is_limit === 1 ? `${product.limit_type === 1 ? '单次' : '累计'}限购 ${product.limit_num} 件` : '不限购' }}</dd></div></dl></article>
        <article class="surface detail-card"><h2>商品图片与视频</h2><div v-if="pictures.length" class="detail-gallery"><div v-for="reference in pictures" :key="reference"><img v-if="image(reference)" :src="image(reference)!" alt="商品图片" referrerpolicy="no-referrer" @error="failed(reference)" /><span v-else>图片暂不可用</span></div></div><p v-else class="detail-empty">暂无商品图片</p><video v-if="video" :src="video" controls preload="none" class="detail-video" /><p v-else-if="product.video_link" class="detail-empty">视频暂不可用，请手动刷新详情</p><p v-if="detail.media.status !== 'ready'" class="detail-empty">部分媒体暂不可用，可手动刷新详情。</p></article>
        <article class="surface detail-card"><h2>商品介绍</h2><div v-if="description" class="detail-rich-text" v-html="description" /><p v-else class="detail-empty">暂无可展示的商品介绍</p></article>
      </template>
    </template>
  </section>
</template>

<style scoped>
.product-detail-page { min-width: 0; }
.page-heading > div:first-child { min-width: 0; }
.page-heading p { overflow-wrap: anywhere; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.detail-actions :deep(.el-button + .el-button) { margin-left: 0; }
.detail-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 16px; color: var(--muted); font-size: 13px; }
.detail-card { min-width: 0; padding: 22px; margin-bottom: 18px; }
.detail-card h2 { margin: 0 0 16px; font-size: 17px; overflow-wrap: anywhere; }
.detail-summary { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 24px; align-items: center; }
.detail-summary p { overflow-wrap: anywhere; color: var(--muted); }
.detail-main-image { display: flex; align-items: center; justify-content: center; width: 150px; height: 150px; background: var(--surface-soft, #f4f6f9); border-radius: 10px; color: var(--muted); font-size: 13px; }
.detail-main-image img { width: 100%; height: 100%; border-radius: inherit; object-fit: contain; }
.detail-kind { margin: 0 0 8px; font-size: 12px; }
.detail-badges { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.detail-badges span { padding: 4px 8px; border: 1px solid var(--border); border-radius: 5px; }
.detail-summary .detail-price { margin-bottom: 0; color: var(--primary, #0f9e9a); font-size: 26px; font-weight: 600; }
.detail-price small { color: var(--muted); font-size: 13px; font-weight: 400; }
.detail-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin: 22px 0 0; }
.detail-facts dt { margin-bottom: 6px; color: var(--muted); font-size: 12px; }
.detail-facts dd { margin: 0; overflow-wrap: anywhere; font-size: 14px; }
.detail-refusal { padding-top: 12px; color: var(--danger, #b94a48); overflow-wrap: anywhere; }
.detail-table-scroll { max-width: 100%; overflow-x: auto; margin-top: 20px; }
.detail-table-scroll table { width: 100%; min-width: 680px; border-collapse: collapse; text-align: left; font-size: 13px; }
.detail-table-scroll th, .detail-table-scroll td { padding: 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.detail-table-scroll th { color: var(--muted); font-weight: 500; }
.detail-sku { display: flex; gap: 10px; align-items: center; max-width: 280px; white-space: normal; overflow-wrap: anywhere; }
.detail-sku img { width: 38px; height: 38px; border-radius: 5px; object-fit: cover; }
.detail-gallery { display: flex; gap: 12px; flex-wrap: wrap; }
.detail-gallery > div { display: flex; width: 120px; height: 120px; align-items: center; justify-content: center; background: var(--surface-soft, #f4f6f9); border-radius: 8px; color: var(--muted); font-size: 12px; }
.detail-gallery img { width: 100%; height: 100%; object-fit: contain; border-radius: inherit; }
.detail-video { display: block; width: min(100%, 640px); max-height: 360px; margin-top: 18px; }
.detail-rich-text { overflow-wrap: anywhere; line-height: 1.8; }
.detail-rich-text :deep(img), .detail-rich-text :deep(video) { max-width: 100%; height: auto; }
.detail-rich-text :deep(table) { display: block; max-width: 100%; overflow-x: auto; }
.detail-empty, .detail-loading { color: var(--muted); font-size: 13px; }
@media (max-width: 720px) {
  .detail-card { padding: 16px; }
  .detail-summary { grid-template-columns: 90px minmax(0, 1fr); gap: 14px; }
  .detail-main-image { width: 90px; height: 90px; }
  .detail-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .detail-gallery > div { width: 96px; height: 96px; }
}
</style>
