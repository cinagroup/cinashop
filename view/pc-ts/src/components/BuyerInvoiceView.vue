<template>
  <div class="invoice-page container">
    <div class="invoice-heading"><div><h2>{{ orderPage ? '订单发票' : '我的发票' }}</h2><p class="muted">{{ orderPage ? flow.state.order?.orderNo || '核对当前订单的开票资料' : '查看开票进度，管理常用抬头' }}</p></div>
      <div class="invoice-actions"><el-button :disabled="flow.state.loading || flow.state.busy" @click="flow.load">刷新资料</el-button><el-button v-if="orderPage" @click="flow.manage">我的发票</el-button></div></div>
    <div v-if="!orderPage" class="invoice-tabs" role="group" aria-label="发票内容"><el-button :type="flow.state.kind === 'records' ? 'primary' : 'default'" :disabled="flow.state.loading || flow.state.busy" @click="flow.selectKind('records')">开票记录</el-button><el-button :type="flow.state.kind === 'titles' ? 'primary' : 'default'" :disabled="flow.state.loading || flow.state.busy" @click="flow.selectKind('titles')">抬头管理</el-button></div>
    <p v-if="flow.state.loading" role="status">正在读取发票资料…</p><el-alert v-if="flow.state.error" :title="flow.state.error" type="error" :closable="false" />
    <p v-if="flow.state.message" role="status" class="invoice-message">{{ flow.state.message }}</p>
    <BuyerInvoiceSnapshot v-if="orderPage && flow.state.order?.invoice" :invoice="flow.state.order.invoice" />
    <el-alert v-else-if="orderPage && flow.state.order && !flow.state.order.canApply" :title="flow.state.order.reason || '当前订单不能申请发票，请联系商家核对'" :closable="false" />
    <template v-if="flow.state.page">
      <p v-if="!flow.state.page.capabilities.enabled" class="muted">商家暂未开启新的开票申请，已有记录和抬头仍可查看管理。</p>
      <template v-if="flow.state.kind === 'records'">
        <p class="muted">显示已支付且未退款的开票记录。需要补开时，请从对应订单详情进入。</p>
        <article v-for="record in flow.records" :key="record.id" class="invoice-card"><div class="invoice-row"><h3>{{ record.name }}</h3><el-tag :type="record.state === -1 ? 'danger' : record.state === 1 ? 'success' : 'info'">{{ invoiceStateText(record) }}</el-tag></div>
          <p>{{ record.product?.name || '订单开票申请' }}</p><p class="muted">{{ invoiceTypeText(record) }} · {{ record.orderNo }}</p><p>{{ record.amount === null ? '历史金额未记录' : '¥' + record.amount }} · {{ record.addTime || '申请时间未记录' }}</p><el-button @click="flow.openRecord(record)">查看开票详情</el-button></article>
        <el-empty v-if="!flow.records.length" description="暂无开票记录" />
      </template>
      <template v-else>
        <section v-if="orderPage && flow.state.order" class="invoice-card"><h3>选择开票抬头</h3><p>申请金额：<strong>¥{{ flow.state.order.amount }}</strong></p><p class="muted">提交申请后由商家处理，请以开票记录状态为准。{{ flow.state.order.paid ? '' : '订单尚未支付，申请将等待支付完成。' }}</p></section>
        <el-button type="primary" :disabled="blocked" @click="flow.edit()">新增抬头</el-button>
        <BuyerInvoiceForm v-if="flow.state.draft" :draft="flow.state.draft" :disabled="flow.state.busy" :special="flow.state.page.capabilities.special" @save="flow.save" @cancel="flow.closeForm" />
        <article v-for="title in flow.titles" :key="title.id" class="invoice-card"><div class="invoice-row"><h3>{{ title.name }}</h3><el-tag v-if="title.isDefault" type="info">同类默认</el-tag></div>
          <p class="muted">{{ invoiceTypeText(title) }}</p><p v-if="title.dutyNumber">税号：{{ title.dutyNumber }}</p><p>手机号：{{ title.drawerPhone || '未记录' }}</p><p>邮箱：{{ title.email || '未记录' }}</p>
          <p v-if="orderPage && title.type === 2 && !flow.state.page.capabilities.special" class="muted">商家暂未开启专用发票，请选择普通发票抬头。</p>
          <div class="invoice-actions"><el-button :disabled="blocked || !!flow.state.draft" @click="flow.edit(title)">编辑抬头</el-button>
            <el-button v-if="orderPage" type="primary" :disabled="blocked || !!flow.state.draft || (title.type === 2 && !flow.state.page.capabilities.special)" @click="flow.apply(title)">使用此抬头申请</el-button>
            <template v-else><el-button v-if="!title.isDefault" :disabled="blocked || !!flow.state.draft" @click="flow.setDefault(title)">设为同类默认</el-button><el-button type="danger" plain :disabled="blocked || !!flow.state.draft" @click="flow.remove(title)">删除抬头</el-button></template></div></article>
        <el-empty v-if="!flow.titles.length && !flow.state.draft" :description="orderPage ? '请先添加开票抬头' : '暂无抬头资料'" />
      </template>
      <div class="invoice-pagination"><el-button v-if="flow.hasPrevious" :disabled="blocked" @click="flow.back">上一页</el-button><el-button v-if="flow.state.page.nextCursor" :disabled="blocked" @click="flow.next">下一页</el-button></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import type { useBuyerInvoices } from '@/composables/useBuyerInvoices';
import BuyerInvoiceForm from './BuyerInvoiceForm.vue';
import BuyerInvoiceSnapshot from './BuyerInvoiceSnapshot.vue';
import { invoiceStateText, invoiceTypeText } from '../../../common/buyerInvoiceFlow';
const props = defineProps<{ flow: UnwrapNestedRefs<ReturnType<typeof useBuyerInvoices>>; orderPage?: boolean }>();
const blocked = computed(() => props.flow.state.loading || props.flow.state.busy || props.flow.state.uncertain);
</script>
<style scoped>
.invoice-page{max-width:960px;padding-bottom:40px;overflow-wrap:anywhere}.invoice-heading,.invoice-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.invoice-heading{margin:26px 0}.invoice-heading h2{font-size:24px;margin:0 0 8px}.invoice-heading p{margin:0}.invoice-tabs,.invoice-pagination{display:flex;gap:12px;margin:20px 0}.invoice-tabs .el-button,.invoice-pagination .el-button{margin:0}.invoice-card{background:#fff;border:1px solid #e2e7ee;border-radius:10px;padding:24px;margin:20px 0}.invoice-card h3{font-size:18px;margin:0}.invoice-card p{line-height:1.7;margin:10px 0}.invoice-actions{display:flex;gap:10px;flex-wrap:wrap}.invoice-actions .el-button{margin:0}.muted{color:#66717f;font-size:14px;line-height:1.7}.invoice-message{padding:14px 18px;background:#f0f7ff;color:#21548b;border-radius:8px;line-height:1.7}@media(max-width:640px){.invoice-card{padding:18px}.invoice-heading{align-items:flex-start}.invoice-row{align-items:flex-start}}
</style>
