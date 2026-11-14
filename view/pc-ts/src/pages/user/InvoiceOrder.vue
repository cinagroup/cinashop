<template><BuyerInvoiceView :flow="flow" order-page /></template>
<script setup lang="ts">
import { reactive } from 'vue';
import BuyerInvoiceView from '@/components/BuyerInvoiceView.vue';
import { useBuyerInvoices } from '@/composables/useBuyerInvoices';
const flow = reactive(useBuyerInvoices(true));
</script>
