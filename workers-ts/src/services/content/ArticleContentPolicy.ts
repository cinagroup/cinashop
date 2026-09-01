import { signAttachmentReferences } from "@/services/system/AttachmentService";
import { ValidateException } from "@/utils/errors";

export const MAX_PUBLISHED_ARTICLE_HTML_CHARS = 200_000;
const MAX_MEDIA_REFERENCE_CHARS = 4_096;

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big",
  "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup",
  "dd", "del", "div", "dl", "dt", "em", "fieldset", "font", "footer", "h1",
  "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins",
  "label", "legend", "li", "mark", "nav", "ol", "p", "pre", "q", "rt",
  "ruby", "s", "section", "small", "span", "strong", "sub", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul",
]);

const VOID_TAGS = new Set(["br", "col", "hr", "img"]);
const TEXT_ATTRIBUTES = new Set(["alt", "title"]);
const DIMENSION_ATTRIBUTES = new Set(["height", "width"]);
const CELL_ATTRIBUTES = new Set(["colspan", "rowspan"]);

const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "title"]),
  bdo: new Set(["dir"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span", "width"]),
  img: new Set(["alt", "height", "src", "title", "width"]),
  ol: new Set(["start", "type"]),
  table: new Set(["width"]),
  td: new Set(["colspan", "height", "rowspan", "width"]),
  th: new Set(["colspan", "height", "rowspan", "width"]),
  tr: new Set(["colspan", "height", "rowspan", "width"]),
};

function decodeAttributeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, digits: string) => {
      const codePoint = Number.parseInt(digits, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&#([0-9]{1,7});?/g, (_, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&(amp|apos|colon|gt|lt|newline|quot|tab);/gi, (_, name: string) => ({
      amp: "&",
      apos: "'",
      colon: ":",
      gt: ">",
      lt: "<",
      newline: "\n",
      quot: '"',
      tab: "\t",
    })[name.toLowerCase()] ?? "");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Uploaded R2 references are durable only in their canonical path form. Any
 * short-lived query string copied from an attachment picker is deliberately
 * removed before the value can be persisted.
 */
export function canonicalizePublishedAttachmentReference(value: string): string {
  const trimmed = decodeAttributeEntities(value).trim();
  const match = /^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/.exec(trimmed);
  return match ? `/api/assets/${match[1]}` : trimmed;
}

function safeUrl(value: string, link: boolean): string | null {
  const canonical = canonicalizePublishedAttachmentReference(value);
  if (
    !canonical
    || canonical.length > MAX_MEDIA_REFERENCE_CHARS
    || /[\u0000-\u001f\u007f]/.test(canonical)
    || /[\s\u00a0]/.test(canonical)
  ) return null;
  const compact = canonical.replace(/[\s\u00a0]+/g, "").toLowerCase();
  if (/^(?:javascript|vbscript|data|file|blob):/.test(compact)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact)) {
    if (/^https:/i.test(compact)) return canonical;
    if (link && /^(?:mailto|tel):/i.test(compact)) return canonical;
    return null;
  }
  if (canonical.startsWith("//")) return null;
  return canonical;
}

export function normalizePublishedArticleMediaReference(value: unknown, label = "文章图片"): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = safeUrl(value, false);
  if (normalized === null) throw new ValidateException(`${label}必须使用HTTPS或站内路径`);
  if (normalized.length > 255) throw new ValidateException(`${label}不能超过255个字符`);
  return normalized;
}

export function normalizePublishedArticleImageInput(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const tokens = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!tokens) throw new ValidateException("文章封面格式错误");
  if (tokens.length > 8) throw new ValidateException("文章封面不能超过8张");
  const normalized = tokens.map((item, index) =>
    normalizePublishedArticleMediaReference(item, `第${index + 1}张文章封面`)
  ).join(",");
  if (normalized.length > 255) throw new ValidateException("文章封面不能超过255个字符");
  return normalized;
}

export function normalizePublishedArticleLink(value: unknown, label = "文章链接"): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = safeUrl(value, true);
  if (normalized === null) throw new ValidateException(`${label}必须使用HTTPS或安全站内路径`);
  return normalized;
}

function safeAttribute(tag: string, name: string, rawValue: string): string | null {
  const value = decodeAttributeEntities(rawValue).trim();
  if (name === "href") return safeUrl(value, true);
  if (name === "src") return safeUrl(value, false);
  if (TEXT_ATTRIBUTES.has(name)) {
    return value.length <= 1_000 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  }
  if (DIMENSION_ATTRIBUTES.has(name)) {
    return /^(?:[1-9][0-9]{0,3})(?:px|%)?$/.test(value) ? value : null;
  }
  if (CELL_ATTRIBUTES.has(name) || name === "span") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= 100 ? String(numeric) : null;
  }
  if (name === "start") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && Math.abs(numeric) <= 10_000 ? String(numeric) : null;
  }
  if (name === "type" && tag === "ol") return /^[1AaIi]$/.test(value) ? value : null;
  if (name === "dir" && tag === "bdo") return /^(?:auto|ltr|rtl)$/.test(value) ? value : null;
  return null;
}

