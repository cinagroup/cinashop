import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { normalizeConfigScalar } from '@/utils/config';
import { ServiceUnavailableException } from '@/utils/errors';
import { PC_BASE_KEYS, normalizePcBaseReplacement, type PcBaseKey, type PcBaseValues } from '../../../../view/common/pcBase';
import { readPcBaseImageReferences, renderPcBaseImages } from './PcBaseAssetPolicy';
import { retainPcFooterKeyOrder } from './PcFooterOrder';

// Fixed adjacent public metadata required by the existing company/home/phone
// contracts. This is not an arbitrary-key config or credential reader.
const EXTRA_KEYS = ['site_url', 'site_name', 'record_No', 'routine_index_logo', 'fast_number',
  'promotion_number', 'new_goods_bananr', 'tengxun_map_key'] as const;
type ExtraKey = typeof EXTRA_KEYS[number];
export type PcBaseRuntimeSnapshot = {
  values: { [K in PcBaseKey]: PcBaseValues[K] | null };
  extras: Record<ExtraKey, string>;
};

export function safePcSiteUrl(value: string): string {
  try {
    const url = new URL(value);
    return value === value.trim() && !/[\\\u0000-\u0020\u007f]/u.test(value)
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash ? value : '';
  } catch { return ''; }
}

/** Caller supplies one READ ONLY repeatable-read transaction. All owned fields
 * and adjacent public metadata are read together, with no per-key KV hit/fill.
 * Platform-only sort/id winners include hidden/duplicate history. Raw values
 * never escape this function, and invalid retained values gain no display grant. */
export async function readPcBaseRuntimeInTx(tx: DbClient): Promise<PcBaseRuntimeSnapshot> {
  const names = [...PC_BASE_KEYS, ...EXTRA_KEYS];
  const rows = await tx.select({ key: systemConfig.menuName, value: systemConfig.value })
    .from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, names)))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(129);
  if (rows.length > 128 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024) {
    throw new ServiceUnavailableException('PC公开配置超过完整读取容量，请维护后重试');
  }
  const winners = new Map<string, string>();
  for (const row of rows) if (!winners.has(row.key)) winners.set(row.key, row.value);
  const values = {} as PcBaseRuntimeSnapshot['values'];
  for (const key of PC_BASE_KEYS) {
    Object.assign(values, { [key]: null });
    const raw = winners.get(key);
    if (raw === undefined) continue;
    try {
      let value: unknown = parseLevelActivationJson(raw);
      if (['bast_number', 'first_number', 'links_open', 'product_phone_buy_url'].includes(key)
        && typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) value = Number(value);
      // PHP's final whole-row tie comparison observes JSON key insertion
      // order. Preserve keys only after exact validation, using safe values.
      if (key === 'links_list') values.links_list = retainPcFooterKeyOrder(value, normalizePcBaseReplacement(key, value));
      else if (key === 'filing_list') values.filing_list = retainPcFooterKeyOrder(value, normalizePcBaseReplacement(key, value));
      else Object.assign(values, { [key]: normalizePcBaseReplacement(key, value) });
    } catch { /* Missing or unsafe retained history is not a public value. */ }
  }
  const icons = values.filing_list?.map(row => row.icon) ?? [];
  const references = await readPcBaseImageReferences(tx, [values.pc_logo ?? '', ...icons]);
  if (values.pc_logo !== null) values.pc_logo = references[0] ?? '';
  if (values.filing_list) values.filing_list = values.filing_list.map((row, index) => ({ ...row, icon: references[index + 1] ?? '' }));
  const extras = Object.fromEntries(EXTRA_KEYS.map(key => [key, normalizeConfigScalar(winners.get(key))])) as Record<ExtraKey, string>;
  extras.site_url = safePcSiteUrl(extras.site_url);
  return { values, extras };
}

export async function readPcBaseRuntime(container: Container): Promise<PcBaseRuntimeSnapshot> {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    return readPcBaseRuntimeInTx(tx);
  });
}

/** HMAC-only response rendering after the read transaction. References already
 * passed current attachment authority; stable HTTP strings remain unchanged. */
export async function renderPcBaseRuntimeImages(snapshot: PcBaseRuntimeSnapshot, appKey: string | undefined) {
  const values = snapshot.values, icons = values.filing_list?.map(row => row.icon) ?? [];
  const rendered = await renderPcBaseImages(appKey, [values.pc_logo ?? '', ...icons]);
  return { ...values, pc_logo: rendered[0] ?? '',
    filing_list: values.filing_list?.map((row, index) => ({ ...row, icon: rendered[index + 1] ?? '' })) ?? [] };
}
