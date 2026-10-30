import type { LiveBroadcastStyle } from '../../../common/diyLiveBroadcast';
/** 750-design rpx and original physical px rendered at a 375px-capped canvas.
 * This scales the Admin canvas only; public MP original unit strings are intact. */
export function liveBroadcastPreviewStyle(value: LiveBroadcastStyle): LiveBroadcastStyle {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string'
    ? item.replace(/(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(rpx|px)\b/giu, (_, raw: string, unit: string) => `${Number(raw) / (unit.toLowerCase() === 'rpx' ? 7.5 : 3.75)}cqw`)
    : item]));
}
