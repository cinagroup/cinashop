<template>
  <view v-if="postId > 0" class="community-comments">
    <view class="comments-heading">
      <text>评论 · {{ total }} 条公开评论</text>
      <button class="comments-refresh" :disabled="busy || loading" @tap="refresh()">刷新评论</button>
    </view>
    <view v-if="unknown" class="comments-warning" role="alert">操作结果未确认，请刷新评论核实，请勿重复提交。</view>
    <view v-if="error" class="comments-error" role="alert">{{ error }}</view>
    <view v-if="message" class="comments-message" role="status">{{ message }}</view>
    <view v-if="configLoading" class="comments-state">加载评论设置...</view>
    <view v-else-if="config && !enabled" class="comments-state">评论功能已关闭</view>
    <template v-if="enabled && !unknown">
      <view v-if="!writable" class="comments-state">当前帖子仅可查看评论及删除本人评论</view>
      <view v-for="root in roots.rows" :key="root.id" class="comment-thread">
        <view v-for="row in threadRows(root)" :key="row.id" class="comment-row" :class="{ 'comment-reply': row.isReply === 0 }">
          <view class="comment-byline" @tap="openAuthor(row)">
            <image v-if="row.author_image" class="comment-avatar" :src="row.author_image" mode="aspectFill" />
            <text class="comment-author">{{ row.author || '社区用户' }}</text>
            <text class="comment-time">{{ time(row.addTime) }}</text>
          </view>
          <view v-if="row.isReply === 0 && row.comment_author" class="comment-target" @tap="openAuthor(row, true)">回复 {{ row.comment_author }}</view>
          <view class="comment-content">{{ row.content }}</view>
          <view v-if="row.isShow === 0" class="comment-hidden">该评论已隐藏，仅你可见</view>
          <view class="comment-actions">
            <button v-if="shown(root) && shown(row)" :disabled="!canInteract || !writable" class="comment-like"
              :class="{ liked: row.isLike === 1 }" @tap="toggleLike(row)">{{ row.isLike === 1 ? '取消点赞' : '点赞' }} {{ row.likeNum }}</button>
            <button v-if="shown(root) && shown(row) && config?.community_comment_add === 1" :disabled="!canAdd" @tap="replyTo(row)">回复</button>
            <button v-if="own(row)" class="comment-delete" :disabled="!canInteract" @tap="requestDelete(row)">删除</button>
          </view>
          <view v-if="deleteId === row.id" class="comment-delete-intent" role="alert">
            <text>{{ row.isReply === 1 ? '删除这条评论及其全部回复？' : '删除这条回复？' }}</text>
            <view class="comment-actions">
              <button @tap="cancelDelete">保留评论</button>
              <button :disabled="!canInteract" @tap="confirmDelete">确认删除评论</button>
            </view>
          </view>
        </view>
        <button v-if="root.reply_count > 0 || replies.get(root.id)?.expanded" class="comment-expand" :disabled="busy || unknown"
          @tap="toggleReplies(root)">{{ replies.get(root.id)?.expanded ? '收起回复' : `展开回复（${root.reply_count}）` }}</button>
        <view v-if="replies.get(root.id)?.expanded" class="reply-pagination">
          <view v-if="replies.get(root.id)?.loading" class="comments-state">加载回复...</view>
          <view v-if="replies.get(root.id)?.error" class="comments-error" role="alert">{{ replies.get(root.id)?.error }}</view>
          <button v-if="!replies.get(root.id)?.finished" :disabled="busy || loading" @tap="moreReplies(root.id)">
            {{ replies.get(root.id)?.error ? '重试回复' : '更多回复' }}</button>
          <view v-else class="comments-state">回复已全部显示</view>
        </view>
      </view>
      <view v-if="roots.loading" class="comments-state">加载评论...</view>
      <view v-if="roots.error" class="comments-error" role="alert">{{ roots.error }}</view>
      <button v-if="!roots.finished && !roots.loading" class="comments-more" :disabled="busy || loading" @tap="loadMore()">
        {{ roots.error ? '重试评论' : '更多评论' }}</button>
      <view v-if="roots.finished && !roots.rows.length" class="comments-state">暂无评论</view>
      <view v-if="!loggedIn" class="comments-login"><button @tap="login">登录后参与评论</button></view>
      <view v-else-if="config?.community_comment_add === 0" class="comments-state">评论发布已关闭</view>
      <view v-else-if="writable" class="comment-composer">
        <view v-if="target" class="comment-reply-intent">回复 {{ target.author }}<button :disabled="busy" @tap="cancelReply">取消回复</button></view>
        <textarea v-model="text" class="comment-input" maxlength="1000" :auto-height="true" :disabled="!canAdd"
          :placeholder="target ? `回复 ${target.author}...` : '说点什么...'" />
        <view class="comment-composer-actions"><text>{{ text.length }}/1000</text><button class="comment-send" :disabled="!canAdd" @tap="submit">发送评论</button></view>
      </view>
    </template>
    <view v-else-if="!config && !configLoading && !unknown && !error" class="comments-state">{{ busy ? '评论操作处理中，请稍候刷新' : '刷新后查看评论' }}</view>
  </view>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useCommunityComments } from '@/composables/useCommunityComments';
