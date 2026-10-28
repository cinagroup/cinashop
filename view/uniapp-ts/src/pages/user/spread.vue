<template>
 <ThemePage><view class="spread-page" :data-spread-owner="ownerUid" :data-selected-template="selected">
  <view v-if="loading" role="status" class="message">正在读取本人推广资料与二维码…</view>
  <view v-if="error" class="error" role="alert">{{error}}</view>
  <button v-if="!auth.isLoggedIn" class="read" @tap="login">登录后生成海报</button>
  <template v-if="data&&code">
   <swiper class="poster-swiper" :current="selected" :indicator-dots="false" :autoplay="false" :circular="false" :duration="500" previous-margin="40px" next-margin="40px" @change="slide">
    <swiper-item v-for="(item,index) in data.spread" :key="ownerVersion+':'+index">
     <view class="poster-slide" :data-poster-index="index" :data-poster-selected="selected===index" :class="selected===index?'active':'quiet'">
      <SpreadPoster :canvas-id="'spread-poster-'+index" :selected="selected===index" :owner-uid="ownerUid" :owner-version="ownerVersion" :template="item.pic" :avatar="data.avatar" :nickname="data.nickname" :site-name="data.site_name" :code="code" :active="visible" :share-path="sharePath" @generated="image=>generated(index,image)" />
     </view>
    </swiper-item>
   </swiper>
   <view class="position" aria-live="polite">{{selected+1}} / {{data.spread.length}}</view>
   <view class="selection"><button :disabled="selected===0" aria-label="上一张海报" @tap="choose(selected-1)">上一张</button><button :disabled="selected===data.spread.length-1" aria-label="下一张海报" @tap="choose(selected+1)">下一张</button></view>
  </template>
  <button v-if="auth.isLoggedIn" class="read" :disabled="loading" @tap="load">{{data?'重新读取推广资料':'生成推广海报'}}</button>
  <button class="finance" @tap="goFinance">查看分销记录与佣金</button>
  <DiySuspendedNavigation/>
 </view></ThemePage>
</template>
<script setup lang="ts">
import {ref,watch} from 'vue';
import {onShareAppMessage} from '@dcloudio/uni-app';
import ThemePage from '@/components/ThemePage.vue';
import SpreadPoster from '@/components/SpreadPoster.vue';
import { useSpreadPoster } from '@/composables/useSpreadPoster';
const {auth,data,selected,code,loading,error,visible,ownerUid,ownerVersion,load,choose,current,sharePath}=useSpreadPoster();
const generatedImage=ref('');
watch(()=>[data.value,selected.value,code.value],()=>{generatedImage.value='';},{flush:'sync'});
function generated(index:number,image:string){if(current()&&index===selected.value)generatedImage.value=image;}
function slide(event:{detail:{current:number}}){choose(event.detail.current);}
// #ifdef MP-WEIXIN
onShareAppMessage(()=>current()&&generatedImage.value&&sharePath.value?{title:(data.value?.nickname||'')+'-分销海报',imageUrl:generatedImage.value,path:sharePath.value}:{title:'商城',path:'/pages/index/index'});
// #endif
function login(){uni.navigateTo({url:'/pages/auth/login'});}function goFinance(){uni.navigateTo({url:'/pages/user/finance'});}
</script>
<style scoped>
.spread-page{max-width:430px;margin:0 auto;padding:40rpx 0 120rpx;background:#f5f5f5;min-height:100vh;box-sizing:border-box}.poster-swiper{width:100%;height:1300rpx;max-height:740px}.poster-slide{width:100%;height:100%;transition:transform .2s ease-in;transform-origin:center top}.poster-slide.quiet{transform:scale(.89)}.poster-slide.active{transform:none}.message,.error{margin:0 40rpx;padding:24rpx 0;font-size:26rpx}.error{color:#a72823}.position{text-align:center;color:#666;font-size:24rpx;margin:12rpx 0}.selection{display:flex;justify-content:center;gap:40rpx}.selection button{margin:0;font-size:24rpx;background:transparent;color:#666}.selection button:after{border:0}.read,.finance{margin:24rpx 40rpx 0;font-size:26rpx}.read{color:var(--view-theme,#e93323);background:#fff}.finance{color:#666;background:transparent}.finance:after{border:0}
@media (min-width:431px){.poster-swiper{height:760px;max-height:none}}
</style>
