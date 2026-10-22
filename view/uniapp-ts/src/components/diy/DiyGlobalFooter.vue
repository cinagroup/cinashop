<template>
  <DiyPageFooter :block="footer.block" :active="active && !blocked && !footer.closed" :ready="!footer.loading && !footer.error" :modal="modal" tab :reserve="reserve" @height="emit('height',$event)" />
  <view v-if="active && !blocked && footer.error" class="diy-global-footer-error" role="alert"><text>{{footer.error}}</text><button size="mini" @tap="footer.refresh">重新读取导航</button></view>
</template>
<script setup lang="ts">
import DiyPageFooter from './DiyPageFooter.vue';
import { useDiyFooterStore } from '@/stores/diyFooter';
withDefaults(defineProps<{active:boolean;blocked?:boolean;modal?:boolean;reserve?:boolean}>(),{blocked:false,modal:false,reserve:true});
const emit=defineEmits<{height:[value:number]}>(),footer=useDiyFooterStore();
</script>
<style scoped>
.diy-global-footer-error{padding:12rpx 24rpx;background:#fff4df;color:#775311;font-size:24rpx;}.diy-global-footer-error button{display:inline-block;margin-left:12rpx;}
</style>
