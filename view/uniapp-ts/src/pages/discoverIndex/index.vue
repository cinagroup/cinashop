<template>
  <ThemePage>
    <view class="community-legacy-main" role="status">{{ error || '正在打开社区…' }}</view>
    <button v-if="error && target" @tap="open">重新打开社区</button>
  </ThemePage>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import ThemePage from '@/components/ThemePage.vue';
import { communityPageQuery } from '@/utils/communityShare';
const error = ref(''), target = ref('');
let disposed = false, generation = 0;
function open() {
  if (disposed || !target.value) return;
  const revision = ++generation;
  uni.switchTab({ url: target.value, fail: () => {
    if (!disposed && revision === generation) error.value = '社区页面暂时无法打开，请重试';
  } });
}
onLoad(input => {
  try {
    const query = communityPageQuery(input ?? {});
    // The PHP main page has no tab/query protocol. Credentials are discarded.
    if (Object.keys(query).some(key => !['token', 'uid', 'spid'].includes(key))) throw Error('社区主地址参数无效');
    target.value = '/pages/discover/index'; open();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '社区地址无效'; }
});
onUnload(() => { disposed = true; generation++; });
</script>
