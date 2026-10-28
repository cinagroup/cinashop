<template>
  <ThemePage>
    <view class="agent-explanation" :data-agent-explanation-id="s.record?.id||0" :data-agent-explanation-loaded="s.loaded" :data-agent-explanation-expired="s.mediaExpired">
      <view v-if="s.loading" class="state" role="status">正在读取分销说明…</view>
      <view v-else-if="s.error" class="state" role="alert"><view>{{s.error}}</view><button @tap="s.load">重新读取说明</button></view>
      <template v-else-if="s.record">
        <view class="content"><template v-if="document.nodes.length"><AgentExplanationRichNode v-for="(node,index) in document.nodes" :key="`${document.key}:${index}`" :node="node" :allowed="document.allowed" :positions="document.positions" @position="document.position($event)" @link="document.open($event)" @reload="document.reload" /></template><view v-else class="empty">商家尚未配置分销说明正文</view></view>
        <view v-if="s.mediaExpired" class="state"><view>说明图片或视频预览已过期</view><button @tap="s.load">重新读取说明</button></view>
      </template>
      <view v-else-if="s.loaded" class="state">商家尚未配置分销说明</view>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import {computed,reactive} from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import AgentExplanationRichNode from '@/components/agent/AgentExplanationRichNode.vue';
import {useAgentExplanation} from '@/composables/useAgentExplanation';
const s=reactive(useAgentExplanation()),document=computed(()=>s.view());
</script>
<style scoped>
.agent-explanation{min-height:100vh;background:#fff;color:#333;font-size:28rpx;line-height:1.8;box-sizing:border-box;overflow-wrap:anywhere}.content{padding:15px 30rpx 40rpx}.state{padding:80rpx 30rpx;text-align:center;color:#888;font-size:26rpx;line-height:1.8}.state button{display:inline-block;margin:28rpx auto 0;padding:12rpx 38rpx;border:1rpx solid #ddd;background:#fff;color:#555;font-size:26rpx;line-height:1.7}.state button::after{border:0}.empty{color:#999;font-size:26rpx}
</style>
