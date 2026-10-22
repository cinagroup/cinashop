import type { DbClient } from '@/lib/di';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { ValidateException } from '@/utils/errors';
import { canonicalizePublishedAttachmentReference } from './ArticleContentPolicy';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

/** Editorial and carousel components expose only these authored image slots.
 * Navigation URLs, preview rows, neighboring components and arbitrary
 * schema strings never acquire an attachment signature. The shared policy
 * verifies the current platform owner, raster type, object key and MIME before
 * signing; historical tickets are canonicalized and refreshed only in output. */
function editorialMediaSlots(components: unknown[]) {
  const slots: Array<{ owner: RecordValue; key: string }> = [];
  const collect = (value: unknown, key: string) => {
    const owner = record(value);
    if (owner && typeof owner[key] === 'string') slots.push({ owner, key });
    // The UI accepts 200 components, including homeComb's ten Admin-authored
    // slides plus logo (2200 slots). Legacy carousels can contain more than ten
    // slides, so preserve their complete list within an explicit total budget.
    // Reject oversize output/save rather than silently sign a partial schema.
    if (slots.length > 2500) throw new ValidateException('DIY公开素材超过完整读取容量');
  };
  for (const value of components) {
    const component = record(value);
    if (!component) continue;
    if (component.name === 'news') collect(component.imgConfig, 'url');
    else if (component.name === 'hotspot') collect(component.picStyle, 'url');
    else if (component.name === 'follow') { collect(component.imgConfig, 'url'); collect(component.codeConfig, 'url'); }
    else if (component.name === 'activeParty') {
      const list = record(component.menuConfig)?.list;
      if (Array.isArray(list)) for (const item of list.slice(0, 4)) collect(item, 'img');
    }
    else if (component.name === 'swipers' || component.name === 'swiperBg' || component.name === 'homeComb') {
      const list = record(component.swiperConfig)?.list;
      if (Array.isArray(list)) for (const item of list) collect(item, 'img');
      if (component.name === 'homeComb') collect(component.logoConfig, 'url');
      // homeComb's blurred background is derived from the selected slide.
      // Its tabs contain text/typed destinations only, not another image slot.
    }
    // goodList and articleList receive their real media from their independent
    // product/article APIs. Their Admin preview rows are not public authority.
  }
  return slots;
}

/** Local relative asset references only. The shared rule never treats an
 * arbitrary foreign HTTPS /api/assets path as a platform attachment. */
export function canonicalizeDiyEditorialMedia(components: unknown[]): void {
  for (const { owner, key } of editorialMediaSlots(components)) owner[key] = canonicalizePublishedAttachmentReference(owner[key] as string);
}

export async function renderDiyEditorialMedia(db: Pick<DbClient, 'select'>, appKey: string | undefined, components: unknown[]): Promise<void> {
  const slots = editorialMediaSlots(components);
  if (!slots.length) return;
  const references = await publicProductPictures(db, slots.map(({ owner, key }) => ({ image: owner[key], type: 0, relationId: 0 })));
  const rendered = await renderProductPictures(appKey, references);
  slots.forEach(({ owner, key }, index) => { owner[key] = rendered[index]; });
}
