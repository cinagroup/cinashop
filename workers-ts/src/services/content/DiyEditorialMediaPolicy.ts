import type { DbClient } from '@/lib/di';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { ValidateException } from '@/utils/errors';
import { canonicalizePublishedAttachmentReference } from './ArticleContentPolicy';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
export const DIY_FOOTER_MEDIA_SLOT_LIMIT = 20_000;

/** Editorial, carousel and navigation components expose only these authored image slots.
 * Navigation URLs, preview rows, neighboring components and arbitrary
 * schema strings never acquire an attachment signature. The shared policy
 * verifies the current platform owner, raster type, object key and MIME before
 * signing; historical tickets are canonicalized and refreshed only in output. */
function editorialMediaSlots(components: unknown[]) {
  const slots: Array<{ value: string; set: (value: string) => void }> = [];
  const counts = { ordinary: 0, navigation: 0, footer: 0 };
  const collect = (value: unknown, key: string, navigation = false) => {
    const owner = record(value);
    if (!owner || typeof owner[key] !== 'string') return;
    slots.push({ value: owner[key], set: value => { owner[key] = value; } });
    // The UI accepts 200 components, including homeComb's ten Admin-authored
    // slides plus logo (2200 slots). Legacy carousels can contain more than ten
    // slides, so preserve their complete list within an explicit total budget.
    // Reject oversize output/save rather than silently sign a partial schema.
    // Navigation's separate budget covers 200 UI components with all 100
    // Admin-authored menu entries. Retain the previous editorial/carousel
    // capacity contract, including its atomic 2501-slot rejection.
    counts[navigation ? 'navigation' : 'ordinary']++;
  };
  for (const value of components) {
    const component = record(value);
    if (!component) continue;
    if (typeof component.name === 'string' && component.name.toLowerCase() === 'pagefoot') {
      const list = component.menuList;
      if (Array.isArray(list)) for (const item of list) {
        const images = record(item)?.imgList;
        if (!Array.isArray(images)) continue;
        // These two actual array positions are the selected/unselected icons.
        // An object with numeric keys, later indices, links and previews are
        // never image authority. Imported lists remain complete, not sliced.
        for (const index of [0, 1]) if (typeof images[index] === 'string') {
          slots.push({ value: images[index], set: value => { images[index] = value; } });
          counts.footer++;
        }
      }
    }
    else if (component.name === 'news') collect(component.imgConfig, 'url');
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
    else if (component.name === 'headerSerch') collect(component.logoConfig, 'url', true);
    else if (component.name === 'menus') {
      const list = record(component.menuConfig)?.list;
      if (Array.isArray(list)) for (const item of list) collect(item, 'img', true);
    }
    else if (component.name === 'pictureCube') {
      const picture = record(component.picStyle);
      if (Array.isArray(picture?.picList)) for (const item of picture.picList) collect(item, 'image', true);
      const style = record(component.styleConfig)?.tabVal;
      if ((style === 11 || style === '11') && Array.isArray(picture?.docPicList)) {
        for (const item of picture.docPicList) collect(item, 'img', true);
      }
      // menuConfig is the Admin picker bridge. Non-custom docPicList rows,
      // links and similarly named neighboring fields are not public slots.
    }
    // goodList and articleList receive their real media from their independent
    // product/article APIs. Their Admin preview rows are not public authority.
  }
  // Collect first, reject before any canonical mutation, database owner lookup
  // or signature. The footer's independent budget cannot consume a previously
  // valid full editorial/carousel or navigation budget.
  if (counts.ordinary > 2500 || counts.navigation > 20000 || counts.footer > DIY_FOOTER_MEDIA_SLOT_LIMIT) {
    throw new ValidateException('DIY公开素材超过完整读取容量');
  }
  return slots;
}

/** Local relative asset references only. The shared rule never treats an
 * arbitrary foreign HTTPS /api/assets path as a platform attachment. */
export function canonicalizeDiyEditorialMedia(components: unknown[]): void {
  for (const slot of editorialMediaSlots(components)) slot.set(canonicalizePublishedAttachmentReference(slot.value));
}

export async function renderDiyEditorialMedia(db: Pick<DbClient, 'select'>, appKey: string | undefined, components: unknown[]): Promise<void> {
  const slots = editorialMediaSlots(components);
  if (!slots.length) return;
  // Deduplicate without pre-normalizing: ProductAssetPolicy must still reject
  // malformed/overlong authored input before canonicalizing copied tickets.
  // Its existing 10000-row bound also keeps each PG parameter list bounded.
  const authored = [...new Set(slots.map(slot => slot.value))];
  const approved: string[] = [];
  for (let index = 0; index < authored.length; index += 10000) {
    approved.push(...await publicProductPictures(db, authored.slice(index, index + 10000).map(image => ({ image, type: 0, relationId: 0 }))));
  }
  // There can be 42500 slots across the three independent family budgets, but
  // never start that many HMAC operations concurrently. Repeated canonical
  // references share one fresh capability, including copied historical URLs.
  const unique = [...new Set(approved)], rendered = new Map<string, string>();
  for (let index = 0; index < unique.length; index += 256) {
    const batch = unique.slice(index, index + 256), values = await renderProductPictures(appKey, batch);
    batch.forEach((reference, offset) => { rendered.set(reference, values[offset]); });
  }
  const byAuthored = new Map(authored.map((reference, index) => [reference, rendered.get(approved[index])!]));
  // Only commit projection mutations after every owner check/signing batch.
  for (const slot of slots) slot.set(byAuthored.get(slot.value)!);
}
