<template>
 <view class="message-preview"><template v-for="(part,index) in segments" :key="index">
  <text v-if="part.kind==='text'">{{ part.text }}</text>
  <view v-else class="message-emoji" :data-message-emoji="part.name" :style="{backgroundPosition:part.position}" role="img" :aria-label="part.marker">
   <!-- #ifdef MP-WEIXIN -->
   <image class="message-emoji-sheet" src="/static/php-messages/sheet_apple_64_indexed_256colors.png" mode="scaleToFill" :style="messageEmojiSheetStyle(part.position)"/>
   <!-- #endif -->
  </view>
 </template></view>
</template>
<script setup lang="ts">
import {computed} from 'vue';
import {messagePreviewSegments,messageEmojiSheetStyle} from '@/utils/messageEmoji';
const props=defineProps<{value:string}>();
const segments=computed(()=>messagePreviewSegments(props.value));
</script>
<style scoped>
.message-preview{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.message-emoji{display:inline-block;position:relative;height:22px;width:22px;overflow:hidden;line-height:18px;font-size:22px;vertical-align:middle;margin-top:-4px}
/* #ifndef MP-WEIXIN */
.message-emoji{background-image:url('/static/php-messages/sheet_apple_64_indexed_256colors.png');background-size:4100%}
/* #endif */
.message-emoji-sheet{position:absolute;width:902px;height:902px;max-width:none}
</style>
