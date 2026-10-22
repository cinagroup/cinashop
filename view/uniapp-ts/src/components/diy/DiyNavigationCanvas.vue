<template>
  <view v-if="admitted() && hasContent" class="navigation-canvas" :style="config.wrapperStyle" :data-layout="config.style">
    <view v-if="config.kind==='menus'" class="navigation-menu-panel" :style="config.panelStyle">
      <swiper v-if="config.paged" class="navigation-menu-swiper" :current="current" :style="{height:menuHeight}" :duration="500" @change="changed"><swiper-item v-for="(page,index) in config.pages" :key="index"><view class="navigation-menu-page" :data-page="index" :style="{gridTemplateColumns:`repeat(${config.columns},minmax(0,1fr))`}"><view v-for="item in page" v-show="item.visible" :key="item.index" class="navigation-menu-item" :data-item-index="item.index" @tap="tap(item)"><view v-if="config.menuStyle!==2" class="navigation-menu-picture"><image v-if="item.image && !errors[item.index]" :src="item.image" :style="config.imageStyle" mode="aspectFill" @load="loaded(item,$event)" @error="failed(item)" /><text v-else class="navigation-image-fallback">暂无图片</text></view><text v-if="config.menuStyle!==1" class="navigation-menu-label" :class="{spaced:config.menuStyle===0}">{{item.label}}</text></view></view></swiper-item></swiper>
      <view v-else class="navigation-menu-page" :style="{gridTemplateColumns:`repeat(${config.columns},minmax(0,1fr))`}"><view v-for="item in config.items" v-show="item.visible" :key="item.index" class="navigation-menu-item" :data-item-index="item.index" @tap="tap(item)"><view v-if="config.menuStyle!==2" class="navigation-menu-picture"><image v-if="item.image && !errors[item.index]" :src="item.image" :style="config.imageStyle" mode="aspectFill" @load="loaded(item,$event)" @error="failed(item)" /><text v-else class="navigation-image-fallback">暂无图片</text></view><text v-if="config.menuStyle!==1" class="navigation-menu-label" :class="{spaced:config.menuStyle===0}">{{item.label}}</text></view></view>
      <view v-if="config.paged && config.pages.length>1" class="navigation-menu-dots"><view v-for="(_,index) in config.pages" :key="index" class="navigation-menu-dot" :data-page-index="index" :style="{background:index===current?config.pointerColor:config.pointerBackground}" @tap="choosePage(index)" /></view>
    </view>
    <view v-else class="navigation-cube-panel" :style="cubePanelStyle">
      <view v-for="cell in cells" :key="cell.item.index" class="navigation-cube-cell" :data-item-index="cell.item.index" :style="{...cell.style,borderWidth:config.imageGap}" @tap="tap(cell.item)"><view class="navigation-cube-picture" :style="{...config.imageStyle,height:cell.imageHeight}"><image v-if="cell.item.image && !errors[cell.item.index]" :src="cell.item.image" :style="config.imageStyle" mode="aspectFill" @load="loaded(cell.item,$event)" @error="failed(cell.item)" /><text v-else class="navigation-image-fallback">暂无图片</text></view></view>
    </view>
    <button v-if="Object.keys(errors).length" class="navigation-media-retry" size="mini" @tap="retry">重试图片</button>
  </view>
