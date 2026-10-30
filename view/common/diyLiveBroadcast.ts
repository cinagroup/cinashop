import type { DiyLiveBroadcastRoom } from './diyLiveBroadcastData';
export type LiveBroadcastStyle = Record<string, string | number>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const child = (value: unknown, key: string) => record(record(value)[key]);
const flag = (value: unknown) => value === true || value === 1 || typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase());
function number(value: unknown, fallback = 0, maximum = 100): number {
  // This is the current public numeric read contract, not an import mutation.
  const parsed = typeof value === 'number' || typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}
function corner(list: unknown, index: number): string { return `${number(record(Array.isArray(list) ? list[index] : null).val, 0) * 2}rpx`; }
/** Pure four-layout view. Only authored backgrounds, spacing and radii apply;
 * fixed status palettes are not imaginary playBg/notBg/endBg author controls. */
export function liveBroadcastPresentation(value: unknown, safeColor: (value: unknown, fallback: string) => string) {
  const block = record(value), layout = Math.floor(number(child(block, 'styleConfig').tabVal, 0, 3));
  const checks = child(block, 'checkboxInfo').type, showTitle = Array.isArray(checks) && checks.includes(0), showAnchor = Array.isArray(checks) && checks.includes(1);
  const color = (key: string, index: number, fallback: string) => { const values = child(block, key).color; return safeColor(record(Array.isArray(values) ? values[index] : null).item, fallback); };
  const panel = child(block, 'fillet'), image = child(block, 'filletImg');
  const panelCorners = panel.type ? [0, 1, 3, 2].map(index => corner(panel.valList, index)) : Array(4).fill(`${number(panel.val, 8) * 2}rpx`) as string[];
  // Explicit author fix: map the own group left-top/right-top/left-bottom/
  // right-bottom to CSS order. PHP cross-read the panel fourth corner; the
  // prior generic TS used own0/1/2/3 and treated string0 as uniform mode.
  const imageCorners = image.type ? [0, 1, 3, 2].map(index => corner(image.valList, index)) : Array(4).fill(`${number(image.val, 8) * 2}rpx`) as string[];
  const configuredLimit = Math.floor(number(child(block, 'numberConfig').val, 10, 10000)), limit = Math.min(configuredLimit, 50), spacing = `${number(child(block, 'liveConfig').val, 10) * 2}rpx`;
  const wrapperStyle: LiveBroadcastStyle = { width: '100%', minWidth: '0', boxSizing: 'border-box', padding: `${number(child(block, 'topConfig').val) * 2}rpx ${number(child(block, 'prConfig').val, 10) * 2}rpx ${number(child(block, 'bottomConfig').val) * 2}rpx`, marginTop: `${number(child(block, 'mbConfig').val) * 2}rpx`, background: color('bottomBgColor', 0, '#f5f5f5') };
  const panelStyle: LiveBroadcastStyle = { minWidth: '0', boxSizing: 'border-box', borderRadius: panelCorners.join(' '), background: `linear-gradient(90deg, ${color('moduleColor', 0, '#ffffff')} 0%, ${color('moduleColor', 1, '#ffffff')} 100%)` };
  const bodyStyle: LiveBroadcastStyle = { padding: layout === 2 ? '20rpx 0' : '20rpx', boxSizing: 'border-box', minWidth: '0' };
  const listStyle: LiveBroadcastStyle = layout === 2 ? { whiteSpace: 'nowrap', display: 'block' } : { minWidth: '0' };
  return { layout, showTitle, showAnchor, configuredLimit, limit, spacing, imageRadius: imageCorners.join(' '), wrapperStyle, panelStyle, bodyStyle, listStyle,
    enabled: block.name === 'liveBroadcast' && !flag(block.isHide) && (block.isShow === undefined || flag(block.isShow)),
    limitNotice: configuredLimit > limit ? '当前公开直播目录最多展示50项，完整配置仍保留' : '',
  };
}
export type DiyLiveBroadcastPresentation = ReturnType<typeof liveBroadcastPresentation>;

/** Original selector rules, separated per room/index so style3's compact tails
 * cannot accidentally inherit the 670rpx cover or hero overlay. */
