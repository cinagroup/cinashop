<template>
  <div v-if="loggedIn" class="message-nav">
    <RouterLink to="/user/messages" class="action-link" :aria-label="badge.unread === null ? '站内信，未读数待核对' : '站内信，' + badge.unread + '条未读'">
      站内信 <span v-if="badge.unread !== null && badge.unread > 0" class="message-badge" data-message-badge>{{ badge.unread > 99 ? '99+' : badge.unread }}</span>
    </RouterLink>
    <button type="button" class="message-refresh" :disabled="badge.loading" aria-label="核对站内信未读数" @click="refresh">{{ badge.loading ? '核对中' : '核对未读数' }}</button>
    <span v-if="badge.error" class="message-pending" role="status">未读数待核对</span>
  </div>
</template>
<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { usePcMessageBadge } from '@/composables/usePcMessageBadge';
const { badge, loggedIn, refresh } = usePcMessageBadge();
</script>
<style scoped>
.message-nav{display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:220px}.action-link{font-size:14px;color:#555;white-space:nowrap}.message-badge{display:inline-block;padding:1px 6px;border-radius:10px;background:#c8332e;color:#fff;line-height:18px;font-size:12px}.message-refresh{padding:0;border:0;background:transparent;color:#777;font-size:11px;cursor:pointer}.message-refresh:disabled{cursor:default}.message-pending{color:#956025;font-size:11px}
</style>
