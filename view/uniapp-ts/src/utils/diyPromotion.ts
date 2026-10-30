import { promotionPresentation, promotionProductBlock, promotionTabPresentation } from '../../../common/diyPromotion';
import { safeDiyColor, safeDiyImageUrl } from './diy';
import type { ThemePreset } from '../../../common/theme';
export const normalizeDiyPromotion = (block: unknown, preset: ThemePreset) => promotionPresentation(block, preset, safeDiyImageUrl, safeDiyColor);
export { promotionProductBlock, promotionTabPresentation };
