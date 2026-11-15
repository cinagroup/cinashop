<template>
  <div class="messages-page container" data-pc-message-center>
    <header class="messages-heading"><h1>站内信</h1><RouterLink to="/user">返回个人中心</RouterLink></header>
    <div v-if="!loggedIn" class="message-state"><p>登录后查看站内信</p><RouterLink :to="loginPath">登录后继续</RouterLink></div>
    <template v-else>
      <p class="read-policy">打开一页站内信会将该页消息标记为已读。「本次打开前未读」表示打开本页之前的状态。</p>
      <div class="message-toolbar"><span>{{ badge.unread === null ? '未读数待核对' : '当前未读 ' + badge.unread + ' 条' }}</span><button type="button" :disabled="state.loading || state.detailLoading" @click="load(state.result?.query.page || 1)">刷新当前页</button><button type="button" :disabled="state.loading || state.detailLoading || badge.loading" @click="checkUnread">{{ badge.loading ? '核对未读数中…' : '只读核对未读数' }}</button></div>
      <p v-if="state.loading" class="message-state" role="status">正在读取第 {{ state.requestedPage }} 页站内信…</p>
      <div v-if="state.error" class="message-error" role="alert"><p>第 {{ state.failedPage }} 页读取未确认：{{ state.error }}</p><p v-if="state.result">仍显示上次成功读取的第 {{ state.result.query.page }} 页。消息可能已经标为已读，可只读核对未读数。</p><button type="button" :disabled="state.loading" @click="retry">重试第 {{ state.failedPage }} 页</button></div>
      <p v-if="badge.error" class="message-state warning" role="status">{{ badge.error }}</p>
      <template v-if="state.result">
        <p class="message-total" data-message-total>共 {{ state.result.count }} 条站内信 · 第 {{ state.result.query.page }} 页，共 {{ state.result.page_count }} 页 · 每页 7 条</p>
        <div class="message-list">
          <article v-for="item in state.result.list" :key="item.id" class="message-card" :data-message-id="item.id">
            <header><div class="message-title"><h2>{{ item.title || '站内信' }}</h2><span v-if="!item.read_before" class="new-message">本次打开前未读</span></div><time>{{ messageDate(item.add_time) }}</time><button type="button" :disabled="state.loading || state.detailLoading || !!state.error" :aria-expanded="state.detailId === item.id" @click="open(item.id)">{{ state.detailId === item.id ? '收起' : '展开' }}</button></header>
            <div v-if="state.detailId === item.id" class="message-detail">
              <p v-if="state.detailLoading" role="status">正在读取消息详情…</p>
              <div v-else-if="state.detailError" class="message-error" role="alert"><p>{{ state.detailError }}</p><button type="button" @click="retryDetail">重新读取这条消息</button></div>
              <template v-else-if="state.detail"><h3>{{ state.detail.title || '站内信' }}</h3><div class="message-content">{{ state.detail.content }}</div></template>
              <p v-else-if="state.detailLoaded" class="message-state">消息不存在或已不可查看，可刷新当前页。</p>
            </div>
          </article>
        </div>
        <p v-if="!state.result.list.length" class="message-state">{{ state.result.count ? '本页暂无消息，目录可能已变化，请返回第一页。' : '暂无站内信' }}</p>
        <nav v-if="state.result.count" class="message-pages" aria-label="站内信分页">
          <button type="button" :disabled="locked || state.result.query.page === 1" @click="page(1)">第一页</button><button type="button" :disabled="locked || state.result.query.page <= 1" @click="page(state.result.query.page - 1)">上一页</button>
          <button type="button" :disabled="locked || state.result.query.page >= state.result.page_count" @click="page(state.result.query.page + 1)">下一页</button><button type="button" :disabled="locked || state.result.query.page === state.result.page_count" @click="page(state.result.page_count)">最后一页</button>
          <form @submit.prevent="jump"><label>跳转页码 <input v-model="pageInput" inputmode="numeric" aria-label="站内信页码" :disabled="locked" /></label><button type="submit" :disabled="locked">跳转</button></form><p v-if="pageError" class="message-error" role="alert">{{ pageError }}</p>
        </nav>
      </template>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { usePcMessages } from '@/composables/usePcMessages';
const { state, badge, loggedIn, loginPath, load, page, retry, open, retryDetail, checkUnread } = usePcMessages();
const pageInput = ref(''), pageError = ref(''), locked = computed(() => state.loading || state.detailLoading || !!state.error);
watch(() => [state.result?.query.page, loggedIn.value], () => { pageInput.value = ''; pageError.value = ''; });
function jump() { const target = Number(pageInput.value); if (!/^[1-9]\d*$/.test(pageInput.value) || !Number.isSafeInteger(target) || !state.result || target > state.result.page_count) { pageError.value = '请输入当前总页数内的页码'; return; } pageError.value = ''; page(target); }
function messageDate(seconds: number) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(seconds * 1000)); }
</script>
<style scoped>
.messages-page{padding-top:24px;padding-bottom:36px;max-width:1000px}.messages-heading,.message-toolbar,.message-card header,.message-pages,.message-pages form{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.messages-heading{justify-content:space-between;margin-bottom:20px}.messages-heading h1{font-size:24px;margin:0}.messages-heading a{font-size:14px;color:#a72d24}.read-policy{font-size:14px;line-height:1.8;background:#fff8e9;padding:14px 18px;border-radius:8px;color:#77551e}.message-toolbar{font-size:14px;margin:20px 0}.messages-page button{padding:8px 13px;border:1px solid #d7b6b1;border-radius:6px;background:#fff;color:#a12e27;cursor:pointer;line-height:1.5}.messages-page button:disabled{cursor:default;color:#999;border-color:#ddd;background:#f6f6f6}.message-total{font-size:13px;color:#666}.message-list{display:flex;flex-direction:column;gap:16px}.message-card{background:#fff;border-radius:9px;overflow:hidden;min-width:0}.message-card header{padding:18px;background:#f1f1f1}.message-title{display:flex;align-items:center;gap:8px;flex:1;min-width:0;flex-wrap:wrap}.message-title h2{margin:0;font-size:16px;overflow-wrap:anywhere;font-weight:500}.message-card time{font-size:12px;color:#888}.new-message{font-size:12px;color:#a83027;border:1px solid #e8c1bc;border-radius:4px;padding:2px 5px}.message-detail{padding:22px;min-width:0}.message-detail h3{font-size:16px;margin:0 0 16px;overflow-wrap:anywhere}.message-content{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.9;font-size:14px}.message-state{padding:20px 12px;text-align:center;font-size:14px;line-height:1.8;color:#777;overflow-wrap:anywhere}.message-error{padding:12px 16px;color:#a72f27;line-height:1.8;background:#fff5f0;border-radius:7px;overflow-wrap:anywhere;font-size:14px}.message-error p{margin:0 0 8px}.warning{color:#906124}.message-pages{margin-top:24px}.message-pages input{width:75px;min-height:34px;border:1px solid #ccc;border-radius:5px;padding:2px 7px;font:inherit}.message-pages label{font-size:14px;color:#555}.message-pages p{width:100%;margin:0}@media(max-width:600px){.messages-page{padding-top:18px}.message-card header{padding:14px;gap:10px}.message-title{flex-basis:100%}.message-card time{flex:1}.message-detail{padding:16px}.message-toolbar button{font-size:12px}.messages-heading h1{font-size:21px}}
</style>
