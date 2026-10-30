import type { PresaleStyle } from '../../../common/diyPresale';
/** The author preview uses a750rpx design canvas, capped at375 CSS pixels.
 * cqw scales every original rpx together when the dialog narrows. Fixed px
 * conversion leaves a240rpx single-column photo beside an unreadable price.
 * Only this Admin preview uses container units; the public native styles stay rpx. */
export function presalePreviewStyle(style: PresaleStyle): PresaleStyle {
 return Object.fromEntries(Object.entries(style).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)rpx/giu, (_, n: string) => `calc(${n} * min(0.5px, 0.1333333333cqw))`) : value]));
}