</template>
<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { diyCubeRectangles, type DiyNavigationConfig, type DiyNavigationItem } from '@/utils/diyNavigationConfig';
const props=withDefaults(defineProps<{config:DiyNavigationConfig;allowed:()=>boolean;initialPage?:number}>(),{initialPage:0});
const emit=defineEmits<{open:[index:number];page:[index:number];retry:[]}>();
const config=props.config,lease=props.allowed,instance=getCurrentInstance();let alive=true,windowWidth=375;
try{const width=uni.getSystemInfoSync().windowWidth;if(Number.isFinite(width)&&width>0)windowWidth=width;}catch{}
const admitted=()=>alive&&lease(),current=ref(Number.isInteger(props.initialPage)&&props.initialPage>=0&&props.initialPage<config.pages.length?props.initialPage:0),errors=ref<Record<number,boolean>>({}),ready=ref<Record<number,boolean>>({}),ratio=ref(1),measuredHeight=ref(0);
const hasContent=computed(()=>config.kind==='menus'?config.items.some(item=>item.visible):config.hasCube);
const minimumMenuHeight=40+config.rows*(config.menuStyle===0?132:config.menuStyle===1?90:28)+(config.rows-1)*24;
const menuHeight=computed(()=>measuredHeight.value?`${measuredHeight.value}px`:`${minimumMenuHeight}rpx`);
function adoptMenuMeasurements(raw:unknown){if(!admitted()||!Array.isArray(raw))return;const heights=raw.map(rect=>(rect as {height?:unknown}|null)?.height).filter((height):height is number=>typeof height==='number'&&Number.isFinite(height)&&height>0&&height<10000);if(heights.length)measuredHeight.value=Math.max(minimumMenuHeight*windowWidth/750,...heights);}
function measure(){void nextTick(()=>{if(!admitted()||!instance?.proxy||typeof uni.createSelectorQuery!=='function'||!config.paged)return;uni.createSelectorQuery().in(instance.proxy).selectAll('.navigation-menu-page').boundingClientRect(adoptMenuMeasurements).exec();});}
function loaded(item:DiyNavigationItem,event:unknown){if(!admitted()||!config.items.includes(item))return;const detail=(event as {detail?:{width?:unknown;height?:unknown}})?.detail,width=typeof detail?.width==='number'?detail.width:NaN,height=typeof detail?.height==='number'?detail.height:NaN,naturalRatio=height/width;if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Number.isFinite(naturalRatio)||naturalRatio<=0||!Number.isFinite(windowWidth*naturalRatio)||!Number.isFinite(375*naturalRatio)){failed(item);return;}ready.value[item.index]=true;delete errors.value[item.index];if(item===config.items[0])ratio.value=naturalRatio;measure();}
function failed(item:DiyNavigationItem){if(admitted()&&config.items.includes(item)){errors.value[item.index]=true;delete ready.value[item.index];measure();}}
function tap(item:DiyNavigationItem){if(admitted()&&config.items.includes(item)&&item.visible&&item.link&&(config.kind==='menus'||ready.value[item.index]))emit('open',item.index);}
function choosePage(index:number){if(admitted()&&Number.isInteger(index)&&index>=0&&index<config.pages.length){current.value=index;emit('page',index);}}
function changed(event:unknown){choosePage(Number((event as {detail?:{current?:unknown}})?.detail?.current));}
function retry(){if(admitted())emit('retry');}
const cubePanelStyle=computed(()=>({position:'relative' as const,overflow:'hidden',...(config.style===1||config.style===2?{display:'flex'}:{}),...(config.style>=3&&config.style<=9||config.style===11?{height:`${windowWidth}px`}:{})}));
const cells=computed(()=>{
  const style=config.style,rects=diyCubeRectangles(style,config.items.length),items=style===10?config.items.slice(0,1):rects.length?config.items.slice(0,rects.length):config.items;
  return items.map(item=>{
    let cellStyle:Record<string,string>={},imageHeight='100%';
    if(style===11&&item.rectangle){const r=item.rectangle;cellStyle={position:'absolute',left:`${r.x*2}rpx`,top:`${r.y*2}rpx`,width:`${r.width*2}rpx`,height:`${r.height*2}rpx`};}
    else if(rects.length){const r=rects[item.index];if(r)cellStyle={position:'absolute',left:`${r[0]!*100}%`,top:`${r[1]!*100}%`,width:`${r[2]!*100}%`,height:`${r[3]!*100}%`};}
    else if(style===1||style===2){cellStyle={width:`${100/config.items.length}%`};imageHeight=`${(style===1?375:Math.max(0,250-config.horizontalPadding))*(errors.value[config.items[0]?.index??0]?2:ratio.value)}rpx`;}
    else {cellStyle={width:'100%'};imageHeight=`${style===0?windowWidth/2:windowWidth*ratio.value}px`;}
    // PHP's natural layouts have an explicitly sized easy-loadimage inside an
    // auto-height border box. Let CSS add the real, pixel-rounded borders;
    // fixed mosaics/custom rectangles keep their explicit outer dimensions.
    return {item,style:cellStyle,imageHeight};
  });
});
onMounted(measure);onScopeDispose(()=>{alive=false;});
</script>
<style scoped>
.navigation-canvas{width:100%;min-width:0;box-sizing:border-box;}.navigation-menu-panel{overflow:hidden;}.navigation-menu-page{display:grid;grid-row-gap:24rpx;width:100%;padding:20rpx 0;box-sizing:border-box;}.navigation-menu-item{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;font-size:24rpx;color:#333;}.navigation-menu-picture{width:90rpx;height:90rpx;position:relative;overflow:hidden;}.navigation-menu-picture image{display:block;width:100%;height:100%;}.navigation-menu-label{display:block;max-width:100%;line-height:28rpx;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.navigation-menu-label.spaced{margin-top:14rpx;}.navigation-menu-swiper{width:100%;display:block;overflow:hidden;}.navigation-menu-dots{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;padding-bottom:20rpx;}.navigation-menu-dot{width:20rpx;height:6rpx;border-radius:3rpx;margin:0 4px;}.navigation-cube-panel{min-width:0;width:100%;}.navigation-cube-cell{box-sizing:border-box;border-style:solid;border-color:transparent;overflow:hidden;position:relative;min-width:0;}.navigation-cube-picture{position:relative;overflow:hidden;width:100%;}.navigation-cube-cell image{display:block;width:100%;height:100%;}.navigation-image-fallback{display:flex;align-items:center;justify-content:center;position:absolute;inset:0;background:#f5f5f5;font-size:20rpx;color:#999;}.navigation-media-retry{margin:12rpx auto;display:block;}
</style>
