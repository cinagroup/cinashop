<template>
  <section class="preview-shell" aria-label="导航组件实际字段预览">
    <p class="hint">375 设计宽度预览；链接不在编辑器中执行。发布后采用站点主题色。</p>
    <div class="navigation-preview" :style="p.wrapperStyle" :data-kind="p.kind" :data-layout="p.style">
      <div v-if="p.kind==='headerSerch'" class="search-header" :style="p.panelStyle">
        <div v-if="p.style===0" class="logo"><img v-if="p.logo" :src="p.logo" alt="搜索框 logo" /><span v-else>LOGO</span></div>
        <strong v-if="p.style===1" class="title">{{p.title}}</strong>
        <div class="search" :class="{center:p.style===2 && p.searchVariant===0}" :style="p.searchStyle"><span>⌕</span><span v-if="p.hotWords.length" :style="p.hotStyle">{{p.hotWords[word % p.hotWords.length]}}</span><span v-else>{{p.placeholder}}</span><span v-if="p.style===2 && p.searchVariant" class="search-action" :style="p.searchVariant===1?p.searchButtonStyle:p.searchTextStyle">搜索</span></div>
      </div>
      <div v-else-if="p.kind==='tabNav'" class="tabs" :style="p.panelStyle" :data-sticky="p.sticky">
        <button v-for="tab in [{index:0,label:'首页',valid:true},...p.tabs]" :key="tab.index" type="button" :aria-pressed="tabIndex===tab.index" :style="tabIndex===tab.index?p.selectedStyle:{}" @click="tabIndex=tab.index">{{tab.label||'未命名'}}<span v-if="!tab.valid" class="invalid">未选目标</span><i v-if="tabIndex===tab.index && p.style!==2" :style="p.decorationStyle" :class="{circle:p.style===1}" /></button>
      </div>
      <div v-else-if="p.kind==='menus'" class="menu-panel" :style="p.panelStyle">
        <div class="menu-grid" :style="{gridTemplateColumns:`repeat(${p.columns},minmax(0,1fr))`}" :data-preview-page="page">
          <div v-for="item in p.paged?p.pages[page]??[]:p.items" :key="item.index" v-show="item.visible" class="menu-item" :data-preview-slot="item.index">
            <div v-if="p.menuStyle!==2" class="menu-image" :style="p.imageStyle"><img v-if="item.image" :src="item.image" alt="菜单图片" :style="p.imageStyle" /><span v-else>暂无图片</span></div><span v-if="p.menuStyle!==1">{{item.label}}</span>
          </div>
        </div>
        <div v-if="p.paged && p.pages.length>1" class="dots"><button v-for="(_,i) in p.pages" :key="i" type="button" :aria-label="`预览菜单第 ${i+1} 页`" :aria-pressed="page===i" :style="{background:page===i?p.pointerColor:p.pointerBackground}" @click="page=i" /></div>
      </div>
      <div v-else-if="p.kind==='pictureCube' && p.hasCube" class="cube-panel" :style="cubePanelStyle">
        <div v-for="cell in cells" :key="`${cell.item.index}:${cell.item.image}`" class="cube-cell" :style="{...cell.style,borderWidth:`${p.gap}px`}" :data-preview-slot="cell.item.index">
          <div class="cube-picture" :style="{...p.imageStyle,height:cell.height}"><img v-if="cell.item.image && !errors[cell.item.index]" :src="cell.item.image" alt="魔方图片" :style="p.imageStyle" @load="loaded(cell.item.index,cell.item.image,$event)" @error="failed(cell.item.index,cell.item.image)" /><span v-else>暂无图片</span></div>
        </div>
      </div>
      <p v-else class="hint">当前没有可显示的图片槽位。</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { navigationPreview, navigationCubeRects, type NavigationRecord } from '@/utils/diyNavigationEditor';
