<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { ArrowLeft, Printer } from "@element-plus/icons-vue";
import { getPickingSheets } from "@/api/supplier";
import type { PickingSheetOrder, PickingSheetResult } from "@/types";
import { formatMoney, formatTime, payType } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const errorMessage = ref("");
const result = ref<PickingSheetResult | null>(null);

function parseOrderIds(value: unknown): number[] {
  if (typeof value !== "string") throw new Error("请选择需要预览的订单");
  const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw new Error("请选择需要预览的订单");
  if (parts.length > 10) throw new Error("每次最多预览10个订单");
  const ids = parts.map((item) => Number(item));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("订单ID格式错误");
  if (new Set(ids).size !== ids.length) throw new Error("订单ID不能重复");
  return ids;
}

const pages = computed(() => {
  const output: Array<{ order: PickingSheetOrder; items: PickingSheetOrder["items"]; page: number; pages: number }> = [];
  for (const order of result.value?.list ?? []) {
    const chunks: PickingSheetOrder["items"][] = [];
    const items = order.items.length ? order.items : [];
    if (!items.length) chunks.push([]);
    for (let index = 0; index < items.length; index += 6) chunks.push(items.slice(index, index + 6));
    chunks.forEach((chunk, index) => output.push({ order, items: chunk, page: index + 1, pages: chunks.length }));
  }
  return output;
});

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    result.value = await getPickingSheets(parseOrderIds(route.query.ids));
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "配货单加载失败";
    ElMessage.error(errorMessage.value);
  } finally {
    loading.value = false;
  }
}

function printSheets() {
  if (!pages.value.length) return ElMessage.warning("没有可打印的配货单");
  window.print();
}

onMounted(load);
</script>

<template>
  <div class="picking-preview">
    <header class="preview-toolbar no-print">
      <el-button :icon="ArrowLeft" @click="router.push('/orders')">返回订单</el-button>
      <div><h1>配货单打印预览</h1><p>每页最多6条商品；请在打印前核对收件信息与订单备注</p></div>
      <el-button type="primary" :icon="Printer" :disabled="!pages.length" @click="printSheets">打印配货单</el-button>
    </header>
    <el-alert
      class="preview-note no-print"
      title="旧页面的二维码只重复编码站点首页，与订单或配货流程无关，本预览不再生成。"
      type="info"
      :closable="false"
      show-icon
    />

    <main v-loading="loading" class="sheet-stage">
      <el-empty v-if="!loading && errorMessage" :description="errorMessage">
        <el-button type="primary" @click="router.push('/orders')">返回订单列表</el-button>
      </el-empty>
      <el-empty v-else-if="!loading && !pages.length" description="没有可预览的配货单" />

      <section v-for="entry in pages" :key="`${entry.order.id}-${entry.page}`" class="picking-page">
        <div class="sheet-title">
          <div><span>配货单</span><small>{{ result?.supplier.name }}</small></div>
          <strong>{{ entry.order.order_id }}</strong>
        </div>

        <div class="order-meta">
          <section><h2>收件信息</h2><p><b>收货人</b>{{ entry.order.real_name }}</p><p><b>手机号</b>{{ entry.order.user_phone }}</p><p><b>地址</b>{{ entry.order.user_address }}</p></section>
          <section><h2>订单信息</h2><p><b>支付时间</b>{{ entry.order.pay_time ? formatTime(entry.order.pay_time) : "未支付" }}</p><p><b>支付方式</b>{{ payType(entry.order.pay_type) }}</p><p><b>分页</b>第 {{ entry.page }} / {{ entry.pages }} 页</p></section>
        </div>

        <table class="items-table">
          <thead><tr><th>#</th><th>商品名称</th><th>规格</th><th>单价</th><th>数量</th><th>小计</th></tr></thead>
          <tbody>
            <tr v-for="item in entry.items" :key="item.index">
              <td>{{ item.index }}</td><td>{{ item.product_name }}</td><td>{{ item.sku }}</td><td>{{ formatMoney(item.unit_price) }}</td><td>{{ item.quantity }}</td><td>{{ formatMoney(item.subtotal) }}</td>
            </tr>
            <tr v-if="!entry.items.length"><td colspan="6" class="empty-items">该订单没有可用商品快照，请先核对数据迁移</td></tr>
          </tbody>
        </table>

        <div class="amounts">
          <span>运费 {{ formatMoney(entry.order.freight_price) }}</span>
          <span>优惠券 -{{ formatMoney(entry.order.coupon_price) }}</span>
          <span>会员折扣 -{{ formatMoney(entry.order.vip_true_price) }}</span>
          <span>积分抵扣 -{{ formatMoney(entry.order.deduction_price) }}</span>
          <strong>实付 {{ formatMoney(entry.order.pay_price) }}</strong>
        </div>
        <div class="remarks"><p><b>用户备注</b>{{ entry.order.mark || "—" }}</p><p v-if="entry.order.supplier_remark"><b>供应商备注</b>{{ entry.order.supplier_remark }}</p></div>
        <footer><span>{{ result?.supplier.address || "未配置供应商地址" }}</span><span>{{ result?.supplier.phone || "未配置联系电话" }}</span></footer>
      </section>
    </main>
  </div>
