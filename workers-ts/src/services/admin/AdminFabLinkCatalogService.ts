import { sql, type SQL } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { fabDeadlines } from '@/services/content/FabReadService';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { fabLink } from './AdminFabSettingsInput';
import { ValidateException } from '@/utils/errors';
import { legacyArticleImages } from '@/services/content/PublicArticleCompatibilityService';
import { integralPublicCandidateSql, integralPublicMediaOwner } from '@/services/activity/IntegralPublicCatalogPolicy';
import { integralDetailInteger, integralDetailMoney, integralDetailText } from '@/services/activity/IntegralProductDetailData';
import { readIntegralCatalogReadability } from '@/services/activity/IntegralCatalogReadability';

export const FAB_LINK_CATEGORIES = [
  { kind: 'basic', name: '基础链接', group: '商城页面' },
  { kind: 'personal', name: '个人中心', group: '商城页面' },
  { kind: 'distribution', name: '分销', group: '商城页面' },
  { kind: 'marketing', name: '营销链接', group: '商城页面' },
  { kind: 'product', name: '商品', group: '商品页面' },
  { kind: 'product_category', name: '商品分类', group: '商品页面' },
  { kind: 'seckill', name: '秒杀商品', group: '商品页面' },
  { kind: 'bargain', name: '砍价商品', group: '商品页面' },
  { kind: 'combination', name: '拼团商品', group: '商品页面' },
  { kind: 'integral', name: '积分商品', group: '商品页面' },
  { kind: 'presale', name: '预售商品', group: '商品页面' },
  { kind: 'news', name: '文章', group: '文章页面' },
  { kind: 'special', name: 'DIY专题', group: '商城页面' },
] as const;
export type FabLinkKind = typeof FAB_LINK_CATEGORIES[number]['kind'];
export interface FabLinkQuery { kind: FabLinkKind; search: string; page: number; limit: number; offset: number; parent_id: number }
export interface FabLinkTarget {
  id: number; name: string; url: string; kind: FabLinkKind; selectable: boolean; partial: boolean; issues: string[];
  image_preview?: string; price?: string; parent_id?: number; has_children?: boolean;
}
const queryKeys = ['kind', 'search', 'page', 'limit', 'parent_id'];
export function parseFabLinkQuery(parameters: URLSearchParams): FabLinkQuery {
  for (const key of new Set(parameters.keys())) {
    if (!queryKeys.includes(key) || parameters.getAll(key).length !== 1) throw new ValidateException('链接查询参数未知或重复');
  }
  const kind = parameters.get('kind');
  if (!FAB_LINK_CATEGORIES.some(item => item.kind === kind)) throw new ValidateException('请选择有效的链接类型');
  const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
    const raw = parameters.get(key); if (raw === null) return fallback;
    if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new ValidateException('链接分页或父分类无效');
    const value = Number(raw); if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ValidateException('链接分页或父分类无效');
    return value;
  };
  const page = integer('page', 1, 1, 10001), limit = integer('limit', 15, 1, 100), offset = (page - 1) * limit;
  if (offset > 10000) throw new ValidateException('链接分页偏移超过10000');
  const parent_id = integer('parent_id', 0, 0, 2147483647);
  if (parent_id !== 0 && kind !== 'product' && kind !== 'product_category') throw new ValidateException('此链接类型不接受父分类');
  const search = (parameters.get('search') ?? '').trim();
  if ([...search].length > 100 || /[\u0000-\u001f\u007f]/u.test(parameters.get('search') ?? '')
    || [...search].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; })) throw new ValidateException('链接搜索文本无效');
  return { kind: kind as FabLinkKind, search, page, limit, offset, parent_id };
}
/** Disabled history stays visible, but its unsafe/unimplemented URL never becomes
 * a selectable value. This catalog does not add mappings to the shared registry. */
