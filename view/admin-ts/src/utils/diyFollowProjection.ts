import { themePreset } from '../../../common/theme';
import { navFlag, navRead, navigationRecord } from './diyNavigationEditor';
import { listNumber, listRadius, listSafeColor, listText } from './diyListProjection';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';

/** Author preview projects the current public consumer without rewriting imports. */
export function normalizeDiyFollowPreview(block: unknown, previews: Record<string, string> = {}) {
  const preset = themePreset(3);
  const color = (key: string, index: number, fallback: string) => listSafeColor(navRead(block, [key, 'color', index, 'item']), fallback);
  const tone = navigationRecord(navRead(block, ['toneConfig']));
  const button = tone && Number(navRead(block, ['toneConfig', 'tabVal'])) !== 1 ? preset.theme : color('themeColor', 0, preset.theme);
  const image = (key: string) => {
    const raw = navRead(block, [key, 'url']);
    if (typeof raw !== 'string') return '';
    return presentationPreviewForReference(raw, previews[canonicalPresentationReference(raw)]) || presentationPreviewUrl(raw);
  };
  return {
    enabled: !navFlag(navRead(block, ['isHide'])) && navFlag(navRead(block, ['isShow']) ?? true),
    title: listText(navRead(block, ['titleConfig', 'value']), '关注公众号', 40),
    image: image('imgConfig'), code: image('codeConfig'),
    wrapperStyle: { padding: `0 ${listNumber(navRead(block, ['prConfig', 'val']), 0, 80)}px`, marginTop: `${listNumber(navRead(block, ['mbConfig', 'val']), 0, 100)}px` },
    cardStyle: { borderRadius: listRadius(block, 'fillet', [0, 1, 2, 3]).replace(/([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)rpx/giu, (_, n: string) => `${Number(n) / 2}px`), background: `linear-gradient(90deg, ${color('bgColor', 0, '#ffffff')} 0%, ${color('bgColor', 1, '#ffffff')} 100%)` },
    buttonStyle: { color: button, borderColor: button },
  };
}