import type { CommunityThreadComment } from '@/api/community';
const props = defineProps<{ postId: number; total: number; writable: boolean }>();
const emit = defineEmits<{ count: [value: { postId: number; count: number }] }>();
const thread = useCommunityComments();
const { roots, replies, config, configLoading, enabled, loading, busy, unknown, canInteract, canAdd, loggedIn,
  error, message, text, target, deleteId, refresh, loadMore, toggleReplies, moreReplies, replyTo, cancelReply,
  submit, toggleLike, own, shown, requestDelete, cancelDelete, confirmDelete, openAuthor, login } = thread;
watch(() => [props.postId, props.writable] as const, ([id, writable]) => { void thread.setContext(id, writable); }, { immediate: true });
watch(thread.countUpdate, value => { if (value) emit('count', value); }, { flush: 'sync' });
function threadRows(root: CommunityThreadComment) {
  const page = replies.get(root.id); return page?.expanded ? [root, ...page.rows] : [root];
}
function time(stamp: number) {
  if (!stamp) return '';
  const date = new Date(stamp * 1000), pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
</script>

<style scoped>
.community-comments { margin-top: 28rpx; padding-top: 20rpx; border-top: 1rpx solid #eee; color: #333; font-size: 26rpx; }
.comments-heading, .comment-byline, .comment-composer-actions, .comment-reply-intent { display: flex; align-items: center; gap: 14rpx; }
.comments-heading { justify-content: space-between; font-weight: 600; }
.community-comments button { margin: 0; padding: 8rpx 18rpx; line-height: 1.5; font-size: 24rpx; border: 0; }
.community-comments button::after { border: 0; }
.comment-thread { padding: 20rpx 0; border-bottom: 1rpx solid #eee; }
.comment-row { padding: 12rpx 0; overflow-wrap: anywhere; }
.comment-reply { margin-left: 28rpx; padding-left: 18rpx; border-left: 3rpx solid #eee; }
.comment-avatar { width: 48rpx; height: 48rpx; border-radius: 50%; flex-shrink: 0; }
.comment-author { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.comment-time { color: #999; font-size: 21rpx; flex-shrink: 0; margin-left: auto; }
.comment-content { margin: 14rpx 0; line-height: 1.65; white-space: pre-wrap; }
.comment-target, .comment-expand, .liked { color: var(--view-theme, #e93323); }
.comment-actions { display: flex; flex-wrap: wrap; gap: 12rpx; }
.comment-hidden, .comments-state { padding: 14rpx 0; color: #888; font-size: 24rpx; }
.comments-warning, .comments-error { margin: 16rpx 0; padding: 18rpx; color: #a32920; background: #fff2ee; border-radius: 12rpx; overflow-wrap: anywhere; }
.comments-message { padding: 16rpx 0; color: #367442; }
.comment-delete-intent { margin-top: 14rpx; padding: 18rpx; background: #fff5f2; border-radius: 12rpx; }
.comment-delete-intent .comment-actions { margin-top: 12rpx; }
.comment-composer { margin-top: 20rpx; padding: 18rpx; border-radius: 12rpx; background: #f5f6f8; }
.comment-input { box-sizing: border-box; width: 100%; min-height: 100rpx; padding: 14rpx 0; font-size: 26rpx; line-height: 1.6; }
.comment-composer-actions { justify-content: space-between; color: #999; font-size: 22rpx; }
.community-comments .comment-send { background: var(--view-theme, #e93323); color: #fff; }
.comment-reply-intent { justify-content: space-between; overflow-wrap: anywhere; }
.comments-more, .comment-expand { margin-top: 14rpx !important; }
</style>