export function projectFabLinkTarget(row: { id: number; name: string; url: string; kind: FabLinkKind; issues?: string[] }): FabLinkTarget {
  const issues = [...(row.issues ?? [])]; let url = '', partial = false;
  try { const target = fabLink(row.url); url = target.value; partial = target.partial; }
  catch { issues.push('此历史目标不安全或尚无可执行页面，请选择其他目标'); }
  if (partial) issues.push(row.kind === 'integral' ? '积分详情可查看；部分旧分享与推荐能力尚未完整承接'
    : '此历史链接使用当前合并页面，部分旧页面能力尚未完整承接');
  return { id: row.id, name: [...row.name.replace(/[\u0000-\u001f\u007f]/gu, '')].slice(0, 256).join('') || `目标 ${row.id}`,
    kind: row.kind, url, selectable: !!url && !(row.issues?.length), partial, issues };
}
type CatalogRow = { id: number; name: string; image: string; url?: string; price?: string; owner_type?: number; relation_id?: number;
  product_id?: number; stock?: number; quota?: number;
  parent_id?: number; has_children?: boolean; value?: string; is_vip?: number };
/** Selection authorizes a link to the activity, never redemption. The detail
 * reader owns paired-SKU stock/price validation; malformed summaries are not
 * converted into a fabricated free product or an ordinary-product identity. */
export function projectFabIntegralLinkTarget(row: { id: number; name: string; price: unknown; stock: unknown; quota: unknown }, unreadableIssues: readonly string[] = []): FabLinkTarget {
  const name = integralDetailText(row.name, 256), price = integralDetailMoney(row.price);
  const item = projectFabLinkTarget({ id: row.id, name: name || '积分商品', kind: 'integral',
    url: `/pages/activity/goods_details/index?id=${row.id}&type=4` });
  if (!name) item.issues.push('积分商品名称异常，详情使用安全名称');
  if (price === null) item.issues.push('积分商品现金价格异常，请在详情确认可兑换规格');
  else item.price = price;
  if (!integralDetailInteger(row.stock) || !integralDetailInteger(row.quota)) item.issues.push('积分商品库存或配额异常，详情将核验可兑换规格');
  else if (row.stock === 0 || row.quota === 0) item.issues.push('当前活动库存或配额为0，仍可查看详情');
  if (unreadableIssues.length) {
    item.selectable = false;
    item.issues.push('积分详情资料重复或超过安全读取范围，暂不可选择');
  }
  return item;
}
// Only publicly visible, root product identities; supplier copies require the
// persisted visible supplier. No credentials, wholesale costs or draft bodies.
const visibleProduct = sql`p.pid=0 AND p.is_del=0 AND p.is_show=1 AND p.is_verify=1 AND
  ((p.type=0 AND p.relation_id=0) OR (p.type=2 AND p.relation_id>0 AND EXISTS
    (SELECT 1 FROM public.system_supplier s WHERE s.id=p.relation_id AND s.is_show=1 AND s.is_del=0)))`;
