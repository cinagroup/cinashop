import type { ThemePreset } from './theme';
export type PointsStyle=Record<string,string|number>;
export interface DiyPointsRow {id:number;productId:number;title:string;image:string;price:string;integral:number;stock:number}
export const POINTS_ICON='/static/images/diy/points-icon.png';
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const child=(v:unknown,key:string)=>record(record(v)[key]);
const flag=(v:unknown)=>v===true||v===1||typeof v==='string'&&['1','true'].includes(v.trim().toLowerCase());
function number(v:unknown,fallback=0,max=100){const n=typeof v==='number'||typeof v==='string'&&v.trim()!==''?Number(v):NaN;return Number.isFinite(n)&&n>=0?Math.min(n,max):fallback;}
/** Fixed PHP pointsMall.vue active template, computed styles and layout CSS.
 * Author-only title/alternate colour metadata intentionally has no public role. */
export function pointsPresentation(value:unknown,preset:ThemePreset,safeImage:(v:unknown)=>string,safeColor:(v:unknown,fallback:string)=>string){
 const b=record(value),style=Math.floor(number(child(b,'styleConfig').tabVal,0,1)),layout=Math.floor(number(child(b,'goodStyleConfig').tabVal,0,2)),textTitle=Math.floor(number(child(b,'titleConfig').tabVal,1,1))===1,custom=Number(child(b,'toneConfig').tabVal)===1;
 const color=(key:string,fallback:string,index=0)=>{const a=child(b,key).color;return safeColor(Array.isArray(a)?record(a[index]).item:undefined,fallback);};
 const gradient=(key:string,fallback:string,angle:number)=>`linear-gradient(${angle}deg, ${color(key,fallback)} 0%, ${color(key,fallback,1)} 100%)`;
 const radius=(key:string,fallback:number)=>{const a=child(b,key),list=a.valList;return flag(a.type)&&Array.isArray(list)&&list.length===4?[0,1,3,2].map(i=>`${number(record(list[i]).val,0,80)*2}rpx`).join(' '):`${number(a.val,fallback,80)*2}rpx`;};
 const images={imgBgConfig:safeImage(child(b,'imgBgConfig').url),imgConfig:safeImage(child(b,'imgConfig').url),imgConfig2:safeImage(child(b,'imgConfig2').url)};
 const titleImage=style?images.imgConfig:images.imgConfig2,headerImage=style?images.imgBgConfig:'';
 const configuredLimit=Math.floor(number(child(b,'numberConfig').val,6,10000)),limit=Math.min(configuredLimit,10),font=Math.floor(number(child(b,'titleText').tabVal,0,2));
 const rawTitle=child(b,'titleTxtConfig').value,title=typeof rawTitle==='string'?rawTitle.replace(/[\u0000-\u001f\u007f]/gu,''):'';
 const wrapperStyle:PointsStyle={width:'100%',minWidth:'0',boxSizing:'border-box',padding:`${number(child(b,'topConfig').val)}rpx ${number(child(b,'prConfig').val)}rpx ${number(child(b,'bottomConfig').val)}rpx`,marginTop:`${number(child(b,'mbConfig').val)}rpx`};
 const panelStyle:PointsStyle={overflow:'hidden',minWidth:'0',borderRadius:radius('fillet',8),background:'#ffffff',backgroundImage:gradient(style?'moduleColor':'moduleColor2','#ffffff',270)};
 const headerStyle:PointsStyle={height:'96rpx',padding:'0 24rpx',boxSizing:'border-box',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'12rpx',backgroundRepeat:'no-repeat',backgroundSize:'100% 100%',backgroundImage:style?(headerImage?`url("${headerImage.replace(/["()]/gu,c=>encodeURIComponent(c))}")`:'none'):gradient('headerBgColor','#ffffff',90)};
 const titleStyle:PointsStyle={fontSize:'32rpx',color:'#333333',fontWeight:font===0?'bold':'normal',fontStyle:font===2?'italic':'normal',minWidth:'0',overflowWrap:'anywhere'};
 const moreStyle:PointsStyle={fontSize:number(child(b,'bntNumber').val,12),color:color(style?'headerBntColor':'headerBntColor2',style?'#ffffff':'#999999'),display:'flex',alignItems:'center',flexShrink:'0',border:'0',padding:'0',margin:'0',background:'transparent',lineHeight:'normal'};
 const titleImageStyle:PointsStyle={width:'176rpx',height:'32rpx',flexShrink:'0'};
 const bodyStyle:PointsStyle={boxSizing:'border-box',minWidth:'0',padding:layout===0?'0 0 32rpx 20rpx':layout===2?'0 10rpx 8rpx':'0'};
 const scrollStyle:PointsStyle={whiteSpace:'nowrap',padding:'20rpx 0 20rpx 20rpx',boxSizing:'border-box',borderRadius:'16rpx 0 0 16rpx',background:'#ffffff',width:'100%'};
 const listStyle:PointsStyle=layout===0?{display:'flex',flexWrap:'nowrap',alignItems:'flex-start'}:{display:'flex',flexWrap:'wrap',padding:layout===1?'0 10rpx 12rpx':'0',boxSizing:'border-box'};
 const cardStyle:PointsStyle={boxSizing:'border-box',minWidth:'0',margin:layout===0?'0 20rpx 0 0':'0',padding:layout===0?'0':'0 10rpx 20rpx',flex:layout===0?'0 0 224rpx':layout===1?'0 0 33.33%':'0 0 50%',width:layout===0?'224rpx':'auto',whiteSpace:'normal'};
 const imageStyle:PointsStyle={display:'block',width:'100%',height:layout===0?'224rpx':layout===1?'212rpx':'324rpx',borderRadius:radius('filletImg',5)};
 const nameStyle:PointsStyle={marginTop:layout===1?'4rpx':'16rpx',fontSize:layout===1?'26rpx':'28rpx',lineHeight:layout===1?'36rpx':'40rpx',color:color('goodsNameColor','#282828'),display:'-webkit-box',WebkitBoxOrient:'vertical',WebkitLineClamp:layout===1?'1':'2',overflow:'hidden',overflowWrap:'anywhere'};
 const priceStyle:PointsStyle={display:layout===0?'inline-flex':'flex',alignItems:'center',width:'auto',height:layout===0?'36rpx':'auto',margin:'16rpx 0 0',padding:layout===0?'0 12rpx':'0',borderRadius:layout===0?'2rpx 20rpx 20rpx 20rpx':'0',fontFamily:'SemiBold, sans-serif',fontSize:layout===0?'22rpx':'24rpx',lineHeight:layout===0?'normal':'40rpx',color:layout===0?custom?color('goodsPriceColor','#ffffff'):'#ffffff':custom?color('goodsUnitPriceColor','#666666'):'#666666',background:layout===0?custom?gradient('priceBgColor',preset.theme,90):`linear-gradient(90deg, ${preset.theme} 0%, ${preset.gradient} 100%)`:'none',flexWrap:layout===0?'nowrap':'wrap',boxSizing:'border-box'};
 const numberStyle:PointsStyle={color:custom?color('goodsPriceColor2',preset.theme):color('goodsPriceColor',preset.theme)};
 const integralStyle:PointsStyle=layout===0?{fontWeight:'600',fontSize:'26rpx'}:layout===2?{...numberStyle,fontWeight:'600',fontSize:'40rpx'}:{...numberStyle};
 const iconStyle:PointsStyle={width:'28rpx',height:'28rpx',marginRight:layout===1?'8rpx':'4rpx',verticalAlign:'middle',flexShrink:'0'};
 return{style,layout,textTitle,custom,title,images,titleImage,headerImage,configuredLimit,limit,limitNotice:configuredLimit>limit?'当前公开列表最多展示10项，完整配置仍保留':'',enabled:b.name==='pointsMall'&&!flag(b.isHide)&&(b.isShow===undefined||flag(b.isShow)),wrapperStyle,panelStyle,headerStyle,titleStyle,moreStyle,titleImageStyle,bodyStyle,scrollStyle,listStyle,cardStyle,imageStyle,nameStyle,priceStyle,numberStyle,integralStyle,iconStyle};
}
export type DiyPointsPresentation=ReturnType<typeof pointsPresentation>;
