<template>
  <view v-if="display && reserve" class="diy-footer-reservation" :style="{height:`${height}px`}" />
  <view v-if="display" class="diy-page-foot" :class="{'diy-footer-floating':config?.floating}" :style="[outerStyle,{visibility:nativeConfirmed?'visible':'hidden'}]">
    <view class="diy-footer-menu" :style="menuStyle">
      <view v-for="slot in slots" :key="slot.key" class="diy-foot-item" :class="[`diy-footer-style-${config?.style}`,{selected:selected(slot.item.route)}]" role="button" :aria-label="slot.item.name" :aria-disabled="!usable" @tap="slot.tap">
        <view v-if="config?.style!==1" class="diy-foot-icon">
          <image v-if="usable && slot.src && !failedImages.includes(slot.index)" :src="slot.src" class="diy-foot-image" mode="aspectFit" @load="slot.loaded" @error="slot.failed" />
        </view>
        <text v-if="config?.style!==2" class="diy-foot-text" :style="{color: selected(slot.item.route) ? activeColor : textColor}">{{slot.item.name}}</text>
        <text v-if="slot.item.link==='/pages/order_addcart/order_addcart' && badge>0" class="diy-foot-badge">{{badge>99?'99+':badge}}</text>
      </view>
    </view>
  </view>
  <view v-if="active && !modal && (configError || nativeError)" class="diy-footer-error" role="alert"><text>{{configError || nativeError}}</text><button v-if="nativeError" size="mini" @tap="native.retry">重新调整导航</button></view>
