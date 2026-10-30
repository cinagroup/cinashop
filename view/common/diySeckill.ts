import type { ThemePreset } from './theme';
export type SeckillStyle = Record<string, string | number>;
export type { DiySeckillRow } from './diySeckillData';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const child = (v: unknown, key: string) => record(record(v)[key]);
const flag = (v: unknown) => v === true || v === 1 || typeof v === 'string' && ['1', 'true'].includes(v.trim().toLowerCase());
function number(v: unknown, fallback = 0, max = 100) { const n = typeof v === 'number' || typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback; }
function text(v: unknown) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/gu, '') : ''; }
/** BaseMoney.vue's fixed2 decimals and comma-separated integer, without loading
 * a purchase controller. API-normalized money is already finite and bounded. */
export function seckillMoneyParts(value: string) { const [integer = '0', decimal = '00'] = Number(value).toFixed(2).split('.'); return { integer: integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ','), decimal }; }
/** Explicit readability adaptation for the fixed150rpx three-column bar.
 * This was not a PHP BaseMoney rule. Preserve the full formatted price and the
 * original24/36/36 sizes elsewhere; conservatively fit long amounts within a
 * 138rpx budget without measuring native glyphs or changing price data. */
export function seckillMoneyTypography(price: string, layout: number) {
 const parts = seckillMoneyParts(price), formatted = `${parts.integer}.${parts.decimal}`;
 const digits = (formatted.match(/[0-9]/gu) ?? []).length, separators = (formatted.match(/[,.]/gu) ?? []).length;
 const estimatedWidth = 24 + 36 * (digits * 0.64 + separators * 0.34);
 const scale = layout === 2 && estimatedWidth > 138 ? 138 / estimatedWidth : 1;
 const size = (base: number) => `${Math.floor(base * scale * 1000) / 1000}rpx`;
 return { symbolStyle: { fontSize: size(24) }, integerStyle: { fontSize: size(36) }, decimalStyle: { fontSize: size(36) } };
}
/** Fixed PHP seckill.vue template/computed styles plus BaseMoney/global CSS.
 * Author check IDs0/1/2/3 preserve their original public meaning.
 * Conditional enum truthiness follows the actual JavaScript consumer, including
 * imported string"0"; the layout and title font comparisons are numeric. */
