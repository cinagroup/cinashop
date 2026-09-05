<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useNoticeStore } from '@/stores/notices';
const auth = useAuthStore(), notices = useNoticeStore(), route = useRoute(), router = useRouter();
watch(() => [auth.token, route.path, route.query.preview], () => {
  notices.setSession(route.path === '/login' || (import.meta.env.DEV && route.query.preview === '1') ? '' : auth.token);
}, { immediate: true, flush: 'sync' });
function expire() { auth.clearSession(); notices.setSession(''); void router.replace('/login'); }
onMounted(() => { notices.start(); window.addEventListener('kefu-auth-expired', expire); });
onBeforeUnmount(() => { notices.stop(); window.removeEventListener('kefu-auth-expired', expire); });
</script>
<template><RouterView /></template>