const props=defineProps<{block:NavigationRecord;previews:Record<string,string>;allowed:()=>boolean}>();
const p=computed(()=>navigationPreview(props.block,props.previews)),page=ref(0),tabIndex=ref(0),word=ref(0),ratio=ref(1),errors=ref<Record<number,boolean>>({});
let timer:ReturnType<typeof setInterval>|null=null,alive=true;const admitted=()=>alive&&props.allowed();
watch(()=>props.block,()=>{page.value=tabIndex.value=word.value=0;ratio.value=1;errors.value={};if(timer)clearInterval(timer);timer=p.value.kind==='headerSerch'&&p.value.hotWords.length>1?setInterval(()=>{if(admitted())word.value++;},3000):null;},{immediate:true});
onBeforeUnmount(()=>{alive=false;if(timer)clearInterval(timer);});
function loaded(index:number,source:string,event:Event){if(!admitted()||p.value.items.find(item=>item.index===index)?.image!==source)return;const img=event.target as HTMLImageElement;if(img.getAttribute('src')!==source||img.currentSrc&&new URL(img.currentSrc,img.baseURI).href!==new URL(source,img.baseURI).href)return;if(img.naturalWidth>0&&img.naturalHeight>0&&Number.isFinite(img.naturalHeight/img.naturalWidth)&&index===p.value.items[0]?.index)ratio.value=img.naturalHeight/img.naturalWidth;}
function failed(index:number,source:string){if(admitted()&&p.value.items.find(item=>item.index===index)?.image===source)errors.value[index]=true;}
const cubePanelStyle=computed(()=>({...(p.value.style===1||p.value.style===2?{display:'flex'}:{}),...(p.value.style>=3&&p.value.style<=9||p.value.style===11?{height:'375px'}:{})}));
const cells=computed(()=>{const q=p.value,rects=navigationCubeRects(q.style,q.items.length),items=q.style===10?q.items.slice(0,1):rects.length?q.items.slice(0,rects.length):q.items;return items.map(item=>{let style:Record<string,string>={},height='100%';if(q.style===11&&item.rectangle){const r=item.rectangle;style={position:'absolute',left:`${r.startX}px`,top:`${r.startY}px`,width:`${r.w}px`,height:`${r.h}px`};}else if(rects.length){const r=rects[item.index];if(r)style={position:'absolute',left:`${r[0]!*100}%`,top:`${r[1]!*100}%`,width:`${r[2]!*100}%`,height:`${r[3]!*100}%`};}else if(q.style===1||q.style===2){style={width:`${100/q.items.length}%`};height=`${(q.style===1?375:Math.max(0,250-q.horizontalPadding))*(errors.value[q.items[0]?.index??0]?2:ratio.value)/2}px`;}else{style={width:'100%'};height=`${q.style===0?187.5:375*ratio.value}px`;}return{item,style,height};});});
</script>
<style scoped>
.preview-shell{width:100%;overflow:auto}.hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}.navigation-preview{width:375px;max-width:100%;min-height:40px;background:#f5f5f5}.search-header{display:flex;align-items:center;gap:12px;padding:12px 10px;box-sizing:border-box}.logo{width:72px;height:22px;display:grid;place-items:center;flex-shrink:0;font-size:12px}.logo img{max-width:100%;max-height:100%}.title{max-width:100px;overflow:hidden;white-space:nowrap}.search{display:flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:20px;min-width:0;flex:1;font-size:12px}.search.center{justify-content:center}.search-action{margin-left:auto;border-radius:20px;padding:3px 10px}.tabs{display:flex;overflow:auto;gap:8px;padding:6px 10px}.tabs button{position:relative;flex-shrink:0;border:0;background:transparent;padding:7px 12px;border-radius:20px;cursor:pointer;font:inherit}.tabs i{position:absolute;bottom:0;left:30%;right:30%;height:3px;border-radius:2px}.tabs i.circle{left:50%;right:auto;bottom:4px;width:32px;height:32px;border:2px solid transparent;border-radius:50%;background:transparent;box-sizing:border-box;transform:translateX(-50%)}.invalid{display:block;font-size:9px;color:#999}.menu-panel{overflow:hidden}.menu-grid{display:grid;row-gap:12px;padding:10px 0}.menu-item{min-width:0;display:flex;flex-direction:column;align-items:center;gap:7px;font-size:12px;color:#333}.menu-item>span{max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.menu-image{width:45px;height:45px;overflow:hidden;display:grid;place-items:center;background:#f5f5f5;font-size:10px;color:#999}.menu-image img{width:100%;height:100%;object-fit:cover}.dots{display:flex;justify-content:center;flex-wrap:wrap;gap:4px;padding-bottom:10px}.dots button{width:10px;height:3px;padding:0;border:0;border-radius:2px;cursor:pointer}.cube-panel{position:relative;width:100%;overflow:hidden}.cube-cell{position:relative;border-style:solid;border-color:transparent;box-sizing:border-box;overflow:hidden;min-width:0}.cube-picture{position:relative;width:100%;overflow:hidden}.cube-picture img{display:block;width:100%;height:100%;object-fit:cover}.cube-picture>span{display:grid;place-items:center;position:absolute;inset:0;background:#f5f5f5;color:#999;font-size:11px}
</style>