export function liveBroadcastCardPresentation(view: DiyLiveBroadcastPresentation, room: DiyLiveBroadcastRoom, index: number) {
  const layout = view.layout, compact = layout === 3 && index > 0;
  const cardStyle: LiveBroadcastStyle = { position: 'relative', minWidth: '0', boxSizing: 'border-box', whiteSpace: 'normal',
    ...(layout === 2 ? { display: 'inline-block', verticalAlign: 'top', width: '280rpx', marginLeft: index === 0 ? view.spacing : '0', marginRight: view.spacing } : layout === 3 && !compact ? { overflow: 'hidden', borderRadius: view.imageRadius } : { display: layout === 1 ? 'flex' : 'block', marginTop: index === 0 ? '0' : view.spacing }),
    ...(compact ? { padding: '24rpx 24rpx 20rpx', border: '1rpx solid #EEEEEE', borderRadius: '16rpx' } : {}),
  };
  const frameStyle: LiveBroadcastStyle = { position: 'relative', overflow: 'hidden', flexShrink: '0', width: layout === 1 ? '332rpx' : layout === 2 ? '280rpx' : '100%', height: layout === 0 ? '400rpx' : layout === 1 ? '236rpx' : layout === 2 ? '200rpx' : '670rpx',
    ...(layout === 3 ? { background: '#F3F9FF' } : { borderRadius: view.imageRadius }), ...(layout === 1 || layout === 2 ? { background: '#F3F9FF' } : {}),
  };
  const imageStyle: LiveBroadcastStyle = { display: 'block', width: '100%', height: '100%', ...(layout === 1 ? { borderRadius: '16rpx 0 0 16rpx' } : layout === 2 ? { borderRadius: '16rpx' } : {}) };
  const infoStyle: LiveBroadcastStyle = layout === 0 ? { padding: '24rpx 0 0', minWidth: '0' } : layout === 1 ? { flex: '1', display: 'flex', flexDirection: 'column', padding: '20rpx 0 24rpx 24rpx', boxSizing: 'border-box', minWidth: '0' } : layout === 2 ? { paddingTop: '16rpx', minWidth: '0' } : compact ? { minWidth: '0' } : { position: 'absolute', right: '0', bottom: '0', left: '0', padding: '24rpx', background: 'rgba(0, 0, 0, 0.2)', boxSizing: 'border-box' };
  const titleStyle: LiveBroadcastStyle = { fontSize: '28rpx', lineHeight: '40rpx', color: layout === 3 && !compact ? '#FFFFFF' : '#333333', ...(layout <= 1 ? { overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: '2', wordBreak: 'break-all' } : { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }), ...(layout === 1 || compact ? { flex: '1', minWidth: '0' } : {}) };
  const anchorStyle: LiveBroadcastStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', marginTop: compact ? '16rpx' : '12rpx', fontSize: '24rpx', color: layout === 3 && !compact ? '#FFFFFF' : '#999999' };
  const avatarStyle: LiveBroadcastStyle = { display: 'block', width: '40rpx', height: '40rpx', marginRight: '12rpx', ...(layout === 0 ? {} : { borderRadius: '20rpx' }), flexShrink: '0' };
  const tailTimeStyle: LiveBroadcastStyle = { paddingLeft: '12rpx', marginLeft: '12rpx', borderLeft: '1rpx solid #EEEEEE', lineHeight: '22rpx' };
  const titleRowStyle: LiveBroadcastStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', minWidth: '0' };
  const hero = layout === 0 || layout === 3 && !compact, status = room.live_status;
  const height = compact ? '32rpx' : hero ? '40rpx' : '36rpx', badgeRadius = compact ? '8rpx' : hero ? '0 20rpx 20rpx 0' : layout === 1 ? '18rpx' : '16rpx 0 20rpx 0';
  const fixedPalette = status === 101 ? 'linear-gradient(90deg, #FF2851 0%, #FF2851 100%)' : status === 102 ? 'linear-gradient(90deg, #208FF2 0%, #3FA6FF 98%)' : 'linear-gradient(90deg, #6D80AC 0%, #889EBD 100%)';
  const badgeStyle: LiveBroadcastStyle = { height, display: 'flex', alignItems: 'center', flexWrap: 'nowrap', padding: hero ? '0 16rpx' : '0 12rpx', borderRadius: badgeRadius, fontSize: compact ? '20rpx' : '22rpx', color: '#FFFFFF',
    ...(!compact ? { position: 'absolute', top: hero ? '24rpx' : layout === 1 ? '12rpx' : '0', left: layout === 1 ? '12rpx' : '0', zIndex: '2' } : { marginRight: '16rpx', flexShrink: '0' }),
    background: status === 102 && !compact ? 'rgba(0, 0, 0, 0.2)' : fixedPalette,
    ...(status === 102 && !compact ? { padding: hero ? '0 16rpx 0 0' : '0 12rpx 0 0' } : {}),
    ...(status === 101 && (layout === 0 || layout === 1 || layout === 2) ? { lineHeight: height } : {}),
  };
  const previewTagStyle: LiveBroadcastStyle = { display: 'flex', alignItems: 'center', height, padding: hero ? '0 16rpx' : '0 12rpx', borderRadius: badgeRadius, marginRight: '12rpx', background: fixedPalette };
  const iconStyle: LiveBroadcastStyle = { fontSize: layout === 2 ? '24rpx' : '16px', ...(layout === 2 ? { marginRight: '8rpx' } : {}) };
  const goodsStyle: LiveBroadcastStyle = { display: 'flex', flexWrap: 'wrap', marginTop: '16rpx' };
  const goodStyle: LiveBroadcastStyle = { position: 'relative', width: '96rpx', height: '96rpx', flexShrink: '0' };
  const goodImageStyle: LiveBroadcastStyle = { display: 'block', width: '96rpx', height: '96rpx', borderRadius: '8rpx' };
  const goodMoneyStyle: LiveBroadcastStyle = { position: 'absolute', right: '0', bottom: '0', left: '0', height: '26rpx', background: 'rgba(0, 0, 0, 0.3)', textAlign: 'center', fontSize: '22rpx', lineHeight: '26rpx', whiteSpace: 'nowrap', color: '#FFFFFF' };
  return { compact, showCover: !compact, showInfo: layout !== 3 || compact || view.showTitle || view.showAnchor, showAnchor: layout !== 1 && view.showAnchor, showGoods: layout === 1,
    showTailTime: compact && view.showAnchor, showPreviewTime: status === 102 && !compact,
    label: status === 101 ? '直播中' : status === 102 ? '预告' : '回放', liveIcon: status === 101,
    cardStyle, frameStyle, imageStyle, infoStyle, titleStyle, anchorStyle, avatarStyle, tailTimeStyle, titleRowStyle, badgeStyle, previewTagStyle, iconStyle, goodsStyle, goodStyle, goodImageStyle, goodMoneyStyle,
  };
}

