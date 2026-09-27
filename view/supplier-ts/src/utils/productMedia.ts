import { sanitizeArticleRichText } from '../../../common/articleRichText';
import { classifyProductMediaReference } from '../../../common/productMediaReference';

export type ProductMediaPreview =
  | { status: 'ready'; src: string; expires_at: number | null }
  | { status: 'unavailable'; expires_at: null };
export interface SupplierProductMedia {
  version: 1;
  previews: Record<string, ProductMediaPreview>;
  description_html: string;
  status: 'ready' | 'partial' | 'too_many_references';
}
export function escapeProductText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function productImagePreview(reference: string, previews: Record<string, ProductMediaPreview>, now = Date.now()): string | null {
  if (typeof reference !== 'string' || !reference || reference.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(reference)) return null;
  const classified = classifyProductMediaReference(reference);
  if (classified.kind === 'invalid') return null;
  if (classified.kind === 'asset') {
    // A ticket or alias is never a public image. Only the exact durable editing
    // key may resolve to the corresponding fresh signed projection entry.
    if (reference !== classified.reference) return null;
    const entry = previews && typeof previews === 'object' && !Array.isArray(previews) && Object.hasOwn(previews, reference) ? previews[reference] : null;
    if (!entry || entry.status !== 'ready' || typeof entry.src !== 'string' || !Number.isSafeInteger(entry.expires_at) || Number(entry.expires_at) * 1000 <= now) return null;
    const match = new RegExp(`^${reference}\\?expires=([1-9]\\d*)&signature=([A-Za-z0-9_-]{43})$`).exec(entry.src);
    return match && Number(match[1]) === entry.expires_at && Number(entry.expires_at) * 1000 <= now + 3600_000 ? entry.src : null;
  }
  return classified.reference;
}
/** Plain text becomes HTML as a whole, so inserting formatting cannot reinterpret an untouched entity. */
export function formatProductDescription(description: string, range: { start: number; end: number }, tag: 'p' | 'strong' | 'em' | 'ul'): string {
  const start = Math.max(0, Math.min(description.length, range.start)), end = Math.max(start, Math.min(description.length, range.end));
  const isHtml = /<[a-z][^>]*>/i.test(description);
  const plain = (value: string) => escapeProductText(value).replaceAll('\n', '<br>');
  const prefix = description.slice(0, start), suffix = description.slice(end);
  const text = plain(description.slice(start, end) || '填写内容');
  const insertion = tag === 'ul' ? `<ul><li>${text}</li></ul>` : `<${tag}>${text}</${tag}>`;
  return (isHtml ? prefix : plain(prefix)) + insertion + (isHtml ? suffix : plain(suffix));
}
export function productDescriptionPreview(description: string, previews: Record<string, ProductMediaPreview>, now = Date.now()): string {
  const html = /<[a-z][^>]*>/i.test(description) ? description : escapeProductText(description).replaceAll('\n', '<br>');
  const sanitized = sanitizeArticleRichText(html).replace(/\bhref="([^"]*)"/g, (attribute, encoded: string) => {
    const reference = encoded.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    const classified = classifyProductMediaReference(reference);
    if (classified.kind !== 'asset' && !(classified.kind === 'invalid' && classified.privateNamespace)) return attribute;
    const preview = productImagePreview(reference, previews, now);
    return preview ? `href="${escapeProductText(preview)}"` : '';
  });
  return sanitized.replace(/<img\b[^>]*>/g, tag => {
    const match = tag.match(/\bsrc="([^"]*)"/);
    if (!match) return '<span>图片暂不可用</span>';
    const reference = match[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    const preview = productImagePreview(reference, previews, now);
    return preview ? tag.replace(match[0], `src="${escapeProductText(preview)}"`) : '<span>图片暂不可用</span>';
  });
}
