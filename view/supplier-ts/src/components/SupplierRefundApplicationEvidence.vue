<script setup lang="ts">
import { reactive, watch } from 'vue';
const props = defineProps<{ images?: Array<{ url: string; src: string }>; error?: string }>();
const failed = reactive(new Set<string>());
watch(() => props.images, () => failed.clear(), { flush: 'sync' });
</script>

<template>
  <section class="application-evidence" aria-label="用户退款申请凭证">
    <h3>申请凭证</h3>
    <p class="source-note">以下图片随本次退款申请提交，供核对申请原因使用。</p>
    <el-alert v-if="!images" title="接口尚未返回申请凭证信息，请刷新详情或更新服务" type="warning" :closable="false" />
    <el-alert v-else-if="error" :title="error" type="warning" :closable="false" />
    <p v-else-if="!images.length" class="source-note">用户未上传申请凭证</p>
    <div v-else class="application-images">
      <div v-for="(image, index) in images" :key="image.src">
        <p v-if="failed.has(image.src)" role="alert" class="source-note">申请凭证 {{ index + 1 }} 读取失败，请刷新详情</p>
        <a v-else :href="image.src" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" :aria-label="`查看申请凭证 ${index + 1}`">
          <img :src="image.src" :alt="`用户申请凭证 ${index + 1}`" referrerpolicy="no-referrer" @error="failed.add(image.src)" />
        </a>
        <span v-if="image.url.startsWith('https://')" class="source-note">历史图片链接</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.application-evidence { margin:20px 0; padding-top:12px; border-top:1px solid var(--border-soft); min-width:0; }
.source-note { color:var(--text-secondary); font-size:13px; line-height:1.7; overflow-wrap:anywhere; }
.application-images { display:flex; flex-wrap:wrap; gap:12px; }
.application-images > div { width:140px; max-width:100%; min-width:0; }
a { display:block; } img { display:block; width:100%; height:140px; object-fit:contain; border:1px solid var(--border-soft); border-radius:8px; }
</style>
