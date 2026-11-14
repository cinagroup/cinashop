<template>
  <form class="invoice-form" aria-label="编辑发票抬头" @submit.prevent="$emit('save')">
    <h3>{{ draft.id ? '编辑抬头' : '新增抬头' }}</h3>
    <fieldset :disabled="disabled"><legend>发票种类</legend>
      <label><input type="radio" name="invoice-type" :checked="draft.type === 1" @change="draft.type = 1" />普通发票</label>
      <label v-if="special || draft.type === 2"><input type="radio" name="invoice-type" :checked="draft.type === 2" @change="draft.type = 2; draft.headerType = 2" />增值税专用发票</label>
    </fieldset>
    <fieldset :disabled="disabled"><legend>抬头类型</legend>
      <label><input type="radio" name="invoice-header" :checked="draft.headerType === 1" @change="draft.headerType = 1; draft.type = 1" />个人</label>
      <label><input type="radio" name="invoice-header" :checked="draft.headerType === 2" @change="draft.headerType = 2" />企业</label>
    </fieldset>
    <div class="invoice-fields">
      <label v-for="field in fields" :key="field.key">{{ field.label }}{{ field.required ? ' *' : '（选填）' }}<el-input v-model="draft[field.key]" :disabled="disabled" :maxlength="field.max" autocomplete="off" /></label>
    </div>
    <label class="invoice-default"><input v-model="draft.isDefault" type="checkbox" :disabled="disabled" />设为同类默认抬头</label>
    <p class="muted">默认项按个人/企业和发票种类分别设置。保存抬头后，还需在订单中提交开票申请。</p>
    <div class="invoice-actions"><el-button type="primary" native-type="submit" :disabled="disabled">保存抬头</el-button><el-button :disabled="disabled" @click="$emit('cancel')">取消编辑</el-button></div>
  </form>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { BuyerInvoiceDraft } from '../../../common/buyerInvoices';
import { buyerInvoiceFormFields } from '../../../common/buyerInvoiceForm';
const props = defineProps<{ draft: BuyerInvoiceDraft; disabled: boolean; special: boolean }>();
defineEmits<{ save: []; cancel: [] }>();
const fields = computed(() => buyerInvoiceFormFields(props.draft));
</script>
<style scoped>
.invoice-form{background:#fff;border:1px solid #dce3eb;border-radius:10px;padding:24px;margin:20px 0}.invoice-form h3{margin:0 0 18px;font-size:18px}.invoice-form fieldset{border:0;padding:0;margin:0 0 18px}.invoice-form legend{padding:0;margin-bottom:8px}.invoice-form fieldset label{margin-right:24px;line-height:2}.invoice-form input[type=radio],.invoice-default input{margin-right:6px}.invoice-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.invoice-fields label{display:grid;gap:8px}.invoice-default{display:block;margin-top:18px}.muted{color:#66717f;font-size:13px;line-height:1.7}.invoice-actions{display:flex;flex-wrap:wrap;gap:10px}.invoice-actions .el-button{margin:0}@media(max-width:640px){.invoice-form{padding:18px}.invoice-fields{grid-template-columns:1fr}}
</style>