export function seckillPresentation(value: unknown, preset: ThemePreset, safeImage: (v: unknown) => string, safeColor: (v: unknown, fallback: string) => string) {
 const b = record(value), style = child(b, 'styleConfig').tabVal ? 1 : 0, layout = Math.floor(number(child(b, 'goodStyleConfig').tabVal, 0, 3)), textTitle = !!child(b, 'titleConfig').tabVal, custom = !!child(b, 'toneConfig').tabVal, showButton = layout !== 2 && !child(b, 'seckillConfig').tabVal;
 const color = (key: string, fallback: string, index = 0) => { const a = child(b, key).color; return safeColor(Array.isArray(a) ? record(a[index]).item : undefined, fallback); };
 const gradient = (key: string, fallback: string) => `linear-gradient(90deg, ${color(key, fallback)} 0%, ${color(key, fallback, 1)} 100%)`;
 const radiusValues = (key: string, fallback: number) => { const a = child(b, key), list = a.valList; return a.type && Array.isArray(list) && list.length === 4 ? [0, 1, 2, 3].map(i => `${number(record(list[i]).val, 0, 80) * 2}rpx`) : Array(4).fill(`${number(a.val, fallback, 80) * 2}rpx`) as string[]; };
 const corners = radiusValues('fillet', 8), imgCorners = radiusValues('filletImg', 0), radius = (r: string[]) => [r[0], r[1], r[3], r[2]].join(' ');
 const images = { imgBgConfig: safeImage(child(b, 'imgBgConfig').url), imgConfig: safeImage(child(b, 'imgConfig').url), imgColorConfig: safeImage(child(b, 'imgColorConfig').url) }, titleImage = style ? images.imgConfig : images.imgColorConfig, headerImage = style ? images.imgBgConfig : '';
 const configuredLimit = Math.floor(number(child(b, 'numberConfig').val, 6, 10000)), limit = Math.min(configuredLimit, 10), font = Math.floor(number(child(b, 'titleText').tabVal, 0, 2));
 const rawChecks = child(b, 'checkboxInfo').type, checks = Array.isArray(rawChecks) ? rawChecks : [], showName = checks.includes(0), showPrice = checks.includes(2), showOldPrice = checks.includes(3);
 const priceColor = custom ? color('seckillPriceColor', preset.theme) : preset.theme, buttonBackground = custom ? `linear-gradient(90deg, ${color('goodsBntColor', preset.theme, 1)} 0%, ${color('goodsBntColor', preset.theme)} 100%)` : `linear-gradient(90deg, ${preset.gradient} 0%, ${preset.theme} 100%)`;
 const wrapperStyle: SeckillStyle = { width: '100%', minWidth: '0', boxSizing: 'border-box', padding: `${number(child(b, 'topConfig').val) * 2}rpx ${number(child(b, 'prConfig').val, 10) * 2}rpx ${number(child(b, 'bottomConfig').val) * 2}rpx`, marginTop: `${number(child(b, 'mbConfig').val) * 2}rpx`, background: color('bottomBgColor', '#f5f5f5') };
 const panelStyle: SeckillStyle = { minWidth: '0', borderRadius: radius(corners), background: gradient('moduleColor', '#ffffff') };
 const headerStyle: SeckillStyle = { height: '96rpx', padding: '0 24rpx', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxSizing: 'border-box', backgroundSize: 'cover', borderRadius: `${corners[0]} ${corners[1]} 0 0`, backgroundImage: style ? headerImage ? `url("${headerImage.replace(/["()]/gu, c => encodeURIComponent(c))}")` : 'none' : `linear-gradient(90deg, ${color('headerBgColor', '#ffffff')} 0%, ${color('headerBgColor', '#ffffff')} 100%)` };
 const titleStyle: SeckillStyle = { fontSize: `${number(child(b, 'titleNumber').val, 16) * 2}rpx`, lineHeight: '44rpx', fontWeight: font === 0 ? 'bold' : '500', fontStyle: font === 2 ? 'italic' : 'normal', color: color('titleColor', '#333333') };
 const titleImageStyle: SeckillStyle = { width: '140rpx', height: '32rpx', flexShrink: '0' };
 const tipStyle: SeckillStyle = { fontSize: '26rpx', lineHeight: '36rpx', paddingLeft:'20rpx', color: color(style ? 'tipsColor' : 'tipsColor2', style ? '#ffffff' : '#666666') };
 const moreStyle: SeckillStyle = { fontSize: `${number(child(b, 'bntNumber').val, 12) * 2}rpx`, color: color(style ? 'headerBntColor' : 'headerBntColor2', style ? '#ffffff' : '#999999'), display: 'flex', alignItems: 'center', flexShrink: '0', border: '0', padding: '0', margin: '0', background: 'transparent', lineHeight: 'normal' };
 const bodyStyle: SeckillStyle = { minWidth: '0', boxSizing: 'border-box', padding: layout === 3 ? '32rpx 0' : '32rpx 20rpx', ...(layout === 0 ? { background: '#ffffff', borderRadius: `0 0 ${corners[0]} ${corners[1]}` } : {}) };
 const listStyle: SeckillStyle = layout === 0 ? { display: 'flex', flexDirection: 'column', gap: '32rpx' } : layout === 3 ? { display: 'flex', flexWrap: 'nowrap' } : { display: 'grid', gridTemplateColumns: `repeat(${layout === 1 ? 2 : 3}, minmax(0, 1fr))`, gap: layout === 1 ? '22rpx' : '18rpx' };
 const cardStyle: SeckillStyle = { position: 'relative', minWidth: '0', boxSizing: 'border-box', ...(layout === 0 ? { display: 'flex', justifyContent: 'space-between', width: '100%' } : layout === 3 ? { display: 'inline-block', flex: '0 0 224rpx', width: '224rpx', marginLeft: '20rpx', verticalAlign: 'middle' } : {}) };
 const imageStyle: SeckillStyle = { display: 'block', flexShrink: '0', width: layout === 0 ? '240rpx' : layout === 3 ? '224rpx' : '100%', height: ['240rpx', '324rpx', '212rpx', '224rpx'][layout], borderRadius: radius(imgCorners) };
 const contentStyle: SeckillStyle = layout === 0 ? { height: '240rpx', paddingLeft: '20rpx', flex: '1', minWidth: '0', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' } : { minWidth: '0' };
 const nameStyle: SeckillStyle = { width: layout === 3 ? '222rpx' : '100%', marginTop: layout === 0 ? '0' : '16rpx', ...(layout === 0 ? { height: '80rpx' } : {}), fontSize: layout <= 1 ? '28rpx' : '26rpx', ...(layout <= 1 ? { lineHeight: '40rpx', wordBreak: 'break-all', display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' } : { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }), color: color('goodsNameColor', '#333333'), fontWeight: child(b, 'goodsName').tabVal ? 'normal' : '500' };
 const progressStyle: SeckillStyle = {width:'240rpx',height:'24rpx',position:'relative',borderRadius:'12rpx',background:'rgba(253, 240, 237, 1)'};
 const progressRowStyle: SeckillStyle = {display:'flex',alignItems:'center',marginTop:'20rpx'};
 const progressFillStyle: SeckillStyle = {height:'24rpx',borderRadius:'12rpx',background:custom?gradient('progressColor',preset.theme):`linear-gradient(45deg, ${preset.gradient} 0%, ${preset.theme} 100%)`};
 const progressTextStyle: SeckillStyle = {fontSize:'22rpx',lineHeight:'30rpx',paddingLeft:'12rpx',color:priceColor};
 const lightningStyle: SeckillStyle = {position:'absolute',top:'-2rpx',width:'28rpx',height:'28rpx'};
 const priceBarStyle: SeckillStyle = {position:'relative',display:'flex',alignItems:'center',justifyContent:'center',width:'150rpx',height:'44rpx',margin:'20rpx 0 0 10rpx',borderRadius:'0 8rpx 8rpx 0',background:`linear-gradient(45deg, ${preset.gradient} 0%, ${preset.theme} 100%)`};
 const shandianStyle: SeckillStyle = {position:'absolute',top:'0',left:'-10rpx',width:'24rpx',height:'44rpx'};
 const numberBackground=color(style?'numberBgColor':'numberBgColor2',style?'#ffffff':preset.theme);
 const countdownStyle: SeckillStyle = {display:'flex',alignItems:'center',flexShrink:'0'};
 const digitStyle: SeckillStyle = {padding:'0 8rpx',borderRadius:'4rpx',fontSize:'24rpx',lineHeight:'40rpx',background:numberBackground,color:color(style?'numberColor':'numberColor2',style?preset.theme:'#ffffff')};
 const dotStyle: SeckillStyle = {fontSize:'24rpx',lineHeight:'40rpx',color:numberBackground};
 const priceStyle: SeckillStyle = { display:'inline-block', whiteSpace:'nowrap', color:layout === 2 ? '#ffffff' : priceColor, fontFamily:'SemiBold, sans-serif', fontWeight:'500' }, prefixStyle: SeckillStyle = { fontSize:'24rpx', fontWeight:'500', fontFamily:'PingFang SC-Medium, PingFang SC, sans-serif', color:priceColor }, symbolStyle: SeckillStyle = { fontSize:'24rpx' }, integerStyle: SeckillStyle = { fontSize:'36rpx' }, decimalStyle: SeckillStyle = { fontSize:'36rpx' };
 const priceRowStyle: SeckillStyle = layout !== 2 ? { display:'flex', justifyContent:'space-between', alignItems:'flex-end', ...(layout !== 0 ? {marginTop:layout === 3?'16rpx':'10rpx'} : {}), minWidth:'0' } : { display:'flex', alignItems:'baseline' };
 const oldPriceStyle: SeckillStyle = { textDecoration:'line-through', fontSize:layout <= 1 ? '28rpx' : '24rpx', color:color('goodsPriceColor','#999999'), fontFamily:'Regular, sans-serif', ...(layout <= 1 ? {paddingTop:'14rpx'} : {lineHeight:'32rpx',...(layout===2?{marginTop:'10rpx'}:{})}) };
 const buttonStyle: SeckillStyle = { position:'relative', width: layout===3?'66rpx':'144rpx', height: layout===3?'40rpx':'56rpx', borderRadius: layout===3?'0 22rpx 22rpx 0':'30rpx', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0', fontSize: '24rpx', color: '#ffffff', background: buttonBackground };
 return { style, layout, textTitle, custom, showButton, showName, showPrice, showOldPrice, title: text(child(b, 'titleTxtConfig').value), tip: '距离结束', moreText: text(child(b, 'rightBntConfig').value), images, titleImage, headerImage, configuredLimit, limit, limitNotice: configuredLimit > limit ? '当前公开列表最多展示10项，完整配置仍保留' : '', enabled: b.name === 'seckill' && !flag(b.isHide) && (b.isShow === undefined || flag(b.isShow)), wrapperStyle, panelStyle, headerStyle, titleStyle, titleImageStyle, tipStyle, moreStyle, bodyStyle, listStyle, cardStyle, imageStyle, contentStyle, nameStyle, priceStyle, prefixStyle, symbolStyle, integerStyle, decimalStyle, priceRowStyle, oldPriceStyle, progressStyle, progressRowStyle, progressFillStyle, progressTextStyle, lightningStyle, priceBarStyle, shandianStyle, countdownStyle, digitStyle, dotStyle, buttonStyle };
}
export type DiySeckillPresentation = ReturnType<typeof seckillPresentation>;

/** Preserve the original public 107px endpoint instead of converting it to a percentage. */
export const seckillLightningLeft=(percent:number)=>percent===100?'107px':`${percent}%`;

/** isDay=false in original countDown: hours may exceed24; zero never rolls to a new slot. */
export function seckillCountdown(stop:number,now:number):string[]{const seconds=Math.max(0,Math.floor(stop-now/1000));return[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0'));}