</template>
<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { normalizeDiyFooter, type DiyFooterConfig } from '@/utils/diyFooterConfig';
import { diyAuthoredPageFingerprint, diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import { useNativeFooterStore } from '@/stores/nativeFooter';
import { useDiyFooterStore } from '@/stores/diyFooter';
import { useAuthStore } from '@/stores/auth';
import { useDiyFooterBadge } from '@/composables/useDiyFooterBadge';
import { diyStationClosure } from '@/utils/diy';
import { TAB_ROUTES } from '@/config/navigation';

const props=withDefaults(defineProps<{block:unknown;active:boolean;ready?:boolean;modal?:boolean;tab?:boolean;reserve?:boolean}>(),{ready:true,modal:false,tab:false,reserve:true});
const emit=defineEmits<{height:[value:number]}>();
const instance=getCurrentInstance(), id=`diy-footer-${instance?.uid ?? Math.random()}`, native=useNativeFooterStore(), app=useDiyFooterStore(), auth=useAuthStore();
const height=ref(0), configError=ref(''), failedImages=ref<number[]>([]), route=ref(''), fullPath=ref(''), lease=ref(0), clock=ref(Date.now());
let epoch=0, disposed=false, timer:ReturnType<typeof setTimeout>|undefined;
const config=shallowRef<DiyFooterConfig|null>(null);
const visible=computed(()=>props.active && app.active && !diyStationClosure.value && !disposed);
const display=computed(()=>visible.value && native.owner===id && !!config.value?.custom && !props.modal);
const nativeError=computed(()=>native.owner===id?native.error:'');
const nativeConfirmed=computed(()=>native.hidden===true && !native.pending && !nativeError.value);
const usable=computed(()=>display.value && nativeConfirmed.value && props.ready && !configError.value && lease.value>clock.value);
const badge=useDiyFooterBadge(()=>usable.value && !!config.value?.items.some(item=>item.link==='/pages/order_addcart/order_addcart'));

const activeColor=computed(()=>config.value?.themed?'var(--view-theme,#e93323)':config.value?.activeColor);
const textColor=computed(()=>config.value?.themed?'#333333':config.value?.color);
const outerStyle=computed(()=>({background:config.value?.floating?'transparent':config.value?.background,paddingBottom:`calc(env(safe-area-inset-bottom,0px) + ${config.value?.bottom ?? 0}rpx)`}));
const menuStyle=computed(()=>({marginLeft:`${config.value?.side ?? 0}rpx`,marginRight:`${config.value?.side ?? 0}rpx`,paddingTop:`${config.value?.topPadding ?? 0}rpx`,paddingBottom:`${config.value?.bottomPadding ?? 0}rpx`,borderRadius:config.value?.floating?config.value.radius:'0',background:config.value?.background}));
function selected(target:string|null){return !!target && target.split('?')[0]===route.value;}
const slots=computed(()=>{
  // Every DOM callback captures its issuing owner, configuration and lease.
  const revision=epoch,block=props.block,actor=`${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const allowed=visible.value && props.ready && !props.modal,expiry=lease.value;
  return (config.value?.items ?? []).map((item,index)=>{
    const src=selected(item.route)?item.selectedImage:item.image;
    const current=()=>allowed&&!disposed&&revision===epoch&&block===props.block&&actor===`${auth.uid}:${auth.token}:${auth.sessionVersion}`&&expiry===lease.value&&usable.value&&Date.now()<expiry;
    return {item,index,src,key:`${index}:${revision}:${src}`,failed:()=>{if(current()&&!failedImages.value.includes(index))failedImages.value=[...failedImages.value,index];},loaded:()=>{if(current())measure();},tap:()=>{if(current())navigate(item.route,item.link);}};
  });
});
function readRoute(){try{const page=getCurrentPages().slice(-1)[0] as unknown as {route?:string;$page?:{fullPath?:string}};route.value=`/${page?.route ?? ''}`;fullPath.value=page?.$page?.fullPath ?? route.value;}catch{route.value='';fullPath.value='';}}
function measure(){const revision=epoch;void nextTick(()=>{if(!display.value||disposed||revision!==epoch||typeof uni.createSelectorQuery!=='function')return;const query=uni.createSelectorQuery();if(instance?.proxy)query.in(instance.proxy);query.select('.diy-page-foot').boundingClientRect(result=>{if(disposed||revision!==epoch||!display.value||Array.isArray(result))return;const value=result?.height;if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<10000){height.value=value;emit('height',value);}}).exec();});}
function navigate(target:string|null,authored:string){
  if(!usable.value||disposed||Date.now()>=lease.value)return;
  if(!target){uni.showToast({title:'该导航入口暂不可用',icon:'none'});return;}
  if(target===fullPath.value||authored===fullPath.value)return;
  const revision=epoch,actor=`${auth.uid}:${auth.token}:${auth.sessionVersion}`,current=()=>!disposed&&revision===epoch&&usable.value&&actor===`${auth.uid}:${auth.token}:${auth.sessionVersion}`&&Date.now()<lease.value;
  const fail=()=>{if(current())uni.showToast({title:'页面暂时无法打开',icon:'none'});};
  const path=target.split('?')[0]!;
  if(TAB_ROUTES.has(path))uni.switchTab({url:path,fail});else uni.redirectTo({url:target,fail});
}
watch(()=>diyAuthoredPageFingerprint([props.block]),()=>{epoch++;failedImages.value=[];},{flush:'sync'});
watch(()=>props.block,()=>{epoch++;failedImages.value=[];configError.value='';if(timer!==undefined)clearTimeout(timer);clock.value=Date.now();lease.value=props.block?diyEditorialMediaDeadline({value:[props.block]},clock.value):0;try{config.value=props.block?normalizeDiyFooter(props.block):null;}catch(reason){config.value=null;configError.value=reason instanceof Error?reason.message:'底部导航配置无效';}if(Number.isFinite(lease.value)&&lease.value>clock.value)timer=setTimeout(()=>{clock.value=Date.now();},lease.value-clock.value);},{immediate:true,deep:true,flush:'sync'});
watch([visible,()=>props.ready,()=>props.modal,()=>props.tab,config,()=>auth.uid,()=>auth.token,()=>auth.sessionVersion],()=>{epoch++;failedImages.value=[];if(visible.value)readRoute();native.claim(id,{active:visible.value,custom:!!config.value?.custom,modal:props.modal,tab:props.tab,actor:`${auth.uid}:${auth.token}:${auth.sessionVersion}`});if(display.value)measure();else{height.value=0;emit('height',0);}},{immediate:true,flush:'sync'});
watch(display,shown=>{if(shown)measure();else{height.value=0;emit('height',0);}},{flush:'sync'});
onScopeDispose(()=>{disposed=true;epoch++;if(timer!==undefined)clearTimeout(timer);native.release(id);emit('height',0);});
</script>
<style scoped>
.diy-page-foot{position:fixed;left:0;right:0;bottom:0;z-index:3000;box-sizing:border-box;}.diy-footer-menu{display:flex;align-items:center;overflow:hidden;box-sizing:border-box;}.diy-foot-item{flex:1;min-width:0;height:96rpx;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;}.diy-foot-icon,.diy-foot-image{width:40rpx;height:40rpx;flex-shrink:0;}.diy-foot-text{font-size:20rpx;line-height:28rpx;margin-top:4rpx;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}.diy-footer-style-1 .diy-foot-text{font-size:32rpx;line-height:44rpx;margin-top:0;}.diy-foot-badge{position:absolute;top:4rpx;left:55%;background:#e93323;color:#fff;border-radius:30rpx;font-size:20rpx;line-height:28rpx;min-width:28rpx;text-align:center;padding:0 5rpx;}.diy-footer-error{position:fixed;left:12rpx;right:12rpx;bottom:110rpx;z-index:3001;background:#fff4df;color:#775311;padding:12rpx;font-size:24rpx;}.diy-footer-error button{display:inline-block;margin-left:16rpx;}
</style>