const categoryTree = sql`WITH RECURSIVE visible_categories AS (
  SELECT c.id,c.pid,c.cate_name,c.pic,c.sort,ARRAY[c.id] AS chain FROM public.store_product_category c
  WHERE c.pid=0 AND c.type=0 AND c.relation_id=0 AND c.is_show=1
  UNION ALL SELECT c.id,c.pid,c.cate_name,c.pic,c.sort,v.chain||c.id
  FROM public.store_product_category c JOIN visible_categories v ON c.pid=v.id
  WHERE c.type=0 AND c.relation_id=0 AND c.is_show=1 AND cardinality(v.chain)<32 AND NOT c.id=ANY(v.chain)
)`;
const staticKinds = new Set<FabLinkKind>(['basic', 'personal', 'distribution', 'marketing']);
function selectFor(query: FabLinkQuery): SQL {
  if (staticKinds.has(query.kind)) {
    const type = query.kind === 'basic' ? 1 : query.kind === 'distribution' ? 2 : 3;
    // The old chooser grouped by category.type and link.type, never seed ids or
    // translated category names. Only connected enabled categories are exposed.
    return sql`SELECT l.id,l.name,l.url,''::text AS image,0 AS owner_type,0 AS relation_id,l.sort
      FROM public.page_link l JOIN public.page_category c ON c.id=l.cate_id
      JOIN public.page_category root ON root.id=c.pid AND root.pid=0 AND root.status=1
      WHERE l.status=1 AND c.status=1 AND ${query.kind === 'marketing' ? sql`c.type='marketing_link'` : sql`c.type='link' AND l.type=${type}`}`;
  }
  if (query.kind === 'product_category') return sql`${categoryTree}
    SELECT c.id,c.cate_name AS name,c.pic AS image,0 AS owner_type,0 AS relation_id,c.sort,c.pid AS parent_id,
      EXISTS(SELECT 1 FROM visible_categories child WHERE child.pid=c.id) AS has_children
    FROM visible_categories c WHERE c.pid=${query.parent_id}`;
  if (query.kind === 'product' || query.kind === 'presale') return sql`${categoryTree}
    SELECT p.id,p.store_name AS name,p.image,p.price::text,p.type AS owner_type,p.relation_id,p.sort,p.is_vip_product AS is_vip
    FROM public.store_product p WHERE ${visibleProduct}
    ${query.kind === 'presale' ? sql`AND p.is_presale_product=1` : sql``}
    ${query.search ? sql`AND (position(${query.search} in p.id::text)>0
      OR position(lower(${query.search}) in lower(p.keyword))>0
      OR position(lower(${query.search}) in lower(p.store_name))>0
      OR position(lower(${query.search}) in lower(p.store_info))>0
      OR position(lower(${query.search}) in lower(p.bar_code))>0
      OR EXISTS (SELECT 1 FROM public.store_product_attr_value av WHERE av.product_id=p.id
        AND av.type=0 AND av.is_retired=0 AND av.bar_code=${query.search}))` : sql``}
    ${query.parent_id ? sql`AND EXISTS (SELECT 1 FROM public.store_product_relation r
      JOIN visible_categories c ON c.id=r.relation_id WHERE r.product_id=p.id AND r.type=1 AND ${query.parent_id}=ANY(c.chain))` : sql``}`;
  if (query.kind === 'news') return sql`SELECT a.id,a.title AS name,a.image_input AS image,0 AS owner_type,0 AS relation_id,a.sort
    FROM public.system_article a WHERE a.status=1 AND a.is_del=0 AND a.hide=0 AND
    (a.cid=0 OR EXISTS (SELECT 1 FROM public.article_category c WHERE c.id=a.cid AND c.status=1 AND c.is_del=0 AND c.hidden=0))`;
  if (query.kind === 'special') return sql`SELECT d.id,d.name,d.cover_image AS image,0 AS owner_type,0 AS relation_id,d.id AS sort,d.value
    FROM public.system_dise d WHERE d.status=1 AND d.is_del=0 AND d.type IN (1,2)`;
  if (query.kind === 'integral') return sql`SELECT a.id,a.product_id,a.store_name AS name,a.image,a.price::text,a.stock,a.quota,
    a.type AS owner_type,a.relation_id,a.sort FROM public.store_integral a JOIN public.store_product p ON p.id=a.product_id
    WHERE ${integralPublicCandidateSql('a', 'p')}`;
  const table = query.kind === 'seckill' ? 'store_seckill' : query.kind === 'bargain' ? 'store_bargain'
    : query.kind === 'combination' ? 'store_combination' : 'store_integral';
  const name = query.kind === 'bargain' ? 'title' : 'store_name';
  // Identifiers are a closed source-controlled list; no query text is raw SQL.
  return sql`SELECT a.id,${sql.raw(`a.${name}`)} AS name,a.image,a.price::text,a.type AS owner_type,a.relation_id,a.sort,p.is_vip_product AS is_vip
    FROM ${sql.raw(`public.${table}`)} a JOIN public.store_product p ON p.id=a.product_id AND p.type=a.type AND p.relation_id=a.relation_id
    WHERE a.status=1 AND a.is_del=0 ${query.kind !== 'bargain' ? sql`AND a.is_show=1` : sql``} AND ${visibleProduct}`;
}
function linkFor(kind: FabLinkKind, row: CatalogRow): string {
  if (row.url !== undefined) return row.url;
  if (kind === 'product') return `/pages/goods_details/index?id=${row.id}`;
  if (kind === 'product_category') return `/pages/goods/goods_list/index?sid=${row.id}&title=${encodeURIComponent(row.name)}`;
  if (kind === 'news') return `/pages/extension/news_details/index?id=${row.id}`;
  if (kind === 'special') return `/pages/annex/special/index?id=${row.id}`;
  if (kind === 'bargain') return `/pages/activity/goods_bargain_details/index?id=${row.id}`;
  return `/pages/activity/goods_details/index?id=${row.id}&type=${kind === 'seckill' ? 1 : kind === 'combination' ? 3 : kind === 'presale' ? 6 : 4}`;
}
export class AdminFabLinkCatalogService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}
  async categories(parameters = new URLSearchParams()) {
    if (parameters.size) throw new ValidateException('链接分类接口不接受查询参数');
    // Fixed capabilities are not seed initialization or a claim that the user's
    // mutable legacy page_category rows have been installed.
    return { list: FAB_LINK_CATEGORIES.map(item => ({ ...item })), issues: [] as string[] };
  }
  async targets(parameters: URLSearchParams) {
    const query = parseFabLinkQuery(parameters);
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await fabDeadlines(tx);
      if (query.parent_id) {
        const rows = await tx.execute<{ id: number }>(sql`${categoryTree} SELECT id FROM visible_categories WHERE id=${query.parent_id}`);
        if (!rows.length) throw new ValidateException('父分类不存在、不可见或未连接到平台分类');
      }
      // Product search uses the old chooser's private keyword/info/barcode
      // sources above. Those fields never become part of its public projection.
      const base = selectFor(query), filter = query.search && query.kind !== 'product' && query.kind !== 'presale'
        ? sql`WHERE position(lower(${query.search}) in lower(target.name))>0 OR target.id::text=${query.search}` : sql``;
      const count = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM (${base}) target ${filter}`);
      const rows = await tx.execute<CatalogRow>(sql`SELECT * FROM (${base}) target ${filter} ORDER BY target.sort DESC,${staticKinds.has(query.kind) ? sql`target.id ASC` : sql`target.id DESC`} LIMIT ${query.limit} OFFSET ${query.offset}`);
      // One batch in this RR snapshot; no per-target full reader/transaction.
      // SQL, global configuration and whole-batch budget failures propagate.
      const readability = query.kind === 'integral'
        ? await readIntegralCatalogReadability(tx, rows.map(row => ({ id: row.id, productId: row.product_id! }))) : null;
      const references = await publicProductPictures(tx, rows.map(row => ({ image: query.kind === 'news' ? legacyArticleImages(row.image)[0] ?? '' : row.image,
        ...(query.kind === 'integral' ? integralPublicMediaOwner(row.owner_type ?? 0, row.relation_id ?? 0)
          : { type: row.owner_type ?? 0, relationId: row.relation_id ?? 0 }) })));
      const list = rows.map((row, index) => {
        const issues: string[] = [];
        if (query.kind === 'special') {
          try { if (typeof row.value !== 'string' || new TextEncoder().encode(row.value).byteLength > 1024*1024 || !Array.isArray(parseLevelActivationJson(row.value))) throw Error(); }
          catch { issues.push('专题内容损坏或超过安全读取范围，暂不可选择'); }
        }
        if (query.kind === 'integral' && !readability!.has(row.id)) throw new ValidateException('积分目录可读性投影不完整');
        const item = query.kind === 'integral'
          ? projectFabIntegralLinkTarget({ id: row.id, name: row.name, price: row.price, stock: row.stock, quota: row.quota }, readability!.get(row.id)!)
          : projectFabLinkTarget({ id: row.id, name: row.name, url: linkFor(query.kind, row), kind: query.kind, issues });
        if (row.is_vip === 1) item.issues.push('目标可能需要会员资格，链接不授予购买权限');
        if (row.image !== '' && references[index] === '') item.issues.push('目标图片不可用，链接身份仍以目录记录为准');
        return { ...item, ...(query.kind !== 'integral' && row.price !== undefined && /^(?:0|[1-9]\d*)\.\d{2}$/.test(row.price) ? { price: row.price } : {}),
          ...(row.parent_id === undefined ? {} : { parent_id: row.parent_id, has_children: row.has_children === true }) };
      });
      return { list, count: count[0]?.count ?? 0, references };
    });
    const previews = await renderProductPictures(this.env.APP_KEY, result.references);
    return { list: result.list.map((item, index) => ({ ...item, image_preview: previews[index] })), count: result.count,
      page: query.page, limit: query.limit, issues: [] as string[] };
  }
}
