import type { ThemePreset } from './theme';
export type CouponStyle = Record<string, string>;
export interface DiyCouponRow { id:number;type:number;coupon_type:number;coupon_title:string;coupon_price:string;use_min_price:string;is_use:boolean|2;remain_count:number;receive_limit:number }
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const child=(v:unknown,k:string)=>record(record(v)[k]);
function number(v:unknown,fallback=0,max=100){const n=typeof v==='number'||typeof v==='string'&&v.trim()!==''?Number(v):NaN;return Number.isFinite(n)&&n>=0?Math.min(n,max):fallback;}
const flag=(v:unknown)=>v===true||v===1||typeof v==='string'&&['1','true'].includes(v.trim().toLowerCase());
/** Fixed PHP coupon.vue active template/CSS. Limits retain current TS policy;
 * the original $config.LIMIT value is absent from the fixed PHP Git tree. */
export function couponPresentation(value:unknown,preset:ThemePreset,safeColor:(v:unknown,fallback:string)=>string){
 const b=record(value),style=Math.floor(number(child(b,'styleConfig').tabVal,0,4)),custom=Number(child(b,'toneConfig').tabVal)===1;
 const color=(key:string,fallback:string,index=0)=>{const raw=child(b,key).color;return safeColor(Array.isArray(raw)?record(raw[index]).item:undefined,fallback);};
 const amount=custom?color('couponMoneyColor',preset.theme):preset.theme,bg=custom?color('couponBgColor',preset.theme):preset.theme;
 const gradient=(angle:number,customOnly=true)=>`linear-gradient(${angle}deg, ${customOnly&&custom?color('bntBgColor',preset.theme):preset.theme} 0%, ${customOnly&&custom?color('bntBgColor',preset.gradient,1):preset.gradient} 100%)`;
 const module=style===1?`linear-gradient(90deg, ${color('moduleColor','#E93323')} 0%, ${color('moduleColor','#FF7931',1)} 100%)`:color('moduleColor2','#ffffff');
 const corners=child(b,'fillet'),list=corners.valList,radius=flag(corners.type)&&Array.isArray(list)&&list.length===4?[0,1,3,2].map(i=>`${number(record(list[i]).val,0,80)*2}rpx`).join(' '):`${number(corners.val,8,80)*2}rpx`;
 const configuredLimit=Math.floor(number(child(b,'numberConfig').val,6,10000)),limit=Math.min(configuredLimit,10);
 const wrapperStyle:CouponStyle={'--view-theme':preset.theme,'--view-gradient':preset.gradient,padding:`${number(child(b,'topConfig').val)*2}rpx ${number(child(b,'prConfig').val)*2}rpx ${number(child(b,'bottomConfig').val)*2}rpx`,marginTop:`${number(child(b,'mbConfig').val)*2}rpx`,background:color('bottomBgColor','transparent'),boxSizing:'border-box',width:'100%',minWidth:'0'};
 const panelStyle:CouponStyle={'--module-color':module,background:module,borderRadius:radius,minWidth:'0'};
 const bodyStyle:CouponStyle={padding:style===3?'24rpx 20rpx':style===4?'24rpx 0 24rpx 20rpx':'24rpx 0 24rpx 24rpx',boxSizing:'border-box',minWidth:'0'};
 const contentStyle:CouponStyle=style===3?{position:'relative',padding:'20rpx 296rpx 20rpx 20rpx',borderRadius:'24rpx',background:bg,boxSizing:'border-box',minWidth:'0'}:{};
 const itemStyle:CouponStyle={position:'relative',flexShrink:'0',boxSizing:'border-box',marginRight:style===3?`${number(child(b,'spacingConfig').val,6)*2}rpx`:'12rpx',background:'#ffffff',overflow:'visible'};
 const textStyle:CouponStyle={boxSizing:'border-box'},moneyStyle:CouponStyle={fontWeight:'500',fontSize:'28rpx',textAlign:'center',color:amount,whiteSpace:'nowrap'},numberStyle:CouponStyle={fontFamily:'SemiBold, sans-serif',fontSize:'44rpx'},conditionStyle:CouponStyle={fontSize:'18rpx',lineHeight:'26rpx',textAlign:'center',whiteSpace:'nowrap'};
 const nameStyle:CouponStyle={},nameInnerStyle:CouponStyle={},innerStyle:CouponStyle={};
 const actionStyle:CouponStyle={boxSizing:'border-box',padding:'0',margin:'0',border:'0',textAlign:'center',fontWeight:'500',fontSize:'24rpx',color:'#ffffff',background:gradient(custom?180:style>=3?0:90),lineHeight:'normal',flexShrink:'0'};
 const notchTop:CouponStyle={},notchBottom:CouponStyle={},curveStyle:CouponStyle={},dividerStyle:CouponStyle={};
 if(style===0){
  Object.assign(itemStyle,{width:'156rpx',height:'156rpx',borderRadius:'32rpx',marginTop:'20rpx',background:bg});
  Object.assign(textStyle,{width:'144rpx',height:'156rpx',paddingTop:'22rpx',border:'2rpx solid #FCEAE9',borderRadius:'16rpx',margin:'-20rpx auto 0',background:'#ffffff'});
  Object.assign(moneyStyle,{height:'40rpx'});Object.assign(numberStyle,{fontSize:'40rpx',lineHeight:'40rpx'});Object.assign(conditionStyle,{marginTop:'10rpx',color:'#999999'});
  Object.assign(actionStyle,{position:'absolute',right:'0',bottom:'0',left:'0',width:'100%',height:'76rpx',paddingTop:'28rpx',borderRadius:'0 0 32rpx 32rpx'});
  Object.assign(curveStyle,{position:'absolute',top:'0',left:'0',width:'156rpx',height:'20rpx',border:'8rpx solid #FCEAE9',borderTopColor:'#ffffff',borderBottomRightRadius:'78rpx 20rpx',borderBottomLeftRadius:'78rpx 20rpx',boxSizing:'border-box',background:'#ffffff',pointerEvents:'none'});
 }else if(style===1){
  Object.assign(itemStyle,{width:'204rpx',height:'232rpx',paddingTop:'28rpx',borderRadius:'16rpx'});Object.assign(nameStyle,{textAlign:'center',fontWeight:'500',fontSize:'24rpx',lineHeight:'34rpx',color:'#333333'});
  Object.assign(textStyle,{marginTop:'8rpx',textAlign:'center',color:amount});Object.assign(moneyStyle,{height:'48rpx'});Object.assign(conditionStyle,{color:amount});Object.assign(actionStyle,{width:'136rpx',height:'48rpx',borderRadius:'24rpx',margin:'12rpx auto 0',lineHeight:'48rpx'});
 }else if(style===2){
  Object.assign(itemStyle,{width:'274rpx',height:'150rpx',border:`1rpx solid ${amount}`,borderRadius:'16rpx',background:amount});Object.assign(innerStyle,{display:'flex',height:'100%',borderRadius:'15rpx',background:'rgba(255,255,255,0.9)'});
  Object.assign(textStyle,{display:'flex',flex:'1',position:'relative',flexDirection:'column',alignItems:'center',justifyContent:'center'});Object.assign(moneyStyle,{height:'48rpx'});Object.assign(conditionStyle,{marginTop:'8rpx',fontSize:'24rpx',lineHeight:'34rpx',color:amount});
  Object.assign(actionStyle,{display:'flex',alignItems:'center',justifyContent:'center',position:'relative',width:'74rpx',padding:'0 24rpx',fontSize:'26rpx',lineHeight:'28rpx',color:amount,background:'transparent',borderRadius:'0',whiteSpace:'normal',wordBreak:'break-all'});
  const notch={position:'absolute',right:'0',zIndex:'2',width:'16rpx',height:'16rpx',border:`1rpx solid ${amount}`,borderRadius:'50%',background:module,boxSizing:'border-box',pointerEvents:'none'};
  Object.assign(notchTop,notch,{top:'0',transform:'translate(50%, -50%)'});Object.assign(notchBottom,notch,{bottom:'0',transform:'translate(50%, 50%)'});Object.assign(dividerStyle,{position:'absolute',top:'12rpx',bottom:'12rpx',left:'0',borderLeft:`1rpx dashed ${amount}`,pointerEvents:'none'});
 }else if(style===3){
  Object.assign(itemStyle,{width:'140rpx',height:'132rpx',borderRadius:'12rpx'});Object.assign(nameStyle,{width:'108rpx',height:'38rpx',lineHeight:'38rpx',borderRadius:'0 0 19rpx 19rpx',margin:'0 auto',background:amount,textAlign:'center',fontSize:'22rpx',color:amount});Object.assign(nameInnerStyle,{width:'100%',height:'100%',borderRadius:'0 0 19rpx 19rpx',background:'rgba(255,255,255,0.9)'});
  Object.assign(moneyStyle,{height:'46rpx',marginTop:'10rpx'});Object.assign(numberStyle,{fontSize:'40rpx'});Object.assign(conditionStyle,{marginTop:'4rpx',color:'#333333'});
 }else{
  Object.assign(itemStyle,{display:'flex',width:'228rpx',height:'108rpx',borderRadius:'12rpx',background:gradient(custom?180:0)});Object.assign(textStyle,{display:'flex',flex:'1',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRadius:'12rpx',background:`radial-gradient(circle at left 54rpx, ${module} 11rpx, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.8) 100%) top`});Object.assign(moneyStyle,{height:'48rpx'});Object.assign(conditionStyle,{fontSize:'22rpx',lineHeight:'30rpx',color:amount});Object.assign(actionStyle,{display:'flex',alignItems:'center',justifyContent:'center',width:'56rpx',padding:'0 16rpx',fontSize:'24rpx',lineHeight:'28rpx',background:'transparent',whiteSpace:'normal',wordBreak:'break-all'});
 }
 const stationStyle:CouponStyle={position:'absolute',top:'0',right:'0',bottom:'0',width:'296rpx',borderRadius:'0 24rpx 24rpx 0',background:gradient(custom?180:0),display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',boxSizing:'border-box'};
 const stationTitleStyle:CouponStyle={fontWeight:'500',fontSize:'32rpx',lineHeight:'44rpx',color:'#ffffff'},stationInfoStyle:CouponStyle={marginTop:'4rpx',fontSize:'20rpx',lineHeight:'28rpx',color:'#F5F5F5'};
 const stationActionStyle:CouponStyle={display:'block',width:'160rpx',height:'48rpx',borderRadius:'24rpx',margin:'8rpx 0 0',padding:'0',border:'0',background:'rgba(255,255,255,0.9)',textAlign:'center',fontWeight:'500',fontSize:'24rpx',lineHeight:'48rpx',color:bg};
 return{style,custom,enabled:b.name==='coupon'&&!flag(b.isHide)&&(b.isShow===undefined||flag(b.isShow)),configuredLimit,limit,limitNotice:configuredLimit>limit?'当前公开列表最多展示10张，完整配置仍保留':'',wrapperStyle,panelStyle,bodyStyle,contentStyle,listStyle:{display:'flex',flexWrap:'nowrap',alignItems:'stretch'} as CouponStyle,itemStyle,textStyle,moneyStyle,numberStyle,conditionStyle,nameStyle,nameInnerStyle,innerStyle,actionStyle,notchTop,notchBottom,curveStyle,dividerStyle,stationStyle,stationTitleStyle,stationInfoStyle,stationActionStyle};
}
export type DiyCouponPresentation=ReturnType<typeof couponPresentation>;
export function couponMoneyParts(row:DiyCouponRow){return row.coupon_type===2?{prefix:'',number:String(Number(row.coupon_price)/10),suffix:'折'}:{prefix:'¥',number:row.coupon_price,suffix:''};}
export function couponCondition(row:DiyCouponRow){return Number(row.use_min_price)>0?`满${row.use_min_price}可用`:'无门槛券';}
export function couponScope(row:DiyCouponRow){return['通用券','品类券','商品券','品牌券'][row.type]??'';}
export function couponDefaultLabel(row:DiyCouponRow,style:number){return row.is_use===true?'已领取':row.is_use===2?'已过期':style<2?'去领取':style===2?'立即领取':'领取';}
