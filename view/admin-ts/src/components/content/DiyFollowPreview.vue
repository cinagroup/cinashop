<template>
  <section class="follow-preview" aria-label="公众号关注只读预览">
    <p class="hint">客户端内容预览 · 关注与关闭按钮仅展示</p>
    <p v-if="!config.enabled" class="hint">此组件已隐藏，配置仍保留。</p>
    <div v-else :style="config.wrapperStyle">
      <div class="follow-card" :style="config.cardStyle">
        <div class="follow-profile"><img v-if="config.image" class="avatar" :src="config.image" alt="公众号头像预览" /><span v-else class="avatar placeholder">微</span><span class="follow-title">{{ config.title }}</span></div>
        <button type="button" class="follow-button" :style="config.buttonStyle" disabled>关注</button><span class="follow-close" aria-hidden="true">×</span>
      </div>
      <div class="code-preview"><span>当前组件二维码</span><img v-if="config.code" :src="config.code" alt="公众号二维码预览" /><p v-else class="hint">尚无可显示的二维码预览</p></div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { normalizeDiyFollowPreview } from '@/utils/diyFollowProjection';
const props = withDefaults(defineProps<{ block: unknown; previews?: Record<string, string> }>(), { previews: () => ({}) });
const config = computed(() => normalizeDiyFollowPreview(props.block, props.previews));
</script>
<style scoped>
.follow-preview{width:min(375px,100%);min-width:0;box-sizing:border-box;overflow-wrap:anywhere}.hint{margin:6px 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.follow-card{display:flex;min-height:60px;padding:7px 12px;align-items:center;box-sizing:border-box;box-shadow:0 2.5px 11px #0000000d}.follow-profile{display:flex;flex:1;min-width:0;align-items:center}.avatar{width:46px;height:46px;border-radius:50%;object-fit:cover;flex:none;background:#f1f1f1}.placeholder{display:flex;align-items:center;justify-content:center;color:#aaa;font-size:14px}.follow-title{margin-left:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;color:#333}.follow-button{flex:none;width:56px;margin-left:6px;padding:0;border:1px solid;border-radius:15px;background:transparent;font-size:11.5px;line-height:27px;opacity:1}.follow-close{margin-left:9px;padding-left:6px;color:#999;font-size:17px}.code-preview{display:grid;justify-items:center;gap:8px;margin-top:12px;padding:12px;border:1px dashed var(--el-border-color);font-size:12px}.code-preview img{width:180px;max-width:100%;height:180px;object-fit:contain}
</style>
