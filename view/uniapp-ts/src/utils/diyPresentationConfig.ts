import { isDiyEnabled, safeDiyColor } from './diy';
import { API_BASE } from './request';
import { diyPresentationHtmlTree, mapDiyPresentationHtmlMedia, safeDiyPresentationUrl } from '../../../common/diyPresentationHtml';
export const DIY_PRESENTATION_NAMES = ['titles','blankPage','guide','richText','videos'] as const;
export const presentationRecord=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const child=(value:Record<string,unknown>,key:string)=>presentationRecord(value[key]);
function number(value:unknown,fallback=0){if(value===undefined)return fallback;const n=typeof value==='number'||typeof value==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)?Number(value):NaN;if(!Number.isFinite(n)||n<0||n>Number.MAX_SAFE_INTEGER/2)throw Error('展示组件长度无效');return n;}
function ordinal(value:unknown,fallback:number,max:number){if(value===undefined)return fallback;const n=typeof value==='number'||typeof value==='string'&&/^(?:0|[1-9]\d*)$/u.test(value)?Number(value):NaN;if(!Number.isInteger(n)||n<0||n>max)throw Error('展示组件选项无效');return n;}
export function presentationMediaUrl(value:unknown):string{const safe=safeDiyPresentationUrl(value);return API_BASE&&/^\/api\/assets\/[1-9]\d*(?:\?|#|$)/u.test(safe)?API_BASE+safe:safe;}
export function normalizeDiyPresentation(value:unknown){
  const block=presentationRecord(value),kind=DIY_PRESENTATION_NAMES.find(name=>name===block.name);if(!kind)throw Error('展示组件类型无效');
  const n=(key:string,fallback=0)=>number(child(block,key).val,fallback),tab=(key:string,fallback=0,max=2)=>ordinal(child(block,key).tabVal,fallback,max);
  const text=(key:string,fallback='')=>{const v=child(block,key).value;return v===undefined?fallback:typeof v==='string'?v:'';};
  const color=(key:string,fallback:string,index=0)=>{const a=child(block,key).color;return safeDiyColor(presentationRecord(Array.isArray(a)?a[index]:null).item,fallback);};
  const fillet=child(block,'fillet'),split=kind!=='guide'&&ordinal(fillet.type,0,1)===1;
  if(split&&fillet.valList!==undefined&&(!Array.isArray(fillet.valList)||fillet.valList.length!==4))throw Error('展示组件四角配置无效');
  const radius=split?[0,1,2,3].map(i=>`${number(presentationRecord((fillet.valList as unknown[]|undefined)?.[i]).val)*2}rpx`).join(' '):`${(kind==='guide'?0:number(fillet.val))*2}rpx`;
  const horizontal=kind==='blankPage'||kind==='guide'?'lrEdge':kind==='richText'?'lrConfig':'prConfig';
  const outerDefault=kind==='titles'?'#ffffff':kind==='videos'?'#F5F5F5':'#E93323';
  const wrapperStyle={boxSizing:'border-box' as const,width:'100%',minWidth:'0',padding:`${n('topConfig',kind==='guide'?6:0)*2}rpx ${n(horizontal)*2}rpx ${n('bottomConfig',kind==='guide'?6:0)*2}rpx`,marginTop:`${kind==='blankPage'?0:n(kind==='richText'?'udConfig':'mbConfig')*2}rpx`,background:color(kind==='guide'?'lineBgColor':'bottomBgColor',outerDefault)};
  const font=kind==='titles'?tab('textStyle'):0,more=kind==='titles'?tab('buttonConfig',0,1)===0:false;
  const source=child(block,'richText').val;
  const html=kind==='richText'&&typeof source==='string'?mapDiyPresentationHtmlMedia(source,ref=>presentationMediaUrl(ref)):'';
  return {kind,enabled:!isDiyEnabled(block.isHide),wrapperStyle,
    panelStyle:{borderRadius:radius,background:kind==='titles'?`linear-gradient(90deg, ${color('titleColor','#ffffff')} 0%, ${color('titleColor','#ffffff',1)} 100%)`:color('bgColor',kind==='blankPage'?'#f5f5f5':'#ffffff')},
    title:text('titleConfig','标题'),right:text('titleConfigRight','更多'),link:text('linkConfig'),more,
    titleRowStyle:{justifyContent:more?'space-between':['flex-start','center','flex-end'][kind==='titles'?tab('textPosition'):0]},
    titleStyle:{fontSize:`${(kind==='titles'?n('fontSize',16):16)*2}rpx`,color:color('themeColor','#333333'),fontStyle:font===1?'italic':'normal',fontWeight:font===2?'bold':'500'},
    moreStyle:{fontSize:`${(kind==='titles'?n('buttonText',12):12)*2}rpx`,color:color('buttonColor','#999999')},
    blankStyle:{height:`${(kind==='blankPage'?n('heightConfig',10):10)*2}rpx`},
    lineStyle:{borderBottomWidth:'1rpx',borderBottomStyle:(['dashed','solid','dotted'] as const)[kind==='guide'?tab('lineStyle',1):1],borderBottomColor:color('lineColor','#f5f5f5')},
    ratio:[9/16,3/4,1][kind==='videos'?tab('scaleConfig'):0],video:presentationMediaUrl(child(block,'videoConfig').url),poster:presentationMediaUrl(child(block,'imgConfig').url),
    richNodes:kind==='richText'?diyPresentationHtmlTree(html):[],
  };
}
export type DiyPresentationConfig=ReturnType<typeof normalizeDiyPresentation>;
