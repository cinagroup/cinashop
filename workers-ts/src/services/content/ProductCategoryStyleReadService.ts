import { sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemDise } from '@/models/schema';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { DISE_TEMPLATE_TRIM_CHARACTERS, themeDeadlines, themeHash } from './ThemeReadService';
import { isProductCategoryStyleValue, PRODUCT_CATEGORY_STYLE_DEFAULT, type ProductCategoryStyleSnapshot,
  type PublicProductCategoryStyle } from '../../../../view/common/productCategoryStyle';

export const PRODUCT_CATEGORY_TEMPLATE_NAME = 'category';
export const PRODUCT_CATEGORY_MAX_VALUE_BYTES = 1_048_576;
/** Semantic JSON preservation: formatting may change, numeric values may not. */
export function categoryStyleNumbersExact(text: string): boolean {
  const decimal = (token: string): string | null => {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    if (!match || token.length > 512 || (match[4]?.length ?? 0) > 64) return null;
    const digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, ''); if (!digits) return '0';
    const coefficient = digits.replace(/0+$/, '');
    return `${match[1]}${coefficient}e${BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length) + BigInt(digits.length - coefficient.length)}`;
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') { i++; while (i < text.length) { const c = text[i++]; if (c === '\\') i++; else if (c === '"') break; } continue; }
    if (/[\d-]/u.test(text[i])) {
      const start = i++; while (i < text.length && /[\deE+.-]/u.test(text[i])) i++;
      const token = text.slice(start, i), number = Number(token), encoded = Number.isFinite(number) ? JSON.stringify(number) : '';
      if (decimal(token) === null || decimal(token) !== decimal(encoded)) return false;
    } else i++;
  }
  return true;
}
export function decodeProductCategoryStyle(value: string | null): Record<string, unknown> | null {
  try {
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > PRODUCT_CATEGORY_MAX_VALUE_BYTES) return null;
    const parsed = parseLevelActivationJson(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !categoryStyleNumbersExact(value)) return null;
    return parsed as Record<string, unknown>;
  } catch { return null; }
}
export async function productCategoryStyleCatalog(tx: DbClient) {
  const rows = await tx.select({ id: systemDise.id, templateName: systemDise.templateName, type: systemDise.type,
    isDel: systemDise.isDel, status: systemDise.status, isShow: systemDise.isShow, version: systemDise.version,
    updateTime: systemDise.updateTime, value: sql<string | null>`CASE WHEN octet_length(${systemDise.value})<=${PRODUCT_CATEGORY_MAX_VALUE_BYTES} THEN ${systemDise.value} ELSE NULL END`,
    valueBytes: sql<number | null>`octet_length(${systemDise.value})`, xmin: sql<string>`xmin::text` })
    .from(systemDise).where(sql`lower(btrim(${systemDise.templateName},${DISE_TEMPLATE_TRIM_CHARACTERS}))=${PRODUCT_CATEGORY_TEMPLATE_NAME}`)
    .orderBy(systemDise.id).limit(3);
  return { rows, revision: await themeHash({ template: PRODUCT_CATEGORY_TEMPLATE_NAME, type: 3, rows }) };
}
export function projectProductCategoryStyle(catalog: Awaited<ReturnType<typeof productCategoryStyleCatalog>>): ProductCategoryStyleSnapshot {
  const snapshot: ProductCategoryStyleSnapshot = { revision: catalog.revision, value: null, configured: false, editable: false, issues: [] };
  if (!catalog.rows.length) return { ...snapshot, value: { ...PRODUCT_CATEGORY_STYLE_DEFAULT }, editable: true, issues: ['category_style_missing'] };
  if (catalog.rows.length !== 1) return { ...snapshot, issues: ['category_style_duplicate'] };
  const row = catalog.rows[0];
  if (row.id <= 0 || row.templateName !== PRODUCT_CATEGORY_TEMPLATE_NAME || row.type !== 3 || row.isDel !== 0) return { ...snapshot, issues: ['category_style_identity_invalid'] };
  const saved = decodeProductCategoryStyle(row.value), value = saved ? { ...PRODUCT_CATEGORY_STYLE_DEFAULT, ...saved } : null;
  if (!value || !isProductCategoryStyleValue(value)) return { ...snapshot, issues: ['category_style_value_invalid'] };
  return { ...snapshot, value: { level: value.level, index: value.index }, configured: true, editable: true };
}
export function publicProductCategoryStyle(snapshot: ProductCategoryStyleSnapshot, extensions?: Record<string, unknown> | null): PublicProductCategoryStyle {
  return { ...(snapshot.configured ? extensions : null), ...(snapshot.value ?? PRODUCT_CATEGORY_STYLE_DEFAULT), configured: snapshot.configured, issues: [...snapshot.issues] };
}
export class ProductCategoryStyleReadService {
  constructor(private readonly container: Container) {}
  read() { return withTx(this.container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await themeDeadlines(tx);
    return projectProductCategoryStyle(await productCategoryStyleCatalog(tx));
  }); }
  readPublic() { return withTx(this.container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await themeDeadlines(tx);
    const catalog = await productCategoryStyleCatalog(tx), snapshot = projectProductCategoryStyle(catalog);
    return publicProductCategoryStyle(snapshot, snapshot.configured ? decodeProductCategoryStyle(catalog.rows[0].value) : null);
  }); }
}