</template>

<style scoped>
.picking-preview { min-height: 100vh; padding: 20px; color: #111827; background: #eef1f5; }
.preview-toolbar { position: sticky; top: 0; z-index: 5; max-width: 1000px; min-height: 72px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 18px; margin: 0 auto 12px; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: rgba(255,255,255,.96); box-shadow: var(--shadow); }
.preview-toolbar h1 { margin: 0; font-size: 18px; }
.preview-toolbar p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.preview-note { max-width: 1000px; margin: 0 auto 14px; }
.sheet-stage { min-height: 300px; }
.picking-page { width: min(100%, 1000px); min-height: 720px; margin: 0 auto 18px; padding: 30px 34px 24px; overflow: hidden; border: 1px solid #d7dce3; background: #fff; box-shadow: 0 8px 24px rgba(14,35,68,.08); break-after: page; }
.picking-page:last-child { break-after: auto; }
.sheet-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 18px; border-bottom: 2px solid #111827; }
.sheet-title div { display: flex; align-items: baseline; gap: 12px; }
.sheet-title span { font-size: 25px; font-weight: 800; letter-spacing: .08em; }
.sheet-title small { color: #4b5563; font-size: 13px; }
.sheet-title strong { font-size: 15px; font-variant-numeric: tabular-nums; }
.order-meta { display: grid; grid-template-columns: 1.35fr 1fr; gap: 32px; padding: 18px 0; }
.order-meta h2 { margin: 0 0 10px; font-size: 14px; }
.order-meta p { display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px; margin: 7px 0; font-size: 12px; line-height: 1.55; }
.order-meta b, .remarks b { color: #4b5563; font-weight: 650; }
.items-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
.items-table th, .items-table td { padding: 12px 9px; border: 1px solid #9ca3af; text-align: center; overflow-wrap: anywhere; }
.items-table th { background: #f3f4f6; font-weight: 700; }
.items-table th:nth-child(1) { width: 6%; }
.items-table th:nth-child(2) { width: 31%; }
.items-table th:nth-child(3) { width: 23%; }
.items-table th:nth-child(4), .items-table th:nth-child(6) { width: 15%; }
.items-table th:nth-child(5) { width: 10%; }
.items-table td:nth-child(2), .items-table td:nth-child(3) { text-align: left; }
.empty-items { height: 90px; color: #6b7280; text-align: center !important; }
.amounts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px 20px; padding: 18px 0 14px; border-bottom: 1px solid #d1d5db; font-size: 12px; }
.amounts strong { font-size: 15px; }
.remarks { padding: 12px 0; min-height: 68px; }
.remarks p { display: grid; grid-template-columns: 82px minmax(0,1fr); gap: 8px; margin: 7px 0; font-size: 12px; overflow-wrap: anywhere; }
.picking-page footer { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 30px; padding-top: 14px; border-top: 1px solid #d1d5db; color: #4b5563; font-size: 11px; }
@media (max-width: 600px) {
  .picking-preview { padding: 10px 0 20px; }
  .preview-toolbar { position: static; grid-template-columns: 1fr 1fr; gap: 10px; border-left: 0; border-right: 0; border-radius: 0; }
  .preview-toolbar > div { grid-column: 1 / -1; grid-row: 1; }
  .preview-note { width: auto; margin: 0 10px 10px; }
  .picking-page { min-height: 0; padding: 20px 12px; border-left: 0; border-right: 0; }
  .sheet-title { align-items: flex-start; flex-direction: column; gap: 8px; }
  .sheet-title span { font-size: 21px; }
  .order-meta { grid-template-columns: 1fr; gap: 12px; }
  .items-table { font-size: 10px; }
  .items-table th, .items-table td { padding: 8px 4px; }
  .items-table th:first-child, .items-table td:first-child { display: none; }
  .items-table th:nth-child(2) { width: 29%; }
  .items-table th:nth-child(3) { width: 23%; }
  .items-table th:nth-child(4), .items-table th:nth-child(6) { width: 18%; }
  .items-table th:nth-child(5) { width: 12%; }
}
@media print {
  .no-print { display: none !important; }
  .picking-preview { padding: 0; background: #fff; }
  .sheet-stage { min-height: 0; }
  .picking-page { width: 100%; min-height: 0; margin: 0; padding: 0; border: 0; box-shadow: none; }
}
</style>

<style>
@page { size: A4 portrait; margin: 10mm; }
@media print { html, body, #app { min-width: 0 !important; background: #fff !important; } }
</style>
