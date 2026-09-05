<script setup lang="ts">
import { useNoticeStore } from '@/stores/notices';
import { noticeStateText } from '../../../common/staff-notifications';
const notices = useNoticeStore();
const preview = import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === '1';
</script>
<template>
  <div class="staff-notice-status" aria-label="系统提醒连接">
    <RouterLink :to="preview ? '/messages?preview=1' : '/messages'">系统提醒{{ notices.unread === null ? '' : ` · ${notices.unread} 条未读` }}</RouterLink>
    <span role="status">{{ preview ? '预览数据 · 未连接通知' : noticeStateText[notices.state] }}</span>
    <button v-if="!preview && ['retrying', 'denied'].includes(notices.state)" type="button" @click="notices.retry()">重连通知</button>
  </div>
</template>
<style scoped>
.staff-notice-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 12px 0; font-size: 12px; color: #5b6e78; }
a { color: #207367; } button { border: 1px solid #c6d7d4; border-radius: 6px; padding: 5px 8px; background: white; color: #215f56; cursor: pointer; }
</style>
