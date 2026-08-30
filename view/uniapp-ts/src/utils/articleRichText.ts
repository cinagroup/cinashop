/**
 * Conservative cross-platform allowlist for legacy article HTML.
 *
 * UniApp rich-text applies a second supported-node allowlist. We still rebuild
 * every tag here because its H5 renderer otherwise forwards arbitrary parsed
 * attributes to Vue. Formatting-only style/class/id attributes are deliberately
 * dropped until publishing-time HTML and media migration is available.
 */
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

function safeUrl(value: string, link: boolean): string | null {
  const decoded = decodeAttributeEntities(value).trim();
  if (!decoded || decoded.length > 4_096 || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  const compact = decoded.replace(/[\s\u00a0]+/g, "").toLowerCase();
  if (/^(?:javascript|vbscript|data|file|blob):/.test(compact)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact)) {
    if (/^https?:/i.test(compact)) return decoded;
    if (link && /^(?:mailto|tel):/i.test(compact)) return decoded;
    return null;
  }
  if (decoded.startsWith("//")) return null;
  return decoded;
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
  // Mini-program rich-text does not reliably apply scoped descendant tag
  // selectors. Generate fixed safe dimensions in the node itself so legacy
  // large images/tables cannot overflow or be clipped after style removal.
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

export function sanitizeArticleRichText(html: string): string {
  // Rebuilding every markup token means active attributes are never copied by
  // default. This small tokenizer observes quotes so a legal `>` inside an
  // attribute cannot split a tag. An unterminated tag is escaped fail-closed.
  let result = "";
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) return result + html.slice(cursor);
    result += html.slice(cursor, opening);

    if (html.startsWith("<!--", opening)) {
      const commentEnd = html.indexOf("-->", opening + 4);
      if (commentEnd < 0) return result;
      cursor = commentEnd + 3;
      continue;
    }

    let quote: "\"" | "'" | null = null;
    let closing = -1;
    for (let index = opening + 1; index < html.length; index += 1) {
      const character = html[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === "\"" || character === "'") {
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
    result += sanitizeTag(html.slice(opening, closing + 1));
    cursor = closing + 1;
  }
  return result;
}