/** Existing migrated UID contract retained deliberately. The original duplicated
 * computed option masks mapGetters(uid), so source alone cannot prove old pid.
 * This builds a destination only, not proof the plugin is deployed/authorized. */
export function liveBroadcastPluginDestination(roomId: number, uid: number): string {
  if (!Number.isSafeInteger(roomId) || roomId < 1 || roomId > 2147483647) throw Error('直播间来源无效');
  const pid = Number.isSafeInteger(uid) && uid > 0 && uid <= 2147483647 ? uid : 0;
  return `plugin-private://wx2b03c6e691cd7370/pages/live-player-plugin?room_id=${roomId}&custom_params=${encodeURIComponent(JSON.stringify({ pid }))}`;
}

/** Long business prices fit the original96rpx badge without truncating money.
 * Ordinary values retain the source22rpx type; this is an explicit readability
 * adaptation, not an original PHP literal-price or fake+5 overlay rule. */
export function liveBroadcastGoodMoneyStyle(price: string, style: LiveBroadcastStyle): LiveBroadcastStyle {
 const digits=(price.match(/[0-9]/gu)??[]).length, separators=(price.match(/[,.]/gu)??[]).length;
 const estimate=22*(0.64+digits*0.64+separators*0.34), size=Math.min(22,22*86/Math.max(1,estimate));
 return {...style,fontSize:`${Math.floor(size*1000)/1000}rpx`};
}
