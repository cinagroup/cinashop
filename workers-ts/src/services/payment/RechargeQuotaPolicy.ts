import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemGroup } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { centsToDecimal, decimalToCents } from '@/services/order/OrderBrokerageService';

export const RECHARGE_QUOTA_LOCK_NAMESPACE = 731_642;
export const RECHARGE_QUOTA_LOCK_KEY = 1;
export const MAX_RECHARGE_QUOTAS = 20;
export const RECHARGE_QUOTA_CONFIG = 'user_recharge_quota';

/** Decimal strings are the management API contract; legacy JSON numbers are
 * accepted only by the stored-data decoder, without rounding fractional cents. */
export function rechargeQuotaMoney(value: unknown, gift = false): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) {
    throw new ValidateException('充值金额必须是最多两位小数的十进制字符串');
  }
  const cents = decimalToCents(value);
  if (cents < (gift ? 0 : 1) || cents > (gift ? 9_999_999_999 : 10_000_000)) {
    throw new ValidateException(gift ? '赠送金额须为0至99999999.99元' : '充值金额须为0.01至100000.00元');
  }
  return centsToDecimal(cents);
}

export function decodeRechargeQuota(value: string | null): { price: string; give_money: string } | null {
  try {
    if (!value) return null;
    const raw: unknown = JSON.parse(value);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const field = (name: string) => {
      let candidate: unknown = (raw as Record<string, unknown>)[name];
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        candidate = (candidate as Record<string, unknown>).value;
      }
      if (name === 'give_money' && (candidate === undefined || candidate === '')) candidate = '0';
      return typeof candidate === 'number' ? String(candidate) : candidate;
    };
    return { price: rechargeQuotaMoney(field('price')), give_money: rechargeQuotaMoney(field('give_money'), true) };
  } catch { return null; }
}

export function rechargeQuotaGroup(db: DbClient): Promise<number>;
export function rechargeQuotaGroup(db: DbClient, allowMissing: true): Promise<number | null>;
export async function rechargeQuotaGroup(db: DbClient, allowMissing = false): Promise<number | null> {
  const rows = await db.select({ id: systemGroup.id }).from(systemGroup)
    .where(eq(systemGroup.configName, RECHARGE_QUOTA_CONFIG)).limit(2);
  if (allowMissing && !rows.length) return null;
  if (rows.length !== 1) throw new ValidateException(rows.length ? '充值档位配置组重复，请先修复配置' : '充值档位配置组不存在，请先完成基础配置');
  return rows[0].id;
}

export async function rechargeQuotaDeadlines(db: DbClient) {
  await db.execute(sql`SELECT set_config('statement_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true)`);
}
