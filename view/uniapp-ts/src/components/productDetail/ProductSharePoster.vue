<template>
  <IntegralSharePoster :url="url" :title="title" :image="image" :price="price" :integral="0" :quote-text="`${priceLabel ? priceLabel+' · ' : ''}¥${price}`" :site-name="siteName" :tagline="tagline" :qr-image="qrImage" canvas-id="ordinary-share-poster" :note="`${qrImage ? qrImage.startsWith('data:') ? '微信正式小程序码打开当前商品。' : '公众号关注码关联当前商品与推荐人。' : '二维码打开商品网页，不代表微信小程序码。'}此为所选规格参考报价，库存、优惠和最终金额以结算复核为准。`" />
</template>
<script setup lang="ts">
import IntegralSharePoster from '@/components/IntegralSharePoster.vue';
defineProps<{url:string;title:string;image:string;price:string;priceLabel:string;siteName:string;tagline:string;qrImage?:string}>();
</script>
