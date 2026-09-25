<template><AgentApplicationForm kind="agent" :requested-id="requestedId" /></template>
<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";
import AgentApplicationForm from "@/components/AgentApplicationForm.vue";
import { resumePendingSmsChallenge } from "@/utils/smsChallenge";
const requestedId = ref("");
onLoad((query) => { requestedId.value = String(query?.id ?? ""); });
onShow(() => { void resumePendingSmsChallenge(); });
</script>
