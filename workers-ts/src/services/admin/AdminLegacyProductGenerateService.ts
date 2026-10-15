import { and, asc, eq, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductVirtual } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { PRODUCT_SKU_GENERATION_PERMISSION } from './AdminPermissionService';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { budgetLegacyProductRead } from './AdminLegacyProductReadBudget';
import { normalizeAdminLegacyProductGenerateInput } from './AdminLegacyProductGenerateInput';

type Row = Record<string, unknown>;
type Header = { title: string; slot?: string; align: string; minWidth: number };
const parentColumns = { id: storeProduct.id, type: storeProduct.type, relationId: storeProduct.relationId, productType: storeProduct.productType };
const skuColumns = { id: storeProductAttrValue.id, unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
  image: storeProductAttrValue.image, price: storeProductAttrValue.price, settlePrice: storeProductAttrValue.settlePrice,
  cost: storeProductAttrValue.cost, otPrice: storeProductAttrValue.otPrice, vipPrice: storeProductAttrValue.vipPrice,
  stock: storeProductAttrValue.stock, barCode: storeProductAttrValue.barCode, code: storeProductAttrValue.code,
  weight: storeProductAttrValue.weight, volume: storeProductAttrValue.volume, brokerage: storeProductAttrValue.brokerage,
  brokerageTwo: storeProductAttrValue.brokerageTwo, diskInfo: storeProductAttrValue.diskInfo, writeTimes: storeProductAttrValue.writeTimes,
  writeValid: storeProductAttrValue.writeValid, writeDays: storeProductAttrValue.writeDays,
  writeStart: storeProductAttrValue.writeStart, writeEnd: storeProductAttrValue.writeEnd };
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function date(value: number): string {
  if (!value) return '';
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new ServiceUnavailableException('次卡历史时间错误');
  const parts = Object.fromEntries(day.formatToParts(new Date(value * 1000)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new ServiceUnavailableException('商品规格历史数值错误');
  return parsed;
}
function headers(names: string[], ownerType: number, productType: number): Header[] {
  const column = (title: string, slot: string, minWidth = 140): Header => ({ title, slot, align: 'center', minWidth });
  return [...names.map((name, index) => column(name, `value${index + 1}`, 130)), column('图片', 'pic', 80),
    ...(ownerType === 2 ? [column('结算价', 'settle_price', 120)] : []), column('售价', 'price', 120),
    column('成本价', 'cost'), column('划线价', 'ot_price'), column('库存', 'stock'), column('商品条形码', 'bar_code'), column('商品编码', 'code'),
    ...(productType === 0 ? [column('重量(KG)', 'weight'), column('体积(m³)', 'volume')]
      : productType === 1 ? [column('卡密商品', 'fictitious')] : []), column('操作', 'action', 70)];
}
function rethrow(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(conflict('商品规格正在更新，请刷新后重试'), { cause: error });
    if (['42501', '57014', '42P01', '42703'].includes(code)) throw Object.assign(new ServiceUnavailableException('商品规格读取权限或迁移未就绪'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** POST-shaped read only projection. It allocates no SKU identity, repairs no
 * legacy rows and never turns route mode 1/2 into a trusted copy operation. */
export class AdminLegacyProductGenerateService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}
  async generate(id: number, mode: 0 | 1 | 2, body: unknown, actor: AdminAuthorityActor) {
    if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647 || ![0, 1, 2].includes(mode)) throw new ValidateException('商品ID或规格生成模式错误');
    const input = normalizeAdminLegacyProductGenerateInput(body);
    assertAdminAuthoritySession(actor);
    try {
      const snapshot = await withTx(this.container, async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        await authorizeAdminLegacyProductRead(tx, actor, PRODUCT_SKU_GENERATION_PERMISSION);
        const [parent] = id ? await tx.select(parentColumns).from(storeProduct).where(eq(storeProduct.id, id)).limit(1) : [];
        if (id && !parent) throw new ValidateException('商品不存在');
        const productType = parent?.productType ?? input.productType;
        if (![0, 1, 3, 4].includes(productType)) throw new ValidateException('当前商品履约类型不支持编辑规格');
        if (productType === 4 && input.dimensions.reduce((size, item) => size * item.detail.length, 1) > 1)
          throw new ValidateException('次卡商品只支持单规格单SKU');
        const where = and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))!;
        if (id) await budgetLegacyProductRead(tx, [{ table: storeProductAttrValue, where, columns: Object.values(skuColumns) }]);
        const skus = id ? await tx.select(skuColumns).from(storeProductAttrValue).where(where).orderBy(asc(storeProductAttrValue.id)).limit(10001) : [];
        if (skus.length > 10000) throw new ServiceUnavailableException('商品规格完整集合超过10000项容量');
        if (new Set(skus.map(row => row.suk)).size !== skus.length || new Set(skus.map(row => row.unique)).size !== skus.length)
          throw conflict('商品规格身份存在歧义，请先核对历史数据');
        const counts = id && productType === 1 && mode === 0 ? await tx.select({ unique: storeProductVirtual.attrUnique,
          available: sql<number>`count(*) FILTER(WHERE ${storeProductVirtual.uid}=0)::int`, total: sql<number>`count(*)::int` })
          .from(storeProductVirtual).where(eq(storeProductVirtual.productId, id)).groupBy(storeProductVirtual.attrUnique).limit(10001) : [];
        if (counts.length > 10000) throw new ServiceUnavailableException('商品卡密聚合超过10000项容量');
        const skuMap = new Map(skus.map(row => [row.suk, row])), countMap = new Map(counts.map(row => [row.unique, row]));
        const combinations = input.dimensions.length ? input.dimensions.reduce<string[][]>((rows, dim) =>
          rows.flatMap(parts => dim.detail.map(value => [...parts, value])), [[]]) : [];
        const value: Row[] = [];
        for (const parts of combinations) {
          const suk = parts.join(','), existing = skuMap.get(suk);
          if (id && mode === 0 && !existing) continue;
          const row: Row = { values: suk, detail: Object.fromEntries(input.dimensions.map((dim, index) => [dim.value, parts[index]])),
            pic: existing?.image ?? '', stock: existing?.stock ?? 0, bar_code: existing?.barCode ?? '', code: existing?.code ?? '' };
          parts.forEach((part, index) => { row[`value${index + 1}`] = part; });
          for (const [field, amount] of Object.entries({ price: existing?.price, settle_price: existing?.settlePrice, cost: existing?.cost,
            ot_price: existing?.otPrice, vip_price: existing?.vipPrice, weight: existing?.weight, volume: existing?.volume,
            brokerage: existing?.brokerage, brokerage_two: existing?.brokerageTwo })) row[field] = numeric(amount);
          if (productType === 1 && mode === 0) Object.assign(row, { virtual_list: [], disk_info: existing?.diskInfo ?? '',
            virtual_available: countMap.get(existing?.unique ?? '')?.available ?? 0, virtual_total: countMap.get(existing?.unique ?? '')?.total ?? 0 });
          // PHP's output mentions these fields but its SELECT omits them. Use
          // actual TS columns so a read/generate/save cannot reset valid rights.
          if (productType === 4) Object.assign(row, { write_times: existing?.writeTimes ?? 1, write_valid: existing?.writeValid ?? 1,
            days: existing?.writeDays ?? 0, section_time: [date(existing?.writeStart ?? 0), date(existing?.writeEnd ?? 0)] });
          value.push(row);
        }
        const info = { attr: input.dimensions, value, header: headers(value.length ? input.dimensions.map(dim => dim.value) : [], parent?.type ?? 0, productType), product_type: productType };
        const slots: Array<{ image: string; type: number; relationId: number; row: Row }> = [];
        for (const row of value) {
          const image = canonicalizePublishedAttachmentReference(row.pic as string);
          if (image.startsWith('/api/assets/')) slots.push({ image, type: parent?.type === 1 ? 0 : parent?.type ?? 0,
            relationId: parent?.type === 1 ? 0 : parent?.relationId ?? 0, row });
        }
        const references = await publicProductPictures(tx, slots);
        await assertAdminLegacyProductReadDeadline(tx, actor);
        return { info, slots, references };
      });
      const signed = await renderProductPictures(this.appKey, snapshot.references);
      snapshot.slots.forEach((slot, index) => { slot.row.pic = signed[index]; });
      if (new TextEncoder().encode(JSON.stringify(snapshot.info)).byteLength > 1024 * 1024) throw new ServiceUnavailableException('商品规格生成响应超过1 MiB容量');
      return { info: snapshot.info };
    } catch (error) { return rethrow(error); }
  }
}
