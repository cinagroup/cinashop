<template>
  <div class="extract-workspace">
    <nav class="workspace-tabs" role="tablist" aria-label="提现管理">
      <button id="extract-directory-tab" type="button" role="tab" :aria-selected="directoryVisible" aria-controls="extract-directory-panel"
        :class="{ active: directoryVisible }" @click="directorySwitch">提现申请</button>
      <button v-if="canManage" id="extract-review-tab" type="button" role="tab" :aria-selected="!directoryVisible" aria-controls="extract-review-panel"
        :class="{ active: !directoryVisible }" @click="reviewSwitch">提现审核</button>
    </nav>
    <section v-if="directoryVisible" id="extract-directory-panel" role="tabpanel" aria-labelledby="extract-directory-tab">
      <AdminExtractList :key="'directory:'+identityGeneration" />
    </section>
    <section v-else id="extract-review-panel" role="tabpanel" aria-labelledby="extract-review-tab">
      <ExtractReview :key="'review:'+identityGeneration" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AdminExtractList from './AdminExtractList.vue';
import ExtractReview from './ExtractReview.vue';
import { useExtractDirectoryOwner } from '@/composables/useExtractDirectoryOwner';
const owner = useExtractDirectoryOwner(), active = ref<'directory'|'review'>('directory');
const identityGeneration = ref(0), canManage = owner.canManage;
const directoryVisible = computed(() => active.value === 'directory' || !canManage.value);
let mounted = false;
// Each rendered button captures this identity; a retained old click cannot
// switch a replacement account into a different workspace.
const directorySwitch = computed(() => {
  const identity = owner.identity.value;
  return () => { if (mounted && owner.current(identity)) active.value = 'directory'; };
});
const reviewSwitch = computed(() => {
  const identity = owner.identity.value;
  return () => { if (mounted && owner.current(identity) && owner.has('extract.manage')) active.value = 'review'; };
});
watch(owner.identity, () => {
  if (!mounted) return;
  active.value = 'directory'; identityGeneration.value++;
},{flush:'sync'});
onMounted(() => { mounted = true; });
onBeforeUnmount(() => { mounted = false; });
</script>

<style scoped>
.workspace-tabs{display:flex;gap:28px;margin:-4px 0 22px;padding:0 22px;background:#fff;border-bottom:1px solid #ebeef5;border-radius:6px 6px 0 0}.workspace-tabs button{position:relative;padding:19px 0 16px;border:0;background:none;color:#606266;font:inherit;font-size:14px;cursor:pointer}.workspace-tabs button.active{color:#1890ff;font-weight:500}.workspace-tabs button.active:after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:#1890ff}.workspace-tabs button:focus-visible{outline:2px solid #1890ff;outline-offset:4px}
</style>
