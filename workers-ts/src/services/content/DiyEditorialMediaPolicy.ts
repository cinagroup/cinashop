import type { DbClient } from '@/lib/di';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { ValidateException } from '@/utils/errors';
import { canonicalizePublishedAttachmentReference } from './ArticleContentPolicy';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

/** The six editorial components expose only these authored image slots.
 * Navigation URLs, preview rows, neighboring components and arbitrary
 * schema strings never acquire an attachment signature. The shared policy
 * verifies the current platform owner, raster type, object key and MIME before
 * signing; historical tickets are canonicalized and refreshed only in output. */
function editorialMediaSlots(components: unknown[]) {
  const slots: Array<{ owner: RecordValue; key: string }> = [];
  const collect = (value: unknown, key: string) => {
    const owner = record(value);
    if (owner && typeof owner[key] === 'string') slots.push({ owner, key });
    // The existing public renderer accepts 200 components; its largest valid
    // field set is activeParty's four images (800 total). Fail on oversize
    // malformed schemas rather than truncate an otherwise valid projection.
    if (slots.length > 1000) throw new ValidateException('DIY公开素材超过完整读取容量');
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
