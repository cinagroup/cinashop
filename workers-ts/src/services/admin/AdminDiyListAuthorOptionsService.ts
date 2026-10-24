import { sql, type SQL } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { fabDeadlines } from '@/services/content/FabReadService';
import { ValidateException } from '@/utils/errors';
import { AdminFabLinkCatalogService, type FabLinkTarget } from './AdminFabLinkCatalogService';

export interface DiyListAuthorQuery { search: string; page: number; limit: number; offset: number; parent_id: number }
export interface DiyListAuthorSelection { kind: 'product' | 'brand' | 'label' | 'article_category'; id: number; name: string }
export interface DiyListAuthorOption { id: number; name: string; selection: DiyListAuthorSelection }
export interface DiyListAuthorBrand extends DiyListAuthorOption { parent_id: number; has_children: boolean }
export interface DiyListAuthorArticleCategory extends DiyListAuthorOption { aggregate: boolean }
export type DiyListAuthorProduct = FabLinkTarget & { selection: DiyListAuthorSelection | null };
export interface DiyListAuthorPage<T> { list: T[]; count: number; page: number; limit: number; issues: string[] }

/** A closed author-only query contract. No SQL identifier, owner, visibility,
 * catalog kind or permission can be supplied by the client. */
export function parseDiyListAuthorQuery(parameters: URLSearchParams, hierarchy = false): DiyListAuthorQuery {
  const keys = hierarchy ? ['search', 'page', 'limit', 'parent_id'] : ['search', 'page', 'limit'];
  for (const key of new Set(parameters.keys())) if (!keys.includes(key) || parameters.getAll(key).length !== 1) {
    throw new ValidateException('列表作者查询参数未知或重复');
  }
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = parameters.get(key); if (raw === null) return fallback;
    if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new ValidateException('列表作者分页或父级无效');
    const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException('列表作者分页或父级无效');
    return value;
  };
  const page = integer('page', 1, 1, 10001), limit = integer('limit', 15, 1, 100), offset = (page - 1) * limit;
  if (offset > 10000) throw new ValidateException('列表作者分页偏移超过10000');
  const source = parameters.get('search') ?? '', search = source.trim();
  if ([...search].length > 100 || /[\u0000-\u001f\u007f]/u.test(source) || [...source].some(char => {
    const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff;
  })) throw new ValidateException('列表作者搜索文本无效');
  return { page, limit, offset, search, parent_id: hierarchy ? integer('parent_id', 0, 0, 2147483647) : 0 };
}

const visibleBrands = sql`WITH RECURSIVE visible_brands AS (
  SELECT b.id,b.pid,b.brand_name,b.sort,ARRAY[b.id] AS chain FROM store_brand b
  WHERE b.id>0 AND b.pid=0 AND b.store_id=0 AND b.is_del=0 AND b.is_show=1
  UNION ALL SELECT b.id,b.pid,b.brand_name,b.sort,v.chain||b.id
  FROM store_brand b JOIN visible_brands v ON b.pid=v.id
  WHERE b.id>0 AND b.store_id=0 AND b.is_del=0 AND b.is_show=1
    AND cardinality(v.chain)<3 AND NOT b.id=ANY(v.chain)
)`;
type CatalogRow = { id: number; name: string; sort: number; parent_id?: number; has_children?: boolean; aggregate?: boolean };
function safeName(value: string, fallback: string) {
  return [...String(value).replace(/[\u0000-\u001f\u007f]/gu, '').trim()].slice(0, 256).join('') || fallback;
}

/** Narrow read-only identities for complete DIY list authors. This does not
 * invoke brand/label management services under a fabricated actor, delegate
 * their role rules, or disclose draft products, article bodies or media keys. */
export class AdminDiyListAuthorOptionsService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}

  async products(parameters: URLSearchParams): Promise<DiyListAuthorPage<DiyListAuthorProduct>> {
    parseDiyListAuthorQuery(parameters, true);
    const query = new URLSearchParams(parameters); query.set('kind', 'product');
    const result = await new AdminFabLinkCatalogService(this.container, this.env).targets(query);
    return { ...result, list: result.list.map(item => {
      const valid = item.selectable && Number.isSafeInteger(item.id) && item.id > 0 && item.id <= 2147483647;
      return { ...item, selectable: valid, selection: valid ? { kind: 'product' as const, id: item.id, name: item.name } : null };
    }) };
  }

  async brands(parameters: URLSearchParams): Promise<DiyListAuthorPage<DiyListAuthorBrand>> {
    const query = parseDiyListAuthorQuery(parameters, true);
    return this.read<DiyListAuthorBrand>(query, sql`${visibleBrands} SELECT b.id,b.brand_name AS name,b.sort,b.pid AS parent_id,
      EXISTS(SELECT 1 FROM visible_brands child WHERE child.pid=b.id) AS has_children
      FROM visible_brands b WHERE b.pid=${query.parent_id}`, row => {
      const name = safeName(row.name, `品牌 ${row.id}`);
      return { id: row.id, name, parent_id: row.parent_id!, has_children: row.has_children === true,
        selection: { kind: 'brand', id: row.id, name } };
    }, true);
  }

  async labels(parameters: URLSearchParams): Promise<DiyListAuthorPage<DiyListAuthorOption>> {
    const query = parseDiyListAuthorQuery(parameters);
    return this.read<DiyListAuthorOption>(query, sql`SELECT id,label_name AS name,sort FROM store_product_label
      WHERE id>0 AND type=0 AND relation_id=0 AND status=1 AND is_show=1`, row => {
      const name = safeName(row.name, `标签 ${row.id}`);
      return { id: row.id, name, selection: { kind: 'label', id: row.id, name } };
    });
  }

  async articleCategories(parameters: URLSearchParams): Promise<DiyListAuthorPage<DiyListAuthorArticleCategory>> {
    const query = parseDiyListAuthorQuery(parameters);
    // Explicit public aggregation capability, not an invented persisted row.
    // An empty imported/default selection is never coerced into this identity.
    return this.read<DiyListAuthorArticleCategory>(query, sql`SELECT 0 AS id,'热门'::text AS name,0 AS sort,true AS aggregate
      UNION ALL SELECT id,title AS name,sort,false AS aggregate FROM article_category
      WHERE id>0 AND status=1 AND is_del=0 AND hidden=0`, row => {
      const name = safeName(row.name, `文章分类 ${row.id}`);
      return { id: row.id, name, aggregate: row.aggregate === true,
        selection: { kind: 'article_category', id: row.id, name } };
    }, false, true);
  }

  private async read<T>(query: DiyListAuthorQuery, base: SQL, project: (row: CatalogRow) => T, brand = false, aggregate = false): Promise<DiyListAuthorPage<T>> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await fabDeadlines(tx);
      if (brand && query.parent_id) {
        const parent = await tx.execute<{ id: number }>(sql`${visibleBrands} SELECT id FROM visible_brands WHERE id=${query.parent_id}`);
        if (!parent.length) throw new ValidateException('父品牌不存在、隐藏、层级无效或不属于平台');
      }
      const filter = query.search ? sql`WHERE position(lower(${query.search}) in lower(target.name))>0 OR target.id::text=${query.search}` : sql``;
      const counts = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM (${base}) target ${filter}`);
      const rows = await tx.execute<CatalogRow>(sql`SELECT * FROM (${base}) target ${filter}
        ORDER BY ${aggregate ? sql`target.aggregate DESC,` : sql``} target.sort DESC,target.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      return { list: rows.map(project), count: counts[0]?.count ?? 0, page: query.page, limit: query.limit, issues: [] };
    });
  }
}
