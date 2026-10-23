import type { DbClient } from '@/lib/di';
import { publicDiyPresentationImages } from './DiyPresentationVideoPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { canonicalDiyPresentationReference } from '../../../../view/common/diyPresentationHtml';
import { ValidateException } from '@/utils/errors';

export const DIY_PAGE_BACKGROUND_MAX_CHARS = 256;
export const DIY_PAGE_COLOUR_MAX_CHARS = 50;

/** A row-level JSON string, never an HTML attribute or an arbitrary schema slot.
 * Copied local tickets become stable IDs before the persisted column bound is
 * checked. Foreign URLs with an asset-shaped path remain foreign references. */
export function canonicalDiyPageBackground(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\"'<>`]/u.test(value)) {
    throw new ValidateException('bg_pic须为安全图片地址');
  }
  const reference = canonicalDiyPresentationReference(value);
  if ([...reference].length > DIY_PAGE_BACKGROUND_MAX_CHARS) throw new ValidateException('bg_pic不能超过256个字符');
  if (!reference) return '';
  if (reference.startsWith('/api/assets/')) {
    const id = parseCanonicalAttachmentId(reference);
    if (id === null || id > 2_147_483_647) throw new ValidateException('bg_pic平台图片标识无效');
    return reference;
  }
  if (/^\/(?!\/)/u.test(reference)) return reference;
  try {
    const url = new URL(reference);
    if (url.protocol === 'https:' && !url.username && !url.password) return reference;
  } catch { /* Invalid author data never becomes an outbound request. */ }
  throw new ValidateException('bg_pic只支持HTTPS或站内路径');
}

function decimal(value: string, maximum: number, percentage = false): boolean {
  const source = percentage ? value.replace(/%$/u, '') : value;
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(source) && Number.isFinite(Number(source)) && Number(source) <= maximum;
}

/** The actual page colour picker emits CSS colour literals, not CSS programs. */
export function normalizeDiyPageColour(value: unknown): string {
  if (typeof value !== 'string' || value.length > DIY_PAGE_COLOUR_MAX_CHARS) throw new ValidateException('color_picker须为不超过50字符的颜色');
  const colour = value.trim();
  if (!colour || /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(colour) || /^(?:transparent|black|white)$/iu.test(colour)) return colour;
  const match = /^(rgb|rgba|hsl|hsla)\(([\d.,%\s+-]+)\)$/iu.exec(colour);
  if (match) {
    const kind = match[1]!.toLowerCase(), values = match[2]!.split(',').map(part => part.trim()), alpha = kind.endsWith('a');
    if (values.length === (alpha ? 4 : 3)) {
      const channels = kind.startsWith('rgb')
        ? values.slice(0, 3).every(part => part.endsWith('%') === values[0]!.endsWith('%') && decimal(part, part.endsWith('%') ? 100 : 255, part.endsWith('%')))
        : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(values[0]!) && Number.isFinite(Number(values[0])) && Math.abs(Number(values[0])) <= Number.MAX_SAFE_INTEGER
          && values.slice(1, 3).every(part => part.endsWith('%') && decimal(part, 100, true));
      if (channels && (!alpha || decimal(values[3]!, values[3]!.endsWith('%') ? 100 : 1, values[3]!.endsWith('%')))) return colour;
    }
  }
  throw new ValidateException('color_picker颜色格式无效');
}

/** This sole row-level slot is independent of every component family budget.
 * All work completes before returning a projection; the saved row is untouched.
 * Only current platform raster eligibility can produce an asset capability. */
export async function renderDiyPageBackground(db: Pick<DbClient, 'select'>, appKey: string | undefined, value: unknown): Promise<string> {
  let reference: string;
  try { reference = canonicalDiyPageBackground(value); } catch { return ''; }
  if (!reference) return '';
  const approved = await publicDiyPresentationImages(db, [reference]);
  return signDiyPageBackground(appKey, approved[0] ?? '');
}

/** Used only after the combined page collector has resolved every owner. */
export async function signDiyPageBackground(appKey: string | undefined, image: string): Promise<string> {
  // The legacy article renderer intentionally decodes HTML entities. A row
  // JSON path such as /&#97;pi/assets/12 must remain a literal static path and
  // must never become a local asset after its owner check has completed.
  if (parseCanonicalAttachmentId(image) === null) return image;
  const rendered = await signAttachmentReferences(appKey, [image]);
  return rendered[0] ?? '';
}
