<template><OfflineCashier result-only /></template>
<script setup lang="ts">
// Separate route component so Vue never reuses a mutable cashier instance when
// navigating between collection and the strictly read-only provider return.
import OfflineCashier from './OfflineCashier.vue';
</script>