function sanitizeTag(source: string): string {
  if (/^<\s*(?:!|\?)/.test(source)) return "";
  const closing = source.match(/^<\s*\/\s*([a-z][a-z0-9]*)[^>]*>$/i);
  if (closing) {
    const tag = closing[1].toLowerCase();
    return ALLOWED_TAGS.has(tag) && !VOID_TAGS.has(tag) ? `</${tag}>` : "";
  }

  const opening = source.match(/^<\s*([a-z][a-z0-9]*)([\s\S]*?)>$/i);
  if (!opening) return "";
  const tag = opening[1].toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return "";

  const allowed = ALLOWED_ATTRIBUTES[tag] ?? new Set<string>();
  const attributes = new Map<string, string>();
  const attributeSource = opening[2].replace(/\/?\s*$/, "");
  const attributePattern = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(attributeSource)) !== null) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) continue;
    const rawValue = match[2] ?? match[3] ?? match[4];
    if (rawValue === undefined) continue;
    const value = safeAttribute(tag, name, rawValue);
    if (value !== null) attributes.set(name, escapeAttribute(value));
  }
  if (tag === "img") {
    attributes.delete("height");
    attributes.set("width", "100%");
  } else if (tag === "table") {
    attributes.set("width", "100%");
  }
  const serialized = [...attributes]
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return `<${tag}${serialized ? ` ${serialized}` : ""}>`;
}

/** Rebuild legacy HTML from an allowlist before it reaches storage or a client. */
export function sanitizePublishedArticleHtml(value: unknown): string {
  if (typeof value !== "string") throw new ValidateException("文章正文格式错误");
  if ([...value].length > MAX_PUBLISHED_ARTICLE_HTML_CHARS) {
    throw new ValidateException(`文章正文不能超过${MAX_PUBLISHED_ARTICLE_HTML_CHARS}个字符`);
  }
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf("<", cursor);
    if (opening < 0) return result + value.slice(cursor);
    result += value.slice(cursor, opening);

    if (value.startsWith("<!--", opening)) {
      const commentEnd = value.indexOf("-->", opening + 4);
      if (commentEnd < 0) return result;
      cursor = commentEnd + 3;
      continue;
    }

    let quote: '"' | "'" | null = null;
    let closing = -1;
    for (let index = opening + 1; index < value.length; index += 1) {
      const character = value[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        closing = index;
        break;
      }
    }
    if (closing < 0) {
      result += "&lt;";
      cursor = opening + 1;
      continue;
    }
    result += sanitizeTag(value.slice(opening, closing + 1));
    cursor = closing + 1;
  }
  return result;
}

/**
 * Fail closed on unsafe historical cover values, refresh copied signatures,
 * and leave external HTTPS/relative references unchanged.
 */
export async function renderPublishedArticleMediaReferences(
  appKey: string | undefined,
  references: readonly string[],
): Promise<string[]> {
  const normalized = references.map((reference) => safeUrl(reference, false) ?? "");
  const canonical = [...new Set(normalized.filter((reference) =>
    /^\/api\/assets\/[1-9]\d*$/.test(reference)
  ))];
  if (canonical.length === 0) return normalized;
  const signed = await signAttachmentReferences(appKey, canonical);
  const byCanonical = new Map(canonical.map((reference, index) => [reference, signed[index]]));
  return normalized.map((reference) => byCanonical.get(reference) ?? reference);
}

/** Sanitize imported HTML and sign only canonical private-R2 references at response time. */
export async function renderPublishedArticleHtml(
  appKey: string | undefined,
  html: string,
): Promise<string> {
  const sanitized = sanitizePublishedArticleHtml(html);
  const canonical = [...new Set(
    [...sanitized.matchAll(/\b(?:href|src)="(\/api\/assets\/[1-9]\d*)"/g)]
      .map((match) => match[1]),
  )];
  if (canonical.length === 0) return sanitized;
  const signed = await signAttachmentReferences(appKey, canonical);
  const byCanonical = new Map(canonical.map((reference, index) => [
    reference,
    escapeAttribute(signed[index]),
  ]));
  return sanitized.replace(
    /\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g,
    (_, attribute: string, reference: string) => `${attribute}="${byCanonical.get(reference) ?? reference}"`,
  );
}
