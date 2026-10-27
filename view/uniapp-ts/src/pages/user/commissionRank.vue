<template><ThemePage><DistributionRanking :state="state"/></ThemePage></template>
<script setup lang="ts">
import {reactive} from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import DistributionRanking from '@/components/user/DistributionRanking.vue';
import {useDistributionRankings} from '@/composables/useDistributionRankings';
const state=reactive(useDistributionRankings('commission'));
</script>
