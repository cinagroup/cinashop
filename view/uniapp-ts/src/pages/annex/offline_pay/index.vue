<template><OfflineCashierView :state="state" :cashier="cashier" :logged-in="auth.isLoggedIn" :result-only="false" :login="login" :launch="launchOfflineTicket" /></template>
<script setup lang="ts">
import OfflineCashierView from '@/components/OfflineCashierView.vue';
import { useOfflineCashier } from '@/composables/useOfflineCashier';
const {auth,state,cashier,login,launchOfflineTicket}=useOfflineCashier();
</script>
