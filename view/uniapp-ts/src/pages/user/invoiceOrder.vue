<template><ThemePage><BuyerInvoiceView :flow="flow" order-page /><DiySuspendedNavigation /></ThemePage></template>
<script setup lang="ts">
import { reactive } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import BuyerInvoiceView from '@/components/BuyerInvoiceView.vue';
import { useBuyerInvoices } from '@/composables/useBuyerInvoices';
const flow = reactive(useBuyerInvoices(true));
</script>
