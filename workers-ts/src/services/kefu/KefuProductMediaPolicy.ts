import type { DbClient } from '@/lib/di';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export type KefuProductMediaRow = { image: string; type: number; relationId: number; slider_image?: string };
export type KefuProductMedia = { image: string; slider_image: string[] };
const MAX_REFERENCES = 10_000;
const MAX_SLIDER_CHARS = 5_000;
const unsafeImageText = (value: string) => /[\u0000-\u001f\u007f\\]/u.test(value);
const validId = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;

function productOwner(row: KefuProductMediaRow) {
  if (row.type === 0 && row.relationId === 0) return { type: 0, relationId: 0 };
  // Store catalogue copies use platform media; a missing/invalid store id must
  // never inherit the activity helper's type1/relation0 compatibility grant.
  if (row.type === 1 && validId(row.relationId)) return { type: 0, relationId: 0 };
  if (row.type === 2 && validId(row.relationId)) return { type: 2, relationId: row.relationId };
  return { type: -1, relationId: 0 };
}

function sliderImages(value: string | undefined): string[] {
  if (!value || [...value].length > MAX_SLIDER_CHARS) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

/** A slider is bounded by its entire 5000-character JSON column, not the main
 * image's 256-character field. Keep every string position, including blanks and
 * duplicates, without fetching legacy URLs or truncating valid stored input. */
function sliderReference(value: string): string {
  if (unsafeImageText(value)) return '';
  const reference = canonicalizePublishedAttachmentReference(value);
  if (unsafeImageText(reference) || !reference || [...reference].length > MAX_SLIDER_CHARS || /\s/u.test(reference)) return '';
  if (reference.startsWith('/api/assets/')) {
    const id = parseCanonicalAttachmentId(reference);
    return id !== null && validId(id) ? reference : '';
  }
  if (/^\/(?!\/)/.test(reference)) return reference;
  try {
    const url = new URL(reference);
    if (url.protocol === 'https:' && !url.username && !url.password) return reference;
  } catch { /* Data remains a reference; no network or object access. */ }
  return '';
}

/** One complete batched authorization read for main and slider references.
 * Canonical slider IDs share exactly the existing product owner/MIME/object
 * policy. Long safe legacy slider paths do not pass through a main-image cap. */
export async function readKefuProductMedia(db: Pick<DbClient, 'select'>, rows: readonly KefuProductMediaRow[]): Promise<KefuProductMedia[]> {
  const inputs: Array<{ image: string; type: number; relationId: number }> = [];
  const positions: Array<{ start: number; sliders: string[] }> = [];
  for (const row of rows) {
    const owner = productOwner(row), sliders = sliderImages(row.slider_image).map(value => owner.type < 0 ? '' : sliderReference(value));
    positions.push({ start: inputs.length, sliders });
    // Validate decoded text without feeding it back for a second entity decode.
    const main = unsafeImageText(canonicalizePublishedAttachmentReference(row.image)) ? '' : row.image;
    inputs.push({ ...owner, image: main }, ...sliders.map(reference => ({ ...owner,
      image: parseCanonicalAttachmentId(reference) === null ? '' : reference })));
    if (inputs.length > MAX_REFERENCES) throw new ValidateException('客服商品图片超过完整预览容量');
  }
  const authorized = await publicProductPictures(db, inputs, 256);
  return positions.map(({ start, sliders }) => ({ image: authorized[start] ?? '',
    slider_image: sliders.map((reference, index) => parseCanonicalAttachmentId(reference) === null
      ? reference : authorized[start + index + 1] ?? '') }));
}

/** Sign only the canonical references already authorized in SQL. Do not run
 * legacy slider URLs through an unrelated article/main-image length budget. */
export async function renderKefuProductMedia(appKey: string | undefined, rows: readonly KefuProductMedia[]): Promise<KefuProductMedia[]> {
  const canonical = [...new Set(rows.flatMap(row => [row.image, ...row.slider_image])
    .filter(reference => parseCanonicalAttachmentId(reference) !== null))];
  const signed = canonical.length ? await signAttachmentReferences(appKey, canonical) : [];
  const tickets = new Map(canonical.map((reference, index) => [reference, signed[index] ?? '']));
  const render = (reference: string) => tickets.get(reference) ?? reference;
  return rows.map(row => ({ image: render(row.image), slider_image: row.slider_image.map(render) }));
}
