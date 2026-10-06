<template><DistributorCatalog :key="String(route.params.levelId)" kind="task" :level-id="String(route.params.levelId ?? '')" /></template>
<script setup lang="ts">
import { useRoute } from 'vue-router';
import DistributorCatalog from './DistributorCatalog.vue';
const route = useRoute();
</script>
